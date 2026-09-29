import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheManager, L1Cache, L2Cache } from '~/lib/cache-manager';
import type { ProviderConfig, SynthesisResult, WordTiming } from '~/lib/providers/types';

function result(bytes = 8, overrides: Partial<SynthesisResult> = {}): SynthesisResult {
  return {
    audio: new ArrayBuffer(bytes),
    mime: 'audio/mpeg',
    durationMs: 1000,
    ...overrides,
  };
}

const TIMINGS: WordTiming[] = [{ charStart: 0, charEnd: 5, startMs: 0, endMs: 400 }];

const DASHSCOPE: ProviderConfig = {
  provider: 'dashscope',
  apiKey: 'secret-one',
  model: 'cosyvoice-v3',
  region: 'cn-beijing',
};

/** A fresh in-memory database per test, so nothing leaks between them. */
function memoryFactory(): IDBFactory {
  return new IDBFactory();
}

/**
 * An `indexedDB.open()` that fails the way a real one does.
 *
 * A browser can refuse the store — a full disk, a private window, another
 * document holding an upgrade open — and the cache has to report it rather
 * than hang.
 */
function failingFactory(mode: 'error' | 'blocked'): IDBFactory {
  const request = {
    error: mode === 'error' ? new Error('the disk is full') : null,
    onsuccess: null as (() => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onblocked: null as ((event: Event) => void) | null,
    onupgradeneeded: null as (() => void) | null,
  };

  return {
    open: () => {
      // The caller attaches its handlers synchronously after this returns.
      setTimeout(() => {
        if (mode === 'error') request.onerror?.(new Event('error'));
        else request.onblocked?.(new Event('blocked'));
      }, 0);
      return request;
    },
  } as unknown as IDBFactory;
}

/**
 * Write a record around the cache's API.
 *
 * A half-migrated database, or one written by an older version, is the only
 * way to reach the read-side validation.
 */
async function writeRaw(
  factory: IDBFactory,
  dbName: string,
  record: Record<string, unknown>
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(dbName, 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore('audio', { keyPath: 'key' });
      store.createIndex('timestamp', 'timestamp');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('L1Cache', () => {
  it('returns what it stored', () => {
    const cache = new L1Cache(1024);
    const stored = result();
    cache.put('a', stored);

    expect(cache.get('a')).toBe(stored);
    expect(cache.size).toBe(8);
    expect(cache.count).toBe(1);
  });

  it('misses on an unknown key', () => {
    expect(new L1Cache(1024).get('nope')).toBeUndefined();
  });

  it('evicts the least recently used entry', () => {
    const cache = new L1Cache(10);
    cache.put('a', result(4));
    cache.put('b', result(4));
    cache.put('c', result(4));

    expect(cache.count).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('keeps a read entry alive', () => {
    const cache = new L1Cache(10);
    cache.put('a', result(4));
    cache.put('b', result(4));
    cache.get('a');
    cache.put('c', result(4));

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('does not double count a key that is replaced', () => {
    const cache = new L1Cache(1024);
    cache.put('a', result(4));
    cache.put('a', result(4));

    expect(cache.count).toBe(1);
    expect(cache.size).toBe(4);
  });

  it('refuses an entry that could never fit', () => {
    const cache = new L1Cache(10);
    cache.put('big', result(64));

    expect(cache.get('big')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('empties on clear', () => {
    const cache = new L1Cache(1024);
    cache.put('a', result());
    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe('L2Cache', () => {
  let cache: L2Cache;

  beforeEach(() => {
    cache = new L2Cache({ factory: memoryFactory(), dbName: 'test-cache' });
  });

  it('round-trips audio, mime and timings', async () => {
    await cache.put('a', result(16, { durationMs: 1234, timings: TIMINGS }));
    const stored = await cache.get('a');

    expect(stored?.mime).toBe('audio/mpeg');
    expect(stored?.durationMs).toBe(1234);
    expect(stored?.audio.byteLength).toBe(16);
    expect(stored?.timings).toEqual(TIMINGS);
  });

  it('omits timings when the provider reported none', async () => {
    await cache.put('a', result());
    expect((await cache.get('a'))?.timings).toBeUndefined();
  });

  it('misses on an unknown key', async () => {
    expect(await cache.get('nope')).toBeUndefined();
  });

  it('counts what it holds', async () => {
    await cache.put('a', result(8));
    await cache.put('b', result(8));

    expect(cache.size).toBe(16);
    expect(cache.entryCount).toBe(2);
  });

  it('does not double count a key that is replaced', async () => {
    await cache.put('a', result(8));
    await cache.put('a', result(8));

    expect(cache.size).toBe(8);
    expect(cache.entryCount).toBe(1);
  });

  it('measures an existing database when it opens', async () => {
    const factory = memoryFactory();
    const first = new L2Cache({ factory, dbName: 'test-cache' });
    await first.put('a', result(8));
    first.close();

    const second = new L2Cache({ factory, dbName: 'test-cache' });
    await second.init();

    expect(second.size).toBe(8);
    expect(second.entryCount).toBe(1);
    expect((await second.get('a'))?.audio.byteLength).toBe(8);
  });

  it('empties on clear', async () => {
    await cache.put('a', result(8));
    await cache.clear();

    expect(await cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.entryCount).toBe(0);
  });

  it('drops malformed records instead of failing', async () => {
    const factory = memoryFactory();
    const raw = new L2Cache({ factory, dbName: 'test-cache' });
    await raw.init();
    await writeRaw(factory, 'test-cache', { key: 'bad', audio: 'not audio', mime: 'audio/mpeg' });

    expect(await raw.get('bad')).toBeUndefined();
  });

  it('keeps well-formed timings and drops the rest', async () => {
    const factory = memoryFactory();
    const raw = new L2Cache({ factory, dbName: 'test-cache' });
    await raw.init();
    await writeRaw(factory, 'test-cache', {
      key: 'mixed',
      audio: new ArrayBuffer(4),
      mime: 'audio/mpeg',
      durationMs: 10,
      timings: [
        TIMINGS[0],
        { charStart: 'x', charEnd: 1, startMs: 0, endMs: 1 },
        null,
        { charStart: 1, charEnd: 2, startMs: Number.NaN, endMs: 3 },
      ],
    });

    expect((await raw.get('mixed'))?.timings).toEqual(TIMINGS);
  });

  it('counts a stored record it cannot measure as zero bytes', async () => {
    const factory = memoryFactory();
    await writeRaw(factory, 'test-cache', { key: 'bad', audio: 'not audio' });

    const cache = new L2Cache({ factory, dbName: 'test-cache' });
    await cache.init();

    expect(cache.entryCount).toBe(1);
    expect(cache.size).toBe(0);
  });

  it('opens the database only once for two concurrent callers', async () => {
    const factory = memoryFactory();
    const open = vi.spyOn(factory, 'open');
    const cache = new L2Cache({ factory, dbName: 'test-cache' });

    await Promise.all([cache.init(), cache.init(), cache.put('a', result(8))]);

    expect(open).toHaveBeenCalledTimes(1);
    expect((await cache.get('a'))?.audio.byteLength).toBe(8);
  });

  it('reports a database that cannot be opened', async () => {
    const cache = new L2Cache({ factory: failingFactory('error'), dbName: 'test-cache' });

    await expect(cache.init()).rejects.toThrow('the disk is full');
  });

  it('reports a database another document is holding open', async () => {
    const cache = new L2Cache({ factory: failingFactory('blocked'), dbName: 'test-cache' });

    await expect(cache.init()).rejects.toThrow('blocked by another open document');
  });

  it('prunes the oldest entries when it runs out of budget', async () => {
    const clock = { now: 1_000 };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const small = new L2Cache({ factory: memoryFactory(), dbName: 'test-cache', maxBytes: 10 });

    await small.put('a', result(6));
    clock.now += 1_000;
    await small.put('b', result(6));

    expect(await small.get('a')).toBeUndefined();
    expect(await small.get('b')).toBeDefined();
    expect(small.size).toBe(6);
    expect(small.entryCount).toBe(1);
  });
});

describe('CacheManager.computeKey', () => {
  let cache: CacheManager;

  beforeEach(() => {
    cache = new CacheManager({ factory: memoryFactory(), dbName: 'test-cache' });
  });

  it('is stable for the same text, voice and config', async () => {
    const first = await cache.computeKey({ text: 'hi', voiceId: 'v', config: DASHSCOPE });
    const second = await cache.computeKey({ text: 'hi', voiceId: 'v', config: DASHSCOPE });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores credentials, which do not change the audio', async () => {
    const first = await cache.computeKey({ text: 'hi', voiceId: 'v', config: DASHSCOPE });
    const second = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: { ...DASHSCOPE, apiKey: 'another-secret' },
    });

    expect(first).toBe(second);
  });

  it.each([
    ['the text', { text: 'different' }],
    ['the voice', { voiceId: 'other' }],
  ])('changes when %s changes', async (_label, change) => {
    const base = await cache.computeKey({ text: 'hi', voiceId: 'v', config: DASHSCOPE });
    const other = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: DASHSCOPE,
      ...change,
    });

    expect(other).not.toBe(base);
  });

  it('changes when the model changes', async () => {
    const base = await cache.computeKey({ text: 'hi', voiceId: 'v', config: DASHSCOPE });
    const other = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: { ...DASHSCOPE, model: 'qwen-tts' },
    });

    expect(other).not.toBe(base);
  });

  it('does not care about the order of voice settings', async () => {
    const eleven = (settings: Record<string, unknown>): ProviderConfig => ({
      provider: 'elevenlabs',
      apiKey: 'k',
      voiceSettings: settings,
    });

    const first = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: eleven({ stability: 0.5, similarity: 0.75 }),
    });
    const second = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: eleven({ similarity: 0.75, stability: 0.5 }),
    });

    expect(first).toBe(second);
  });

  it('separates two self-hosted servers', async () => {
    const server = (baseUrl: string): ProviderConfig => ({ provider: 'openai-compat', baseUrl });

    const first = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: server('http://a/v1'),
    });
    const second = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: server('http://b/v1'),
    });

    expect(first).not.toBe(second);
  });

  it('separates two providers configured the same way', async () => {
    const browser = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: { provider: 'browser', lang: 'en-US' },
    });
    const dashscope = await cache.computeKey({ text: 'hi', voiceId: 'v', config: DASHSCOPE });

    expect(browser).not.toBe(dashscope);
  });

  it('separates two Volcengine resources', async () => {
    const volc = (resourceId: string): ProviderConfig => ({
      provider: 'volcengine',
      appId: 'a',
      accessToken: 't',
      resourceId,
    });

    const first = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: volc('volc.service_type.10029'),
    });
    const second = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: volc('volc.service_type.10048'),
    });

    expect(first).not.toBe(second);
  });

  it('separates two Azure output formats', async () => {
    const azure = (outputFormat: string): ProviderConfig => ({
      provider: 'azure',
      subscriptionKey: 'k',
      region: 'eastasia',
      outputFormat,
    });

    const first = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: azure('audio-24khz-48kbitrate-mono-mp3'),
    });
    const second = await cache.computeKey({
      text: 'hi',
      voiceId: 'v',
      config: azure('audio-16khz-32kbitrate-mono-mp3'),
    });

    expect(first).not.toBe(second);
  });

  it('ignores an Azure region, which does not change the audio', async () => {
    const azure = (region: string): ProviderConfig => ({
      provider: 'azure',
      subscriptionKey: 'k',
      region,
    });

    const first = await cache.computeKey({ text: 'hi', voiceId: 'v', config: azure('eastasia') });
    const second = await cache.computeKey({ text: 'hi', voiceId: 'v', config: azure('westus') });

    expect(first).toBe(second);
  });
});

