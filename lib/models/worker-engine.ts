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
import {
  abortError,
  type DeviceInfo,
  type OnDeviceEngine,
  type RawPcm,
  WORKER_DEAD,
} from './engine';
import type { ModelTier, OnDeviceFamily, OnDeviceModel } from './registry';
import type { ModelSource } from './urls';
import { isWorkerReply, type WorkerReply, type WorkerRequest } from './worker-protocol';

/**
 * The worker events this engine listens for.
 *
 * Named apart from the DOM's `WorkerEventMap` so the generic constraint below
 * cannot accidentally bind to the global one — the shapes happen to match
 * today, and a silent divergence would be invisible. Exported because a test
 * that stands in for a worker has to implement the same surface.
 */
export interface LocalWorkerEvents {
  message: MessageEvent;
  error: ErrorEvent;
  messageerror: MessageEvent;
}

/** The slice of `Worker` this module uses. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener<K extends keyof LocalWorkerEvents>(
    type: K,
    listener: (event: LocalWorkerEvents[K]) => void
  ): void;
  removeEventListener<K extends keyof LocalWorkerEvents>(
    type: K,
    listener: (event: LocalWorkerEvents[K]) => void
  ): void;
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
  /**
   * Why the worker is gone, once it is.
   *
   * The error itself rather than a flag: a request made after the crash has to
   * see the same reason the crash gave, not a generic replacement — the
   * worker's own message is usually the only actionable half.
   */
  private dead: Error | null = null;

  constructor(options: WorkerLocalEngineOptions) {
    this.worker = options.worker;
    this.source = options.source;
    this.allowFallback = options.allowFallback ?? false;
    this.family = options.family ?? 'kokoro';
    this.worker.addEventListener('message', this.onMessage);
    // Without these two the failure mode is silence. A worker that throws
    // outside a request never answers that request, so the promise waiting for
    // it is never settled — and the page cannot see the worker's stack at all,
    // which leaves a hang as the only symptom and nothing in any console.
    this.worker.addEventListener('error', this.onError);
    this.worker.addEventListener('messageerror', this.onError);
  }

  /**
   * Install the fetch patch in the worker, once.
   *
   * Every entry point awaits this, because the patch has to be in place before
   * the first request the model makes — and `load` is what makes it.
   */
  private init(): Promise<void> {
    if (this.initialised) return this.initialised;

    const initialised = this.request((id) => ({
      type: 'init',
      id,
      source: this.source,
      allowFallback: this.allowFallback,
    }))
      .then(() => undefined)
      .catch((error: unknown) => {
        // Not memoized: the handshake may have failed against a worker that has
        // since died, and the next call deserves a fresh attempt rather than
        // the same rejection forever.
        this.initialised = null;
        throw error;
      });

    this.initialised = initialised;
    return initialised;
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
    this.detach();
    this.worker.terminate();
    this.failAll(new Error('the local engine was disposed'));
  }

  /** Send a request and resolve with the reply that carries its id. */
  private request(build: (id: number) => WorkerRequest): Promise<WorkerReply> {
    if (this.disposed) return Promise.reject(new Error('the local engine was disposed'));
    if (this.dead) return Promise.reject(this.dead);

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

  /** Stop listening to a worker that is being torn down. */
  private detach(): void {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.removeEventListener('messageerror', this.onError);
  }

  /**
   * The worker failed outside any request it was answering.
   *
   * A request in flight will never be answered now, so the one thing that must
   * happen is that nobody keeps waiting for it. The worker is torn down and
   * every later call fails at once — which is what lets the provider notice and
   * build a fresh engine for the next sentence instead of retrying into a
   * corpse.
   */
  private readonly onError = (event: Event): void => {
    // Read structurally: `ErrorEvent` does not survive every fake in tests, and
    // the message is the only part worth keeping.
    const detail = (event as { message?: unknown }).message;
    this.fail(typeof detail === 'string' ? detail : '');
  };

  private fail(message: string): void {
    if (this.dead) return;
    const error = deadWorkerError(message);
    this.dead = error;
    this.detach();
    this.worker.terminate();
    this.failAll(error);
  }
}

/** The error every later request sees once the worker is gone. */
function deadWorkerError(message?: string): Error {
  const text =
    message !== undefined && message.length > 0 ? message : 'the on-device worker stopped';
  const error = new Error(text);
  error.name = WORKER_DEAD;
  return error;
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
