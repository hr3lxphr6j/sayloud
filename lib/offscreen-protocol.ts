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
import type { ProviderErrorCode } from './providers/errors';
import type { ProviderConfig } from './providers/types';

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
  | { type: 'error'; id: string; code: OffscreenErrorCode; message: string };

/**
 * A provider failure code, plus the two failures that can only happen in the
 * offscreen document: the browser refusing to play the audio, and a bug in this
 * extension.
 */
export type OffscreenErrorCode = ProviderErrorCode | 'audio-error' | 'unknown';

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
  'stop',
]);

const EVENT_TYPES: ReadonlySet<string> = new Set(['ready', 'word', 'sentence-end', 'error']);

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
    default:
      return true;
  }
}

/** True for a well-formed event. */
export function isOffscreenEvent(value: unknown): value is OffscreenEvent {
  const type = typeOf(value);
  if (type === null || !EVENT_TYPES.has(type)) return false;
  const message = value as Record<string, unknown>;
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
