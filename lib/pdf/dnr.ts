/**
 * The declarativeNetRequest rule that sends PDF navigations to the viewer.
 *
 * A dynamic rule rather than a static ruleset: the redirect target has to name
 * this extension's own origin, and `chrome.runtime.getURL()` is the only way to
 * learn it — the id is not known at build time (it differs between an unpacked
 * install, the store, and every profile of a dev build).
 *
 * The original URL travels in the fragment. A redirect cannot add a query
 * parameter of its own without losing the one it was redirecting, and a
 * fragment is never sent to a server: `regexSubstitution` appends the whole
 * match, and `parseInterceptedUrl` reads it back on the viewer page.
 *
 * Two manifest declarations are what make the rule work at all, and neither is
 * optional:
 *
 *   - redirect rules need host access to the request URL. SayLoud ships with
 *     none, so the settings panel asks for `PDF_INTERCEPT_ORIGINS` when the
 *     user turns the feature on (`optional_host_permissions` is what lets it
 *     ask); a rule without the grant is silently ignored by Chrome.
 *   - a navigation to an extension page requires that page to be web
 *     accessible. `pdf-viewer.html` is declared for exactly this redirect, and
 *     nothing else in the package is — `pdfium.wasm` in particular stays out.
 */

import { type Browser, browser } from 'wxt/browser';

/** Chosen to be recognisable in `chrome://extensions` and unused elsewhere. */
export const PDF_DNR_RULE_ID = 1_001;

/** Where the viewer lives, relative to the extension root. */
export const PDF_VIEWER_PATH = '/pdf-viewer.html';

/**
 * The fragment key a redirected viewer gets: `#url=<the pdf's own url>`.
 *
 * The value is not percent-encoded — DNR has no escape for the matched text —
 * which is why it is parsed by hand rather than through `URLSearchParams`.
 */
export const INTERCEPT_HASH_PREFIX = 'url=';

/** The origins the rule needs access to. Also what the panel asks for. */
export const PDF_INTERCEPT_ORIGINS: readonly string[] = ['http://*/*', 'https://*/*'];

/**
 * What counts as a PDF navigation.
 *
 * `main_frame` only, and only http(s): a `file:` PDF needs file access this
 * extension never asks for, and subresources named `.pdf` are not navigations.
 * The query/hash allowance covers the common `/download?file=a.pdf` form.
 */
export const PDF_URL_PATTERN = '^https?://.*\\.pdf(?:[?#].*)?$';

/**
 * The slice of `declarativeNetRequest` this module uses.
 *
 * Narrow and injectable so the rule can be asserted without a browser, and so
 * the service worker is the only place that has to know the real API.
 */
export interface DynamicRulesApi {
  updateDynamicRules(options: {
    addRules?: Browser.declarativeNetRequest.Rule[];
    removeRuleIds?: number[];
  }): Promise<void>;
}

/** The one rule, built against a concrete viewer URL. */
export function pdfInterceptRule(viewerUrl: string): Browser.declarativeNetRequest.Rule {
  return {
    id: PDF_DNR_RULE_ID,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        // `\0` is the entire match. The viewer reads the raw value back in
        // `parseInterceptedUrl`, so nothing here may percent-encode it.
        regexSubstitution: `${viewerUrl}#${INTERCEPT_HASH_PREFIX}\\0`,
      },
    },
    condition: {
      regexFilter: PDF_URL_PATTERN,
      resourceTypes: ['main_frame'],
      // `.PDF` is a PDF too.
      isUrlFilterCaseSensitive: false,
    },
  };
}

/**
 * Add the rule, replacing any older copy of it.
 *
 * `updateDynamicRules` removes and adds in one call, which is what makes this
 * safe to run on every service-worker start: there is never a moment with two
 * rules for the same navigation.
 */
export async function enablePdfIntercept(
  api: DynamicRulesApi = browser.declarativeNetRequest,
  viewerUrl: string = browser.runtime.getURL(PDF_VIEWER_PATH)
): Promise<void> {
  await api.updateDynamicRules({
    addRules: [pdfInterceptRule(viewerUrl)],
    removeRuleIds: [PDF_DNR_RULE_ID],
  });
}

/** Take the rule away. A rule that was never added is not an error. */
export async function disablePdfIntercept(
  api: DynamicRulesApi = browser.declarativeNetRequest
): Promise<void> {
  await api.updateDynamicRules({
    addRules: [],
    removeRuleIds: [PDF_DNR_RULE_ID],
  });
}

/** Make the installed rule match `enabled`. */
export async function syncPdfIntercept(
  enabled: boolean,
  api: DynamicRulesApi = browser.declarativeNetRequest,
  viewerUrl: string = browser.runtime.getURL(PDF_VIEWER_PATH)
): Promise<void> {
  if (enabled) {
    await enablePdfIntercept(api, viewerUrl);
  } else {
    await disablePdfIntercept(api);
  }
}

/** Whether `hash` declares a redirected document at all, valid or not. */
export function isInterceptHash(hash: string): boolean {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  return fragment.startsWith(INTERCEPT_HASH_PREFIX);
}

/**
 * The document URL a redirect put in the viewer's fragment.
 *
 * Returned verbatim: `URLSearchParams` would decode `%2F` and turn `+` into a
 * space, and the fragment is the only copy of the URL there is. Anything that
 * is not http(s) is refused before the viewer fetches it.
 */
export function parseInterceptedUrl(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment.startsWith(INTERCEPT_HASH_PREFIX)) return null;

  const url = fragment.slice(INTERCEPT_HASH_PREFIX.length);
  if (url.length === 0) return null;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
