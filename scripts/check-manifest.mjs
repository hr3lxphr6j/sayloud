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

/** What the plan fixes for P1: nothing beyond these four. */
const EXPECTED_PERMISSIONS = ['activeTab', 'scripting', 'storage', 'tts'];

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

if (manifest.content_scripts?.length) {
  problems.push('content_scripts must be empty: the reader is injected at runtime');
}

if (problems.length > 0) {
  console.error(`manifest check failed for ${path}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`manifest check passed for ${path}`);
