/**
 * The saved rate, in a real browser.
 *
 * The rate is the one preference that has to reach two places: the content
 * script reads it for the `load` command that starts a session, and the service
 * worker pushes it into a session that is already running (spec §11 T4).
 * Neither is visible to a unit test — one is built inside a shadow DOM by an
 * entrypoint, the other is a subscription in a service worker — so the
 * assertion is the rate the player's own button shows, which is the number the
 * engine reports.
 */
import type { Worker } from '@playwright/test';
import { control, expect, test } from './fixtures';

/** Must match `SETTINGS_KEY`; storage keys are plain strings, as in the smoke. */
const SETTINGS_KEY = 'sayloud:settings';

/** The bits of `chrome` this spec touches, from inside the worker. */
interface ChromeLike {
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
}

/** Write the preference the way the settings panel does. */
async function saveRate(serviceWorker: Worker, rate: number): Promise<void> {
  await serviceWorker.evaluate(
    ({ key, value }) => {
      const chrome = (globalThis as unknown as { chrome: ChromeLike }).chrome;
      return chrome.storage.local.set({ [key]: { rate: value } });
    },
    { key: SETTINGS_KEY, value: rate }
  );
}

test('a new session starts at the saved rate', async ({ page, serviceWorker, activate }) => {
  // Saved before the reader is injected: the rate travels in the `load`
  // command, so it has to be in storage by then.
  await saveRate(serviceWorker, 2);

  await page.goto('/article.html');
  await activate();

  await expect(control(page, 'Playback speed 2×')).toBeVisible();
});

test('a rate change reaches a session that is already reading', async ({
  page,
  serviceWorker,
  activate,
}) => {
  await page.goto('/article.html');
  await activate();
  await expect(control(page, 'Pause')).toBeVisible();
  await expect(control(page, 'Playback speed 1×')).toBeVisible();

  await saveRate(serviceWorker, 0.5);

  await expect(control(page, 'Playback speed 0.5×')).toBeVisible();
});
