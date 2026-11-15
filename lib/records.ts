/**
 * Stored values, read as plain records.
 *
 * Everything the extension reads back from `chrome.storage` is `unknown`, and
 * it may have been written by another version: an array, a primitive, `null`.
 * A read path that expects a record has to check before it indexes into one,
 * and treats anything else as "nothing stored" — an array is not a record here
 * because its numeric keys would be read as provider names.
 */

/** True when `value` is a record: an object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` as a record, or an empty one when it is not a record. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
