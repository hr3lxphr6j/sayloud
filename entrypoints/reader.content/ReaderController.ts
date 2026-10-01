import { type Browser, browser } from 'wxt/browser';
import { needsReveal, SCROLL_PAUSE_MS, ScrollSuspension } from '~/lib/autoscroll';
import { extractBlocks } from '~/lib/extractor';
import { Highlighter, installHighlightStyles } from '~/lib/highlighter';
import { createTranslator, resolveLang, type Translator } from '~/lib/i18n';
import { PORT_NAME } from '~/lib/port';
import type { EngineCommand, EngineEvent, EngineStatus } from '~/lib/protocol';
import { buildReadingDoc, type ReadingDoc } from '~/lib/reading-doc';
import type { Settings, SettingsStore } from '~/lib/settings-store';
import { type CaptionState, CaptionWindow } from './CaptionWindow';

/** Reasons the reader cannot read, each with its own bubble card. */
/**
 * `'orphaned'` is the odd one out: the other three come from the engine, and
 * this one is the reader's own — the extension was reloaded under the page, so
 * there is no engine left to have an opinion about anything.
 */
export type ReaderError = 'no-content' | 'no-voice' | 'tts-error' | 'orphaned';

/** The word being spoken, as offsets into the sentence's own text. */
export interface WordPosition {
  index: number;
  charStart: number;
  charEnd: number;
}

export interface ReaderState {
  /** Null until the service worker reports a session. */
  status: EngineStatus | null;
  hasContent: boolean;
  error: ReaderError | null;
  /** The reader scrolled away from the sentence being read. */
  scrolledAway: boolean;
  /**
   * The word being spoken, or null before the first word event of a sentence.
   *
   * Null is also what a provider without word timings leaves behind, which the
   * caption window reads the same way the page highlight does: no estimate.
   */
  word: WordPosition | null;
  /** Whether the settings ask the bar to offer the caption window. */
  captionEnabled: boolean;
  /** Whether the caption window is open. */
  captionOpen: boolean;
}

/** The starting rate, for a reader built without a saved preference. */
const DEFAULT_RATE = 1;

/** A port that dies because the worker is busy must not spin forever. */
const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 250;

/** Clicks on these belong to the page, not to "read from here". */
const INTERACTIVE = 'a, button, input, textarea, select, [contenteditable], [role="button"]';

type Port = Browser.runtime.Port;

/** What the reader needs from the settings before it starts reading. */
export interface ReaderControllerOptions {
  /**
   * The saved default rate for a new session.
   *
   * Read before the reader is built rather than subscribed to afterwards: the
   * rate travels in the `load` command, which is sent once, and the service
   * worker takes a rate change from storage for every later one.
   */
  initialRate?: number;
  /**
   * The saved preferences, for the caption window's switch and language.
   *
   * Subscribed to rather than read once: turning the switch off must close a
   * window that is already open, and the caption window's text follows the
   * interface language.
   */
  settings?: SettingsStore;
}

/**
 * Owns the content script's half of a reading session.
 *
 * The service worker owns playback state; this class extracts the document,
 * keeps the highlight in sync with the events it receives, and turns page
 * interactions into engine commands. The Side Player renders `ReaderState` and
 * sends commands back through here.
 */
export class ReaderController {
  private readonly doc: ReadingDoc | null;
  private readonly highlighter = new Highlighter();
  private readonly suspension = new ScrollSuspension();
  private readonly listeners = new Set<(state: ReaderState) => void>();
  /**
   * Identifies this document instance, so the engine can tell a reconnected
   * player apart from a page that navigated away.
   */
  private readonly docId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  private state: ReaderState;
  private readonly initialRate: number;
  private readonly caption = new CaptionWindow((open) => this.setCaptionOpen(open));
  private unsubscribeSettings: (() => void) | null = null;
  /** The language the caption window's own line is written in. */
  private t: Translator = createTranslator('en');
  private port: Port | null = null;
  private reconnects = 0;
  private reconnectTimer: number | null = null;
  private scrollTimer: number | null = null;
  private disposed = false;
  /** Whether the sentence list was already handed to the engine. */
  private loaded = false;
  /** Sentence whose highlight is on screen, so scrolling only follows changes. */
  private highlighted = -1;

