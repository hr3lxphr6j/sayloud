import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import type { PdfAssetUrls } from './assets';
import type { PdfOpenError, PdfPageText, PdfTextItem } from './types';

/**
 * How many times the reader may ask for a password before the open fails.
 *
 * PDF.js reports a wrong password by rejecting the whole loading task, so every
 * retry is a fresh task and the counter lives here rather than in PDF.js.
 */
const MAX_PASSWORD_ATTEMPTS = 3;

/** An open PDF document, ready to hand out one page's text at a time. */
export interface PdfDocument {
  /** Number of pages, as reported by PDF.js. */
  readonly pageCount: number;
  /** Text items of a 1-based page, in content-stream order. */
  getPageText(pageNumber: number): Promise<PdfPageText>;
  /** Release the document and its worker. */
  destroy(): Promise<void>;
}

function isPasswordException(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'PasswordException'
  );
}

/**
 * Open a PDF from bytes, prompting for a password only when PDF.js says the
 * document is encrypted.
 *
 * Resolves with a handle rather than a bare page count because the caller needs
 * the document alive to read pages and must be able to dispose of its worker.
 * Rejects with a {@link PdfOpenError} string — never with a PDF.js exception,
 * whose messages are not meant for users.
 */
export async function openPdf(
  bytes: ArrayBuffer,
  assets: PdfAssetUrls,
  askPassword: () => Promise<string | null>
): Promise<PdfDocument> {
  if (bytes.byteLength === 0) return Promise.reject('empty' satisfies PdfOpenError);

  const pdf = await openDocument(bytes, assets, askPassword);

  return {
    pageCount: pdf.numPages,
    async getPageText(pageNumber: number): Promise<PdfPageText> {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const textItems: PdfTextItem[] = [];

      for (const entry of content.items) {
        // Marked-content markers carry no `str`; keeping them would break the
        // one-DOM-child-per-item invariant the text layer relies on.
        if (!('str' in entry)) continue;
        textItems.push({
          str: entry.str,
          hasEOL: entry.hasEOL ?? false,
          nodeIndex: textItems.length,
        });
      }

      return { pageNumber, items: textItems };
    },
    destroy: () => pdf.destroy(),
  };
}

/**
 * Run the get-document/prompt loop until PDF.js accepts a password.
 *
 * Attempt 0 passes no password, so an unencrypted document never prompts. Each
 * later attempt gets its own copy of the bytes: PDF.js transfers the buffer to
 * its worker, so reusing one would hand the next attempt a detached buffer.
 */
async function openDocument(
  bytes: ArrayBuffer,
  assets: PdfAssetUrls,
  askPassword: () => Promise<string | null>
): Promise<PDFDocumentProxy> {
  GlobalWorkerOptions.workerSrc = assets.workerSrc;

  let password: string | undefined;

  for (let attempt = 0; attempt <= MAX_PASSWORD_ATTEMPTS; attempt++) {
    let task: PDFDocumentLoadingTask | undefined;
    try {
      task = getDocument({
        data: new Uint8Array(bytes.slice(0)),
        isEvalSupported: false,
        useSystemFonts: false,
        cMapUrl: assets.cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: assets.standardFontDataUrl,
        password,
      });
      return await task.promise;
    } catch (error) {
      // A failed task holds its worker until destroyed; the retry must not leak it.
      await task?.destroy().catch(() => undefined);

      if (!isPasswordException(error)) return Promise.reject('invalid' satisfies PdfOpenError);
      // Every allowed prompt has been answered, and the last answer was wrong.
      if (attempt === MAX_PASSWORD_ATTEMPTS) {
        return Promise.reject('password' satisfies PdfOpenError);
      }

      const answer = await askPassword();
      if (answer === null) return Promise.reject('cancelled' satisfies PdfOpenError);
      password = answer;
    }
  }

  return Promise.reject('password' satisfies PdfOpenError);
}
