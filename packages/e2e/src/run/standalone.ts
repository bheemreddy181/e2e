/** Worker and attempt lifecycle shared by hosted tests and the one-shot MCP path. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecutorAttempt } from '../agent/executor.ts';
import type { AgentContext } from '../agent/invocation.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { TargetSession } from '../engine/surface.ts';
import { publishAttempt } from '../expect/attempt.ts';
import { PollScope } from '../expect/poll-scope.ts';
import { SoftFailures } from '../expect/soft.ts';
import { DebugTrace } from '../internal/debug.ts';
import { classifyError, ConfigurationError, InfrastructureError, serializeError, type SerializedError } from '../internal/errors.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { resultId, timestamp, uuidv7 } from '../internal/ids.ts';
import { Deadline, withTimeout } from '../internal/time.ts';
import { attemptVideo, type ResolvedRecording, type VideoRecording } from '../internal/recording-modes.ts';
import { buildReport } from '../report/build.ts';
import { renderTracePage } from '../report/failure-text.ts';
import { outcome } from '../report/outcome.ts';
import { toPosixPath, writeTextReport } from '../report/write.ts';
import { holdSecretRegistry } from '../secrets.ts';
import type { TestFixtures } from '../types.ts';
import { createAttemptArtifacts, resultSegment } from './artifacts.ts';
import { AttemptBudget } from './budget.ts';
import { TargetExecutor, type ClosingRecord } from './execute.ts';
import { createFixtures } from './fixtures.ts';
import type { AppProcesses } from './managed-process.ts';
import { outputLayout } from './output.ts';
import type { ProcessPool } from './process-pool.ts';
import { PreparedEngines, recordingNotices, startDeclaredProcesses, validateEngine } from './provision.ts';
import type { AttemptRecord, ResultRecord } from './records.ts';
import { processSecrets, redactForSession, sessionSecrecy } from './secrecy.ts';
import { SessionStore } from './sessions.ts';
import { StepRecorder, type StepProgress } from './steps.ts';
import { WorkerModels } from './worker-models.ts';

export interface StandaloneHostOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly headed: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly processes?: ProcessPool | undefined;
  readonly notice?: (target: string, message: string) => void;
  readonly debug?: DebugTrace;
  /** Persistent test hosts own the engine exclusively; MCP retains its existing one-shot policy. */
  readonly hosted?: true;
}

export interface StandaloneSessionOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly agent?: string | undefined;
  readonly onProgress?: (progress: StepProgress) => void;
  /** Present only for a hosted test: publishes expectations and writes its own trace. */
  readonly name?: string;
}

export interface StandaloneAttemptOptions extends StandaloneHostOptions, StandaloneSessionOptions {}

export interface StandaloneAttempt {
  readonly runId: string;
  readonly attemptId: string;
  readonly fixtures: TestFixtures;
  readonly agentRuntime: AgentContext;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  readonly budget: AttemptBudget;
  readonly artifactsDir: string;
  readonly tracePath: string;
  close(): Promise<readonly SerializedError[]>;
}

export interface StandaloneHost {
  readonly runId: string;
  openAttempt(options: StandaloneSessionOptions): Promise<StandaloneAttempt>;
  close(): Promise<readonly SerializedError[]>;
}

const engineOwners = realmSlot<WeakSet<object>>('e2e.standalone.engines.v1');

/** A worker owns its engine before prepare can acquire resources and until teardown settles. */
function claimEngine(engine: ResolvedTarget['engine'], exclusive: boolean): () => void {
  if (engine === undefined) return () => undefined;
  let owners = engineOwners.get(globalThis);
  if (owners === undefined) {
    owners = new WeakSet<object>();
    engineOwners.set(globalThis, owners);
  }
  if (owners.has(engine)) throw new InfrastructureError('WORKER_PROTOCOL', 'the engine instance already belongs to an e2e host');
  if (!exclusive) return () => undefined;
  owners.add(engine);
  return () => owners.delete(engine);
}

