/**
 * The wire protocol between `WorkerLocalEngine` and the phonemize worker
 * (P6 spec §2.4, phase 7).
 *
 * Two workers rather than one, because the two halves have nothing in common:
 * phonemization is pure computation with no I/O once the dictionaries are in
 * place, and inference is a GPU session that takes a second per sentence. On
 * one thread the second one is a wall the first one has to wait behind — which
 * is not a stutter (the offscreen document's main thread is what plays audio)
 * but a lost overlap: a prefetch's phonemization cannot happen while the
 * sentence being listened to is being synthesized, and the other way round.
 *
 * The scheduling stays above both workers, in `WorkerLocalEngine`. A
 * `MessageChannel` could connect them directly, but then the policy that
 * decides what to prepare and when would live in a worker instead of next to
 * the cache, the aborts and the retries — and the two workers would each have
 * to know about the other's failures.
 *
 * Every message is validated before use, the same as the kokoro worker's
 * channel, and for the same reason.
 */
import type { ProviderErrorCode } from '../providers/errors';
import { type FrontendId, isFrontendId } from './frontend';
import { isDictionaryLoadError } from './phonemize-dict';
import { isMessageId, messageTypeOf } from './worker-message';

/** Main thread → phonemize worker. */
export type PhonemizeWorkerRequest =
  | {
      /**
       * Instantiate the wasm module.
       *
       * Its own message rather than something the first `prepare` implies:
       * instantiating is 5 MB of wasm and several milliseconds, and doing it up
       * front is what lets it happen while the kokoro worker is still loading
       * the model.
       */
      type: 'init';
      id: number;
    }
  | {
      /**
       * Load the dictionaries `(frontend, lang)` needs, before the first
       * sentence. Idempotent, and a no-op for a language whose dictionary is
       * compiled in (English).
       */
      type: 'prepare';
      id: number;
      frontend: FrontendId;
      lang: string;
    }
  | {
      /**
       * Text to phonemes, for one piece of a sentence.
       *
       * Per piece rather than per sentence because the sentence has to be cut
       * to fit the model's token limit *before* it can be synthesized, and the
       * only way to know how many tokens a piece is worth is to phonemize it
       * and ask the tokenizer — which lives in the other worker. So the
       * coordinator cuts, and this is what it cuts with.
       */
      type: 'phonemize';
      id: number;
      text: string;
      frontend: FrontendId;
      lang: string;
    }
  | { type: 'dispose' };

/** Phonemize worker → main thread. */
export type PhonemizeWorkerReply =
  | { type: 'ready'; id: number }
  | { type: 'prepared'; id: number }
  | {
      type: 'phonemized';
      id: number;
      phonemes: string;
      /**
       * Runs of text that produced no phonemes, one message each.
       *
       * Absent when there are none, which is the common case. Carried through
       * rather than dropped because a dropped word is audible, and the engine
       * above has nowhere else to learn about it.
       */
      warnings?: readonly string[];
    }
  | { type: 'error'; id: number; code: ProviderErrorCode; message: string };

const REQUEST_TYPES: ReadonlySet<string> = new Set(['init', 'prepare', 'phonemize', 'dispose']);

const REPLY_TYPES: ReadonlySet<string> = new Set(['ready', 'prepared', 'phonemized', 'error']);

/** True for a well-formed request. */
export function isPhonemizeWorkerRequest(value: unknown): value is PhonemizeWorkerRequest {
  const type = messageTypeOf(value);
  if (type === null || !REQUEST_TYPES.has(type)) return false;
  const message = value as Record<string, unknown>;

  switch (type) {
    case 'init':
      return isMessageId(message.id);
    case 'prepare':
    case 'phonemize':
      return (
        isMessageId(message.id) &&
        isFrontendId(message.frontend) &&
        typeof message.lang === 'string' &&
        (type === 'prepare' || typeof message.text === 'string')
      );
    default:
      return true;
  }
}

/** True for a well-formed reply. */
export function isPhonemizeWorkerReply(value: unknown): value is PhonemizeWorkerReply {
  const type = messageTypeOf(value);
  if (type === null || !REPLY_TYPES.has(type) || !isMessageId((value as { id?: unknown }).id)) {
    return false;
  }
  const message = value as Record<string, unknown>;

  switch (type) {
    case 'phonemized':
      return (
        typeof message.phonemes === 'string' &&
        (message.warnings === undefined ||
          (Array.isArray(message.warnings) &&
            message.warnings.every((warning) => typeof warning === 'string')))
      );
    case 'error':
      return typeof message.code === 'string' && typeof message.message === 'string';
    default:
      return true;
  }
}

/**
 * The provider code a phonemize failure should travel as.
 *
 * Two of the reasons a dictionary load can fail are about the request and not
 * about the extension's own files, and only those two are worth telling apart
 * today:
 *
 * - `unsupported-language` is a voice that cannot speak the language it was
 *   given, which is the same situation as any other voice mismatch, and is the
 *   one failure here a user can fix by picking a different voice.
 * - everything else is a file the extension shipped failing to load or decode,
 *   which is a reinstall rather than a setting. Reported as a model load
 *   failure because that is the sentence the panel has for "a thing this
 *   extension ships could not be loaded"; phase 8 gives it a code of its own.
 *
 * Deliberately not `unknown`: that reads as "something went wrong" and throws
 * away the only actionable part of the message.
 */
export function phonemizeErrorCode(error: unknown): ProviderErrorCode {
  if (isDictionaryLoadError(error)) {
    return error.reason === 'unsupported-language' ? 'voice-mismatch' : 'model-load-failed';
  }
  return 'unknown';
}
