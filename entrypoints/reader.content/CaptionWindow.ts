/**
 * The always-on-top caption window, drawn with Document Picture-in-Picture.
 *
 * It can only be opened from a click in a page: Chrome refuses
 * `requestWindow()` in the side panel, a popup and the offscreen document
 * (WICG/document-picture-in-picture#88), which is why the settings switch only
 * reveals a button on the reader's own bar. The window then belongs to the page
 * that opened it and goes away when that page navigates or closes — expected,
 * not a defect: the reader is reading that page.
 *
 * `requestWindow()` is called synchronously inside the click that triggers it.
 * The call consumes the click's transient user activation, so an `await` before
 * it would leave the window unopened with no error anywhere.
 */
import { createElement, render } from 'preact';
import { supportsPictureInPicture } from '~/lib/document-pip';
import { CaptionView } from './CaptionView';

export interface CaptionState {
  /** The sentence being read, or `''` before the first status arrives. */
  text: string;
  /**
   * Offsets of the spoken word inside `text`.
   *
   * `-1` means the provider reports no word timings, which the view reads the
   * same way the page highlight does.
   */
  charStart: number;
  charEnd: number;
  /** Index of the sentence being read, and how many the session has. */
  index: number;
  total: number;
  /**
   * The "sentence n of m" line, already in the reader's language.
   *
   * Translated by the controller rather than here: the window is not inside the
   * reader's `I18nProvider`, and the controller is the one holding both the
   * settings and the session.
   */
  counter: string;
}

/** The parts of the window `requestWindow()` returns that this class uses. */
export interface CaptionWindowHandle {
  readonly document: Document;
  close(): void;
  addEventListener(type: 'pagehide', listener: () => void): void;
}

/** The slice of `window.documentPictureInPicture` this class uses. */
export interface PictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<CaptionWindowHandle>;
}

/** A readable default; the reader can resize the window afterwards. */
const WINDOW_SIZE = { width: 420, height: 180 };

export class CaptionWindow {
  private pip: CaptionWindowHandle | null = null;
  /** A request Chrome has accepted but not yet answered. */
  private pending = false;
  /** Incremented per request, so a late answer for an abandoned one is ignored. */
  private requestId = 0;
  private state: CaptionState | null = null;

  /**
   * `onOpenChange` reports every transition, including the ones the reader
   * causes by closing the window: the button has to stop looking pressed.
   */
  constructor(private readonly onOpenChange: (open: boolean) => void = () => {}) {}

  /** Whether this browser has the API at all. */
  static isSupported(): boolean {
    return supportsPictureInPicture();
  }

  /** True from the moment a window is asked for until it is gone. */
  get isOpen(): boolean {
    return this.pip !== null || this.pending;
  }

  /**
   * Show `initial` in a new window, or retarget the open one.
   *
   * Returns false when this browser cannot open one at all. Must be called from
   * a click handler — see the class comment.
   */
  open(initial: CaptionState): boolean {
    this.state = initial;

    if (this.pip) {
      this.render();
      return true;
    }
    if (this.pending) return true;
    if (!CaptionWindow.isSupported()) return false;

    const id = ++this.requestId;
    let request: Promise<CaptionWindowHandle>;
    try {
      // Synchronous on purpose: see the class comment.
      request = pictureInPicture().requestWindow(WINDOW_SIZE);
    } catch (error) {
      console.warn('[SayLoud] cannot open the caption window', error);
      return false;
    }

    this.pending = true;
    this.onOpenChange(true);
    request.then(
      (pip) => this.attach(id, pip),
      (error: unknown) => {
        if (id !== this.requestId) return;
        this.pending = false;
        this.onOpenChange(false);
        console.warn('[SayLoud] the caption window did not open', error);
      }
    );
    return true;
  }

  /** Redraw with a new sentence or word. Does nothing while closed. */
  update(state: CaptionState): void {
    this.state = state;
    if (this.pip) this.render();
  }

  close(): void {
    const pip = this.pip;
    if (pip) {
      pip.close();
      // Chrome fires `pagehide` as the window goes away, which is what clears
      // the state; running the handler here as well keeps the button from
      // sticking if it does not.
      this.onClosed();
      return;
    }
    if (!this.pending) return;

    // Asked for but not yet answered. Abandon it: the handler closes the window
    // the moment it exists.
    this.requestId += 1;
    this.pending = false;
    this.onOpenChange(false);
  }

  private attach(id: number, pip: CaptionWindowHandle): void {
    if (id !== this.requestId) {
      // Closed, or reopened, while this window was still being created.
      pip.close();
      return;
    }

    this.pending = false;
    this.pip = pip;
    pip.addEventListener('pagehide', this.onClosed);
    injectStyles(pip);
    this.render();
  }

  /** The window is gone, whether we closed it or the reader did. */
  private readonly onClosed = (): void => {
    if (this.pip === null && !this.pending) return;
    this.requestId += 1;
    this.pip = null;
    this.pending = false;
    this.onOpenChange(false);
  };

  private render(): void {
    const pip = this.pip;
    const state = this.state;
    if (!pip || !state) return;
    render(createElement(CaptionView, { state }), pip.document.body);
  }
}

function pictureInPicture(): PictureInPictureApi {
  return (window as unknown as { documentPictureInPicture: PictureInPictureApi })
    .documentPictureInPicture;
}

const CAPTION_CSS = `
:root { color-scheme: light dark; }
body {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  margin: 0;
  padding: 0 6vmin;
  background: #fff;
  color: #1c1c1e;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  /* Scales with the window the reader drags, not with the page behind it. */
  font-size: clamp(16px, 5vmin, 40px);
  text-align: center;
}
.caption { max-width: 100%; }
.caption-sentence {
  margin: 0;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.caption-word {
  border-radius: 0.15em;
  background: rgb(255 214 10 / 0.5);
  color: inherit;
}
.caption-counter {
  margin: 0.6em 0 0;
  font-size: 0.45em;
  opacity: 0.6;
}
@media (prefers-color-scheme: dark) {
  body { background: #1c1c1e; color: #f2f2f7; }
}
`;

/**
 * Put the window's styles into the picture-in-picture document.
 *
 * A constructable sheet is the only route that survives a strict CSP: the PiP
 * document inherits the opener's policy, and on such a page an inline `<style>`
 * element is dropped with a `style-src-elem` violation (V12 in the P3 spec).
 *
 * The sheet has to be built from the PiP window's own constructor. A stylesheet
 * belongs to the document that created it, and adopting one built in the
 * content script's realm throws "Sharing constructed stylesheets in multiple
 * documents is not allowed".
 */
function injectStyles(pip: CaptionWindowHandle): void {
  const doc = pip.document;
  const realm = pip as CaptionWindowHandle & { CSSStyleSheet?: typeof CSSStyleSheet };

  try {
    if (!realm.CSSStyleSheet) throw new Error('no constructable stylesheets');
    const sheet = new realm.CSSStyleSheet();
    sheet.replaceSync(CAPTION_CSS);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    return;
  } catch (error) {
    // An engine without constructable stylesheets leaves only an element, which
    // a strict-CSP page will block. Chrome has had both since it gained
    // Document Picture-in-Picture, so this path is a formality.
    console.warn('[SayLoud] caption styles fall back to a <style> element', error);
  }

  const style = doc.createElement('style');
  style.textContent = CAPTION_CSS;
  doc.head.appendChild(style);
}
