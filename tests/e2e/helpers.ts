/**
 * Read the text currently under a highlight layer.
 *
 * The content script registers the ranges in the shared `CSS.highlights`
 * registry, so the page's own world can see them.
 */
export async function highlighted(page: import('@playwright/test').Page, name: string) {
  return page.evaluate((key) => {
    const highlight = CSS.highlights.get(key);
    if (!highlight) return '';
    return Array.from(highlight)
      .map((range) => range.toString())
      .join('');
  }, name);
}

export function sentenceHighlight(page: import('@playwright/test').Page) {
  return highlighted(page, 'sayloud-sentence');
}

export function wordHighlight(page: import('@playwright/test').Page) {
  return highlighted(page, 'sayloud-word');
}

/** Must match `lib/settings-store.ts`; e2e specs do not resolve the `~` alias. */
const SETTINGS_KEY = 'sayloud:settings';

/**
 * Write behaviour preferences the way the side panel does.
 *
 * From an extension page, because a content script's `chrome.storage` lives in
 * its isolated world, which Playwright cannot reach, and the service worker's
 * own storage is not exposed to the test either.
 */
export async function saveSettings(
  page: import('@playwright/test').Page,
  settings: Record<string, unknown>
): Promise<void> {
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

/** The bubble card, wherever the player has opened one. */
export function bubble(page: import('@playwright/test').Page) {
  return page.getByRole('status');
}

/**
 * Kill the extension's service worker, the way Chrome's idle timeout would.
 *
 * MV3 terminates an idle worker without warning, and the only way to reproduce
 * that from a test is to close the worker's target over CDP.
 */
export async function terminateServiceWorker(
  context: import('@playwright/test').BrowserContext,
  page: import('@playwright/test').Page
): Promise<void> {
  const client = await context.newCDPSession(page);
  const { targetInfos } = await client.send('Target.getTargets');
  const worker = targetInfos.find((target) => target.type === 'service_worker');
  if (!worker) throw new Error('no service worker target to terminate');
  await client.send('Target.closeTarget', { targetId: worker.targetId });
  await client.detach();
}
