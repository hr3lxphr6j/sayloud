/**
 * Byte counts, as the panel writes them.
 *
 * Two functions rather than one because the panel measures two different
 * things against two different references, and rounding one the way the other
 * wants would misstate it.
 */

/**
 * A byte count, as the cache card writes it.
 *
 * One decimal place at most, and no decimal at all when it would be a zero:
 * the same function formats the cache's limit, which the picker offers as
 * "200 MB", and the cache's usage, which is whatever the store happens to
 * hold. A dash between them should not read as a different number.
 *
 * Binary, because the limit it labels is: `MAX_BYTES_CHOICES` is megabytes of
 * 1024². On-device model files get `formatDecimalBytes` instead.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;

  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / (1024 * 1024), 'MB'];

  return `${trimDecimal(value)} ${unit}`;
}

/**
 * A byte count, in the units the model repository quotes.
 *
 * Decimal, unlike `formatBytes`. A tier's size is the sum of the byte counts
 * the repository's file listing reports, and the download really is 92,360,000
 * bytes; calling that "88.1 MB" would understate what the user is about to
 * spend by four percent, against a number they can check against the mirror.
 * The settings panel shows the same decimal figures the repository quotes.
 */
export function formatDecimalBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.max(0, Math.round(bytes))} B`;

  const [value, unit] = bytes < 1_000_000 ? [bytes / 1000, 'KB'] : [bytes / 1_000_000, 'MB'];

  return `${trimDecimal(value)} ${unit}`;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
