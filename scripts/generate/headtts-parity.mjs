/**
 * Dump HeadTTS's English letter-to-sound rules into the parity fixture.
 *
 * HeadTTS (`@met4citizen/headtts`) turns English words into phonemes with two
 * tables: a 125 829-word pronouncing dictionary, and — for everything the
 * dictionary does not have — the letter-to-sound rules of NRL Report 7948
 * ("Automatic Translation of English Text to Phonetics by Means of
 * Letter-to-Sound Rules", 1976). Phase 9A ports the second table to Rust, and
 * this script is where the port's expected values come from.
 *
 * It runs **upstream JavaScript**, not a copy of it: every `phonemes` string in
 * the output is what `Language#phonemizeWord` returned, so the Rust engine in
 * `crates/phonemize/src/backends/headtts_en/` is checked against HeadTTS rather
 * than against this repository's idea of HeadTTS. `rules` is dumped for the same
 * reason — it is upstream's own `{regex, move, phonemes}` triples — and
 * `scripts/generate/gen-headtts-rules.mjs` transcribes it into `rules.rs`.
 *
 * The output is committed, so nothing in CI needs the HeadTTS checkout:
 *
 *     HEADTTS_DIR=/path/to/HeadTTS node scripts/generate/headtts-parity.mjs
 *
 * **Regenerating is a deliberate act, not a routine one.** It rewrites the
 * expected values of every Rust test that reads the fixture, so a regeneration
 * against a different HeadTTS revision is a change of the thing being tested and
 * has to be reviewed as one. The provenance block records the revision, the
 * package version and the SHA-256 of the one module the rules live in, so a
 * reviewer can see that it changed.
 *
 * **The word list is platform-dependent and the expected values are not.**
 * `/usr/share/dict/words` is the second half of the candidate corpus, and it is a
 * different file on Linux than on macOS; the covering pass would then pick
 * different words that cover the same 305 rules. So a regeneration on another
 * machine is a diff in `words` and in nothing else, and a diff anywhere else in
 * the file means upstream moved. Checking the committed fixture against a live
 * checkout is what tells those two apart, and it is what was run when this phase
 * landed: 296 words and 309 rules, no differences.
 *
 * # Why the word list is chosen by a covering pass
 *
 * 309 rules, and a fixture that exercises 200 of them only pins 200 of them. The
 * selection below keeps every word that fires a rule no earlier word fired, in
 * descending order of how many rules a word fires, so the committed list covers
 * the whole table with as few words as possible. `tests/headtts_en.rs` asserts
 * the coverage, so a rule added upstream and not exercised here is a failure
 * rather than a silently untested rule.
 *
 * The candidates are the HeadTTS dictionary's own keys (the words a reader is
 * most likely to type) plus `/usr/share/dict/words` when it is readable — the
 * dictionary is the corpus, not the answer key: nothing here looks up a word's
 * pronunciation, only which rules its spelling fires.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const OUT = join(ROOT, 'crates', 'phonemize', 'tests', 'fixtures', 'headtts-en-parity.json');

const HEADTTS_DIR = process.env.HEADTTS_DIR || '/tmp/HeadTTS';
const MODULE = join(HEADTTS_DIR, 'modules', 'language-en-us.mjs');
const DICTIONARY = join(HEADTTS_DIR, 'dictionaries', 'en-us.txt');
/** Where the candidates come from when the checkout carries no dictionary. */
const WORD_LIST = '/usr/share/dict/words';

/**
 * Words that are in the fixture because a reader would type them, not because
 * they cover a rule: product names, surnames and place names are what the OOV
 * path is for, and a covering pass over a dictionary of common words is exactly
 * the wrong way to find them.
 */
