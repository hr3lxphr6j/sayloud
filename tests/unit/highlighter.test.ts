import { beforeEach, describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_STYLES,
  Highlighter,
  installHighlightStyles,
  SENTENCE_HIGHLIGHT,
  WORD_HIGHLIGHT,
} from '~/lib/highlighter';

class FakeHighlight {
  ranges: Range[] = [];

  add(range: Range): void {
    this.ranges.push(range);
  }

  clear(): void {
    this.ranges = [];
  }
}

function fakeRegistry() {
  const map = new Map<string, FakeHighlight>();
  const registry = {
    set(key: string, highlight: unknown) {
      map.set(key, highlight as FakeHighlight);
      return registry;
    },
    delete(key: string) {
      return map.delete(key);
    },
  };
  return { map, registry };
}

function makeRange(): Range {
  return document.createRange();
}

describe('Highlighter', () => {
  let fake: ReturnType<typeof fakeRegistry>;
  let highlighter: Highlighter;

  beforeEach(() => {
    document.body.innerHTML = '<p>Hello brave new world.</p>';
    fake = fakeRegistry();
    highlighter = new Highlighter(fake.registry, FakeHighlight);
  });

  it('registers both highlight layers up front', () => {
    expect(fake.map.has(SENTENCE_HIGHLIGHT)).toBe(true);
    expect(fake.map.has(WORD_HIGHLIGHT)).toBe(true);
    expect(highlighter.enabled).toBe(true);
  });

  it('replaces the sentence range instead of accumulating', () => {
    const first = makeRange();
    const second = makeRange();

    highlighter.setSentence(first);
    expect(fake.map.get(SENTENCE_HIGHLIGHT)?.ranges).toEqual([first]);

    highlighter.setSentence(second);
    expect(fake.map.get(SENTENCE_HIGHLIGHT)?.ranges).toEqual([second]);
  });

  it('keeps the word layer independent of the sentence layer', () => {
    const sentence = makeRange();
    const word = makeRange();

    highlighter.setSentence(sentence);
    highlighter.setWord(word);
    expect(fake.map.get(SENTENCE_HIGHLIGHT)?.ranges).toEqual([sentence]);
    expect(fake.map.get(WORD_HIGHLIGHT)?.ranges).toEqual([word]);

    highlighter.clearWord();
    expect(fake.map.get(WORD_HIGHLIGHT)?.ranges).toEqual([]);
    // Sentence highlight must survive clearing the word.
    expect(fake.map.get(SENTENCE_HIGHLIGHT)?.ranges).toEqual([sentence]);
  });

  it('clears both layers without unregistering them', () => {
    highlighter.setSentence(makeRange());
    highlighter.setWord(makeRange());

    highlighter.clear();
    expect(fake.map.get(SENTENCE_HIGHLIGHT)?.ranges).toEqual([]);
    expect(fake.map.get(WORD_HIGHLIGHT)?.ranges).toEqual([]);
    expect(fake.map.size).toBe(2);
  });

  it('unregisters both layers on dispose', () => {
    highlighter.dispose();
    expect(fake.map.size).toBe(0);
  });

  it('degrades to a no-op when the Highlight API is missing', () => {
    const unsupported = new Highlighter(null, null);

    expect(unsupported.enabled).toBe(false);
    // None of these should throw.
    unsupported.setSentence(makeRange());
    unsupported.setWord(makeRange());
    unsupported.clearWord();
    unsupported.clear();
    unsupported.dispose();
  });
});

describe('installHighlightStyles', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.adoptedStyleSheets = [];
  });

  it('declares both highlight pseudo-elements', () => {
    expect(HIGHLIGHT_STYLES).toContain(`::highlight(${SENTENCE_HIGHLIGHT})`);
    expect(HIGHLIGHT_STYLES).toContain(`::highlight(${WORD_HIGHLIGHT})`);
  });

  it('installs the rules through a stylesheet or a style element', () => {
    installHighlightStyles(document);

    const viaAdopted = document.adoptedStyleSheets.length > 0;
    const viaStyleElement = document.head.querySelector('style[data-sayloud-highlight]') !== null;
    expect(viaAdopted || viaStyleElement).toBe(true);
  });

  it('does not install the rules twice', () => {
    installHighlightStyles(document);
    installHighlightStyles(document);

    expect(document.adoptedStyleSheets.length).toBeLessThanOrEqual(1);
    expect(
      document.head.querySelectorAll('style[data-sayloud-highlight]').length
    ).toBeLessThanOrEqual(1);
  });
});
