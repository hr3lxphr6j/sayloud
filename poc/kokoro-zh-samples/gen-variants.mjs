/**
 * Generate the phoneme strings for the listening page (spike, throwaway).
 *
 *   npx jiti poc/kokoro-zh-samples/gen-variants.mjs
 *
 * The point of this file is to isolate the five deviations from the spec's §1.2
 * one at a time, so that listening to the page can say *which* change matters
 * rather than only whether the whole batch helps. Each variant flips exactly one
 * flag:
 *
 *   现状               every deviation present (what we ship today)
 *   只修 A（jieba）      word-internal concatenation, words from jieba
 *   对齐 A+B+D          A+B+D; toneSandhi deliberately untouched
 *   对齐 A+B+D + 补丁    the above plus the patch table
 *
 * The sentences are the user's own reported failures rather than invented ones,
 * because the invented ones turned out not to be audible. They exercise: an
 * unwanted pause inside 人设 and 曾经 (A), 得 read as dé where it should be děi or
 * a neutral de (E), punctuation that the model does not pause at (model-side),
 * and 知识 which our G2P gets right and the model renders as 指示 (model-side).
 *
 * `现状` is not hand-written: it is asserted equal to the *real* exported
 * `hanToIpa` / `mapPunctuation` / `splitRuns` output, so a drift in either the
 * product code or this reimplementation fails loudly instead of quietly
 * mislabelling a sample. The reimplementation exists only because the real one
 * has the flags hardcoded.
 *
 * The word boundaries come from jieba because that is what the model was trained
 * with (misaki's legacy path is `jieba.lcut` + `lazy_pinyin`). `hmm: true` is
 * load-bearing: with it off, jieba-wasm splits 还书 into 还|书 and diverges from
 * the Python jieba the training pipeline used. Measured on 24 sentences,
 * `cut(text, true)` and Python `jieba.lcut(text)` agree 24/24; with `hmm: false`
 * they already disagree on the first one.
 *
 * jieba-wasm is imported from a scratch install rather than package.json: the
 * dependency is not part of the product until the spec is approved, and this file
 * is a spike.
 */
import { cut } from '/tmp/jieba-check/node_modules/jieba-wasm/pkg/nodejs/jieba_rs_wasm.js';
import { pinyin } from 'pinyin-pro';
import { hanToIpa, mapPunctuation, retone, splitRuns, TONE_MAPPING } from '../../lib/models/phonemize/chinese.ts';
import { numbersToHan } from '../../lib/models/phonemize/numbers.ts';
import table from '../../lib/models/phonemize/pinyin-table.json' with { type: 'json' };
import { writeFileSync } from 'node:fs';

const ENTRIES = table;
const HAN = '\\u3007\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const KEPT_PUNCTUATION = new Set('$;:,.!?—…"()“”'.split(''));

/** A copy of the product's `syllableToIpa`, minus the file-private scope. */
function syllableToIpa(syllable) {
  const reported = Number(syllable.slice(-1));
  const tone = reported === 0 ? 5 : reported;
  const key = syllable.slice(0, -1).replaceAll('ü', 'v');
  const template = ENTRIES[key];
  if (template === undefined) throw new Error(`no IPA for ${key}`);
  return retone(template.replaceAll('0', TONE_MAPPING[tone]));
}

/** The product's `keepPunctuation`, with the trim made optional. */
function keepPunctuation(text, trim) {
  const kept = [...text]
    .filter((character) => /\s/.test(character) || KEPT_PUNCTUATION.has(character))
    .join('')
    .replace(/\s+/g, ' ');
  return trim ? kept.trim() : kept;
}

/** A faithful copy of the product's `hanToIpa`, with the flags exposed. */
function hanToIpaVariant(han, { toneSandhi, stripMark, boundaries }) {
  const syllables = pinyin(han, { toneType: 'num', type: 'array', nonZh: 'removed', toneSandhi });
  const characters = [...han];
  if (syllables.length !== characters.length) {
    throw new Error(`pinyin-pro read ${syllables.length}/${characters.length} of ${han}`);
  }
  const ipa = syllables.map(syllableToIpa).map((s) => (stripMark ? s.replaceAll('\u032F', '') : s));

  if (boundaries === 'syllable') return ipa.join(' ');

  // `boundaries` is a list of word lengths in characters — the caller decides
  // where the words are (Intl.Segmenter here, jieba on the Python side).
  const words = [];
  let at = 0;
  for (const length of boundaries) {
    words.push(ipa.slice(at, at + length).join(''));
    at += length;
  }
  if (at !== ipa.length) throw new Error(`word lengths cover ${at}/${ipa.length} syllables`);
  return words.join(' ');
}

