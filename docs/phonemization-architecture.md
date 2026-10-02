# Phonemization Architecture

## Overview

Phonemization (text → IPA) only applies to **on-device Kokoro TTS**. Cloud providers (OpenAI, Volcengine, Azure, etc.) receive raw text and handle phonemization themselves.

The phonemization pipeline lives in `lib/models/kokoro-engine.ts` and delegates to language-specific phonemizers based on the voice's language.

## Shared Logic (common.ts)

Both Chinese and Japanese phonemizers share common preprocessing:

### 1. Punctuation Normalization (`normalizePunctuation`)

Converts full-width punctuation to ASCII equivalents:

- **Key behavior**: Comma (，) → Period (.) for stronger pausing
  - Chosen by listening tests (Chinese P5 spec)
  - Comma gives 290ms pause, period gives 270ms with longer gaps (180ms vs 170ms)
  - User selected this from 7 variants
- Enumeration comma (、) → ASCII comma (,)
- Full-width period (。) → ASCII period (.)
- Quotes (「」《》etc.) → ASCII quotes

**Why**: Kokoro's pause behavior is language-agnostic at the punctuation level.

### 2. Text Segmentation (`segmentText`)

Splits mixed-script text into runs:

- **Han**: Chinese characters (CJK Unified Ideographs)
- **Kana**: Japanese Hiragana/Katakana
- **Latin**: A-Z, a-z (for brand names, acronyms)
- **Other**: Punctuation and everything else

Each run type gets different phonemization:
- Han → pinyin-pro → IPA (Chinese)
- Kana → Kanji conversion → IPA mapping (Japanese)
- Latin → espeak (spelled or word)
- Other → keep only recognized punctuation

### 3. Latin Text Phonemization (`phonemizeSpelled`)

Rules:
- **All-uppercase** (API, LLM) → spell out letter by letter
- **Mixed-case** (ChatGPT, Agent) → treat as word via espeak

Uses dynamic import to avoid loading 1.3 MB espeak wasm in tests.

### 4. Punctuation Filtering (`keepPunctuation`)

Only keeps punctuation Kokoro's tokenizer recognizes:
```
space , . ! ? - : ; ( ) " '
```

Measured against `tokenizer.json` vocabulary during verification.

## Language-Specific Phonemizers

### Chinese (`chinese.ts`)

Pipeline:
1. Numbers → Chinese words (`numbers.ts`)
2. Normalize punctuation
3. Segment into Han/Latin/Other
4. Han → pinyin-pro → tone marks → IPA (with jieba word boundaries)
5. Latin → espeak
6. Concatenate (no separators)

Key details:
- Tone marks are arrows (↗↘) not diacritics
- Jieba provides word boundaries for multi-character compound phonemization
- Year readings: 2024 → 二零二四 (digit-by-digit, not 二千零二十四)

### Japanese (`japanese.ts`)

Pipeline:
1. Normalize punctuation
2. Segment into Kana/Han/Latin/Other
3. Kana/Han → Kuroshiro (Kanji→Katakana) → IPA mapping
4. Latin → espeak
5. Concatenate (no separators)

Key details:
- Kuroshiro uses vendored kuromoji (ES modules, runs in worker)
- Katakana→IPA mapping from hexgrad/misaki
- No word boundaries needed (Japanese is already segmented by kana)

### English (`english.ts`)

Direct espeak phonemization, no preprocessing.

## Architecture Decisions

### Why Cloud Providers Don't Use Phonemization

Cloud APIs expect raw text:
- They handle language detection internally
- They have their own G2P models
- Sending IPA would break their pipeline

Only `local.ts` (on-device Kokoro) calls `engine.phonemize()`.

### Why Punctuation Normalization is Shared

Kokoro's pause behavior is language-agnostic at the punctuation level:
- Same tokenizer for all languages
- Same pause durations for same ASCII marks
- Full-width → ASCII is always needed for CJK text

The "comma → period" rule was validated by listening tests and applies to both languages.

### Why Latin Handling is Shared

Both Chinese and Japanese need to handle:
- Brand names (ChatGPT, Kokoro)
- Acronyms (API, LLM, TTS)
- Mixed text (今天用API)

The "uppercase = spell, mixed = word" rule works universally.

### Why Segmentation is Shared

Both languages need to detect script boundaries:
- CJK characters vs Latin alphabet
- Different phonemization per script
- Preserve punctuation between runs

Unicode ranges make this language-agnostic.

## Testing Strategy

### Unit Tests

- **Japanese**: 27 tests (Kanji, Kana, punctuation, Latin)
- **Chinese**: Existing tests cover Han/Latin/punctuation
- **Common**: Tested through language-specific tests

### Integration Tests

- Japanese integration tests load real kuromoji dict
- Verify end-to-end: text → IPA → audio

### What's Not Tested

- Actual audio quality (requires listening)
- Pause durations (measured once, not continuously)
- Voice-specific behavior (depends on Kokoro model)

## Performance

### Lazy Loading

- espeak wasm (1.3 MB): Loaded only when Latin text appears
- Kuroshiro/kuromoji: Initialized on first Japanese text
- Jieba: Loaded on first Chinese text with word boundaries

### Memory

- Kuromoji dict: 13 MB compressed, ~30 MB decompressed in memory
- espeak wasm: 1.3 MB
- Jieba wasm: TBD

### Bottlenecks

- Kanji→Kana conversion (kuroshiro): ~10-50ms per sentence
- espeak phonemization: ~5-20ms per word
- Pinyin-pro: ~1-5ms per character

## Future Work

### Potential Improvements

1. **Number handling for Japanese**: 2024 → にせんにじゅうよん
2. **Context-aware readings**: 今日 (kyou vs kon-nichi)
3. **Proper noun detection**: ChatGPT should stay English
4. **User dictionaries**: Override readings for specific words

### Known Limitations

1. **No prosody control**: Only segmental phonemes, no pitch/duration
2. **No emphasis**: Can't mark stressed syllables
3. **Homograph ambiguity**: 读(dú vs dòu) depends on context
4. **Dialect variation**: Only supports standard pronunciations

## References

- [Chinese P5 Spec](../plans/2026-10-01-p5-chinese-g2p-v11zh-spec.md)
- [Japanese Implementation](./japanese-support-completed.md)
- [Kokoro Model](https://huggingface.co/hexgrad/Kokoro-82M)
- [Misaki G2P](https://github.com/hexgrad/misaki)
