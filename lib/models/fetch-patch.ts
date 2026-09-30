/**
 * The fetch patch that makes canonical cache keys work (P4 spec §3.5).
 *
 * The problem it solves: transformers.js caches a downloaded file under the
 * URL it requested. If the request URL is the real source, then switching
 * source — Hugging Face to ModelScope, or to a company mirror — changes the key
 * and re-downloads 163 MB. So the engine pins transformers.js to a host that
 * never resolves (`.invalid`, reserved by RFC 2606) and rewrites every request
 * on the way out. The cache key is then the same string whatever the bytes came
 * from, and `env.useBrowserCache` works as intended.
 *
 * It rewrites two things and nothing else:
 *
 * - canonical model URLs, built by `lib/models/urls.ts`;
 * - voice URLs, which `kokoro-js` hardcodes as Hugging Face URLs and looks up
 *   in the `kokoro-voices` bucket by that exact string. That key is not ours to
 *   choose, so it stays a Hugging Face URL and the patch is what makes the
 *   request reach the selected mirror.
 *
 * Anything else is passed through untouched. The guard lives in `isOurs()`, and
 * it is load-bearing: without it any other library's Hugging Face request would
 * be silently redirected to the user's mirror.
 *
 * `resolveUrl` is not reimplemented here. The downloader (side panel) and this
 * patch must agree on the URL character for character, or the key that was
 * written is not the key that is looked up — and that failure reads as
 * "it downloaded 163 MB and then re-downloads them", which no unit test on
 * either side alone would catch.
 */
import { HUGGINGFACE_HOST, isOurs, MODELSCOPE_HOST, type ModelSource, resolveUrl } from './urls';

/** The fetch this patch wraps. `typeof fetch` so it drops in for the global. */
export type FetchLike = typeof globalThis.fetch;

export interface FetchPatchOptions {
  /** Where canonical URLs resolve to. */
  readonly source: ModelSource;
  /** The fetch to call through to. Defaults to the global one. */
  readonly fetch?: FetchLike;
  /**
   * Whether a failed request may be retried against the other mirror.
   *
   * True only when the source came from `auto`: a source the user picked
   * explicitly must not be quietly swapped for another, or the setting means
   * nothing (spec §3.4). The caller knows which it was; this module does not.
   */
  readonly allowFallback?: boolean;
}

/**
 * The source's counterpart, for the one retry `auto` is allowed.
 *
 * Only the two mirrors have one. A custom mirror has no counterpart by
 * definition, and a user-chosen source is not retried at all.
 */
export function fallbackSource(source: ModelSource): ModelSource | undefined {
  if (source.host === 'huggingface') return { host: 'modelscope' };
  if (source.host === 'modelscope') return { host: 'huggingface' };
  return undefined;
}

/** The URL a fetch input refers to. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Build the patched fetch.
 *
 * Returned rather than installed so it can be tested directly, and so the
 * worker can decide exactly when the global is replaced.
 */
export function createFetchPatch(options: FetchPatchOptions): FetchLike {
  const original = options.fetch ?? globalThis.fetch.bind(globalThis);
  const { source, allowFallback = false } = options;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (!isOurs(url)) return original(input, init);

    const real = resolveUrl(url, source);
    try {
      return await original(rewrite(input, real), init);
    } catch (error) {
      // A blocked mirror fails at the connection, not with a status code, which
      // is exactly the case `auto` exists for. A response that came back with
      // an error status is *not* retried: a 404 means the file is not there, and
      // asking the other mirror would only double the wait.
      const other = allowFallback ? fallbackSource(source) : undefined;
      if (other === undefined) throw error;
      return original(rewrite(input, resolveUrl(url, other)), init);
    }
  };
}

/**
 * Point the request at `real`, keeping a `Request`'s method and headers.
 *
 * A `Request` cannot simply be replaced by its URL string without losing
 * whatever it carried. transformers.js uses plain strings today, so this is
 * belt-and-braces rather than a known need.
 */
function rewrite(input: RequestInfo | URL, real: string): RequestInfo | URL {
  if (typeof input === 'string' || input instanceof URL) return real;
  return new Request(real, input);
}

/**
 * Replace the global fetch.
 *
 * Called at the top of the worker, before the model is first fetched. Voices
 * are loaded lazily by `generate()` rather than at module load (verification
 * V19), so there is no race to lose here — but the model load is not, which is
 * why this is the first thing the worker does.
 */
export function installFetchPatch(options: FetchPatchOptions): void {
  globalThis.fetch = createFetchPatch(options);
}

/** The host transformers.js is pinned to; re-exported for the worker's setup. */
export { CANONICAL_HOST } from './urls';

/** True when a source is one of the two public mirrors. */
export function isMirrorHost(host: string): boolean {
  return host === 'huggingface' || host === 'modelscope';
}

/** The real hosts, exported so a test can assert which one a URL reached. */
export const REAL_HOSTS = { huggingface: HUGGINGFACE_HOST, modelscope: MODELSCOPE_HOST } as const;
