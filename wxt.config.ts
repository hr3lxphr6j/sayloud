import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

/**
 * Host access granted to the e2e build only.
 *
 * Returns a fresh array every time on purpose. WXT keeps the array by reference
 * when it builds the manifest and then pushes the content script's matches into
 * it, so a shared constant would silently gain `<all_urls>` and defeat the
 * filter in the `build:manifestGenerated` hook below.
 */
function e2eHostPermissions(): string[] {
  return ['http://127.0.0.1/*'];
}

export default defineConfig({
  vite: () => ({ plugins: [preact()] }),
  manifest: ({ mode }) => ({
    name: 'SayLoud',
    version: '0.1.0',
    // The reader is injected into the clicked tab under `activeTab`, so the
    // extension asks for no standing access to any site. `offscreen` is what
    // lets the service worker own an audio document, which is the only place
    // cloud audio can be decoded and played.
    permissions: ['activeTab', 'scripting', 'storage', 'tts', 'offscreen'],
    action: {},
    ...(mode === 'e2e' && { host_permissions: e2eHostPermissions() }),
  }),
  outDir: process.env.SAYLOUD_E2E ? '.output-e2e' : '.output',
  // WXT's default template appends the mode, which would put the e2e build in
  // `.output-e2e/chrome-mv3-e2e`. The e2e build already has its own outDir, so
  // drop the suffix and give the Playwright fixtures a stable path.
  ...(process.env.SAYLOUD_E2E && { outDirTemplate: '{{browser}}-mv{{manifestVersion}}' }),

  hooks: {
    /**
     * Drop the host permission WXT derives from the reader's `matches`.
     *
     * WXT adds a runtime-registered content script's `matches` to
     * `host_permissions`, because `scripting.registerContentScripts` needs them.
     * SayLoud never calls that API: the reader is injected with
     * `scripting.executeScript`, which `activeTab` already covers for the tab
     * the reader clicked. Shipping `<all_urls>` would ask every user for access
     * to every site on install, for no benefit.
     *
     * Only `<all_urls>` is removed, because the same mechanism also adds the
     * dev server's permission in `wxt dev` and the e2e build's 127.0.0.1 grant,
     * and both of those are wanted.
     */
    'build:manifestGenerated': (_wxt, manifest) => {
      const remaining = (manifest.host_permissions ?? []).filter(
        (pattern: string) => pattern !== '<all_urls>'
      );
      if (remaining.length > 0) manifest.host_permissions = remaining;
      else delete manifest.host_permissions;
    },
  },
});
