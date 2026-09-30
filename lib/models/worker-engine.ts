/**
 * The `OnDeviceEngine` that talks to the nested worker (P4 spec §3.3, §3.16).
 *
 * Everything here is bookkeeping: give each request an id, keep the promise
 * that is waiting for it, and make sure nothing is left waiting when the worker
 * dies or the caller aborts. The audio itself never passes through this class's
 * logic — a `Float32Array` is handed back and goes straight into a WAV.
 *
 * The worker is injected rather than constructed here so this can be tested
 * with a fake one. `createLocalWorker` is the only place that knows the worker
 * file's path.
 */

import type { Device } from './device';
import { abortError, type DeviceInfo, type OnDeviceEngine, type RawPcm } from './engine';
import type { ModelTier, OnDeviceFamily, OnDeviceModel } from './registry';
import type { ModelSource } from './urls';
import { isWorkerReply, type WorkerReply, type WorkerRequest } from './worker-protocol';

/** The slice of `Worker` this module uses. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

export interface WorkerLocalEngineOptions {
  readonly worker: WorkerLike;
  /**
   * Where canonical URLs resolve to.
   *
   * Resolved by the service worker and handed down, because an offscreen
   * document has no `chrome.storage` to read the user's choice from — the same
   * reason the cache policy travels as a message.
   */
  readonly source: ModelSource;
  /** True when `source` came from `auto`, so one retry is allowed. */
  readonly allowFallback?: boolean;
  readonly family?: OnDeviceFamily;
}

/** One request waiting for its reply. */
interface Pending {
  resolve: (reply: WorkerReply) => void;
  reject: (error: unknown) => void;
}

export class WorkerLocalEngine implements OnDeviceEngine {
  readonly family: OnDeviceFamily;

  private readonly worker: WorkerLike;
  private readonly source: ModelSource;
  private readonly allowFallback: boolean;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private initialised: Promise<void> | null = null;
  private disposed = false;

  constructor(options: WorkerLocalEngineOptions) {
    this.worker = options.worker;
    this.source = options.source;
    this.allowFallback = options.allowFallback ?? false;
    this.family = options.family ?? 'kokoro';
    this.worker.addEventListener('message', this.onMessage);
  }

  /**
   * Install the fetch patch in the worker, once.
   *
   * Every entry point awaits this, because the patch has to be in place before
   * the first request the model makes — and `load` is what makes it.
   */
  private init(): Promise<void> {
    this.initialised ??= this.request((id) => ({
      type: 'init',
      id,
      source: this.source,
      allowFallback: this.allowFallback,
    })).then(() => undefined);
    return this.initialised;
  }

  async load(model: OnDeviceModel, tier: ModelTier, device: Device): Promise<DeviceInfo> {
    await this.init();
    const reply = await this.request((id) => ({
      type: 'load',
      id,
      modelId: model.id,
      tierId: tier.id,
      device,
    }));
    if (reply.type !== 'loaded') throw unexpected(reply);
    return reply.info;
  }

  async synthesize(
    text: string,
    voiceId: string,
    lang: string,
    signal: AbortSignal
  ): Promise<RawPcm> {
    await this.init();
    if (signal.aborted) throw abortError();

    const id = this.nextId;
    const reply = this.request((requestId) => ({
      type: 'synthesize',
      id: requestId,
      text,
      voiceId,
      lang,
    }));

    // A seek or a stop has to reach the worker: the inference is already
    // running, and dropping the reply would leave it occupying the device
    // while the next sentence waits for it.
    const onAbort = (): void => {
      this.post({ type: 'cancel', id });
      const waiting = this.pending.get(id);
      if (waiting) {
        this.pending.delete(id);
        waiting.reject(abortError());
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const settled = await reply;
      if (settled.type !== 'pcm') throw unexpected(settled);
      return { pcm: settled.pcm, sampleRate: settled.sampleRate };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.post({ type: 'dispose' });
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.terminate();
    this.failAll(new Error('the local engine was disposed'));
  }

  /** Send a request and resolve with the reply that carries its id. */
  private request(build: (id: number) => WorkerRequest): Promise<WorkerReply> {
    if (this.disposed) return Promise.reject(new Error('the local engine was disposed'));

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<WorkerReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.post(build(id));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private post(message: WorkerRequest): void {
    // The PCM reply is transferred, but nothing is sent the other way that is
    // worth transferring.
    this.worker.postMessage(message);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const reply: unknown = event.data;
    if (!isWorkerReply(reply)) return;

    const waiting = this.pending.get(reply.id);
    if (!waiting) return;
    this.pending.delete(reply.id);

    if (reply.type === 'error') {
      const error = new Error(reply.message);
      error.name = reply.code;
      waiting.reject(error);
      return;
    }
    waiting.resolve(reply);
  };

  private failAll(error: unknown): void {
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
  }
}

function unexpected(reply: WorkerReply): Error {
  return new Error(`the local worker answered with ${reply.type}`);
}

/**
 * Start the nested worker.
 *
 * The path has to be a literal in `new URL(...)` for the bundler to find and
 * emit it — which is also why this is the only place that names the file.
 */
export function createLocalWorker(): WorkerLike {
  return new Worker(new URL('../../entrypoints/offscreen/local.worker.ts', import.meta.url), {
    type: 'module',
  });
}
