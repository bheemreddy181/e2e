/** Hosted attempts use the built runner and the same expect registry as a consumer. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineHandle, EnginePrepareInfo, EngineFinishInfo } from '../../src/engine/index.ts';
import type { E2EConfig } from '../../src/index.ts';
import type { E2EHost, OpenHostOptions, StepProgress } from '../../src/runner.ts';
import { createFakeEngine, FAKE_APP, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { contentsUnder } from '../helpers/run-project.ts';

const runnerModule = new URL('../../dist/runner.js', import.meta.url).href;
const sdkModule = new URL('../../dist/index.js', import.meta.url).href;
const { openHost } = (await import(runnerModule)) as typeof import('../../src/runner.ts');
const { credentials, expect: sdkExpect, secrets } = (await import(sdkModule)) as typeof import('../../src/index.ts');
const PROJECTS = new URL('../tmp-projects/', import.meta.url);
const ENGINES = '__e2eOpenHostTestEngines';

interface Gadget {
  poke(what: string): Promise<string>;
  dropFile(): Promise<string>;
  hang(): Promise<never>;
  slow(options?: { timeout?: number }): Promise<string>;
  describe(): string;
}

/** A gate makes lifecycle races independent of how fast the engine starts. */
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Add run-level hooks without changing the fake engine's attempt instrumentation. */
function provisioned(fake: FakeEngineHandle) {
  const prepares: EnginePrepareInfo[] = [];
  const finishes: EngineFinishInfo[] = [];
  const events: string[] = [];
  const engine: EngineHandle = {
    ...fake.engine,
    async prepare(info) {
      prepares.push(info);
      events.push('prepare');
      info.log('pool ready');
      return { env: { FROM_PREPARE: 'prepared', OVERRIDE: 'prepared' } };
    },
    async finish(info) {
      finishes.push(info);
      events.push('finish');
      info.log('pool released');
    },
  };
  return { engine, prepares, finishes, events };
}

