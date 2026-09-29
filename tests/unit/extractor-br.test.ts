import { beforeEach, describe, expect, it } from 'vitest';
import { extractBlocks } from '~/lib/extractor';
import { buildReadingDoc } from '~/lib/reading-doc';

/**
 * Roughly the shape of marxists.org's Chinese archive pages: a title and a date
 * in `<p>` tags, then the whole body as `<br>`-separated text nodes.
 */
const BR_ONLY_PAGE = `
  <p class="title1">矛盾论</p>
  <p class="date">一九三七年八月</p>
  <br>
  事物的矛盾法则，即对立统一的法则，是唯物辩证法的最根本的法则。<br>
  列宁说，就本来的意义讲，辩证法是研究对象的本质自身中的矛盾。<br>
  因此，我们在研究这个法则时，不得不涉及广泛的方面。<br>
`;

describe('extractor: BR-only pages', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reads BR-separated prose alongside the blocks it found', () => {
    document.body.innerHTML = BR_ONLY_PAGE;

    expect(extractBlocks().map((block) => block.text)).toEqual([
      '矛盾论',
      '一九三七年八月',
      '事物的矛盾法则，即对立统一的法则，是唯物辩证法的最根本的法则。',
      '列宁说，就本来的意义讲，辩证法是研究对象的本质自身中的矛盾。',
      '因此，我们在研究这个法则时，不得不涉及广泛的方面。',
    ]);
  });

  it('reads the text runs Readability left out of a stub article', () => {
    // Long enough for `isProbablyReaderable`, but Readability only keeps the one
    // paragraph, so the page would otherwise be read as a single paragraph.
    const paragraph = 'A paragraph long enough to be worth reading aloud. '.repeat(14);
    document.body.innerHTML = `
      <article><p>${paragraph}</p></article>
      <div id="body-text">
        Line one of the real document.<br>
        Line two of the real document.<br>
        Line three of the real document.<br>
      </div>
    `;

    const texts = extractBlocks().map((block) => block.text);
    expect(texts).toContain(paragraph.trim());
    expect(texts).toContain('Line one of the real document.');
    expect(texts).toContain('Line two of the real document.');
    expect(texts).toContain('Line three of the real document.');
  });

  it('treats consecutive BR tags as a single break', () => {
    document.body.innerHTML = 'Line 1<br><br>Line 2<br><br><br>Line 3<br>';

    expect(extractBlocks().map((block) => block.text)).toEqual(['Line 1', 'Line 2', 'Line 3']);
  });

  it('drops runs that collapse to whitespace', () => {
    document.body.innerHTML = 'Real text<br>   <br>\n  <br>More text<br>';

    expect(extractBlocks().map((block) => block.text)).toEqual(['Real text', 'More text']);
  });

  it('skips script, style, pre and code inside a text run', () => {
    document.body.innerHTML = `
      Visible text<br>
      <script>console.log('ignored');</script>
      More visible text<br>
      <style>.hidden { display: none; }</style>
      <pre>preformatted ignored</pre>
      Final text<br>
    `;

    expect(extractBlocks().map((block) => block.text)).toEqual([
      'Visible text',
      'More visible text',
      'Final text',
    ]);
  });

  it('does not repeat text that a block element already covers', () => {
    document.body.innerHTML = '<p>Only paragraph here.</p>Tail text here<br>';

    expect(extractBlocks().map((block) => block.text)).toEqual([
      'Only paragraph here.',
      'Tail text here',
    ]);
  });

  it('does not glue sibling blocks that have no whitespace between them', () => {
    document.body.innerHTML = '<div>Line 1</div><div>Line 2</div><div>Line 3</div>';

    expect(extractBlocks().map((block) => block.text)).toEqual(['Line 1', 'Line 2', 'Line 3']);
  });

  it('keeps inline markup inside one run', () => {
    document.body.innerHTML = '<div>Hello <b>brave</b>, and <a href="#">more</a>.</div>';

    expect(extractBlocks().map((block) => block.text)).toEqual(['Hello brave, and more.']);
  });

  it('keeps document order when blocks and text runs alternate', () => {
    document.body.innerHTML = `
      <p>Intro paragraph.</p>
      Middle text line one<br>
      Middle text line two<br>
      <p>Outro paragraph.</p>
    `;

    expect(extractBlocks().map((block) => block.text)).toEqual([
      'Intro paragraph.',
      'Middle text line one',
      'Middle text line two',
      'Outro paragraph.',
    ]);
  });

  it('builds ranges across inline elements in a text run', () => {
    document.body.innerHTML = 'Hello <b>brave</b> world<br>Second line<br>';

    const blocks = extractBlocks();
    expect(blocks.map((block) => block.text)).toEqual(['Hello brave world', 'Second line']);
    expect(blocks[0]?.rangeFor(0, 5)?.toString()).toBe('Hello');
    expect(blocks[0]?.rangeFor(6, 11)?.toString()).toBe('brave');
    expect(blocks[0]?.rangeFor(11, 17)?.toString()).toBe(' world');
    expect(blocks[0]?.rangeFor(0, 99)).toBeNull();
  });

  it('maps caret positions back to offsets in a text run', () => {
    document.body.innerHTML = 'Hello <b>brave</b> world<br>Second line<br>';

    const blocks = extractBlocks();
    const brave = document.body.querySelector('b')?.firstChild;
    if (!(brave instanceof Text)) throw new Error('expected a text node inside <b>');

    expect(blocks[0]?.offsetAt(brave, 0)).toBe(6);
    expect(blocks[0]?.offsetAt(brave, 2)).toBe(8);
    // The second block carries none of the first run's text.
    expect(blocks[1]?.offsetAt(brave, 0)).toBeNull();
  });
});

describe('extractor: BR fallback with the reading doc', () => {
  beforeEach(() => {
    document.body.innerHTML =
      'First sentence here. Second sentence here.<br>Next paragraph text.<br>';
  });

  it('segments sentences and resolves their ranges', () => {
    const doc = buildReadingDoc(extractBlocks(), 'en');

    expect(doc.sentences.map((sentence) => sentence.text)).toEqual([
      'First sentence here.',
      'Second sentence here.',
      'Next paragraph text.',
    ]);
    expect(doc.rangeForSentence(1)?.toString()).toBe('Second sentence here.');
    expect(doc.rangeForWord(1, 0, 6)?.toString()).toBe('Second');
  });

  it('resolves a sentence from a click inside a text run', () => {
    const doc = buildReadingDoc(extractBlocks(), 'en');
    const text = document.body.firstChild;
    if (!(text instanceof Text)) throw new Error('expected a text node');

    expect(doc.sentenceAt(text, 25)).toBe(1);
    expect(doc.sentenceAt(text, 0)).toBe(0);
  });
});
