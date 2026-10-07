/**
 * The offscreen document's cache policy, and how it travels.
 *
 * The policy has to be applied where the cache lives — the offscreen document —
 * but that document is not given `chrome.storage`: Chrome exposes `runtime` and
 * `offscreen` to it and nothing else. So the worker answers a request for the
 * policy when a document starts, and sends the policy again whenever it changes,
 * rather than the document reading `storage.local` for itself.
 *
 * Asking is also what makes the policy survive Chrome closing the document after
 * ~30 seconds without audio: the next document asks before its first sentence,
 * instead of depending on a message that was sent while nothing was listening.
 */
import type { CacheManager } from './cache-manager';
import { type RuntimeApi, sendToOffscreen } from './offscreen-manager';
import {
  CACHE_POLICY_REQUEST,
  type CachePolicyMessage,
  isCachePolicyMessage,
} from './offscreen-protocol';
import type { CacheSettings, Settings } from './settings-store';

export class CachePolicy {
  constructor(private readonly cache: CacheManager) {}

  /**
   * Apply a policy.
   *
   * Clearing the store when persistence is turned off is `setPersist`'s doing,
   * so "off" takes effect here even for a document that was already running.
   */
  async apply(cache: CacheSettings): Promise<void> {
    await this.cache.setPersist(cache.persist);
    await this.cache.setMaxBytes(cache.maxBytes);
  }

  /**
   * Another context emptied the store: drop the memory layer too, and let
   * `usage()` re-measure what is left.
   *
   * Both halves matter. Without dropping L1 the sentences just heard would play
   * on after the user cleared the cache, and without the re-measurement this
   * document would keep subtracting from byte counters that describe a store
   * someone else already deleted.
   */
  async onCleared(): Promise<void> {
    this.cache.clearL1();
    await this.cache.usage();
  }
}

/** The policy as the worker sends it. */
export function cachePolicyMessage(cache: CacheSettings): CachePolicyMessage {
  return { type: 'cache-policy', cache: { persist: cache.persist, maxBytes: cache.maxBytes } };
}

/**
 * True when a settings change is one the offscreen document has to hear about.
 *
 * Volume, rate and the rest arrive on the same subscription; passing those on
 * to the offscreen document would be work for nothing.
 */
export function cachePolicyChanged(previous: Settings, next: Settings): boolean {
  return (
    previous.cache.persist !== next.cache.persist || previous.cache.maxBytes !== next.cache.maxBytes
  );
}

/** Send a changed policy to a live document; there may be none. */
export function pushCachePolicy(runtime: RuntimeApi, cache: CacheSettings): Promise<void> {
  return sendToOffscreen(runtime, cachePolicyMessage(cache));
}

/**
 * Ask the worker for the policy and apply it.
 *
 * Rejects when the request itself failed, which the caller reports: a document
 * that could not learn the policy still plays audio, it just uses the defaults.
 */
export async function pullCachePolicy(runtime: RuntimeApi, policy: CachePolicy): Promise<void> {
  const reply = await runtime.sendMessage(CACHE_POLICY_REQUEST);
  if (isCachePolicyMessage(reply)) await policy.apply(reply.cache);
}
