export interface PdfTextItem {
  str: string;
  /** PDF.js text item 的 hasEOL。 */
  hasEOL: boolean;
  /** 在该页文本层容器里的子节点下标，构建时写入。 */
  nodeIndex: number;
}