/**
 * Word lengths from jieba — the training pipeline's segmenter, and phase 1's
 * choice (spec §3.2).
 *
 * `hmm: true` matches Python `jieba.lcut`'s default. See the file header.
 */
function jiebaWordLengths(han) {
  const words = cut(han, true);
  const lengths = words.map((w) => [...w].length);
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total !== [...han].length) throw new Error(`jieba covered ${total}/${[...han].length} of ${han}`);
  return lengths;
}

/** Longest-match patch application — the shape the spec proposes for T3. */
function applyPatches(han, syllables, patches) {
  const out = [...syllables];
  const chars = [...han];
  const keys = Object.keys(patches).sort((a, b) => b.length - a.length);
  for (let i = 0; i < chars.length; i += 1) {
    for (const key of keys) {
      const word = [...key];
      if (word.length > chars.length - i) continue;
      if (word.every((c, k) => c === chars[i + k])) {
        out.splice(i, word.length, ...patches[key].split(' '));
        i += word.length - 1;
        break;
      }
    }
  }
  if (out.length !== chars.length) throw new Error(`patch changed the syllable count of ${han}`);
  return out;
}

const PATCHES = {
  还书: 'huan2 shu1',
  // 得 是系统性错误：pinyin-pro 在「V + 得 + 补语」结构里一律给 de2，
  // 而它应该是轻声的 de（累得、跑得快、写得很好）或 děi（都得 = must）。
  都得: 'dou1 dei3',
  累得: 'lei4 de0',
};

/** The whole sentence, with the assembly strategy exposed too. */
function phonemize(text, opts) {
  const mapped = mapPunctuation(numbersToHan(text));
  const parts = [];
  // Recorded for the 2a sample, which needs the readings *and* the word
  // boundaries rather than the finished IPA.
  const syllables = [];
  let wordLengths = [];
  for (const run of splitRuns(mapped)) {
    if (run.kind === 'han') {
      const raw = pinyin(run.text, {
        toneType: 'num',
        type: 'array',
        nonZh: 'removed',
        toneSandhi: opts.toneSandhi,
      });
      const patched = opts.patches ? applyPatches(run.text, raw, opts.patches) : raw;
      const characters = [...run.text];
      const ipa = patched
        .map(syllableToIpa)
        .map((s) => (opts.stripMark ? s.replaceAll('\u032F', '') : s));
      if (ipa.length !== characters.length) throw new Error('count mismatch');
      syllables.push(...patched);

      if (opts.boundaries === 'syllable') {
        wordLengths.push(...ipa.map(() => 1));
        parts.push(ipa.join(' '));
      } else {
        const lengths = opts.boundaries(run.text);
        wordLengths.push(...lengths);
        const words = [];
        let at = 0;
        for (const length of lengths) {
          words.push(ipa.slice(at, at + length).join(''));
          at += length;
        }
        parts.push(words.join(' '));
      }
    } else if (run.kind === 'latin') {
      parts.push(`«${run.text}»`);
    } else {
      const kept = keepPunctuation(run.text, opts.trimOther);
      if (kept !== '') parts.push(kept);
    }
  }
  const joined = opts.spaceBetweenParts ? parts.join(' ') : parts.join('');
  return { phonemes: joined.replace(/\s+/g, ' ').trim(), syllables, wordLengths };
}

// --- the samples ------------------------------------------------------------

const SENTENCES = [
  {
    id: 'r1',
    text: '为了维持传奇潮男的人设，无论他想不想，都得常去夜场转悠……甚至连休息日都要练舞，累得他都快崩溃了。',
    why: '用户报告：「人设」中间有不该有的停顿；「得」读成二声（应 děi / de）；「……」没停顿',
  },
  {
    id: 'r2',
    text: '他的母亲作为众阳之民，一直怀念着遗产之地曾经叫做“亚斯拉尼荒野”的时候，怀念着太阳。',
    why: '用户报告：「曾经」二字中间有不该有的停顿',
  },
  {
    id: 'r3',
    text: '在众阳之民还生活在太阳之下的时代，长大成人的男孩要告别父母、远走他乡，但艾海亚打算留在村子和母亲一起生活。',
    why: '用户报告：第一个「，」没停顿，和后面连起来读了',
  },
  {
    id: 'r4',
    text: '要了解的知识',
    why: '用户报告：「知识」听起来像「指示」（注：我们的读音是对的，问题在模型）',
  },
];

