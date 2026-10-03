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
 * Four failures this is here to catch, all of which have real consequences:
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
 * 3. **The phonemizer reaching a page that does not phonemize.** Its wasm is
 *    5 MB and its glue another 12 kB. Same structural guarantee as ONNX
 *    Runtime, same reason to check it.
 * 4. **An asset URL that resolved to `undefined`.** `import.meta.url` is what
 *    names the emitted worker and ORT's wasm pair; a global `define` that
 *    replaces `import.meta` — the tempting fix for the `[EMPTY_IMPORT_META]`
 *    warning — leaves those names as unresolved `{}.ROLLDOWN_FILE_URL_*`
 *    placeholders that evaluate to `undefined` at runtime. Nothing else in the
 *    suite notices: the build stays green and the extension only fails on the
 *    first sentence, as "the on-device worker stopped". The two tests at the end
 *    of this file are the ones that would have caught it.
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

/**
 * Strings that only appear in a bundle carrying the Rust phonemizer.
 *
 * `phonemize_bg-` is the hashed name of the wasm module, which the glue that
 * loads it names — so this covers both "the glue reached this chunk" and "this
 * chunk knows where the wasm is". The second matters because the module is
 * instantiated by the glue itself: a rename would leave the build green and
 * only show up on the first sentence, as "the phonemizer was not initialised".
 *
 * Phase 7 moved this here from jieba, which the same test used to guard. The
 * JavaScript chain is no longer reachable from any entry point, so nothing in
 * the output mentions jieba at all — which is asserted by the count of wasm
 * files rather than by a marker, since the marker's absence is the point.
 */
const PHONEMIZE_MARKERS = ['phonemize_bg-'] as const;

/**
 * Measured 57.7 MB: ONNX Runtime's 20.6 MB wasm, 16.9 MB of `kuromoji-dict/`
 * files, the 8.1 MB IPADic dictionary, the 5.1 MB phonemizer wasm, the 2.2 MB
 * kokoro worker chunk, the 1.6 MB Chinese word list, and the rest.
 *
 * **The drop phase 7 was expected to bring did not happen, and the reason is
 * worth keeping.** The prediction was that wiring the Rust phonemizer up would
 * remove kuromoji's 16.9 MB and jieba's 3.8 MB. It removed the 4.0 MB jieba wasm
 * and its glue — and added the 5.1 MB phonemizer wasm — but kuromoji's 16.9 MB
 * and the 1.6 MB word list are `public/` assets, which a bundler copies whether
 * or not anything imports them. So the build went 56,983,122 → 57,692,840 B
 * (+0.71 MB), and the 16.9 MB goes away when phase 8 deletes the directory
 * rather than when the import goes away. The JavaScript chain itself *is* gone:
 * no chunk in the output mentions kuromoji, kuroshiro or jieba.
 *
 * **This bound had already been exceeded before phase 6 touched it.** It was set
 * to 44-50 MB around a measurement of 46.8 MB and did not move when the IPADic
 * dictionary — 8.1 MB, and absent from the itemisation above until now — landed;
 * the build was 55.35 MB at the commit before the Chinese word list was added,
 * which is 5.35 MB past the ceiling. Nothing noticed because `pnpm test:build`
 * is opt-in and CI does not run it.
 */
const MIN_BYTES = 55_000_000;
const MAX_BYTES = 59_000_000;

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

