/**
 * The EmbedPDF text layer.
 *
 * PDFium hands back one rectangle per text run and no DOM at all, so the
 * builder has to do two things at once: put real spans on the page (so
 * `Block.rangeFor` can return a range the browser can highlight) and group the
 * runs into blocks that a sentence may cross. These tests pin both halves, and
 * the geometry the viewer's highlight layer draws from.
 */
import type { PdfTextRectObject } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';
import { buildEmbedBlocks, type EmbedBlock } from '~/lib/pdf/embed/blocks';

/** One PDFium text rectangle in PDF points. */
function textRect(
  content: string,
  x: number,
  y: number,
  width = content.length * 6,
  height = 12
): PdfTextRectObject {
  return {
    content,
    font: { family: 'Helvetica', size: height },
    rect: { origin: { x, y }, size: { width, height } },
  };
}

function slots(): { textLayer: HTMLElement; pageEl: HTMLElement } {
  document.body.innerHTML = '';
  const textLayer = document.createElement('div');
  const pageEl = document.createElement('div');
  document.body.append(pageEl, textLayer);
  return { textLayer, pageEl };
}

/** The text node of one run span, which is what a range points into. */
function textNodeOf(block: EmbedBlock, run = 0): Text {
  const node = block.span.children[run]?.firstChild;
  if (!node) throw new Error(`run ${run} has no text node`);
  return node as Text;
}

describe('buildEmbedBlocks', () => {
  it('turns one rectangle into a block with a positioned span', () => {
    const container = slots();
    const blocks = buildEmbedBlocks([textRect('Hello PDF', 10, 20, 60, 12)], container, 2);

    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block?.text).toBe('Hello PDF');
    // PDF points become CSS pixels.
    expect(block?.run[0]?.rect).toEqual({ x: 20, y: 40, width: 120, height: 24 });
    const span = block?.run[0]?.span;
    expect(span?.style.left).toBe('20px');
    expect(span?.style.top).toBe('40px');
    expect(span?.style.width).toBe('120px');
    expect(container.textLayer.contains(span ?? null)).toBe(true);
    expect(container.textLayer.firstElementChild?.className).toBe('pdf-text-block');
  });

  it('returns a real DOM range for a span of characters', () => {
    const container = slots();
    const blocks = buildEmbedBlocks([textRect('Hello PDF', 0, 0)], container, 1);
    const block = blocks[0] as EmbedBlock;

    const range = block.rangeFor(6, 9);

    expect(range).not.toBeNull();
    expect(range?.startContainer).toBe(textNodeOf(block));
    expect(range?.startOffset).toBe(6);
    expect(range?.endOffset).toBe(9);
  });

  it('refuses a range outside the block', () => {
    const container = slots();
    const block = buildEmbedBlocks([textRect('Hello', 0, 0)], container, 1)[0] as EmbedBlock;

    expect(block.rangeFor(-1, 2)).toBeNull();
    expect(block.rangeFor(2, 2)).toBeNull();
    expect(block.rangeFor(0, 99)).toBeNull();
  });

  it('joins the lines of a paragraph with a newline', () => {
    const container = slots();
    const blocks = buildEmbedBlocks(
      [textRect('first line', 72, 100), textRect('second line', 72, 116)],
      container,
      1
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('first line\nsecond line');
    expect(blocks[0]?.run).toHaveLength(2);
  });

  it('lets one range cross the newline between two lines', () => {
    const container = slots();
    const block = buildEmbedBlocks(
      [textRect('first line', 0, 0, 50), textRect('second line', 0, 16, 50)],
      container,
      1
    )[0] as EmbedBlock;

    // "line" ends at 10, the newline is 10, "second" starts at 11.
    const range = block.rangeFor(6, 17);

    expect(range?.startContainer).toBe(textNodeOf(block, 0));
    expect(range?.startOffset).toBe(6);
    expect(range?.endContainer).toBe(textNodeOf(block, 1));
    expect(range?.endOffset).toBe(6);
  });

  it('starts a new block at a paragraph gap', () => {
    const container = slots();
    const blocks = buildEmbedBlocks(
      [textRect('paragraph one', 0, 0), textRect('paragraph two', 0, 60)],
      container,
      1
    );

    expect(blocks.map((block) => block.text)).toEqual(['paragraph one', 'paragraph two']);
  });

  it('starts a new block when the text jumps to another column', () => {
    const container = slots();
    // Same line, but 300 pt to the right: a column change, not a continuation.
    const blocks = buildEmbedBlocks(
      [textRect('left column', 72, 100, 80), textRect('right column', 372, 100, 80)],
      container,
      1
    );

    expect(blocks.map((block) => block.text)).toEqual(['left column', 'right column']);
  });

  it('drops rectangles without readable text', () => {
    const container = slots();
    const blocks = buildEmbedBlocks(
      [textRect('   ', 0, 0), textRect('real text', 0, 30)],
      container,
      1
    );

    expect(blocks.map((block) => block.text)).toEqual(['real text']);
  });

  it('maps a DOM position back to an offset in the block', () => {
    const container = slots();
    const block = buildEmbedBlocks([textRect('Hello PDF', 0, 0)], container, 1)[0] as EmbedBlock;
    const node = textNodeOf(block);

    expect(block.offsetAt(node, 0)).toBe(0);
    expect(block.offsetAt(node, 5)).toBe(5);
    // Past the node's last character: the position just after it, so a click
    // at the end of a line still resolves to the last sentence.
    expect(block.offsetAt(node, 9)).toBe(9);
    expect(block.offsetAt(document.createElement('span'), 0)).toBeNull();
  });

  it('maps a position in the second line into the joined text', () => {
    const container = slots();
    const block = buildEmbedBlocks(
      [textRect('first', 0, 0, 30), textRect('second', 0, 16, 36)],
      container,
      1
    )[0] as EmbedBlock;

    // "first" is 0-4, the newline is 5, "second" starts at 6.
    expect(block.offsetAt(textNodeOf(block, 1), 0)).toBe(6);
    expect(block.offsetAt(textNodeOf(block, 1), 3)).toBe(9);
  });

  it('reports a bounding box over every run of the block', () => {
    const container = slots();
    const block = buildEmbedBlocks(
      [textRect('first', 100, 50, 30, 10), textRect('second line', 80, 62, 66, 10)],
      container,
      1
    )[0] as EmbedBlock;

    expect(block.rect).toEqual({ x: 80, y: 50, width: 66, height: 22 });
  });

  it('leaves pageIndex for the viewer to fill in', () => {
    const container = slots();
    const block = buildEmbedBlocks([textRect('Hello', 0, 0)], container, 1)[0] as EmbedBlock;

    expect(block.pageIndex).toBe(-1);
  });
});
