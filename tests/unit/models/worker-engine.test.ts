/**
 * The nested worker, as the engine above it sees it.
 *
 * The case worth guarding is the one that is invisible in a browser: a worker
 * that throws outside a request it is answering. Nothing in the page can see
 * that stack, and if the engine is not listening for it the request in flight
 * waits forever — which reads as "playback does nothing" rather than as an
 * error, and is exactly how the on-device path failed in manual testing.
 *
 * The happy path is covered too, because every test here would pass just as
 * well against an engine that rejects everything.
 */
import { describe, expect, it } from 'vitest';
import { isWorkerDeadError } from '~/lib/models/engine';
import { KOKORO_82M, type ModelTier, tierById } from '~/lib/models/registry';
import { type WorkerLike, WorkerLocalEngine } from '~/lib/models/worker-engine';
import type { WorkerReply, WorkerRequest } from '~/lib/models/worker-protocol';

/** A worker that records what it was sent, and can be made to die. */
class FakeWorker {
  readonly posted: WorkerRequest[] = [];
  terminated = 0;

  private messageListener: ((event: MessageEvent) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private messageErrorListener: ((event: MessageEvent) => void) | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message as WorkerRequest);
  }

  addEventListener(type: string, listener: unknown): void {
    if (type === 'message') this.messageListener = listener as (event: MessageEvent) => void;
    else if (type === 'error') this.errorListener = listener as (event: ErrorEvent) => void;
    else if (type === 'messageerror')
      this.messageErrorListener = listener as (event: MessageEvent) => void;
  }

  removeEventListener(type: string, listener: unknown): void {
    if (type === 'message' && this.messageListener === listener) this.messageListener = null;
    else if (type === 'error' && this.errorListener === listener) this.errorListener = null;
    else if (type === 'messageerror' && this.messageErrorListener === listener) {
      this.messageErrorListener = null;
    }
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Every listener still attached, so teardown can be asserted. */
  get listeners(): number {
    return (
      (this.messageListener === null ? 0 : 1) +
      (this.errorListener === null ? 0 : 1) +
      (this.messageErrorListener === null ? 0 : 1)
    );
  }

  /** Answer a request the way the real worker does. */
  reply(reply: WorkerReply): void {
    this.messageListener?.({ data: reply } as MessageEvent);
  }

  /** Fail the way a worker does when it throws outside a request. */
  crash(message = 'boom'): void {
    this.errorListener?.({ message } as ErrorEvent);
  }

  /** Fail the way a worker does when a reply cannot be deserialized. */
  breakChannel(): void {
    this.messageErrorListener?.({} as MessageEvent);
  }
}

/** The fake is structurally a worker; the cast keeps the test readable. */
function asWorker(worker: FakeWorker): WorkerLike {
  return worker as unknown as WorkerLike;
}

/** Let every microtask queued by the engine run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function tierOf(id: string): ModelTier {
  const tier = tierById(KOKORO_82M, id);
  if (!tier) throw new Error(`the registry has no ${id} tier`);
  return tier;
}

function setup() {
  const worker = new FakeWorker();
  const engine = new WorkerLocalEngine({
    worker: asWorker(worker),
    source: { host: 'modelscope' },
  });
  return { worker, engine };
}

/** Answer the handshake and wait for the request that follows it. */
async function handshake(worker: FakeWorker): Promise<void> {
  worker.reply({ type: 'ready', id: 1 });
  await tick();
}

describe('WorkerLocalEngine', () => {
  it('resolves a load the worker answers', async () => {
    const { worker, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    await handshake(worker);
    worker.reply({
      type: 'loaded',
      id: 2,
      info: { device: 'webgpu', sessionInitMs: 5 },
    });

    await expect(loading).resolves.toEqual({ device: 'webgpu', sessionInitMs: 5 });
  });

  it('sends the handshake before the load', async () => {
    const { worker, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    expect(worker.posted).toEqual([
      { type: 'init', id: 1, source: { host: 'modelscope' }, allowFallback: false },
    ]);

    await handshake(worker);
    expect(worker.posted[1]).toEqual({
      type: 'load',
      id: 2,
      modelId: 'kokoro-82m',
      tierId: 'fp16',
      device: 'webgpu',
    });

    worker.reply({ type: 'loaded', id: 2, info: { device: 'webgpu', sessionInitMs: 1 } });
    await loading;
  });

  it('rejects the request in flight when the worker dies', async () => {
    const { worker, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    // Attached before the crash so the rejection is never unhandled.
    const failure = expect(loading).rejects.toThrow('boom');

    await handshake(worker);
    worker.crash('boom');

    await failure;
  });

  it('names the failure so the provider knows to rebuild the engine', async () => {
    const { worker, engine } = setup();
    worker.crash('the GPU process went away');

    const error = await engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu').catch((e: unknown) => e);

    expect(isWorkerDeadError(error)).toBe(true);
    expect((error as Error).message).toBe('the GPU process went away');
  });

  it('treats an undeliverable reply the same way', async () => {
    const { worker, engine } = setup();
    worker.breakChannel();

    const error = await engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu').catch((e: unknown) => e);

    expect(isWorkerDeadError(error)).toBe(true);
  });

  it('fails at once once the worker is gone, without sending anything to it', async () => {
    const { worker, engine } = setup();
    worker.crash('worker died');
    const posted = worker.posted.length;

    await expect(engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu')).rejects.toThrow('worker died');

    // A request that cannot be answered must not be sent to a dead worker.
    expect(worker.posted).toHaveLength(posted);
  });

  it('fails an in-flight synthesis, not only a load', async () => {
    const { worker, engine } = setup();

    const synthesis = engine.synthesize('hello', 'af_heart', 'en-US', new AbortController().signal);
    const failure = expect(synthesis).rejects.toThrow('boom');

    await handshake(worker);
    worker.crash('boom');

    await failure;
  });

  it('stops listening to a worker it has given up on', () => {
    const { worker } = setup();
    expect(worker.listeners).toBe(3);

    worker.crash('boom');

    expect(worker.listeners).toBe(0);
  });

  it('terminates the worker it can no longer trust', () => {
    const { worker } = setup();
    worker.crash('boom');

    expect(worker.terminated).toBe(1);
  });

  it('survives a second crash without tearing down twice', () => {
    const { worker } = setup();
    worker.crash('first');
    worker.crash('second');

    expect(worker.terminated).toBe(1);
  });

  it('retries the handshake when it failed, rather than reusing the rejection', async () => {
    const { worker, engine } = setup();

    // The handshake fails while the worker is alive: a call made after that
    // must send a new `init` instead of returning the same rejection forever.
    const first = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    const firstFailure = expect(first).rejects.toThrow('no');
    worker.reply({ type: 'error', id: 1, code: 'model-load-failed', message: 'no' });
    await firstFailure;

    const second = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    await tick();

    expect(worker.posted.filter((message) => message.type === 'init')).toHaveLength(2);
    worker.reply({ type: 'ready', id: 2 });
    await tick();
    worker.reply({ type: 'loaded', id: 3, info: { device: 'webgpu', sessionInitMs: 1 } });
    await expect(second).resolves.toBeDefined();
  });

  it('rejects every waiting request when it is disposed', async () => {
    const { worker, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    const failure = expect(loading).rejects.toThrow('disposed');

    engine.dispose();

    await failure;
    expect(worker.terminated).toBe(1);
    expect(worker.listeners).toBe(0);
  });
});
