/**
 * Fetching dictionary bytes for the Rust phonemizer.
 *
 * The wasm decides *which* dictionaries it needs and what is inside one; this
 * module only moves bytes. That is why nothing here knows a dictionary's
 * format, and why the names are opaque strings handed over by
 * `required_dictionaries`.
 *
 * Dictionaries ship inside the extension (`public/dictionaries/`), so a fetch is
 * a read from local disk rather than a download. The cache below is therefore
 * close to redundant today — it exists because it is the seam a dictionary that
 * *is* downloaded would land in, and because the alternative the P6 plan first
 * proposed, `browser.storage.local`, cannot hold one: the extension does not ask
 * for `unlimitedStorage`, so that area is capped at 10 MB, and the Japanese
 * dictionary is ~10 MB compressed — before the 33% that base64 costs. Cache
 * Storage stores the bytes as a blob with no quota of its own, which is also how
 * the models and voices are already cached (`lib/models/downloader.ts`).
 */

/**
 * The part of the Cache API this module uses.
 *
 * Declared narrowly rather than using `Cache`, so a test can pass a plain
 * object — the same reason `ModelCache` exists in `lib/models/downloader.ts`.
 */
export interface DictionaryCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface DictionaryCacheStorage {
  open(name: string): Promise<DictionaryCache>;
}

/**
 * A dictionary's bytes.
 *
 * Spelled with the buffer parameter rather than as a bare `Uint8Array`: since
 * TypeScript 5.7 the bare form means "possibly backed by a `SharedArrayBuffer`",
 * which `Response` refuses. Nothing here ever is, and `tests/unit/models/fakes.ts`
 * spells its byte maps the same way for the same reason.
 */
export type DictionaryBytes = Uint8Array<ArrayBuffer>;

/** The shape of `fetch` this module needs; `typeof fetch` satisfies it. */
export type FetchLike = (url: string) => Promise<Response>;

/** Where the compressed dictionaries live, under the extension root. */
export const DICTIONARY_DIRECTORY = '/dictionaries';

/** The Cache Storage bucket the compressed dictionaries are kept in. */
export const DICTIONARIES_CACHE = 'phonemize-dictionaries';

/** The zstd frame magic number (RFC 8878 §3.1.1). */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

/**
 * Why a dictionary could not be loaded.
 *
 * The values that come from the wasm are the `code` strings
 * `crates/phonemize/src/dictionary.rs` puts on the errors it throws, verbatim —
 * so classifying one is a lookup rather than a translation, and a rename on
 * either side shows up as `'unknown'` here instead of as a wrong message.
 */
export type DictionaryFailureReason =
  | 'network'
  | 'status'
  | 'dictionary-format'
  | 'dictionary-decompress'
  | 'unknown-dictionary'
  | 'missing-dictionaries'
  | 'unknown-vocab'
  | 'unsupported-language'
  /** The wasm threw something this module does not recognise. */
  | 'unknown';

/** Every reason that can arrive as a wasm error `code`. */
const FROM_WASM: ReadonlySet<string> = new Set([
  'dictionary-format',
  'dictionary-decompress',
  'unknown-dictionary',
  'missing-dictionaries',
  'unknown-vocab',
  'unsupported-language',
]);

export class DictionaryLoadError extends Error {
  constructor(
    readonly reason: DictionaryFailureReason,
    message: string,
    /** The HTTP status, when the source answered with one. */
    readonly status?: number,
    /** Whatever was thrown underneath, kept for logging. */
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'DictionaryLoadError';
  }
}

export function isDictionaryLoadError(error: unknown): error is DictionaryLoadError {
  return error instanceof DictionaryLoadError;
}

/**
 * True for a zstd frame header.
 *
 * Checked here as well as in the wasm, and for a different reason each time. The
 * wasm's check is the authoritative one: it is what tells a packaging mistake
 * apart from a corrupt file. This one guards the cache — an entry written by an
 * interrupted `cache.put` is not a frame, and without the check it would be
 * served on every later cold start until the user reinstalled.
 */
export function isZstdFrame(bytes: Uint8Array): boolean {
  return bytes.length >= ZSTD_MAGIC.length && ZSTD_MAGIC.every((byte, at) => bytes[at] === byte);
}

/** Where one dictionary's bytes live, by default. */
export function dictionaryUrl(name: string): string {
  return `${DICTIONARY_DIRECTORY}/${name}.bin.zst`;
}

export interface DictionaryDeps {
  /** Injected for tests; defaults to the page's `fetch`. */
  readonly fetch?: FetchLike;
  /**
   * Injected for tests; defaults to the page's Cache Storage. `null` turns
   * caching off, which `undefined` cannot mean: in a browser, `undefined` is
   * "use the real one".
   */
  readonly cacheStorage?: DictionaryCacheStorage | null;
  /** Injected for tests; defaults to {@link dictionaryUrl}. */
  readonly url?: (name: string) => string;
}

