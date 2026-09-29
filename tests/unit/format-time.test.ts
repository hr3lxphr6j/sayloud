import { describe, expect, it } from 'vitest';
import {
  BASELINE_CHARS_PER_SEC,
  estimateRemainingSeconds,
  formatDuration,
  formatRemaining,
} from '~/lib/format-time';

describe('formatDuration', () => {
  it('formats sub-minute durations as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7)).toBe('0:07');
    expect(formatDuration(59)).toBe('0:59');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(750)).toBe('12:30');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('adds an hours field past an hour', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('rounds up so a partial second still reads as one second', () => {
    expect(formatDuration(0.4)).toBe('0:01');
    expect(formatDuration(59.5)).toBe('1:00');
  });

  it('treats nonsense and negative input as zero', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('estimateRemainingSeconds', () => {
  it('divides the remaining characters by the measured rate', () => {
    expect(estimateRemainingSeconds(120, 12)).toBe(10);
  });

  it('falls back to the baseline rate before any measurement exists', () => {
    expect(estimateRemainingSeconds(BASELINE_CHARS_PER_SEC * 3, 0)).toBe(3);
  });

  it('returns zero when nothing is left', () => {
    expect(estimateRemainingSeconds(0, 12)).toBe(0);
    expect(estimateRemainingSeconds(-10, 12)).toBe(0);
  });
});

describe('formatRemaining', () => {
  it('renders a whole phrase for the bubble card', () => {
    // 9000 characters at 12 characters per second is 750 seconds.
    expect(formatRemaining(9_000, 12)).toBe('12:30 left');
    expect(formatRemaining(0, 12)).toBe('0:00 left');
  });

  it('uses the baseline rate when the engine has no measurement yet', () => {
    expect(formatRemaining(BASELINE_CHARS_PER_SEC * 60, 0)).toBe('1:00 left');
  });
});
