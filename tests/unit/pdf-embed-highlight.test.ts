/**
 * The highlight rectangles.
 *
 * PDFium renders each page as an image, so a sentence cannot be painted with
 * `::highlight()` over glyphs that do not exist; the viewer lays rectangles
 * over the rectangles PDFium reported instead. These tests pin the geometry
 * and the lifecycle (replace, not accumulate).
 */
import type { PdfTextRectObject } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';
import { buildEmbedBlocks, type EmbedBlock } from '~/lib/pdf/embed/blocks';
import { EmbedHighlightLayer } from '~/lib/pdf/embed/highlight';

function textRect(content: string, x: number, y: number, height = 12): PdfTextRectObject {
  return {
    content,
    font: { family: 'Helvetica', size: height },
    rect: { origin: { x, y }, size: { width: content.length * 6, height } },
  };
}

function setup(rects: PdfTextRectObject[]): {
  layer: EmbedHighlightLayer;
  container: HTMLElement;
  blocks: EmbedBlock[];
} {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.append(container);
  const blocks = buildEmbedBlocks(rects, { textLayer: container, pageEl: container }, 1);
  return { layer: new EmbedHighlightLayer(container), container, blocks };
}

function rectsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.pdf-highlight-rect'));
}

describe('EmbedHighlightLayer', () => {
  it('draws a rectangle at the run position and size', () => {
    const { layer, container, blocks } = setup([textRect('Hello', 10, 20)]);

    layer.highlight(0, blocks);

    const [rect] = rectsIn(container);
    expect(rect).toBeDefined();
    expect(rect?.style.left).toBe('10px');
    expect(rect?.style.top).toBe('20px');
    expect(rect?.style.width).toBe('30px');
    expect(rect?.style.height).toBe('12px');
    expect(rect?.dataset.sentence).toBe('0');
  });

  it('replaces the previous sentence instead of accumulating', () => {
    const { layer, container, blocks } = setup([textRect('Hello', 0, 0), textRect('World', 0, 40)]);

    layer.highlight(0, [blocks[0] as EmbedBlock]);
    layer.highlight(1, [blocks[1] as EmbedBlock]);

    const drawn = rectsIn(container);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.dataset.sentence).toBe('1');
    expect(drawn[0]?.style.top).toBe('40px');
  });

  it('clears everything', () => {
    const { layer, container, blocks } = setup([textRect('Hello', 0, 0)]);

    layer.highlight(0, blocks);
    layer.clear();

    expect(rectsIn(container)).toHaveLength(0);
  });

  it('draws only the rectangles it is given', () => {
    const { layer, container, blocks } = setup([
      textRect('first line', 0, 0),
      textRect('second line', 0, 16),
    ]);
    const block = blocks[0] as EmbedBlock;

    layer.setRects([block.run[1]?.rect ?? { x: 0, y: 0, width: 0, height: 0 }], 3);

    const drawn = rectsIn(container);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.style.top).toBe('16px');
    expect(drawn[0]?.dataset.sentence).toBe('3');
  });

  it('skips degenerate rectangles', () => {
    const { layer, container } = setup([]);

    layer.setRects([
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: 0 },
      { x: 5, y: 5, width: 2, height: 2 },
    ]);

    expect(rectsIn(container)).toHaveLength(1);
  });

  it('keeps the rectangles inside the page container, not the document', () => {
    const { layer, container, blocks } = setup([textRect('Hello', 1, 2)]);

    layer.highlight(0, blocks);

    expect(container.lastElementChild?.className).toBe('pdf-highlight-rect');
  });
});
