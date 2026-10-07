/**
 * The README's images.
 *
 * Not a test: it drives the same e2e bundle a spec does — a real Chrome, the
 * real extension, the bundled article and the stub TTS server — and writes PNGs
 * into `assets/`. Skipped unless `SAYLOUD_CAPTURE=1`, so neither `pnpm test:e2e`
 * nor CI ever writes images.
 *
 *     pnpm capture:screenshots
 *
 * Two things about what ends up in the frames. The host page is the test
 * fixture with a stylesheet added below, because the fixture deliberately ships
 * with none — the tests care about extraction and highlighting, not about how
 * the page looks. And the voice is the browser voice, because the images must
 * not depend on an API key or a 92 MB model download. Everything else in them is
 * the real thing, which also means they go stale when the UI moves: re-run the
 * command after a UI change and commit the diff.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { control, expect, test } from './fixtures';
import { saveSettings, sentenceHighlight } from './helpers';

const OUT = resolve(process.cwd(), 'assets');

/**
 * A stylesheet for the article, so the screenshots show a page rather than a
 * browser default. Nothing the extension does depends on it.
 */
const ARTICLE_CSS = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    background: #fbfbfa;
    color: #24292f;
    font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  article { max-width: 40rem; margin: 0 auto; padding: 72px 40px 160px; }
  h1 { font-size: 2.1rem; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 0.4em; }
  p { margin: 0 0 1.35em; }
`;

const PANEL_SIZE = { width: 380, height: 820 };

/** What each tab has to be showing before its screenshot is worth taking. */
const TAB_READY = {
  Reading: 'Reading session',
  Settings: 'Interface language',
  Models: 'Download source',
} as const;

/** Start reading with the browser voice, which needs no key and no download. */
async function startReading(page: Page, activate: () => Promise<void>): Promise<void> {
  await page.goto('/article.html');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addStyleTag({ content: ARTICLE_CSS });
  await activate();
  await expect(control(page, 'Pause')).toBeVisible();
  await expect.poll(() => sentenceHighlight(page)).toContain('first sentence');
}

/** The side panel, on one of its tabs, sized like a real one. */
async function openPanel(
  context: BrowserContext,
  extensionId: string,
  tab: keyof typeof TAB_READY
): Promise<Page> {
  const panel = await context.newPage();
  await panel.setViewportSize(PANEL_SIZE);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('tab', { name: tab }).click();
  await expect(panel.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText(TAB_READY[tab])).toBeVisible();
  return panel;
}

/** The window a caption-button click opened, once Chromium has made it. */
async function captionWindow(context: BrowserContext, before: Page[]): Promise<Page> {
  const known = new Set(before);
  await expect.poll(() => context.pages().length).toBe(before.length + 1);
  const opened = context.pages().find((candidate) => !known.has(candidate));
  if (!opened) throw new Error('the caption window never appeared');
  return opened;
}

/** What the caption window shows, or '' while its document is still empty. */
async function captionText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body?.textContent ?? '');
  } catch {
    return '';
  }
}

test.describe('README images', () => {
  test.skip(!process.env.SAYLOUD_CAPTURE, 'SAYLOUD_CAPTURE=1 writes the images');

  test('writes them', async ({ context, extensionId, page, activate }) => {
    await mkdir(OUT, { recursive: true });

    // The bar's caption button only appears once the reader has been told to
    // offer it, which is a setting.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await saveSettings(options, { captionWindow: true });
    await options.close();

    await startReading(page, activate);
    await page.screenshot({ path: join(OUT, 'reading.png') });

    for (const tab of ['Reading', 'Settings', 'Models'] as const) {
      const panel = await openPanel(context, extensionId, tab);
      await panel.screenshot({ path: join(OUT, `panel-${tab.toLowerCase()}.png`) });
      await panel.close();
    }

    const before = context.pages();
    await control(page, 'Caption window').click();
    const caption = await captionWindow(context, before);
    await expect.poll(() => captionText(caption)).toMatch(/Sentence 1 of \d+/);
    // Chromium hands Playwright the window as a page with the *browser's*
    // viewport, so the capture would be the caption centred in 1280x720 of white.
    // Tell it the size the window was requested at instead.
    await caption.setViewportSize({ width: 420, height: 180 });
    await caption.screenshot({ path: join(OUT, 'caption.png') });
  });
});
