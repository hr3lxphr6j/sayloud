/**
 * Regenerate the Chinese pinyin data the Rust phonemizer embeds.
 *
 * The JavaScript half of the Chinese G2P reads `pinyin-pro`'s own tables at
 * runtime: `DICT1` for a character's readings, `DICT2`–`DICT5` (plus the numeral
 * rule table) for the phrases that decide which reading a character gets in
 * context, and `toneSandhiMap`/`toneSandhiIgnoreSuffix` for the 一/不 rules.
 * The Rust half has to answer the same questions with no JavaScript and no
 * network, so those tables are extracted here, once, into text files that
 * `include_str!` puts in the wasm.
 *
 * **This is a port, not a reimplementation.** `crates/phonemize/src/g2p/zh/pinyin.rs`
 * reproduces `pinyin-pro`'s algorithm step for step, so the data has to be
 * `pinyin-pro`'s own, and the readings have to stay in the order `pinyin-pro`
 * wrote them (that order *is* the priority: the first reading is the one a
 * character gets on its own).
 *
 * Four decisions are made here rather than in Rust, because they are decisions
 * about the data:
 *
 * - **Tone is precomputed, and precomputed here.** `pinyin-pro` stores readings
 *   with tone *symbols* (`nǐ`) and derives a tone *number* (`ni3`) at output
 *   time through two regex passes. Both passes are pure functions of the
 *   reading, so the number is computed here with `pinyin-pro`'s own
 *   `getPinyinWithoutTone`/`getNumOfTone` and the files carry `ni3`. Rust never
 *   has to know that `ǎ` means third tone — which is the point: a hand-written
 *   tone table in Rust would be a second place for the mapping to live.
 * - **The 一/不/了/々 rules are precomputed too.** They are the one part of the
 *   algorithm whose *inputs* are linguistic (`toneSandhiMap` is a map from a
 *   character and the next character's tone to a reading), so they are emitted
 *   as a rule table rather than re-encoded in Rust. `pinyin-special.txt` is that
 *   table, generated from `pinyin-pro`'s `special.mjs`.
 * - **`pinyin-pro`'s surname table is dropped.** With `surname: 'off'` — the
 *   default, and what `chinese.ts` uses — `acTree.match` filters out every
 *   pattern whose priority is `Surname`, so those patterns can never be selected.
 *   Shipping them would be 10 KB of data that is provably unreachable.
 * - **`pinyin-table.json` is transcribed, not regenerated.** It comes from
 *   `scripts/generate/gen-pinyin-table.py` (pypinyin, via misaki) and answers a different
 *   question — pinyin → IPA. This script only reads it and writes the same
 *   entries as `pinyin-syllables.txt`, so that the crate has no JSON parser
 *   dependency at runtime. The entry count is asserted, the way the pypinyin
 *   script asserts it, so a change of shape is loud here.
 *
 *   It sits in the crate's data directory, not in the JavaScript phonemize
 *   chain it used to live in: that chain is gone, and this script is now the only
 *   thing that reads the file.
 *
 * Regenerate with:
 *
 *     node scripts/generate/gen-pinyin-pro-data.mjs
 *
 * `--check` regenerates in memory and compares against the committed files
 * without writing anything, which is what CI or a reviewer wants.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getNumOfTone, getPinyinWithoutTone } from 'pinyin-pro/dist/esm/core/pinyin/handle.mjs';
import DICT1 from 'pinyin-pro/dist/esm/data/dict1.mjs';
import DICT2 from 'pinyin-pro/dist/esm/data/dict2.mjs';
import DICT3 from 'pinyin-pro/dist/esm/data/dict3.mjs';
import DICT4 from 'pinyin-pro/dist/esm/data/dict4.mjs';
import DICT5 from 'pinyin-pro/dist/esm/data/dict5.mjs';
import {
  PatternNumberDict,
  toneSandhiIgnoreSuffix,
  toneSandhiMap,
} from 'pinyin-pro/dist/esm/data/special.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const DATA_DIR = join(ROOT, 'crates', 'phonemize', 'data');

/** The pinyin-pro version these files were extracted from. */
const EXPECTED_VERSION = '3.29.4';

/** `Probability.DICT` and `Probability.Rule` (pinyin-pro's `common/constant.mjs`). */
const DICT_PROBABILITY = 2e-8;
const RULE_PROBABILITY = 1e-12;

