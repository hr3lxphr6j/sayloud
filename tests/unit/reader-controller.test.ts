/**
 * The reader's own half of a session, from the side that has to notice when the
 * extension it belongs to was reloaded underneath it.
 *
 * `Extension context invalidated` is not a service worker being recycled: it
 * means this content script is an orphan, and no amount of retrying brings the
 * port back. The failure it used to produce was the worst available — a bar
 * that still drew itself and still accepted clicks, and did nothing with them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { ReaderController } from '~/entrypoints/reader.content/ReaderController';
import type { EngineStatus } from '~/lib/protocol';
import type { ReadingDoc } from '~/lib/reading-doc';
import { DEFAULT_SETTINGS, type Settings, type SettingsStore } from '~/lib/settings-store';

/** The extension id, read before any test hides it. */
const liveId: unknown = browser.runtime.id;

/** What a call into a reloaded extension throws. */
function contextInvalidated(): Error {
  return new Error('Extension context invalidated.');
}

/** Make the extension look reloaded: `runtime.id` is what the reader checks. */
function reloadExtension(): void {
  Object.defineProperty(browser.runtime, 'id', { configurable: true, value: undefined });
}

/**
 * A port that records what it was sent, and can be made to fail the way a torn
 * down one does.
 */
function fakePort() {
  const sent: unknown[] = [];
  const listeners = new Set<(message: unknown) => void>();
  let stale = false;

  return {
    port: {
      postMessage(message: unknown) {
        if (stale) throw new Error('Attempting to use a disconnected port object');
        sent.push(message);
      },
      disconnect: () => {},
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.add(listener) },
      onDisconnect: { addListener: () => {} },
    },
    sent,
    goStale: () => {
      stale = true;
    },
    /** Deliver an event the way the worker would. */
    receive: (message: unknown) => {
      for (const listener of [...listeners]) listener(message);
    },
  };
}

/** A status the engine might announce, for the reader's own reading of it. */
function statusOf(
  phase: EngineStatus['phase'],
  index: number,
  overrides: Partial<EngineStatus> = {}
): EngineStatus {
  return {
    phase,
    index,
    total: 3,
    rate: 1,
    voice: 'Samantha',
    charsRead: 0,
    charsTotal: 0,
    charsPerSec: 0,
    ...overrides,
  };
}

