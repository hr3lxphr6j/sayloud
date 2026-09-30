/**
 * The caption window, against a stand-in for `documentPictureInPicture`.
 *
 * The real API needs a click in a real browser, so these tests fake it and
 * cover what the fake can see: support detection, the synchronous request, what
 * ends up in the window's document, and the two ways the window can close —
 * the reader asking, and the reader using the window's own close control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CaptionState,
  CaptionWindow,
  type CaptionWindowHandle,
  type PictureInPictureApi,
} from '~/entrypoints/reader.content/CaptionWindow';

/** A constructable-stylesheet stand-in that needs no document of its own. */
class FakeStyleSheet {
  cssText = '';
  replaceSync(css: string): void {
    this.cssText = css;
  }
}

/** A stand-in for the window `requestWindow()` resolves with. */
class FakePipWindow extends EventTarget implements CaptionWindowHandle {
  readonly document: Document;
  /** Set when a stylesheet constructor is available to the window. */
  readonly CSSStyleSheet?: typeof FakeStyleSheet;
  closed = false;

  constructor(options: { stylesheets?: boolean } = {}) {
    super();
    this.document = document.implementation.createHTMLDocument('caption');
    if (options.stylesheets) {
      this.CSSStyleSheet = FakeStyleSheet;
      Object.defineProperty(this.document, 'adoptedStyleSheets', {
        value: [],
        writable: true,
        configurable: true,
      });
    }
  }

  close(): void {
    this.closed = true;
    // Chrome fires `pagehide` as the window goes away, whichever way it was
    // closed; the tests reproduce that so the class cannot rely on the caller
    // cleaning up after it.
    this.dispatchEvent(new Event('pagehide'));
  }

  /** The reader closed the window with the control in its own title bar. */
  userClose(): void {
    this.closed = true;
    this.dispatchEvent(new Event('pagehide'));
  }

  text(): string {
    return this.document.body.textContent ?? '';
  }
}

function installApi(requestWindow: PictureInPictureApi['requestWindow']): void {
  Object.defineProperty(window, 'documentPictureInPicture', {
    value: { requestWindow },
    configurable: true,
  });
}

function captionState(overrides: Partial<CaptionState> = {}): CaptionState {
  return {
    text: 'The first sentence is deliberately short.',
    charStart: 4,
    charEnd: 9,
    index: 0,
    total: 6,
    counter: 'Sentence 1 of 6',
    ...overrides,
  };
}

