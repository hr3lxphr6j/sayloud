import { control, expect, HOST_ID, test } from './fixtures';
import { sentenceHighlight, terminateServiceWorker, wordHighlight } from './helpers';

test.describe('reading a page with the browser voice', () => {
  test('starts reading and highlights the sentence and the spoken word', async ({
    page,
    activate,
  }) => {
    await page.goto('/article.html');
    await activate();

    // The bar is the reader's only control surface, so it has to be there.
    await expect(page.locator(`#${HOST_ID}`)).toBeAttached();
    await expect(control(page, 'Pause')).toBeVisible();

    // The first sentence is highlighted before any audio arrives.
    await expect
      .poll(() => sentenceHighlight(page), { timeout: 10_000 })
      .toContain('first sentence');

    // `chrome.tts` word events drive the second layer.
    await expect.poll(() => wordHighlight(page), { timeout: 10_000 }).not.toBe('');
  });

  test('moves on to the next sentence on its own', async ({ page, activate }) => {
    await page.goto('/article.html');
    await activate();

    await expect
      .poll(() => sentenceHighlight(page), { timeout: 15_000 })
      .toContain('second sentence');
  });

  test('reports progress through the page', async ({ page, activate }) => {
    await page.goto('/article.html');
    await activate();

    const ring = page.getByRole('button', { name: /Reading progress/ });
    await expect(ring).toBeVisible();

    await expect
      .poll(
        async () => Number((await ring.getAttribute('aria-label'))?.match(/(\d+) percent/)?.[1]),
        {
          timeout: 15_000,
        }
      )
      .toBeGreaterThan(0);
  });

  test('does not stack a second player when the icon is clicked again', async ({
    page,
    activate,
  }) => {
    await page.goto('/article.html');
    await activate();
    await expect(page.locator(`#${HOST_ID}`)).toBeAttached();

    await activate();

    await expect(page.locator(`#${HOST_ID}`)).toHaveCount(1);
  });

  test('renders the 28px bar against the right edge', async ({ page, activate }) => {
    await page.goto('/article.html');
    await activate();

    const bar = page.getByRole('toolbar', { name: 'SayLoud' });
    await expect(bar).toBeVisible();

    const box = await bar.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error('the bar was never laid out');

    // The spec fixes the bar at 28px wide, pinned to the right edge in a single
    // column. A taller-than-wide box is what makes it a bar and not a panel.
    expect(box.width).toBe(28);
    expect(viewport.width - (box.x + box.width)).toBeLessThanOrEqual(16);
    expect(box.height).toBeGreaterThan(box.width);
  });

  test('resumes a paused session after the worker is recycled', async ({
    page,
    context,
    activate,
  }) => {
    await page.goto('/article.html');
    await activate();
    await expect(control(page, 'Pause')).toBeVisible();
    await expect
      .poll(() => sentenceHighlight(page), { timeout: 10_000 })
      .toContain('first sentence');

    await terminateServiceWorker(context, page);

    // A restored session always lands in `paused`: the reader is no longer
    // mid-gesture, and chrome.tts would need a fresh call anyway. Seeing Play
    // here proves the content script reconnected and got a new status, and the
    // surviving highlight proves the snapshot carried the position.
    await expect(control(page, 'Play')).toBeVisible();
    expect(await sentenceHighlight(page)).toContain('first sentence');
  });
});