describe('ReaderController', () => {
  beforeEach(() => {
    // A live extension, whatever the previous test did to it: the id is a
    // shared object's property, so hiding it leaks across tests otherwise.
    Object.defineProperty(browser.runtime, 'id', { configurable: true, value: liveId });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a reloaded extension instead of retrying into it', () => {
    reloadExtension();
    vi.spyOn(browser.runtime, 'connect').mockImplementation(() => {
      throw contextInvalidated();
    });

    const controller = new ReaderController();
    controller.connect();

    expect(controller.getState().error).toBe('orphaned');

    controller.dispose();
  });

  it('keeps waiting when the worker is only unreachable', () => {
    // The context is alive — `runtime.id` is still there — so this is the case
    // a retry can fix, and the reader must not tell the user to refresh while
    // the worker is merely restarting.
    vi.spyOn(browser.runtime, 'connect').mockImplementation(() => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });

    const controller = new ReaderController();
    controller.connect();

    expect(controller.getState().error).not.toBe('orphaned');

    controller.dispose();
  });

  it('resends a command when the port turns out to be stale', () => {
    // Chrome throws on a port it has already torn down, and the command that
    // triggered it is whatever the reader just asked for. Dropping it there is
    // what "the play button does nothing" looks like from outside: no error the
    // user can see, and nothing to retry by hand.
    const stale = fakePort();
    stale.goStale();
    const fresh = fakePort();
    const ports = [stale, fresh];
    let next = 0;
    vi.spyOn(browser.runtime, 'connect').mockImplementation(
      () => (ports[next++] ?? fresh).port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const controller = new ReaderController();
    controller.connect();
    controller.sendCommand({ type: 'toggle' });

    expect(stale.sent).toEqual([]);
    expect(fresh.sent).toContainEqual({ type: 'toggle' });

    controller.dispose();
  });

  it('gives up quietly when not even a fresh port takes the command', () => {
    const stale = fakePort();
    stale.goStale();
    const alsoStale = fakePort();
    alsoStale.goStale();
    const ports = [stale, alsoStale];
    let next = 0;
    vi.spyOn(browser.runtime, 'connect').mockImplementation(
      () =>
        (ports[next++] ?? alsoStale).port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const controller = new ReaderController();
    controller.connect();

    // Nothing to assert but the absence of a throw: the reader schedules a
    // retry rather than propagating a port failure into the page.
    expect(() => controller.sendCommand({ type: 'toggle' })).not.toThrow();

    controller.dispose();
  });

  it('reads the document it was handed instead of the page', () => {
    // The PDF viewer hands its own document in: the page it lives on holds a
    // canvas, not prose. Extracting would find nothing worth reading — or,
    // worse, some chrome around the viewer — so the option has to win.
    document.body.innerHTML = '<article><p>Text from the page. It must not be read.</p></article>';

    const port = fakePort();
    vi.spyOn(browser.runtime, 'connect').mockReturnValue(
      port.port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const sentence = {
      text: 'Only from the pdf.',
      lang: 'en',
      blockIndex: 0,
      start: 0,
      end: 18,
    };
    const doc: ReadingDoc = {
      blocks: [],
      sentences: [sentence],
      getSentence: (index) => (index === 0 ? sentence : null),
      rangeForSentence: () => null,
      rangeForWord: () => null,
      sentenceAt: () => null,
    };

    const controller = new ReaderController(null, { doc });
    controller.connect();

    expect(controller.getState().hasContent).toBe(true);
    const load = port.sent.find((message) => (message as { type?: string }).type === 'load');
    expect(load).toBeDefined();
    expect((load as { sentences: { text: string }[] }).sentences).toEqual([
      { text: 'Only from the pdf.', lang: 'en' },
    ]);

    controller.dispose();
    document.body.innerHTML = '';
  });

  it('sends the document again when the worker says it lost the session', () => {
    // The whole point of `session-lost`. The reader set `loaded` the first time
    // it sent the sentences, so without this it would keep pressing a play
    // button that has nothing behind it — the symptom that took the longest to
    // find, because there is no error anywhere.
    document.body.innerHTML = '<article><p>One sentence here. Another follows.</p></article>';

    const port = fakePort();
    vi.spyOn(browser.runtime, 'connect').mockReturnValue(
      port.port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const controller = new ReaderController();
    controller.connect();

    expect(port.sent).toContainEqual(expect.objectContaining({ type: 'load' }));

    // The engine answered once, which is what makes this a session to recover.
    port.receive({ type: 'status', status: statusOf('playing', 1) });
    port.sent.length = 0;
    port.receive({ type: 'session-lost' });

    // A recovery, not a fresh start: the engine has to take the sentences and
    // keep the position, without speaking over a pause the user asked for.
    expect(port.sent).toContainEqual(
      expect.objectContaining({ type: 'load', startIndex: 1, resume: true })
    );

    controller.dispose();
    document.body.innerHTML = '';
  });

  it('ignores a session-lost that arrives before the engine ever answered', () => {
    // Booting a fresh worker: the reader sends its document with this very
    // connection, and the empty engine's `session-lost` crosses that `load` on
    // the way back. Treating it as a recovery would send a `resume` load that
    // stops the reading the first `load` had just started.
    document.body.innerHTML = '<article><p>One sentence here.</p></article>';

    const port = fakePort();
    vi.spyOn(browser.runtime, 'connect').mockReturnValue(
      port.port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const controller = new ReaderController();
    controller.connect();
    port.sent.length = 0;

    port.receive({ type: 'session-lost' });

    expect(port.sent).toHaveLength(0);

    controller.dispose();
    document.body.innerHTML = '';
  });

  it('hands the hint the words the service failed with', () => {
    document.body.innerHTML = '<article><p>One sentence here.</p></article>';

    const port = fakePort();
    vi.spyOn(browser.runtime, 'connect').mockReturnValue(
      port.port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const controller = new ReaderController();
    controller.connect();

    port.receive({
      type: 'status',
      status: statusOf('error', 0, {
        error: 'tts-error',
        errorMessage: 'HTTP 403: invalid api key',
      }),
    });

    // The reader's own state stays decoupled from the engine's shape: the hint
    // gets the text, and the code that picked it is still `tts-error`.
    expect(controller.getState().error).toBe('tts-error');
    expect(controller.getState().errorDetail).toBe('HTTP 403: invalid api key');

    controller.dispose();
    document.body.innerHTML = '';
  });

  it('turns a provider with no voice chosen into its own hint', () => {
    // The engine names the unconfigured provider so a log says which service it
    // was; the bar has no room for the name and the hint reads the same for all
    // of them. The mapping is the whole point: the error arrives either way, and
    // without it there is no hint to show and the user is back to a play button
    // that does nothing.
    document.body.innerHTML = '<article><p>One sentence here.</p></article>';

    const port = fakePort();
    vi.spyOn(browser.runtime, 'connect').mockReturnValue(
      port.port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const controller = new ReaderController();
    controller.connect();
    port.receive({
      type: 'status',
      status: {
        phase: 'error',
        index: 0,
        total: 0,
        rate: 1,
        voice: '',
        charsRead: 0,
        charsTotal: 0,
        charsPerSec: 0,
        error: 'no-voice-selected:dashscope',
      },
    });

    expect(controller.getState().error).toBe('no-voice-selected');

    controller.dispose();
    document.body.innerHTML = '';
  });

  it('sends stop command on dispose when playing', () => {
    // When the page navigates away, the content script is disposed and should
    // stop playback to prevent audio from continuing in the background.
    document.body.innerHTML = '<article><p>One sentence here.</p></article>';

    const port = fakePort();
    vi.spyOn(browser.runtime, 'connect').mockReturnValue(
      port.port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const controller = new ReaderController();
    controller.connect();

    // Simulate the engine reporting it's playing
    port.receive({
      type: 'status',
      status: {
        phase: 'playing',
        index: 0,
        total: 1,
        rate: 1,
        voice: 'test-voice',
        charsRead: 0,
        charsTotal: 100,
        charsPerSec: 10,
      },
    });

    port.sent.length = 0;
    controller.dispose();

    // Should have sent stop command before disconnecting
    expect(port.sent).toContainEqual({ type: 'stop' });

    document.body.innerHTML = '';
  });

  it('does not send stop command on dispose when idle', () => {
    // When not playing, dispose should not send unnecessary stop commands.
    document.body.innerHTML = '<article><p>One sentence here.</p></article>';

    const port = fakePort();
    vi.spyOn(browser.runtime, 'connect').mockReturnValue(
      port.port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const controller = new ReaderController();
    controller.connect();

    // Simulate the engine reporting it's idle
    port.receive({
      type: 'status',
      status: {
        phase: 'idle',
        index: 0,
        total: 1,
        rate: 1,
        voice: 'test-voice',
        charsRead: 0,
        charsTotal: 100,
        charsPerSec: 0,
      },
    });

    port.sent.length = 0;
    controller.dispose();

    // Should not send stop when already idle
    expect(port.sent).not.toContainEqual({ type: 'stop' });

    document.body.innerHTML = '';
  });
});

/**
 * Auto-scrolling keeps the sentence being read inside a comfort band near the
 * top of the viewport, and it is a preference: with it off, a new sentence must
 * not move the reader's viewport at all.
 */
describe('ReaderController auto-scrolling', () => {
  /** What the controller reads its preferences from, without storage. */
  function settingsStore(overrides: Partial<Settings>): SettingsStore {
    const settings = { ...DEFAULT_SETTINGS, ...overrides };
    return {
      load: () => Promise.resolve(settings),
      subscribe: () => () => {},
    } as unknown as SettingsStore;
  }

  const VIEWPORT = 800;

  let scrollTo: ReturnType<typeof vi.fn>;
  let rectTop: number;
  let originalClientRects: typeof Range.prototype.getClientRects | undefined;

  beforeEach(() => {
    rectTop = 900;
    scrollTo = vi.fn();
    vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo as unknown as typeof window.scrollTo);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT });

    const root = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 5_000 });
    Object.defineProperty(root, 'scrollTop', { configurable: true, value: 0 });

    // happy-dom has no layout: every range rect is empty unless we say otherwise.
    originalClientRects = Range.prototype.getClientRects;
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ top: rectTop, bottom: rectTop + 20, width: 200, height: 20 }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalClientRects === undefined) {
      Reflect.deleteProperty(Range.prototype, 'getClientRects');
    } else {
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: originalClientRects,
      });
    }
    document.body.innerHTML = '';
  });

  /** Build a reader over a two-sentence page, with its preferences applied. */
  async function readingController(overrides: Partial<Settings>, html?: string) {
    document.body.innerHTML =
      html ?? '<article><p>One sentence here. Another follows.</p></article>';
    const port = fakePort();
    vi.spyOn(browser.runtime, 'connect').mockReturnValue(
      port.port as unknown as ReturnType<typeof browser.runtime.connect>
    );

    const controller = new ReaderController(null, { settings: settingsStore(overrides) });
    // The saved preferences arrive through a promise; let them land before the
    // engine starts announcing sentences.
    await Promise.resolve();
    controller.connect();
    return { controller, port };
  }

  it('brings the sentence top back to the anchor as reading moves on', async () => {
    const { controller, port } = await readingController({ autoScroll: true });

    port.receive({ type: 'status', status: statusOf('playing', 1) });

    // 900 − 0.33 × 800 = 636.
    expect(scrollTo).toHaveBeenCalledWith({ top: 636, behavior: 'smooth' });

    controller.dispose();
  });

  it('leaves the page alone while the sentence top is already in the band', async () => {
    rectTop = VIEWPORT * 0.33;
    const { controller, port } = await readingController({ autoScroll: true });

    port.receive({ type: 'status', status: statusOf('playing', 1) });

    expect(scrollTo).not.toHaveBeenCalled();

    controller.dispose();
  });

  it('leaves the page where the reader put it when the preference is off', async () => {
    const { controller, port } = await readingController({ autoScroll: false });

    port.receive({ type: 'status', status: statusOf('playing', 1) });

    expect(scrollTo).not.toHaveBeenCalled();
    // Nor does it pretend the reader scrolled away: that hint offers to bring
    // the page back, which is exactly what the preference turned off.
    expect(controller.getState().scrolledAway).toBe(false);

    controller.dispose();
  });

  it('scrolls even a settled sentence when the reader asks to go back', async () => {
    rectTop = VIEWPORT * 0.33;
    const { controller, port } = await readingController({ autoScroll: true });
    port.receive({ type: 'status', status: statusOf('playing', 0) });
    expect(scrollTo).not.toHaveBeenCalled();

    controller.returnToPosition();

    expect(scrollTo).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('suspends when the reader uses the wheel', async () => {
    const { controller } = await readingController({ autoScroll: true });

    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));

    expect(controller.getState().scrolledAway).toBe(true);

    controller.dispose();
  });

  it('suspends on a touch move but not on the tap that starts a seek', async () => {
    const { controller } = await readingController({ autoScroll: true });

    window.dispatchEvent(new Event('touchstart'));
    expect(controller.getState().scrolledAway).toBe(false);

    window.dispatchEvent(new Event('touchmove'));
    expect(controller.getState().scrolledAway).toBe(true);

    controller.dispose();
  });

  it('ignores keyboard scrolling while the reader is typing', async () => {
    const { controller } = await readingController({ autoScroll: true });
    const input = document.createElement('input');
    document.body.append(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(controller.getState().scrolledAway).toBe(false);

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(controller.getState().scrolledAway).toBe(true);

    controller.dispose();
  });

  it('does not treat Space on a button as a page scroll', async () => {
    const { controller } = await readingController({ autoScroll: true });
    const button = document.createElement('button');
    document.body.append(button);

    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

    expect(controller.getState().scrolledAway).toBe(false);

    controller.dispose();
  });

  it('ignores the tiny scrolls a reflow produces', async () => {
    const { controller } = await readingController({ autoScroll: true });
    const root = document.scrollingElement ?? document.documentElement;

    Object.defineProperty(root, 'scrollTop', { configurable: true, value: 2 });
    window.dispatchEvent(new Event('scroll'));
    expect(controller.getState().scrolledAway).toBe(false);

    Object.defineProperty(root, 'scrollTop', { configurable: true, value: 120 });
    window.dispatchEvent(new Event('scroll'));
    expect(controller.getState().scrolledAway).toBe(true);

    controller.dispose();
  });

  it('lets the reader take over during our own smooth scroll', async () => {
    const { controller, port } = await readingController({ autoScroll: true });
    port.receive({ type: 'status', status: statusOf('playing', 1) });
    // The reveal above opened the programmatic window; a wheel must still win.
    expect(controller.getState().scrolledAway).toBe(false);

    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));

    expect(controller.getState().scrolledAway).toBe(true);

    controller.dispose();
  });

  it('re-aligns the sentence after the layout settles from a resize', async () => {
    const { controller, port } = await readingController({ autoScroll: true });
    port.receive({ type: 'status', status: statusOf('playing', 1) });
    scrollTo.mockClear();

    vi.useFakeTimers();
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    expect(scrollTo).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('does nothing on resize when the sentence is still in the band', async () => {
    rectTop = VIEWPORT * 0.33;
    const { controller, port } = await readingController({ autoScroll: true });
    port.receive({ type: 'status', status: statusOf('playing', 1) });
    scrollTo.mockClear();

    vi.useFakeTimers();
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    expect(scrollTo).not.toHaveBeenCalled();

    controller.dispose();
  });

  it('scrolls the container the article lives in, not the page', async () => {
    const { controller, port } = await readingController(
      { autoScroll: true },
      '<div id="scroller" style="overflow-y:auto"><article><p>One sentence here. Another follows.</p></article></div>'
    );
    const scroller = document.querySelector('#scroller') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 3_000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 });
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, bottom: 400, left: 0, right: 800 }),
    });
    const containerScroll = vi.fn();
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: containerScroll });

    rectTop = 300;
    port.receive({ type: 'status', status: statusOf('playing', 1) });

    // 300 − 0.33 × 400 = 168.
    expect(containerScroll).toHaveBeenCalledWith({ top: 168, behavior: 'smooth' });
    expect(scrollTo).not.toHaveBeenCalled();

    controller.dispose();
  });
});
