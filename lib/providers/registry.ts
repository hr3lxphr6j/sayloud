/**
 * The provider adapters, built once for the settings panel.
 *
 * Instantiated here rather than inside the panel so there is a single place to
 * see everything the extension can talk to. `AzureProvider` is the only one
 * with a dependency, and its default loader reaches the Speech SDK through a
 * dynamic `import()`, so building this registry does not pull ~400KB of SDK into
 * the side panel's bundle — it loads only when Azure actually synthesizes.
 */
import { AzureProvider } from './azure';
import { DashscopeProvider } from './dashscope';
import { ElevenLabsProvider } from './elevenlabs';
import { OpenAiCompatProvider } from './openai-compat';
import type { Provider, ProviderId } from './types';
import { VolcengineProvider } from './volcengine';

/**
 * Providers with a network adapter.
 *
 * The browser voice is deliberately absent: it has no credentials to check and
 * no catalogue to fetch, so it needs no `Provider` and the panel renders a
 * static notice for it instead.
 */
export type CloudProviderId = Exclude<ProviderId, 'browser'>;

/** One adapter per cloud provider. */
export function createProviders(): Record<CloudProviderId, Provider> {
  return {
    dashscope: new DashscopeProvider(),
    volcengine: new VolcengineProvider(),
    'openai-compat': new OpenAiCompatProvider(),
    elevenlabs: new ElevenLabsProvider(),
    azure: new AzureProvider(),
  };
}