/** The syllable table `gen-pinyin-table.py` writes. See the module doc for why it is read, not made. */
const SYLLABLE_SOURCE = join(ROOT, 'crates', 'phonemize', 'data', 'pinyin-table.json');
const EXPECTED_SYLLABLES = 426;

/**
 * A reading in the form the Rust side wants: toneless pinyin plus a tone digit.
 *
 * The tone has to come from the *symbol* form (`originPinyin` in
 * `pinyin-pro`'s `middlewareToneType`), not from the toneless one — that is the
 * whole reason the symbol is carried this far.
 *
 * **A reading can have no tone at all**, and the Rust side reads that as "the
 * last byte is not a digit". Exactly one does: 哼's *second* reading, `hng` —
 * `getNumOfTone` falls through to `''` for a syllable with no tone mark and no
 * plain vowel (`hng` has neither). Its first reading is `hēng`, so no text can
 * select the toneless one today: a character on its own takes its first reading,
 * and no phrase pattern contains 哼. It is still in the data, so the parser has
 * to accept it — and a port that gave it a tone would be answering a question
 * the original never asks.
 */
function reading(symbol) {
  const toneless = getPinyinWithoutTone(symbol);
  const tone = getNumOfTone(symbol);

  if (!/^[0-4]?$/.test(tone)) {
    throw new Error(`reading ${JSON.stringify(symbol)} has a multi-digit tone ${JSON.stringify(tone)}`);
  }
  if (toneless === '') {
    throw new Error(`reading ${JSON.stringify(symbol)} is toneless-empty`);
  }
  // The parser decides "is there a tone" from the last byte, so a toneless
  // syllable ending in a digit would be read as that digit's tone.
  if (/[0-9]$/.test(toneless)) {
    throw new Error(`reading ${JSON.stringify(symbol)} ends in a digit`);
  }
  return `${toneless}${tone}`;
}

/** Every character `pinyin-pro` has a reading for, with its readings in priority order. */
function characterTable() {
  const rows = [];

  // Single BMP characters live in `NumberDICT`, indexed by code unit; astral
  // characters are two code units to JavaScript, so `FastDictFactory.set` files
  // them under `StringDICT` instead. Both are one `char` to Rust and one element
  // of `splitString`'s output, so both belong here.
  for (let code = 0; code < DICT1.NumberDICT.length; code++) {
    const readings = DICT1.NumberDICT[code];
    if (readings === undefined) continue;
    rows.push({ char: String.fromCodePoint(code), readings });
  }

  for (const [key, readings] of DICT1.StringDICT) {
    if ([...key].length !== 1) {
      throw new Error(`DICT1 has a multi-character key ${JSON.stringify(key)}`);
    }
    rows.push({ char: key, readings });
  }

  const seen = new Set();
  const lines = rows
    .sort((a, b) => a.char.codePointAt(0) - b.char.codePointAt(0))
    .map(({ char, readings }) => {
      // A character in two dictionary keys would mean one of its readings is
      // silently unreachable, and which one depends on object key order.
      if (seen.has(char)) throw new Error(`DICT1 lists ${JSON.stringify(char)} twice`);
      seen.add(char);
      return `${char} ${readings.split(' ').map(reading).join(' ')}`;
    });

  if (lines.length === 0) throw new Error('DICT1 is empty — the pinyin-pro layout changed');
  return lines.join('\n') + '\n';
}

/**
 * The phrase patterns that decide a character's reading in context.
 *
 * `pinyin-pro` builds these into an Aho-Corasick automaton and then runs a
 * maximum-probability segmentation over the matches (`common/segmentit/`). The
 * only thing the Rust side needs from that is, for each phrase, its readings and
 * its probability — the automaton is rebuilt there as a hash lookup over the
 * last *n* characters, which finds the same patterns in the same order.
 */
