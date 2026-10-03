/**
 * The katakana→IPA table exists twice — in `lib/models/phonemize/japanese.ts`,
 * which the JavaScript pipeline uses, and in the generated
 * `crates/phonemize/src/frontends/ja_ipa_table.rs`, which the Rust pipeline
 * uses.
 *
 * Parity between the two pipelines is the point of P6, and a 193-entry table is
 * exactly the kind of thing that drifts by one entry. So neither side is allowed
 * to change alone: this test reads the Rust table back out of its source and
 * asserts it is the same table.
 *
 * The Rust table is generated from the TypeScript one by
 * `scripts/gen-ja-ipa-table.py`, so the usual cause of a failure here is that
 * someone edited one side and forgot the other.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KATAKANA_TO_IPA } from '@/lib/models/phonemize/japanese';

const RUST_TABLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'crates',
  'phonemize',
  'src',
  'frontends',
  'ja_ipa_table.rs'
);

/**
 * One `    ("\u{30a1}", "a"),` line, as `gen-ja-ipa-table.py` writes it.
 *
 * Escapes only, and only `\u{...}` and the four short forms the generator
 * emits — a table entry that needed anything else would mean the generator
 * changed, and this test should fail rather than mis-parse.
 */
const ENTRY =
  /^\s*\("((?:\\u\{[0-9a-f]{4}\}|\\["\\nrt]|[^"\\])*)", "((?:\\u\{[0-9a-f]{4}\}|\\["\\nrt]|[^"\\])*)"\),\s*$/gm;

function decode(escaped: string): string {
  return escaped
    .replace(/\\u\{([0-9a-f]{4})\}/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** The Rust table, as the pairs the generator wrote. */
function rustTable(): [string, string][] {
  const source = readFileSync(RUST_TABLE_PATH, 'utf8');
  const start = source.indexOf('pub const KATAKANA_TO_IPA');
  const end = source.indexOf('];', start);
  expect(start, 'the Rust table should be in the file').toBeGreaterThan(-1);

  return [...source.slice(start, end).matchAll(ENTRY)].map((match) => [
    decode(match[1] ?? ''),
    decode(match[2] ?? ''),
  ]);
}

describe('the generated Rust katakana table', () => {
  it('parses, so the rest of this file means something', () => {
    // A regex that stops matching would make the comparison below trivially
    // pass on two empty lists, which is the failure this whole test exists to
    // prevent.
    const entries = rustTable();
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.length).toBe(Object.keys(KATAKANA_TO_IPA).length);
  });

  it('is the same table as the TypeScript one', () => {
    const fromRust = rustTable();
    const fromTypeScript = Object.entries(KATAKANA_TO_IPA);

    // Compared entry by entry so a failure names the mora that differs rather
    // than printing 193 pairs.
    const differences: string[] = [];
    for (const [index, [kana, ipa]] of fromTypeScript.entries()) {
      const rust = fromRust[index];
      if (rust === undefined) {
        differences.push(`${kana} → ${ipa}: missing from the Rust table`);
      } else if (rust[0] !== kana || rust[1] !== ipa) {
        differences.push(
          `${kana} → ${ipa}: the Rust table has ${rust[0]} → ${rust[1]} at this position`
        );
      }
    }
    if (fromRust.length > fromTypeScript.length) {
      differences.push(
        `the Rust table has ${fromRust.length - fromTypeScript.length} entries the TypeScript one does not`
      );
    }

    expect(differences).toEqual([]);
  });
});
