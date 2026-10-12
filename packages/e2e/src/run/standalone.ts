/** The worker a hosted test runner or the one-shot MCP path keeps alive between attempts. */

import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { DebugTrace } from '../internal/debug.ts';
import { classifyError, InfrastructureError, serializeError, type SerializedError } from '../internal/errors.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { uuidv7 } from '../internal/ids.ts';
import { holdSecretRegistry } from '../secrets.ts';
import { TargetExecutor } from './execute.ts';
import type { AppProcesses } from './managed-process.ts';
import { outputLayout } from './output.ts';
import type { ProcessPool } from './process-pool.ts';
import { PreparedEngines, recordingNotices, startDeclaredProcesses, validateEngine } from './provision.ts';
import { processSecrets } from './secrecy.ts';
import { SessionStore } from './sessions.ts';
import {
  launchAttempt, reserveAttempt, type AttemptClosed, type AttemptKind, type AttemptReservation, type StandaloneAttempt, type StandaloneSessionOptions,
} from './standalone-attempt.ts';

export type { StandaloneAttempt, StandaloneSessionOptions } from './standalone-attempt.ts';

export interface StandaloneHostOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly headed: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly processes?: ProcessPool | undefined;
  readonly notice?: (target: string, message: string) => void;
  readonly debug?: DebugTrace;
}

export interface StandaloneAttemptOptions extends StandaloneHostOptions, StandaloneSessionOptions {}

export interface StandaloneHost {
  readonly runId: string;
  /** One attempt at a time: the next may open once the previous close settled. */
  openAttempt(options: StandaloneSessionOptions): Promise<StandaloneAttempt>;
  close(): Promise<readonly SerializedError[]>;
}

const engineOwners = realmSlot<WeakSet<object>>('e2e.standalone.engines.v1');

/**
 * Refuses an engine instance another host owns. A hosted worker then owns it
 * until its teardown settles cleanly; the one-shot path keeps its existing
 * policy of checking without owning.
 */
function claimEngine(engine: ResolvedTarget['engine'], kind: AttemptKind): () => void {
  if (engine === undefined) return () => undefined;
  let owners = engineOwners.get(globalThis);
  if (owners === undefined) {
    owners = new WeakSet<object>();
    engineOwners.set(globalThis, owners);
  }
  if (owners.has(engine)) throw new InfrastructureError('WORKER_PROTOCOL', 'the engine instance already belongs to an e2e host');
  if (kind === 'one-shot') return () => undefined;
  owners.add(engine);
  return () => owners.delete(engine);
}

/** Prepares, starts app processes, and initializes one worker for a hosted test runner. */
export function openStandaloneHost(options: StandaloneHostOptions): Promise<StandaloneHost> {
  return openWorker(options, 'hosted');
}

/** MCP's one attempt on a worker of its own, closed together. */
export async function openStandaloneAttempt(options: StandaloneAttemptOptions): Promise<StandaloneAttempt> {
  const host = await openWorker(options, 'one-shot');
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

async function openWorker(options: StandaloneHostOptions, kind: AttemptKind): Promise<StandaloneHost> {
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
  const releaseEngine = claimEngine(target.engine, kind);
  const releaseRegistry = holdSecretRegistry(config);
  const engines = new PreparedEngines();
  const layout = outputLayout(config.output);
  const sessionStore = SessionStore.create(runId, layout.sessions);
  const errors: SerializedError[] = [];
  const failure = (cause: unknown): void => {
    errors.push(serializeError(classifyError(cause), { phase: 'cleanup', projectRoot: config.projectRoot, redact: processSecrets.redact }));
  };
  let processes: AppProcesses | undefined;
  let executor: TargetExecutor | undefined;
  let tearingDown: Promise<void> | undefined;
  /** Releases every owner once, whichever of launch failure, attempt close, or host close gets there first. */
  const teardown = (): Promise<void> => {
    tearingDown ??= (async () => {
      // Attempt failures are the caller's to report; only teardown's own decide engine reuse.
      const priorFailures = errors.length;
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
      if (errors.length === priorFailures) releaseEngine();
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
  const worker = { kind, config, target, runId, executor, resultsDir: layout.results, debug, signal };
  let opening: Promise<StandaloneAttempt> | undefined;
  let active: StandaloneAttempt | undefined;
  let closing: Promise<readonly SerializedError[]> | undefined;
  /** Set once an attempt's cleanup failed: its isolation is uncertain, so no later attempt may reuse the worker. */
  let retired = false;

  /** Cancels a launch before awaiting it, then ends the attempt before disposing its worker. */
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
    if (closing !== undefined || retired) return Promise.reject(new InfrastructureError('WORKER_PROTOCOL', 'the e2e host is closed'));
    if (opening !== undefined || active !== undefined) {
      return Promise.reject(new InfrastructureError('WORKER_PROTOCOL', 'the e2e host already has an opening, live, or closing session'));
    }
    let reservation: AttemptReservation;
    try {
      reservation = reserveAttempt(worker, sessionOptions);
    } catch (cause) { return Promise.reject(cause); }
    const onClosed = async ({ cleanup }: AttemptClosed): Promise<void> => {
      if (cleanup !== 'complete') {
        retired = true;
        hostEnd.abort();
        await teardown();
      }
      if (active === launched) active = undefined;
    };
    let launched: StandaloneAttempt | undefined;
    // The microtask makes the reservation visible even if launch throws synchronously.
    const pending = Promise.resolve().then(async () => {
      launched = await launchAttempt(worker, reservation, onClosed);
      active = launched;
      return launched;
    });
    const settled = pending
      .catch((cause: unknown) => { reservation.release(); throw cause; })
      .finally(() => { if (opening === settled) opening = undefined; });
    opening = settled;
    return settled;
  };
  return { runId, openAttempt, close };
}
