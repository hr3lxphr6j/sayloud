/**
 * The wire protocol between the service worker and the offscreen document
 * (spec §1.2).
 *
 * The service worker owns every piece of session state; the offscreen document
 * is a stateless executor that plays audio. So the protocol is small on
 * purpose: commands carry everything the executor needs to act, and events
 * carry back only what the state machine cannot know — the real duration of the
 * audio, where each word lands, and which sentence finished.
 *
 * Every message is validated before use. `runtime.sendMessage` delivers to
 * every extension context, and an extension's own pages are not a trusted
 * boundary: a stale document from a previous version, or any code that can post
 * to the extension's runtime, can put anything on this channel.
 */
import type { ModelSource } from './models/urls';
import type { ProviderErrorCode } from './providers/errors';
import type { ProviderConfig } from './providers/types';
import type { CacheSettings } from './settings-store';

/** Service worker → offscreen document. */
export type OffscreenCommand =
  | {
      type: 'synthesize';
      /** Correlates the `ready` / `error` events, and every later `play`. */
      id: string;
      text: string;
      voiceId: string;
      config: ProviderConfig;
    }
  | {
      type: 'prefetch';
      /** Sentences to warm, nearest first. There is no reply. */
      items: readonly { text: string; voiceId: string }[];
      config: ProviderConfig;
    }
  | { type: 'play'; id: string; startTimeMs: number }
  | { type: 'pause' }
  | { type: 'setRate'; rate: number }
  | { type: 'setVolume'; volume: number }
  | { type: 'stop' };

/**
 * What the offscreen document replies to a `synthesize` command.
 *
 * `undefined` means the synthesis failed and an `error` event was already sent,
 * so the caller must not follow up with `play`.
 */
export interface SynthesizeReply {
  durationMs: number;
  hasTimings: boolean;
}

/**
 * Offscreen document → service worker.
 *
 * `word` carries an `id` that the spec's sketch omits. Without it the worker
 * cannot tell a word from the sentence it just cancelled from a word of the one
 * it is now speaking, and a seek would leave a stale highlight behind.
 */
export type OffscreenEvent =
  | { type: 'ready'; id: string; durationMs: number; hasTimings: boolean }
  | { type: 'word'; id: string; charStart: number; charEnd: number }
  | { type: 'sentence-end'; id: string }
  | { type: 'paused'; currentTimeMs: number }
  | { type: 'error'; id: string; code: OffscreenErrorCode; message: string };

/**
 * A provider failure code, plus the two failures that can only happen in the
 * offscreen document: the browser refusing to play the audio, and a bug in this
 * extension.
 */
export type OffscreenErrorCode = ProviderErrorCode | 'audio-error' | 'unknown';

/**
 * The settings panel telling a running offscreen document to drop its half of
 * the cache.
 *
 * Deliberately not an `OffscreenCommand`: it is addressed to whatever document
 * happens to be alive rather than to the executor's state machine, and the
 * common case is that there is no document at all — a broadcast nobody receives
 * is the successful outcome, not a failed command.
 */
export const CACHE_CLEARED = { type: 'cache-cleared' } as const;

export type CacheClearedMessage = typeof CACHE_CLEARED;

/** True for the cache-cleared broadcast. */
export function isCacheCleared(value: unknown): value is CacheClearedMessage {
  return typeOf(value) === CACHE_CLEARED.type;
}

/**
 * The offscreen document's cache policy.
 *
 * It travels as a message in both directions — the worker sends it, and sends
 * it again when it changes — because an offscreen document is not given
 * `chrome.storage`. Chrome exposes `runtime` and `offscreen` there and nothing
 * else, so the policy cannot be read where it is used and has to be told.
 */
export interface CachePolicyMessage {
  type: typeof CACHE_POLICY;
  cache: CacheSettings;
}

/** The offscreen document asking the service worker for the policy at startup. */
export const CACHE_POLICY_REQUEST = { type: 'cache-policy-request' } as const;

export type CachePolicyRequest = typeof CACHE_POLICY_REQUEST;

const CACHE_POLICY = 'cache-policy';

/** True for the offscreen document's request for the current cache policy. */
export function isCachePolicyRequest(value: unknown): value is CachePolicyRequest {
  return typeOf(value) === CACHE_POLICY_REQUEST.type;
}

/**
 * Where the on-device engine should fetch model files from.
 *
 * It travels as a message for the same reason the cache policy does: the
 * offscreen document is not given `chrome.storage`, and the user's download
 * source lives there. The engine needs it before its first request, and the
 * document may be starting for the hundredth time.
 */
export interface ModelSourceMessage {
  type: typeof MODEL_SOURCE;
  source: ModelSource;
  /** True when the source came from `auto`, so one retry is allowed. */
  allowFallback: boolean;
}

/** The offscreen document asking the service worker where to download from. */
export const MODEL_SOURCE_REQUEST = { type: 'model-source-request' } as const;

