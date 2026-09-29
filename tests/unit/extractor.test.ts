import { beforeEach, describe, expect, it } from 'vitest';
import { extractBlocks } from '~/lib/extractor';

/** Enough prose for `isProbablyReaderable` to accept the document. */
function longArticle(): string {
  const paragraph = 'This is a reasonably long paragraph of prose. '.repeat(6);
  return Array.from({ length: 8 }, (_, i) => `<p>${paragraph}${i}</p>`).join('');
}

describe('extractor', () => {
  describe('Readability path', () => {
    beforeEach(() => {
      document.body.innerHTML = `<article>${longArticle()}</article>`;
    });

    it('extracts blocks for a long article', () => {
      const blocks = extractBlocks();
      expect(blocks).toHaveLength(8);
      expect(blocks[0]?.text).toContain('This is a reasonably long paragraph of prose.');
    });

    it('drops boilerplate that only Readability removes', () => {
      // The fallback scanner would also pick up the aside, so seeing it gone
      // proves the Readability path ran rather than the body scan.
      document.body.insertAdjacentHTML('beforeend', '<aside><p>Aside junk here.</p></aside>');

      const blocks = extractBlocks();
      expect(blocks.some((b) => b.text.includes('Aside junk'))).toBe(false);
      expect(blocks).toHaveLength(8);
    });
  });

  describe('fallback path', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <article>
          <p>Hello world.</p>
          <p>Goodbye <b>brave</b> new world.</p>
        </article>
      `;
    });

    it('extracts blocks with text and ranges', () => {
      const blocks = extractBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.text).toBe('Hello world.');
      expect(blocks[1]?.text).toBe('Goodbye brave new world.');
    });

    it('builds a range spanning inline elements', () => {
      const blocks = extractBlocks();
      expect(blocks[0]?.rangeFor(0, 5)?.toString()).toBe('Hello');
      expect(blocks[1]?.rangeFor(8, 13)?.toString()).toBe('brave');
    });

    it('returns null for out-of-range or empty offsets', () => {
      const blocks = extractBlocks();
      expect(blocks[0]?.rangeFor(0, 99)).toBeNull();
      expect(blocks[0]?.rangeFor(-1, 3)).toBeNull();
      expect(blocks[0]?.rangeFor(3, 3)).toBeNull();
      expect(blocks[0]?.rangeFor(5, 2)).toBeNull();
    });
  });

  describe('block selection', () => {
    it('returns an empty array for an unreadable page', () => {
      document.body.innerHTML = '<div></div>';
      expect(extractBlocks()).toEqual([]);
    });

    it('returns an empty array when there is no body content', () => {
      document.body.innerHTML = '';
      expect(extractBlocks()).toEqual([]);
    });

    it('keeps only the nearest block ancestor of nested blocks', () => {
      document.body.innerHTML =
        '<blockquote><p>Quoted text here.</p></blockquote><ul><li>One</li><li>Two</li></ul>';

      expect(extractBlocks().map((b) => b.text)).toEqual(['Quoted text here.', 'One', 'Two']);
    });

    it('skips code, pre and hidden subtrees', () => {
      document.body.innerHTML = `
        <p>Inline <code>const x = 1;</code> stays</p>
        <p>Before <span hidden>hidden words</span> after</p>
        <pre>preformatted block</pre>
      `;

      expect(extractBlocks().map((b) => b.text)).toEqual(['Inline stays', 'Before after']);
    });
  });

  describe('whitespace', () => {
    it('collapses whitespace and keeps offsets aligned', () => {
      document.body.innerHTML = '<p>Hello   <b>brave</b>\n new</p>';

      const blocks = extractBlocks();
      expect(blocks[0]?.text).toBe('Hello brave new');
      // Offsets must still address the collapsed text, not the raw source.
      expect(blocks[0]?.rangeFor(6, 11)?.toString()).toBe('brave');
      expect(blocks[0]?.rangeFor(0, 5)?.toString()).toBe('Hello');
    });

    it('drops blocks that collapse to nothing', () => {
      document.body.innerHTML = '<p>   </p><p>Real text.</p>';
      expect(extractBlocks().map((b) => b.text)).toEqual(['Real text.']);
    });
  });
});
