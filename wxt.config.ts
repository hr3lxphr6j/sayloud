import { fileURLToPath } from 'node:url';
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
  vite: () => ({
    plugins: [preact()],
    resolve: {
      alias: {
        /**
         * Take espeak-ng out of the bundle.
         *
         * `kokoro-js` imports `phonemize` from the `phonemizer` package at
         * module scope, so espeak-ng's wasm is in the import graph from the
         * moment the kokoro worker exists — whether or not `generate()` is ever
         * called — and the bundler follows the import graph rather than the
         * calls. Every language is now rendered from IPA through
         * `generate_from_ids()`, so `generate()` is not called and the 1.3 MB of
         * espeak data is not reachable at runtime; this alias is what makes it
         * not reachable at build time either.
         *
         * Aliasing the *specifier* is the whole mechanism, and it has to be the
         * bare name rather than a path: `kokoro-js` is the one that says
         * `import ... from "phonemizer"`, and `resolve.alias` replaces that
         * source string before resolution. Pointing it at `false` instead would
         * leave the import in place as an empty module and only work for the
         * default export.
         *
         * `phonemizer` is not a direct dependency — it is `kokoro-js`'s, and pnpm
         * keeps it in the store rather than the root — so there is no
         * `package.json` entry to remove and nothing else names it. The stub's own
         * doc comment explains what would break if the call ever came back.
         */
        phonemizer: fileURLToPath(new URL('lib/models/phonemizer-stub.ts', import.meta.url)),
      },
    },
    /**
     * Do **not** add `define: { 'import.meta': '{}' }` here.
     *
     * It looks like a free win: kokoro-js is bundled as `iife`, `import.meta`
     * is not valid there, and the build prints `[EMPTY_IMPORT_META]` saying
     * exactly how to silence it. Doing so breaks the extension in a way that
     * points nowhere near this file.
     *
     * `import.meta.url` is how Rolldown names emitted assets: it rewrites each
     * one into a `{}.ROLLDOWN_FILE_URL_<hash>` placeholder and substitutes the
     * real path in a later pass. A blanket `define` replaces `import.meta`
     * first, so the placeholder survives into the bundle and evaluates to
     * `undefined`. Two things silently lose their URL:
     *
     *   - `new Worker(new URL(…, import.meta.url))` in `models/worker-engine`
     *     — the worker is never created, and every synthesis fails with
     *     "the on-device worker stopped".
     *   - ONNX Runtime's `wasmPaths` (kokoro.worker.ts) — the wasm backend
     *     cannot load even if the worker does start.
     *
     * The warning itself is harmless: nothing here needs `import.meta`, and the
     * empty object is only reached inside kokoro-js's own iife bundle.
     *
     * After a build, no placeholder may survive anywhere in `.output`:
     *   rg 'ROLLDOWN_FILE_URL' .output
     * and the worker URL must be a real path, not `undefined`:
     *   rg -o 'new Worker\(new URL\([^)]*' .output/chrome-mv3/chunks/offscreen-*.js
     */
  }),
  /**
   * Dev mode only, and not cosmetic.
   *
   * WXT builds the dev CSP from `dev.server.origin`, a *separate* option that
   * defaults to `http://localhost:3000` and does not follow the port, while
   * `strictPort: false` (the default) lets the server silently move to the next
   * free port. Two `pnpm dev` instances therefore produced a manifest whose CSP
   * allowed `localhost:3000` while the pages loaded from `localhost:3001`: every
   * script was blocked and the side panel never opened. Pinning both options
   * means a second instance fails loudly instead of overwriting
   * `.output/chrome-mv3-dev` with a broken extension.
   */
  dev: {
    server: {
      port: 3000,
      strictPort: true,
    },
  },
  manifest: ({ mode }) => ({
    name: 'SayLoud',
    version: '0.6.0',
    // The reader is injected into the clicked tab under `activeTab`, so the
    // extension asks for no standing access to any site. `offscreen` is what
    // lets the service worker own an audio document, which is the only place
    // cloud audio can be decoded and played.
    permissions: ['activeTab', 'scripting', 'storage', 'tts', 'offscreen'],
    // Declared, never granted on install. The settings panel asks for the one
    // host a provider needs when it is tested or saved — only services whose
    // CORS preflight rejects the extension need it (see provider-origins.ts).
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {},
    // `wasm-unsafe-eval` is what lets ONNX Runtime compile its wasm module.
    // Measured: without it the wasm backend does not start at all.
    //
    // COOP/COEP are deliberately **not** enabled, which is the larger decision
    // here. Cross-origin isolation would allow a threaded wasm build, but it
    // also changes how every cross-origin request behaves — and the extension
    // talks to six cloud TTS services. Measured (V17): with `numThreads: 1` the
    // wasm backend initialises fine without it, so the global manifest change
    // and the six-provider regression it would require are both avoidable.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
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
