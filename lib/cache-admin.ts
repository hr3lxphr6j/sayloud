/**
 * The settings panel's half of the cache (spec §4.3).
 *
 * The panel opens its own connection to the same IndexedDB the offscreen
 * document writes to rather than asking the service worker: showing a number
 * must not have a side effect, and going through the worker would risk waking —
 * or creating — an audio document just to count bytes.
 *
 * Both functions open a connection, do one thing and close it. The panel is not
 * the owner of this store; the offscreen document is, and holding a second
 * connection open for the lifetime of a side panel would make a future version
 * upgrade block on a panel nobody is looking at.
 */
import { L2Cache, type L2CacheOptions } from './cache-manager';
import { type RuntimeApi, sendToOffscreen } from './offscreen-manager';
import { CACHE_CLEARED } from './offscreen-protocol';

export interface CacheUsage {
  bytes: number;
  entries: number;
}

/** What the audio cache holds right now, measured from the store itself. */
export async function readCacheUsage(options: L2CacheOptions = {}): Promise<CacheUsage> {
  const cache = new L2Cache(options);
  try {
    await cache.init();
    return await cache.usage();
  } finally {
    cache.close();
  }
}

/**
 * Empty the audio cache.
 *
 * The clear comes first and the broadcast second, because a live offscreen
 * document re-measures the store when it hears it: it has to measure an empty
 * one. Nothing is broadcast when the clear failed — there is nothing to tell
 * the document, and the caller has to hear about the failure.
 */
export async function clearCache(runtime: RuntimeApi, options: L2CacheOptions = {}): Promise<void> {
  const cache = new L2Cache(options);
  try {
    await cache.clear();
  } finally {
    cache.close();
  }

  // Best effort, and success either way: the memory layer being dropped lives
  // inside a document that may well be gone, and if it is, nothing is left
  // holding what was just cleared.
  await sendToOffscreen(runtime, CACHE_CLEARED);
}