export type ModelSourceRequest = typeof MODEL_SOURCE_REQUEST;

const MODEL_SOURCE = 'model-source';

/** True for the offscreen document's request for a download source. */
export function isModelSourceRequest(value: unknown): value is ModelSourceRequest {
  return typeOf(value) === MODEL_SOURCE_REQUEST.type;
}

/**
 * True for a well-formed source message.
 *
 * Checked rather than trusted: the reply crosses a context boundary, and a
 * malformed source would be handed straight to `fetch`.
 */
export function isModelSourceMessage(value: unknown): value is ModelSourceMessage {
  if (typeOf(value) !== MODEL_SOURCE) return false;
  const message = value as { source?: unknown; allowFallback?: unknown };
  if (typeof message.allowFallback !== 'boolean') return false;

  const source = message.source;
  if (typeof source !== 'object' || source === null) return false;
  const { host, customHostUrl, revision } = source as Record<string, unknown>;
  if (host === 'huggingface' || host === 'modelscope') return true;
  if (host !== 'custom') return false;
  return (
    typeof customHostUrl === 'string' &&
    customHostUrl.startsWith('https://') &&
    (revision === undefined || typeof revision === 'string')
  );
}

/**
 * True for a well-formed cache policy.
 *
 * Both fields are checked rather than trusted: the reply to the request above
 * crosses a context boundary, and a policy of the wrong shape must leave the
 * cache as it was instead of prising the store down to a budget that is not a
 * number.
 */
export function isCachePolicyMessage(value: unknown): value is CachePolicyMessage {
  if (typeOf(value) !== CACHE_POLICY) return false;
  const cache = (value as { cache?: unknown }).cache;
  if (typeof cache !== 'object' || cache === null) return false;
  const { persist, maxBytes } = cache as { persist?: unknown; maxBytes?: unknown };
  return (
    typeof persist === 'boolean' &&
    typeof maxBytes === 'number' &&
    Number.isFinite(maxBytes) &&
    maxBytes > 0
  );
}

/** The reason string `chrome.offscreen` requires; nothing else uses the API. */
export const OFFSCREEN_REASON = 'AUDIO_PLAYBACK';

/** The page `OffscreenManager` opens. Must match the built entrypoint's path. */
export const OFFSCREEN_PATH = 'offscreen.html';

const COMMAND_TYPES: ReadonlySet<string> = new Set([
  'synthesize',
  'prefetch',
  'play',
  'pause',
  'setRate',
  'setVolume',
  'stop',
]);

const EVENT_TYPES: ReadonlySet<string> = new Set(['ready', 'word', 'sentence-end', 'paused', 'error']);

/**
 * True for a well-formed command.
 *
 * Only the envelope is checked: `config` is re-validated by
 * `parseStoredConfig` on the way out of storage, and re-checking a whole
 * provider config here would duplicate that schema.
 */
export function isOffscreenCommand(value: unknown): value is OffscreenCommand {
  const type = typeOf(value);
  if (type === null || !COMMAND_TYPES.has(type)) return false;
  const message = value as Record<string, unknown>;

  switch (type) {
    case 'synthesize':
      return (
        isNonEmptyString(message.id) &&
        typeof message.text === 'string' &&
        typeof message.voiceId === 'string' &&
        typeof message.config === 'object' &&
        message.config !== null
      );
    case 'prefetch':
      return (
        Array.isArray(message.items) &&
        message.items.every(isPrefetchItem) &&
        typeof message.config === 'object' &&
        message.config !== null
      );
    case 'play':
      return isNonEmptyString(message.id) && isFiniteNumber(message.startTimeMs);
    case 'setRate':
      return isFiniteNumber(message.rate);
    case 'setVolume':
      return isFiniteNumber(message.volume);
    default:
      return true;
  }
}

/** True for a well-formed event. */
export function isOffscreenEvent(value: unknown): value is OffscreenEvent {
  const type = typeOf(value);
  if (type === null || !EVENT_TYPES.has(type)) return false;
  const message = value as Record<string, unknown>;
  
  // 'paused' event has no id field, as it reports global playback state
  if (type === 'paused') {
    return isFiniteNumber(message.currentTimeMs);
  }
  
  // All other events require an id to correlate with a specific sentence
  if (!isNonEmptyString(message.id)) return false;

  switch (type) {
    case 'ready':
      return isFiniteNumber(message.durationMs) && typeof message.hasTimings === 'boolean';
    case 'word':
      return isFiniteNumber(message.charStart) && isFiniteNumber(message.charEnd);
    case 'error':
      return typeof message.code === 'string' && typeof message.message === 'string';
    default:
      return true;
  }
}

/** The `type` field, when the value is an object that has one. */
function typeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

function isPrefetchItem(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { text?: unknown; voiceId?: unknown };
  return typeof item.text === 'string' && typeof item.voiceId === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
