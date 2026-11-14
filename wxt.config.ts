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

/*
 * No runtime assets are copied into the package any more.
 *
 * pdf.js needed its worker, cMaps and standard fonts copied and declared
 * web-accessible. EmbedPDF's PDFium wasm goes through `?url` (one hashed file
 * in `assets/`, see `lib/pdf/embed/document.ts`), and the viewer is an
 * extension page rather than a content script, so nothing has to be readable
 * from a web page.
 */

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
    version: '0.6.2',
    description:
      'Read web pages aloud with sentence highlighting, browser voices, on-device models, or your own cloud TTS service.',
    homepage_url: 'https://github.com/hr3lxphr6j/sayloud',
    // `sidePanel` needs Chrome 114, `offscreen` 109, and the caption window
    // 116. Declaring 116 keeps the store from installing it on a browser where
    // one of the three is silently missing.
    minimum_chrome_version: '116',
    // The reader is injected into the clicked tab under `activeTab`, so the
    // extension asks for no standing access to any site. `offscreen` is what
    // lets the service worker own an audio document, which is the only place
    // cloud audio can be decoded and played.
    // `declarativeNetRequest` lets the worker install the PDF redirect rule.
    // The permission itself grants no access to any site; redirect rules also
    // need host access, which is optional below and asked for by the settings
    // toggle that turns the rule on.
    permissions: ['activeTab', 'scripting', 'storage', 'tts', 'offscreen', 'declarativeNetRequest'],
    // Only the viewer's HTML shell, and only because the DNR redirect lands
    // there: a navigation from a web page cannot reach an extension page that
    // is not declared here. Scripts, the PDFium worker and `pdfium.wasm` are
    // loaded by the page itself and stay unreachable from the web — the wasm
    // in particular is 4.4 MB no site has a reason to read.
    web_accessible_resources: [
      {
        resources: ['pdf-viewer.html'],
        matches: ['http://*/*', 'https://*/*'],
      },
    ],
    // Declared, never granted on install. Volcengine is the one service whose
    // CORS preflight rejects the extension (its `X-Api-Key` header is missing
    // from `Access-Control-Allow-Headers`), so it is the only host a provider
    // needs. Every other provider answers the preflight itself, and a custom
    // Volcengine `baseUrl` on another host has to answer it too (see
    // provider-origins.ts). The http(s) patterns belong to the PDF interception
    // toggle: it asks for them when switched on, and drops them when switched
    // off, so a user who never wants PDFs redirected is never asked.
    optional_host_permissions: ['https://openspeech.bytedance.com/*', 'http://*/*', 'https://*/*'],
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
    // EmbedPDF POC finding (2026-11-14): do **not** add `worker-src 'self' blob:`
    // here. MV3 rejects `blob:` as a script/worker source in
    // `extension_pages`, and an invalid CSP makes Chrome refuse to load the
    // whole extension — silently, with no manifest warning in the browser log.
    // The EmbedPDF worker engine therefore has to be tested against this CSP
    // as-is, and falls back to `pdfium-direct-engine` if blob workers are
    // blocked at runtime (measured during the EmbedPDF POC).
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
     * Put the pdf.js runtime files into the package.
     *
     * The target comes from `wxt.config.outDir`, not a literal path: it is
     * `.output/chrome-mv3` for a build, `.output-e2e/chrome-mv3` for the e2e
     * build (config above) and `.output/chrome-mv3-dev` under `pnpm dev`.
     *
     * The other outputs are refreshed only when they already exist: a dev
     * session or an e2e run started after `pnpm build` reuses that bundle, and
     * a bundle without the assets fails at document-open time rather than at
     * build time.
     */
    /**
     * Drop the host permission WXT derives from the reader's `matches`.
     *
     * WXT adds a runtime-registered content script's `matches` to
     * `host_permissions`, because `scripting.registerContentScripts` needs them.
     * SayLoud never calls that API: the reader is injected with
     * `scripting.executeScript`, which `activeTab` already covers for the tab
     * the reader clicked. Shipping `<all_urls>` would ask every user for access
     * to every site on install, for no benefit. PDF interception asks for the
     * http(s) hosts at runtime instead, and only when its toggle is on.
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