describe('openHost', { timeout: 60_000 }, () => {
  let dir: string;
  let hosts: E2EHost<GadgetFixtures>[];
  let releases: (() => void)[];
  type GadgetFixtures = { gadget: Gadget };

  /** A config value exercises cwd resolution without importing source runtime modules. */
  function config(engine: EngineHandle, extra: Partial<E2EConfig> = {}): E2EConfig {
    return { targets: [{ name: 'kiosk', platform: 'kiosk', engine, app: FAKE_APP }], ...extra };
  }

  /** Keep every opened host available for cleanup even if an assertion fails. */
  async function host(engine: EngineHandle, options: Partial<OpenHostOptions> = {}) {
    const opened = await openHost<GadgetFixtures>({ cwd: dir, env: {}, config: config(engine), ...options });
    hosts.push(opened);
    return opened;
  }

  /** Release pending fake lifecycle hooks before afterEach closes their hosts. */
  function heldGate() {
    const held = gate();
    releases.push(held.resolve);
    return held;
  }

  beforeEach(() => {
    mkdirSync(PROJECTS, { recursive: true });
    dir = mkdtempSync(path.join(PROJECTS.pathname, 'open-host-'));
    hosts = [];
    releases = [];
  });

  afterEach(async () => {
    for (const release of releases) release();
    for (const opened of hosts) await opened.close();
    delete (globalThis as Record<string, unknown>)[ENGINES];
    rmSync(dir, { recursive: true, force: true });
  });

  it('prepares and initializes once, with fresh fixtures, steps, ids and artifacts per session', async () => {
    const fake = createFakeEngine({ fixtures: true, artifacts: true });
    const pool = provisioned(fake);
    const notices: string[] = [];
    const opened = await host(pool.engine, {
      headed: true,
      env: { OVERRIDE: 'host', FROM_HOST: 'host' },
      onNotice: (target, message) => notices.push(`${target}: ${message}`),
    });
    expect(opened.target).toBe('kiosk');
    expect(pool.prepares).toHaveLength(1);
    expect(pool.prepares[0]).toMatchObject({ runId: opened.runId, slots: 1, projectRoot: dir, headed: true });
    expect(fake.inits[0]).toMatchObject({
      runId: opened.runId,
      projectRoot: dir,
      headed: true,
      env: { FROM_PREPARE: 'prepared', OVERRIDE: 'host', FROM_HOST: 'host' },
    });

    const progress: StepProgress[] = [];
    const first = await opened.openSession({ name: 'first checkout', timeout: 5_000, onStep: (step) => progress.push(step) });
    expect(first.runId).toBe(opened.runId);
    expect(first.target).toBe(opened.target);
    expect(first.fixtures.platform).toBe('kiosk');
    expect(first.fixtures.gadget.describe()).toContain('kiosk');
    expect(first.steps()).toEqual([]);
    await first.fixtures.gadget.poke('first');
    await first.fixtures.app.screenshot('first home');
    expect(progress.filter((step) => step.phase === 'start')).toHaveLength(2);
    expect(progress.filter((step) => step.phase === 'end')).toHaveLength(2);
    expect(await first.close()).toEqual([]);
    expect(await first.close()).toEqual([]);
    expect(fake.stats().disposes).toBe(0);
    expect(pool.finishes).toHaveLength(0);

    const firstSteps = first.steps();
    const second = await opened.openSession({ name: 'second checkout', timeout: 10_000 });
    expect(second.runId).toBe(first.runId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.artifactsDir).not.toBe(first.artifactsDir);
    expect(second.tracePath).not.toBe(first.tracePath);
    expect(second.fixtures === first.fixtures).toBe(false);
    expect(second.steps()).toEqual([]);
    await second.fixtures.gadget.poke('second');
    expect(first.steps()).toEqual(firstSteps);
    expect(await second.close()).toEqual([]);
    expect(fake.callsOf(second.attemptId)).toEqual([]);
    expect(fake.fixtureCalls).toEqual(['poke:first', 'poke:second']);
    expect(fake.attempts.map((attempt) => attempt.artifactsDir)).toEqual([first.artifactsDir, second.artifactsDir]);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 2, attemptsEnded: 2, maxConcurrentAttempts: 1, disposes: 0 });
    for (const session of [first, second]) {
      expect(path.isAbsolute(session.artifactsDir)).toBe(true);
      expect(path.isAbsolute(session.tracePath)).toBe(true);
      expect(readFileSync(session.tracePath, 'utf8')).toContain('gadget.poke');
    }
    expect(await opened.close()).toEqual([]);
    expect(await opened.close()).toEqual([]);
    expect(fake.stats().disposes).toBe(1);
    expect(pool.finishes).toHaveLength(1);
    expect(pool.finishes[0]?.runId).toBe(opened.runId);
    expect(notices.join('\n')).toContain('pool ready');
    expect(notices.join('\n')).toContain('pool released');
  });

  it('isolates engine state and step ids between sequential sessions', async () => {
    const fake = createFakeEngine({ scene: () => [{ id: 'name', role: 'textbox', name: 'Name', value: 'initial' }] });
    const opened = await host(fake.engine);
    const first = await opened.openSession({ name: 'mutate a field' });
    await first.fixtures.app.open();
    await first.fixtures.screen.getByRole('textbox', 'Name').fill('first session');
    await sdkExpect(first.fixtures.screen.getByRole('textbox', 'Name')).toHaveValue('first session');
    expect(await first.close()).toEqual([]);
    const firstIds = new Set(first.steps().map((step) => step.id));
    const second = await opened.openSession({ name: 'fresh field' });
    await second.fixtures.app.open();
    await sdkExpect(second.fixtures.screen.getByRole('textbox', 'Name')).toHaveValue('initial');
    expect(second.steps().every((step) => !firstIds.has(step.id))).toBe(true);
    expect(fake.callsOf(second.attemptId, 'perform')).toEqual([]);
    expect(await second.close()).toEqual([]);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 2, attemptsEnded: 2 });
  });

  it('starts a declared app process once and keeps it alive between sessions until host close', async () => {
    const port = await freePort();
    const starts = path.join(dir, 'starts.txt');
    const script = `
      require('node:fs').appendFileSync(${JSON.stringify(starts)}, 'start\\n');
      require('node:http').createServer((_req, res) => res.end(String(process.pid)))
        .listen(${port}, '127.0.0.1');
    `;
    const app = {
      url: `http://127.0.0.1:${port}`,
      command: { executable: process.execPath, args: ['-e', script], startupTimeout: 15_000, shutdownTimeout: 2_000 },
    };
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: { targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine, app }] } });
    const pid = await (await fetch(app.url)).text();
    const first = await opened.openSession({ name: 'first request' });
    await first.close();
    expect(await (await fetch(app.url)).text()).toBe(pid);
    const second = await opened.openSession({ name: 'second request' });
    await second.close();
    expect(readFileSync(starts, 'utf8')).toBe('start\n');
    expect(await (await fetch(app.url)).text()).toBe(pid);
    await opened.close();
    await expect(fetch(app.url)).rejects.toThrow();
  });

  it('loads an explicit config path and selects only the named target', async () => {
    const one = createFakeEngine();
    const two = createFakeEngine();
    (globalThis as Record<string, unknown>)[ENGINES] = { one: one.engine, two: two.engine };
    writeFileSync(path.join(dir, 'host.config.ts'), `export default { targets: [
      { name: 'one', platform: 'kiosk', engine: globalThis.${ENGINES}.one, app: ${JSON.stringify(FAKE_APP)} },
      { name: 'two', platform: 'kiosk', engine: globalThis.${ENGINES}.two, app: ${JSON.stringify(FAKE_APP)} }
    ] };\n`);
    await expect(openHost({ cwd: dir, env: {}, config: 'host.config.ts' })).rejects.toMatchObject({ code: 'TARGET_REQUIRED' });
    await expect(openHost({ cwd: dir, env: {}, config: 'host.config.ts', target: 'missing' })).rejects.toMatchObject({ code: 'UNKNOWN_TARGET' });
    const opened = await host(two.engine, { config: 'host.config.ts', target: 'two' });
    await using session = await opened.openSession({ name: 'selected target' });
    expect(session.target).toBe('two');
    expect(one.stats().inits).toBe(0);
    expect(two.inits[0]?.projectRoot).toBe(dir);
    expect(two.stats().inits).toBe(1);
  });

  it('chooses the session agent without carrying its choice into the next session', async () => {
    const fake = createFakeEngine();
    const calls: string[] = [];
    const executor = (name: string) => ({ name, async runStep() {
      calls.push(name);
      return { status: 'passed' as const, summary: `done by ${name}` };
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      cache: 'off', agents: { default: { executor: executor('default') }, reviewer: { executor: executor('reviewer') } },
    }) });
    const first = await opened.openSession({ name: 'review', agent: 'reviewer' });
    await first.fixtures.agent.act('check the screen');
    expect(await first.close()).toEqual([]);
    const second = await opened.openSession({ name: 'default' });
    await second.fixtures.agent.act('check the screen');
    expect(await second.close()).toEqual([]);
    expect(calls).toEqual(['reviewer', 'default']);
  });

  it('reserves same-host and cross-host opening attempts before any engine start', async () => {
    const release = heldGate();
    const fake = createFakeEngine({ onStartAttempt: () => release.promise });
    const other = createFakeEngine();
    const opened = await host(fake.engine);
    const another = await host(other.engine);
    const opening = opened.openSession({ name: 'first proposal' });
    const same = opened.openSession({ name: 'same-host proposal' });
    const cross = another.openSession({ name: 'cross-host proposal' });
    expect(fake.stats().attemptsStarted).toBe(0);
    expect(other.stats().attemptsStarted).toBe(0);
    await Promise.all([
      expect(same).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' }),
      expect(cross).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' }),
    ]);
    expect(fake.stats().attemptsStarted).toBe(1);
    expect(other.stats().attemptsStarted).toBe(0);
    release.resolve();
    const session = await opening;
    expect(await session.close()).toEqual([]);
    const next = await another.openSession({ name: 'rejected overlap did not poison the host' });
    expect(await next.close()).toEqual([]);
  });

  it.each(['opening', 'live', 'closing'] as const)('refuses same-host and cross-host overlap while a session is %s, before engine start', async (phase) => {
    const entered = gate();
    const released = heldGate();
    const fake = createFakeEngine({
      ...(phase === 'opening' ? { onStartAttempt: async () => { entered.resolve(); await released.promise; } } : {}),
      ...(phase === 'closing' ? { onEndAttempt: async () => { entered.resolve(); await released.promise; } } : {}),
    });
    const other = createFakeEngine();
    const opened = await host(fake.engine);
    const another = await host(other.engine);
    const opening = opened.openSession({ name: 'owner' });
    let closing: Promise<readonly unknown[]> | undefined;
    if (phase === 'opening') await entered.promise;
    else {
      const session = await opening;
      if (phase === 'closing') { closing = session.close(); await entered.promise; }
    }
    await expect(opened.openSession({ name: 'same-host overlap' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    await expect(another.openSession({ name: 'cross-host overlap' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(fake.stats().attemptsStarted).toBe(1);
    expect(other.stats().attemptsStarted).toBe(0);
    expect(other.stats().disposes).toBe(0);
    released.resolve();
    const session = await opening;
    await (closing ?? session.close());
    expect(fake.stats().maxConcurrentAttempts).toBe(1);
    const next = await another.openSession({ name: 'after release' });
    expect(await next.close()).toEqual([]);
    expect(other.stats().attemptsStarted).toBe(1);
  });

  it('keeps attempt publication through cleanup without leaking soft failures into another host', async () => {
    const ending = gate();
    const release = heldGate();
    const fake = createFakeEngine({ onEndAttempt: async () => { ending.resolve(); await release.promise; } });
    const other = createFakeEngine();
    const opened = await host(fake.engine);
    const another = await host(other.engine);
    const session = await opened.openSession({ name: 'soft owner' });
    sdkExpect.soft(1, 'first owner').toBe(2);
    const closing = session.close();
    await ending.promise;
    await expect(another.openSession({ name: 'during cleanup' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(other.stats().attemptsStarted).toBe(0);
    release.resolve();
    expect((await closing).map((error) => error.code)).toContain('ASSERTION_FAILED');
    const next = await another.openSession({ name: 'new owner' });
    sdkExpect.soft('ok').toBe('ok');
    expect(await next.close()).toEqual([]);
  });

  it('poisons a host after start failure and releases resources before another host can open', async () => {
    const failed = createFakeEngine({ onStartAttempt: () => { throw new Error('launch broke'); } });
    const pool = provisioned(failed);
    const opened = await host(pool.engine);
    await expect(opened.openSession({ name: 'broken start' })).rejects.toThrow('launch broke');
    expect(failed.stats().disposes).toBe(1);
    expect(pool.finishes).toHaveLength(1);
    await expect(opened.openSession({ name: 'cannot reuse' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(failed.stats().attemptsStarted).toBe(1);
    await opened.close();
    expect(failed.stats().disposes).toBe(1);
    expect(pool.finishes).toHaveLength(1);
    const fresh = createFakeEngine();
    const replacement = await host(fresh.engine);
    const session = await replacement.openSession({ name: 'replacement host' });
    expect(await session.close()).toEqual([]);
  });

  it('does not release a failed opening until host teardown has completed', async () => {
    const disposing = gate();
    const release = heldGate();
    const failed = createFakeEngine({
      onStartAttempt: () => { throw new Error('start refused'); },
      onDispose: async () => { disposing.resolve(); await release.promise; },
    });
    const opened = await host(failed.engine);
    const other = createFakeEngine();
    const another = await host(other.engine);
    const opening = opened.openSession({ name: 'failed owner' }).catch((cause: unknown) => cause);
    await disposing.promise;
    await expect(another.openSession({ name: 'too soon' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(other.stats().attemptsStarted).toBe(0);
    release.resolve();
    expect(await opening).toBeInstanceOf(Error);
    const next = await another.openSession({ name: 'after failed cleanup' });
    expect(await next.close()).toEqual([]);
  });

  it('host close cancels an opening session and waits for disposal and finish exactly once', async () => {
    const starting = gate();
    const fake = createFakeEngine({ onStartAttempt: (context) => new Promise<void>((_resolve, reject) => {
      starting.resolve();
      if (context.signal.aborted) reject(context.signal.reason);
      else context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
    }) });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const opening = opened.openSession({ name: 'cancel opening' }).then(() => 'opened', () => 'cancelled');
    await starting.promise;
    const [first, second] = await Promise.all([opened.close(), opened.close()]);
    expect(await opening).toBe('cancelled');
    expect(second).toEqual(first);
    expect(fake.stats()).toMatchObject({ attemptsStarted: 1, disposes: 1 });
    expect(pool.finishes).toHaveLength(1);
    await expect(opened.openSession({ name: 'after close' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    const nextHost = await host(createFakeEngine().engine);
    const next = await nextHost.openSession({ name: 'released publication' });
    expect(await next.close()).toEqual([]);
  });

  it('closes a host immediately after session publication without allowing the opening to escape', async () => {
    const fake = createFakeEngine();
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const opening = opened.openSession({ name: 'close before launch' }).then(() => 'opened', () => 'cancelled');
    expect(fake.stats().attemptsStarted).toBe(0);
    const closing = opened.close();
    expect(await opening).toBe('cancelled');
    await closing;
    expect(fake.stats().disposes).toBe(1);
    expect(pool.finishes).toHaveLength(1);
    await expect(opened.openSession({ name: 'closed owner' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    const replacement = await host(createFakeEngine().engine);
    const session = await replacement.openSession({ name: 'publication released after immediate close' });
    expect(await session.close()).toEqual([]);
  });

  it('host close cancels an active fixture call and waits for pending session cleanup', async () => {
    const performing = gate();
    const ending = gate();
    const release = heldGate();
    const fake = createFakeEngine({
      perform: (_ref, _action, operation) => new Promise<void>((_resolve, reject) => {
        performing.resolve();
        operation.signal.addEventListener('abort', () => reject(operation.signal.reason), { once: true });
      }),
      onEndAttempt: async () => { ending.resolve(); await release.promise; },
    });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const session = await opened.openSession({ name: 'active close' });
    const click = session.fixtures.screen.getByRole('button', 'Submit').click().then(() => 'passed', () => 'cancelled');
    await performing.promise;
    let closed = false;
    const closing = opened.close().then((errors) => { closed = true; return errors; });
    await ending.promise;
    expect(await click).toBe('cancelled');
    expect(closed).toBe(false);
    expect(fake.stats().disposes).toBe(0);
    expect(pool.finishes).toHaveLength(0);
    await expect(opened.openSession({ name: 'while host closes' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    release.resolve();
    const errors = await closing;
    expect(errors.map((error) => error.code)).toContain('STEP_NOT_AWAITED');
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
    expect(pool.finishes).toHaveLength(1);
    expect(await session.close()).toEqual(await session.close());
  });

  it('returns both soft assertion and cleanup failures, idempotently, then clears collection', async () => {
    const fake = createFakeEngine({ onEndAttempt: (index) => {
      if (index === 0) throw new Error('attempt cleanup broke');
    } });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'soft errors' });
    sdkExpect.soft(1, 'quantity').toBe(2);
    sdkExpect.soft('actual', 'label').toBe('expected');
    await sdkExpect.soft(session.fixtures.screen.getByRole('button', 'Submit')).toBeHidden({ timeout: 25 });
    await session.fixtures.app.open();
    const failures = await session.close();
    expect(failures.find((failure) => failure.code === 'ASSERTION_FAILED')?.message).toContain('3 soft assertions failed');
    expect(failures.map((failure) => failure.message).join('\n')).toContain('attempt cleanup broke');
    expect(await session.close()).toEqual(failures);
    expect(session.steps().at(-1)).toMatchObject({ api: 'app.open', status: 'passed' });
    await expect(opened.openSession({ name: 'unsafe reuse after failed endAttempt' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(fake.stats().disposes).toBe(1);
    const replacement = await host(createFakeEngine().engine);
    const clean = await replacement.openSession({ name: 'no inherited soft errors' });
    sdkExpect.soft(true).toBe(true);
    expect(await clean.close()).toEqual([]);
  });

  it('holds publication while disposing a worker whose endAttempt failed, then refuses reuse', async () => {
    const disposing = gate();
    const release = heldGate();
    const fake = createFakeEngine({
      onEndAttempt: () => { throw new Error('isolation did not close'); },
      onDispose: async () => { disposing.resolve(); await release.promise; },
    });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const other = createFakeEngine();
    const another = await host(other.engine);
    const session = await opened.openSession({ name: 'uncertain engine state' });
    const closing = session.close();
    await disposing.promise;
    await expect(another.openSession({ name: 'during failed teardown' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(other.stats().attemptsStarted).toBe(0);
    release.resolve();
    expect((await closing).map((error) => error.message).join()).toContain('isolation did not close');
    expect(pool.finishes).toHaveLength(1);
    await expect(opened.openSession({ name: 'unsafe reuse' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    const replacement = await another.openSession({ name: 'after failed owner disposed' });
    expect(await replacement.close()).toEqual([]);
    await opened.close();
    expect(fake.stats().disposes).toBe(1);
    expect(pool.finishes).toHaveLength(1);
  });

  it('AsyncDisposable reports session failures and host disposal failures as AggregateError', async () => {
    const fake = createFakeEngine({ onDispose: () => { throw new Error('worker disposal broke'); } });
    const opened = await host(fake.engine);
    const disposedSession = (async () => {
      await using session = await opened.openSession({ name: 'disposed soft error' });
      sdkExpect.soft(1).toBe(2);
      expect(session.runId).toBe(opened.runId);
    })();
    await expect(disposedSession).rejects.toBeInstanceOf(AggregateError);
    expect(fake.stats().disposes).toBe(0);
    const failures = await opened.close();
    expect(failures.map((failure) => failure.message).join('\n')).toContain('worker disposal broke');
    await expect(opened[Symbol.asyncDispose]()).rejects.toBeInstanceOf(AggregateError);
    expect(await opened.close()).toEqual(failures);
    expect(fake.stats().disposes).toBe(1);
  });

  it('await using closes a successful host and its still-live session', async () => {
    const fake = createFakeEngine();
    const pool = provisioned(fake);
    let tracePath = '';
    {
      await using opened = await host(pool.engine);
      const session = await opened.openSession({ name: 'implicit close' });
      tracePath = session.tracePath;
      await session.fixtures.app.open();
    }
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
    expect(pool.finishes).toHaveLength(1);
    expect(readFileSync(tracePath, 'utf8')).toContain('app.open');
  });

  it('bounds polls by config assertionTimeout and refreshes the deadline for the next session', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, { assertionTimeout: 40 }) });
    const first = await opened.openSession({ name: 'short poll', timeout: 200 });
    await expect(sdkExpect.poll(() => false, { interval: 5 }).toBe(true)).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('timed out after 40 ms') });
    expect(await first.close()).toEqual([]);
    const second = await opened.openSession({ name: 'fresh deadline', timeout: 5_000 });
    let reads = 0;
    await sdkExpect.poll(() => ++reads, { interval: 5, timeout: 500 }).toBeGreaterThan(2);
    await second.fixtures.app.open();
    const operation = fake.operations.find((entry) => entry.attemptId === second.attemptId);
    expect(operation?.timeoutMs).toBeGreaterThan(200);
    expect(operation?.runId).toBe(opened.runId);
    expect(await second.close()).toEqual([]);
  });

  it('caps contributed fixture calls at the session deadline and refuses dispatch after expiry', async () => {
    const fake = createFakeEngine({ fixtures: true });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'contributed deadline', timeout: 10 });
    await expect(session.fixtures.gadget.slow()).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
    await expect(session.fixtures.gadget.poke('too late')).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
    expect(fake.fixtureCalls).toEqual(['slow']);
    expect(session.steps()).toContainEqual(expect.objectContaining({ api: 'gadget.slow', status: 'failed', error: expect.objectContaining({ code: 'TEST_TIMEOUT' }) }));
    await session.close();
    expect(readFileSync(session.tracePath, 'utf8')).toContain('timed out');
  });

  it('keeps the session deadline when a contributed operation disables its own timeout', async () => {
    const fake = createFakeEngine();
    const engine: EngineHandle = { ...fake.engine, fixtures: {
      gadget: (context) => context.fixture('gadget', {
        hang: async () => new Promise<never>(() => undefined),
      }, { hang: { kind: 'resource', timeout: false } }),
    } };
    const opened = await host(engine);
    const session = await opened.openSession({ name: 'disabled operation timeout', timeout: 15 });
    await expect(session.fixtures.gadget.hang()).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
    expect(await session.close()).toEqual([]);
  });

  it('records a blocked agent verdict as non-passing and retains failure-only video', async () => {
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure', cache: 'off', agents: { default: { executor: {
        name: 'blocked-host-executor',
        async runStep() { return { status: 'blocked' as const, summary: 'cannot automate this surface', errorCode: 'AUTOMATION_UNSUPPORTED' as const }; },
      } } },
    }) });
    const session = await opened.openSession({ name: 'blocked automation' });
    await expect(session.fixtures.agent.act('unsupported operation')).rejects.toMatchObject({ code: 'AUTOMATION_UNSUPPORTED' });
    expect(session.steps().at(-1)?.status).toBe('blocked');
    await session.close();
    expect(readFileSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBeDefined();
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace).toContain('AUTOMATION_UNSUPPORTED');
    expect(trace.split('\n')[0]).not.toContain('passed');
  });

  it('records a cancelled fixture as interrupted and retains failure-only video', async () => {
    const controller = new AbortController();
    const fake = createFakeEngine({ video: true, fixtures: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: 'cancelled operation', signal: controller.signal });
    const pending = session.fixtures.gadget.hang();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    controller.abort();
    await rejected;
    expect(session.steps().at(-1)?.status).toBe('cancelled');
    await session.close();
    expect(readFileSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBeDefined();
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace).toContain('interrupted');
    expect(trace).toContain('CANCELLED');
    expect(trace.split('\n')[0]).not.toContain('passed');
  });

  it('caps an explicitly long poll at the session deadline', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'session deadline', timeout: 100 });
    await expect(sdkExpect.poll(() => false, { timeout: 30_000, interval: 5 }).toBe(true)).rejects.toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('attempt deadline') });
    await session.close();
    const next = await opened.openSession({ name: 'after timeout', timeout: 5_000 });
    await sdkExpect.poll(() => true).toBe(true);
    expect(await next.close()).toEqual([]);
  });

  it.each(['session signal', 'host signal', 'session close', 'host close'] as const)('cancels an in-flight poll on %s', async (cancellation) => {
    const controller = new AbortController();
    const fake = createFakeEngine();
    const opened = await host(fake.engine, cancellation === 'host signal' ? { signal: controller.signal } : {});
    const session = await opened.openSession({ name: cancellation, timeout: 30_000, ...(cancellation === 'session signal' ? { signal: controller.signal } : {}) });
    const reading = gate();
    const poll = sdkExpect.poll(() => {
      reading.resolve();
      return new Promise<boolean>(() => undefined);
    }, { timeout: 30_000 }).toBe(true).then(() => 'passed', () => 'cancelled');
    await reading.promise;
    if (cancellation.endsWith('signal')) controller.abort();
    else if (cancellation === 'host close') await opened.close();
    else await session.close();
    expect(await poll).toBe('cancelled');
    await session.close();
    expect(fake.stats().attemptsEnded).toBe(1);
  });

  it('records abandoned polls and steps without unhandled rejections or reads after close', async () => {
    const fake = createFakeEngine({ fixtures: true });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'abandoned work' });
    let reads = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (cause: unknown) => { unhandled.push(cause); };
    process.on('unhandledRejection', onUnhandled);
    try {
      sdkExpect.poll(() => ++reads, { timeout: 30_000, interval: 5 }).toBe(-1);
      session.fixtures.gadget.hang();
      const failures = await session.close();
      expect(failures.map((failure) => failure.code)).toContain('STEP_NOT_AWAITED');
      expect(failures.map((failure) => failure.message).join('\n')).toContain('expect.poll');
      expect(session.steps()).toContainEqual(expect.objectContaining({ api: 'gadget.hang', status: 'failed', error: expect.objectContaining({ code: 'STEP_NOT_AWAITED' }) }));
      const readsAtClose = reads;
      const next = await opened.openSession({ name: 'after abandoned poll' });
      await sdkExpect.poll(() => true).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).toBe(readsAtClose);
      expect(unhandled).toEqual([]);
      expect(await next.close()).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('redacts provider-valued session opening errors before an external runner can report them', async () => {
    const plaintext = 'opening-provider-secret-19JX';
    const token = secrets.get('openingToken');
    const fake = createFakeEngine({
      secrets: [token],
      onStartAttempt: async (context) => {
        const value = await context.resolveSecret(token);
        throw new Error(`start failed with ${value}`, { cause: new Error(`nested cause ${value}`) });
      },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { openingToken: () => plaintext } }) });
    const error: unknown = await opened.openSession({ name: 'failed launch' }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ category: 'infrastructure', code: 'ENGINE_FAILURE' });
    expect(inspect(error, { depth: 10 })).not.toContain(plaintext);
    expect(JSON.stringify(error)).not.toContain(plaintext);
    expect((error as Error).cause).toBeUndefined();
    expect(fake.stats().disposes).toBe(1);
  });

  it('redacts static secrets from host initialization errors', async () => {
    const plaintext = 'host-init-secret-81XX';
    const fake = createFakeEngine({ onInit: () => { throw new Error(`init failed ${plaintext}`); } });
    const error: unknown = await openHost({ cwd: dir, env: {}, config: config(fake.engine, { secrets: { initToken: plaintext } }) }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ category: 'infrastructure', code: 'ENGINE_FAILURE' });
    expect(inspect(error, { depth: 10 })).not.toContain(plaintext);
    expect(fake.stats().disposes).toBe(1);
  });

  it('redacts provider values resolved by an attempt from host finish failures and notices', async () => {
    const plaintext = 'provider-finish-secret-8Zq-22';
    const handle = secrets.get('finishToken');
    let resolved = '';
    let finishes = 0;
    const notices: string[] = [];
    const fake = createFakeEngine({ secrets: [handle], onStartAttempt: async (context) => {
      resolved = await context.resolveSecret(handle);
    } });
    const pool = provisioned(fake);
    const engine: EngineHandle = { ...pool.engine, async finish(info) {
      finishes += 1;
      info.log(`releasing ${resolved}`);
      throw new Error(`finish refused ${resolved}`);
    } };
    const opened = await host(engine, {
      config: config(engine, { secrets: { finishToken: () => plaintext } }),
      onNotice: (_target, message) => notices.push(message),
    });
    const session = await opened.openSession({ name: 'resolved during launch' });
    expect(resolved).toBe(plaintext);
    expect(await session.close()).toEqual([]);
    const failures = await opened.close();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('finish refused');
    expect(failures[0]?.message).toContain('<secret:finishToken>');
    expect(JSON.stringify(failures)).not.toContain(plaintext);
    expect(await opened.close()).toEqual(failures);
    await expect(opened[Symbol.asyncDispose]()).rejects.toMatchObject({
      message: expect.not.stringContaining(plaintext),
    });
    expect(finishes).toBe(1);
    for (const [file, content] of contentsUnder(path.join(dir, '.e2e'))) {
      expect(file).not.toContain(plaintext);
      expect(content, file).not.toContain(plaintext);
    }
    expect(notices.join('\n')).toContain('releasing <secret:finishToken>');
    expect(notices.join('\n')).not.toContain(plaintext);
  });

  it.each(['short', '180-character'] as const)('never puts a %s provider-valued session name in paths or a clipped trace title', async (length) => {
    const plaintext = length === 'short' ? 'provider-path-secret-5Jx-12' : 'ProviderTitleSecret-'.repeat(10).slice(0, 180);
    if (length === '180-character') expect(plaintext).toHaveLength(180);
    const handle = secrets.get('titleToken');
    const resolved: string[] = [];
    const fake = createFakeEngine({ secrets: [handle], onStartAttempt: async (context) => {
      resolved.push(await context.resolveSecret(handle));
    } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { titleToken: () => plaintext } }) });
    const directories: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const session = await opened.openSession({ name: `${plaintext} readable suffix` });
      const segment = path.relative(path.join(dir, '.e2e', 'results', 'host'), session.artifactsDir);
      expect(segment.split(path.sep)).toHaveLength(1);
      expect(segment).toMatch(/^host-session-[a-f0-9]+$/);
      expect(session.artifactsDir.toLowerCase()).not.toContain(plaintext.slice(0, 18).toLowerCase());
      expect(session.tracePath).toBe(path.join(session.artifactsDir, 'trace.md'));
      expect(await session.close()).toEqual([]);
      const trace = readFileSync(session.tracePath, 'utf8');
      expect(trace).toContain('secret:titleToken');
      expect(trace).toContain('readable suffix');
      expect(trace).not.toContain(plaintext);
      expect(trace).not.toContain(plaintext.slice(0, 18));
      directories.push(session.artifactsDir);
    }
    expect(resolved).toEqual([plaintext, plaintext]);
    expect(directories[0]).not.toBe(directories[1]);
    for (const [file, content] of contentsUnder(path.join(dir, '.e2e'))) {
      expect(file.toLowerCase()).not.toContain(plaintext.slice(0, 18).toLowerCase());
      expect(content, file).not.toContain(plaintext.slice(0, 18));
    }
  });

  it.each(['before A opens', 'while A is live'] as const)('keeps A credentials, secrets and deferred purpose when B is constructed %s', async (timing) => {
    const deferredPassword = secrets.get('purposeProbe.password');
    const token = secrets.get('onlyA');
    const first = createFakeEngine({
      scene: () => [{ id: 'token', role: 'textbox', name: 'Token', value: '' }],
      secrets: [token],
      onStartAttempt: async (context) => {
        expect(credentials.user('registryAccount').username).toBe('account-A');
        expect(secrets.get('onlyA').name).toBe('onlyA');
        expect(deferredPassword.purpose).toBe('password');
        expect(await context.resolveSecret(token)).toBe('registry-token-A-91');
      },
    });
    const second = createFakeEngine();
    const a = await host(first.engine, { config: config(first.engine, {
      credentials: {
        registryAccount: { username: 'account-A', password: 'registry-password-A-91' },
        purposeProbe: { username: 'purpose-A', password: 'purpose-password-A-91' },
      },
      secrets: { onlyA: 'registry-token-A-91' },
    }) });
    const openB = () => host(second.engine, { config: config(second.engine, {
      credentials: { registryAccount: { username: 'account-B', password: 'registry-password-B-42' } },
      secrets: { onlyB: 'registry-token-B-42', 'purposeProbe.password': 'generic-purpose-B-42' },
    }) });
    let b: E2EHost<GadgetFixtures> | undefined;
    if (timing === 'before A opens') b = await openB();
    const sessionA = await a.openSession({ name: 'registry A' });
    if (timing === 'while A is live') b = await openB();
    expect(credentials.user('registryAccount').username).toBe('account-A');
    expect(deferredPassword.purpose).toBe('password');
    expect(secrets.get('onlyA').purpose).toBe('generic-secret');
    expect(() => secrets.get('onlyB')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
    await sessionA.fixtures.app.open();
    await sessionA.fixtures.screen.getByRole('textbox', 'Token').fill(secrets.get('onlyA'));
    expect(first.callsOf(sessionA.attemptId, 'perform')).toContainEqual(expect.objectContaining({
      action: expect.objectContaining({ kind: 'fill', value: 'registry-token-A-91' }),
    }));
    expect(await sessionA.close()).toEqual([]);
    const sessionB = await b!.openSession({ name: 'registry B' });
    expect(credentials.user('registryAccount').username).toBe('account-B');
    expect(secrets.get('onlyB').name).toBe('onlyB');
    expect(deferredPassword.purpose).toBe('generic-secret');
    expect(() => secrets.get('onlyA')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
    expect(await sessionB.close()).toEqual([]);
  });

  it.each(['alone', 'dormant A', 'live A'] as const)('evaluates B file-config secret references independently with %s', async (timing) => {
    const first = createFakeEngine();
    let a: E2EHost<GadgetFixtures> | undefined;
    let sessionA: Awaited<ReturnType<E2EHost<GadgetFixtures>['openSession']>> | undefined;
    if (timing !== 'alone') {
      a = await host(first.engine, { config: config(first.engine, {
        secrets: { onlyA: 'file-registry-value-A' },
        credentials: { registryAccount: { username: 'account-A', password: 'file-password-value-A' } },
      }) });
      if (timing === 'live A') sessionA = await a.openSession({ name: 'A during config evaluation' });
    }
    const entered = gate();
    const proceed = gate();
    const shared: Record<string, unknown> = { entered, proceed };
    const second = createFakeEngine({ onStartAttempt: async (context) => {
      const token = shared.token as Parameters<typeof context.resolveSecret>[0];
      expect(await context.resolveSecret(token)).toBe('file-registry-value-B');
    } });
    shared.two = second.engine;
    (globalThis as Record<string, unknown>)[ENGINES] = shared;
    const filename = path.join(dir, 'registry-config.mts');
    writeFileSync(filename, `import { secrets } from ${JSON.stringify(sdkModule)};
      const shared = globalThis.${ENGINES};
      shared.token = secrets.get('onlyB');
      shared.entered.resolve();
      await shared.proceed.promise;
      const reference = secrets.get('onlyB');
      export default {
        secrets: { onlyB: 'file-registry-value-B' },
        targets: [{ name: 'kiosk', platform: 'kiosk', engine: { ...shared.two, secrets: [reference] }, app: ${JSON.stringify(FAKE_APP)} }]
      };`);
    const opening = host(second.engine, { config: filename });
    try {
      await Promise.race([entered.promise, opening.then(() => undefined)]);
      if (a !== undefined) {
        expect(secrets.get('onlyA').name).toBe('onlyA');
        expect(credentials.user('registryAccount').username).toBe('account-A');
        expect(() => secrets.get('onlyB')).toThrow(expect.objectContaining({ code: 'SECRET_UNAVAILABLE' }));
      }
    } finally {
      proceed.resolve();
    }
    const b = await opening;
    if (sessionA !== undefined) {
      expect(secrets.get('onlyA').name).toBe('onlyA');
      await sessionA.close();
    }
    const sessionB = await b.openSession({ name: 'B own file-config reference' });
    expect(secrets.get('onlyB').name).toBe('onlyB');
    expect(await sessionB.close()).toEqual([]);
  });

  it('releases engine ownership after clean worker teardown despite a live session soft failure', async () => {
    const fake = createFakeEngine({ fixtures: true });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    await opened.openSession({ name: 'soft failure during host close' });
    sdkExpect.soft(1).toBe(2);
    expect(await opened.close()).toContainEqual(expect.objectContaining({ code: 'ASSERTION_FAILED' }));
    expect(fake.stats().disposes).toBe(1);
    const replacement = await host(pool.engine);
    const next = await replacement.openSession({ name: 'cleanly reacquired engine' });
    expect(await next.fixtures.gadget.poke('reused')).toBe('poked reused');
    expect(await replacement.close()).toEqual([]);
    expect(fake.stats()).toMatchObject({ inits: 2, disposes: 2 });
    expect(pool.prepares).toHaveLength(2);
    expect(pool.finishes).toHaveLength(2);
  });

  it('rejects a duplicate engine owner before prepare or init without disposing the live host, then permits clean reuse', async () => {
    const fake = createFakeEngine({ fixtures: true });
    const pool = provisioned(fake);
    const opened = await host(pool.engine);
    const session = await opened.openSession({ name: 'original engine owner' });
    await expect(host(pool.engine)).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(pool.prepares).toHaveLength(1);
    expect(pool.finishes).toHaveLength(0);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 1, disposes: 0 });
    expect(await session.fixtures.gadget.poke('still usable')).toBe('poked still usable');
    await session.fixtures.app.open();
    expect(await session.close()).toEqual([]);
    expect(await opened.close()).toEqual([]);
    expect(pool.finishes).toHaveLength(1);
    expect(fake.stats().disposes).toBe(1);
    const replacement = await host(pool.engine);
    const next = await replacement.openSession({ name: 'reused after clean worker teardown' });
    expect(await next.fixtures.gadget.poke('new owner')).toBe('poked new owner');
    expect(await next.close()).toEqual([]);
    expect(await replacement.close()).toEqual([]);
    expect(pool.prepares).toHaveLength(2);
    expect(pool.finishes).toHaveLength(2);
    expect(fake.stats()).toMatchObject({ inits: 2, attemptsStarted: 2, disposes: 2 });
  });

  it('claims an engine before asynchronous prepare so concurrent host construction cannot enter its hooks', async () => {
    const entered = gate();
    const release = heldGate();
    const fake = createFakeEngine({ fixtures: true });
    let prepares = 0;
    const engine: EngineHandle = { ...fake.engine, async prepare() {
      prepares += 1;
      entered.resolve();
      await release.promise;
    } };
    const opening = host(engine);
    await entered.promise;
    await expect(host(engine)).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(prepares).toBe(1);
    expect(fake.stats()).toMatchObject({ inits: 0, disposes: 0, attemptsStarted: 0 });
    release.resolve();
    const opened = await opening;
    const session = await opened.openSession({ name: 'prepare owner survived' });
    expect(await session.fixtures.gadget.poke('after prepare')).toBe('poked after prepare');
    expect(await session.close()).toEqual([]);
    expect(await opened.close()).toEqual([]);
    expect(fake.stats()).toMatchObject({ inits: 1, disposes: 1 });
  });

  it.each(['dispose', 'finish'] as const)('retains the engine lease until asynchronous worker %s completes', async (hook) => {
    const entered = gate();
    const release = heldGate();
    const fake = createFakeEngine(hook === 'dispose' ? { onDispose: async () => { entered.resolve(); await release.promise; } } : {});
    const pool = provisioned(fake);
    const engine: EngineHandle = { ...pool.engine, ...(hook === 'finish' ? { async finish(info: EngineFinishInfo) {
      entered.resolve();
      await release.promise;
      await pool.engine.finish?.(info);
    } } : {}) };
    const opened = await host(engine);
    const closing = opened.close();
    await entered.promise;
    await expect(host(engine)).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(pool.prepares).toHaveLength(1);
    expect(fake.stats().inits).toBe(1);
    expect(fake.stats().disposes).toBe(1);
    release.resolve();
    expect(await closing).toEqual([]);
    const replacement = await host(engine);
    expect(pool.prepares).toHaveLength(2);
    expect(fake.stats().inits).toBe(2);
    expect(await replacement.close()).toEqual([]);
  });

  it.each(['dispose', 'finish'] as const)('fails closed on duplicate engine reuse after worker %s fails', async (hook) => {
    const fake = createFakeEngine(hook === 'dispose' ? { onDispose: () => { throw new Error('unsafe worker dispose'); } } : {});
    const pool = provisioned(fake);
    const engine: EngineHandle = { ...pool.engine, ...(hook === 'finish' ? { async finish(info: EngineFinishInfo) {
      await pool.engine.finish?.(info);
      throw new Error('unsafe worker finish');
    } } : {}) };
    const opened = await host(engine);
    const failures = await opened.close();
    expect(failures.map((failure) => failure.message).join('\n')).toContain(`unsafe worker ${hook}`);
    await expect(host(engine)).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    expect(await opened.close()).toEqual(failures);
    expect(pool.prepares).toHaveLength(1);
    expect(pool.finishes).toHaveLength(1);
    expect(fake.stats()).toMatchObject({ inits: 1, disposes: 1 });
  });

  it.each(['failed', 'passed'] as const)('records hosted retain-on-failure video and only keeps a %s session file', async (status) => {
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: `hosted video ${status}` });
    expect(fake.operations.filter((operation) => operation.method === 'artifacts.startVideo')).toHaveLength(1);
    await session.fixtures.app.open();
    if (status === 'failed') sdkExpect.soft(1, 'video soft failure').toBe(2);
    const failures = await session.close();
    expect(failures.map((failure) => failure.code)).toEqual(status === 'failed' ? ['ASSERTION_FAILED'] : []);
    expect(fake.operations.filter((operation) => operation.method === 'artifacts.stopVideo')).toHaveLength(1);
    const video = path.join(session.artifactsDir, 'video', 'fake.webm');
    expect(existsSync(video)).toBe(status === 'failed');
    const trace = readFileSync(session.tracePath, 'utf8');
    if (status === 'failed') {
      expect(readFileSync(video).length).toBeGreaterThan(0);
      const links = [...trace.matchAll(/\]\(([^)]+)\)/g)].map((match) => decodeURIComponent(match[1]!));
      expect(links.some((link) => path.resolve(path.dirname(session.tracePath), link) === video)).toBe(true);
      expect(trace).toContain('ASSERTION_FAILED');
    } else expect(trace).not.toContain('fake.webm');
    expect(await opened.close()).toEqual([]);
  });

  it('writes safe per-session trace pages with readable artifact links and redacted names and errors', async () => {
    const secret = 'host-secret-7Xq-91';
    const handle = secrets.get('hostToken');
    const fake = createFakeEngine({ fixtures: true, artifacts: true, secrets: [handle],
      onStartAttempt: async (context) => { await context.resolveSecret(handle); },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { hostToken: secret } }) });
    const name = `../../escape\\folder/<script>\u001b[31m ${secret}`;
    const traces: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const session = await opened.openSession({ name });
      await session.fixtures.app.screenshot(`home ${secret}`);
      await session.fixtures.gadget.dropFile();
      sdkExpect.soft(secret, `private ${secret}`).toBe('not the token');
      const failures = await session.close();
      const steps = session.steps();
      expect(JSON.stringify({ failures, steps })).not.toContain(secret);
      expect(path.isAbsolute(session.tracePath)).toBe(true);
      const relative = path.relative(path.join(dir, '.e2e', 'results', 'host'), session.artifactsDir);
      expect(relative).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(relative.split(path.sep)).toHaveLength(1);
      expect(relative).not.toContain(secret);
      const trace = readFileSync(session.tracePath, 'utf8');
      expect(trace).toContain('app.screenshot');
      expect(trace).toContain('gadget.dropFile');
      expect(trace).toContain('ASSERTION_FAILED');
      expect(trace).not.toContain(secret);
      expect(trace).not.toContain('\u001b');
      expect(trace).not.toContain('<script>');
      const links = [...trace.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
      const localLinks = links.filter((link) => !/^[a-z][a-z\d+.-]*:/i.test(link) && !link.startsWith('#'));
      expect(localLinks.length).toBeGreaterThan(0);
      for (const link of localLinks) {
        expect(readFileSync(path.resolve(path.dirname(session.tracePath), decodeURIComponent(link)))).toBeDefined();
      }
      expect(readFileSync(path.join(session.artifactsDir, 'gadget', 'log.txt'), 'utf8')).toBe('gadget log\n');
      traces.push(session.tracePath);
    }
    expect(traces[0]).not.toBe(traces[1]);
    const output = path.join(dir, '.e2e');
    for (const [file, content] of contentsUnder(output)) {
      expect(file).not.toContain(secret);
      expect(content, file).not.toContain(secret);
    }
  });

});