const CURATED = [
  // Names and places — the OOV words a text-to-speech system actually meets.
  'kokoro', 'openai', 'github', 'chatgpt', 'shakespeare', 'einstein', 'manhattan',
  'typescript', 'javascript', 'pytorch', 'youtube', 'iphone', 'oauth', 'devops',
  'tolkien', 'hemingway', 'kafka', 'wojciechowski', 'srinivasan', 'nakamura',
  'reykjavik', 'ljubljana', 'tucson', 'yosemite', 'mississippi', 'massachusetts',
  'kubectl', 'nginx', 'localhost', 'yaml', 'postgres', 'redis', 'webpack', 'eslint',
  // Irregular spellings the rules should get right and a dictionary cannot cover.
  'tough', 'through', 'thorough', 'thought', 'bought', 'though', 'cough', 'slough',
  'enough', 'rough', 'plough', 'borough', 'thoroughfare', 'weight', 'height',
  'neighbour', 'leisure', 'seizure', 'measure', 'treasure', 'closure',
  // The three samples in HeadTTS's own test suite (`tests/language-en-us.test.mjs`).
  'and', 'merchandise', 'notindictionary',
];

/** Non-alphabetic inputs, which the rules engine is also expected to survive. */
const NON_ALPHABETIC = ["don't", 'well-known', "o'clock", 'e.g.', 'a1', 'x-ray'];

/**
 * The rule table, in a stable order.
 *
 * Upstream keeps it as an object keyed by the first letter of each pattern, and
 * walks it in the order the letters appear in the word. Sorting the keys rather
 * than trusting the object literal's insertion order costs nothing and makes the
 * fixture independent of how the source file happens to be laid out.
 */
function dumpRules(lang) {
  const rules = [];
  for (const letter of Object.keys(lang.rules).sort()) {
    for (const rule of lang.rules[letter]) {
      rules.push([letter, rule.regex.source, rule.move, rule.phonemes.join('')]);
    }
  }
  return rules;
}

/** The punctuation table from `language.mjs`, which `phonemizeWord` echoes. */
const PUNCTUATION = {
  ';': ';', ':': ':', ',': ',', '.': '.', '!': '!', '?': '?', '¡': '!', '¿': '?',
  '—': '—', '"': '"', '…': '…', '«': '"', '»': '"', '“': '"', '”': '"',
  '(': '(', ')': ')', '{': '(', '}': ')', '[': '(', ']': ')', ' ': ' ', '-': '-',
  "'": "'",
};

/**
 * Which rules a word fires, keyed `LETTER#INDEX`, in one pass.
 *
 * A transcription of upstream's own `phonemizeWord` loop — including the
 * detail that only the character at the current position is lower-cased before
 * the regex is matched, which is what anchors each pattern. It is used only to
 * *choose* the word list; every expected value comes from `phonemizeWord`
 * itself, and the two are compared below so that a misreading of the loop shows
 * up here rather than as a Rust test failing later.
 */
function firedRules(word, rules) {
  const fired = new Set();
  const produced = [];
  const chars = [...word];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    // `phonemizeWord` passes a punctuation through as itself before it ever
    // looks for rules — `-` and `'` survive `normalizeUpper`, so a hyphenated
    // word reaches the phoneme string with its hyphen in it.
    if (Object.hasOwn(PUNCTUATION, c)) {
      produced.push(PUNCTUATION[c]);
      i += 1;
      continue;
    }
    const group = rules[c];
    if (!group) {
      i += 1;
      continue;
    }
    const test = word.substring(0, i) + c.toLowerCase() + word.substring(i + 1);
    let hit = -1;
    for (let j = 0; j < group.length; j += 1) {
      if (test.match(group[j].regex)) {
        hit = j;
        break;
      }
    }
    if (hit < 0) {
      throw new Error(`${word}: no rule matched ${c} at ${i}, which upstream would loop on`);
    }
    fired.add(`${c}#${hit}`);
    produced.push(group[hit].phonemes.join(''));
    i += group[hit].move;
  }
  return { fired, produced: produced.join('') };
}