describe('CacheManager', () => {
  let cache: CacheManager;

  beforeEach(() => {
    cache = new CacheManager({ factory: memoryFactory(), dbName: 'test-cache' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the database through the manager', async () => {
    const cache = new CacheManager({ factory: memoryFactory(), dbName: 'test-cache' });

    await cache.init();
    await cache.putL2('a', result(8));

    expect(cache.stats()).toEqual({ l1Bytes: 0, l2Bytes: 8, l2Entries: 1 });
  });

  it('promotes an L2 hit into L1', async () => {
    await cache.putL2('a', result(8));

    const found = await cache.get('a');

    expect(found?.audio.byteLength).toBe(8);
    expect(cache.getL1('a')).toBe(found);
    expect(cache.stats()).toEqual({ l1Bytes: 8, l2Bytes: 8, l2Entries: 1 });
  });

  it('prefers L1 over L2', async () => {
    const memoryOnly = result(4);
    cache.putL1('a', memoryOnly);

    expect(await cache.get('a')).toBe(memoryOnly);
  });

  it('writes both layers on put', async () => {
    const stored = result(8);
    await cache.put('a', stored);

    expect(cache.getL1('a')).toBe(stored);
    expect(await cache.getL2('a')).toBeDefined();
  });

  it('misses when neither layer has the key', async () => {
    expect(await cache.get('nope')).toBeUndefined();
  });

  it('clears one layer at a time', async () => {
    await cache.put('a', result(8));

    cache.clearL1();
    expect(cache.getL1('a')).toBeUndefined();
    expect(await cache.getL2('a')).toBeDefined();

    await cache.clearL2();
    expect(await cache.getL2('a')).toBeUndefined();
    expect(cache.stats()).toEqual({ l1Bytes: 0, l2Bytes: 0, l2Entries: 0 });
  });
});
