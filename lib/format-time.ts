import type { MessageKey } from './i18n/messages.en';

/**
 * Rough speaking speed in characters per second, used until the engine has
 * measured a real rate: an estimate first, corrected per voice once real
 * durations are known.
 */
export const BASELINE_CHARS_PER_SEC = 14;

/** Format seconds as `m:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${minutes}:${pad(secs)}`;
}

/** Seconds left, from the remaining character count and the measured rate. */
export function estimateRemainingSeconds(charsRemaining: number, charsPerSec: number): number {
  if (!Number.isFinite(charsRemaining) || charsRemaining <= 0) return 0;
  const rate = charsPerSec > 0 ? charsPerSec : BASELINE_CHARS_PER_SEC;
  return charsRemaining / rate;
}

/** The remaining-time card: the clock, and the message that wraps it. */
export interface RemainingMessage {
  /** Keyed, because the words around the clock have to be translated. */
  key: MessageKey;
  params: { time: string };
}

/**
 * The remaining time, as a message key and its parameter.
 *
 * Only the clock is built here: `m:ss` reads the same in every language, while
 * the phrase around it does not, and building that would mean this module
 * importing a translator.
 */
export function remainingMessage(charsRemaining: number, charsPerSec: number): RemainingMessage {
  return {
    key: 'bubble.remaining',
    params: { time: formatDuration(estimateRemainingSeconds(charsRemaining, charsPerSec)) },
  };
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
