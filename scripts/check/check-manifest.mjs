/**
 * Guards the extension's permission surface.
 *
 * WXT adds a runtime-registered content script's `matches` to
 * `host_permissions`, which would quietly hand every user access to every site
 * on install. `wxt.config.ts` strips it again, and this check is what keeps that
 * strip honest: the failure mode is silent, and only shows up as a permission
 * prompt nobody looks at.
 *
 * Run against a built manifest: `pnpm check:manifest [path]`.
 */
import { readFile } from 'node:fs/promises';

/**
 * What the extension is allowed to ask for.
 *
 * `activeTab`, `scripting`, `storage` and `tts` are the reading set: the reader
 * is injected into the clicked tab under `activeTab`, so no standing host access
 * is needed. `sidePanel` is added by WXT because `entrypoints/sidepanel` exists —
 * the manifest's `side_panel.default_path` is inert without it — and it grants
 * nothing beyond showing the panel. `offscreen` covers cloud audio, which is
 * fetched and played in an offscreen document, because a service worker cannot
 * play audio and a content script would be subject to the page's CSP.
 * `declarativeNetRequest` installs the PDF redirect rule; its host access is
 * optional and granted from the settings toggle, never on install.
 */
const EXPECTED_PERMISSIONS = [
  'activeTab',
  'declarativeNetRequest',
  'offscreen',
  'scripting',
  'sidePanel',
  'storage',
  'tts',
];

const path = process.argv[2] ?? '.output/chrome-mv3/manifest.json';

let manifest;
try {
  manifest = JSON.parse(await readFile(path, 'utf8'));
} catch (error) {
  console.error(`cannot read ${path}: ${error.message}`);
  console.error('build the extension first (pnpm build)');
  process.exit(1);
}

const problems = [];

const permissions = [...(manifest.permissions ?? [])].sort();
const expected = [...EXPECTED_PERMISSIONS].sort();
if (JSON.stringify(permissions) !== JSON.stringify(expected)) {
  problems.push(
    `permissions are ${JSON.stringify(permissions)}, expected ${JSON.stringify(expected)}`
  );
}

if (manifest.host_permissions?.length) {
  problems.push(
    `host_permissions must be empty, got ${JSON.stringify(manifest.host_permissions)}. ` +
      'The reader is injected under activeTab, so it needs no standing host access.'
  );
}

// Only declared: granted per host from the settings panel, never on install.
// Volcengine needs a grant for its CORS preflight (see lib/provider-origins.ts),
// and the PDF interception toggle asks for the http(s) patterns when it is
// switched on.
const EXPECTED_OPTIONAL_HOSTS = [
  'http://*/*',
  'https://*/*',
  'https://openspeech.bytedance.com/*',
];
const optionalHosts = [...(manifest.optional_host_permissions ?? [])].sort();
if (JSON.stringify(optionalHosts) !== JSON.stringify(EXPECTED_OPTIONAL_HOSTS)) {
  problems.push(
    `optional_host_permissions are ${JSON.stringify(optionalHosts)}, ` +
      `expected ${JSON.stringify(EXPECTED_OPTIONAL_HOSTS)}`
  );
}

if (manifest.content_scripts?.length) {
  problems.push('content_scripts must be empty: the reader is injected at runtime');
}

// The DNR redirect lands on the viewer, so that page has to be reachable from
// the web. Nothing else may be: the PDFium wasm in particular must not be.
const webAccessible = (manifest.web_accessible_resources ?? []).flatMap(
  (entry) => entry.resources ?? []
);
if (!webAccessible.includes('pdf-viewer.html')) {
  problems.push('web_accessible_resources must declare pdf-viewer.html for the PDF redirect');
}
if (webAccessible.some((resource) => resource.includes('pdfium'))) {
  problems.push(
    `web_accessible_resources must not expose PDFium, got ${JSON.stringify(webAccessible)}`
  );
}

if (problems.length > 0) {
  console.error(`manifest check failed for ${path}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`manifest check passed for ${path}`);
