/**
 * Transport helpers shared by the HTTP providers.
 *
 * Adapters keep their own error vocabulary (see `mapError` in each provider)
 * but the mechanics — network failures, base64 audio, SSE framing, chunked
 * JSON — are identical across services, so they live here.
 */
import { isAbortError, networkError } from './errors';

/**
 * Issue a request, translating transport failures into `ProviderError`.
 *
 * A non-2xx response is returned rather than thrown: providers need the body
 * to tell "key rejected" from "service not activated", and both arrive as 403
 * on several services. Aborts pass through untouched — a cancelled request is
 * a caller decision, not a provider failure.
 */
export async function sendRequest(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch = fetch
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw networkError(error);
  }
}

/**
 * Decode standard or URL-safe base64 into bytes.
 *
 * Provider chunks arrive padded or not, sometimes with embedded newlines, and
 * `atob` rejects all of those, so the input is normalized first.
 */
export function decodeBase64(input: string): ArrayBuffer {
  const normalized = input.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length === 0) return new ArrayBuffer(0);

  const padding = (4 - (normalized.length % 4)) % 4;
  const binary = atob(normalized + '='.repeat(padding));

  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

/** Join audio chunks in the order the provider sent them. */
export function concatChunks(chunks: ArrayBuffer[]): ArrayBuffer {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;

  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

export interface SseEvent {
  /** The `event:` field, when the provider sends one. */
  event?: string;
  /** All `data:` lines of the event, joined with newlines. */
  data: string;
}

/**
 * Parse a complete `text/event-stream` body into its events.
 *
 * Providers emit the whole stream for one sentence and the `Provider`
 * contract returns a complete result, so the body is parsed in one pass
 * rather than consumed incrementally. Handing back the first chunk before the
 * body ends would need a streaming reader here instead.
 */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let data: string[] = [];
  let event: string | undefined;

  const flush = (): void => {
    // A block with an `event:` but no `data:` carries no payload.
    if (data.length > 0) events.push({ event, data: data.join('\n') });
    data = [];
    event = undefined;
  };

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    // `:` starts a comment; keep-alive pings arrive this way.
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }

  flush();
  return events;
}

/**
 * Extract every complete JSON object from a body that carries several.
 *
 * Volcengine answers with newline-delimited JSON, but proxies and chunk
 * boundaries can deliver objects back to back or split across lines, so
 * objects are found by brace matching rather than by splitting on newlines.
 *
 * A frame that does not parse does not end the scan: the search restarts one
 * character later, so a stray `{` or a corrupt frame cannot swallow the valid
 * frames that follow it. A trailing partial object is simply left unread.
 */
export function parseJsonChunks(text: string): unknown[] {
  const chunks: unknown[] = [];
  let index = 0;

  while (index < text.length) {
    const start = text.indexOf('{', index);
    if (start < 0) break;

    const end = findObjectEnd(text, start);
    if (end < 0) {
      // The object never closes — treat this brace as noise and look for the
      // next one rather than giving up on the rest of the body.
      index = start + 1;
      continue;
    }

    const candidate = text.slice(start, end + 1);
    try {
      chunks.push(JSON.parse(candidate));
      index = end + 1;
    } catch {
      index = start + 1;
    }
  }

  return chunks;
}

/** Index of the `}` closing the object that starts at `start`, or -1. */
function findObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text.charAt(index);

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth++;
      continue;
    }
    if (char === '}') {
      depth--;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

/** True for a JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read `record[key]` when it is a string. */
export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read `record[key]` when it is a finite number. */
export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read `record[key]` when it is an array. */
export function readArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

/** Read `record[key]` when it is a JSON object. */
export function readRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/** Read the first string among `keys`, for providers with field aliases. */
export function readFirstString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Read the first finite number among `keys`, for providers with field aliases. */
export function readFirstNumber(
  record: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}