/** Let a resolved `requestWindow` promise run its handlers. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  Reflect.deleteProperty(window, 'documentPictureInPicture');
  vi.restoreAllMocks();
});

describe('CaptionWindow.isSupported', () => {
  it('is false in a browser without Document Picture-in-Picture', () => {
    expect(CaptionWindow.isSupported()).toBe(false);
  });

  it('is true once the API is there', () => {
    installApi(vi.fn());
    expect(CaptionWindow.isSupported()).toBe(true);
  });
});

describe('CaptionWindow.open', () => {
  it('refuses to open anything when the API is missing', () => {
    const caption = new CaptionWindow();
    expect(caption.open(captionState())).toBe(false);
    expect(caption.isOpen).toBe(false);
  });

  it('asks for the window synchronously, before any await', () => {
    const requestWindow = vi.fn(async () => new FakePipWindow());
    installApi(requestWindow);
    const caption = new CaptionWindow();

    const opened = caption.open(captionState());

    // The whole point: the request has to leave during the click, so it cannot
    // be waiting on an already-resolved promise.
    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(opened).toBe(true);
    expect(caption.isOpen).toBe(true);
  });

  it('reports the window opening and closing to its owner', async () => {
    installApi(vi.fn(async () => new FakePipWindow()));
    const onOpenChange = vi.fn();
    const caption = new CaptionWindow(onOpenChange);

    caption.open(captionState());
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    await flush();
    caption.close();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it('shows the sentence, the spoken word and the sentence count', async () => {
    const handle = new FakePipWindow();
    installApi(vi.fn(async () => handle));
    const caption = new CaptionWindow();

    caption.open(captionState());
    await flush();

    expect(handle.text()).toContain('The first sentence is deliberately short.');
    expect(handle.text()).toContain('Sentence 1 of 6');
    expect(handle.document.querySelector('mark')?.textContent).toBe('first');
  });

  it('leaves the word unmarked when the provider reported no timings', async () => {
    const handle = new FakePipWindow();
    installApi(vi.fn(async () => handle));
    const caption = new CaptionWindow();

    caption.open(captionState({ charStart: -1, charEnd: -1 }));
    await flush();

    expect(handle.document.querySelector('mark')).toBeNull();
    expect(handle.text()).toContain('deliberately short');
  });

  it('hides the sentence count before a session reports one', async () => {
    const handle = new FakePipWindow();
    installApi(vi.fn(async () => handle));
    const caption = new CaptionWindow();

    caption.open(captionState({ text: '', index: 0, total: 0, counter: 'Sentence 1 of 0' }));
    await flush();

    expect(handle.text()).toBe('');
  });

  it('retargets an open window instead of asking for a second one', async () => {
    const handle = new FakePipWindow();
    const requestWindow = vi.fn(async () => handle);
    installApi(requestWindow);
    const caption = new CaptionWindow();

    caption.open(captionState());
    await flush();
    caption.open(
      captionState({ text: 'The second sentence follows.', counter: 'Sentence 2 of 6' })
    );

    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(handle.text()).toContain('The second sentence follows.');
  });

  it('closes the window when the request never lands', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installApi(vi.fn(async () => Promise.reject(new Error('nope'))));
    const onOpenChange = vi.fn();
    const caption = new CaptionWindow(onOpenChange);

    expect(caption.open(captionState())).toBe(true);
    await flush();

    expect(caption.isOpen).toBe(false);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it('keeps a synchronous throw from the API from escaping', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installApi(() => {
      throw new Error('no user activation');
    });
    const caption = new CaptionWindow();

    expect(caption.open(captionState())).toBe(false);
    expect(caption.isOpen).toBe(false);
  });
});

describe('CaptionWindow.update', () => {
  it('redraws the open window with the next sentence and word', async () => {
    const handle = new FakePipWindow();
    installApi(vi.fn(async () => handle));
    const caption = new CaptionWindow();
    caption.open(captionState());
    await flush();

    caption.update(
      captionState({
        text: 'The second sentence follows it closely enough.',
        charStart: 4,
        charEnd: 10,
        index: 1,
        counter: 'Sentence 2 of 6',
      })
    );

    expect(handle.text()).toContain('The second sentence follows');
    expect(handle.text()).toContain('Sentence 2 of 6');
    expect(handle.document.querySelector('mark')?.textContent).toBe('second');
  });

  it('does nothing once the window is gone', async () => {
    const handle = new FakePipWindow();
    installApi(vi.fn(async () => handle));
    const caption = new CaptionWindow();
    caption.open(captionState());
    await flush();

    caption.close();
    const after = handle.text();
    caption.update(captionState({ text: 'never drawn' }));

    expect(handle.text()).toBe(after);
  });
});

describe('CaptionWindow.close', () => {
  it('closes the window and reports it', async () => {
    const handle = new FakePipWindow();
    installApi(vi.fn(async () => handle));
    const onOpenChange = vi.fn();
    const caption = new CaptionWindow(onOpenChange);
    caption.open(captionState());
    await flush();

    caption.close();

    expect(handle.closed).toBe(true);
    expect(caption.isOpen).toBe(false);
    // Once: the close is not announced twice just because Chrome also fires
    // `pagehide` for it.
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it('notices a window the reader closed from its own title bar', async () => {
    const handle = new FakePipWindow();
    installApi(vi.fn(async () => handle));
    const onOpenChange = vi.fn();
    const caption = new CaptionWindow(onOpenChange);
    caption.open(captionState());
    await flush();

    handle.userClose();

    expect(caption.isOpen).toBe(false);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    // A second click on the bar must open a new window rather than try to
    // reopen the one that is gone.
    expect(caption.open(captionState())).toBe(true);
  });

  it('closes a window that arrives after being closed again', async () => {
    const handle = new FakePipWindow();
    const pending: { resolve?: (pip: FakePipWindow) => void } = {};
    installApi(
      () =>
        new Promise<FakePipWindow>((resolve) => {
          pending.resolve = resolve;
        })
    );
    const onOpenChange = vi.fn();
    const caption = new CaptionWindow(onOpenChange);

    caption.open(captionState());
    caption.close();
    expect(caption.isOpen).toBe(false);

    pending.resolve?.(handle);
    await flush();

    expect(handle.closed).toBe(true);
    expect(handle.text()).toBe('');
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });
});

describe('CaptionWindow styles', () => {
  it('adopts a constructed sheet', async () => {
    const handle = new FakePipWindow({ stylesheets: true });
    installApi(vi.fn(async () => handle));
    const caption = new CaptionWindow();

    caption.open(captionState());
    await flush();

    const sheets = (handle.document as unknown as { adoptedStyleSheets: FakeStyleSheet[] })
      .adoptedStyleSheets;
    expect(sheets).toHaveLength(1);
    // Built from the PiP window's own constructor: a sheet made in the content
    // script's realm cannot be adopted into another document (V12).
    expect(sheets[0]).toBeInstanceOf(FakeStyleSheet);
    expect(sheets[0]?.cssText).toContain('clamp(16px, 5vmin, 40px)');
    expect(handle.document.querySelector('style')).toBeNull();
  });

  it('falls back to a style element when the window has no constructor', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = new FakePipWindow();
    installApi(vi.fn(async () => handle));
    const caption = new CaptionWindow();

    caption.open(captionState());
    await flush();

    expect(handle.document.querySelector('style')?.textContent).toContain(
      'clamp(16px, 5vmin, 40px)'
    );
  });
});
