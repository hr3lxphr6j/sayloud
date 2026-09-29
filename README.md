# SayLoud

A Chrome extension that reads web pages aloud with the browser's built-in
speech, highlighting the sentence being read and, word by word, the word being
spoken.

## P1: browser voice (current)

Reading a page needs no account, no API key and no network: `chrome.tts` speaks
with a voice the system already has.

- Reads the whole page, from a 28px bar pinned to the right edge
- Sentence-level highlighting as the baseline, plus word-level highlighting
  from `chrome.tts` word events
- Play/pause, previous/next sentence, and a speed control from 0.5x to 2x
- A progress ring for the page, with the remaining time in a bubble card
- Click a sentence in the page to start reading from there
- Auto-scroll follows the reading position, and stops following as soon as you
  scroll yourself
- Hints and errors arrive in bubble cards, because 28px has no room for text
- The session survives the service worker being recycled: it restores as paused,
  in the same place, and the content script reconnects on its own

Not in P1: cloud voices (P2), the settings panel and voice picker (P3), the
paragraph button, selection button and keyboard shortcuts (P4), and
dark-page-adaptive highlight colours (P4).

## Development

Requires Node.js 22 or later and pnpm 9 or later.

```bash
pnpm install
pnpm dev        # launches Chrome with the extension, reloading on change
pnpm test       # unit tests (vitest, happy-dom)
pnpm test:e2e   # end-to-end tests (Playwright, real Chrome)
pnpm typecheck  # tsc --noEmit
pnpm lint       # Biome, formatting and lint
pnpm build      # production bundle in .output/chrome-mv3
```

To load the built extension by hand: open `chrome://extensions`, turn on
Developer mode, choose "Load unpacked", and select `.output/chrome-mv3`.

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

## Testing

Unit tests run in `happy-dom` and need no browser. The end-to-end tests drive a
real Chrome with the extension loaded, because the interesting parts only exist
there: `chrome.tts` actually speaking, its word events reaching the content
script, and the CSS Custom Highlight API actually painting.

`pnpm test:e2e` builds its own bundle first (`.output-e2e/chrome-mv3`), which
differs from the shipped one in two ways: it exposes a `sayloudActivate()` hook
on the service worker's scope, and it grants host access to `127.0.0.1` so test
pages can be served over http. Playwright cannot click an extension's toolbar
icon, so the hook stands in for that click and takes the same injection path.

The end-to-end tests need speech voices installed. macOS ships with them; on
Linux install `speech-dispatcher`. They run headless.

## License

MIT
