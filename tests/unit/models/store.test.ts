import { describe, expect, it } from 'vitest';
import {
  DownloadError,
  type FetchLike,
  fileBytes,
  isCancellation,
  VOICE_FILE_BYTES,
  voiceKey,
} from '~/lib/models/downloader';
import { KOKORO_82M, type ModelTier, SHARED_FILE_BYTES } from '~/lib/models/registry';
import {
  DEFAULT_MODEL_SOURCE,
  MODEL_HOST_LAST_GOOD_KEY,
  MODEL_SOURCE_KEY,
  ModelHostUnreachableError,
  ModelStore,
  type ModelStoreOptions,
  normalizeLastGood,
  normalizeModelSource,
} from '~/lib/models/store';
import {
  type ConcreteModelHost,
  canonicalModelUrl,
  KOKORO_VOICES_CACHE,
  resolveUrl,
  TRANSFORMERS_CACHE,
} from '~/lib/models/urls';
import { bytesOf, FakeCaches, type FakeRoute, fakeArea, fakeFetch, requireTier } from './fakes';

const REPO = KOKORO_82M.repo;
const Q8 = requireTier(KOKORO_82M, 'q8');
const FP16 = requireTier(KOKORO_82M, 'fp16');

const SHARED_BYTES = Object.values(SHARED_FILE_BYTES).reduce((sum, bytes) => sum + bytes, 0);

/** The URL a model file resolves to on a source. */
function modelUrl(file: string, host: ConcreteModelHost = 'huggingface'): string {
  return resolveUrl(canonicalModelUrl(REPO, file), { host });
}

function voiceUrl(voiceId: string, host: ConcreteModelHost = 'huggingface'): string {
  return resolveUrl(voiceKey(KOKORO_82M, voiceId), { host });
}

/** Routes that answer every file of a tier, with a token body. */
function tierRoutes(
  tier: ModelTier,
  host: ConcreteModelHost = 'huggingface'
): Record<string, FakeRoute> {
  const routes: Record<string, FakeRoute> = {};
  for (const file of tier.files) routes[modelUrl(file, host)] = { bytes: bytesOf(8) };
  return routes;
}

/** Put a tier in the cache as if it had been downloaded. */
function seedTier(caches: FakeCaches, tier: ModelTier): void {
  for (const file of tier.files) {
    caches.bucket(TRANSFORMERS_CACHE).seed(canonicalModelUrl(REPO, file), fileBytes(tier, file));
  }
}

function seedVoice(caches: FakeCaches, voiceId: string): void {
  caches.bucket(KOKORO_VOICES_CACHE).seed(voiceKey(KOKORO_82M, voiceId), VOICE_FILE_BYTES);
}

function makeStore(fetch: FetchLike, options: Partial<ModelStoreOptions> = {}) {
  const fake = fakeArea();
  const caches = new FakeCaches();
  const store = new ModelStore({
    storage: fake.area,
    cacheStorage: caches,
    fetch,
    ...options,
  });
  return { store, caches, fake };
}

