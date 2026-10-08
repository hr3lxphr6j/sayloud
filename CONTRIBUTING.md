# Contributing to SayLoud

Development, architecture and testing notes. What the extension does and how to
install it is in the [README](README.md).

## Requirements

- Node.js 22 or later, and pnpm 9 or later
- Chrome, for anything that drives the extension
- A Rust toolchain with the `wasm32-unknown-unknown` target, and `wasm-pack`
  (`cargo install wasm-pack`) — the phonemizer is a wasm module that `pnpm build`
  compiles through its `prebuild` hook

## Commands

```bash
pnpm install        # also builds the dictionaries (scripts/setup/)
pnpm dev            # launches Chrome with the extension, reloading on change
pnpm test           # unit tests (vitest, happy-dom)
pnpm test:e2e       # end-to-end tests (Playwright, real Chrome)
pnpm test:e2e:production # production side panel acceptance tests
pnpm typecheck      # tsc --noEmit
pnpm lint           # Biome, formatting and lint
pnpm build          # production bundle in .output/chrome-mv3
```

To load the built extension by hand: open `chrome://extensions`, turn on
Developer mode, choose "Load unpacked", and select `.output/chrome-mv3`.

Two more commands that do not run in CI:

```bash
pnpm capture:screenshots   # rewrites the images in assets/ from a real build
pnpm check:ja-mutations    # mutates the Japanese pipeline's guards; minutes
```

`scripts/README.md` documents the rest: the dictionary scripts, the data
generators and their `--check` modes, and the manifest and reference checks.

## Architecture

Two halves, split so that exactly one of them owns playback state.

**Service worker** (`entrypoints/background.ts`) holds the `PlaybackEngine`, the
only writer of session state, and speaks through `chrome.tts` via
`BrowserSpeaker`. `SessionRouter` moves commands and events between the engine
and the tab that owns the session, and mirrors every change into
`storage.session`. The content script is registered at runtime and injected when
the toolbar icon is clicked, so the extension holds no standing access to any
page; `activeTab` grants access to the clicked tab only.

**Content script** (`entrypoints/reader.content.tsx`) extracts the readable
blocks with Readability, builds a sentence model that maps back to DOM ranges,
and renders the bar inside a shadow root. `ReaderController` connects to the
worker over a port, keeps the two CSS Custom Highlight layers in sync with the
engine's events, and turns page interactions into commands. The Side Player is a
pure view over `ReaderState`.

Cloud and on-device audio add a third context: an offscreen document
(`entrypoints/offscreen/`) that owns the `<audio>` element, the two-layer audio
cache, and the models. The service worker decides *what* to say; the offscreen
document decides how to get the bytes, which is also why playback survives a tab
switch.

Shared logic lives in `lib/`, where it is testable without a browser:
extraction, segmentation, the engine state machine, the speaker wrapper, the
snapshot store, the router, remaining-time formatting and the auto-scroll policy.

A few decisions worth knowing about:

- **One session at a time.** Starting in a new tab stops the old one, and
  switching tabs pauses the running session.
- **Reconnects send `sync`, not `load`.** The worker is recycled when idle, so
  the content script reconnects on port disconnect; `sync` lets the engine
  re-announce the current state instead of restarting the page.
- **A restored session is always paused.** The reader is no longer mid-gesture,
  and `chrome.tts` needs a fresh call anyway.
- **`chrome.tts` cannot resume mid-sentence**, so resuming a paused sentence
  replays it from the start.
- **Auto-scroll announces its own scrolls.** The page fires the same `scroll`
  event for our smooth scroll and for the reader dragging the page, so only real
  user scrolls suspend auto-scrolling.
- **`AGENT.md` is the other half of this file**, in Chinese: it walks the same
  architecture from the data flow down, and is the place to look when adding an
  entrypoint, a message or a store.

## Testing

Unit tests run in `happy-dom` and need no browser. The end-to-end tests drive a
real Chrome with the extension loaded, because the interesting parts only exist
there: `chrome.tts` actually speaking, its word events reaching the content
script, and the CSS Custom Highlight API actually painting.

`pnpm test:e2e` runs both the `chromium` and `production` projects. Each project
builds its bundle before running so it cannot test stale artifacts. The
`production` project exercises the shipped side panel in `.output/chrome-mv3`,
including provider forms, persistence, voice selection and narrow layouts.
`pnpm test:e2e:production` runs only that project.

The `chromium` project uses `.output-e2e/chrome-mv3`, which
differs from the shipped one in two ways: it exposes a `sayloudActivate()` hook
on the service worker's scope, and it grants host access to `127.0.0.1` so test
pages can be served over http. Playwright cannot click an extension's toolbar
icon, so the hook stands in for that click and takes the same injection path.

The end-to-end tests need speech voices installed. macOS ships with them; on
Linux install `speech-dispatcher`. They run headless.

`tests/e2e/screenshots.spec.ts` is skipped unless `SAYLOUD_CAPTURE=1`: it is the
`pnpm capture:screenshots` command rather than a test, and it writes the images
the READMEs use.

## License

MIT