function phraseTable() {
  /** @type {Map<string, {readings: string, probability: number, source: string}>} */
  const patterns = new Map();

  const add = (dict, probability, source) => {
    for (const [phrase, pinyin] of Object.entries(dict)) {
      if (pinyin.trim() === '') throw new Error(`${source} has an empty reading for ${phrase}`);

      const readings = pinyin.split(' ');
      const length = [...phrase].length;
      if (length < 2) {
        // A one-character pattern would be a character's *only* reading in
        // context, which `pinyin-pro` handles through `DICT1` instead — the
        // `match.length === 1 && priority <= Normal` branch in `handle.mjs`.
        throw new Error(`${source} has the one-character pattern ${JSON.stringify(phrase)}`);
      }
      if (readings.length !== length) {
        throw new Error(
          `${source}: ${JSON.stringify(phrase)} is ${length} characters but ${readings.length} readings`
        );
      }

      const existing = patterns.get(phrase);
      if (existing !== undefined) {
        // Two dictionaries disagreeing about one phrase is the kind of thing
        // that would otherwise be resolved by whichever file happened to be
        // read first.
        if (existing.readings !== pinyin) {
          throw new Error(
            `${JSON.stringify(phrase)} is ${existing.readings} in ${existing.source} and ${pinyin} in ${source}`
          );
        }
        // Same readings in two tables: keep the higher probability, which is
        // what `insertPattern`'s ordering does in `pinyin-pro`.
        if (probability > existing.probability) {
          patterns.set(phrase, { readings: pinyin, probability, source });
        }
        continue;
      }
      patterns.set(phrase, { readings: pinyin, probability, source });
    }
  };

  add(DICT2, DICT_PROBABILITY, 'DICT2');
  add(DICT3, DICT_PROBABILITY, 'DICT3');
  add(DICT4, DICT_PROBABILITY, 'DICT4');
  add(DICT5, DICT_PROBABILITY, 'DICT5');

  // The numeral rules are built in `special.mjs` rather than stored: a number
  // followed by 重/行/斗/更 keeps its full tone (`一重` → `yī chóng`), which is
  // the one place a numeral's tone is not sandhi'd away.
  for (const pattern of PatternNumberDict) {
    const existing = patterns.get(pattern.zh);
    if (existing !== undefined && existing.readings !== pattern.pinyin) {
      throw new Error(`${JSON.stringify(pattern.zh)} disagrees with the numeral rule table`);
    }
    if (existing === undefined || RULE_PROBABILITY > existing.probability) {
      patterns.set(pattern.zh, {
        readings: pattern.pinyin,
        probability: RULE_PROBABILITY,
        source: 'NumberDict',
      });
    }
  }

  const lines = [...patterns.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([phrase, { readings, probability }]) => {
      const tag =
        probability === DICT_PROBABILITY ? 'd' : probability === RULE_PROBABILITY ? 'r' : null;
      if (tag === null) throw new Error(`${phrase} has an unexpected probability ${probability}`);
      return `${phrase} ${tag} ${readings.split(' ').map(reading).join(' ')}`;
    });

  if (lines.length === 0) throw new Error('no phrase patterns — the pinyin-pro layout changed');
  return lines.join('\n') + '\n';
}

/**
 * The 一/不/了/々 rules, as a table rather than as code.
 *
 * `pinyin-pro` applies these inside `getPinyin`, one character at a time, in a
 * fixed order: `々`, then 了, then 一/不 (`getProcessFuncs`). Each row below is
 * one branch of that, with its reading already in tone-number form:
 *
 * - `s <char> <next tone> <reading>` — `toneSandhiMap`: 一 before a fourth tone
 *   is `yí`, before any other tone `yì`; 不 before a fourth tone is `bú`.
 * - `n <char> <reading>` — the 叠词 case (`看一看`, `去不去`), where the character
 *   between two of the same is read with no tone at all. `pinyin-pro` builds this
 *   by stripping the tone off the reading and numbering the result `0`, so the
 *   row is `yi0`, not `yi`.
 * - `d <char> <reading>` — the reading when no Chinese character precedes it.
 *   Both are string literals inside `handle.mjs` rather than table entries, so
 *   they are the two values here that are transcribed rather than derived; the
 *   parity corpus covers both.
 * - `x <char> <next char>` — `toneSandhiIgnoreSuffix`: these followers block the
 *   sandhi rules (`不一` is `bù yī`, not `bú yī`).
 */
function specialTable() {
  const lines = [];

  for (const [char, readings] of Object.entries(toneSandhiMap)) {
    for (const [symbol, tones] of Object.entries(readings)) {
      for (const tone of tones) {
        lines.push(`s ${char} ${tone} ${reading(symbol)}`);
      }
    }
  }

  // 一 and 不 are the only characters `toneSandhiMap` lists, and the neutral-tone
  // branch strips the tone from the same readings, so this is derived from the
  // map rather than restated.
  for (const char of Object.keys(toneSandhiMap)) {
    const symbol = toneSandhiMap[char][Object.keys(toneSandhiMap[char])[0]];
    const first = getSingleWordSymbol(char);
    const neutral = `${getPinyinWithoutTone(first)}0`;
    if (symbol === undefined || !/^[0-4]$/.test(getNumOfTone(neutral))) {
      throw new Error(`cannot build the neutral-tone reading for ${char}`);
    }
    lines.push(`n ${char} ${neutral}`);
  }

  lines.push(`d 了 ${reading('liǎo')}`);
  lines.push(`d 々 ${reading('tóng')}`);

  for (const [char, blocked] of Object.entries(toneSandhiIgnoreSuffix)) {
    for (const next of blocked) lines.push(`x ${char} ${next}`);
  }

  return lines.join('\n') + '\n';
}

