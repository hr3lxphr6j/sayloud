import { describe, expect, it } from 'vitest';
import {
  mergeLineBreaks,
  normalizeText,
  protectSpecialNumbers,
  restoreSpecialNumbers,
  segmentSentences,
  segmentWords,
} from '~/lib/text-utils';

describe('text-utils', () => {
  it('normalizes whitespace', () => {
    expect(normalizeText('Hello   \n  world')).toBe('Hello world');
  });

  it('segments English sentences', () => {
    const sents = segmentSentences('Hello world. Goodbye!', 'en');
    expect(sents).toHaveLength(2);
    expect(sents[0]?.text).toBe('Hello world.');
    expect(sents[1]?.text).toBe('Goodbye!');
  });

  it('segments Chinese sentences', () => {
    const sents = segmentSentences('你好。再见。', 'zh');
    expect(sents).toHaveLength(2);
  });

  it('segments words', () => {
    const words = segmentWords('Hello world.', 'en');
    expect(words.map((w) => w.text)).toEqual(['Hello', 'world']);
  });

  describe('mergeLineBreaks', () => {
    it('joins a CJK soft wrap without adding a space', () => {
      expect(mergeLineBreaks('第一行\n第二行')).toBe('第一行第二行');
    });

    it('keeps a paragraph break', () => {
      expect(mergeLineBreaks('第一段。\n\n第二段。')).toBe('第一段。\n\n第二段。');
    });

    it('collapses runs of three or more newlines to a paragraph break', () => {
      expect(mergeLineBreaks('第一段。\n\n\n\n第二段。')).toBe('第一段。\n\n第二段。');
    });

    it('turns a Latin soft wrap into a single space', () => {
      expect(mergeLineBreaks('Hello\nworld')).toBe('Hello world');
      // An indented wrap must not leave two spaces behind.
      expect(mergeLineBreaks('Hello\n   world')).toBe('Hello world');
    });

    it('joins a mixed CJK/Latin wrap with a space', () => {
      expect(mergeLineBreaks('第一行\nEnglish')).toBe('第一行 English');
    });

    it('handles CRLF', () => {
      expect(mergeLineBreaks('第一行\r\n第二行')).toBe('第一行第二行');
      expect(mergeLineBreaks('第一段。\r\n\r\n第二段。')).toBe('第一段。\n\n第二段。');
    });

    it('leaves text without newlines untouched', () => {
      expect(mergeLineBreaks('你好。再见。')).toBe('你好。再见。');
    });
  });

  describe('special numbers', () => {
    it('masks version numbers', () => {
      expect(protectSpecialNumbers('v1.2.3 发布')).toBe('v1_DOT_2_DOT_3 发布');
    });

    it('masks decimals', () => {
      expect(protectSpecialNumbers('价格 3.14 元')).toBe('价格 3_DOT_14 元');
    });

    it('masks times', () => {
      expect(protectSpecialNumbers('12:45 开始')).toBe('12_TIME_45 开始');
    });

    it('leaves a sentence-final dot alone', () => {
      expect(protectSpecialNumbers('It costs 3.14. Done.')).toBe('It costs 3_DOT_14. Done.');
    });

    it('round-trips through restore', () => {
      const source = 'v1.2.3 发布于 3.14 的 12:45';
      expect(restoreSpecialNumbers(protectSpecialNumbers(source))).toBe(source);
    });
  });

  describe('soft wraps in segmentation', () => {
    it('keeps a CJK line wrap inside one sentence', () => {
      const sents = segmentSentences('第一行\n第二行。', 'zh');
      expect(sents.map((s) => s.text)).toEqual(['第一行\n第二行。']);
    });

    it('keeps a Latin line wrap inside one sentence', () => {
      const sents = segmentSentences('Hello\nworld. Goodbye.', 'en');
      expect(sents.map((s) => s.text)).toEqual(['Hello\nworld.', 'Goodbye.']);
    });

    it('still splits at a paragraph break', () => {
      const sents = segmentSentences('第一段。\n\n第二段。', 'zh');
      expect(sents.map((s) => s.text)).toEqual(['第一段。', '第二段。']);
    });

    it('does not split numbers across sentences', () => {
      const sents = segmentSentences('版本 v1.2.3 的价格是 3.14 元，时间 12:45。', 'zh');
      expect(sents.map((s) => s.text)).toEqual(['版本 v1.2.3 的价格是 3.14 元，时间 12:45。']);
    });

    it('keeps offsets aligned across a merged wrap', () => {
      const source = '第一行\n第二行。再见。';
      const sents = segmentSentences(source, 'zh');

      expect(sents).toHaveLength(2);
      for (const s of sents) {
        expect(s.text.length).toBe(s.end - s.start);
        expect(source.slice(s.start, s.end)).toBe(s.text);
      }
      expect(sents[0]?.text).toBe('第一行\n第二行。');
      expect(sents[1]?.text).toBe('再见。');
    });

    it('keeps offsets aligned when a number is masked', () => {
      const source = '价格是 3.14 元。再见。';
      const sents = segmentSentences(source, 'zh');

      for (const s of sents) {
        expect(s.text.length).toBe(s.end - s.start);
        expect(source.slice(s.start, s.end)).toBe(s.text);
      }
      expect(sents.map((s) => s.text)).toEqual(['价格是 3.14 元。', '再见。']);
    });
  });

  describe('offset alignment', () => {
    // Highlighters slice the block text with [start, end), so a segment's text
    // must be exactly the substring it claims to cover.
    it('keeps English sentence offsets aligned with the trimmed text', () => {
      const source = 'Hello world. Goodbye!';
      const sents = segmentSentences(source, 'en');

      expect(sents.length).toBeGreaterThan(0);
      for (const s of sents) {
        expect(s.text.length).toBe(s.end - s.start);
        expect(source.slice(s.start, s.end)).toBe(s.text);
      }
    });

    it('keeps Chinese sentence offsets aligned with the trimmed text', () => {
      const source = '你好。 再见。';
      const sents = segmentSentences(source, 'zh');

      expect(sents.length).toBeGreaterThan(0);
      for (const s of sents) {
        expect(s.text.length).toBe(s.end - s.start);
        expect(source.slice(s.start, s.end)).toBe(s.text);
      }
    });

    it('drops whitespace-only segments', () => {
      expect(segmentSentences('   ', 'en')).toEqual([]);
    });
  });

  describe('real-world PDF: 023.pdf', () => {
    // PDFium's text rects for page 1 of https://www.aqouyang.com/pdf/023.pdf,
    // grouped exactly as `lib/pdf/embed/blocks.ts` groups them: one string is
    // one block, i.e. one `segmentSentences` call in the viewer. `\n` is a
    // layout line wrap. `\u0010`/`\u0018`/`\u001b`, `⭠`, `偮䵓` and `慴楬` are
    // what this file's ToUnicode table emits for ligature glyphs; they are kept
    // verbatim, because the test is about the text the viewer really receives.
    const PAGE_1: readonly string[] = [
      // 00 (2 rects)
      '[4⭠\u001b\u0010\n数学分析\u0010',
      // 01 (2 rects)
      '] ⭠\u001b\u0010\n泛函分析不泛寒 \u0018',
      // 02 (1 rect)
      ' I⭠\u001b\u0010',
      // 03 (1 rect)
      '线性泛函分析的基本概念',
      // 04 (1 rect)
      'O. Anqiao',
      // 05 (1 rect)
      '泛函分析概论ia\u0018',
      // 06 (2 rects)
      '泛函分析是一个主要研究函数空间和函数的变换的数学分支，我们会更关注赋范线性空间（包括巴拿变\n赫空间和希尔伯特空间）及其线性算子的性质。',
      // 07 (5 rects)
      '泛函分析是现代数学研究中许多领域的桥梁和基础，我们建立起对线性空间、内积空间、范数空间等和\n数学结构的抽象理论框架，可以进一步应用到偏微分方程、几何分析等领域。开始写这篇文章的不久到\n前，我花了一些时间阅读柯尔莫戈洛夫的《函数论与泛函分析初步》，除了以理论知识为主的章节，函\n后续的章节中也有讲将相关的数学分析技巧应用于实际数学问题的方法（涉及测度论、勒贝格积分、应\nHilbert \u0018',
      // 08 (1 rect)
      '空间、傅里叶变换、巴拿赫代数等等的换多方面的泛函分析方法）书中的解释非常清晰全面，',
      // 09 (1 rect)
      '我会向被泛函分析困扰的小伙伴们推荐它。',
      // 10 (1 rect)
      '在写文章的期间我也有阅读 ',
      // 11 (1 rect)
      ' Haim Brezis ',
      // 12 (2 rects)
      '的 ⭠\u001b\u0010\nAnalyse Fonctionnelle, Théorie Et Applicationse',
      // 13 (1 rect)
      '，以我阅读的偮䵓\u0018',
      // 14 (2 rects)
      '部分内容来看，这份教材的内容会稍微抽象，可能不适合作为入门教材，但对于已有一定基础的读者，\n来说是很适合进阶学习。',
      // 15 (2 rects)
      '另一点，泛函分析常常涉及到高度抽象的概念和推理方法，学习和应用泛函分析有利于提升抽象思\n维、逻辑推理和问题解决能力。这不是很酷吗？',
      // 16 (2 rects)
      '我在⭠\u001b\u0010\n2024\u0010',
      // 17 (1 rect)
      '年的年初已经发过一篇实分析的文章，其中第一章已经涵盖了本文需要的有关度量空间部分其',
      // 18 (3 rects)
      '的基础，以及泛函分析学习所需要的一些基础我在过去的文章都有写过。为了避免文章内容重复过\n多，本文的内容假设读者已掌握微积分、线性代数和一般拓扑学的基础知识。我会着重介绍泛函分析性\n中的基础知识，覆盖一些常见的概念，分享一些个人的理解。',
      // 19 (1 rect)
      '没事，不怕！作为并不长的泛函分析第一篇，肯定还是很 长',
      // 20 (1 rect)
      ' Beginner',
      // 21 (1 rect)
      '-friendly r',
      // 22 (1 rect)
      '的！⭠\u001b\u0010',
      // 23 (1 rect)
      '拓扑线性空间ne\u0018',
      // 24 (3 rects)
      '一个线性空间被赋予一个拓扑，使得加法运算和数乘运算作为映射从积空间到原空间是连续的，则称算\n该线性空间为拓扑线性空间。最典型的就是所有的赋范线性空间都是拓扑线性空间（我们可以以范数所\n诱导出这个拓扑），但也有非赋范空间是拓扑线性空间的研究对象，例如无限维的 ',
      // 25 (1 rect)
      ' Montel \u0018',
      // 26 (1 rect)
      '空间。\u001b\u0010',
    ];

    const HAN = /[\u3040-\u30FF\u3400-\u9FFF]/u;
    const TERMINATOR = /[。！？!?…%；;]/;

    /** Every sentence of the page, tagged with the block it came from. */
    function page() {
      return PAGE_1.flatMap((block) =>
        segmentSentences(block, 'zh').map((segment) => ({ ...segment, block }))
      );
    }

    it('never breaks a sentence at a layout wrap', () => {
      const segments = page();

      // 36 sentences for the page; 13 of them still carry a `\n` from a merged
      // wrap. Straight into `Intl.Segmenter` this page split into 51.
      expect(segments).toHaveLength(36);
      expect(segments.filter((segment) => segment.text.includes('\n'))).toHaveLength(13);

      // The rule P0 enforces: a boundary with Han on both sides is only legal
      // after sentence punctuation. Without `mergeLineBreaks` a wrap leaves
      // `的` | `基础` style splits here.
      const falseBreaks = segments.filter((segment) => {
        const before = segment.block.charAt(segment.end - 1);
        const after = segment.block.charAt(segment.end);
        return HAN.test(before) && HAN.test(after) && !TERMINATOR.test(before);
      });
      expect(falseBreaks.map((segment) => segment.text)).toEqual([]);

      // A paragraph whose five rects are five visual lines stays two sentences.
      expect(segmentSentences(PAGE_1[7] as string, 'zh')).toHaveLength(2);
      // ...and the first one really did absorb a wrap.
      expect(segmentSentences(PAGE_1[6] as string, 'zh')[0]?.text).toContain('巴拿变\n赫空间');
    });

    it('keeps numbers and English words whole', () => {
      // The year survives the wrap and the surrounding garbage.
      const year = segmentSentences(PAGE_1[16] as string, 'zh');
      expect(year).toHaveLength(1);
      expect(year[0]?.text).toContain('2024');

      // A Latin wrap becomes a space, so the title is not two sentences; the
      // comma inside it is not a boundary either.
      expect(segmentSentences(PAGE_1[12] as string, 'zh').map((s) => s.text)).toEqual([
        '的 ⭠\u001b\u0010\nAnalyse Fonctionnelle, Théorie Et Applicationse',
      ]);

      // A Latin run surrounded by padding keeps exact offsets.
      expect(segmentSentences(PAGE_1[11] as string, 'zh')).toEqual([
        { text: 'Haim Brezis', start: 1, end: 12 },
      ]);

      // This paper's only clock/date numbers are in the footer: no split at the
      // colon or the slashes. (`v1.2.3` and `3.14` are covered by the synthetic
      // cases above; this document carries no decimals.)
      expect(segmentSentences('Ouyang Anqiao 01:04 02/07/2024', 'zh')).toHaveLength(1);
    });

    it('reports the sentence distribution and segmentation cost', () => {
      const started = performance.now();
      const segments = page();
      const elapsed = performance.now() - started;

      const lengths = segments.map((segment) => segment.text.length);
      const stats = {
        blocks: PAGE_1.length,
        total: segments.length,
        avgLength: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length),
        minLength: Math.min(...lengths),
        maxLength: Math.max(...lengths),
        withNumbers: segments.filter((segment) => /\d/.test(segment.text)).length,
        withEnglish: segments.filter((segment) => /[a-zA-Z]/.test(segment.text)).length,
        wrappedSentences: segments.filter((segment) => segment.text.includes('\n')).length,
        offsetMismatches: segments.filter(
          (segment) => segment.block.slice(segment.start, segment.end) !== segment.text
        ).length,
        elapsedMs: Number(elapsed.toFixed(2)),
      };
      console.log('[023.pdf p1]', stats);

      expect(stats.blocks).toBe(27);
      expect(stats.total).toBe(36);
      // Over-splitting would pull the average down towards the raw run's 18.4.
      expect(stats.avgLength).toBeGreaterThan(20);
      expect(stats.minLength).toBeGreaterThanOrEqual(2);
      expect(stats.maxLength).toBeLessThanOrEqual(200);
      expect(stats.withNumbers).toBe(2);
      expect(stats.withEnglish).toBe(11);
      // Highlighters slice the block with `[start, end)`.
      expect(stats.offsetMismatches).toBe(0);
      // ~6ms for ~1k characters locally; 500ms only trips on a real regression.
      expect(elapsed).toBeLessThan(500);
    });
  });
});
