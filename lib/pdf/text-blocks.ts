import type { Block } from '../extractor';
import type { PdfTextItem } from './types';

/** One character of `text` that a live text node actually carries. */
interface CharRef {
  node: Text;
  offset: number;
}

/**
 * Map one page's pdf.js text items onto a single {@link Block}.
 *
 * The block mirrors the order pdf.js emitted the items in. A two-column page
 * arrives as interleaved left/right lines, and this function deliberately does
 * not reorder them by position: reading order is whatever the content stream
 * says (a known limitation of the text layer).
 *
 * `layer` must hold exactly one child per item, each with a single text node
 * whose data equals `item.str`; anything else means the layer and the items
 * were built from different PDF.js runs, so this throws rather than producing
 * offsets that point at the wrong glyphs.
 *
 * Spaces between items and newlines for `hasEOL` items are inserted into
 * `text`, but they exist in no text node. `rangeFor` and `offsetAt` therefore
 * only ever land on characters that a node carries.
 */
export function pageBlock(items: PdfTextItem[], layer: HTMLElement): Block | null {
  const nodes = textNodesFor(items, layer);
  const chars: Array<CharRef | null> = [];
  let text = '';

  const push = (piece: string): void => {
    chars.push(null);
    text += piece;
  };

  items.forEach((item, index) => {
    if (index > 0 && !endsWithWhitespace(text)) push(' ');
    const node = nodes[index] as Text;
    for (let offset = 0; offset < item.str.length; offset++) {
      chars.push({ node, offset });
      text += item.str.charAt(offset);
    }
    // The last item starts no new line, so its EOL is dropped.
    if (item.hasEOL && index < items.length - 1) push('\n');
  });

  if (text.trim().length === 0) return null;

  return {
    text,
    rangeFor(start: number, end: number): Range | null {
      if (start < 0 || start >= end || end > chars.length) return null;
      const first = firstRefIn(chars, start, end);
      const last = lastRefIn(chars, start, end);
      if (!first || !last) return null;
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
      return range;
    },
    offsetAt(node: Node, offset: number): number | null {
      let lastOfNode = -1;
      for (let i = 0; i < chars.length; i++) {
        const ref = chars[i];
        if (!ref || ref.node !== node) continue;
        if (ref.offset >= offset) return i;
        lastOfNode = i;
      }
      // Past the last character this node contributes: report the position
      // just after it so callers can still resolve a sentence.
      return lastOfNode === -1 ? null : lastOfNode + 1;
    },
  };
}

/** Resolve the text node backing each item, validating the layer as it goes. */
function textNodesFor(items: PdfTextItem[], layer: HTMLElement): Text[] {
  if (layer.children.length !== items.length) throw mismatch();

  const nodes = new Array<Text>(items.length);
  const seen = new Set<number>();
  for (const [index, item] of items.entries()) {
    if (!Number.isInteger(item.nodeIndex)) throw mismatch();
    if (item.nodeIndex < 0 || item.nodeIndex >= layer.children.length) throw mismatch();
    if (seen.has(item.nodeIndex)) throw mismatch();
    seen.add(item.nodeIndex);

    const child = layer.children[item.nodeIndex] as HTMLElement;
    if (child.childNodes.length !== 1) throw mismatch();
    const node = child.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) throw mismatch();
    const text = node as Text;
    if (text.data !== item.str) throw mismatch();
    nodes[index] = text;
  }
  return nodes;
}

function mismatch(): Error {
  return new Error('pdf text layer mismatch');
}

function endsWithWhitespace(text: string): boolean {
  return text.length > 0 && /\s/.test(text.charAt(text.length - 1));
}

function firstRefIn(chars: Array<CharRef | null>, start: number, end: number): CharRef | null {
  for (let i = start; i < end; i++) {
    const ref = chars[i];
    if (ref) return ref;
  }
  return null;
}

function lastRefIn(chars: Array<CharRef | null>, start: number, end: number): CharRef | null {
  for (let i = end - 1; i >= start; i--) {
    const ref = chars[i];
    if (ref) return ref;
  }
  return null;
}
