/**
 * The settings gear, in a real browser.
 *
 * The bug this guards against: the gear used to call `chrome.sidePanel.open()`
 * from the content script, where `sidePanel` does not exist — a content script
 * is given `runtime`, `i18n`, `storage` and `dom` and nothing else. The guard
 * in front of the call was therefore always false and the click did nothing,
 * silently, with no error anywhere.
 *
 * So the assertion that matters is not "the panel opened" (a side panel has no
 * queryable open state) but "the click reached the worker and the worker asked
 * for the panel for *this* tab". The worker's call is recorded by wrapping the
 * API before the click.
 */
import { control, expect, test } from './fixtures';

/** The bits of `chrome` these specs touch, from inside the worker. */
interface ChromeLike {
  sidePanel: {
    open(options: { tabId?: number; windowId?: number }): Promise<void>;
  };
  runtime: { openOptionsPage(): Promise<void> };
}

/** Calls the worker recorded, or null when the wrapper was never installed. */
async function recordedCalls(serviceWorker: import('@playwright/test').Worker) {
  return serviceWorker.evaluate(
    () => (globalThis as unknown as { __sidePanelCalls?: unknown[] }).__sidePanelCalls ?? null
  );
}

test('the worker exposes the side panel API a content script cannot reach', async ({
  serviceWorker,
}) => {
  const api = await serviceWorker.evaluate(() => {
    const chrome = (globalThis as unknown as { chrome?: ChromeLike }).chrome;
    return {
      open: typeof chrome?.sidePanel?.open,
      options: typeof chrome?.runtime?.openOptionsPage,
    };
  });

  // `open` is the call the gear depends on; `openOptionsPage` is its fallback.
  expect(api.open).toBe('function');
  expect(api.options).toBe('function');
});

test('clicking the gear asks the worker to open the panel for this tab', async ({
  page,
  serviceWorker,
  activate,
}) => {
  await page.goto('/article.html');
  await activate();
  await expect(control(page, 'Settings')).toBeVisible();

  // Install the recorder *after* the page is up, so the real extension startup
  // is not disturbed. Resolving instead of delegating keeps the side panel from
  // actually opening, which would outlive the assertion.
  await serviceWorker.evaluate(() => {
    const chrome = (globalThis as unknown as { chrome: ChromeLike }).chrome;
    const calls: unknown[] = [];
    (globalThis as unknown as { __sidePanelCalls?: unknown[] }).__sidePanelCalls = calls;
    chrome.sidePanel.open = async (options) => {
      calls.push(options);
    };
  });

  await control(page, 'Settings').click();

  // Poll for the call, not for the recorder: the recorder is installed above, so
  // its array already exists — and is empty — when the click happens, and "the
  // recorder exists" is therefore true on the first poll. That read the list
  // before the click had been through the worker, which failed on a runner that
  // took longer than one poll interval to get there.
  await expect.poll(() => recordedCalls(serviceWorker), { timeout: 10_000 }).toHaveLength(1);

  const calls = await recordedCalls(serviceWorker);

  // The tab id, not the window id: the gear belongs to one tab, and opening the
  // panel per window would replace another tab's settings.
  expect(calls).toHaveLength(1);
  expect(calls?.[0]).toEqual({ tabId: expect.any(Number) });
});
