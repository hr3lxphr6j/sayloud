/**
 * The wire protocol between `WorkerLocalEngine` and the kokoro worker.
 *
 * ONNX inference must not run on the offscreen document's main thread: that
 * thread also drives `TimelinePlayer`'s timers and playback, and a synthesis
 * that blocks it for a second is a stutter in the audio that is playing now.
 * So the model lives in a worker and this is the only way in or out.
 *
 * That worker is one of two, and this is the half that owns the
 * model and nothing else. What it no longer does is decide what to say: text
 * arrives phonemized and already cut to fit, because cutting it needs a token
 * count (here) and phonemizing it needs a dictionary (in the phonemize worker),
 * and no single worker has both.
 *
 * Every message is validated before use, the same as the service worker's
 * channel: a worker's `message` event is not a trusted boundary, and a stale
 * worker from a previous version is a real possibility.
 */
import type { ProviderErrorCode } from '../providers/errors';
import type { Device } from './device';
import type { DeviceInfo } from './engine';
import type { ModelSource } from './urls';
import { isMessageId, messageTypeOf } from './worker-message';

/**
 * One synthesis call's worth of prepared text.
 *
 * **Only the IPA travels.** English used to be rendered from `text`, because
 * `kokoro-js`'s own `generate()` runs the model's front end internally — espeak,
 * plus the number, punctuation and character substitutions applied afterwards —
 * and re-implementing that here was how the two would drift apart. All three
 * languages are now phonemized by the Rust crate, so there is one rendering path
 * and one input: `ipa`, which is `generate_from_ids`'s argument and needs no
 * reading of the text at all.
 *
 * The text is still what gets *split*, and where it is split is decided by
 * `planPieces` before this struct exists — so what a caller loses by not sending
 * it is nothing it still needs.
 */
export interface SynthesizePiece {
  readonly ipa: string;
}

/** Main thread → worker. */
export type WorkerRequest =
  | {
      /**
       * Point the fetch patch at a download source, before anything is fetched.
       *
       * Has to be its own message rather than part of `load`: the patch must be
       * installed before transformers.js makes its first request, and `load` is
       * what makes that request.
       */
      type: 'init';
      id: number;
      source: ModelSource;
      /** True when `source` came from `auto`, so one retry is allowed. */
      allowFallback: boolean;
    }
  | { type: 'load'; id: number; modelId: string; tierId: string; device: Device }
  | {
      /**
       * How many tokens the model's tokenizer makes of this IPA.
       *
       * Asked separately from `synthesize` because the coordinator has to know
       * it *before* it can say what to synthesize: the sentence is cut to fit
       * the model's limit, and the tokenizer that decides is this worker's.
       * Without truncation, so the answer is the real length.
       */
      type: 'count';
      id: number;
      phonemes: string;
    }
  | {
      type: 'synthesize';
      id: number;
      /** Already phonemized and already cut to fit. */
      pieces: readonly SynthesizePiece[];
      voiceId: string;
      lang: string;
    }
  | { type: 'cancel'; id: number }
  | { type: 'dispose' };

/** Worker → main thread. */
export type WorkerReply =
  | { type: 'ready'; id: number }
  | { type: 'loaded'; id: number; info: DeviceInfo }
  | { type: 'counted'; id: number; tokens: number }
  | { type: 'pcm'; id: number; pcm: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; code: ProviderErrorCode; message: string };

const REQUEST_TYPES: ReadonlySet<string> = new Set([
  'init',
  'load',
  'count',
  'synthesize',
  'cancel',
  'dispose',
]);

const REPLY_TYPES: ReadonlySet<string> = new Set(['ready', 'loaded', 'counted', 'pcm', 'error']);

/** True for one piece of a sentence that is ready to be spoken. */
function isSynthesizePiece(value: unknown): value is SynthesizePiece {
  if (typeof value !== 'object' || value === null) return false;
  const piece = value as { ipa?: unknown };
  return typeof piece.ipa === 'string';
}

/** True for a well-formed request. */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
  const type = messageTypeOf(value);
  if (type === null || !REQUEST_TYPES.has(type)) return false;
  const message = value as Record<string, unknown>;

  switch (type) {
    case 'init':
      return (
        isMessageId(message.id) &&
        isModelSource(message.source) &&
        typeof message.allowFallback === 'boolean'
      );
    case 'load':
      return (
        isMessageId(message.id) &&
        typeof message.modelId === 'string' &&
        typeof message.tierId === 'string' &&
        (message.device === 'webgpu' || message.device === 'wasm')
      );
    case 'count':
      return isMessageId(message.id) && typeof message.phonemes === 'string';
    case 'synthesize':
      return (
        isMessageId(message.id) &&
        Array.isArray(message.pieces) &&
        message.pieces.length > 0 &&
        message.pieces.every(isSynthesizePiece) &&
        typeof message.voiceId === 'string' &&
        typeof message.lang === 'string'
      );
    case 'cancel':
      return isMessageId(message.id);
    default:
      return true;
  }
}

/** A resolved source, as it can arrive from another context. */
function isModelSource(value: unknown): value is ModelSource {
  if (typeof value !== 'object' || value === null) return false;
  const host = (value as { host?: unknown }).host;
  if (host === 'huggingface' || host === 'modelscope') return true;
  if (host !== 'custom') return false;
  return typeof (value as { customHostUrl?: unknown }).customHostUrl === 'string';
}

/** True for a well-formed reply. */
export function isWorkerReply(value: unknown): value is WorkerReply {
  const type = messageTypeOf(value);
  if (type === null || !REPLY_TYPES.has(type)) return false;
  if (!isMessageId((value as { id?: unknown }).id)) return false;
  const message = value as Record<string, unknown>;

  switch (type) {
    case 'ready':
      return true;
    case 'loaded':
      return typeof message.info === 'object' && message.info !== null;
    case 'counted':
      return typeof message.tokens === 'number' && message.tokens >= 0;
    case 'pcm':
      return message.pcm instanceof Float32Array && typeof message.sampleRate === 'number';
    case 'error':
      return typeof message.code === 'string' && typeof message.message === 'string';
    default:
      return false;
  }
}
