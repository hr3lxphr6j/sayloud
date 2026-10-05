/**
 * Which phoneme inventory a voice needs, by the name of the model it belongs to.
 *
 * The two ids are model names — `kokoro-v1` and `kokoro-v11-zh` — because a
 * model ships exactly one inventory and one tokenizer: v1.0 keeps 115
 * characters and speaks IPA with four tone arrows, v1.1-zh keeps 172 and speaks
 * zhuyin with tone digits. The same Chinese text phonemizes to different
 * characters for each, and the wrong one is not a subtle quality difference —
 * the tokenizer deletes what it does not know, silently.
 *
 * So this is not a language and not a *front end* either: it follows the **voice
 * the user picked**, exactly as the language does, and both are known before the
 * first sentence (`lib/providers/local.ts`). The name it travels under is the
 * model's, which is why the Rust side calls the same field a vocabulary: that is
 * what the id selects for (`crates/phonemize/src/vocab.rs`).
 *
 * It lives in a module of its own rather than beside the phonemizer that uses
 * it because `lib/models/registry.ts` has to name one per model, and the
 * registry is imported by the side panel — which must never reach the
 * phonemizer's wasm. A type-only import would be erased today and a value
 * import would not, and nothing about that distinction is visible at the import
 * site; a module with no imports of its own is what makes it structural.
 */

/** The phoneme inventories this build can produce. */
export type VocabId = 'kokoro-v1' | 'kokoro-v11-zh';

/** Every vocabulary, so a validator does not have to list them twice. */
export const VOCAB_IDS: readonly VocabId[] = ['kokoro-v1', 'kokoro-v11-zh'];

/** True for a string that names a vocabulary this build knows. */
export function isVocabId(value: unknown): value is VocabId {
  return typeof value === 'string' && (VOCAB_IDS as readonly string[]).includes(value);
}
