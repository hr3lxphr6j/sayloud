import { describe, expect, it } from 'vitest';
import {
  ALL_VOICE_FILES,
  ALL_VOICES_BYTES,
  DownloadError,
  type DownloadProgress,
  downloadFiles,
  fileBytes,
  isCancellation,
  type PlannedFile,
  tierPlan,
  VOICE_FILE_BYTES,
  voiceKey,
  voicePlan,
} from '~/lib/models/downloader';
import { KOKORO_82M } from '~/lib/models/registry';
import { canonicalModelUrl, KOKORO_VOICES_CACHE, TRANSFORMERS_CACHE } from '~/lib/models/urls';
import {
  abortError,
  bytesOf,
  chunkedBody,
  FakeCaches,
  type FakeRoute,
  failingBody,
  fakeFetch,
  requireTier,
  sharedBytes,
} from './fakes';

const HF = { host: 'huggingface' } as const;
const Q8 = requireTier(KOKORO_82M, 'q8');

/** Two small files, so the progress arithmetic can be checked by hand. */
const FILES: readonly PlannedFile[] = [
  {
    path: 'a.bin',
    url: 'https://source.test/a.bin',
    key: 'key:a',
    cache: TRANSFORMERS_CACHE,
    bytes: 100,
  },
  {
    path: 'b.bin',
    url: 'https://source.test/b.bin',
    key: 'key:b',
    cache: TRANSFORMERS_CACHE,
    bytes: 50,
  },
];

/** Fresh routes per test: a `ReadableStream` can only be consumed once. */
function routes(): Record<string, FakeRoute> {
  return {
    'https://source.test/a.bin': { body: chunkedBody(bytesOf(10), bytesOf(20), bytesOf(70)) },
    'https://source.test/b.bin': { bytes: bytesOf(50) },
  };
}

describe('the plans', () => {
  it('sizes a shared file by its own measurement and the ONNX by the tier', () => {
    expect(fileBytes(Q8, 'config.json')).toBe(sharedBytes('config.json'));
    expect(fileBytes(Q8, 'tokenizer.json')).toBe(sharedBytes('tokenizer.json'));
    expect(fileBytes(Q8, 'onnx/model_quantized.onnx')).toBe(Q8.bytes);
  });

  it('plans a tier with canonical keys and resolved URLs', () => {
    const plan = tierPlan(KOKORO_82M, Q8, HF);

    expect(plan.map((file) => file.path)).toEqual([
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
    ]);
    for (const file of plan) {
      expect(file.cache).toBe(TRANSFORMERS_CACHE);
      expect(file.key).toBe(canonicalModelUrl(KOKORO_82M.repo, file.path));
      expect(file.key.startsWith('https://model-cache.sayloud.invalid/')).toBe(true);
      expect(file.url.startsWith('https://huggingface.co/')).toBe(true);
    }

    const total = plan.reduce((sum, file) => sum + file.bytes, 0);
    expect(total).toBe(
      Q8.bytes +
        sharedBytes('config.json') +
        sharedBytes('tokenizer.json') +
        sharedBytes('tokenizer_config.json')
    );
  });

  it('plans a tier against ModelScope on the other branch', () => {
    const plan = tierPlan(KOKORO_82M, Q8, { host: 'modelscope' });
    expect(plan[0]?.url).toBe(
      `https://modelscope.cn/models/${KOKORO_82M.repo}/resolve/master/config.json`
    );
    // The key never moves, so switching source does not orphan the cache.
    expect(plan[0]?.key).toBe(canonicalModelUrl(KOKORO_82M.repo, 'config.json'));
  });

  it('plans a voice under the key kokoro-js looks up', () => {
    const plan = voicePlan(KOKORO_82M, 'af_heart', HF);
    const file = plan[0];

    expect(plan).toHaveLength(1);
    expect(file?.path).toBe('voices/af_heart.bin');
    expect(file?.cache).toBe(KOKORO_VOICES_CACHE);
    expect(file?.bytes).toBe(VOICE_FILE_BYTES);
    expect(file?.key).toBe(voiceKey(KOKORO_82M, 'af_heart'));
    expect(file?.key).toBe(
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin'
    );
  });

  it('plans a voice against ModelScope without moving its key', () => {
    const file = voicePlan(KOKORO_82M, 'af_heart', { host: 'modelscope' })[0];
    expect(file?.url).toBe(
      'https://modelscope.cn/models/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/master/voices/af_heart.bin'
    );
    expect(file?.key).toContain('https://huggingface.co/');
  });

  it('knows what downloading every voice costs', () => {
    expect(VOICE_FILE_BYTES).toBe(522_240);
    expect(ALL_VOICE_FILES).toBe(54);
    expect(ALL_VOICES_BYTES).toBe(54 * 522_240);
  });
});

