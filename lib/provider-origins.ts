/**
 * Host access a provider configuration needs before its requests can succeed.
 *
 * SayLoud ships with no `host_permissions`; `optional_host_permissions` only
 * declares what may be asked for. Most services answer the extension's CORS
 * preflight on their own and need nothing: DashScope echoes the
 * `chrome-extension://` origin, Kokoro sends `*`, and Azure speaks over a
 * WebSocket, which has no preflight. Volcengine does not: its preflight allows
 * any origin but leaves `X-Api-Key` out of `Access-Control-Allow-Headers`, and
 * only a granted host permission lets the extension skip CORS.
 *
 * The manifest declares exactly one optional host — Volcengine's — so that is
 * the only origin Chrome will let the extension ask for. A custom `baseUrl` on
 * another host has to answer the CORS preflight itself, the way every other
 * provider does: requesting an origin the manifest does not declare fails.
 */
import type { ProviderConfig } from './providers/types';
import { DEFAULT_BASE_URL as VOLCENGINE_BASE_URL } from './providers/volcengine';

/**
 * The one origin `optional_host_permissions` declares.
 *
 * Kept next to the request rather than read from the manifest: the manifest is
 * not reachable from here, and the two have to agree — which is why
 * `scripts/check/check-manifest.mjs` asserts the manifest's value.
 */
const DECLARED_ORIGIN = new URL(VOLCENGINE_BASE_URL).origin;

/** The slice of `chrome.permissions` this module needs. */
export interface PermissionsApi {
  request(permissions: { origins: string[] }): Promise<boolean>;
  /**
   * Whether an origin is already granted.
   *
   * Optional because a test double, or a build without the full API, may only
   * have `request`; without it the caller assumes the grant is missing.
   */
  contains?(permissions: { origins: string[] }): Promise<boolean>;
  /**
   * Give a grant back.
   *
   * Optional for the same reason. Used by the PDF interception switch, whose
   * broad host access exists only for that one feature.
   */
  remove?(permissions: { origins: string[] }): Promise<boolean>;
}

/**
 * Match patterns for the hosts `config` talks to that need a grant.
 *
 * Returns nothing for a Volcengine configuration pointed at some other host:
 * Chrome only grants origins the manifest declares, and asking for an
 * undeclared one rejects. Such an endpoint falls back to CORS, which is what
 * every other provider already relies on.
 */
export function requiredOrigins(config: ProviderConfig): string[] {
  if (config.provider !== 'volcengine') return [];
  const origin = new URL(config.baseUrl || VOLCENGINE_BASE_URL).origin;
  return origin === DECLARED_ORIGIN ? [originPattern(origin)] : [];
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

/**
 * Whether the host access `config` needs is there already.
 *
 * The question a save has to ask, as opposed to the prompt `request` raises.
 * `request` without a user gesture does not come back at all — it neither
 * resolves nor rejects — so a save triggered by a blur must check with
 * `contains`, which needs no gesture, and leave the asking to a click.
 *
 * A missing grant is reported as "no access" rather than an error: the caller's
 * way out of it is to offer the button that asks properly.
 */
export async function hasProviderAccess(
  config: ProviderConfig,
  permissions: PermissionsApi | undefined
): Promise<boolean> {
  const origins = requiredOrigins(config);
  if (origins.length === 0) return true;
  if (!permissions?.contains) return false;
  try {
    return await permissions.contains({ origins });
  } catch {
    return false;
  }
}

function originPattern(url: string): string {
  return `${new URL(url).origin}/*`;
}
