import type { Block } from './extractor';
import { isSupportedLang, segmentSentences } from './text-utils';

export interface ReadingSentence {
  text: string;
  lang: string;
  /** Index into `ReadingDoc.blocks`. */
  blockIndex: number;
  /** Offsets of `text` inside the owning block's text. */
  start: number;
  end: number;
}

export interface ReadingDoc {
  readonly blocks: readonly Block[];
  readonly sentences: readonly ReadingSentence[];
  getSentence(index: number): ReadingSentence | null;
  rangeForSentence(index: number): Range | null;
  /** `charStart`/`charEnd` are offsets into the sentence's own text. */
  rangeForWord(index: number, charStart: number, charEnd: number): Range | null;
  sentenceAt(node: Node, offset: number): number | null;
}

/** Page language, falling back to the UI language and finally to English. */
export function detectDocumentLang(doc: Document = document): string {
  const declared = doc.documentElement?.getAttribute('lang')?.trim();
  if (declared) return declared;
  return navigator.language?.trim() || 'en';
}

export function buildReadingDoc(blocks: Block[], lang = detectDocumentLang()): ReadingDoc {
  // A tag `Intl.Segmenter` rejects would throw on every block, so normalise once.
  const usableLang = isSupportedLang(lang) ? lang : 'en';

  const sentences: ReadingSentence[] = [];
  /** Sentence indices produced by each block, used for `sentenceAt` lookups. */
  const perBlock: number[][] = [];

  blocks.forEach((block, blockIndex) => {
    const indices: number[] = [];
    for (const segment of segmentSentences(block.text, usableLang)) {
      indices.push(sentences.length);
      sentences.push({
        text: segment.text,
        lang: usableLang,
        blockIndex,
        start: segment.start,
        end: segment.end,
      });
    }
    perBlock.push(indices);
  });

  function getSentence(index: number): ReadingSentence | null {
    return sentences[index] ?? null;
  }

  function blockFor(index: number): Block | null {
    const sentence = sentences[index];
    if (!sentence) return null;
    return blocks[sentence.blockIndex] ?? null;
  }

  return {
    blocks,
    sentences,

    getSentence,

    rangeForSentence(index) {
      const sentence = sentences[index];
      const block = blockFor(index);
      if (!sentence || !block) return null;
      return block.rangeFor(sentence.start, sentence.end);
    },

    rangeForWord(index, charStart, charEnd) {
      const sentence = sentences[index];
      const block = blockFor(index);
      if (!sentence || !block) return null;
      if (charStart < 0 || charStart >= charEnd || charEnd > sentence.text.length) return null;
      return block.rangeFor(sentence.start + charStart, sentence.start + charEnd);
    },

    sentenceAt(node, offset) {
      const caret = resolveTextPosition(node, offset);
      if (!caret) return null;

      for (const [blockIndex, block] of blocks.entries()) {
        const at = block.offsetAt(caret.node, caret.offset);
        if (at === null) continue;

        const candidates = perBlock[blockIndex] ?? [];
        let nearest: number | null = null;
        for (const index of candidates) {
          const sentence = sentences[index];
          if (!sentence) continue;
          if (at >= sentence.start && at < sentence.end) return index;
          // Caret fell in a gap between sentences; keep the closest one before it.
          if (at >= sentence.end) nearest = index;
        }
        return nearest ?? candidates[0] ?? null;
      }
      return null;
    },
  };
}

/**
 * `caretPositionFromPoint` can return an element, so descend to the first text
 * node at that position before looking for an owning block.
 */
function resolveTextPosition(node: Node, offset: number): { node: Text; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) return { node: node as Text, offset };

  const child = node.childNodes[offset] ?? node.firstChild;
  if (!child) return null;

  const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  return first ? { node: first as Text, offset: 0 } : null;
}