describe('downloadFiles', () => {
  it('counts bytes as they arrive and finishes at the promised total', async () => {
    const caches = new FakeCaches();
    const progress: DownloadProgress[] = [];

    await downloadFiles(FILES, {
      fetch: fakeFetch(routes()),
      cacheStorage: caches,
      onProgress: (update) => progress.push(update),
    });

    // 10, 30 and 100 as `a` streams, then `b`'s 50.
    expect(progress.map((update) => update.bytes)).toEqual([10, 30, 100, 150]);
    expect(progress.at(-1)?.totalBytes).toBe(150);
    expect(progress.at(-1)?.fileCount).toBe(2);

    // Progress has to be usable as a bar, so it never goes backwards.
    let previous = -1;
    for (const update of progress) {
      expect(update.bytes).toBeGreaterThanOrEqual(previous);
      previous = update.bytes;
    }

    // Mid-file values prove the body is streamed rather than buffered whole.
    expect(progress.some((update) => update.bytes > 0 && update.bytes < 100)).toBe(true);
    expect(progress[0]).toMatchObject({ path: 'a.bin', fileIndex: 1, fileCount: 2 });
  });

  it('writes each file under its canonical key, in its own bucket', async () => {
    const caches = new FakeCaches();

    await downloadFiles(FILES, { fetch: fakeFetch(routes()), cacheStorage: caches });

    const bucket = caches.bucket(TRANSFORMERS_CACHE);
    expect([...bucket.entries.keys()]).toEqual(['key:a', 'key:b']);
    expect(bucket.entries.get('key:a')?.byteLength).toBe(100);
    expect(bucket.entries.get('key:b')?.byteLength).toBe(50);
  });

  it('counts a file that is already cached instead of fetching it again', async () => {
    const caches = new FakeCaches();
    caches.bucket(TRANSFORMERS_CACHE).seed('key:a', 100);
    const fetch = fakeFetch(routes());

    await downloadFiles(FILES, { fetch, cacheStorage: caches });

    expect(fetch.calls).toEqual(['https://source.test/b.bin']);
  });

  it('does nothing at all for an empty plan', async () => {
    const fetch = fakeFetch({});
    await downloadFiles([], { fetch, cacheStorage: new FakeCaches() });
    expect(fetch.calls).toEqual([]);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const fetch = fakeFetch(routes());
    const error = await downloadFiles(FILES, {
      fetch,
      cacheStorage: new FakeCaches(),
      signal: AbortSignal.abort(),
    }).catch((thrown: unknown) => thrown);

    expect(fetch.calls).toEqual([]);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).reason).toBe('cancelled');
  });

  it('stops a download that is cancelled in flight, leaving nothing behind', async () => {
    const caches = new FakeCaches();
    const controller = new AbortController();
    const promise = downloadFiles(FILES, {
      fetch: fakeFetch({
        ...routes(),
        'https://source.test/a.bin': {
          body: chunkedBody(bytesOf(10), bytesOf(20), bytesOf(70)),
          delayMs: 50,
        },
      }),
      cacheStorage: caches,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 5);
    const error = await promise.catch((thrown: unknown) => thrown);

    expect((error as DownloadError).reason).toBe('cancelled');
    expect(caches.bucket(TRANSFORMERS_CACHE).entries.size).toBe(0);
  });

  it('reports a non-2xx answer as a status failure, with the status', async () => {
    const caches = new FakeCaches();
    const error = await downloadFiles(FILES, {
      fetch: fakeFetch({ 'https://source.test/a.bin': { status: 404 } }),
      cacheStorage: caches,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).reason).toBe('status');
    expect((error as DownloadError).status).toBe(404);
    expect(caches.bucket(TRANSFORMERS_CACHE).entries.size).toBe(0);
  });

  it('refuses a partial response, which the Cache API will not store', async () => {
    const caches = new FakeCaches();
    const error = await downloadFiles(FILES, {
      fetch: fakeFetch({ 'https://source.test/a.bin': { status: 206, bytes: bytesOf(4) } }),
      cacheStorage: caches,
    }).catch((thrown: unknown) => thrown);

    expect((error as DownloadError).reason).toBe('status');
    expect((error as DownloadError).status).toBe(206);
    expect(caches.bucket(TRANSFORMERS_CACHE).entries.size).toBe(0);
  });

  it('reports a source that cannot be reached as a network failure', async () => {
    const caches = new FakeCaches();
    const error = await downloadFiles(FILES, {
      fetch: async () => {
        throw new TypeError('failed to fetch');
      },
      cacheStorage: caches,
    }).catch((thrown: unknown) => thrown);

    expect((error as DownloadError).reason).toBe('network');
    expect((error as DownloadError).message).toContain('a.bin');
    expect(caches.bucket(TRANSFORMERS_CACHE).entries.size).toBe(0);
  });

  it('leaves no half-written entry when the body dies mid-download', async () => {
    const caches = new FakeCaches();
    const error = await downloadFiles(FILES, {
      fetch: fakeFetch({
        'https://source.test/a.bin': { body: failingBody(40) },
      }),
      cacheStorage: caches,
    }).catch((thrown: unknown) => thrown);

    // A broken connection is a network failure, not a cache one: the caller
    // must not be told the disk is full when the source went away.
    expect((error as DownloadError).reason).toBe('network');
    expect(caches.bucket(TRANSFORMERS_CACHE).has('key:a')).toBe(false);
    expect(caches.bucket(TRANSFORMERS_CACHE).entries.size).toBe(0);
  });

  it('reports a cache that refuses the write, and keeps nothing', async () => {
    const deleted: string[] = [];
    const storage = {
      async open() {
        return {
          async match() {
            return undefined;
          },
          async put() {
            throw new Error('quota exceeded');
          },
          async delete(key: string) {
            deleted.push(key);
            return true;
          },
          async keys() {
            return [];
          },
        };
      },
    };

    const error = await downloadFiles(FILES, {
      fetch: fakeFetch(routes()),
      cacheStorage: storage,
    }).catch((thrown: unknown) => thrown);

    expect((error as DownloadError).reason).toBe('cache');
    expect((error as DownloadError).message).toContain('quota exceeded');
    expect(deleted).toEqual(['key:a']);
  });

  it('recognises a cancellation however it arrives', () => {
    expect(isCancellation(new DownloadError('cancelled', 'stop'))).toBe(true);
    expect(isCancellation(abortError())).toBe(true);
    expect(isCancellation(new DownloadError('network', 'down'))).toBe(false);
    expect(isCancellation(new Error('nope'))).toBe(false);
  });
});
