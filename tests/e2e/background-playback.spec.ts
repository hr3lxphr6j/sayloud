import type { Page } from '@playwright/test';
import { control, expect, test } from './fixtures';

/** Must match `lib/settings-store.ts`; e2e specs do not resolve the `~` alias. */
const SETTINGS_KEY = 'sayloud:settings';

/**
 * Write the settings the way the side panel does, from an extension page.
 *
 * A content script's `chrome.storage` lives in its isolated world, which
 * Playwright cannot reach, and the service worker's own storage is not exposed
 * to the test either. An extension page's main world has the API.
 */
async function saveSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ([key, value]) => {
      const api = (
        globalThis as unknown as {
          chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };
        }
      ).chrome;
      return api.storage.local.set({ [key as string]: value });
    },
    [SETTINGS_KEY, settings]
  );
}

test.describe('playing while another tab has the focus', () => {
  test('keeps reading when the user switches to another tab', async ({
    context,
    page,
    activate,
  }) => {
    await page.goto('/article.html');
    await activate();
    await expect(control(page, 'Pause')).toBeVisible();

    const other = await context.newPage();
    await other.bringToFront();

    // Long enough for a pause, if one were coming, to have arrived.
    await page.waitForTimeout(1_000);

    // The default is to keep going: switching tabs to look something up must
    // not stop the reading.
    await expect(control(page, 'Pause')).toBeVisible();
    await expect(control(page, 'Play')).toHaveCount(0);

    await other.close();
  });

  test('pauses when the setting is turned off', async ({
    context,
    extensionId,
    page,
    activate,
  }) => {
    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await saveSettings(settingsPage, { keepPlayingInBackground: false });
    await settingsPage.close();
    // The service worker hears about the change through `storage.onChanged`.
    await page.waitForTimeout(200);

    await page.goto('/article.html');
    await activate();
    await expect(control(page, 'Pause')).toBeVisible();

    const other = await context.newPage();
    await other.bringToFront();

    await expect(control(page, 'Play')).toBeVisible();

    await other.close();
  });
});
