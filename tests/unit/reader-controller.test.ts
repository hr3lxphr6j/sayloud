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
      onMessage: {
        addListener: (listener: (message: unknown) => void) => listeners.add(listener),
      },
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

    port.sent.length = 0;
    port.receive({ type: 'session-lost' });

    expect(port.sent).toContainEqual(expect.objectContaining({ type: 'load' }));

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
