/**
 * The caption window, opened from the bar on the page.
 *
 * Chromium exposes a Document Picture-in-Picture window as an extra page in the
 * browsing context, so this spec can read what the window actually shows —
 * the sentence, the sentence count and the word mark — rather than only
 * checking that a button appeared. (The window is the `about:blank` page that
 * appears alongside the article.)
 */
import type { BrowserContext, Page } from '@playwright/test';
import { control, expect, test } from './fixtures';

/** The window the click opened, once Chromium has made it. */
async function captionWindow(context: BrowserContext, before: Page[]): Promise<Page> {
  const known = new Set(before);
  await expect.poll(() => context.pages().length).toBe(before.length + 1);

  const opened = context.pages().find((page) => !known.has(page));
  if (!opened) throw new Error('the caption window never appeared');
  return opened;
}

/** What the caption window is showing, or '' while its document is still empty. */
async function captionText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body?.textContent ?? '');
  } catch {
    return '';
  }
}

test('opens the caption window from the bar and closes it again', async ({
  context,
  page,
  activate,
}) => {
  await page.goto('/article.html');
  await activate();
  await expect(control(page, 'Pause')).toBeVisible();

  const before = context.pages();
  await control(page, 'Caption window').click();
  const caption = await captionWindow(context, before);

  await expect
    .poll(() => captionText(caption))
    .toContain('The first sentence is deliberately short.');
  await expect.poll(() => captionText(caption)).toMatch(/Sentence 1 of \d+/);
  // The browser voice reports word boundaries, so the spoken word is marked.
  await expect.poll(() => captionText(caption)).not.toBe('');
  await expect(caption.locator('mark')).not.toHaveText('');

  await control(page, 'Caption window').click();
  await expect.poll(() => context.pages().length).toBe(before.length);
});

test('offers the caption button without any setting', async ({ page, activate }) => {
  await page.goto('/article.html');
  await activate();
  await expect(control(page, 'Pause')).toBeVisible();

  await expect(control(page, 'Caption window')).toHaveCount(1);
});