/** Every candidate word, in a deterministic order. */
function candidates(lang) {
  const words = new Set(CURATED);
  for (const extra of NON_ALPHABETIC) words.add(extra);
  try {
    for (const line of readFileSync(DICTIONARY, 'utf8').split('\n')) {
      const word = line.split('\t')[0].trim();
      if (word && /^[A-Za-z'-]+$/.test(word)) words.add(word.toLowerCase());
    }
  } catch {
    // No checkout dictionary: `/usr/share/dict/words` is the fallback corpus.
  }
  try {
    for (const line of readFileSync(WORD_LIST, 'utf8').split('\n')) {
      const word = line.trim();
      if (word && /^[A-Za-z'-]+$/.test(word)) words.add(word.toLowerCase());
    }
  } catch {
    // macOS keeps it in `/usr/share/dict/words`; a platform without one still
    // has the HeadTTS dictionary.
  }
  return [...words].sort();
}

/** Cover every rule with as few words as the candidate list allows. */
function select(words, lang) {
  const analysed = words.map((word) => {
    const normalized = lang.normalizeUpper(word).join('');
    CACHE.set(word, normalized);
    const { fired, produced } = firedRules(normalized, lang.rules);
    return { word, normalized, fired, produced };
  });

  const covered = new Set();
  const chosen = [];
  const bySize = [...analysed].sort((a, b) => b.fired.size - a.fired.size || (a.word < b.word ? -1 : 1));
  for (const entry of bySize) {
    let adds = false;
    for (const rule of entry.fired) {
      if (!covered.has(rule)) {
        adds = true;
        break;
      }
    }
    if (!adds) continue;
    for (const rule of entry.fired) covered.add(rule);
    chosen.push(entry);
  }

  // The curated words are in the fixture whether or not they cover anything.
  for (const word of CURATED) {
    const normalized = CACHE.get(word);
    if (!chosen.some((entry) => entry.word === word)) {
      chosen.push(analysed.find((entry) => entry.word === word));
    }
  }
  return { chosen, covered };
}

const CACHE = new Map();

async function main() {
  const { Language } = await import(resolve(MODULE));
  const lang = new Language();

  const totalRules = dumpRules(lang).length;
  const { chosen, covered } = select(candidates(lang), lang);

  const words = chosen
    .filter(Boolean)
    .map((entry) => {
      const expected = lang.phonemizeWord(entry.normalized).join('');
      if (expected !== entry.produced) {
        throw new Error(
          `${entry.word}: the scan above produced ${JSON.stringify(entry.produced)} but ` +
            `upstream produced ${JSON.stringify(expected)} — this script's reading of ` +
            'phonemizeWord is wrong, and the fixture would be too',
        );
      }
      return { word: entry.word, normalized: entry.normalized, phonemes: expected };
    })
    .sort((a, b) => (a.word < b.word ? -1 : 1));

  const bytes = readFileSync(MODULE);
  let revision = null;
  try {
    revision = execFileSync('git', ['-C', HEADTTS_DIR, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    revision = null;
  }

  const fixture = {
    $comment:
      'Generated by scripts/generate/headtts-parity.mjs from an upstream HeadTTS checkout. ' +
      'Do not edit: regenerate, and review the provenance change.',
    source: {
      package: JSON.parse(readFileSync(join(HEADTTS_DIR, 'package.json'), 'utf8')).version,
      module: 'modules/language-en-us.mjs',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      revision,
      url: 'https://github.com/met4citizen/HeadTTS',
      license: 'MIT (c) 2025 Mika Suominen',
    },
    counts: { rules: totalRules, rulesExercised: covered.size, words: words.length },
    rules: dumpRules(lang),
    words,
  };

  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `${OUT}: ${totalRules} rules (${covered.size} exercised), ${words.length} words`,
  );
  // Keyed the way `firedRules` keys them — by group and index within the group —
  // which is the only key that survives `dumpRules`' flattening.
  const uncovered = [];
  for (const [letter, group] of Object.entries(lang.rules)) {
    group.forEach((_, j) => {
      if (!covered.has(`${letter}#${j}`)) uncovered.push(`${letter}#${j}`);
    });
  }
  if (uncovered.length) {
    console.log(`unexercised rules (${uncovered.length}): ${uncovered.join(', ')}`);
  }
}

await main();
