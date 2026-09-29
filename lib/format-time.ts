/**
 * Rough speaking speed in characters per second, used until the engine has
 * measured a real rate. The spec calls for an estimate first and a correction
 * per voice once real durations are known (P2); P1 only has the estimate.
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

/** The remaining-time phrase shown in the bubble card. */
export function formatRemaining(charsRemaining: number, charsPerSec: number): string {
  return `${formatDuration(estimateRemainingSeconds(charsRemaining, charsPerSec))} left`;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}
