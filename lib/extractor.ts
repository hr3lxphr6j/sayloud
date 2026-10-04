import { isProbablyReaderable, Readability } from '@mozilla/readability';

export interface Block {
  text: string;
  rangeFor(start: number, end: number): Range | null;
  /**
   * Map a DOM position back to an offset in `text`, for click-to-seek.
   * Returns an insertion point in `[0, text.length]`, or null when `node`
   * carries no text from this block.
   */
  offsetAt(node: Node, offset: number): number | null;
}

/** Elements that make up exactly one readable block. */
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE']);
const BLOCK_SELECTOR = [...BLOCK_TAGS].join(',');

/** Subtrees whose text is never read aloud. */
const SKIP_TAGS = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'SUP']);

/**
 * Containers that end the surrounding text run.
 *
 * Sibling blocks are separate paragraphs even when the markup has no whitespace
 * between them, which is why the text fallback cannot simply concatenate every
 * text node it walks past.
 */
const FLOW_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

/**
 * Fewer blocks than this means the page carries no semantic structure, so the
 * `<br>` fallback takes over. Old HTML 4.01 archives (marxists.org and friends)
 * keep entire documents as `<br>`-separated text runs alongside headers,
 * which block selectors alone would reduce to those headers.
 */
const MIN_BLOCKS = 3;

/**
 * When blocks cover less than this fraction of the page's total text, the rest
 * is likely BR-separated prose that block selectors missed.
 */
const MIN_COVERAGE = 0.3;

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
 * back to scanning block elements in document order, and when even that finds
 * almost nothing we split the remaining text on `<br>` (see `mergeTextBlocks`).
 */
export function extractBlocks(): Block[] {
  const clone = document.cloneNode(true) as Document;
  const cloneToOriginal = new WeakMap<Node, Node>();
  linkNodes(document, clone, cloneToOriginal);

  const articleRoot = readableRoot(clone);
  if (articleRoot) {
    // Readability builds its content wrapper itself, so the wrapper has no live
    // counterpart; the nodes it moved in do. Resolving them against the body is
    // what keeps their ranges anchored in the real DOM.
    const liveRoot = liveElementFor(articleRoot, cloneToOriginal) ?? document.body;
    if (liveRoot) {
      const entries = collectBlockEntries(articleRoot, liveRoot, (el) =>
        liveElementFor(el, cloneToOriginal)
      );
      // A stub means Readability latched onto a title or a byline; the prose it
      // could not classify is worth another look further down.
      // Even when several blocks are found, if their total text is a tiny fraction
      // of the page, the real content is likely BR-separated runs.
      if (shouldUseDomBlocks(entries, liveRoot)) {
        return entries.map((entry) => entry.block);
      }
    }
  }

  const body = document.body;
  if (!body) return [];

  const entries = collectBlockEntries(body, body, (el) => el);
  if (shouldUseDomBlocks(entries, body)) {
    return entries.map((entry) => entry.block);
  }
  return mergeTextBlocks(body, entries);
}

/**
 * Decide whether to use blocks from DOM selectors or fall back to text extraction.
 *
 * Returns true when:
 * - At least MIN_BLOCKS blocks are found, AND
 * - Those blocks cover at least MIN_COVERAGE of the root's total text
 *
 * Example: marxists.org has 10 block elements (headers + a quote) but they only
 * cover ~5% of the page's 27KB text — the rest is BR-separated prose.
 */
function shouldUseDomBlocks(entries: BlockEntry[], root: Element): boolean {
  if (entries.length < MIN_BLOCKS) return false;
  const blockText = entries.map((e) => e.block.text).join('').length;
  const totalText = root.textContent?.trim().length || 0;
  // If blocks capture < MIN_COVERAGE of the text, the rest is probably BR-separated.
  return totalText === 0 || blockText / totalText >= MIN_COVERAGE;
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

/** A block element that produced a block, kept so the text fallback can skip it. */
interface BlockEntry {
  element: Element;
  block: Block;
}

function collectBlockEntries(
  root: Element,
  liveRoot: Element,
  resolve: (el: Element) => Element | null
): BlockEntry[] {
  const entries: BlockEntry[] = [];
  for (const candidate of root.querySelectorAll(BLOCK_SELECTOR)) {
    const live = resolve(candidate);
    // Nodes created by Readability have no live counterpart and cannot be highlighted.
    if (!live) continue;
    if (hasSkippedAncestor(live, liveRoot)) continue;
    // Nested blocks belong to their nearest block ancestor, not to themselves.
    if (hasBlockAncestor(live, liveRoot)) continue;
    const block = buildBlock(live);
    if (block) entries.push({ element: live, block });
  }
  return entries;
}

/**
 * Fallback for pages whose prose is not wrapped in block elements.
 *
 * Block elements that did yield a block keep their own boundaries; every other
 * text node is collected into the current run, which ends at a `<br>`, at a
 * container element, or when the run collapses to nothing (which is how blank
 * lines read). Blocks come out in document order, so a stray paragraph between
 * two text runs still lands in the right place.
 */
function mergeTextBlocks(root: Element, entries: BlockEntry[]): Block[] {
  const byElement = new Map(entries.map((entry) => [entry.element, entry.block]));
  const blocks: Block[] = [];
  let chars: CharRef[] = [];

  const flush = (): void => {
    const block = blockFromChars(chars);
    chars = [];
    if (block) blocks.push(block);
  };

  const walk = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child as Text;
        pushChars(chars, text);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const block = byElement.get(el);
      if (block) {
        flush();
        blocks.push(block);
        continue;
      }
      if (el.tagName === 'BR') {
        flush();
        continue;
      }
      if (isSkippedElement(el)) continue;
      if (!FLOW_TAGS.has(el.tagName)) {
        walk(el);
        continue;
      }
      flush();
      walk(el);
      flush();
    }
  };

  walk(root);
  flush();
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
    pushChars(chars, node as Text);
    node = walker.nextNode();
  }

  return blockFromChars(chars);
}

/** Append one `CharRef` per emitted character, collapsing whitespace runs. */
function pushChars(chars: CharRef[], node: Text): void {
  const raw = node.data;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    const isSpace = /\s/.test(ch);
    // Collapse runs of whitespace into a single space so offsets stay 1:1
    // with the emitted text.
    if (isSpace && (chars.length === 0 || chars[chars.length - 1]?.ch === ' ')) continue;
    chars.push({ ch: isSpace ? ' ' : ch, node, offset: i });
  }
}

function blockFromChars(chars: CharRef[]): Block | null {
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
    offsetAt(node: Node, offset: number): number | null {
      let lastOfNode = -1;
      for (let i = 0; i < chars.length; i++) {
        const ref = chars[i];
        if (ref?.node !== node) continue;
        if (ref.offset >= offset) return i;
        lastOfNode = i;
      }
      // Past the last character this node contributes: report the position
      // just after it so callers can still resolve a sentence.
      return lastOfNode === -1 ? null : lastOfNode + 1;
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