describe('the download source setting', () => {
  it('defaults to auto before anything is saved', async () => {
    const { store } = makeStore(fakeFetch({}));
    expect(await store.getSource()).toEqual({ host: 'auto' });
  });

  it('saves the choice, and reports what was stored', async () => {
    const { store, fake } = makeStore(fakeFetch({}));

    expect(await store.setSource({ host: 'modelscope' })).toEqual({ host: 'modelscope' });
    expect(fake.data.get(MODEL_SOURCE_KEY)).toEqual({ host: 'modelscope' });
    expect(await store.getSource()).toEqual({ host: 'modelscope' });
  });

  it('normalizes what it reads, because storage is shared with other versions', () => {
    expect(normalizeModelSource(undefined)).toEqual(DEFAULT_MODEL_SOURCE);
    expect(normalizeModelSource({ host: 'nonsense' })).toEqual({ host: 'auto' });
    expect(normalizeModelSource('modelscope')).toEqual({ host: 'auto' });
    // A custom mirror without a usable URL can only fail at fetch time, so it
    // falls back rather than being kept and then blamed on the network.
    expect(normalizeModelSource({ host: 'custom' })).toEqual({ host: 'auto' });
    expect(normalizeModelSource({ host: 'custom', customHostUrl: 'http://mirror.test' })).toEqual({
      host: 'auto',
    });
    expect(normalizeModelSource({ host: 'custom', customHostUrl: 'https://' })).toEqual({
      host: 'auto',
    });
    expect(
      normalizeModelSource({ host: 'custom', customHostUrl: '  https://mirror.test/m  ' })
    ).toEqual({ host: 'custom', customHostUrl: 'https://mirror.test/m' });
    // The URL the user typed is kept even when another host is selected, so
    // switching away from `custom` and back does not lose it.
    expect(normalizeModelSource({ host: 'auto', customHostUrl: 'https://mirror.test/m' })).toEqual({
      host: 'auto',
      customHostUrl: 'https://mirror.test/m',
    });
    // An unknown key is dropped rather than passed on.
    expect(normalizeModelSource({ host: 'huggingface', extra: 1 })).toEqual({
      host: 'huggingface',
    });
  });

  it('only remembers a source `auto` could have chosen', () => {
    expect(normalizeLastGood('huggingface')).toBe('huggingface');
    expect(normalizeLastGood('modelscope')).toBe('modelscope');
    expect(normalizeLastGood('custom')).toBeNull();
    expect(normalizeLastGood('auto')).toBeNull();
    expect(normalizeLastGood(undefined)).toBeNull();
  });
});

describe('resolveSource', () => {
  it('takes an explicit choice as it is, without probing', async () => {
    const fetch = fakeFetch({});
    const { store } = makeStore(fetch);
    await store.setSource({ host: 'huggingface' });

    expect(await store.resolveSource(KOKORO_82M)).toEqual({ host: 'huggingface' });
    expect(fetch.calls).toEqual([]);
  });

  it('keeps the custom mirror URL of an explicit choice', async () => {
    const { store } = makeStore(fakeFetch({}));
    await store.setSource({ host: 'custom', customHostUrl: 'https://mirror.test/m' });

    expect(await store.resolveSource(KOKORO_82M)).toEqual({
      host: 'custom',
      customHostUrl: 'https://mirror.test/m',
    });
  });

  it('surfaces a failure instead of silently switching source', async () => {
    const probe = (host: ConcreteModelHost): string => modelUrl('config.json', host);
    const fetch = fakeFetch({
      [probe('huggingface')]: { status: 503 },
      // Reachable, and deliberately never asked: the user chose Hugging Face.
      [probe('modelscope')]: { json: {} },
    });
    const { store, fake } = makeStore(fetch);
    await store.setSource({ host: 'huggingface' });

    const error = await store.downloadTier(KOKORO_82M, Q8).catch((thrown: unknown) => thrown);

    expect((error as DownloadError).status).toBe(503);
    expect(fetch.calls).toEqual([probe('huggingface')]);
    // And the failure does not quietly rewrite the remembered source either.
    expect(fake.data.has(MODEL_HOST_LAST_GOOD_KEY)).toBe(false);
  });

  it('uses the remembered source for auto, without probing again', async () => {
    const fetch = fakeFetch({});
    const { store, fake } = makeStore(fetch);
    fake.data.set(MODEL_HOST_LAST_GOOD_KEY, 'modelscope');

    expect(await store.resolveSource(KOKORO_82M)).toEqual({ host: 'modelscope' });
    expect(fetch.calls).toEqual([]);
  });

  it('probes both sources for auto and remembers the first to answer', async () => {
    const probe = (host: ConcreteModelHost): string => modelUrl('config.json', host);
    const fetch = fakeFetch({
      [probe('huggingface')]: { json: {}, delayMs: 40 },
      [probe('modelscope')]: { json: {}, delayMs: 5 },
    });
    const { store, fake } = makeStore(fetch);

    expect(await store.resolveSource(KOKORO_82M)).toEqual({ host: 'modelscope' });
    expect(fetch.calls).toHaveLength(2);
    // Remembered, so the next auto download does not pay for a probe again.
    expect(fake.data.get(MODEL_HOST_LAST_GOOD_KEY)).toBe('modelscope');
    // The choice the user made is untouched.
    expect(fake.data.has(MODEL_SOURCE_KEY)).toBe(false);
  });

  it('gives up when neither source answers', async () => {
    const probe = (host: ConcreteModelHost): string => modelUrl('config.json', host);
    const fetch = fakeFetch({
      [probe('huggingface')]: { json: {}, delayMs: 40 },
      [probe('modelscope')]: { json: {}, delayMs: 40 },
    });
    const { store, fake } = makeStore(fetch, { probeTimeoutMs: 5 });

    await expect(store.resolveSource(KOKORO_82M)).rejects.toBeInstanceOf(ModelHostUnreachableError);
    expect(fake.data.has(MODEL_HOST_LAST_GOOD_KEY)).toBe(false);
  });

  it('rejects a source that answers 200 with something that is not a model config', async () => {
    const probe = (host: ConcreteModelHost): string => modelUrl('config.json', host);
    // A captive portal: reachable, but not a place to download 163 MB from.
    const fetch = fakeFetch({
      [probe('huggingface')]: { bytes: bytesOf(20) },
      [probe('modelscope')]: { bytes: bytesOf(20) },
    });
    const { store } = makeStore(fetch, { probeTimeoutMs: 50 });

    await expect(store.resolveSource(KOKORO_82M)).rejects.toBeInstanceOf(ModelHostUnreachableError);
  });
});

