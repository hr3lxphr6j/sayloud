/**
 * The one place that knows how a model file's URL is spelled (P4 spec §3.5).
 *
 * Two callers have to agree on this exactly: the downloader (side panel) and
 * the fetch patch (offscreen worker). If they disagree, the cache key the
 * download wrote is not the key the engine looks up, and the failure looks
 * like "it downloaded 163 MB and then re-downloads them" — a bug that unit
 * tests on either side alone would not see. So neither side builds a URL by
 * hand: they build a *canonical* one here and hand it to `resolveUrl`.
 *
 * Canonical means the key stored in Cache Storage:
 *
 *   https://model-cache.sayloud.invalid/{repo}/resolve/main/{file}
 *
 * `.invalid` is reserved by RFC 2606 and never resolves, which is the point:
 * the key says nothing about where the bytes came from, so switching source
 * (Hugging Face → ModelScope → a company mirror) keeps the cache valid. The
 * revision in a canonical URL is always `main`; only the real URL knows that
 * ModelScope calls that branch `master`.
 *
 * Voices are the exception. `kokoro-js` hardcodes the Hugging Face URL and
 * looks the cache up with that exact string, so *that* is the canonical key —
 * it is not ours to choose.
 */

/**
 * The canonical host, as a Cache Storage key prefix. Never fetched from.
 *
 * Trailing slash included: every builder below is a plain concatenation.
 */
export const CANONICAL_HOST = 'https://model-cache.sayloud.invalid/';

/** Where the real files live when the source is Hugging Face. */
export const HUGGINGFACE_HOST = 'https://huggingface.co/';

/** Where the real files live when the source is ModelScope (note `/models/`). */
export const MODELSCOPE_HOST = 'https://modelscope.cn/models/';

/** The branch each source keeps its files on. */
export const CANONICAL_REVISION = 'main';
export const MODELSCOPE_REVISION = 'master';

/** Where transformers.js keeps the model files it downloads. */
export const TRANSFORMERS_CACHE = 'transformers-cache';

/**
 * Where `kokoro-js` keeps voice files.
 *
 * Named by `kokoro-js` itself, not by us: it opens this bucket by name.
 */
export const KOKORO_VOICES_CACHE = 'kokoro-voices';

/** Where model weights may be fetched from. `auto` picks at runtime. */
export type ModelHostId = 'auto' | 'huggingface' | 'modelscope' | 'custom';

/** Every `ModelHostId`, in the order the UI offers them. */
export const MODEL_HOSTS: readonly ModelHostId[] = ['auto', 'huggingface', 'modelscope', 'custom'];

/** A host that can be turned into a URL; `auto` cannot, it has to be resolved. */
export type ConcreteModelHost = Exclude<ModelHostId, 'auto'>;

/** A resolved download source. */
export interface ModelSource {
  readonly host: ConcreteModelHost;
  /** Required when `host` is `custom`; ignored otherwise. */
  readonly customHostUrl?: string;
  /** `custom` only — a mirror may serve any branch. Defaults to `main`. */
  readonly revision?: string;
}

/** The pieces of a canonical URL, once split apart. */
interface ParsedModelUrl {
  readonly repo: string;
  readonly revision: string;
  readonly file: string;
}

/** The canonical URL of one file in a model repository. */
export function canonicalModelUrl(repo: string, file: string): string {
  return `${CANONICAL_HOST}${repo}/resolve/${CANONICAL_REVISION}/${file}`;
}

/**
 * The canonical (and cached) URL of one voice file.
 *
 * This is the string `kokoro-js` builds for itself, which is why the key has
 * to stay a Hugging Face URL even when the bytes came from ModelScope: the
 * library looks up the cache before it ever calls `fetch`, and a miss there is
 * a request to Hugging Face.
 *
 * Takes the path rather than the voice id so the caller uses the model's own
 * `voiceFile` template; for Kokoro that path is `voices/{id}.bin`.
 */
export function canonicalVoiceUrl(repo: string, voiceFile: string): string {
  return `${HUGGINGFACE_HOST}${repo}/resolve/${CANONICAL_REVISION}/${voiceFile}`;
}

/** The canonical key prefix every voice of `repo` shares. */
export function voiceUrlPrefix(repo: string): string {
  return `${HUGGINGFACE_HOST}${repo}/resolve/${CANONICAL_REVISION}/voices/`;
}

/** True for a URL this module builds as a cache key. */
export function isCanonicalModelUrl(url: string): boolean {
  return parseFrom(CANONICAL_HOST, url) !== null;
}

/**
 * True for a voice URL, ours or Hugging Face's — they are the same string.
 *
 * Deliberately narrow: only `voices/*.bin`, so a stray Hugging Face URL for
 * anything else is left alone by the fetch patch.
 */
export function isVoiceUrl(url: string): boolean {
  const parsed = parseFrom(HUGGINGFACE_HOST, url);
  if (!parsed) return false;
  return parsed.file.startsWith('voices/') && parsed.file.endsWith('.bin');
}

/** True when a URL is one of ours and therefore has to be rewritten. */
export function isOurs(url: string): boolean {
  return isCanonicalModelUrl(url) || isVoiceUrl(url);
}

/**
 * Rewrite a canonical URL into the real one for `source`.
 *
 * Anything that is not ours is returned unchanged, so a caller can pass every
 * request through here — which is exactly what the fetch patch does.
 */
export function resolveUrl(url: string, source: ModelSource): string {
  const parsed = parseFrom(CANONICAL_HOST, url) ?? parseFrom(HUGGINGFACE_HOST, url);
  if (!parsed) return url;

  switch (source.host) {
    case 'huggingface':
      return `${HUGGINGFACE_HOST}${parsed.repo}/resolve/${CANONICAL_REVISION}/${parsed.file}`;
    case 'modelscope':
      return `${MODELSCOPE_HOST}${parsed.repo}/resolve/${MODELSCOPE_REVISION}/${parsed.file}`;
    case 'custom':
      return `${customBase(source)}/${parsed.repo}/resolve/${customRevision(source)}/${parsed.file}`;
  }
}

/** The base of a custom mirror, without a trailing slash. */
export function customBase(source: ModelSource): string {
  const base = source.customHostUrl?.trim().replace(/\/+$/, '') ?? '';
  if (base === '') throw new Error('a custom download source needs a URL');
  return base;
}

/** The branch to ask a custom mirror for. */
export function customRevision(source: ModelSource): string {
  const revision = source.revision?.trim();
  return revision && revision !== '' ? revision : CANONICAL_REVISION;
}

/**
 * Split `{prefix}{repo}/resolve/{revision}/{file}` apart.
 *
 * Returns null for anything that does not match, including a URL with an empty
 * repo, revision or file, so a malformed key is passed through rather than
 * rewritten into a nonsense URL.
 */
function parseFrom(prefix: string, url: string): ParsedModelUrl | null {
  if (!url.startsWith(prefix)) return null;

  const rest = url.slice(prefix.length);
  const marker = '/resolve/';
  const at = rest.indexOf(marker);
  if (at <= 0) return null;

  const repo = rest.slice(0, at);
  const tail = rest.slice(at + marker.length);
  const slash = tail.indexOf('/');
  if (slash <= 0) return null;

  const revision = tail.slice(0, slash);
  const file = tail.slice(slash + 1);
  if (revision === '' || file === '') return null;

  return { repo, revision, file };
}