  constructor(
    private readonly host: Element | null = null,
    options: ReaderControllerOptions = {}
  ) {
    installHighlightStyles();
    this.initialRate = options.initialRate ?? DEFAULT_RATE;

    const blocks = extractBlocks();
    this.doc = blocks.length > 0 ? buildReadingDoc(blocks) : null;
    this.state = {
      status: null,
      hasContent: this.doc !== null,
      error: this.doc ? null : 'no-content',
      scrolledAway: false,
      word: null,
      captionEnabled: false,
      captionOpen: false,
    };

    const settings = options.settings;
    if (settings) {
      void settings
        .load()
        .then((loaded) => this.applySettings(loaded))
        .catch((error: unknown) => {
          console.error('[SayLoud] cannot read the saved settings', error);
        });
      this.unsubscribeSettings = settings.subscribe((loaded) => this.applySettings(loaded));
    }

    window.addEventListener('scroll', this.onScroll, { passive: true });
    document.addEventListener('click', this.onClick, true);
  }

  getState(): ReaderState {
    return this.state;
  }

  subscribe(listener: (state: ReaderState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Connect to the service worker, resuming an existing session if there is one.
   *
   * Reconnecting is not optional: the worker is recycled while idle, and a
   * reader who paused for a minute should still find their place.
   */
  connect(): void {
    if (this.port || this.disposed) return;

    let port: Port;
    try {
      port = browser.runtime.connect({ name: PORT_NAME });
    } catch (error) {
      // Two different failures look alike here and could not be less alike in
      // what they need: a worker that is merely restarting is worth retrying,
      // while a reloaded extension has left this content script permanently
      // unable to reach anything. Only the second one is worth telling the
      // reader about, because nothing they do will fix it.
      if (this.contextGone()) {
        this.orphan();
        return;
      }
      console.warn('[SayLoud] cannot reach the service worker', error);
      this.scheduleReconnect();
      return;
    }

    this.port = port;
    port.onMessage.addListener((message) => {
      this.reconnects = 0;
      this.onEvent(message);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this.scheduleReconnect();
    });

    if (!this.doc) return;

    // `sync` first: it tells the engine which document this is, and makes it
    // re-announce the current state when it already has this session.
    this.post({ type: 'sync', docId: this.docId });
    if (this.loaded) return;

    this.loaded = true;
    this.post({
      type: 'load',
      sentences: this.doc.sentences.map((sentence) => ({
        text: sentence.text,
        lang: sentence.lang,
      })),
      startIndex: 0,
      rate: this.initialRate,
    });
  }

  sendCommand(command: EngineCommand): void {
    this.post(command);
  }

  /**
   * Open the caption window, or close it when it is already open.
   *
   * Called straight from the button's click and deliberately synchronous all
   * the way down: `requestWindow()` needs that click's transient user
   * activation, which the first `await` would spend.
   */
  toggleCaption(): void {
    if (this.caption.isOpen) {
      this.caption.close();
      return;
    }
    this.caption.open(this.captionState());
  }

  /** Bring the sentence being read back into view and re-enable auto-scrolling. */
  returnToPosition(): void {
    this.suspension.resume();
    this.clearScrollTimer();
    this.setState({ ...this.state, scrolledAway: false });
    this.reveal(this.state.status?.index ?? 0, true);
  }

  dispose(): void {
    this.disposed = true;
    this.caption.close();
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    window.removeEventListener('scroll', this.onScroll);
    document.removeEventListener('click', this.onClick, true);
    this.clearScrollTimer();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.port?.disconnect();
    } catch {
      // Already gone with the worker.
    }
    this.port = null;
    this.highlighter.dispose();
    this.listeners.clear();
  }

  private post(command: EngineCommand): void {
    if (!this.port) this.connect();

    if (this.tryPost(command)) return;

    if (this.contextGone()) {
      this.orphan();
      return;
    }

    // A stale port is the one failure here that a new connection fixes, and the
    // command is worth keeping: it is whatever the reader just asked for, so
    // dropping it is indistinguishable from a bar that ignores clicks. That is
    // the whole symptom — no error, no effect, and nothing to retry by hand.
    console.warn('[SayLoud] the port was stale; reconnecting and resending');
    this.port = null;
    this.connect();
    if (!this.tryPost(command)) this.scheduleReconnect();
  }

  /** Send once, reporting whether the port took it. */
  private tryPost(command: EngineCommand): boolean {
    if (!this.port) return false;
    try {
      this.port.postMessage(command);
      return true;
    } catch {
      // Chrome throws on a port it has already torn down.
      return false;
    }
  }

  /**
   * Whether this content script's extension context is still alive.
   *
   * Reloading the extension — which `wxt dev` does on every save — turns every
   * content script already in a page into an orphan: the DOM it drew is still
   * there and its buttons still click, but `runtime.id` is gone and every call
   * into the extension throws. Nothing recovers from that but a page reload, so
   * it is checked before a retry rather than discovered after a few.
   */
  private contextGone(): boolean {
    try {
      const id: unknown = browser.runtime.id;
      return typeof id !== 'string';
    } catch {
      // Reading `runtime` itself throws once the context is gone.
      return true;
    }
  }

  /**
   * Report that the extension was reloaded under this page.
   *
   * Said once and never retried. A reader that keeps trying its dead port looks
   * exactly like one that ignores clicks, and that is the worst of the
   * available failures: the person clicking has no way to tell the two apart,
   * so they wait for something that is never coming.
   */
  private orphan(): void {
    if (this.state.error === 'orphaned') return;
    this.setState({ ...this.state, error: 'orphaned' });
  }

  private scheduleReconnect(): void {
    // An orphaned reader can never reach anything again, and a retry loop would
    // only hide that from the person waiting on it.
    if (this.contextGone()) {
      this.orphan();
      return;
    }
    if (this.disposed || this.reconnectTimer !== null) return;
    if (this.reconnects >= MAX_RECONNECTS) return;
    this.reconnects += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private onEvent(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const event = message as EngineEvent;

    switch (event.type) {
      case 'status':
        this.onStatus(event.status);
        return;
      case 'word':
        this.onWord(event.index, event.charStart, event.charEnd);
        return;
      default:
        return;
    }
  }

  private onStatus(status: EngineStatus): void {
    const error = errorFor(status);
    // A new sentence invalidates the previous word: the next `word` event
    // belongs to it, and a stale one would mark the wrong text in the caption.
    const word =
      this.state.word !== null && this.state.word.index !== status.index ? null : this.state.word;
    this.setState({ ...this.state, status, error, word });

    if (status.phase === 'idle' || status.phase === 'ended') {
      this.highlighter.clear();
      this.highlighted = -1;
      this.syncCaption();
      return;
    }

    // An errored session keeps its highlight so the reader can see where it
    // stopped, but a word highlight would be a lie.
    this.highlighter.clearWord();

    const changed = status.index !== this.highlighted;
    if (!changed && status.phase === 'error') {
      this.syncCaption();
      return;
    }

    const range = this.doc?.rangeForSentence(status.index) ?? null;
    // The page may have replaced the nodes we extracted (SPA navigation);
    // highlighting a detached range would silently do nothing anyway.
    this.highlighter.setSentence(range?.startContainer.isConnected ? range : null);
    this.highlighted = status.index;

    if (changed) this.reveal(status.index);

    this.syncCaption();
  }

  private onWord(index: number, charStart: number, charEnd: number): void {
    this.setState({ ...this.state, word: { index, charStart, charEnd } });

    const range = this.doc?.rangeForWord(index, charStart, charEnd) ?? null;
    this.highlighter.setWord(range?.startContainer.isConnected ? range : null);

    this.syncCaption();
  }

  /** What the caption window should be showing right now. */
  private captionState(): CaptionState {
    const status = this.state.status;
    const index = status?.index ?? 0;
    const total = status?.total ?? 0;
    const word = this.state.word;

    return {
      // The sentence list is the reader's own, so the text comes from there
      // rather than from the engine's status.
      text: this.doc?.getSentence(index)?.text ?? '',
      charStart: word ? word.charStart : -1,
      charEnd: word ? word.charEnd : -1,
      index,
      total,
      counter: this.t('caption.counter', { index: index + 1, total }),
    };
  }

  /** Redraw the caption window with the current state; a no-op when closed. */
  private syncCaption(): void {
    this.caption.update(this.captionState());
  }

  private setCaptionOpen(open: boolean): void {
    if (open === this.state.captionOpen) return;
    this.setState({ ...this.state, captionOpen: open });
  }

  /** Take a settings change: the switch, and the language the window reads in. */
  private applySettings(settings: Settings): void {
    this.t = createTranslator(resolveLang(settings.uiLang, navigator.language));

    if (settings.captionWindow !== this.state.captionEnabled) {
      this.setState({ ...this.state, captionEnabled: settings.captionWindow });
    }

    // Turning the switch off closes a window that is already open, which the
    // reader expects to happen the moment the switch moves.
    if (settings.captionWindow) this.syncCaption();
    else this.caption.close();
  }

  /**
   * Scroll the sentence back into view when it has left the viewport.
   *
   * `force` is for the reader asking to go back, which overrides both the
   * "still visible" test and the suspension.
   */
  private reveal(index: number, force = false): void {
    if (!force && this.suspension.active) return;
    const range = this.doc?.rangeForSentence(index) ?? null;
    if (!range?.startContainer.isConnected) return;
    if (!force && !needsReveal(range.getBoundingClientRect(), window.innerHeight)) return;

    const element = range.startContainer.parentElement;
    if (!element) return;

    // Our own smooth scroll fires scroll events; announce it so they are not
    // mistaken for the reader scrolling away.
    this.suspension.noteProgrammatic();

    // Choose scroll alignment based on element's position in the document, not
    // in the viewport. For elements near the document top, 'start' keeps the
    // page from scrolling down unnecessarily; for the rest, 'center' keeps the
    // sentence visible during continuous playback.
    const distanceFromTop = element.getBoundingClientRect().top + window.scrollY;
    const block = distanceFromTop < window.innerHeight * 0.5 ? 'start' : 'center';

    element.scrollIntoView({ behavior: 'smooth', block });
  }

  private readonly onScroll = (): void => {
    this.suspension.noteScroll();
    this.syncScrolledAway();

    this.clearScrollTimer();
    if (!this.suspension.active) return;
    // Let the hint clear itself once the suspension window has passed.
    this.scrollTimer = window.setTimeout(() => {
      this.scrollTimer = null;
      this.syncScrolledAway();
    }, SCROLL_PAUSE_MS + 50);
  };

  private clearScrollTimer(): void {
    if (this.scrollTimer === null) return;
    window.clearTimeout(this.scrollTimer);
    this.scrollTimer = null;
  }

  private syncScrolledAway(): void {
    const scrolledAway = this.suspension.active;
    if (scrolledAway === this.state.scrolledAway) return;
    this.setState({ ...this.state, scrolledAway });
  }

  private readonly onClick = (event: MouseEvent): void => {
    const status = this.state.status;
    if (!this.doc || !status || status.phase === 'idle' || status.phase === 'error') return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    // Clicks on the player itself are controls, not "read from here".
    if (this.host && event.composedPath().includes(this.host)) return;
    if (target.closest(INTERACTIVE)) return;

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;

    const caret = caretFromPoint(event.clientX, event.clientY);
    if (!caret) return;

    const index = this.doc.sentenceAt(caret.node, caret.offset);
    if (index === null || index === status.index) return;
    this.post({ type: 'seek', index });
  };

  private setState(state: ReaderState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state);
  }
}

/** The engine's error, or `no-content` when there is nothing to read at all. */
function errorFor(status: EngineStatus): ReaderError | null {
  if (status.error === 'no-voice' || status.error === 'tts-error') return status.error;
  if (status.error === 'no-content') return 'no-content';
  return null;
}

interface CaretPositionLike {
  offsetNode: Node;
  offset: number;
}

/**
 * Where the pointer landed in the text.
 *
 * Chrome only has `caretPositionFromPoint` from version 128, so the older
 * WebKit-style `caretRangeFromPoint` stays as a fallback.
 */
function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const target = document as unknown as {
    caretPositionFromPoint?: (x: number, y: number) => CaretPositionLike | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  const position = target.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };

  const range = target.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}