describe('tiers', () => {
  it('reports a tier downloaded only when every one of its files is there', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    expect(await store.isTierDownloaded(KOKORO_82M, Q8)).toBe(false);

    seedTier(caches, Q8);
    expect(await store.isTierDownloaded(KOKORO_82M, Q8)).toBe(true);

    await caches.bucket(TRANSFORMERS_CACHE).delete(canonicalModelUrl(REPO, 'tokenizer.json'));
    expect(await store.isTierDownloaded(KOKORO_82M, Q8)).toBe(false);
  });

  it('lists the tiers that are downloaded', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedTier(caches, FP16);

    expect((await store.downloadedTiers(KOKORO_82M)).map((tier) => tier.id)).toEqual(['fp16']);
  });

  it('downloads a tier and remembers the source that worked', async () => {
    const fetch = fakeFetch(tierRoutes(Q8));
    const { store, caches, fake } = makeStore(fetch);
    await store.setSource({ host: 'huggingface' });
    const progress: number[] = [];
    let total = 0;

    await store.downloadTier(KOKORO_82M, Q8, {
      onProgress: (update) => {
        progress.push(update.bytes);
        total = update.totalBytes;
      },
    });

    expect(await store.isTierDownloaded(KOKORO_82M, Q8)).toBe(true);
    expect(fetch.calls).toHaveLength(Q8.files.length);
    // The bar follows the registry's measured sizes, not the token bodies the
    // fake served — that is what makes the promise before a download honest.
    expect(progress.at(-1)).toBe(Q8.bytes + SHARED_BYTES);
    expect(total).toBe(Q8.bytes + SHARED_BYTES);
    expect(fake.data.get(MODEL_HOST_LAST_GOOD_KEY)).toBe('huggingface');
    expect(caches.bucket(TRANSFORMERS_CACHE).has(canonicalModelUrl(REPO, 'config.json'))).toBe(
      true
    );
  });

  it('fetches only the files a failed download did not finish', async () => {
    const fetch = fakeFetch(tierRoutes(Q8));
    const { store, caches } = makeStore(fetch);
    await store.setSource({ host: 'huggingface' });
    caches.bucket(TRANSFORMERS_CACHE).seed(canonicalModelUrl(REPO, 'config.json'), 44);

    await store.downloadTier(KOKORO_82M, Q8);

    expect(fetch.calls).not.toContain(modelUrl('config.json'));
    expect(fetch.calls).toHaveLength(Q8.files.length - 1);
  });

  it('deletes one tier and keeps what another tier still needs', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedTier(caches, Q8);
    seedTier(caches, FP16);

    await store.deleteTier(KOKORO_82M, Q8);

    const bucket = caches.bucket(TRANSFORMERS_CACHE);
    expect(bucket.has(canonicalModelUrl(REPO, 'onnx/model_quantized.onnx'))).toBe(false);
    expect(bucket.has(canonicalModelUrl(REPO, 'onnx/model_fp16.onnx'))).toBe(true);
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
      expect(bucket.has(canonicalModelUrl(REPO, file))).toBe(true);
    }
  });

  it('deletes the shared files with the last tier that needed them', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedTier(caches, Q8);
    seedTier(caches, FP16);

    await store.deleteTier(KOKORO_82M, Q8);
    await store.deleteTier(KOKORO_82M, FP16);

    expect(caches.bucket(TRANSFORMERS_CACHE).entries.size).toBe(0);
  });

  it('does not let orphaned shared files keep themselves alive', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedTier(caches, Q8);
    // Another tier's metadata, with no weights behind it: not a reason to keep
    // the shared files forever.
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
      caches.bucket(TRANSFORMERS_CACHE).seed(canonicalModelUrl(REPO, file));
    }

    await store.deleteTier(KOKORO_82M, Q8);

    expect(caches.bucket(TRANSFORMERS_CACHE).entries.size).toBe(0);
  });
});

