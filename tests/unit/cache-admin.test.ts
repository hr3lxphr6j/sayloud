import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCache, readCacheUsage } from '~/lib/cache-admin';
import { L2Cache, type L2CacheOptions } from '~/lib/cache-manager';
import { CACHE_CLEARED } from '~/lib/offscreen-protocol';
import type { SynthesisResult } from '~/lib/providers/types';

const DB_NAME = 'test-cache';

function options(factory: IDBFactory): L2CacheOptions {
  return { factory, dbName: DB_NAME };
}

function result(bytes = 8): SynthesisResult {
  return { audio: new ArrayBuffer(bytes), mime: 'audio/mpeg', durationMs: 1000 };
}

/** A runtime that records what the panel broadcast. */
function fakeRuntime(send: (message: unknown) => Promise<unknown> = async () => undefined) {
  const sent: unknown[] = [];
  return {
    sent,
    runtime: {
      async sendMessage(message: unknown) {
        sent.push(message);
        return send(message);
      },
    },
  };
}

describe('readCacheUsage', () => {
  it('measures a store this context did not write', async () => {
    const factory = new IDBFactory();
    const offscreen = new L2Cache(options(factory));
    await offscreen.put('a', result(8));
    await offscreen.put('b', result(16));
    offscreen.close();

    expect(await readCacheUsage(options(factory))).toEqual({ bytes: 24, entries: 2 });
  });

  it('reports a store that is not there yet', async () => {
    expect(await readCacheUsage(options(new IDBFactory()))).toEqual({ bytes: 0, entries: 0 });
  });

  it('reuses the measurement init() took instead of scanning the store again', async () => {
    const factory = new IDBFactory();
    const offscreen = new L2Cache(options(factory));
    await offscreen.put('a', result(8));
    offscreen.close();

    // A second pass over every record is what makes the settings panel slow on
    // a full cache, so this pins the cheap path rather than the number alone.
    const usage = vi.spyOn(L2Cache.prototype, 'usage');
    expect(await readCacheUsage(options(factory))).toEqual({ bytes: 8, entries: 1 });
    expect(usage).not.toHaveBeenCalled();
  });
});

describe('clearCache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('empties the store before it tells the offscreen document', async () => {
    const factory = new IDBFactory();
    const offscreen = new L2Cache(options(factory));
    await offscreen.put('a', result(8));
    offscreen.close();

    const { runtime, sent } = fakeRuntime(async () => {
      // The document that hears the broadcast re-measures the store, so the
      // message has to arrive after the clear — not before it.
      expect(await readCacheUsage(options(factory))).toEqual({ bytes: 0, entries: 0 });
    });

    await clearCache(runtime, options(factory));

    expect(sent).toEqual([CACHE_CLEARED]);
    expect(await readCacheUsage(options(factory))).toEqual({ bytes: 0, entries: 0 });
  });

  it('treats a document that is not running as success', async () => {
    const factory = new IDBFactory();
    const offscreen = new L2Cache(options(factory));
    await offscreen.put('a', result(8));
    offscreen.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime } = fakeRuntime(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });

    await expect(clearCache(runtime, options(factory))).resolves.toBeUndefined();

    // Nothing to tell: the document that held the memory layer is gone, and the
    // store it cached is already empty.
    expect(await readCacheUsage(options(factory))).toEqual({ bytes: 0, entries: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a delivery that failed for another reason, having cleared anyway', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime } = fakeRuntime(async () => {
      throw new Error('the extension context was reloaded');
    });

    await expect(clearCache(runtime, options(new IDBFactory()))).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports a store it cannot clear, and broadcasts nothing', async () => {
    const broken = {
      open: () => {
        throw new Error('the disk is gone');
      },
    } as unknown as IDBFactory;
    const { runtime, sent } = fakeRuntime();

    await expect(clearCache(runtime, options(broken))).rejects.toThrow('the disk is gone');
    expect(sent).toEqual([]);
  });
});
