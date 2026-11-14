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
import { segmentSentences } from '~/lib/text-utils';
import realRects from '../fixtures/pdf/023-page1-rects.json';

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

  it('keeps same-line runs together instead of measuring from their origins', () => {
    const container = slots();
    // What PDFium emits for one visual line of 023.pdf p1: the runs start a
    // run-width apart, because the previous rect is the *entire* run to their
    // left. Comparing origins made each of these a block of its own.
    const blocks = buildEmbedBlocks(
      [
        textRect('在写文章的期间我也有阅读 ', 60, 362, 135, 12),
        textRect(' Haim Brezis ', 195, 364, 63, 8),
        textRect('的 ', 257, 362, 11, 11),
        textRect('Analyse Fonctionnelle', 270, 362, 215, 11),
      ],
      container,
      1
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(
      '在写文章的期间我也有阅读 \n Haim Brezis \n的 \nAnalyse Fonctionnelle'
    );
  });

  it('keeps a wrapped line together when it starts left of the previous run', () => {
    const container = slots();
    // The run that ends the line starts far to the right; the next line returns
    // to the left margin. That is a line wrap, not a column change, so the
    // horizontal comparison must not use an absolute x distance.
    const blocks = buildEmbedBlocks(
      [textRect('，以我阅读的偮䵓', 487, 362, 66, 12), textRect('部分内容来看', 54, 380, 200, 12)],
      container,
      1
    );

    expect(blocks).toHaveLength(1);
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

  it('cleans glyph-id garbage out of the text and the node alike', () => {
    const container = slots();
    // What PDFium's ToUnicode fallback emits: a glyph id per unmapped glyph.
    const block = buildEmbedBlocks(
      [textRect('数学\u001b\u0010分析\u0018', 0, 0)],
      container,
      1
    )[0] as EmbedBlock | undefined;

    expect(block?.text).toBe('数学分析');
    // The span carries the same characters the block advertises, so a range
    // built from a block offset lands on the right glyphs.
    expect(textNodeOf(block as EmbedBlock).data).toBe('数学分析');
    expect(block?.rangeFor(0, 2)?.toString()).toBe('数学');
  });

  it('skips a rectangle that is nothing but garbage', () => {
    const container = slots();
    const blocks = buildEmbedBlocks(
      [textRect('\u001b\u0010', 0, 0), textRect('real text', 0, 30)],
      container,
      1
    );

    // No stray newline and no empty run: the garbage rect never became a line.
    expect(blocks.map((block) => block.text)).toEqual(['real text']);
    expect(blocks[0]?.run).toHaveLength(1);
    expect(container.textLayer.querySelectorAll('.pdf-text-run')).toHaveLength(1);
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

/**
 * Real PDFium output for page 1 of https://www.aqouyang.com/pdf/023.pdf.
 *
 * This is the page the sentence-segmentation tests use in `text-utils.test.ts`,
 * one hand-grouped string per block. Here the same page arrives raw (42 rects,
 * PDFium's text order), so the grouping rule itself is what is under test: the
 * viewer segments per block, and every over-fragmented block is a sentence that
 * cannot be merged across a font or inline-run boundary.
 */
describe('023.pdf page 1', () => {
  const rects = realRects as PdfTextRectObject[];

  function page() {
    const container = slots();
    return buildEmbedBlocks(rects, container, 1);
  }

  it('groups the page into paragraphs, not into runs', () => {
    const blocks = page();

    // Before the horizontal fix this page produced 27 blocks: the header line
    // and every inline run (author, book title, superscript, “Beginner") was
    // cut off because the rule compared x origins. One block per paragraph is
    // the intended unit, and there are 12 of them.
    expect(blocks).toHaveLength(12);
    expect(blocks.map((block) => block.run.length)).toEqual([5, 1, 1, 1, 2, 7, 7, 2, 6, 4, 1, 5]);

    // A sentence can only cross a line inside one block, so fewer blocks means
    // fewer artificially split sentences: 34 before, 19 now.
    const sentences = blocks.flatMap((block) => segmentSentences(block.text, 'zh'));
    expect(sentences).toHaveLength(19);
  });

  it('keeps the sentence around “Haim Brezis” in one block', () => {
    const block = page().find((candidate) => candidate.text.includes('Haim Brezis'));

    expect(block).toBeDefined();
    // The author name (8px rect) and the book title are inline runs of the same
    // visual line, and the line after them wraps back to the left margin.
    expect(block?.text).toContain('在写文章的期间我也有阅读');
    expect(block?.text).toContain('Analyse Fonctionnelle, Théorie Et Applicationse');
    expect(block?.text).toContain('部分内容来看');
    expect(block?.text).toContain('来说是很适合进阶学习。');

    const sentences = segmentSentences(block?.text ?? '', 'zh');
    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.text).toContain('Haim Brezis');
  });

  it('keeps the header line and the closing paragraph whole', () => {
    const blocks = page();

    // The first line of the running header: five inline runs (CJK, Latin, the
    // ligature placeholders) share one visual line and one block now; the old
    // rule made three blocks of them.
    expect(blocks[0]?.run).toHaveLength(5);
    expect(blocks[0]?.text).toContain('数学分析');
    // Glyph-id controls are already cleaned by the builder (P1).
    expect(blocks[0]?.text).toContain(' I⭠');

    // The paragraph whose last line ends with the inline “ Montel ” superscript
    // used to split before the superscript and again after it.
    const montel = blocks.find((block) => block.text.includes('Montel'));
    expect(montel?.text).toContain('诱导出这个拓扑');
    expect(montel?.text).toContain('空间。');
  });
});
