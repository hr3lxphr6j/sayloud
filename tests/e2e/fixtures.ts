import path from 'node:path';
import {
  type BrowserContext,
  test as base,
  chromium,
  expect,
  type Page,
  type Worker,
} from '@playwright/test';

/** Built by `global-setup.ts` from `wxt.config.ts`'s e2e mode. */
export const EXTENSION_PATH = path.resolve(process.cwd(), '.output-e2e/chrome-mv3');

/** Must match `tests/e2e/server.mjs` and the manifest's host permission. */
export const BASE_URL = `http://127.0.0.1:${process.env.SAYLOUD_E2E_PORT ?? 8787}`;

/** The shadow host the content script mounts the player into. */
export const HOST_ID = 'sayloud-host';

interface Fixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  page: Page;
  /**
   * Start reading in the current tab.
   *
   * Playwright cannot click the extension's toolbar icon, so the e2e build
   * exposes `sayloudActivate()` on the service worker's global scope. It takes
   * the same path as the real click: resolve the active tab, then inject.
   */
  activate: () => Promise<void>;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern for a fixture's first argument, and this fixture needs nothing from it.
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      // The UI follows the browser's language when the setting is `auto`, and
      // these specs are written in English. Pinned so the language a spec runs
      // in does not depend on the machine it runs on.
      locale: 'en-US',
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--mute-audio',
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(serviceWorker.url().split('/')[2] ?? '');
  },

  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },

  activate: async ({ page, serviceWorker }, use) => {
    await use(async () => {
      // `tabs.query({ active: true })` only sees the tab if it is focused.
      await page.bringToFront();
      await serviceWorker.evaluate(() => globalThis.sayloudActivate?.());
    });
  },
});

/** The shadow root of the mounted player, as an HTML string. */
export async function shadowHtml(page: Page): Promise<string> {
  return page.evaluate((id) => {
    const host = document.getElementById(id);
    return host?.shadowRoot?.innerHTML ?? '';
  }, HOST_ID);
}

/**
 * A control inside the player.
 *
 * Playwright's role selectors pierce open shadow roots, so no manual
 * `shadowRoot` traversal is needed here. Names are matched exactly: "Play"
 * would otherwise also match the rate control's "Playback speed 1x" label.
 */
export function control(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

export { expect };
