import type { PdfTextRectObject, Rect } from '@embedpdf/models';
import type { Block } from '~/lib/extractor';

/**
 * One text rectangle as the page renders it, in CSS pixels.
 *
 * `x`/`y` are the top-left corner and are measured from the page's own
 * top-left, i.e. they already include the scale and are what an absolutely
 * positioned child of the text layer wants.
 */
export interface EmbedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The two elements a page offers to the block builder. */
export interface EmbedPageSlots {
  /** The container that holds the transparent text spans. */
  textLayer: HTMLElement;
  /** The canvas/img layer for click positioning. */
  pageEl: HTMLElement;
}

/** One text rectangle's span and the range of block characters it carries. */
export interface EmbedRun {
  span: HTMLSpanElement;
  rect: EmbedRect;
  /** Offsets into `EmbedBlock.text`; `[start, end)` is this run's text. */
  start: number;
  end: number;
}

/**
 * A {@link Block} backed by real DOM text, plus the geometry to draw over it.
 *
 * PDFium renders pages as images, so there is no text to select or highlight.
 * The builder lays a transparent span per text rectangle over the page and
 * keeps a block whose characters point into those spans; `rangeFor` therefore
 * returns a range the browser (and `CSS.highlights`) can use, while `rect` and
 * `runs` give the viewer rectangles to paint.
 *
 * A block normally holds several rectangles (a paragraph's lines), because
 * sentence segmentation across line breaks must not restart at every line.
 */
export interface EmbedBlock extends Block {
  /** Bounding box of the block's runs, in CSS pixels from the page's origin. */
  rect: EmbedRect;
  /** The span that wraps every run of this block. */
  span: HTMLSpanElement;
  run: EmbedRun[];
  /** 0-based page this block belongs to; the viewer fills it in. */
  pageIndex: number;
}

/** One character of `text` that a live text node actually carries. */
interface CharRef {
  node: Text;
  offset: number;
}

/** Separator between two text rectangles: a newline, which no node carries. */
const SEPARATOR = '\n';

/**
 * Build blocks from EmbedPDF's `getPageTextRects`.
 *
 * Rectangles arrive in PDFium's text order (content stream, not visual order),
 * so this never reorders them. Instead it groups neighbouring rectangles into
 * a block so a sentence can span lines:
 *
 *   - a vertical gap larger than a line starts a new block (a paragraph break);
 *   - a horizontal jump wider than a couple of lines starts a new block (a
 *     column change, which is what keeps two-column text from being glued
 *     into one run when the columns are emitted one after the other).
 *
 * `text` joins a block's rectangles with `\n`, which `Intl.Segmenter` treats as
 * whitespace: the sentence text keeps its words apart without inventing a
 * space that the PDF did not have.
 */
export function buildEmbedBlocks(
  textRects: readonly PdfTextRectObject[],
  slots: EmbedPageSlots,
  scale: number
): EmbedBlock[] {
  const usable = textRects.filter((entry) => isUsable(entry));
  const blocks: EmbedBlock[] = [];

  let group: PdfTextRectObject[] = [];
  let previous: Rect | null = null;

  const flush = (): void => {
    if (group.length === 0) return;
    const block = buildBlock(group, slots, scale, blocks.length);
    if (block) blocks.push(block);
    group = [];
  };

  for (const entry of usable) {
    if (previous && startsNewBlock(previous, entry.rect)) flush();
    group.push(entry);
    previous = entry.rect;
  }
  flush();

  return blocks;
}

/** Whether a rectangle carries text this viewer can read. */
function isUsable(entry: PdfTextRectObject): boolean {
  return (
    entry.rect.size.width > 0 &&
    entry.rect.size.height > 0 &&
    entry.content.trim().length > 0 &&
    entry.content.length > 0
  );
}

