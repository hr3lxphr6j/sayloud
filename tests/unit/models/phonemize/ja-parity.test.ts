/**
 * The Japanese parity corpus: one input, the phonemes the JavaScript pipeline
 * produces for it, and — where the Rust pipeline deliberately differs — what
 * Rust produces instead.
 *
 * It is committed, and both sides are pinned to it:
 *
 * - this file checks the JavaScript pipeline still produces `js`;
 * - `crates/phonemize/tests/ja_pipeline.rs` checks the Rust pipeline produces
 *   `rust ?? js`.
 *
 * Neither side can drift alone. A change to the JavaScript output fails here and
 * forces whoever made it to decide what the Rust output should become; the Rust
 * side then has to follow or record a divergence.
 *
 * Regenerate after an intended JavaScript change:
 *
 * ```text
 * PHONEMIZE_UPDATE_PARITY=1 pnpm vitest run tests/unit/models/phonemize/ja-parity.test.ts
 * ```
 *
 * The dictionary the Rust test needs is built by `scripts/setup-lindera-dict.sh`,
 * which `pnpm install` runs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { phonemizerFor } from '@/lib/models/phonemize';

const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'crates',
  'phonemize',
  'tests',
  'fixtures',
  'ja-parity.json'
);

interface Sample {
  input: string;
  /** What the JavaScript pipeline produces. */
  js: string;
  /** What Rust produces, when it is not meant to be the same as `js`. */
  rust?: string;
  /** Why they differ. Required whenever `rust` is present. */
  divergence?: string;
}

interface Corpus {
  generatedBy: string;
  samples: Sample[];
}

/**
 * The inputs, chosen to cover the paths that can break independently: the
 * dictionary lookup, each kana row, the mora that are two characters, the three
 * special mora, the numeral rules, the punctuation rules, and the one case where
 * Rust is knowingly not finished.
 *
 * Kept as text rather than as a JSON fixture so the reason each sample exists
 * sits next to it — a corpus is documentation of what was checked, and a bare
 * list of strings loses that.
 */
const INPUTS: string[] = [
  // Kana only: no dictionary lookup, so a failure here is the table or the
  // segmenter's fallback rather than IPADic.
  'こんにちは',
  'ありがとう',
  'さようなら',
  'ひらがなとカタカナ',
  // Kanji: the dictionary's reading is the whole answer.
  '経営',
  '学校',
  '新聞',
  '東京',
  '日本語',
  // Read alone this is ニッポン to lindera and, per the JavaScript test, either
  // ニホン or ニッポン there — a segmentation difference between IPADic and
  // kuromoji that this sample is here to make visible rather than to hide.
  '日本',
  // The three special mora, which each have their own table entry.
  'がっこう',
  'コーヒー',
  'しんぶん',
  // Two-character mora: palatalized and foreign. These are the entries a
  // longest-match lookup gets wrong by taking the first character.
  'きゃく',
  'しゃしん',
  'インターネット',
  'キャンプ',
  // Numerals, which are read before segmentation and carry five sound changes
  // the dictionary does not make.
  '2022年',
  '三百',
  '六百',
  '八百',
  '三千',
  '8000',
  '10001',
  '15.6%',
  '２０２２年',
  // Punctuation, including the comma-to-period rewrite.
  'こんにちは、せかい。',
  '「はい」',
  'ほんとう？',
  // Mixed, which exercises the run splitter.
  '東京は日本の首都です。',
  'こんにちは、世界',
  '今日は良い天気ですね',
  'わたしは',
  'りんご、バナナ、オレンジ',
  '7',
  '八千',
  '資産３２億ドル、約４２００億円',
  // Latin runs. `APIを使う` is the one sample Rust is *still* meant to differ on,
  // and it is now a phoneme-detail difference rather than a missing engine: both
  // sides spell the acronym out, piper gives `ə pˈiː aɪ` where espeak gives
  // `ɐ pˈiː ˈaɪ`. `Chatを使う` and `あQい` matched exactly once the English
  // backend landed, so their divergence notes were deleted — a note that has
  // stopped being true is worse than none.
  'APIを使う',
  'Chatを使う',
  // A character no table entry covers, which the IPA conversion keeps as-is.
  'あQい',
];

const UPDATE = process.env.PHONEMIZE_UPDATE_PARITY === '1';

/** The corpus as it is on disk, or a fresh one built from {@link INPUTS}. */
async function build(): Promise<Corpus> {
  const phonemizer = await phonemizerFor('ja');

  // Loaded whether or not this is a regeneration: `rust` and `divergence` are
  // decisions about the Rust side that this file does not recompute, so a
  // comparison that dropped them would report a difference on every run.
  const existing = loadExisting();
  const samples: Sample[] = [];

  for (const input of INPUTS) {
    const js = await phonemizer.phonemize(input, 'ja');
    const previous = existing?.samples.find((sample) => sample.input === input);
    samples.push(
      previous?.rust === undefined
        ? { input, js }
        : { input, js, rust: previous.rust, divergence: previous.divergence }
    );
  }

  return { generatedBy: 'tests/unit/models/phonemize/ja-parity.test.ts', samples };
}

/** The committed corpus, so a regeneration keeps its divergence notes. */
function loadExisting(): Corpus | undefined {
  try {
    return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;
  } catch {
    return undefined;
  }
}

describe('the Japanese parity corpus', () => {
  it('is what the JavaScript pipeline produces', async () => {
    const corpus = await build();

    if (UPDATE) {
      mkdirSync(dirname(CORPUS_PATH), { recursive: true });
      writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
      console.log(`wrote ${CORPUS_PATH} (${corpus.samples.length} samples)`);
      return;
    }

    const committed = loadExisting();
    expect(committed, `${CORPUS_PATH} is missing; regenerate it`).toBeDefined();

    // Compared as a whole rather than sample by sample so a change to the
    // JavaScript output reports the two strings that differ, which is what the
    // person reading it needs.
    expect(corpus.samples).toEqual(committed?.samples);
  });

  it('records a reason for every sample Rust is meant to differ on', () => {
    const committed = loadExisting();
    for (const sample of committed?.samples ?? []) {
      if (sample.rust !== undefined) {
        expect(
          sample.divergence,
          `${JSON.stringify(sample.input)} records a Rust divergence with no reason`
        ).toBeTruthy();
      }
    }
  });
});
