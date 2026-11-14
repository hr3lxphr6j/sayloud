export interface PdfTextItem {
  str: string;
  /** PDF.js text item 的 hasEOL。 */
  hasEOL: boolean;
  /** 在该页文本层容器里的子节点下标，构建时写入。 */
  nodeIndex: number;
}

/** Why {@link openPdf} refused to open a document. */
export type PdfOpenError = 'empty' | 'invalid' | 'password' | 'cancelled';

/** One page's text items, in the order pdf.js emitted them. */
export interface PdfPageText {
  /** 1-based, matching the value handed to PDF.js `getPage`. */
  pageNumber: number;
  items: PdfTextItem[];
}
