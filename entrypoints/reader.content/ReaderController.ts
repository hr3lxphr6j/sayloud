import { type Browser, browser } from 'wxt/browser';
import { needsReveal, SCROLL_PAUSE_MS, ScrollSuspension } from '~/lib/autoscroll';
import { extractBlocks } from '~/lib/extractor';
import { Highlighter, installHighlightStyles } from '~/lib/highlighter';
import { PORT_NAME } from '~/lib/port';
import type { EngineCommand, EngineEvent, EngineStatus } from '~/lib/protocol';
import { buildReadingDoc, type ReadingDoc } from '~/lib/reading-doc';

/** Reasons the reader cannot read, each with its own bubble card. */
export type ReaderError = 'no-content' | 'no-voice' | 'tts-error';

export interface ReaderState {
  /** Null until the service worker reports a session. */
  status: EngineStatus | null;
  hasContent: boolean;
  error: ReaderError | null;
  /** The reader scrolled away from the sentence being read. */
  scrolledAway: boolean;
}

/** The starting rate, and the one the plan fixes for P1. */
const DEFAULT_RATE = 1;

/** A port that dies because the worker is busy must not spin forever. */
const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 250;

/** Clicks on these belong to the page, not to "read from here". */
const INTERACTIVE = 'a, button, input, textarea, select, [contenteditable], [role="button"]';

type Port = Browser.runtime.Port;

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
  private port: Port | null = null;
  private reconnects = 0;
  private reconnectTimer: number | null = null;
  private scrollTimer: number | null = null;
  private disposed = false;
  /** Whether the sentence list was already handed to the engine. */
  private loaded = false;
  /** Sentence whose highlight is on screen, so scrolling only follows changes. */
  private highlighted = -1;

  constructor(private readonly host: Element | null = null) {
    installHighlightStyles();

    const blocks = extractBlocks();
    this.doc = blocks.length > 0 ? buildReadingDoc(blocks) : null;
    this.state = {
      status: null,
      hasContent: this.doc !== null,
      error: this.doc ? null : 'no-content',
      scrolledAway: false,
    };

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
      // The extension was reloaded or disabled; there is nothing to talk to.
      console.warn('[SayLoud] cannot reach the service worker', error);
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
      rate: DEFAULT_RATE,
    });
  }

  sendCommand(command: EngineCommand): void {
    this.post(command);
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
    try {
      this.port?.postMessage(command);
    } catch (error) {
      console.warn('[SayLoud] command dropped', error);
      this.port = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
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
    this.setState({ ...this.state, status, error });

    if (status.phase === 'idle' || status.phase === 'ended') {
      this.highlighter.clear();
      this.highlighted = -1;
      return;
    }

    // An errored session keeps its highlight so the reader can see where it
    // stopped, but a word highlight would be a lie.
    this.highlighter.clearWord();

    const changed = status.index !== this.highlighted;
    if (!changed && status.phase === 'error') return;

    const range = this.doc?.rangeForSentence(status.index) ?? null;
    // The page may have replaced the nodes we extracted (SPA navigation);
    // highlighting a detached range would silently do nothing anyway.
    this.highlighter.setSentence(range?.startContainer.isConnected ? range : null);
    this.highlighted = status.index;

    if (changed) this.reveal(status.index);
  }

  private onWord(index: number, charStart: number, charEnd: number): void {
    const range = this.doc?.rangeForWord(index, charStart, charEnd) ?? null;
    this.highlighter.setWord(range?.startContainer.isConnected ? range : null);
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
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
