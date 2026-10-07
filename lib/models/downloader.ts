/**
 * Fetching model and voice files into Cache Storage.
 *
 * This runs in the side panel, which is a visible page — deliberately not in
 * the offscreen document, which Chrome recycles 30 seconds after audio stops and
 * would kill a multi-minute download halfway. It therefore must not import
 * anything that drags in ORT: it only moves bytes.
 *
 * The keys it writes are canonical (`urls.ts`), never the URL it fetched, so
 * changing download source keeps what is already cached.
 */
import { isAbortError } from '../providers/errors';
import {
  type ModelTier,
  type OnDeviceModel,
  SHARED_FILE_BYTES,
  SHARED_MODEL_FILES,
} from './registry';
import {
  canonicalModelUrl,
  canonicalVoiceUrl,
  KOKORO_VOICES_CACHE,
  type ModelSource,
  resolveUrl,
  TRANSFORMERS_CACHE,
} from './urls';

/** The measured size of one voice file; the UI promises this before fetching. */
export const VOICE_FILE_BYTES = 522_240;

/**
 * How many entries the repository's `voices/` directory holds.
 *
 * All of them, including the languages the on-device engine cannot synthesize:
 * "download all voices" is about the repository's files, and a partial voice
 * list would make the button's size estimate wrong.
 */
export const ALL_VOICE_FILES = 54;

/** What downloading every voice costs, in the same units as `VOICE_FILE_BYTES`. */
export const ALL_VOICES_BYTES = VOICE_FILE_BYTES * ALL_VOICE_FILES;

/**
 * The part of the Cache API this module uses.
 *
 * Declared here rather than using `Cache` so a test can pass a plain object,
 * the same reason `LocalStorageArea` exists in `config-store.ts`.
 */
export interface ModelCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<readonly CacheKey[]>;
}

/** A stored key: Chrome hands back `Request`s, a fake may hand back strings. */
export type CacheKey = string | { readonly url: string };

export interface ModelCacheStorage {
  open(name: string): Promise<ModelCache>;
}

/** The URL a stored key stands for, or null when it has none. */
export function cacheKeyUrl(entry: CacheKey): string | null {
  if (typeof entry === 'string') return entry === '' ? null : entry;
  const url = entry.url;
  return typeof url === 'string' && url !== '' ? url : null;
}

/** The shape of `fetch` this module needs; `typeof fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init?: { readonly signal?: AbortSignal }
) => Promise<Response>;

/** One file to fetch, and where its bytes belong once they are all in. */
export interface PlannedFile {
  /** Path inside the model root, e.g. `onnx/model_quantized.onnx`. */
  readonly path: string;
  /** Where to fetch it from, already resolved for the chosen source. */
  readonly url: string;
  /** The Cache Storage key — canonical, so the source cannot leak into it. */
  readonly key: string;
  /** Which bucket it belongs in. */
  readonly cache: string;
  /** The measured size, so progress can be shown before a byte arrives. */
  readonly bytes: number;
}

/** How far a download has got, across all the files in one plan. */
export interface DownloadProgress {
  /** Bytes fetched so far, counting the files already in the cache. */
  readonly bytes: number;
  /** The sum of the measured sizes. */
  readonly totalBytes: number;
  /** The file being fetched, for a caption. */
  readonly path: string;
  /** 1-based, for "file 2 of 4". */
  readonly fileIndex: number;
  readonly fileCount: number;
}

export interface DownloadOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
  /** Injected for tests; defaults to the page's `caches` and `fetch`. */
  readonly cacheStorage?: ModelCacheStorage;
  readonly fetch?: FetchLike;
}

/** Why a download stopped. The store maps these onto user-facing errors. */
export type DownloadFailureReason = 'cancelled' | 'network' | 'status' | 'cache';

