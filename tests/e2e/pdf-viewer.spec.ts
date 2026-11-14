/**
 * The PDF viewer page.
 *
 * Opened as an extension page rather than injected, because a PDF tab has no
 * prose for the content script's extractor to find. One test covers the file
 * picker, one the toolbar handoff, and one the missing-bytes screen both of
 * them fall back to.
 */
import path from 'node:path';
import { BASE_URL, expect, test } from './fixtures';

const HELLO = path.resolve(process.cwd(), 'tests/fixtures/pdf/hello.pdf');

test.describe('the pdf viewer', () => {
  test('turns a chosen PDF into a document the bar can read', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/pdf-viewer.html`);

    // The picker is the only thing to do before a document is open.
    await page.locator('input[type=file]').setInputFiles(HELLO);

    // The text layer is real DOM: its words are selectable text, which is what
    // the reader builds its sentences and highlights from.
    await expect(page.locator('.pdf-text-layer')).toContainText('Hello', { timeout: 15_000 });

    // The existing bar is mounted over the page, and it has not concluded that
    // the document is unreadable.
    await expect(page.locator('.side-player')).toBeVisible();
    await expect(page.getByText('SayLoud found no readable text on this page.')).toHaveCount(0);

    // The reading-order line is part of the page, not a dismissible hint.
    await expect(page.locator('.pdf-order-hint')).toContainText('PDF text order');
  });

  test('says the PDF could not be read when its hash has no bytes', async ({
    page,
    extensionId,
  }) => {
    await page.goto(`chrome-extension://${extensionId}/pdf-viewer.html#missing`);

    await expect(page.getByText('This PDF could not be read')).toBeVisible();
    await expect(page.locator('input[type=file]')).toBeAttached();
  });

  /**
   * The toolbar handoff: a PDF tab is opened in the viewer with its bytes, and
   * the tab the user was reading stays open. Playwright cannot click the icon,
   * so `activate` calls the same entry point the click does.
   *
   * Only online PDFs are covered here. A persistent context gives the extension
   * no access to `file:` URLs, so the injected fetch cannot succeed and the
   * click would land on the missing screen; that path, including the file
   * picker it leaves the user with, is the test above.
   */
  test('opens the viewer on the pdf the icon was clicked on', async ({
    page,
    context,
    extensionId,
    activate,
  }) => {
    await page.goto(`${BASE_URL}/pdf/hello.pdf`);

    const [viewer] = await Promise.all([context.waitForEvent('page'), activate()]);

    // The new tab is the extension's own page, with the hash the viewer reads.
    await expect(viewer).toHaveURL(
      new RegExp(`^chrome-extension://${extensionId}/pdf-viewer\\.html#`)
    );

    // The bytes made the trip: the page's text layer is built from them.
    await expect(viewer.locator('.pdf-text-layer')).toContainText('Hello', { timeout: 15_000 });

    // The PDF tab is kept, not replaced by the viewer.
    expect(page.isClosed()).toBe(false);
  });
});