const VARIANTS = [
  {
    id: 'current',
    label: '现状（全部偏差）',
    note: '每音节一空格 · 一/不 变调 · 保留 U+032F · 标点前有空格',
    opts: { toneSandhi: true, stripMark: false, boundaries: 'syllable', trimOther: true, spaceBetweenParts: true },
  },
  {
    id: 'fix-a',
    label: '只修 A 词边界（jieba）',
    note: '词内连写、词间空格，词边界用 jieba（训练时的分词器）；其余不变',
    opts: { toneSandhi: true, stripMark: false, boundaries: jiebaWordLengths, trimOther: true, spaceBetweenParts: true },
  },
  {
    id: 'aligned',
    label: '对齐 A+B+D（保留变调）',
    note: '阶段 1 的目标。jieba 边界 + 删 U+032F + 标点紧邻，不动变调；读音仍用 pinyin-pro',
    opts: { toneSandhi: true, stripMark: true, boundaries: jiebaWordLengths, trimOther: false, spaceBetweenParts: false },
  },
  {
    id: 'aligned-patched',
    label: '对齐 A+B+D + 补丁',
    note: '在上一版基础上加多音字补丁表（还书 / 都得 / 累得）',
    opts: { toneSandhi: true, stripMark: true, boundaries: jiebaWordLengths, trimOther: false, spaceBetweenParts: false, patches: PATCHES },
  },
];

// --- the anchor: 现状 must equal what the product actually produces ----------

/** The product's `phonemize`, non-Latin path, transcribed from chinese.ts. */
function productPhonemize(text) {
  const mapped = mapPunctuation(numbersToHan(text));
  const parts = [];
  for (const run of splitRuns(mapped)) {
    if (run.kind === 'han') {
      const ipa = hanToIpa(run.text, text);
      if (ipa !== '') parts.push(ipa);
    } else if (run.kind === 'latin') {
      parts.push(`«${run.text}»`);
    } else {
      const kept = keepPunctuation(run.text, true);
      if (kept !== '') parts.push(kept);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const mismatches = [];
for (const sentence of SENTENCES) {
  const mine = phonemize(sentence.text, VARIANTS[0].opts).phonemes;
  const real = productPhonemize(sentence.text);
  if (mine !== real) mismatches.push({ text: sentence.text, mine, real });
}
if (mismatches.length > 0) {
  console.error('现状 variant does not match the product:\n', JSON.stringify(mismatches, null, 2));
  process.exit(1);
}
console.log(`anchor ok: 现状 == product output for all ${SENTENCES.length} sentences`);

// --- emit -------------------------------------------------------------------

const out = [];
for (const sentence of SENTENCES) {
  for (const variant of VARIANTS) {
    if (variant.only && !variant.only.includes(sentence.id)) continue;
    const { phonemes, syllables, wordLengths } = phonemize(sentence.text, variant.opts);
    out.push({
      sentenceId: sentence.id,
      text: sentence.text,
      why: sentence.why,
      variantId: variant.id,
      label: variant.label,
      note: variant.note,
      phonemes,
      syllables,
      wordLengths,
    });
    console.log(`${sentence.id} ${variant.id.padEnd(17)} ${phonemes}`);
  }
}

writeFileSync(new URL('./variants.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`\nwrote variants.json (${out.length} entries)`);

// --- the 2a readings --------------------------------------------------------
//
// Phase 2a is *not* the aligned format: v1.1-zh wants sandhi back on (spec
// §4.4), and the patch table carries over (spec §4.5). Only the encoding
// changes, from IPA to bopomofo. So the readings are taken with `toneSandhi:
// true` and the patches applied, which is a combination no group-1 variant has.
const twoA = {};
for (const sentence of SENTENCES) {
  const { syllables, wordLengths } = phonemize(sentence.text, {
    toneSandhi: true,
    stripMark: true,
    boundaries: jiebaWordLengths,
    trimOther: false,
    spaceBetweenParts: false,
    patches: PATCHES,
  });
  twoA[sentence.id] = { syllables, wordLengths };
  console.log(`2a ${sentence.id} ${syllables.join(' ')}`);
}
writeFileSync(new URL('./two-a.json', import.meta.url), JSON.stringify(twoA, null, 1));
console.log('wrote two-a.json');
