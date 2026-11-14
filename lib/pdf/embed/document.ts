import type { PluginRegistry } from '@embedpdf/core';
import { createPdfiumEngine as createDirectEngine } from '@embedpdf/engines/pdfium-direct-engine';
import { createPdfiumEngine as createWorkerEngine } from '@embedpdf/engines/pdfium-worker-engine';
import {
  type PdfDocumentObject,
  type PdfEngine,
  PdfErrorCode,
  type PdfErrorReason,
  type PdfTextRectObject,
} from '@embedpdf/models';
import pdfiumWasm from '@embedpdf/pdfium/pdfium.wasm?url';
import type { DocumentManagerCapability } from '@embedpdf/plugin-document-manager';
import { browser } from 'wxt/browser';

/** The engine the viewer drives; PDFium hands back page rasters as blobs. */
export type EmbedEngine = PdfEngine<Blob>;

/** The plugin id, spelled once so a rename is a compile error everywhere. */
const DOCUMENT_MANAGER = 'document-manager';

/** How many times a password is asked for before the open is called off. */
export const MAX_PASSWORD_ATTEMPTS = 3;

/** What an open document handle carries. */
export interface OpenedDocument {
  documentId: string;
  document: PdfDocumentObject;
}

/**
 * A failed open, with the document id and PDFium's own reason.
 *
 * `DocumentManagerCapability.openDocumentBuffer` resolves with the id *before*
 * the parse finishes, so the rejection alone loses the id that
 * `retryDocument` needs for a password retry. This is what keeps the two
 * together.
 */
export class EmbedOpenError extends Error {
  constructor(
    readonly reason: PdfErrorReason | null,
    readonly documentId: string | null
  ) {
    super(reason?.message ?? 'the pdf could not be opened');
    this.name = 'EmbedOpenError';
  }
}

/** Whether a failed open is PDFium asking for (or rejecting) a password. */
export function isPasswordError(reason: PdfErrorReason | null): boolean {
  return reason?.code === PdfErrorCode.Password;
}

/**
 * Where the PDFium wasm lives inside the extension.
 *
 * Imported as an asset rather than copied into `public/`: Vite emits it once
 * under `assets/`, with a hash, and the worker bundle's own fallback URL points
 * at that same file — copying a second copy was how the POC ended up shipping
 * 4.65 MB twice. The viewer is an extension page, so the URL is same-origin and
 * needs no `web_accessible_resources` entry.
 */
export function pdfiumWasmUrl(): string {
  // `?url` yields a root-relative path. The worker engine runs in a blob
  // worker, where a relative fetch has no useful base URL, so resolve it
  // against the extension origin before handing it over.
  return new URL(pdfiumWasm, browser.runtime.getURL('/')).toString();
}

/**
 * Create the PDF engine.
 *
 * The worker engine keeps PDFium off the page's main thread, which is what
 * keeps a heavy page from stalling the reader's UI. It is created
 * synchronously; a worker that cannot start fails on its first task. The
 * direct engine is the fallback for exactly that case — it is verified to work
 * in this extension (see docs/research/embedpdf-poc-report.md) — at the cost
 * of rendering on the main thread.
 *
 * `fontFallback: null` keeps PDFium from fetching fonts over the network: an
 * extension page has no business making that request, and pages without
 * embedded fonts render from the system's fonts anyway (tested for CJK).
 */
export async function createPdfEngine(wasmUrl = pdfiumWasmUrl()): Promise<EmbedEngine> {
  try {
    return createWorkerEngine(wasmUrl, { fontFallback: null });
  } catch (error) {
    console.warn('[SayLoud] the pdf worker could not start; using the main thread', error);
    return createDirectEngine(wasmUrl, { fontFallback: null });
  }
}

/** The document manager's capability, or null before the plugin is ready. */
export function documentManager(registry: PluginRegistry | null): DocumentManagerCapability | null {
  if (!registry) return null;
  const plugin = registry.getPlugin(DOCUMENT_MANAGER);
  const provides = plugin?.provides?.() as DocumentManagerCapability | undefined;
  return provides ?? null;
}

/**
 * Open bytes as a document, reporting failures with their document id.
 *
 * The outer task allocates the id immediately; the inner task is the parse.
 * Both can reject, and only the inner one carries PDFium's reason, so the
 * outer's id is kept even when the inner one fails.
 */
export async function openPdfDocument(
  registry: PluginRegistry | null,
  bytes: ArrayBuffer,
  name: string,
  password?: string
): Promise<OpenedDocument> {
  const capability = documentManager(registry);
  if (!capability) throw new EmbedOpenError(null, null);

  let documentId: string | null = null;
  try {
    const opened = await capability
      .openDocumentBuffer({ buffer: bytes, name, ...(password ? { password } : {}) })
      .toPromise();
    documentId = opened.documentId;
    const document = await opened.task.toPromise();
    return { documentId, document };
  } catch (error) {
    throw new EmbedOpenError(reasonOf(error), documentId);
  }
}

/** Retry a document that failed to open, with another password. */
export async function retryPdfDocument(
  registry: PluginRegistry | null,
  documentId: string,
  password: string
): Promise<OpenedDocument> {
  const capability = documentManager(registry);
  if (!capability) throw new EmbedOpenError(null, documentId);

  try {
    const opened = await capability.retryDocument(documentId, { password }).toPromise();
    const document = await opened.task.toPromise();
    return { documentId, document };
  } catch (error) {
    throw new EmbedOpenError(reasonOf(error), documentId);
  }
}

/** Close every open document; used before a new file replaces the old one. */
export async function closePdfDocuments(registry: PluginRegistry | null): Promise<void> {
  const capability = documentManager(registry);
  if (!capability) return;
  for (const state of capability.getOpenDocuments()) {
    try {
      await capability.closeDocument(state.id).toPromise();
    } catch (error) {
      console.warn('[SayLoud] could not close a previous pdf', error);
    }
  }
}

/**
 * One page's text rectangles, cached per document.
 *
 * The viewer rebuilds its spans on every zoom, and a rebuild must not re-run
 * PDFium's text extraction: the text does not change, only the scale. The
 * cache is dropped with the document, so a second file never reads the first
 * one's geometry.
 */
const rectCache = new WeakMap<PdfDocumentObject, Map<number, PdfTextRectObject[]>>();

/** Text rectangles of a page, in PDF points, in PDFium's text order. */
export async function pageTextRects(
  engine: EmbedEngine,
  doc: PdfDocumentObject,
  pageIndex: number
): Promise<PdfTextRectObject[]> {
  let pages = rectCache.get(doc);
  if (!pages) {
    pages = new Map();
    rectCache.set(doc, pages);
  }
  const cached = pages.get(pageIndex);
  if (cached) return cached;

  const page = doc.pages[pageIndex];
  if (!page) return [];
  const rects = await engine.getPageTextRects(doc, page).toPromise();
  pages.set(pageIndex, rects);
  return rects;
}

/** PDFium hands its reason through a `TaskError`; unwrap it for callers. */
function reasonOf(error: unknown): PdfErrorReason | null {
  if (error && typeof error === 'object') {
    const candidate = error as { reason?: unknown; code?: unknown; message?: unknown };
    if (candidate.reason && typeof candidate.reason === 'object') {
      return candidate.reason as PdfErrorReason;
    }
    if (typeof candidate.code === 'number') {
      return candidate as PdfErrorReason;
    }
  }
  return null;
}
