/**
 * The `OnDeviceEngine` that owns the offscreen document's two workers (P4 spec
 * §3.3, §3.16).
 *
 * Everything here is bookkeeping: give each request an id, keep the promise
 * that is waiting for it, and make sure nothing is left waiting when a worker
 * dies or the caller aborts. The audio itself never passes through this class's
 * logic — a `Float32Array` is handed back and goes straight into a WAV.
 *
 * Since phase 7 that bookkeeping covers two workers instead of one, and this
 * class is also where they are *scheduled*: a sentence is phonemized in one
 * worker, then synthesized in the other, and the step in between — cutting the
 * sentence to fit the model's token limit — is here because it is the only
 * place that can reach both halves. The cut needs a token count (which only the
 * kokoro worker has) of phonemes (which only the phonemize worker produces), so
 * neither worker could do it alone. A `MessageChannel` would let them talk
 * directly, but then the policy would live in a worker, away from the aborts,
 * the retries and the failure handling that are already here.
 *
 * **Either worker dying takes both down.** They are independent isolates and
 * Chrome reclaims them independently, so one can be gone while the other is
 * still fine — and there is no useful state to preserve across that: the
 * dictionaries and the session are both rebuildable, and a half-alive engine
 * would fail on the next sentence anyway. Tearing both down is what makes the
 * next sentence start from a known state instead of from whichever half
 * survived.
 *
 * The workers are injected rather than constructed here so this can be tested
 * with fakes. The `create*` functions at the bottom are the only place that
 * knows the worker files' paths.
 */

import { planPieces } from './audio';
import type { Device } from './device';
import {
  abortError,
  type DeviceInfo,
  type OnDeviceEngine,
  type RawPcm,
  WORKER_DEAD,
} from './engine';
import {
  isPhonemizeWorkerReply,
  type PhonemizeWorkerReply,
  type PhonemizeWorkerRequest,
} from './phonemize-worker-protocol';
import type { ModelTier, OnDeviceFamily, OnDeviceModel } from './registry';
import type { ModelSource } from './urls';
import type { VocabId } from './vocab';
import { isErrorReply } from './worker-message';
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
   * The worker that turns text into phonemes.
   *
   * Required rather than optional: an engine without one cannot phonemize, and
   * the failure would otherwise wait until the first sentence — where it would
   * read as a broken install rather than as a missing argument.
   */
  readonly phonemizeWorker: WorkerLike;
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
interface Pending<Reply> {
  resolve: (reply: Reply) => void;
  reject: (error: unknown) => void;
}

/** A request that has been sent, and the id a `cancel` would name. */
interface InFlight<Reply> {
  readonly id: number;
  readonly reply: Promise<Reply>;
}

/**
 * One worker, and the map from request id to the promise waiting for it.
 *
 * Generic over the two protocols rather than written twice: what differs
 * between them is only which messages exist, and the failure handling — the
 * part worth getting right — is identical. The reply guard is a parameter
 * because a worker's `message` event is not a trusted boundary, and because a
 * worker left over from a previous version is a real possibility.
 */
class WorkerClient<Request, Reply extends { readonly id: number }> {
  private readonly pending = new Map<number, Pending<Reply>>();
  private nextId = 1;
  /**
   * Set once the worker is gone, whichever way it went.
   *
   * Doubles as the "do not touch it again" flag: a torn client never posts,
   * never terminates a second time, and rejects everything immediately. Both
   * halves matter — a second `terminate` is what a crash arriving twice would
   * otherwise cause, and a post to a terminated worker is silent data loss.
   */
  private torn = false;
  private failure: Error | null = null;

  constructor(
    private readonly worker: WorkerLike,
    private readonly isReply: (value: unknown) => value is Reply,
    private readonly onDead: (error: Error) => void
  ) {
    this.worker.addEventListener('message', this.onMessage);
    // Without these two the failure mode is silence. A worker that throws
    // outside a request never answers that request, so the promise waiting for
    // it is never settled — and the page cannot see the worker's stack at all,
    // which leaves a hang as the only symptom and nothing in any console.
    this.worker.addEventListener('error', this.onError);
    this.worker.addEventListener('messageerror', this.onError);
  }