describe('usage', () => {
  it('counts nothing when nothing is downloaded', async () => {
    const { store } = makeStore(fakeFetch({}));
    expect(await store.usage()).toEqual({
      modelBytes: 0,
      voiceBytes: 0,
      totalBytes: 0,
      voiceCount: 0,
    });
  });

  it('counts a tier by its measured size', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedTier(caches, Q8);

    expect(await store.usage()).toMatchObject({ modelBytes: Q8.bytes + SHARED_BYTES });
  });

  it('counts the shared files once, however many tiers are installed', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedTier(caches, Q8);
    seedTier(caches, FP16);

    expect((await store.usage()).modelBytes).toBe(Q8.bytes + FP16.bytes + SHARED_BYTES);
  });

  it('counts voices separately from the model', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedTier(caches, Q8);
    seedVoice(caches, 'af_heart');
    seedVoice(caches, 'zf_xiaoxiao');

    const usage = await store.usage();
    expect(usage.voiceCount).toBe(2);
    expect(usage.voiceBytes).toBe(2 * VOICE_FILE_BYTES);
    expect(usage.totalBytes).toBe(usage.modelBytes + usage.voiceBytes);
  });
});

describe('voices', () => {
  it('reports a voice as downloaded only when its file is cached', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    expect(await store.isVoiceDownloaded(KOKORO_82M, 'af_heart')).toBe(false);

    seedVoice(caches, 'af_heart');
    expect(await store.isVoiceDownloaded(KOKORO_82M, 'af_heart')).toBe(true);
    expect(await store.isVoiceDownloaded(KOKORO_82M, 'af_bella')).toBe(false);
  });

  it('lists the downloaded voices in the order they were asked about', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedVoice(caches, 'af_bella');

    expect(
      await store.downloadedVoiceIds(KOKORO_82M, ['af_heart', 'af_bella', 'zf_xiaoxiao'])
    ).toEqual(['af_bella']);
  });

  it('downloads one voice under the key kokoro-js will look up', async () => {
    const fetch = fakeFetch({ [voiceUrl('af_heart', 'modelscope')]: { bytes: bytesOf(16) } });
    const { store, caches } = makeStore(fetch);
    await store.setSource({ host: 'modelscope' });

    await store.downloadVoice(KOKORO_82M, 'af_heart');

    expect(fetch.calls).toEqual([voiceUrl('af_heart', 'modelscope')]);
    // Fetched from ModelScope, cached under the Hugging Face URL: the library
    // reads that key and never sees where the bytes came from.
    expect(caches.bucket(KOKORO_VOICES_CACHE).has(voiceKey(KOKORO_82M, 'af_heart'))).toBe(true);
    expect(await store.isVoiceDownloaded(KOKORO_82M, 'af_heart')).toBe(true);
  });

  it('does not call a voice downloaded when its download failed', async () => {
    const fetch = fakeFetch({ [voiceUrl('af_heart')]: { status: 500 } });
    const { store, caches } = makeStore(fetch);
    await store.setSource({ host: 'huggingface' });

    const error = await store
      .downloadVoice(KOKORO_82M, 'af_heart')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).status).toBe(500);
    expect(await store.isVoiceDownloaded(KOKORO_82M, 'af_heart')).toBe(false);
    expect(caches.bucket(KOKORO_VOICES_CACHE).entries.size).toBe(0);
  });

  it('keeps going when one voice of a bulk download fails', async () => {
    const fetch = fakeFetch({
      [voiceUrl('af_heart')]: { bytes: bytesOf(16) },
      [voiceUrl('af_bella')]: { status: 403 },
      [voiceUrl('zf_xiaoxiao')]: { bytes: bytesOf(16) },
    });
    const { store } = makeStore(fetch);
    await store.setSource({ host: 'huggingface' });
    const progress: number[] = [];

    const report = await store.downloadAllVoices(
      KOKORO_82M,
      ['af_heart', 'af_bella', 'zf_xiaoxiao'],
      { onProgress: (update) => progress.push(update.bytes) }
    );

    expect([...report.downloaded].sort()).toEqual(['af_heart', 'zf_xiaoxiao']);
    expect(report.failed.map((failure) => failure.voiceId)).toEqual(['af_bella']);
    expect(await store.isVoiceDownloaded(KOKORO_82M, 'af_bella')).toBe(false);
    // The bar counts bytes that reached the cache: the two that succeeded. The
    // one that failed is reported separately rather than counted as progress.
    expect(progress.at(-1)).toBe(2 * VOICE_FILE_BYTES);
    expect(Math.max(...progress)).toBeLessThanOrEqual(3 * VOICE_FILE_BYTES);
  });

  it('stops a bulk download that the user cancelled', async () => {
    const fetch = fakeFetch({
      [voiceUrl('af_heart')]: { bytes: bytesOf(16) },
      [voiceUrl('af_bella')]: { bytes: bytesOf(16) },
    });
    const { store } = makeStore(fetch);
    await store.setSource({ host: 'huggingface' });

    const error = await store
      .downloadAllVoices(KOKORO_82M, ['af_heart', 'af_bella'], { signal: AbortSignal.abort() })
      .catch((thrown: unknown) => thrown);

    expect(isCancellation(error)).toBe(true);
    expect(fetch.calls).toEqual([]);
  });

  it('does nothing for an empty voice list', async () => {
    const fetch = fakeFetch({});
    const { store } = makeStore(fetch);
    await store.setSource({ host: 'huggingface' });

    expect(await store.downloadAllVoices(KOKORO_82M, [])).toEqual({ downloaded: [], failed: [] });
    expect(fetch.calls).toEqual([]);
  });

  it('deletes this model voices and leaves anything else in the bucket', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedVoice(caches, 'af_heart');
    seedVoice(caches, 'zf_xiaoxiao');
    const foreign = 'https://huggingface.co/other/repo/resolve/main/voices/af_heart.bin';
    caches.bucket(KOKORO_VOICES_CACHE).seed(foreign);

    await store.deleteAllVoices(KOKORO_82M);

    expect(caches.bucket(KOKORO_VOICES_CACHE).entries.size).toBe(1);
    expect(caches.bucket(KOKORO_VOICES_CACHE).has(foreign)).toBe(true);
    expect(await store.isVoiceDownloaded(KOKORO_82M, 'af_heart')).toBe(false);
  });

  it('leaves the model files alone when voices are deleted', async () => {
    const { store, caches } = makeStore(fakeFetch({}));
    seedTier(caches, Q8);
    seedVoice(caches, 'af_heart');

    await store.deleteAllVoices(KOKORO_82M);

    expect(await store.isTierDownloaded(KOKORO_82M, Q8)).toBe(true);
  });
});