/** Prepares, starts app processes, and initializes one reusable worker. */
export async function openStandaloneHost(options: StandaloneHostOptions): Promise<StandaloneHost> {
  const { config, target } = options;
  const hostEnd = new AbortController();
  const signal = AbortSignal.any([options.signal, hostEnd.signal]);
  const debug = options.debug ?? new DebugTrace(false);
  const notice = (targetName: string, message: string): void => {
    options.notice?.(processSecrets.redact(targetName), processSecrets.redact(message));
  };
  const runId = uuidv7();
  const grade = validateEngine(target);
  for (const message of recordingNotices([{ target, pairs: [] }], new Map([[target.name, grade]]))) notice(target.name, message);
  const releaseEngine = claimEngine(target.engine, options.hosted === true);
  const releaseRegistry = holdSecretRegistry(config);
  const engines = new PreparedEngines();
  const layout = outputLayout(config.output);
  const sessionStore = SessionStore.create(runId, layout.sessions);
  const errors: SerializedError[] = [];
  const failure = (cause: unknown): void => {
    errors.push(serializeError(classifyError(cause), {
      phase: 'cleanup', projectRoot: config.projectRoot,
      redact: processSecrets.redact,
    }));
  };
  let processes: AppProcesses | undefined;
  let executor: TargetExecutor | undefined;
  let tearingDown: Promise<void> | undefined;
  /** No release is allowed to skip the remaining owners, or run twice after a launch/close race. */
  const teardown = (): Promise<void> => {
    tearingDown ??= (async () => {
      try {
        await executor?.dispose();
        errors.push(...(executor?.collectedRunErrors().map((error) => error.error) ?? []));
      } catch (cause) { failure(cause); }
      try {
        await engines.finish({ runId, env: options.env, timeoutMs: config.cleanupTimeout, notice, onFailure: failure });
      } catch (cause) { failure(cause); }
      try { await processes?.stop(failure); } catch (cause) { failure(cause); }
      try { sessionStore.cleanup(); } catch (cause) { failure(cause); }
      releaseRegistry();
      // Failed worker teardown cannot prove this same engine is safe to reuse.
      if (errors.length === 0) releaseEngine();
    })();
    return tearingDown;
  };
  try {
    const prepared = await engines.prepare(target, 1, {
      runId, projectRoot: config.projectRoot, env: options.env, signal, headed: options.headed, notice,
    });
    const hooks = { ci: config.ci, notice: (message: string) => notice('app', message) };
    processes = await startDeclaredProcesses([target], config.projectRoot, () => hooks, signal, debug, options.processes);
    if (signal.aborted) throw new InfrastructureError('CANCELLED', `opening a host on target "${target.name}" was cancelled`);
    executor = new TargetExecutor({
      config, target, runId, artifactsRoot: layout.results, sessionStore,
      headed: options.headed, workerSlot: 0, env: { ...prepared?.env, ...options.env },
      isolated: false, interruptSignal: signal, debug,
      events: { onNotice: (message) => notice(target.name, message) },
    });
    await executor.initEngineOnce();
    if (signal.aborted) throw new InfrastructureError('CANCELLED', `opening a host on target "${target.name}" was cancelled`);
  } catch (cause) {
    hostEnd.abort();
    await teardown();
    for (const error of errors) notice(target.name, error.message);
    throw cause;
  }
  const worker = executor;
  let opening: Promise<StandaloneAttempt> | undefined;
  let active: StandaloneAttempt | undefined;
  let closing: Promise<readonly SerializedError[]> | undefined;
  let broken = false;

  /** Cancels launch before awaiting it, then ends the attempt before disposing its worker. */
  const close = (): Promise<readonly SerializedError[]> => {
    if (closing !== undefined) return closing;
    hostEnd.abort();
    closing = (async () => {
      if (opening !== undefined) await opening.catch(() => undefined);
      try {
        if (active !== undefined) errors.push(...await active.close());
      } catch (cause) { failure(cause); }
      await teardown();
      return errors;
    })();
    return closing;
  };

  /** Reserves the attempt synchronously, before any engine work can run. */
  const openAttempt = (sessionOptions: StandaloneSessionOptions): Promise<StandaloneAttempt> => {
    if (closing !== undefined || broken) return Promise.reject(new InfrastructureError('WORKER_PROTOCOL', 'the e2e host is closed'));
    if (opening !== undefined || active !== undefined) return Promise.reject(new InfrastructureError('WORKER_PROTOCOL', 'the e2e host already has an opening, live, or closing session'));
    if (signal.aborted || sessionOptions.signal.aborted) return Promise.reject(new InfrastructureError('CANCELLED', 'opening the e2e session was cancelled'));
    if (!Number.isFinite(sessionOptions.timeoutMs) || sessionOptions.timeoutMs < 0) return Promise.reject(new ConfigurationError('INVALID_CONFIG', 'session timeout must be a finite number of milliseconds, 0 or more'));
    const attemptId = uuidv7();
    const attemptEnd = new AbortController();
    const publicationEnd = new AbortController();
    const attemptSignal = AbortSignal.any([signal, sessionOptions.signal, attemptEnd.signal]);
    const budget = new AttemptBudget(attemptSignal, new Deadline(sessionOptions.timeoutMs));
    const soft = new SoftFailures();
    const polls = new PollScope('the hosted session');
    if (sessionOptions.name !== undefined) {
      try {
        publishAttempt({ attemptId, testKind: 'test', assertionTimeout: config.assertionTimeout, budget, soft, polls, registry: config }, publicationEnd.signal);
      } catch (cause) { return Promise.reject(cause); }
    }
    // The microtask makes the reservation visible even if launch throws synchronously.
    const pending = Promise.resolve().then(async (): Promise<StandaloneAttempt> => {
      let session: TargetSession | undefined;
      const redact = (text: string): string => redactForSession(session, config.allSecrets, text);
      const name = processSecrets.redact(redact(sessionOptions.name ?? target.name));
      const agent = sessionOptions.agent ?? config.agentNames[0] ?? '';
      const testId = sessionOptions.name === undefined ? `session:${target.name}` : `host:${resultId(name, target.name, agent, 0)}:${attemptId}`;
      // A provider's value is not yet known, so no caller text can be vouched for as a path slug.
      const providerSecrets = [...config.allSecrets.values()].some((secret) => typeof secret.value === 'function');
      const identity = { id: resultId(testId, target.name, agent, 0), file: 'host', titlePath: [providerSecrets ? 'session' : name] };
      const segments = sessionOptions.name === undefined ? ['mcp', `${target.name}-${attemptId}`] : ['host', resultSegment(identity)];
      const steps = new StepRecorder(attemptId, {
        maxEventsPerStep: config.limits.maxEventsPerStep, projectRoot: config.projectRoot, redact,
        ...(sessionOptions.onProgress === undefined ? {} : { onProgress: sessionOptions.onProgress }),
      });
      const artifacts = createAttemptArtifacts({
        artifactsRoot: layout.results, segments, attemptId, currentStepId: () => steps.currentStepId,
        ...(config.artifactStore === undefined ? {} : { store: config.artifactStore }),
        secrecy: () => session === undefined ? undefined : sessionSecrecy(session, config.allSecrets),
        identity: { runId, testId, attemptId },
      });
      const attemptErrors: SerializedError[] = [];
      const recordFailure = (cause: unknown, phase: 'body' | 'cleanup'): void => {
        attemptErrors.push(serializeError(classifyError(cause), { phase, projectRoot: config.projectRoot, redact }));
      };
      /** One outcome drives both recording retention and trace rendering. */
      const verdict = (): { status: AttemptRecord['status']; error: SerializedError | undefined } => {
        const step = steps.all().find((candidate) => candidate.status !== 'passed');
        const error = attemptErrors[0] ?? step?.error;
        const status = error === undefined ? 'passed'
          : error.code === 'CANCELLED' ? 'interrupted'
          : error.code === 'TEST_TIMEOUT' || step?.status === 'timed-out' ? 'timed-out' : 'failed';
        return { status, error };
      };
      const video = sessionOptions.name === undefined ? sessionRecording(target.video) : attemptVideo(target.video, 0);
      session = await worker.launchSession({ session: undefined, recordings: { trace: undefined, video } }, attemptId, artifacts.dir, attemptSignal);
      if (attemptSignal.aborted) {
        await worker.closeSession(session, { attemptId, video }, { status: 'interrupted', cleanup: 'complete' }, artifacts.sink, attemptErrors);
        throw new InfrastructureError('CANCELLED', 'opening the e2e session was cancelled');
      }
      session.appLog.route((event, at) => steps.recordAppEvent(event, at));
      // Opening is launch work, not charged against the test's operation deadline.
      budget.enter(attemptSignal, sessionOptions.timeoutMs);
      const attempt: ExecutorAttempt = { testId, attemptId, index: 0, signal: attemptEnd.signal, memory: new Map<string, unknown>() };
      let acquired: ReturnType<typeof createFixtures>;
      try {
        acquired = createFixtures({
          config, target, session, steps, budget, runId, attemptId, attempt, artifacts: artifacts.sink,
          priorSteps: () => steps.completed(), agent: sessionOptions.agent, agentContext: undefined, saveSession: undefined,
          models: new WorkerModels((error) => recordFailure(error, 'body')), debug,
        });
      } catch (cause) {
        attemptEnd.abort();
        await worker.closeSession(session, { attemptId, video }, { status: 'failed', cleanup: 'complete' }, artifacts.sink, attemptErrors);
        throw cause;
      }
      const { fixtures, agentRuntime } = acquired;
      const openedSession = session;
      const startedAt = timestamp();
      const startedMs = Date.now();
      const tracePath = path.join(artifacts.dir, 'trace.md');
      let ending: Promise<readonly SerializedError[]> | undefined;
      const result: StandaloneAttempt = {
        runId, attemptId, fixtures, agentRuntime, session, steps, budget, artifactsDir: artifacts.dir, tracePath,
        close: () => {
          ending ??= (async () => {
            const abandonedPoll = polls.close();
            const abandonedStep = steps.abandonRunning();
            attemptEnd.abort();
            for (const error of [abandonedStep, abandonedPoll, soft.close()]) if (error !== undefined) recordFailure(error, 'body');
            try {
              await withTimeout(steps.settleAbandoned(), config.cleanupTimeout, () => new InfrastructureError('CLEANUP_TIMEOUT', 'abandoned session steps did not settle'));
            } catch (cause) { recordFailure(cause, 'cleanup'); }
            try {
              // Settling runs under the worker's signal; an interrupted host still ends its attempt below.
              if (!signal.aborted) await worker.settleAttempt(openedSession, attemptId);
            } catch (cause) { recordFailure(cause, 'body'); }
            const record: ClosingRecord = {
              status: verdict().status,
              cleanup: 'complete',
            };
            try {
              await worker.closeSession(openedSession, { attemptId, video }, record, artifacts.sink, attemptErrors);
            } catch (cause) { recordFailure(cause, 'cleanup'); record.cleanup = 'failed'; }
            try { await artifacts.settle(); } catch (cause) { recordFailure(cause, 'cleanup'); }
            try {
              if (sessionOptions.name !== undefined) {
                const { error, status } = verdict();
                const attemptRecord: AttemptRecord = {
                  id: attemptId, index: 0, status, startedAt, durationMs: Date.now() - startedMs,
                  steps: [...steps.all()], appLog: [...steps.appLog()], artifacts: artifacts.records,
                  ...(error === undefined ? {} : { error }), secondaryErrors: attemptErrors.slice(1), cleanup: record.cleanup,
                };
                const title = processSecrets.redact(redact(sessionOptions.name ?? target.name));
                const resultRecord: ResultRecord = {
                  test: { id: testId, kind: 'test', title, titlePath: [title], file: 'host', declarationIndex: 0, sessions: [], tags: [], source: undefined, serialId: undefined },
                  target, agent, repeat: 0, selected: true, status, attempts: [attemptRecord],
                };
                const report = buildReport({ config, runId, startedAt, status: status === 'interrupted' ? 'interrupted' : status === 'passed' ? 'passed' : 'failed', exitCode: status === 'interrupted' ? 130 : status === 'passed' ? 0 : 1, results: [resultRecord], serialGroups: [], runErrors: [], targetProvenance: new Map() });
                const reported = report.run.results[0]!;
                const page = renderTracePage(report, reported, outcome(reported, new Map()), {
                  artifactsDir: toPosixPath(path.relative(config.projectRoot, layout.results)), pageDir: toPosixPath(path.join(...segments)),
                  readArtifact: (reportPath) => { try { return readFileSync(path.join(layout.results, reportPath), 'utf8'); } catch { return undefined; } },
                });
                await writeTextReport(tracePath, redact(page));
              }
            } catch (cause) { recordFailure(cause, 'cleanup'); }
            finally {
              if (record.cleanup !== 'complete') {
                // Failed endAttempt leaves isolation uncertain; no subsequent test may reuse it.
                broken = true;
                hostEnd.abort();
                await teardown();
              }
              publicationEnd.abort();
              if (active === result) active = undefined;
            }
            return attemptErrors;
          })();
          return ending;
        },
      };
      active = result;
      return result;
    });
    const settled = pending.catch(async (cause: unknown) => {
      // A failed launch may have partially opened isolation. Never reuse that worker.
      broken = true;
      hostEnd.abort();
      await teardown();
      publicationEnd.abort();
      throw cause;
    }).finally(() => { if (opening === settled) opening = undefined; });
    opening = settled;
    return settled;
  };
  return { runId, openAttempt, close };
}

/** MCP retains its one-shot path without publishing a test attempt. */
export async function openStandaloneAttempt(options: StandaloneAttemptOptions): Promise<StandaloneAttempt> {
  const host = await openStandaloneHost(options);
  try {
    const attempt = await host.openAttempt(options);
    let closing: Promise<readonly SerializedError[]> | undefined;
    return { ...attempt, close: () => {
      closing ??= host.close();
      return closing;
    } };
  } catch (cause) {
    await host.close();
    throw cause;
  }
}

/** One-shot sessions never keep a recording that would only survive a failure. */
function sessionRecording(recording: ResolvedRecording): VideoRecording | undefined {
  const planned = attemptVideo(recording, 0);
  return planned?.keep === 'on-failure' ? undefined : planned;
}
