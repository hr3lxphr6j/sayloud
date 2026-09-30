/**
 * What the built extension must and must not contain.
 *
 * These are the assertions the unit suite cannot make, because they are about
 * the *bundle* rather than about any module in it: whether a dependency tree
 * reached a chunk, whether a 21 MB binary was emitted, and whether 28 MB of
 * voice files were swept in as assets. Every one of them fails silently in
 * development — the extension still runs, just heavier or with 21 MB of runtime
 * one import away from a page that only draws a form.
 *
 * Two failures this is here to catch, both of which have real consequences:
 *
 * 1. **ONNX Runtime leaking into the service worker or the side panel.**
 *    `background.js` is 40 kB today; the transformers.js tree is 2.5 MB plus a
 *    21 MB wasm. The side panel is worse: it is a page the user opens, and its
 *    only job is to move bytes into Cache Storage. The guarantee is structural
 *    (the engine is injected, never imported), and this is what keeps it
 *    structural — a stray `import` of `engine.ts`'s value exports would quietly
 *    undo it.
 * 2. **The voice files being bundled.** `kokoro-js`'s npm package carries 28 MB
 *    of `voices/*.bin`. They are fetched at runtime into `kokoro-voices`, and a
 *    bundler that decides they are assets would add them to the package and
 *    make the extension ten times bigger.
 *
 * Run with `pnpm test:build`, which builds first. It is deliberately not part
 * of `pnpm test`: that suite runs without a build, and a test that silently
 * skips when `.output` is absent stops testing anything.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/** What `pnpm build` writes. */
const OUTPUT_DIR = resolve(process.cwd(), '.output/chrome-mv3');

/**
 * Strings that only appear in a bundle carrying ONNX Runtime.
 *
 * Four rather than one so that a single renamed symbol cannot make the check
 * vacuous: `InferenceSession` is the runtime's own entry point,
 * `wasmPaths` is the setting the worker passes to it, and `ort-wasm` is the
 * binary's name.
 */
const ORT_MARKERS = ['onnxruntime', 'InferenceSession', 'wasmPaths', 'ort-wasm'] as const;

/** Measured 24.8 MB: a 21.6 MB wasm, a 2.5 MB worker chunk, and the rest. */
const MIN_BYTES = 24_000_000;
const MAX_BYTES = 26_000_000;

interface BuiltFile {
  /** Path relative to the output directory, POSIX-separated. */
  readonly path: string;
  readonly text: string;
}

function readBuiltFile(path: string): BuiltFile {
  return { path, text: readFileSync(join(OUTPUT_DIR, path), 'utf8') };
}

/** Every file in the output, relative and POSIX-separated. */
function allFiles(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(relative(OUTPUT_DIR, absolute).split(sep).join(posix.sep));
    }
  };

  walk(OUTPUT_DIR);
  return found;
}

/** The output has to exist: `pnpm test:build` builds before it runs. */
if (!existsSync(OUTPUT_DIR)) {
  throw new Error(
    `${OUTPUT_DIR} is missing — run \`pnpm test:build\`, which builds first, rather than \`pnpm test\``
  );
}

const FILES = allFiles();

/**
 * The module a reference names, resolved the way the browser would.
 *
 * Everything Vite emits is either relative to the importing file (`./chunks/…`)
 * or rooted at the extension (`/chunks/…`), so the two cases are all this has
 * to handle. A bare specifier is returned as-is: it cannot be resolved inside
 * the output, and the caller treats "not a built file" as "nothing to follow".
 */
function resolveReference(from: string, reference: string): string | null {
  const path = reference.startsWith('/')
    ? reference.slice(1)
    : posix.normalize(posix.join(posix.dirname(from), reference));

  return FILES.includes(path) ? path : null;
}

