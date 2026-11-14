import type { EmbedBlock, EmbedRect } from './blocks';

/**
 * Draws highlight rectangles over PDFium-rendered pages.
 *
 * PDFium produces an `<img>`, not DOM text, so the rectangles are absolutely
 * positioned divs over the page. The text layer that makes `Block.rangeFor`
 * work is transparent and is *not* what the reader sees as a highlight: the
 * sentence paint comes from here, because a run's rectangle is the line box
 * PDFium reported and therefore lines up with the pixels even when the
 * invisible glyphs would wrap differently.
 *
 * The layer lives inside the page's text layer, which the viewer also rotates
 * for `/Rotate 90|180|270` pages, so the rectangles share the page's own
 * coordinate system and need no extra transform here.
 */
export class EmbedHighlightLayer {
  private readonly rects: HTMLElement[] = [];

  constructor(readonly container: HTMLElement) {}

  /**
   * Highlight a sentence given the blocks it covers.
   *
   * Draws every run of the blocks, which is exact when the caller passes only
   * the blocks the sentence intersects (as the viewer does for one-line
   * blocks), and deliberately coarse when it passes a whole paragraph. The
   * viewer uses {@link setRects} with the runs a sentence actually overlaps,
   * which is precise for multi-line paragraphs.
   */
  highlight(sentenceIndex: number, blocks: readonly EmbedBlock[]): void {
    const rects = blocks.flatMap((block) => block.run.map((run) => run.rect));
    this.setRects(rects, sentenceIndex);
  }

  /** Replace every rectangle with `rects`, in page pixels. */
  setRects(rects: readonly EmbedRect[], sentenceIndex?: number): void {
    this.clear();
    const doc = this.container.ownerDocument;

    for (const rect of rects) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const node = doc.createElement('div');
      node.className = 'pdf-highlight-rect';
      if (sentenceIndex !== undefined) node.dataset.sentence = String(sentenceIndex);
      node.style.left = `${rect.x}px`;
      node.style.top = `${rect.y}px`;
      node.style.width = `${rect.width}px`;
      node.style.height = `${rect.height}px`;
      this.container.appendChild(node);
      this.rects.push(node);
    }
  }

  /** Remove every rectangle. */
  clear(): void {
    for (const node of this.rects) node.remove();
    this.rects.length = 0;
  }
}
