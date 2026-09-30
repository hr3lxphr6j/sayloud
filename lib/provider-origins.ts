/**
 * Host access a provider configuration needs before its requests can succeed.
 *
 * SayLoud ships with no `host_permissions`; `optional_host_permissions` only
 * declares what may be asked for. Most services answer the extension's CORS
 * preflight on their own and need nothing (spec V5: DashScope echoes the
 * `chrome-extension://` origin; V7: Kokoro sends `*`; Azure speaks over a
 * WebSocket, which has no preflight). Volcengine does not: its preflight
 * allows any origin but leaves `X-Api-Key` out of `Access-Control-Allow-Headers`
 * (spec A.4), and only a granted host permission lets the extension skip CORS.
 *
 * The request names the exact origin from the configuration, so the prompt
 * shows one host rather than "all sites".
 */
import type { ProviderConfig } from './providers/types';
import { DEFAULT_BASE_URL as VOLCENGINE_BASE_URL } from './providers/volcengine';

/** The slice of `chrome.permissions` this module needs. */
export interface PermissionsApi {
  request(permissions: { origins: string[] }): Promise<boolean>;
}

/** Match patterns for the hosts `config` talks to that need a grant. */
export function requiredOrigins(config: ProviderConfig): string[] {
  switch (config.provider) {
    case 'volcengine':
      return [originPattern(config.baseUrl || VOLCENGINE_BASE_URL)];
    default:
      return [];
  }
}

/**
 * Ask for the host access `config` needs.
 *
 * Must be called from a click handler before anything is awaited:
 * `permissions.request` needs the click's user gesture, which the first
 * `await` gives up. Resolves true when nothing is needed or the user granted
 * it, false when the user declined.
 */
export function requestProviderAccess(
  config: ProviderConfig,
  permissions: PermissionsApi | undefined
): Promise<boolean> {
  const origins = requiredOrigins(config);
  if (origins.length === 0) return Promise.resolve(true);
  // A build without the permissions API (tests, a non-Chrome browser) cannot
  // ask; let the request fail on its own with the provider's error.
  if (!permissions) return Promise.resolve(true);
  return permissions.request({ origins });
}

function originPattern(url: string): string {
  return `${new URL(url).origin}/*`;
}
