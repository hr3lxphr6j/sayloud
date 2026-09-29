import { control, expect, test } from './fixtures';
import { sentenceHighlight } from './helpers';

/** Pause first: the highlight then only moves when the test asks it to. */
async function pause(page: import('@playwright/test').Page) {
  await control(page, 'Pause').click();
  await expect(control(page, 'Play')).toBeVisible();
}

test.describe('playback controls', () => {
  test('pause holds the sentence and play resumes', async ({ page, activate }) => {
    await page.goto('/article.html');
    await activate();
    await expect(control(page, 'Pause')).toBeVisible();

    await pause(page);

    const held = await sentenceHighlight(page);
    expect(held).not.toBe('');
    // Nothing is being spoken, so the highlight must not drift.
    await page.waitForTimeout(1_500);
    expect(await sentenceHighlight(page)).toBe(held);

    await control(page, 'Play').click();
    await expect(control(page, 'Pause')).toBeVisible();
  });

  test('next and previous move the highlight', async ({ page, activate }) => {
    await page.goto('/article.html');
    await activate();
    await expect(control(page, 'Pause')).toBeVisible();
    await pause(page);

    await control(page, 'Next sentence').click();
    await expect.poll(() => sentenceHighlight(page)).toContain('second sentence');

    await control(page, 'Previous sentence').click();
    await expect.poll(() => sentenceHighlight(page)).toContain('first sentence');
  });

  test('the ends of the document disable the sentence controls', async ({ page, activate }) => {
    await page.goto('/article.html');
    await activate();
    await expect(control(page, 'Pause')).toBeVisible();
    await pause(page);

    await expect(control(page, 'Previous sentence')).toBeDisabled();

    for (let i = 0; i < 6; i++) {
      const next = control(page, 'Next sentence');
      if (await next.isDisabled()) break;
      await next.click();
    }

    await expect(control(page, 'Next sentence')).toBeDisabled();
  });

  test('the speed control steps through the preset rates', async ({ page, activate }) => {
    await page.goto('/article.html');
    await activate();
    await expect(control(page, 'Pause')).toBeVisible();

    await control(page, 'Playback speed 1×').click();
    await expect(control(page, 'Playback speed 1.25×')).toBeVisible();

    await control(page, 'Playback speed 1.25×').click();
    await expect(control(page, 'Playback speed 1.5×')).toBeVisible();
  });

  test('the arrow keys and space work when the bar has focus', async ({ page, activate }) => {
    await page.goto('/article.html');
    await activate();
    await expect(control(page, 'Pause')).toBeVisible();

    const bar = page.getByRole('toolbar', { name: 'SayLoud' });
    await bar.focus();

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => sentenceHighlight(page)).toContain('second sentence');

    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => sentenceHighlight(page)).toContain('first sentence');

    await page.keyboard.press(' ');
    await expect(control(page, 'Play')).toBeVisible();

    await page.keyboard.press(' ');
    await expect(control(page, 'Pause')).toBeVisible();
  });
});
