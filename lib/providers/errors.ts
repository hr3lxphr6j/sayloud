/**
 * Unified provider error codes (spec §7.1).
 *
 * Every adapter maps its service's failures onto this closed set so the
 * playback engine can make one decision — degrade to the browser voice, retry,
 * or surface the error — without knowing which provider produced it.
 */
export type ProviderErrorCode =
  | 'invalid-key'
  | 'service-unavailable'
  | 'rate-limit'
  | 'no-quota'
  | 'network-error'
  | 'unknown';

/**
 * A TTS provider failure with a stable, provider-independent code.
 *
 * `details` carries the provider's own payload (status, error code, response
 * body) so the P3 error UI can show something actionable without every adapter
 * inventing its own shape. Never put an API key in `details`.
 */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/**
 * True for the `AbortError` that `fetch` rejects with when its signal fires.
 *
 * Cancellation is a caller decision (a seek or a stop), not a provider
 * failure, so adapters rethrow it untouched instead of wrapping it in a
 * `ProviderError` — otherwise the engine would report a spurious error and
 * fall back to the browser voice every time the user skips ahead.
 */
export function isAbortError(error: unknown): boolean {
  // Deliberately structural rather than `instanceof`: a rejection reason can be
  // any value (`AbortController.abort()` takes one), and `instanceof` also
  // fails across realms — which is exactly where a signal from another context
  // would come from.
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Wrap a transport-level failure (`fetch` rejected) as a provider error. */
export function networkError(cause: unknown): ProviderError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ProviderError('network-error', message, cause);
}

/**
 * What each unified code means, in one line the settings panel can show.
 *
 * The code is the part a user can act on ("the key is wrong" vs "the service is
 * down"), so it leads; the provider's own message is appended as detail.
 */
const CODE_MESSAGES: Record<ProviderErrorCode, string> = {
  'invalid-key': 'The API key was rejected. Check that it was copied in full.',
  'service-unavailable': 'The service is unavailable right now. Try again in a moment.',
  'rate-limit': 'The service is rate limiting this key. Wait a moment and retry.',
  'no-quota': 'This account has no quota left for the service.',
  'network-error': 'The request could not reach the service. Check the URL and your connection.',
  unknown: 'The service rejected the request.',
};

/** The message of any thrown value, for logs and fallback copy. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  // A DOMException does not extend Error, and a failed `fetch` rejects with one.
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return String(error);
}

/**
 * One line for the settings panel: the code's explanation, then the provider's
 * own message, which is usually the actionable half (`model not activated`,
 * `bad gateway URL`).
 *
 * Never includes `details`: those can hold a whole response body, and echoing
 * it in the panel would be noise at best. A cancellation is reported as such,
 * because a superseded request is not a failure the user can act on.
 */
export function describeProviderError(error: unknown): string {
  if (isAbortError(error)) return 'The request was cancelled.';

  if (isProviderError(error)) {
    const summary = CODE_MESSAGES[error.code];
    const detail = error.message.trim();
    return detail.length > 0 && detail !== summary ? `${summary} (${detail})` : summary;
  }

  return `Unexpected failure: ${errorMessage(error)}.`;
}

/** Provider-specific refinements applied before the generic status mapping. */
export interface ErrorMappingContext {
  /** HTTP status, when the failure came with a response. */
  status?: number;
  /** Raw response body, already read as text. */
  body?: string;
  /** Error code the provider reported in its own body, if any. */
  providerCode?: string | number;
}

/**
 * Map an HTTP status onto a unified code.
 *
 * This is only the default: several services report "not activated" as a 403
 * or a 400 with a specific body code, so adapters inspect their own payload
 * first and call this as the fallback.
 */
export function errorFromStatus(status: number, message: string, details?: unknown): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('invalid-key', message, details);
  }
  if (status === 402) {
    return new ProviderError('no-quota', message, details);
  }
  if (status === 429) {
    return new ProviderError('rate-limit', message, details);
  }
  if (status >= 500) {
    return new ProviderError('service-unavailable', message, details);
  }
  // 400 / 404 and anything else: a bad request or a misconfigured base URL.
  // Adapters that know their own error vocabulary refine this.
  return new ProviderError('unknown', message, details);
}

/**
 * Pull a human-readable message out of a provider's error body.
 *
 * Providers answer with JSON in several shapes (`message`, `error.message`,
 * `msg`, `Message`) and occasionally with plain text or HTML, so this degrades
 * to a truncated raw body rather than throwing.
 */
export function messageFromBody(body: string, fallback: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return fallback;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const nested = record.error;
      if (nested && typeof nested === 'object') {
        const nestedMessage = (nested as Record<string, unknown>).message;
        if (typeof nestedMessage === 'string' && nestedMessage.length > 0) return nestedMessage;
      }
      for (const key of ['message', 'msg', 'Message', 'error_msg', 'detail']) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) return value;
      }
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }

  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/**
 * Read a response body as text without letting a read failure mask the
 * original error.
 */
export async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