/** Block grouping rule: see the doc comment on {@link buildEmbedBlocks}. */
function startsNewBlock(previous: Rect, next: Rect): boolean {
  const lineHeight = Math.max(previous.size.height, 1);
  const gap = next.origin.y - (previous.origin.y + previous.size.height);

  // Going backwards in y is a new region of the page (a sidebar, a footnote).
  if (gap < -lineHeight * 1.5) return true;
  // A paragraph break, or any gap wider than the text's own line.
  if (gap > lineHeight * 0.9) return true;
  // A column change, an indent running far enough to be a different region.
  return Math.abs(next.origin.x - previous.origin.x) > lineHeight * 2.5;
}

/** Materialise one block: the wrapper span, its runs, and the char map. */
function buildBlock(
  entries: readonly PdfTextRectObject[],
  slots: EmbedPageSlots,
  scale: number,
  index: number
): EmbedBlock | null {
  const doc = slots.textLayer.ownerDocument;
  const wrapper = doc.createElement('span');
  wrapper.className = 'pdf-text-block';
  wrapper.dataset.blockIndex = String(index);

  const chars: Array<CharRef | null> = [];
  const runs: EmbedRun[] = [];
  let text = '';

  for (const [position, entry] of entries.entries()) {
    if (position > 0) {
      // The line break exists in `text` only; no node carries it.
      chars.push(null);
      text += SEPARATOR;
    }

    const rect = scaledRect(entry.rect, scale);
    const span = doc.createElement('span');
    span.className = 'pdf-text-run';
    span.dataset.blockIndex = String(index);
    span.style.left = `${rect.x}px`;
    span.style.top = `${rect.y}px`;
    span.style.width = `${rect.width}px`;
    span.style.height = `${rect.height}px`;
    // The glyphs are invisible; this is what keeps selection and `Range`
    // geometry in the right place without drawing the text twice.
    span.style.fontSize = `${rect.height}px`;
    span.style.lineHeight = `${rect.height}px`;
    span.textContent = entry.content;

    const node = span.firstChild as Text | null;
    if (!node) continue; // `textContent` above guarantees a text child
    wrapper.appendChild(span);

    const start = text.length;
    for (let offset = 0; offset < entry.content.length; offset++) {
      chars.push({ node, offset });
      text += entry.content.charAt(offset);
    }
    runs.push({ span, rect, start, end: text.length });
  }

  if (text.trim().length === 0) return null;

  slots.textLayer.appendChild(wrapper);

  return {
    text,
    rect: boundingRect(runs.map((run) => run.rect)),
    span: wrapper,
    run: runs,
    pageIndex: -1,
    rangeFor(start: number, end: number): Range | null {
      if (start < 0 || start >= end || end > chars.length) return null;
      const first = firstRefIn(chars, start, end);
      const last = lastRefIn(chars, start, end);
      if (!first || !last) return null;
      const range = doc.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
      return range;
    },
    offsetAt(node: Node, offset: number): number | null {
      let lastOfNode = -1;
      for (let position = 0; position < chars.length; position++) {
        const ref = chars[position];
        if (!ref || ref.node !== node) continue;
        if (ref.offset >= offset) return position;
        lastOfNode = position;
      }
      // Past the last character this node contributes: report the position
      // just after it so callers can still resolve a sentence.
      return lastOfNode === -1 ? null : lastOfNode + 1;
    },
  };
}

/** PDF points to CSS pixels. */
function scaledRect(rect: Rect, scale: number): EmbedRect {
  return {
    x: rect.origin.x * scale,
    y: rect.origin.y * scale,
    width: rect.size.width * scale,
    height: rect.size.height * scale,
  };
}

function boundingRect(rects: readonly EmbedRect[]): EmbedRect {
  const first = rects[0];
  if (!first) return { x: 0, y: 0, width: 0, height: 0 };

  let left = first.x;
  let top = first.y;
  let right = first.x + first.width;
  let bottom = first.y + first.height;
  for (const rect of rects.slice(1)) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function firstRefIn(chars: Array<CharRef | null>, start: number, end: number): CharRef | null {
  for (let position = start; position < end; position++) {
    const ref = chars[position];
    if (ref) return ref;
  }
  return null;
}

function lastRefIn(chars: Array<CharRef | null>, start: number, end: number): CharRef | null {
  for (let position = end - 1; position >= start; position--) {
    const ref = chars[position];
    if (ref) return ref;
  }
  return null;
}