/** The symbol form of a character's first reading, the way `handle.mjs` reads it. */
function getSingleWordSymbol(char) {
  const pinyin = DICT1.get(char);
  if (!pinyin) throw new Error(`DICT1 has no reading for ${JSON.stringify(char)}`);
  const index = pinyin.indexOf(' ');
  return index === -1 ? pinyin : pinyin.slice(0, index);
}

/** The syllable table, transcribed out of the JSON the JavaScript side reads. */
function syllableTable() {
  const parsed = JSON.parse(readFileSync(SYLLABLE_SOURCE, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${SYLLABLE_SOURCE} is not an object`);
  }

  const entries = Object.entries(parsed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length !== EXPECTED_SYLLABLES) {
    throw new Error(
      `${SYLLABLE_SOURCE} has ${entries.length} entries, expected ${EXPECTED_SYLLABLES} — ` +
        'run scripts/generate/gen-pinyin-table.py and review what changed'
    );
  }

  return (
    entries
      .map(([syllable, ipa]) => {
        if (typeof ipa !== 'string' || !ipa.includes('0')) {
          throw new Error(`${syllable} has no tone placeholder in ${JSON.stringify(ipa)}`);
        }
        if (/[\s]/.test(syllable)) throw new Error(`${syllable} has whitespace in it`);
        return `${syllable} ${ipa}`;
      })
      .join('\n') + '\n'
  );
}

/** `# Generated by …` plus a description of the columns, on every file. */
const header = (columns) =>
  `# Generated by scripts/generate/gen-pinyin-pro-data.mjs from pinyin-pro ${EXPECTED_VERSION} — do not edit.\n# ${columns}\n`;

function main() {
  const check = process.argv.includes('--check');

  const version = JSON.parse(
    readFileSync(join(ROOT, 'node_modules', 'pinyin-pro', 'package.json'), 'utf8')
  ).version;
  if (version !== EXPECTED_VERSION) {
    console.error(
      `pinyin-pro is ${version}, but these files were extracted from ${EXPECTED_VERSION}.\n` +
        'A new version can change a reading, and the readings are pinned by tests — ' +
        'bump EXPECTED_VERSION deliberately and review the diff.'
    );
    return 1;
  }

  const outputs = [
    {
      name: 'pinyin-chars.txt',
      content: header('<character> <reading>...   reading = toneless pinyin + tone (0 = neutral, absent = none)') + characterTable(),
      label: 'characters',
    },
    {
      name: 'pinyin-phrases.txt',
      content: header('<phrase> <tag> <reading>...   tag: d = dictionary (2e-8), r = numeral rule (1e-12)') + phraseTable(),
      label: 'phrases',
    },
    {
      name: 'pinyin-special.txt',
      content: header(
        's <char> <next tone> <reading> | n <char> <reading> | d <char> <reading> | x <char> <next char>'
      ) + specialTable(),
      label: '一/不/了/々 rules',
    },
    {
      name: 'pinyin-syllables.txt',
      content: header('<toneless syllable> <IPA with a 0 where the tone goes>') + syllableTable(),
      label: 'syllable table',
    },
  ];

  if (!check) mkdirSync(DATA_DIR, { recursive: true });

  let failed = false;
  for (const { name, content, label } of outputs) {
    const path = join(DATA_DIR, name);
    const relative = `crates/phonemize/data/${name}`;

    if (check) {
      let committed;
      try {
        committed = readFileSync(path, 'utf8');
      } catch {
        console.error(`${relative} is missing; run without --check`);
        failed = true;
        continue;
      }
      if (committed === content) {
        console.log(`${relative} is up to date (${label})`);
      } else {
        console.error(`${relative} is stale; run without --check`);
        failed = true;
      }
      continue;
    }

    writeFileSync(path, content);
    const lines = content.split('\n').length - 1;
    console.log(`wrote ${relative} (${label}, ${lines} lines, ${content.length} bytes)`);
  }

  return failed ? 1 : 0;
}

process.exit(main());
