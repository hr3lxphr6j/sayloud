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
});
