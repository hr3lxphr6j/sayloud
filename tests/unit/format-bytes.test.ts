import { describe, expect, it } from 'vitest';
import { formatBytes } from '~/lib/format-bytes';

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
