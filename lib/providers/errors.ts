import type { MessageKey, MessageParams, Translator } from '../i18n';

/**
 * Unified provider error codes (spec §7.1).
 *
 * Every adapter maps its service's failures onto this closed set so the
 * playback engine can make one decision — degrade to the browser voice, retry,
 * or surface the error — without knowing which provider produced it.
 */
export type ProviderErrorCode =
  | 'invalid-key'
  | 'not-activated'
  | 'service-unavailable'
  | 'voice-mismatch'
  | 'rate-limit'
  | 'no-quota'
  | 'network-error'
  // The on-device model's own failures (P4 spec §3.15). They are separate codes
  // rather than `unknown` because each one has a different fix, and every fix is
  // something the user does in the extension: download, pick a source, retry,
  // delete and re-download, or change the device.
  | 'model-missing'
  | 'model-host-unreachable'
  | 'model-download-failed'
  | 'model-load-failed'
  | 'device-unavailable'
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
 * What each unified code means, as the key of the line the panel shows.
 *
 * The code is the part a user can act on ("the key is wrong" vs "the service is
 * down"), so it leads; the provider's own message is appended as detail.
 */
const CODE_KEYS: Record<ProviderErrorCode, MessageKey> = {
  'invalid-key': 'error.invalid-key',
  'not-activated': 'error.not-activated',
  'service-unavailable': 'error.service-unavailable',
  'voice-mismatch': 'error.voice-mismatch',
  'rate-limit': 'error.rate-limit',
  'no-quota': 'error.no-quota',
  'network-error': 'error.network-error',
  'model-missing': 'error.model-missing',
  'model-host-unreachable': 'error.model-host-unreachable',
  'model-download-failed': 'error.model-download-failed',
  'model-load-failed': 'error.model-load-failed',
  'device-unavailable': 'error.device-unavailable',
  unknown: 'error.unknown',
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
 * What went wrong, in a form that can be put into words later.
 *
 * A key and its parameters rather than a sentence: this module is bundled into
 * the service worker, which has no language, and a caller with a translator can
 * always turn one of these into the other.
 */
export interface ProviderErrorSummary {
  readonly key: MessageKey;
  readonly params?: MessageParams;
  /**
   * The provider's own message, untranslated. It is remote copy, so it stays in
   * whatever language the service wrote it in — and it is usually the
   * actionable half (`model not activated`, `bad gateway URL`).
   */
  readonly detail?: string;
}

/**
 * Read a thrown value as the line the settings panel should show.
 *
 * A cancellation is reported as such, because a superseded request is not a
 * failure the user can act on.
 */
export function providerErrorSummary(error: unknown): ProviderErrorSummary {
  if (isAbortError(error)) return { key: 'error.cancelled' };

  if (isProviderError(error)) {
    const key = CODE_KEYS[error.code];
    const detail = error.message.trim();
    // Whether the detail is worth showing cannot be decided here: it is dropped
    // when it repeats our own line, and only a translator knows what that says.
    return detail.length > 0 ? { key, detail } : { key };
  }

  return { key: 'error.unexpected', params: { detail: errorMessage(error) } };
}

/**
 * One line for the settings panel: the code's explanation, then the provider's
 * own message when it adds something.
 *
 * Never includes `details`: those can hold a whole response body, and echoing
 * it in the panel would be noise at best.
 */
export function formatProviderError(summary: ProviderErrorSummary, t: Translator): string {
  const text = t(summary.key, summary.params);
  const detail = summary.detail?.trim() ?? '';
  return detail.length > 0 && detail !== text ? `${text} (${detail})` : text;
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