  /** Send a request and resolve with the reply that carries its id. */
  request(build: (id: number) => Request): InFlight<Reply> {
    const id = this.nextId;
    this.nextId += 1;

    if (this.torn) return { id, reply: Promise.reject(this.reason()) };

    const reply = new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage(build(id));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    return { id, reply };
  }

  /** Send a message that expects no reply. */
  post(message: Request): void {
    if (this.torn) return;
    this.worker.postMessage(message);
  }

  /**
   * Stop waiting for one request, as an abort does.
   *
   * The worker is not told: only the kokoro worker has a `cancel`, and the
   * caller sends that itself, because what to cancel is protocol knowledge.
   */
  abandon(id: number, error: unknown): void {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    waiting.reject(error);
  }

  /** Tear down the worker and fail everything waiting, with `error`. */
  disposeWith(error: Error): void {
    if (this.torn) return;
    this.torn = true;
    this.failure = error;
    this.detach();
    this.worker.terminate();
    this.failAll(error);
  }

  dispose(): void {
    this.disposeWith(new Error('the local engine was disposed'));
  }

  private reason(): Error {
    return this.failure ?? new Error('the local engine was disposed');
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const reply: unknown = event.data;
    if (!this.isReply(reply)) return;

    const waiting = this.pending.get(reply.id);
    if (!waiting) return;
    this.pending.delete(reply.id);

    if (isErrorReply(reply)) {
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
   * happen is that nobody keeps waiting for it. The engine above is told, which
   * is what lets it take the other worker down too.
   */
  private readonly onError = (event: Event): void => {
    // Read structurally: `ErrorEvent` does not survive every fake in tests, and
    // the message is the only part worth keeping.
    const detail = (event as { message?: unknown }).message;
    const error = deadWorkerError(typeof detail === 'string' ? detail : '');
    this.disposeWith(error);
    this.onDead(error);
  };
}

export class WorkerLocalEngine implements OnDeviceEngine {
  readonly family: OnDeviceFamily;

  private readonly kokoro: WorkerClient<WorkerRequest, WorkerReply>;
  private readonly phonemizer: WorkerClient<PhonemizeWorkerRequest, PhonemizeWorkerReply>;
  private readonly source: ModelSource;
  private readonly allowFallback: boolean;
  /**
   * Why the engine is gone, once it is.
   *
   * The error itself rather than a flag: a request made after the crash has to
   * see the same reason the crash gave, not a generic replacement — the
   * worker's own message is usually the only actionable half.
   */
  private dead: Error | null = null;
  private disposed = false;
  private kokoroReady: Promise<void> | null = null;
  private phonemizerReady: Promise<void> | null = null;
  /**
   * Dictionaries already loaded, by `(vocab, lang)`.
   *
   * Keyed by both because they are independent: the same language needs
   * different dictionaries under v1.0 and v1.1-zh, and one vocabulary speaks
   * several languages. The value is the *promise*, so a prefetch and the
   * sentence being listened to cannot both pay for the same 8 MB of
   * decompression.
   */
  private readonly prepared = new Map<string, Promise<void>>();
  /** The inventory the loaded model's voices need; null until `load`. */
  private vocab: VocabId | null = null;

  constructor(options: WorkerLocalEngineOptions) {
    this.source = options.source;
    this.allowFallback = options.allowFallback ?? false;
    this.family = options.family ?? 'kokoro';
    this.kokoro = new WorkerClient(options.worker, isWorkerReply, this.onWorkerDead);
    this.phonemizer = new WorkerClient(
      options.phonemizeWorker,
      isPhonemizeWorkerReply,
      this.onWorkerDead
    );
  }

  /**
   * Load the model, and instantiate the phonemizer alongside it.
   *
   * The two are independent — one is a 163 MB ONNX session, the other is 5 MB
   * of wasm and a dictionary — so they are started together rather than one
   * after the other. It is a few milliseconds next to twelve seconds, and it
   * also means the phonemizer is ready by the time the first sentence needs it.
   */
  async load(model: OnDeviceModel, tier: ModelTier, device: Device): Promise<DeviceInfo> {
    this.ensureAlive();
    const [info] = await Promise.all([this.loadModel(model, tier, device), this.initPhonemizer()]);
    return info;
  }

  /**
   * Speak `text`.
   *
   * Three steps, and the middle one is why this class exists at all: phonemize
   * a piece, ask what it costs in tokens, and repeat until the sentence is cut
   * small enough to fit the model — then hand the pieces over.
   */
  async synthesize(
    text: string,
    voiceId: string,
    lang: string,
    signal: AbortSignal
  ): Promise<RawPcm> {
    this.ensureAlive();
    await Promise.all([this.initKokoro(), this.initPhonemizer()]);
    if (signal.aborted) throw abortError();

    const vocab = this.vocab;
    if (!vocab) throw new Error('the model is not loaded');

    await this.prepare(vocab, lang);
    if (signal.aborted) throw abortError();

    const pieces = await planPieces(text, async (piece) => {
      if (signal.aborted) throw abortError();
      const ipa = await this.phonemizeText(piece, vocab, lang);
      return { ipa, tokens: await this.countTokens(ipa) };
    });
    if (signal.aborted) throw abortError();

    const { id, reply } = this.kokoro.request((requestId) => ({
      type: 'synthesize',
      id: requestId,
      pieces: pieces.map(({ ipa }) => ({ ipa })),
      voiceId,
      lang,
    }));

    // A seek or a stop has to reach the worker: the inference is already
    // running, and dropping the reply would leave it occupying the device
    // while the next sentence waits for it.
    const onAbort = (): void => {
      this.kokoro.post({ type: 'cancel', id });
      this.kokoro.abandon(id, abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const settled = await reply;
      if (settled.type !== 'pcm') throw unexpected('kokoro', settled.type);
      return { pcm: settled.pcm, sampleRate: settled.sampleRate };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.prepared.clear();
    this.kokoro.post({ type: 'dispose' });
    this.phonemizer.post({ type: 'dispose' });
    this.kokoro.dispose();
    this.phonemizer.dispose();
  }

  /** The model's session, built once. */
  private async loadModel(
    model: OnDeviceModel,
    tier: ModelTier,
    device: Device
  ): Promise<DeviceInfo> {
    await this.initKokoro();
    const { reply } = this.kokoro.request((id) => ({
      type: 'load',
      id,
      modelId: model.id,
      tierId: tier.id,
      device,
    }));
    const settled = await reply;
    if (settled.type !== 'loaded') throw unexpected('kokoro', settled.type);
    // Remembered here rather than passed per sentence: the inventory follows
    // the model, and this is the only message that names one.
    this.vocab = model.vocab;
    return settled.info;
  }

  /**
   * Install the fetch patch in the kokoro worker, once.
   *
   * Every entry point awaits this, because the patch has to be in place before
   * the first request the model makes — and `load` is what makes it.
   */
  private initKokoro(): Promise<void> {
    if (this.kokoroReady) return this.kokoroReady;

    const ready = this.kokoro
      .request((id) => ({
        type: 'init',
        id,
        source: this.source,
        allowFallback: this.allowFallback,
      }))
      .reply.then((reply) => {
        if (reply.type !== 'ready') throw unexpected('kokoro', reply.type);
      })
      .catch((error: unknown) => {
        // Not memoized: the handshake may have failed against a worker that has
        // since died, and the next call deserves a fresh attempt rather than
        // the same rejection forever.
        this.kokoroReady = null;
        throw error;
      });

    this.kokoroReady = ready;
    return ready;
  }

  /** Instantiate the phonemize worker's wasm, once. */
  private initPhonemizer(): Promise<void> {
    if (this.phonemizerReady) return this.phonemizerReady;

    const ready = this.phonemizer
      .request((id) => ({ type: 'init', id }))
      .reply.then((reply) => {
        if (reply.type !== 'ready') throw unexpected('phonemize', reply.type);
      })
      .catch((error: unknown) => {
        this.phonemizerReady = null;
        throw error;
      });

    this.phonemizerReady = ready;
    return ready;
  }

  /**
   * Load the dictionaries `(vocab, lang)` needs, once.
   *
   * Awaited by every sentence and paid for by the first one, because nothing
   * above knows which voice the user has chosen until it synthesizes — the
   * offscreen document is given a voice with each sentence and has no channel
   * for "the voice changed" — preparing at voice selection would need one. What
   * it costs is decompression from files the
   * extension already ships, and every language needs something now: English's
   * pronunciation dictionary is compiled in, but its numerals come from two
   * WeText grammars (phase 9B) as Chinese's and Japanese's do (9E).
   */
  private prepare(vocab: VocabId, lang: string): Promise<void> {
    const key = `${vocab}\u0000${lang}`;
    const existing = this.prepared.get(key);
    if (existing) return existing;

    const loading = this.phonemizer
      .request((id) => ({ type: 'prepare', id, vocab, lang }))
      .reply.then((reply) => {
        if (reply.type !== 'prepared') throw unexpected('phonemize', reply.type);
      })
      .catch((error: unknown) => {
        // Same reasoning as the handshakes: a dictionary that failed to load is
        // worth retrying on the next sentence, not worth remembering as failed
        // for the life of the document.
        this.prepared.delete(key);
        throw error;
      });

    this.prepared.set(key, loading);
    return loading;
  }

  /** One piece of text to IPA, through the phonemize worker. */
  private async phonemizeText(text: string, vocab: VocabId, lang: string): Promise<string> {
    const { reply } = this.phonemizer.request((id) => ({
      type: 'phonemize',
      id,
      text,
      vocab,
      lang,
    }));
    const settled = await reply;
    if (settled.type !== 'phonemized') throw unexpected('phonemize', settled.type);

    // Reported rather than dropped, and not as an error: the sentence still
    // plays, but a run of text with no pronunciation is audible as a missing
    // word, and this is the only place that knows which one it was.
    if (settled.warnings !== undefined && settled.warnings.length > 0) {
      console.warn('[SayLoud] the phonemizer dropped text', settled.warnings);
    }
    return settled.phonemes;
  }

  /** How many tokens the model's tokenizer makes of this IPA. */
  private async countTokens(phonemes: string): Promise<number> {
    const { reply } = this.kokoro.request((id) => ({ type: 'count', id, phonemes }));
    const settled = await reply;
    if (settled.type !== 'counted') throw unexpected('kokoro', settled.type);
    return settled.tokens;
  }

  private ensureAlive(): void {
    if (this.dead) throw this.dead;
    if (this.disposed) throw new Error('the local engine was disposed');
  }

  /**
   * One worker is gone, so both are.
   *
   * The other worker's in-flight requests would otherwise wait forever: nothing
   * will answer them now, because whatever would have driven the next step of
   * their sentence is dead. Both are terminated and every later call fails at
   * once, which is what lets `LocalProvider` notice and build a fresh engine for
   * the next sentence instead of retrying into a corpse.
   */
  private readonly onWorkerDead = (error: Error): void => {
    if (this.dead) return;
    this.dead = error;
    this.prepared.clear();
    this.kokoro.disposeWith(error);
    this.phonemizer.disposeWith(error);
  };
}

/** The error every later request sees once a worker is gone. */
function deadWorkerError(message?: string): Error {
  const text =
    message !== undefined && message.length > 0 ? message : 'the on-device worker stopped';
  const error = new Error(text);
  error.name = WORKER_DEAD;
  return error;
}

function unexpected(worker: 'kokoro' | 'phonemize', type: string): Error {
  return new Error(`the ${worker} worker answered with ${type}`);
}

/**
 * Start the worker that holds the model.
 *
 * The path has to be a literal in `new URL(...)` for the bundler to find and
 * emit it — which is also why these are the only places that name the files.
 */
export function createKokoroWorker(): WorkerLike {
  return new Worker(new URL('../../entrypoints/offscreen/kokoro.worker.ts', import.meta.url), {
    type: 'module',
  });
}

/** Start the worker that holds the phonemizer. */
export function createPhonemizeWorker(): WorkerLike {
  return new Worker(new URL('../../entrypoints/offscreen/phonemize.worker.ts', import.meta.url), {
    type: 'module',
  });
}
