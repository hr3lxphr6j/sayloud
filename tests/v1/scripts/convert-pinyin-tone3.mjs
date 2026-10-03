/**
 * Convert the upstream pinyin dictionaries from accented pinyin to TONE3.
 *
 *   node tests/v1/scripts/convert-pinyin-tone3.mjs <in-dir> <out-dir>
 *
 * Why this exists
 * ---------------
 * `ChinesePhonemizer` (src/rust/piper-plus-g2p/src/chinese.rs) reads the tone
 * with `extract_tone`, which looks for a trailing ASCII digit 1-5 and defaults
 * to 5 otherwise. It contains no diacritic handling at all.
 *
 * The dictionaries shipped upstream are in pypinyin's *default* style, which is
 * accented: `{"20320": "nǐ"}`. Feeding them in unchanged makes `extract_tone`
 * return tone 5 and leaves the accented vowel unmatched, so `你好` comes out as
 * `n{tone5}xo{tone5}` instead of `ni{tone3}x{aʊ}{tone3}`.
 *
 * So the dictionaries are converted here to the style the parser actually
 * expects (`{"20320": "ni3"}`). This is a *fix applied by the harness*, and the
 * report says so: the as-shipped state is measured separately, without it.
 *
 * Conversion rules: the tone is carried by the diacritic on the syllable's main
 * vowel (macron = 1, acute = 2, caron = 3, grave = 4); no diacritic = tone 5.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** accented vowel -> [plain vowel, tone] */
const TONES = {
  ā: ['a', 1], á: ['a', 2], ǎ: ['a', 3], à: ['a', 4],
  ē: ['e', 1], é: ['e', 2], ě: ['e', 3], è: ['e', 4],
  ī: ['i', 1], í: ['i', 2], ǐ: ['i', 3], ì: ['i', 4],
  ō: ['o', 1], ó: ['o', 2], ǒ: ['o', 3], ò: ['o', 4],
  ū: ['u', 1], ú: ['u', 2], ǔ: ['u', 3], ù: ['u', 4],
  ǖ: ['ü', 1], ǘ: ['ü', 2], ǚ: ['ü', 3], ǜ: ['ü', 4],
  ń: ['n', 2], ň: ['n', 3], ǹ: ['n', 4],
  ḿ: ['m', 2],
};

/**
 * One pinyin syllable -> `base + tone digit`.
 *
 * A syllable with no diacritic is already tone-numbered if it ends in 1-5
 * (the upstream files never do, but the converter stays idempotent so it can
 * be re-run on its own output).
 */
function toTone3(syllable) {
  if (/[1-5]$/.test(syllable)) {
    return syllable;
  }
  let tone = 5;
  let base = '';
  for (const ch of syllable) {
    const hit = TONES[ch];
    if (hit) {
      base += hit[0];
      tone = hit[1];
    } else {
      base += ch;
    }
  }
  return `${base}${tone}`;
}

/** Convert one dict value, preserving `a,b` alternative lists. */
function convertAlternatives(value) {
  return value
    .split(',')
    .map((alt) => toTone3(alt))
    .join(',');
}

const [, , inDir, outDir] = process.argv;
if (!inDir || !outDir) {
  throw new Error('usage: convert-pinyin-tone3.mjs <in-dir> <out-dir>');
}

mkdirSync(outDir, { recursive: true });

// ---- single-character dictionary: { "20320": "nǐ,nuò" } --------------------
const single = JSON.parse(readFileSync(resolve(inDir, 'pinyin_single.json'), 'utf8'));
const singleOut = {};
let singleChanged = 0;
for (const [key, value] of Object.entries(single)) {
  const converted = convertAlternatives(value);
  if (converted !== value) singleChanged += 1;
  singleOut[key] = converted;
}
writeFileSync(resolve(outDir, 'pinyin_single.json'), JSON.stringify(singleOut));

// ---- phrase dictionary: { "你好": [["nǐ"],["hǎo"]] } ----------------------
const phrases = JSON.parse(readFileSync(resolve(inDir, 'pinyin_phrases.json'), 'utf8'));
const phrasesOut = {};
let phraseSyllables = 0;
for (const [key, syllables] of Object.entries(phrases)) {
  phrasesOut[key] = syllables.map((group) => {
    const converted = group.map((syllable) => {
      phraseSyllables += 1;
      return toTone3(syllable);
    });
    return converted;
  });
}
writeFileSync(resolve(outDir, 'pinyin_phrases.json'), JSON.stringify(phrasesOut));

console.log(
  `   pinyin_single.json:  ${Object.keys(single).length} entries, ${singleChanged} rewritten`,
);
console.log(
  `   pinyin_phrases.json: ${Object.keys(phrases).length} phrases, ${phraseSyllables} syllables rewritten`,
);
