/**
 * The stand-in for `phonemizer` (phase 10).
 *
 * It exists to be aliased in (`wxt.config.ts`) so that `kokoro-js`'s module-level
 * `import { phonemize } from "phonemizer"` does not pull espeak-ng's 2.5 MB wasm
 * into the package. One behaviour is worth pinning and this is it: **calling it
 * throws**, rather than returning something a caller could carry on from.
 *
 * The failure it guards against is not this file changing but the call coming
 * back: if `KokoroEngine.render` ever went back to `KokoroTTS.generate()`, a stub
 * that returned `[]` would make `kokoro-js`'s `phonemize(...).join(' ')` produce
 * an empty string, the tokenizer would produce no tokens, and the sentence would
 * play as silence — a bug that looks like a model problem and is not.
 */
import { describe, expect, it } from 'vitest';
import { phonemize } from '~/lib/models/phonemizer-stub';

describe('the phonemizer stub', () => {
  it('throws when called rather than returning empty phonemes', () => {
    expect(() => phonemize()).toThrow(/generate_from_ids/);
  });

  it('names itself, so the stack trace points at this file and not at kokoro-js', () => {
    // The message is the only handle a reader gets: the throw happens inside
    // minified `kokoro-js`, and without this the trace ends in a mangled
    // `function l(...)` with no way back to the decision that removed espeak.
    expect(() => phonemize()).toThrow(/phonemizer-stub\.ts/);
  });
});
