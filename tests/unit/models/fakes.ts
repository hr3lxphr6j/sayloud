/**
 * Test doubles for the model data layer.
 *
 * Not a `.test.ts` file, so Vitest does not collect it as a suite. Everything
 * the modules touch from the outside world — `chrome.storage.local`, Cache
 * Storage and `fetch` — is a constructor argument, so nothing here needs a
 * global or a network.
 */
import type { LocalStorageArea } from '~/lib/config-store';
import type { FetchLike, ModelCache, ModelCacheStorage } from '~/lib/models/downloader';
import {
  type ModelTier,
  type OnDeviceModel,
  SHARED_FILE_BYTES,
  tierById,
} from '~/lib/models/registry';

/** An in-memory `chrome.storage.local`. */
export function fakeArea(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const area: LocalStorageArea = {
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of wanted) result[key] = data.get(key);
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
  };
  return { area, data };
}

/** One bucket of the Cache API, holding bytes by key. */
export class FakeBucket implements ModelCache {
  readonly entries = new Map<string, Uint8Array<ArrayBuffer>>();

  /** Put bytes in without going through a download, for a "already there" test. */
  seed(key: string, size = 1): void {
    this.entries.set(key, new Uint8Array(size));
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  async match(key: string): Promise<Response | undefined> {
    const bytes = this.entries.get(key);
    return bytes === undefined ? undefined : new Response(bytes);
  }

  async put(key: string, response: Response): Promise<void> {
    // Reading the body is what drives the downloader's progress callbacks, so a
    // fake that skipped it would not exercise the counting stream at all.
    this.entries.set(key, new Uint8Array(await response.arrayBuffer()));
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    return [...this.entries.keys()];
  }
}

/** An in-memory Cache Storage. */
export class FakeCaches implements ModelCacheStorage {
  readonly buckets = new Map<string, FakeBucket>();

  /** The bucket, created if it is not there; for seeding and assertions. */
  bucket(name: string): FakeBucket {
    const existing = this.buckets.get(name);
    if (existing) return existing;
    const bucket = new FakeBucket();
    this.buckets.set(name, bucket);
    return bucket;
  }

  async open(name: string): Promise<FakeBucket> {
    return this.bucket(name);
  }
}

export interface FakeRoute {
  /** The whole body, in one chunk. */
  bytes?: Uint8Array<ArrayBuffer>;
  /** A body in several chunks, so progress is observable mid-file. */
  body?: ReadableStream<Uint8Array>;
  /** A JSON body, for the `auto` probe's `config.json`. */
  json?: unknown;
  status?: number;
  /** How long the source takes to answer, in milliseconds. */
  delayMs?: number;
}

export interface FakeFetch extends FetchLike {
  readonly calls: string[];
}

/** A `fetch` that only answers the URLs it was given, and records them. */
export function fakeFetch(routes: Record<string, FakeRoute>): FakeFetch {
  const calls: string[] = [];

  const fetchLike = async (
    url: string,
    init?: { readonly signal?: AbortSignal }
  ): Promise<Response> => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) throw new TypeError(`no fake route for ${url}`);

    if (route.delayMs !== undefined) await sleep(route.delayMs, init?.signal);

    const status = route.status ?? 200;
    if (route.body !== undefined) return new Response(route.body, { status });
    if (route.json !== undefined) {
      return new Response(JSON.stringify(route.json), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(route.bytes ?? null, { status });
  };

  return Object.assign(fetchLike, { calls });
}

/** `size` zero bytes, typed as the body of a `Response` needs them. */
export function bytesOf(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size));
}

/** The measured size of a shared model file, without an unchecked index. */
export function sharedBytes(file: string): number {
  const bytes = SHARED_FILE_BYTES[file];
  if (bytes === undefined) throw new Error(`${file} is not a shared model file`);
  return bytes;
}

/** A body delivered as the given chunks, in order. */
export function chunkedBody(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/** A body that sends `size` bytes and then dies, as a dropped connection does. */
export function failingBody(
  size: number,
  error: Error = new Error('connection reset')
): ReadableStream<Uint8Array> {
  const chunk = bytesOf(size);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(error);
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

/** An `AbortError`, the way `fetch` rejects when its signal fires. */
export function abortError(): Error {
  const error = new Error('the operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** The tier of `model` with this id, or a thrown error — no `!` in tests. */
export function requireTier(model: OnDeviceModel, id: string): ModelTier {
  const tier = tierById(model, id);
  if (!tier) throw new Error(`${model.id} has no tier ${id}`);
  return tier;
}

/** Wait, unless the signal fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
