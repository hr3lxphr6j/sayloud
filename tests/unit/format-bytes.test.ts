import { describe, expect, it } from 'vitest';
import { formatBytes, formatDecimalBytes } from '~/lib/format-bytes';

describe('formatBytes', () => {
  it('shows an empty store as zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('keeps small counts in bytes', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('switches to kilobytes at 1024', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('switches to megabytes at a mebibyte', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12.4 MB');
  });

  it('drops a pointless decimal, so a limit reads as the picker writes it', () => {
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 MB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('rounds to one decimal rather than printing noise', () => {
    expect(formatBytes(1234)).toBe('1.2 KB');
    expect(formatBytes(12.44 * 1024 * 1024)).toBe('12.4 MB');
  });
});

/**
 * The model sizes, in the units the repository reports them in.
 *
 * Two formatters rather than one because the two numbers are checked against
 * different references: the cache's limit is what the picker offers, and a
 * model's size is what the mirror's file listing says. Rounding the second one
 * the way the first wants would understate a download by four percent.
 */
describe('formatDecimalBytes', () => {
  it('keeps small counts in bytes', () => {
    expect(formatDecimalBytes(0)).toBe('0 B');
    expect(formatDecimalBytes(44)).toBe('44 B');
    expect(formatDecimalBytes(999)).toBe('999 B');
  });

  it('switches to kilobytes at 1000', () => {
    expect(formatDecimalBytes(1000)).toBe('1 KB');
    expect(formatDecimalBytes(3497)).toBe('3.5 KB');
  });

  it('quotes the measured tier sizes the way the spec does', () => {
    expect(formatDecimalBytes(92_363_654)).toBe('92.4 MB');
    expect(formatDecimalBytes(163_233_654)).toBe('163.2 MB');
    expect(formatDecimalBytes(325_533_654)).toBe('325.5 MB');
  });

  it('drops a pointless decimal', () => {
    expect(formatDecimalBytes(1_000_000)).toBe('1 MB');
    expect(formatDecimalBytes(28_200_960)).toBe('28.2 MB');
  });
});
