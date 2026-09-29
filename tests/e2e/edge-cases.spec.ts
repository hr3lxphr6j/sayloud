import { control, expect, HOST_ID, test } from './fixtures';
import { bubble, sentenceHighlight } from './helpers';

test.describe('pages SayLoud cannot read', () => {
  test('explains a page with no readable text', async ({ page, activate }) => {
    await page.goto('/empty.html');
    await activate();

    // The bar still appears, so the reader is told what happened rather than
    // being left wondering why nothing is being read.
    await expect(page.locator(`#${HOST_ID}`)).toBeAttached();
    await expect(bubble(page)).toContainText('Nothing to read');
    await expect(bubble(page)).toContainText('no readable text');

    // Nothing was handed to the engine, so there is nothing to play.
    await expect(control(page, 'Play')).toBeDisabled();
    expect(await sentenceHighlight(page)).toBe('');
  });

  test('reads a page that only has a little text', async ({ page, activate }) => {
    await page.goto('/article.html');
    await activate();

    await expect
      .poll(() => sentenceHighlight(page), { timeout: 10_000 })
      .toContain('first sentence');
  });
});
