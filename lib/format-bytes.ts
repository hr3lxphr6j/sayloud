/**
 * A byte count, as the settings panel writes it.
 *
 * One decimal place at most, and no decimal at all when it would be a zero:
 * the same function formats the cache's limit, which the picker offers as
 * "200 MB", and the cache's usage, which is whatever the store happens to hold.
 * A dash between them should not read as a different number.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;

  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / (1024 * 1024), 'MB'];

  return `${trimDecimal(value)} ${unit}`;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
