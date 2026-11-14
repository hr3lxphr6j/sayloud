/**
 * The PDF viewer page.
 *
 * Opened as an extension page rather than injected, because a PDF tab has no
 * prose for the content script's extractor to find. One test covers the file
 * picker, one the toolbar handoff, and one the missing-bytes screen both of
 * them fall back to.
 */
import path from 'node:path';
import { BASE_URL, control, expect, test } from './fixtures';
import { sentenceHighlight } from './helpers';

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

  /**
   * A paper served from a URL that does not end in `.pdf`, the arXiv shape.
   *
   * The URL cannot say what the tab holds, so the click has to ask the document
   * for its own MIME type; Chrome renders this response with the built-in
   * viewer, and the answer is what routes the click to SayLoud's viewer.
   */
  test('opens the viewer on a pdf the url does not name', async ({
    page,
    context,
    extensionId,
    activate,
  }) => {
    await page.goto(`${BASE_URL}/paper/2301.12345v1`);

    const [viewer] = await Promise.all([context.waitForEvent('page'), activate()]);

    await expect(viewer).toHaveURL(
      new RegExp(`^chrome-extension://${extensionId}/pdf-viewer\\.html#`)
    );
    // The bytes made the trip from the extension-less URL.
    await expect(viewer.locator('.pdf-text-layer')).toContainText('Hello', { timeout: 15_000 });
    expect(page.isClosed()).toBe(false);
  });

  test('starts reading a pdf and highlights the sentence', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/pdf-viewer.html`);
    await page.locator('input[type=file]').setInputFiles(HELLO);

    // Wait for the text layer to be built.
    await expect(page.locator('.pdf-text-layer')).toContainText('Hello', { timeout: 15_000 });

    // The bar starts paused on a freshly opened document.
    await expect(page.locator('.side-player')).toBeVisible();
    await expect(control(page, 'Play')).toBeVisible();

    // Click play and verify the first sentence is highlighted.
    await control(page, 'Play').click();
    await expect.poll(() => sentenceHighlight(page), { timeout: 10_000 }).toContain('Hello');
  });

  test('paints the sentence over the page and zooms the text layer with it', async ({
    page,
    extensionId,
  }) => {
    await page.goto(`chrome-extension://${extensionId}/pdf-viewer.html`);
    await page.locator('input[type=file]').setInputFiles(HELLO);
    await expect(page.locator('.pdf-text-layer')).toContainText('Hello', { timeout: 15_000 });

    // PDFium paints the page as an image, so the visible highlight is the
    // rectangle layer the viewer draws from PDFium's own text boxes. The
    // `CSS.highlights` range above is what the reader registers; this is what
    // is actually on screen.
    if (await control(page, 'Pause').count()) await control(page, 'Pause').click();
    await control(page, 'Play').click();
    await expect
      .poll(() => page.locator('.pdf-highlight-rect').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Zooming is EmbedPDF's own plugin: the percentage moves and the text
    // layer is rebuilt at the new scale with the highlight still on it.
    const zoom = page.locator('.pdf-zoom-level');
    const before = await zoom.innerText();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => zoom.innerText(), { timeout: 10_000 }).not.toBe(before);
    await expect(page.locator('.pdf-text-layer')).toContainText('Hello');
    expect(await page.locator('.pdf-highlight-rect').count()).toBeGreaterThan(0);
  });
});
