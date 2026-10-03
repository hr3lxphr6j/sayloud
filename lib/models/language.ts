/**
 * Which pipeline a BCP-47 tag takes.
 *
 * Both predicates are here rather than inside the JavaScript phonemize chain,
 * where they used to live, because the kokoro engine needs them to decide how to
 * render a piece — Chinese and Japanese go in as IPA through
 * `generate_from_ids`, English goes in as text through `generate()` — and that
 * engine must not depend on a chain that P6 replaced and phase 8 deleted. The
 * chain re-exported these so its own callers did not have to move in the same
 * commit; the chain is gone, so this module is the only home they need.
 */

/**
 * True for a language whose text goes down the Chinese pipeline.
 *
 * Only the primary subtag matters: `zh`, `zh-CN`, `zh-Hans` and `zh-TW` all
 * take the same path — P4's table is Mandarin, and the traditional/simplified
 * split is a writing system rather than a pronunciation.
 */
export function isChinese(lang: string): boolean {
  return lang.toLowerCase().startsWith('zh');
}

/** True for a language whose text goes down the Japanese pipeline. */
export function isJapanese(lang: string): boolean {
  return lang.toLowerCase().startsWith('ja');
}
