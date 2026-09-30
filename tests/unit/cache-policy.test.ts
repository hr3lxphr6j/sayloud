import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheManager, L2Cache } from '~/lib/cache-manager';
import {
  CachePolicy,
  cachePolicyChanged,
  cachePolicyMessage,
  pullCachePolicy,
  pushCachePolicy,
} from '~/lib/cache-policy';
import { CACHE_POLICY_REQUEST } from '~/lib/offscreen-protocol';
import type { SynthesisResult } from '~/lib/providers/types';
import { DEFAULT_SETTINGS, type Settings } from '~/lib/settings-store';

const DB_NAME = 'test-cache';

function result(bytes = 8): SynthesisResult {
  return { audio: new ArrayBuffer(bytes), mime: 'audio/mpeg', durationMs: 1000 };
}

function settings(cache: Partial<Settings['cache']> = {}, rest: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...rest, cache: { ...DEFAULT_SETTINGS.cache, ...cache } };
}

/** A cache over a factory the test keeps a handle on, to be a second context. */
function memoryCache(maxBytes?: number) {
  const factory = new IDBFactory();
  return { factory, cache: new CacheManager({ factory, dbName: DB_NAME, maxBytes }) };
}

describe('CachePolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('empties the store when the policy says not to persist', async () => {
    const { cache } = memoryCache(100);
    const policy = new CachePolicy(cache);
    await policy.apply(settings().cache);
    await cache.put('a', result(8));

    await policy.apply(settings({ persist: false }).cache);

    expect(cache.getL1('a')).toBeDefined();
    expect(await cache.usage()).toEqual({ bytes: 0, entries: 0 });
  });

  it('applies the budget it is given', async () => {
    const { cache } = memoryCache(100);
    const policy = new CachePolicy(cache);

    await policy.apply(settings({ maxBytes: 8 }).cache);
    await cache.put('a', result(8));
    await cache.put('b', result(8));

    expect(await cache.usage()).toEqual({ bytes: 8, entries: 1 });
  });

  it('drops the memory layer and re-measures when the store is cleared', async () => {
    const { factory, cache } = memoryCache(100);
    const policy = new CachePolicy(cache);
    await policy.apply(settings().cache);
    await cache.put('a', result(8));
    expect(cache.stats().l1Bytes).toBe(8);

    // The settings panel clears through its own connection, so this document's
    // counters still describe a store that is already gone.
    const panel = new L2Cache({ factory, dbName: DB_NAME });
    await panel.clear();
    panel.close();

    await policy.onCleared();

    expect(cache.getL1('a')).toBeUndefined();
    expect(cache.stats()).toEqual({ l1Bytes: 0, l2Bytes: 0, l2Entries: 0 });
  });
});

describe('cachePolicyMessage', () => {
  it('carries the cache policy the offscreen document needs', () => {
    expect(cachePolicyMessage(settings({ persist: false, maxBytes: 50 }).cache)).toEqual({
      type: 'cache-policy',
      cache: { persist: false, maxBytes: 50 },
    });
  });
});

describe('cachePolicyChanged', () => {
  it('is false for a change the cache does not care about', () => {
    expect(cachePolicyChanged(settings(), settings({}, { volume: 1.5, rate: 2 }))).toBe(false);
  });

  it.each([
    ['persistence', settings({ persist: false })],
    ['the budget', settings({ maxBytes: 50 * 1024 * 1024 })],
  ])('is true when %s changes', (_label, next) => {
    expect(cachePolicyChanged(settings(), next)).toBe(true);
  });
});

describe('pushCachePolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the policy to a live document', async () => {
    const sent: unknown[] = [];
    const runtime = {
      sendMessage: async (message: unknown) => {
        sent.push(message);
      },
    };

    await pushCachePolicy(runtime, settings({ maxBytes: 8 }).cache);

    expect(sent).toEqual([{ type: 'cache-policy', cache: { persist: true, maxBytes: 8 } }]);
  });

  it('treats a document that is not running as success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = {
      sendMessage: async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    };

    await expect(pushCachePolicy(runtime, settings().cache)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a failure for another reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = {
      sendMessage: async () => {
        throw new Error('the extension context was reloaded');
      },
    };

    await expect(pushCachePolicy(runtime, settings().cache)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('pullCachePolicy', () => {
  it('asks the service worker for the policy and applies it', async () => {
    const { cache } = memoryCache(100);
    const policy = new CachePolicy(cache);
    const sent: unknown[] = [];
    const runtime = {
      sendMessage: async (message: unknown) => {
        sent.push(message);
        return { type: 'cache-policy', cache: { persist: true, maxBytes: 8 } };
      },
    };

    await pullCachePolicy(runtime, policy);
    await cache.put('a', result(8));
    await cache.put('b', result(8));

    expect(sent).toEqual([CACHE_POLICY_REQUEST]);
    expect(await cache.usage()).toEqual({ bytes: 8, entries: 1 });
  });

  it('ignores a reply that is not a policy', async () => {
    const { cache } = memoryCache(100);
    const policy = new CachePolicy(cache);
    await cache.put('a', result(8));

    // The reply crosses a context boundary, so a malformed one must leave the
    // cache as it was rather than being applied.
    const runtime = { sendMessage: async () => ({ type: 'cache-policy', cache: 'nonsense' }) };
    await pullCachePolicy(runtime, policy);

    expect(await cache.usage()).toEqual({ bytes: 8, entries: 1 });
  });

  it('reports a request that could not be answered', async () => {
    const { cache } = memoryCache(100);
    const policy = new CachePolicy(cache);
    const runtime = {
      sendMessage: async () => {
        throw new Error('storage is gone');
      },
    };

    await expect(pullCachePolicy(runtime, policy)).rejects.toThrow('storage is gone');
  });
});
