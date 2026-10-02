/**
 * The English side's decisions, without the English side's wasm.
 *
 * `espeakLanguage` and `isInitialism` are pure, so they are tested here for real
 * rather than through a stub. The phonemization itself is not: it loads espeak's
 * 1.3 MB wasm, and the file that would pay for it is the wrong place to spend
 * 200 ms. What espeak actually does with these inputs is recorded in
 * `isInitialism`'s comment and covered end to end by the listening harness's
 * anchor, which compares against the real `ChinesePhonemizer`.
 *
 * This is its own file so that the cost of importing `english.ts` — which pulls
 * the wasm into the module graph — is paid once, by the tests that need it,
 * instead of by every test that touches Chinese phonemization.
 */
import { describe, expect, it } from 'vitest';
import { espeakLanguage, isInitialism } from '~/lib/models/phonemize/english';

describe('espeakLanguage', () => {
  it('maps the British tag and falls back to American for everything else', () => {
    expect(espeakLanguage('en-GB')).toBe('en-gb');
    expect(espeakLanguage('en-gb')).toBe('en-gb');
    expect(espeakLanguage('en-US')).toBe('en-us');
    // Not passed through: espeak rejects an unknown identifier by throwing, and
    // a thrown phonemizer error costs the user the whole sentence.
    expect(espeakLanguage('zh-CN')).toBe('en-us');
    expect(espeakLanguage('')).toBe('en-us');
  });
});

describe('isInitialism', () => {
  it('treats a capitalised run as an initialism, to be spelled out', () => {
    // The ones that matter: espeak reads `RAG` as the English word "rag" if it
    // is handed over whole, so capitals must take the letter-by-letter path.
    expect(isInitialism('RAG')).toBe(true);
    expect(isInitialism('LLM')).toBe(true);
    expect(isInitialism('QPS')).toBe(true);
    expect(isInitialism('API')).toBe(true);
    expect(isInitialism('GPT')).toBe(true);
    expect(isInitialism('GPU')).toBe(true);
  });

  it('treats anything with a lowercase letter as a word', () => {
    // These are what the rule buys: spelled letter by letter they came out as
    // A-G-E-N-T, K-O-K-O-R-O and C-H-A-T-G-P-T.
    expect(isInitialism('Agent')).toBe(false);
    expect(isInitialism('Kokoro')).toBe(false);
    expect(isInitialism('ChatGPT')).toBe(false);
    expect(isInitialism('OpenAI')).toBe(false);
    expect(isInitialism('WiFi')).toBe(false);
    expect(isInitialism('GitHub')).toBe(false);
  });

  it('does not require two capitals, because a lone letter is still a letter', () => {
    expect(isInitialism('A')).toBe(true);
    expect(isInitialism('I')).toBe(true);
  });

  it('records the miss: OK is a word that happens to be written in capitals', () => {
    // It comes out `ˈoʊ kˈeɪ` instead of `ˌoʊkˈeɪ`. Fixing it needs a list of
    // capitalised words English pronounces anyway, and one wrong word costs less
    // than maintaining that list. Pinned here so the behaviour is a decision
    // rather than a surprise.
    expect(isInitialism('OK')).toBe(true);
  });
});
