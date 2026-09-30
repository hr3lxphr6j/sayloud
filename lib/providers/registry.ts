/**
 * The provider adapters, built once for the settings panel.
 *
 * Instantiated here rather than inside the panel so there is a single place to
 * see everything the extension can talk to. `AzureProvider` is the only cloud
 * one with a dependency, and its default loader reaches the Speech SDK through
 * a dynamic `import()`, so building this registry does not pull ~400KB of SDK
 * into the side panel's bundle — it loads only when Azure actually synthesizes.
 *
 * `LocalProvider` is the one adapter whose collaborators are *not* defaulted:
 * its engine has to be supplied by the offscreen document, because the chunk
 * behind it carries ONNX Runtime. The side panel builds this same registry to
 * render the settings form, and a default that could reach the worker would put
 * 21 MB of runtime one call away from a page that only draws a form.
 */
import { AzureProvider } from './azure';
import { DashscopeProvider } from './dashscope';
import { ElevenLabsProvider } from './elevenlabs';
import { LocalProvider } from './local';
import { OpenAiCompatProvider } from './openai-compat';
import type { Provider, ProviderId } from './types';
import { VolcengineProvider } from './volcengine';

/**
 * Providers that talk to a remote service.
 *
 * The browser voice is absent because it has no credentials to check and no
 * catalogue to fetch, and the local provider is absent because "cloud" is not
 * what it is — it shares the `Provider` interface, not the transport.
 */
export type CloudProviderId = Exclude<ProviderId, 'browser' | 'local'>;

/**
 * Providers with an adapter at all.
 *
 * The browser voice is the only member of `ProviderId` without one: it has no
 * credentials to check and no catalogue to fetch, so the panel renders a static
 * notice for it instead of a form.
 */
export type AdapterProviderId = Exclude<ProviderId, 'browser'>;

/** One adapter per provider, plus any caller-supplied override. */
export function createProviders(
  overrides: Partial<Record<AdapterProviderId, Provider>> = {}
): Record<AdapterProviderId, Provider> {
  return {
    dashscope: new DashscopeProvider(),
    volcengine: new VolcengineProvider(),
    'openai-compat': new OpenAiCompatProvider(),
    elevenlabs: new ElevenLabsProvider(),
    azure: new AzureProvider(),
    local: overrides.local ?? new LocalProvider(),
  };
}
