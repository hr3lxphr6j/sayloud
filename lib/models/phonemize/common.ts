/**
 * Common phonemization utilities shared across Chinese and Japanese.
 *
 * Both languages need:
 * - Full-width punctuation normalization
 * - Text segmentation into script runs (CJK / Latin / punctuation)
 * - Spelled Latin character phonemization via espeak
 */

/**
 * Script run types for mixed-script text segmentation.
 */
export type ScriptRun =
  | { kind: 'han'; text: string } // Chinese characters
  | { kind: 'kana'; text: string } // Japanese Hiragana/Katakana
  | { kind: 'latin'; text: string } // A-Z, a-z (will be spelled out)
  | { kind: 'other'; text: string }; // Punctuation and everything else

/**
 * Normalize full-width punctuation to ASCII equivalents.
 *
 * **Key behavior**: Comma (，) becomes a **period** to force pausing.
 * This was chosen by listening tests in Chinese (P5 spec), and applies
 * to Japanese as well since both use Kokoro's same pause behavior.
 *
 * Used by both Chinese and Japanese phonemizers before segmentation.
 *
 * @param text Input text with potential full-width punctuation
 * @param _lang Language code ('zh-CN', 'ja-JP', ...) — accepted but unused; kept
 *   for the language-specific rules that will hang off it.
 * @returns Text with normalized ASCII punctuation
 */
export function normalizePunctuation(text: string, _lang: string): string {
  return (
    text
      .replaceAll('、', ', ')
      // **Comma → Period**: force pause
      // Chosen by listening (Chinese P5 spec): comma gives 290ms pause,
      // period gives 270ms but with longer single gaps (180ms vs 170ms).
      // User selected this treatment from 7 variants.
      .replaceAll('，', '. ')
      .replaceAll('。', '. ')
      .replaceAll('．', '. ')
      .replaceAll('！', '! ')
      .replaceAll('：', ': ')
      .replaceAll('；', '; ')
      .replaceAll('？', '? ')
      .replaceAll('«', ' "')
      .replaceAll('»', '" ')
      .replaceAll('《', ' "')
      .replaceAll('》', '" ')
      .replaceAll('「', ' "')
      .replaceAll('」', '" ')
      .replaceAll('【', ' "')
      .replaceAll('】', '" ')
      .replaceAll('（', ' (')
      .replaceAll('）', ') ')
      .trim()
  );
}

/**
 * Segment text into script runs: Han/Kana/Latin/Other.
 *
 * Each contiguous run of the same script type is grouped together.
 * This allows different phonemization strategies per script:
 * - Han (Chinese): pinyin-pro → IPA
 * - Kana (Japanese): direct mapping → IPA
 * - Latin: espeak spelled (phonemizeSpelled)
 * - Other: kept as-is if in Kokoro's punctuation set
 *
 * @param text Input text (should already have normalized punctuation)
 * @returns Array of script runs
 */
export function segmentText(text: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  let current: ScriptRun | null = null;

  for (const char of text) {
    const code = char.charCodeAt(0);
    let kind: ScriptRun['kind'];

    // Determine script type
    if (
      // CJK Unified Ideographs
      (code >= 0x4e00 && code <= 0x9fff) ||
      // CJK Extension A
      (code >= 0x3400 && code <= 0x4dbf) ||
      // CJK Extension B-F
      (code >= 0x20000 && code <= 0x2ebef)
    ) {
      kind = 'han';
    } else if (
      // Hiragana
      (code >= 0x3040 && code <= 0x309f) ||
      // Katakana
      (code >= 0x30a0 && code <= 0x30ff) ||
      // Katakana Phonetic Extensions
      (code >= 0x31f0 && code <= 0x31ff)
    ) {
      kind = 'kana';
    } else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      // A-Z, a-z
      kind = 'latin';
    } else {
      kind = 'other';
    }

    // Merge into current run or start new run
    if (current && current.kind === kind) {
      current.text += char;
    } else {
      if (current) runs.push(current);
      current = { kind, text: char } as ScriptRun;
    }
  }

  if (current) runs.push(current);
  return runs;
}

/**
 * Phonemize Latin text by spelling it letter by letter via espeak.
 *
 * Used for brand names, acronyms, and other Latin text in CJK context.
 * Examples:
 * - "API" → "eɪ piː aɪ"
 * - "ChatGPT" → espeak's attempt at the word
 *
 * **Rule**: All-uppercase = spell out; contains lowercase = treat as word.
 *
 * Dynamic import to avoid loading 1.3 MB of espeak wasm in tests that don't need it.
 *
 * @param text Latin text to phonemize
 * @returns IPA phoneme string
 */
export async function phonemizeSpelled(text: string): Promise<string> {
  const { isInitialism, phonemizeEnglish, phonemizeSpelled: spelled } = await import('./english');

  // All uppercase = spell out letter by letter
  // Contains lowercase = treat as a word
  return isInitialism(text) ? spelled(text) : phonemizeEnglish(text);
}

/**
 * The punctuation marks that Kokoro's tokenizer recognizes.
 *
 * Measured against tokenizer.json vocabulary during verification.
 * Only these ASCII marks survive into the final IPA.
 */
const KOKORO_PUNCTUATION = new Set([' ', ',', '.', '!', '?', '-', ':', ';', '(', ')', '"', "'"]);

/**
 * Keep only punctuation that Kokoro understands.
 *
 * Any mark not in the tokenizer's vocabulary is dropped, since Kokoro
 * cannot do anything with it anyway.
 *
 * @param text Text containing potential punctuation
 * @returns Filtered text with only recognized punctuation
 */
export function keepPunctuation(text: string): string {
  return text
    .split('')
    .filter((char) => KOKORO_PUNCTUATION.has(char))
    .join('');
}