export class DownloadError extends Error {
  constructor(
    readonly reason: DownloadFailureReason,
    message: string,
    /** The HTTP status, when the source answered with one. */
    readonly status?: number
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export function isDownloadError(error: unknown): error is DownloadError {
  return error instanceof DownloadError;
}

/** True for a download the caller cancelled, however it surfaced. */
export function isCancellation(error: unknown): boolean {
  return (isDownloadError(error) && error.reason === 'cancelled') || isAbortError(error);
}

/** The measured size of one file of a tier: the ONNX carries the tier's bytes. */
export function fileBytes(tier: ModelTier, file: string): number {
  return SHARED_FILE_BYTES[file] ?? tier.bytes;
}

/** True for a file every tier of the model shares. */
export function isSharedModelFile(file: string): boolean {
  return SHARED_MODEL_FILES.includes(file);
}

/** Every file a tier download needs, with its key, its URL and its size. */
export function tierPlan(
  model: OnDeviceModel,
  tier: ModelTier,
  source: ModelSource
): PlannedFile[] {
  return tier.files.map((file) => {
    const key = canonicalModelUrl(model.repo, file);
    return {
      path: file,
      url: resolveUrl(key, source),
      key,
      cache: TRANSFORMERS_CACHE,
      bytes: fileBytes(tier, file),
    };
  });
}

/** The path a voice file has inside the repository. */
export function voiceFilePath(model: OnDeviceModel, voiceId: string): string {
  return model.voiceFile?.(voiceId) ?? `voices/${voiceId}.bin`;
}

/** The Cache Storage key a voice is stored under, and looked up by. */
export function voiceKey(model: OnDeviceModel, voiceId: string): string {
  return canonicalVoiceUrl(model.repo, voiceFilePath(model, voiceId));
}

/** The one-file plan a voice download needs. */
export function voicePlan(
  model: OnDeviceModel,
  voiceId: string,
  source: ModelSource
): PlannedFile[] {
  const key = voiceKey(model, voiceId);
  return [
    {
      path: voiceFilePath(model, voiceId),
      url: resolveUrl(key, source),
      key,
      cache: KOKORO_VOICES_CACHE,
      bytes: VOICE_FILE_BYTES,
    },
  ];
}

/**
 * Download every file in `files`, in order, reporting bytes as they arrive.
 *
 * A file that is already cached is counted as done and not fetched again, so
 * retrying after a failure resumes instead of starting over. A failure throws
 * and leaves nothing behind: the entry is only written once its body has been
 * read to the end, and a body that dies midway takes the entry with it.
 */
export async function downloadFiles(
  files: readonly PlannedFile[],
  options: DownloadOptions = {}
): Promise<void> {
  if (files.length === 0) return;

  const context: DownloadContext = {
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    cacheStorage: options.cacheStorage ?? globalThis.caches,
    signal: options.signal,
    buckets: new Map(),
  };
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  let done = 0;
  let reported = -1;

  for (const [index, file] of files.entries()) {
    const report = (bytes: number): void => {
      // A file that finishes exactly where its last chunk left off would
      // otherwise report the same total twice.
      if (bytes === reported) return;
      reported = bytes;
      options.onProgress?.({
        bytes,
        totalBytes,
        path: file.path,
        fileIndex: index + 1,
        fileCount: files.length,
      });
    };

    if (!(await isCached(context, file))) {
      await downloadOne(file, context, (received) => report(done + received));
    }

    // The declared size, not the bytes counted: the bar has to line up with the
    // total the UI promised, and the two differ only if upstream changed a file.
    done += file.bytes;
    report(done);
  }
}

interface DownloadContext {
  readonly fetch: FetchLike;
  readonly cacheStorage: ModelCacheStorage;
  readonly signal?: AbortSignal;
  /** Opened buckets, so a plan does not reopen one per file. */
  readonly buckets: Map<string, Promise<ModelCache>>;
}

/** Whether the canonical key is already stored, whatever source wrote it. */
async function isCached(context: DownloadContext, file: PlannedFile): Promise<boolean> {
  const cache = await bucket(context, file.cache);
  return (await cache.match(file.key)) !== undefined;
}

/** Fetch one file and store it under its canonical key. */
async function downloadOne(
  file: PlannedFile,
  context: DownloadContext,
  onBytes: (received: number) => void
): Promise<void> {
  const response = await request(file, context);
  // A 206 is a partial file, and the Cache API refuses to store one at all —
  // better to say so here than to fail inside `cache.put` with a TypeError.
  if (!response.ok || response.status === 206) {
    throw new DownloadError(
      'status',
      `the download source answered ${response.status} for ${file.path}`,
      response.status
    );
  }

  const cache = await bucket(context, file.cache);
  const headers = contentTypeOf(response);
  let bodyFailure: DownloadError | null = null;

  try {
    const body = response.body;
    if (!body) {
      // A response with no stream still has bytes; read them in one go.
      const buffer = await response.arrayBuffer();
      onBytes(buffer.byteLength);
      await cache.put(file.key, new Response(buffer, { headers }));
      return;
    }
    await cache.put(
      file.key,
      new Response(
        countBytes(body, file.path, onBytes, (failure) => {
          bodyFailure = failure;
        }),
        { headers }
      )
    );
  } catch (error) {
    // A half-read entry is worse than no entry: the engine would load it and
    // fail at model-load time with nothing to point at. Cache Storage drops a
    // body that errored, but a partial write from another cause is possible.
    await cache.delete(file.key).catch(() => false);
    // A body that died is reported as the network failure it is, whatever the
    // runtime chose to reject with: Node wraps the reason in an `EncodingError`
    // and Chrome passes it through, and neither is something a caller can tell
    // apart from a failing write.
    throw bodyFailure ?? asDownloadError(error, 'cache', `the download of ${file.path} failed`);
  }
}

/** Issue the request, turning a transport failure into a `DownloadError`. */
async function request(file: PlannedFile, context: DownloadContext): Promise<Response> {
  if (context.signal?.aborted) {
    throw new DownloadError('cancelled', `the download of ${file.path} was cancelled`);
  }

  try {
    return await context.fetch(file.url, context.signal ? { signal: context.signal } : undefined);
  } catch (error) {
    if (isAbortError(error)) {
      throw new DownloadError('cancelled', `the download of ${file.path} was cancelled`);
    }
    throw asDownloadError(error, 'network', `could not fetch ${file.path}`);
  }
}

/** Wrap a non-download failure, keeping cancellation recognisable. */
function asDownloadError(
  error: unknown,
  reason: DownloadFailureReason,
  message: string
): DownloadError {
  if (error instanceof DownloadError) return error;
  if (isAbortError(error)) return new DownloadError('cancelled', message);
  const detail = error instanceof Error ? error.message : String(error);
  return new DownloadError(reason, `${message}: ${detail}`);
}

/**
 * A stream that reports how many bytes have gone through it.
 *
 * The bytes are counted as `cache.put` pulls them, so a failure part-way is a
 * failure of the same promise that would have stored the entry. A read that
 * fails is turned into a `DownloadError` here rather than in the caller's
 * `catch`, which cannot tell a broken connection from a broken write.
 */
function countBytes(
  body: ReadableStream<Uint8Array>,
  path: string,
  onBytes: (received: number) => void,
  onFailure: (failure: DownloadError) => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        const failure = readFailure(error, path);
        onFailure(failure);
        controller.error(failure);
        return;
      }

      const { done, value } = result;
      if (done) {
        controller.close();
        return;
      }
      received += value.byteLength;
      onBytes(received);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The failure of a body read, told apart from a failure to write it. */
function readFailure(error: unknown, path: string): DownloadError {
  if (isAbortError(error)) {
    return new DownloadError('cancelled', `the download of ${path} was cancelled`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new DownloadError('network', `the download of ${path} broke off: ${detail}`);
}

/** The bucket, opened once per plan. */
function bucket(context: DownloadContext, name: string): Promise<ModelCache> {
  const opened = context.buckets.get(name) ?? context.cacheStorage.open(name);
  context.buckets.set(name, opened);
  return opened;
}

/** Keep the response's content type; the bytes are all that matter otherwise. */
function contentTypeOf(response: Response): Record<string, string> | undefined {
  const type = response.headers.get('content-type');
  return type === null || type === '' ? undefined : { 'Content-Type': type };
}
