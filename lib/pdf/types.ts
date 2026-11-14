/**
 * Types that cross the PDF viewer's module boundaries.
 *
 * The viewer drives EmbedPDF/PDFium, whose document and text-rectangle shapes
 * are re-exported here so `lib/pdf/embed/*` callers do not have to reach into
 * `@embedpdf/models` for them.
 */
export type {
  PdfDocumentObject as EmbedPdfDocument,
  PdfTextRectObject as EmbedPdfTextRect,
} from '@embedpdf/models';
