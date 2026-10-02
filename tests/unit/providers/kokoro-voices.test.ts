/**
 * The Kokoro voice table (P4 spec §3.11.6).
 *
 * The table is what the voice picker offers, so a voice in it that the model
 * cannot speak is a bug the user finds by picking it — which is why the
 * repository's other 18 voices are absent, and why the prefixes are worth
 * asserting: the engine derives a language from the prefix, so a voice listed
 * under the wrong one would be phonemized by the wrong pipeline.
 */
import { describe, expect, it } from 'vitest';
import { KOKORO_82M } from '~/lib/models/registry';
import {
  CHINESE_VOICES,
  ENGLISH_VOICES,
  JAPANESE_VOICES,
  KOKORO_VOICES,
} from '~/lib/providers/kokoro-voices';

const ENGLISH_IDS = [
  'af_heart',
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
  'bf_emma',
  'bf_isabella',
  'bm_george',
  'bm_lewis',
  'bf_alice',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
];

const CHINESE_IDS = [
  'zf_xiaobei',
  'zf_xiaoni',
  'zf_xiaoxiao',
  'zf_xiaoyi',
  'zm_yunjian',
  'zm_yunxi',
  'zm_yunxia',
  'zm_yunyang',
];

const JAPANESE_IDS = ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo'];

describe('KOKORO_VOICES', () => {
  it('holds the 41 voices the model can actually speak', () => {
    expect(KOKORO_VOICES).toHaveLength(41);
    expect(ENGLISH_VOICES).toHaveLength(28);
    expect(CHINESE_VOICES).toHaveLength(8);
    expect(JAPANESE_VOICES).toHaveLength(5);
  });

  it('matches the repository exactly, with nothing extra', () => {
    // 54 voices ship; the 13 left out would each need their own G2P, so
    // offering them would only produce an error when one was picked.
    expect(KOKORO_VOICES.map((voice) => voice.id)).toEqual([
      ...ENGLISH_IDS,
      ...CHINESE_IDS,
      ...JAPANESE_IDS,
    ]);
  });

  it('gives every voice a unique id', () => {
    const ids = KOKORO_VOICES.map((voice) => voice.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports the model registry voice count', () => {
    expect(KOKORO_82M.voiceCount).toBe(KOKORO_VOICES.length);
  });

  it('lists only the languages the model registry claims', () => {
    const supported = new Set(KOKORO_82M.languages);
    for (const voice of KOKORO_VOICES) {
      expect(supported, voice.id).toContain(voice.lang);
    }
  });

  it('gives every voice a BCP-47 tag, a name and a gender', () => {
    for (const voice of KOKORO_VOICES) {
      expect(voice.lang, voice.id).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
      expect(voice.name.length, voice.id).toBeGreaterThan(0);
      expect(['female', 'male'], voice.id).toContain(voice.gender);
    }
  });

  it('keeps the language and gender the id prefix implies', () => {
    // `af` is American female and so on; `zf`/`zm` are Mandarin, `jf`/`jm` are Japanese.
    // The engine derives the phonemization path from this prefix, so a mismatch here
    // would send a voice down the wrong pipeline.
    const expected: Record<string, { lang: string; gender: string }> = {
      af: { lang: 'en-US', gender: 'female' },
      am: { lang: 'en-US', gender: 'male' },
      bf: { lang: 'en-GB', gender: 'female' },
      bm: { lang: 'en-GB', gender: 'male' },
      zf: { lang: 'zh-CN', gender: 'female' },
      zm: { lang: 'zh-CN', gender: 'male' },
      jf: { lang: 'ja', gender: 'female' },
      jm: { lang: 'ja', gender: 'male' },
    };

    for (const voice of KOKORO_VOICES) {
      const want = expected[voice.id.slice(0, 2)];
      expect(want, voice.id).toBeDefined();
      expect(voice.lang, voice.id).toBe(want?.lang);
      expect(voice.gender, voice.id).toBe(want?.gender);
    }
  });

  it('advertises no word timings', () => {
    // Kokoro returns audio only, and SayLoud highlights the whole sentence
    // rather than estimating word positions.
    for (const voice of KOKORO_VOICES) {
      expect(voice.supportsTimings, voice.id).toBe(false);
    }
  });
});
