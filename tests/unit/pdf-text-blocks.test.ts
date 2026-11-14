import { describe, expect, it } from 'vitest';
import { pageBlock } from '~/lib/pdf/text-blocks';
import type { PdfTextItem } from '~/lib/pdf/types';

/**
 * Build the text layer the way the PDF viewer will: one `<span>` per item,
 * each holding exactly one text node with the item's string.
 */
function buildLayer(specs: Array<{ str: string; hasEOL?: boolean }>): {
  layer: HTMLElement;
  items: PdfTextItem[];
  nodes: Text[];
} {
  const layer = document.createElement('div');
  const items: PdfTextItem[] = [];
  const nodes: Text[] = [];

  specs.forEach((spec, index) => {
    const span = document.createElement('span');
    const node = document.createTextNode(spec.str);
    span.appendChild(node);
    layer.appendChild(span);
    items.push({ str: spec.str, hasEOL: spec.hasEOL ?? false, nodeIndex: index });
    nodes.push(node);
  });

  return { layer, items, nodes };
}

describe('pageBlock', () => {
  it('joins two items with a single space', () => {
    const { layer, items } = buildLayer([{ str: 'Hello' }, { str: 'world', hasEOL: true }]);

    const block = pageBlock(items, layer);

    expect(block?.text).toBe('Hello world');
  });

  it('does not add a space when the previous item already ends in whitespace', () => {
    const { layer, items } = buildLayer([{ str: 'Hello ' }, { str: 'world' }]);

    const block = pageBlock(items, layer);

    expect(block?.text).toBe('Hello world');
  });

  it('puts a newline after an item that ends its line', () => {
    const { layer, items } = buildLayer([
      { str: 'first', hasEOL: true },
      { str: 'second', hasEOL: true },
      { str: 'third', hasEOL: true },
    ]);

    const block = pageBlock(items, layer);

    // The last item's EOL is dropped: there is no next line to start.
    expect(block?.text).toBe('first\nsecond\nthird');
  });

  it('does not add a space after the newline of an EOL item', () => {
    const { layer, items } = buildLayer([{ str: 'first', hasEOL: true }, { str: 'second' }]);

    const block = pageBlock(items, layer);

    expect(block?.text).toBe('first\nsecond');
  });

  it('keeps item order when columns interleave (known limitation: no layout reordering)', () => {
    // A two-column page: pdf.js emits the text items in content-stream order,
    // not visual order, so left and right column lines alternate. This block
    // deliberately mirrors the input and never reorders by position.
    const { layer, items } = buildLayer([
      { str: 'left one', hasEOL: false },
      { str: 'right one', hasEOL: true },
      { str: 'left two', hasEOL: false },
    ]);

    const block = pageBlock(items, layer);

    expect(block?.text).toBe('left one right one\nleft two');
  });

  it('builds a range over the text nodes, not over the layer container', () => {
    const { layer, items, nodes } = buildLayer([{ str: 'Hello' }, { str: 'world', hasEOL: true }]);

    const block = pageBlock(items, layer);
    const range = block?.rangeFor(0, 5);

    expect(range).not.toBeNull();
    expect(range?.startContainer).toBe(nodes[0]);
    expect(range?.endContainer).toBe(nodes[0]);
    expect(range?.startOffset).toBe(0);
    expect(range?.endOffset).toBe(5);
    expect(range?.toString()).toBe('Hello');
  });

  it('spans two text nodes when the range crosses the inserted space', () => {
    const { layer, items, nodes } = buildLayer([{ str: 'Hello' }, { str: 'world', hasEOL: true }]);

    const block = pageBlock(items, layer);
    const range = block?.rangeFor(0, 11);

    expect(range?.startContainer).toBe(nodes[0]);
    expect(range?.startOffset).toBe(0);
    expect(range?.endContainer).toBe(nodes[1]);
    expect(range?.endOffset).toBe(5);
    // The inserted space lives in no text node, so the DOM string of the range
    // joins the two spans without it; the block text still has the space.
    expect(range?.toString()).toBe('Helloworld');
  });

  it('ignores an inserted space that has no text node of its own', () => {
    const { layer, items } = buildLayer([{ str: 'Hello' }, { str: 'world' }]);

    const block = pageBlock(items, layer);
    // Offset 5 is the inserted space, which no DOM node carries.
    const range = block?.rangeFor(0, 6);

    expect(range?.toString()).toBe('Hello');
  });

  it('returns null from offsetAt for nodes outside the layer', () => {
    const { layer, items } = buildLayer([{ str: 'Hello' }]);
    const outside = document.createTextNode('not in the layer');

    const block = pageBlock(items, layer);

    expect(block?.offsetAt(outside, 0)).toBeNull();
  });

  it('maps an offset inside the first text node back to the block offset', () => {
    const { layer, items, nodes } = buildLayer([{ str: 'Hello' }, { str: 'world' }]);

    const block = pageBlock(items, layer);

    expect(block?.offsetAt(nodes[0] as Node, 1)).toBe(1);
    // Just past the node's last character still resolves to the insertion point.
    expect(block?.offsetAt(nodes[0] as Node, 5)).toBe(5);
    // The second node starts after the inserted space.
    expect(block?.offsetAt(nodes[1] as Node, 0)).toBe(6);
  });

  it('returns null for an empty item list', () => {
    const layer = document.createElement('div');

    expect(pageBlock([], layer)).toBeNull();
  });

  it('returns null when the items carry no readable text', () => {
    const { layer, items } = buildLayer([{ str: '   ' }, { str: '\n' }]);

    expect(pageBlock(items, layer)).toBeNull();
  });

  it('throws when the layer children do not match the items', () => {
    const { layer, items } = buildLayer([{ str: 'Hello' }]);
    layer.appendChild(document.createElement('span'));

    expect(() => pageBlock(items, layer)).toThrow('pdf text layer mismatch');
  });

  it('throws when an item string differs from its text node', () => {
    const { layer, items } = buildLayer([{ str: 'Hello' }]);
    items[0] = { str: 'Goodbye', hasEOL: false, nodeIndex: 0 };

    expect(() => pageBlock(items, layer)).toThrow('pdf text layer mismatch');
  });

  it('throws when a child holds more than one text node', () => {
    const { layer, items } = buildLayer([{ str: 'Hello' }]);
    const span = layer.firstElementChild as HTMLElement;
    span.appendChild(document.createTextNode('!'));

    expect(() => pageBlock(items, layer)).toThrow('pdf text layer mismatch');
  });
});
