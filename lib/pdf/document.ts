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
 * PDF.js keeps the same loading task (and worker) alive while the password is
 * retried through `onPassword`, so the counter lives here: the fourth password
 * request is refused without prompting again.
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
 * Start the single loading task, reporting a synchronous refusal as `null`.
 *
 * A copy of the bytes keeps PDF.js from detaching the caller's ArrayBuffer when
 * it hands `data` over to the worker.
 */
function startTask(bytes: ArrayBuffer, assets: PdfAssetUrls): PDFDocumentLoadingTask | null {
  try {
    return getDocument({
      data: new Uint8Array(bytes.slice(0)),
      isEvalSupported: false,
      useSystemFonts: false,
      cMapUrl: assets.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: assets.standardFontDataUrl,
    });
  } catch {
    return null;
  }
}

/**
 * Start one loading task and answer its password requests until it settles.
 *
 * PDF.js reports a needed or wrong password through `onPassword` on the same
 * task; passing the password back re-runs only the authentication step, so a
 * typo does not re-parse the document or restart its worker. An unencrypted
 * document never calls the handler at all.
 */
async function openDocument(
  bytes: ArrayBuffer,
  assets: PdfAssetUrls,
  askPassword: () => Promise<string | null>
): Promise<PDFDocumentProxy> {
  GlobalWorkerOptions.workerSrc = assets.workerSrc;

  const task = startTask(bytes, assets);
  if (!task) return Promise.reject('invalid' satisfies PdfOpenError);

  const state: { outcome: PdfOpenError | null; promptFailure: unknown } = {
    outcome: null,
    promptFailure: null,
  };
  let prompts = 0;

  task.onPassword = (updatePassword: (password: string | Error) => void): void => {
    if (prompts >= MAX_PASSWORD_ATTEMPTS) {
      // The last allowed answer was rejected: fail without a fourth prompt.
      state.outcome = 'password';
      updatePassword(new Error('Password attempts exhausted'));
      return;
    }
    prompts += 1;

    const failPrompt = (error: unknown): void => {
      state.promptFailure = error;
      updatePassword(error instanceof Error ? error : new Error(String(error)));
    };

    let answer: Promise<string | null>;
    try {
      answer = askPassword();
    } catch (error) {
      failPrompt(error);
      return;
    }

    answer.then((password) => {
      if (password === null) {
        state.outcome = 'cancelled';
        updatePassword(new Error('Password prompt cancelled'));
        return;
      }
      updatePassword(password);
    }, failPrompt);
  };

  try {
    return await task.promise;
  } catch {
    // A rejected task can still hold its worker; destroy it before giving up.
    await task.destroy().catch(() => undefined);
    if (state.outcome) return Promise.reject(state.outcome);
    if (state.promptFailure) return Promise.reject(state.promptFailure);
    return Promise.reject('invalid' satisfies PdfOpenError);
  }
}
