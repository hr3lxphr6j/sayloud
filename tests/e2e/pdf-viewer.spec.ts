/**
 * The PDF viewer page.
 *
 * Opened as an extension page rather than injected, because a PDF tab has no
 * prose for the content script's extractor to find. The file picker is the path
 * this task owns; the hash handoff from the toolbar icon belongs to a later
 * task, so only its failure branch is covered here.
 */
import path from 'node:path';
import { expect, test } from './fixtures';

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
    // The worker's `pdf-bytes` handler arrives in a later task; until then this
    // is the viewer's honest answer, and it must offer the picker as a way out.
    await page.goto(`chrome-extension://${extensionId}/pdf-viewer.html#missing`);

    await expect(page.getByText('This PDF could not be read')).toBeVisible();
    await expect(page.locator('input[type=file]')).toBeAttached();
  });
});