/**
 * The bytes of one dictionary, compressed.
 *
 * Cache first, then fetch. Every failure along the way is a
 * {@link DictionaryLoadError} with a reason the caller can act on: the spec
 * (§8.1) requires a corrupt file to be told apart from a missing one, because
 * they are not fixed by the same thing.
 */
export async function fetchDictionary(
  name: string,
  deps: DictionaryDeps = {}
): Promise<DictionaryBytes> {
  const url = (deps.url ?? dictionaryUrl)(name);
  const cache = await openCache(deps.cacheStorage);

  const cached = await readCache(cache, url);
  if (cached !== null) return cached;

  const bytes = await download(url, name, deps.fetch);
  await writeCache(cache, url, bytes);
  return bytes;
}

/**
 * Classify what a call into the wasm threw.
 *
 * The Rust side throws a real `Error` with a `code` property, so this is a
 * lookup rather than a parse of the message — the message stays free to change,
 * and stays what a user-facing string is built from.
 */
export function dictionaryFailure(error: unknown): DictionaryLoadError {
  if (error instanceof DictionaryLoadError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  const reason =
    typeof code === 'string' && FROM_WASM.has(code) ? (code as DictionaryFailureReason) : 'unknown';

  return new DictionaryLoadError(reason, message, undefined, error);
}

/** The bucket, or null when this environment has no Cache Storage. */
async function openCache(
  storage: DictionaryCacheStorage | null | undefined
): Promise<DictionaryCache | null> {
  // `null` is a caller saying there is none; `undefined` is one saying it has
  // not looked. In a browser the second means the real Cache Storage.
  if (storage === null) return null;

  const resolved = storage ?? (globalThis as { caches?: DictionaryCacheStorage }).caches;
  if (!resolved) return null;

  try {
    return await resolved.open(DICTIONARIES_CACHE);
  } catch {
    // Caching is an optimisation. A cache that will not open must not stop a
    // dictionary from loading, or the extension stops working on a machine
    // whose storage is full.
    return null;
  }
}

/**
 * A usable entry, or null to carry on and fetch.
 *
 * A corrupt entry is deleted rather than left in place: it would otherwise be
 * re-read, re-rejected and re-fetched on every cold start for the life of the
 * profile.
 */
async function readCache(
  cache: DictionaryCache | null,
  url: string
): Promise<DictionaryBytes | null> {
  if (cache === null) return null;

  try {
    const hit = await cache.match(url);
    if (hit === undefined) return null;

    const bytes = new Uint8Array(await hit.arrayBuffer());
    if (isZstdFrame(bytes)) return bytes;

    await cache.delete(url).catch(() => false);
    return null;
  } catch {
    return null;
  }
}

/** Store the bytes, best effort. */
async function writeCache(
  cache: DictionaryCache | null,
  url: string,
  bytes: DictionaryBytes
): Promise<void> {
  if (cache === null) return;

  try {
    // A fresh `Response` rather than the fetched one: its body was read to get
    // these bytes, so the original is already consumed.
    await cache.put(url, new Response(bytes));
  } catch {
    // See `openCache`: a cache that cannot be written is a slower extension, not
    // a broken one.
  }
}

/** Fetch one dictionary, turning each way it can fail into a distinct reason. */
async function download(
  url: string,
  name: string,
  fetch: FetchLike | undefined
): Promise<DictionaryBytes> {
  const request = fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!request) {
    throw new DictionaryLoadError(
      'network',
      `there is no fetch available to load the ${name} dictionary`
    );
  }

  let response: Response;
  try {
    response = await request(url);
  } catch (cause) {
    throw new DictionaryLoadError(
      'network',
      `could not read the ${name} dictionary from ${url}`,
      undefined,
      cause
    );
  }

  if (!response.ok) {
    throw new DictionaryLoadError(
      'status',
      `the extension answered ${response.status} for the ${name} dictionary`,
      response.status
    );
  }

  let bytes: DictionaryBytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    throw new DictionaryLoadError(
      'network',
      `the ${name} dictionary broke off part way through`,
      undefined,
      cause
    );
  }

  if (!isZstdFrame(bytes)) {
    // Named before the wasm gets a chance to say "not a zstd frame", because
    // here the message can also say how many bytes arrived — which is what
    // distinguishes a file that is missing from one that was truncated.
    throw new DictionaryLoadError(
      'dictionary-format',
      `the ${name} dictionary is not a zstd frame (${bytes.length} bytes)`
    );
  }

  return bytes;
}
