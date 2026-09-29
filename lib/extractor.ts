import { isProbablyReaderable, Readability } from '@mozilla/readability';

export interface Block {
  text: string;
  rangeFor(start: number, end: number): Range | null;
}

/** Elements that make up exactly one readable block. */
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE']);
const BLOCK_SELECTOR = [...BLOCK_TAGS].join(',');

/** Subtrees whose text is never read aloud. */
const SKIP_TAGS = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE']);

/** A single collapsed character and the live text node it came from. */
interface CharRef {
  ch: string;
  node: Text;
  offset: number;
}

/**
 * Extract readable blocks from the current document.
 *
 * Readability runs against a clone so the page is never mutated; a WeakMap
 * maps every cloned node back to its live counterpart so ranges are always
 * built against the real DOM. When Readability finds nothing usable we fall
 * back to scanning block elements in document order.
 */
export function extractBlocks(): Block[] {
  const clone = document.cloneNode(true) as Document;
  const cloneToOriginal = new WeakMap<Node, Node>();
  linkNodes(document, clone, cloneToOriginal);

  const articleRoot = readableRoot(clone);
  if (articleRoot) {
    const liveRoot = liveElementFor(articleRoot, cloneToOriginal) ?? document.body;
    const blocks = collectBlocks(articleRoot, liveRoot, (el) =>
      liveElementFor(el, cloneToOriginal)
    );
    if (blocks.length > 0) return blocks;
  }

  const body = document.body;
  if (!body) return [];
  return collectBlocks(body, body, (el) => el);
}

/** Pair up a node and its clone so cloned nodes can be resolved to live ones. */
function linkNodes(original: Node, clone: Node, map: WeakMap<Node, Node>): void {
  map.set(clone, original);
  const count = Math.min(original.childNodes.length, clone.childNodes.length);
  for (let i = 0; i < count; i++) {
    const originalChild = original.childNodes[i];
    const cloneChild = clone.childNodes[i];
    if (originalChild && cloneChild) linkNodes(originalChild, cloneChild, map);
  }
}

/** Run Readability on the clone, returning its content element when usable. */
function readableRoot(clone: Document): Element | null {
  try {
    if (!isProbablyReaderable(clone)) return null;
    const article = new Readability(clone, { serializer: (el) => el }).parse();
    return article?.content instanceof Element ? article.content : null;
  } catch {
    // Readability can throw on unusual documents; the fallback covers us.
    return null;
  }
}

function liveElementFor(node: Node, map: WeakMap<Node, Node>): Element | null {
  const original = map.get(node);
  return original instanceof Element ? original : null;
}

function collectBlocks(
  root: Element,
  liveRoot: Element,
  resolve: (el: Element) => Element | null
): Block[] {
  const blocks: Block[] = [];
  for (const candidate of root.querySelectorAll(BLOCK_SELECTOR)) {
    const live = resolve(candidate);
    // Nodes created by Readability have no live counterpart and cannot be highlighted.
    if (!live) continue;
    if (hasSkippedAncestor(live, liveRoot)) continue;
    // Nested blocks belong to their nearest block ancestor, not to themselves.
    if (hasBlockAncestor(live, liveRoot)) continue;
    const block = buildBlock(live);
    if (block) blocks.push(block);
  }
  return blocks;
}

function buildBlock(el: Element): Block | null {
  const chars: CharRef[] = [];

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      hasSkippedAncestor(node.parentElement, el)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });

  let node = walker.nextNode();
  while (node !== null) {
    const text = node as Text;
    const raw = text.data;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charAt(i);
      const isSpace = /\s/.test(ch);
      // Collapse runs of whitespace into a single space so offsets stay 1:1
      // with the emitted text.
      if (isSpace && (chars.length === 0 || chars[chars.length - 1]?.ch === ' ')) continue;
      chars.push({ ch: isSpace ? ' ' : ch, node: text, offset: i });
    }
    node = walker.nextNode();
  }

  while (chars[0]?.ch === ' ') chars.shift();
  while (chars[chars.length - 1]?.ch === ' ') chars.pop();

  const text = chars.map((c) => c.ch).join('');
  if (text.length === 0) return null;

  return {
    text,
    rangeFor(start: number, end: number): Range | null {
      if (start < 0 || start >= end || end > chars.length) return null;
      const first = chars[start];
      const last = chars[end - 1];
      if (!first || !last) return null;
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
      return range;
    },
  };
}

/** Walk from `start` up to and including `stopAt`, looking for a skipped element. */
function hasSkippedAncestor(start: Element | null, stopAt: Element): boolean {
  let current = start;
  while (current) {
    if (isSkippedElement(current)) return true;
    if (current === stopAt) return false;
    current = current.parentElement;
  }
  return false;
}

function isSkippedElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (typeof el.checkVisibility === 'function') {
    try {
      if (!el.checkVisibility()) return true;
    } catch {
      // checkVisibility throws on detached nodes; treat as visible.
    }
  }
  return false;
}

/** True when an ancestor up to `stopAt` is itself a block element. */
function hasBlockAncestor(el: Element, stopAt: Element): boolean {
  let current = el.parentElement;
  while (current && current !== stopAt) {
    if (BLOCK_TAGS.has(current.tagName)) return true;
    current = current.parentElement;
  }
  return false;
}
