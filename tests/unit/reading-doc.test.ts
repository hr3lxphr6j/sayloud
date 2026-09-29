import { beforeEach, describe, expect, it } from 'vitest';
import { extractBlocks } from '~/lib/extractor';
import { buildReadingDoc, detectDocumentLang } from '~/lib/reading-doc';

function firstTextNode(selector: string): { node: Text; element: Element } {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`fixture is missing ${selector}`);
  const node = element.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    throw new Error(`${selector} does not start with a text node`);
  }
  return { node: node as Text, element };
}

describe('reading-doc', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('lang', 'en');
    document.body.innerHTML = `
      <article>
        <p>Hello world. Goodbye now.</p>
        <p>Second block here.</p>
      </article>
    `;
  });

  it('builds one sentence list across blocks', () => {
    const doc = buildReadingDoc(extractBlocks());
    expect(doc.blocks).toHaveLength(2);
    expect(doc.sentences.map((s) => s.text)).toEqual([
      'Hello world.',
      'Goodbye now.',
      'Second block here.',
    ]);
    expect(doc.sentences.map((s) => s.blockIndex)).toEqual([0, 0, 1]);
  });

  it('maps a sentence index back to a DOM range', () => {
    const doc = buildReadingDoc(extractBlocks());
    expect(doc.rangeForSentence(0)?.toString()).toBe('Hello world.');
    expect(doc.rangeForSentence(1)?.toString()).toBe('Goodbye now.');
    expect(doc.rangeForSentence(2)?.toString()).toBe('Second block here.');
    expect(doc.rangeForSentence(99)).toBeNull();
  });

  it('maps sentence-relative word offsets to a DOM range', () => {
    const doc = buildReadingDoc(extractBlocks());
    expect(doc.rangeForWord(0, 0, 5)?.toString()).toBe('Hello');
    expect(doc.rangeForWord(0, 6, 11)?.toString()).toBe('world');
    // Offsets are relative to the sentence, not the block.
    expect(doc.rangeForWord(1, 0, 7)?.toString()).toBe('Goodbye');
  });

  it('rejects word offsets outside the sentence', () => {
    const doc = buildReadingDoc(extractBlocks());
    expect(doc.rangeForWord(0, 0, 99)).toBeNull();
    expect(doc.rangeForWord(0, 5, 2)).toBeNull();
    expect(doc.rangeForWord(0, -1, 3)).toBeNull();
    expect(doc.rangeForWord(99, 0, 3)).toBeNull();
  });

  it('resolves a caret position to a sentence index', () => {
    const doc = buildReadingDoc(extractBlocks());
    const first = firstTextNode('p');

    expect(doc.sentenceAt(first.node, 0)).toBe(0);
    expect(doc.sentenceAt(first.node, 13)).toBe(1);

    const second = firstTextNode('p + p');
    expect(doc.sentenceAt(second.node, 0)).toBe(2);
  });

  it('resolves a caret inside an inline element to its sentence', () => {
    document.body.innerHTML = '<p>Hello <b>brave</b> world.</p>';
    const doc = buildReadingDoc(extractBlocks());
    const bold = document.querySelector('b')?.firstChild;

    expect(doc.sentenceAt(bold as Text, 2)).toBe(0);
  });

  it('returns null when the position carries no block text', () => {
    const doc = buildReadingDoc(extractBlocks());
    const stray = document.createTextNode('detached');
    expect(doc.sentenceAt(stray, 0)).toBeNull();
  });

  it('detects the document language', () => {
    document.documentElement.setAttribute('lang', 'zh-CN');
    expect(detectDocumentLang()).toBe('zh-CN');

    document.documentElement.removeAttribute('lang');
    expect(detectDocumentLang()).not.toBe('');
  });

  it('segments Chinese text when the page is Chinese', () => {
    document.documentElement.setAttribute('lang', 'zh-CN');
    document.body.innerHTML = '<p>你好世界。再见。</p>';

    const doc = buildReadingDoc(extractBlocks());
    expect(doc.sentences.map((s) => s.text)).toEqual(['你好世界。', '再见。']);
    expect(doc.rangeForSentence(1)?.toString()).toBe('再见。');
  });

  it('ignores blocks that produce no sentences', () => {
    document.body.innerHTML = '<p>   </p><p>Real text.</p>';
    const doc = buildReadingDoc(extractBlocks());
    expect(doc.sentences.map((s) => s.text)).toEqual(['Real text.']);
  });
});