/** Whether this file's code mentions the phonemizer. JavaScript only, as above. */
function carriesPhonemizer(path: string): boolean {
  if (!path.endsWith('.js')) return false;
  const { text } = readBuiltFile(path);
  return PHONEMIZE_MARKERS.some((marker) => text.includes(marker));
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
    expect(carrying[0]).toMatch(/^assets\/kokoro\.worker-/);
    // And it is *only* there: no other file in the package contains a marker.
    expect(FILES.filter(carriesOrt)).toEqual(carrying);
  });

  it('ships the wasm the runtime loads, and only those', () => {
    const wasm = FILES.filter((path) => path.endsWith('.wasm'));

    // Exactly two: ONNX Runtime's and the phonemizer's. Both are singletons —
    // the jsep build covers the WebGPU and wasm backends, so a second ORT
    // binary would be 21 MB of dead weight (spec §1.4), and a second phonemizer
    // binary would be 5 MB of the same. jieba's is no longer here at all, which
    // is the whole of phase 7's effect on this list.
    expect(wasm).toHaveLength(2);

    const ort = wasm.filter((path) => /ort-wasm-simd-threaded\.jsep-.*\.wasm$/.test(path));
    expect(ort).toHaveLength(1);
    expect(statSync(join(OUTPUT_DIR, ort[0] as string)).size).toBe(21_596_019);

    const phonemize = wasm.filter((path) => /phonemize_bg-.*\.wasm$/.test(path));
    expect(phonemize).toHaveLength(1);
    expect(statSync(join(OUTPUT_DIR, phonemize[0] as string)).size).toBe(5_081_554);
  });

  it('ships the phonemizer exactly where it is needed: the offscreen worker', () => {
    // Same structural guarantee as ONNX Runtime, and worth the same test: 5 MB
    // of wasm plus its glue is too much to leave one stray import away from the
    // side panel. And since phase 7 the engine cannot speak without it — the
    // kokoro worker is handed phonemes and has no way to make any.
    const carrying = FILES.filter(carriesPhonemizer);

    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toMatch(/^assets\/phonemize\.worker-/);
    expect(FILES.filter(carriesPhonemizer)).toEqual(carrying);

    // And the glue names the binary that was actually emitted. Nothing else
    // would notice a rename: the build stays green and the wasm is simply not
    // there when the first sentence asks for it.
    const wasm = FILES.find((path) => /phonemize_bg-.*\.wasm$/.test(path));
    expect(wasm).toBeDefined();
    expect(readBuiltFile(carrying[0] as string).text).toContain(posix.basename(wasm as string));
  });

  it('ships the glue module ONNX Runtime imports at runtime', () => {
    // ORT assembles this path itself and `import()`s it, so no bundler sees the
    // file and nothing else notices when it goes missing: the build stays green
    // and the failure only appears on the first synthesis, as "no available
    // backend found" — after a fallback to a jsdelivr URL that the extension's
    // `script-src 'self'` blocks. That is exactly how it shipped once already.
    const glue = FILES.filter((path) =>
      /^assets\/ort-wasm-simd-threaded\.jsep-.*\.mjs$/.test(path)
    );
    expect(glue).toHaveLength(1);

    const worker = FILES.find((path) => path.startsWith('assets/kokoro.worker-'));
    expect(worker).toBeDefined();
    // The name the worker hands ORT has to be the name that was emitted: a URL
    // pointing at nothing fails exactly like no URL at all.
    expect(readFileSync(join(OUTPUT_DIR, worker as string), 'utf8')).toContain(
      posix.basename(glue[0] as string)
    );
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

  it('points the offscreen document at both workers that were emitted', () => {
    // The workers' names come from `import.meta.url`, so a build that rewrites
    // `import.meta` leaves them as unresolved placeholders rather than paths —
    // and `new Worker(new URL(undefined, …))` throws where the engine is
    // assembled, before anything can report why. The user sees every synthesis
    // fail with "the on-device worker stopped", which names the symptom and
    // neither the cause nor this file.
    //
    // Both are checked, and checked against the emitted names rather than
    // merely "is a string": a URL pointing at a file that does not exist fails
    // exactly like no URL at all, and since phase 7 the engine cannot speak
    // without the second one.
    const offscreen = entryGraph('offscreen.html');
    const spawning = offscreen.filter((path) =>
      /new Worker\(\s*new URL\(\s*["'`]\/assets\/[a-z]+\.worker-/.test(readBuiltFile(path).text)
    );

    expect(spawning).toHaveLength(1);

    const text = readBuiltFile(spawning[0] as string).text;
    for (const name of ['kokoro', 'phonemize']) {
      const worker = FILES.find((path) => path.startsWith(`assets/${name}.worker-`));
      expect(worker).toBeDefined();
      expect(text).toContain(`/${worker as string}`);
    }
  });

  it('leaves no emitted-asset placeholder unresolved', () => {
    // The other half of the same failure, and the reason it is a test of its
    // own: a placeholder that survives the build reads as `undefined` wherever
    // it lands, so this catches the next asset to be named this way even though
    // the test above only knows about the worker.
    const placeholders = FILES.filter((path) => path.endsWith('.js')).filter((path) =>
      readBuiltFile(path).text.includes('ROLLDOWN_FILE_URL_')
    );

    expect(placeholders).toEqual([]);
  });
});