/** Every module reference in a chunk: static, re-exported and dynamic. */
function referencesOf(file: BuiltFile): string[] {
  const found: string[] = [];
  // `import"…"` / `import{…}from"…"` / `export…from"…"`, and the two spellings
  // of a dynamic import. Backticks appear because Vite quotes some of them
  // that way after minification.
  const patterns = [
    /(?:^|[^\w$])(?:import|export)\s*(?:[^"'`;]*?\sfrom\s*)?["'`]([^"'`]+)["'`]/g,
    /import\s*\(\s*["'`]([^"'`]+)["'`]/g,
    // Vite emits a worker as `new Worker(new URL("/assets/…", …))`, which is a
    // reference to a file in the bundle like any other.
    /new URL\(\s*["'`]([^"'`]+)["'`]/g,
  ];

  for (const pattern of patterns) {
    for (const match of file.text.matchAll(pattern)) {
      const reference = match[1];
      // Anything else is a bare specifier, which cannot name a file inside the
      // output; the caller resolves it to nothing.
      if (reference?.startsWith('.') === true || reference?.startsWith('/') === true) {
        found.push(reference);
      }
    }
  }

  return found;
}

/**
 * The entry point's file and everything it can reach.
 *
 * Reachability, not adjacency: the assertion is "nothing the side panel can
 * load contains ONNX Runtime", and a chunk two imports deep is loaded just as
 * certainly as one import deep.
 */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const reference of referencesOf(readBuiltFile(current))) {
      const resolved = resolveReference(current, reference);
      if (resolved === null || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }

  return [...seen];
}

/** The files an HTML entry point names: its scripts, preloads and styles. */
function htmlEntry(htmlPath: string): string[] {
  const found: string[] = [];
  for (const match of readBuiltFile(htmlPath).text.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const reference = match[1];
    if (reference === undefined) continue;
    const resolved = resolveReference(htmlPath, reference);
    if (resolved !== null) found.push(resolved);
  }
  return found;
}

/** An HTML entry point plus everything its scripts can reach. */
function entryGraph(htmlPath: string): string[] {
  const all = new Set(htmlEntry(htmlPath));
  for (const script of [...all]) {
    for (const file of reachableFrom(script)) all.add(file);
  }
  return [...all];
}

/**
 * Whether this file's *code* mentions ONNX Runtime.
 *
 * Only JavaScript is scanned. The 21 MB wasm binary contains the strings
 * `onnxruntime` and `InferenceSession` because they are the runtime's own
 * names, and searching binaries for text finds them in every copy of it —
 * which would say nothing about whether a bundle can load the runtime.
 */
function carriesOrt(path: string): boolean {
  if (!path.endsWith('.js')) return false;
  const { text } = readBuiltFile(path);
  return ORT_MARKERS.some((marker) => text.includes(marker));
}

const manifest = JSON.parse(readBuiltFile('manifest.json').text) as {
  background?: { service_worker?: string; scripts?: string[] };
  side_panel?: { default_path?: string };
  options_ui?: { page?: string };
};

const sidepanelHtml = manifest.side_panel?.default_path;
const optionsHtml = manifest.options_ui?.page;
const serviceWorker = manifest.background?.service_worker ?? manifest.background?.scripts?.[0];

const SIDEPANEL = sidepanelHtml === undefined ? [] : entryGraph(sidepanelHtml);
const OPTIONS = optionsHtml === undefined ? [] : entryGraph(optionsHtml);
const READER = FILES.filter((path) => path.startsWith('content-scripts/'));

describe('the build output', () => {
  it('builds the entries the manifest names', () => {
    expect(serviceWorker).toBe('background.js');
    expect(sidepanelHtml).toBeTruthy();
    expect(optionsHtml).toBeTruthy();
    expect(FILES).toContain('offscreen.html');
    expect(READER.length).toBeGreaterThan(0);
  });

  it('keeps ONNX Runtime out of the service worker', () => {
    // One file: the worker imports nothing, so there is no graph to walk.
    expect(reachableFrom(serviceWorker as string)).toEqual(['background.js']);
    expect(carriesOrt(serviceWorker as string)).toBe(false);
  });

  it('keeps ONNX Runtime out of everything the side panel can load', () => {
    // The graph is asserted to be more than the entry itself, because a walk
    // that resolved nothing would pass this test for the wrong reason.
    expect(SIDEPANEL.length).toBeGreaterThan(3);
    expect(SIDEPANEL.filter(carriesOrt)).toEqual([]);
  });

  it('keeps ONNX Runtime out of the options page and the injected reader', () => {
    expect(OPTIONS.length).toBeGreaterThan(1);
    expect(OPTIONS.filter(carriesOrt)).toEqual([]);
    expect(READER.filter(carriesOrt)).toEqual([]);
  });

  it('ships the runtime exactly where it is needed: the offscreen worker', () => {
    // The complement of the three tests above. Without this one, deleting the
    // engine entirely would leave them all passing.
    const offscreen = entryGraph('offscreen.html');
    const carrying = offscreen.filter(carriesOrt);

    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toMatch(/^assets\/local\.worker-/);
    // And it is *only* there: no other file in the package contains a marker.
    expect(FILES.filter(carriesOrt)).toEqual(carrying);
  });

  it('ships the wasm the runtime loads, and only that one', () => {
    const wasm = FILES.filter((path) => path.endsWith('.wasm'));

    expect(wasm).toHaveLength(1);
    // The jsep build covers both the WebGPU and the wasm backends, so a second
    // binary would be 21 MB of dead weight (spec §1.4).
    expect(wasm[0]).toMatch(/^assets\/ort-wasm-simd-threaded\.jsep-.*\.wasm$/);
    expect(statSync(join(OUTPUT_DIR, wasm[0] as string)).size).toBe(21_596_019);
  });

  it('does not bundle the voice files, which are fetched at runtime', () => {
    // `kokoro-js` ships 54 of these in its npm package; they belong in Cache
    // Storage, and 28 MB in the extension package would be a mistake nobody
    // notices until review.
    expect(FILES.filter((path) => path.endsWith('.bin'))).toEqual([]);
  });

  it('stays the size the spec measured', () => {
    const bytes = FILES.reduce((sum, path) => sum + statSync(join(OUTPUT_DIR, path)).size, 0);

    expect(bytes).toBeGreaterThanOrEqual(MIN_BYTES);
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES);
  });
});
