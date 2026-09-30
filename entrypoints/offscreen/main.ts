/**
 * The offscreen document: the extension's audio engine (spec §3.1).
 *
 * Chrome gives a service worker no way to decode or play audio, and gives a
 * content script no way to reach a TTS API without the page's CSP applying to
 * it. An offscreen document has both, so every cloud byte is fetched and played
 * here.
 *
 * It holds no state worth keeping. The service worker owns the session; this
 * only answers commands, and if Chrome reclaims the document the worker is
 * rebuilt on the next command and the cache in IndexedDB is still there.
 */
import { browser } from 'wxt/browser';
import { AudioWorker } from '~/lib/audio-worker';
import { CacheManager } from '~/lib/cache-manager';
import { CachePolicy, pullCachePolicy } from '~/lib/cache-policy';
import {
  isCacheCleared,
  isCachePolicyMessage,
  isOffscreenCommand,
  type OffscreenEvent,
} from '~/lib/offscreen-protocol';
import { createProviders } from '~/lib/providers/registry';
import type { Provider, ProviderId } from '~/lib/providers/types';
import { TimelinePlayer } from '~/lib/timeline-player';

/** Report an event to the service worker, which is the only consumer. */
function emit(event: OffscreenEvent): void {
  void browser.runtime.sendMessage(event).catch((error: unknown) => {
    // A worker that is asleep, or gone, is not a failure: the engine that asked
    // for this audio no longer exists either.
    console.warn('[SayLoud] the audio event could not be delivered', error);
  });
}

/** Every cloud adapter, keyed the way a config names its provider. */
function providerMap(): Map<ProviderId, Provider> {
  const providers = new Map<ProviderId, Provider>();
  for (const [id, provider] of Object.entries(createProviders())) {
    providers.set(id as ProviderId, provider);
  }
  return providers;
}

const cache = new CacheManager();
const player = new TimelinePlayer({ emit });
const worker = new AudioWorker({ providers: providerMap(), cache, player, emit });
const policy = new CachePolicy(cache);

// Open the database before the first sentence needs it, so the first synthesis
// does not wait on an upgrade. A failure only costs the cache, never playback.
void cache.init().catch((error: unknown) => {
  console.warn('[SayLoud] the audio cache is unavailable', error);
});

// Chrome gives an offscreen document `runtime` and not much else — no
// `storage` — so the cache policy is asked for rather than read. Asking at
// startup is also what survives this document: Chrome closes it after ~30
// seconds without audio, and the next one asks again before it synthesizes.
void pullCachePolicy(browser.runtime, policy).catch((error: unknown) => {
  console.warn('[SayLoud] cannot apply the saved cache settings', error);
});

browser.runtime.onMessage.addListener((message: unknown) => {
  // Both of these come from the extension rather than from the executor's
  // state machine, so they are answered before the command filter — which
  // would reject them as unknown types.
  if (isCachePolicyMessage(message)) {
    void policy.apply(message.cache).catch((error: unknown) => {
      console.warn('[SayLoud] cannot apply the cache settings', error);
    });
    return undefined;
  }

  if (isCacheCleared(message)) {
    void policy.onCleared().catch((error: unknown) => {
      console.warn('[SayLoud] cannot drop the cleared audio cache', error);
    });
    return undefined;
  }

  // The runtime is not a trusted channel: anything in the extension can post to
  // it, so a message that is not a command is ignored rather than acted on.
  if (!isOffscreenCommand(message)) return undefined;
  return worker.handleCommand(message);
});
