/**
 * Kokoro's voices, as a static table.
 *
 * Static on purpose: the voice picker must not need the network, and it must
 * not need the model either — this is the list of what *could* be synthesized,
 * while "which of them are downloaded" is the model store's question.
 *
 * Only the 41 voices that have G2P support are listed here:
 * - 28 English voices (American & British)
 * - 8 Chinese voices
 * - 5 Japanese voices
 *
 * The repository ships 54 voices total, but the other 13 (Spanish, French, Hindi,
 * Italian, Portuguese) would each need their own G2P — listing them would only
 * offer the user a voice that throws when used.
 *
 * The English half is generated from `kokoro-js`'s own `VOICES` metadata
 * (name, language, gender), which is also the list its `generate()` validates
 * against. The Chinese and Japanese halves are written out by hand: the repository
 * publishes no display names for those voices, only the id.
 *
 * Loaded only by `listVoices()`, so the offscreen document — which only
 * synthesizes — never carries it.
 */
import type { Voice } from './types';

/** The 28 English voices: 20 American, 8 British. */
export const ENGLISH_VOICES: readonly Voice[] = [
  {
    id: 'af_heart',
    name: 'Heart',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_alloy',
    name: 'Alloy',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_aoede',
    name: 'Aoede',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_bella',
    name: 'Bella',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_jessica',
    name: 'Jessica',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_kore',
    name: 'Kore',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_nicole',
    name: 'Nicole',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_nova',
    name: 'Nova',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_river',
    name: 'River',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_sarah',
    name: 'Sarah',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'af_sky',
    name: 'Sky',
    lang: 'en-US',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'am_adam',
    name: 'Adam',
    lang: 'en-US',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'am_echo',
    name: 'Echo',
    lang: 'en-US',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'am_eric',
    name: 'Eric',
    lang: 'en-US',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'am_fenrir',
    name: 'Fenrir',
    lang: 'en-US',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'am_liam',
    name: 'Liam',
    lang: 'en-US',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'am_michael',
    name: 'Michael',
    lang: 'en-US',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'am_onyx',
    name: 'Onyx',
    lang: 'en-US',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'am_puck',
    name: 'Puck',
    lang: 'en-US',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'am_santa',
    name: 'Santa',
    lang: 'en-US',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'bf_emma',
    name: 'Emma',
    lang: 'en-GB',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'bf_isabella',
    name: 'Isabella',
    lang: 'en-GB',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'bm_george',
    name: 'George',
    lang: 'en-GB',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'bm_lewis',
    name: 'Lewis',
    lang: 'en-GB',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'bf_alice',
    name: 'Alice',
    lang: 'en-GB',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'bf_lily',
    name: 'Lily',
    lang: 'en-GB',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'bm_daniel',
    name: 'Daniel',
    lang: 'en-GB',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'bm_fable',
    name: 'Fable',
    lang: 'en-GB',
    gender: 'male',
    supportsTimings: false,
  },
];

/** The 8 Mandarin voices. */
export const CHINESE_VOICES: readonly Voice[] = [
  {
    id: 'zf_xiaobei',
    name: 'Xiaobei',
    lang: 'zh-CN',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'zf_xiaoni',
    name: 'Xiaoni',
    lang: 'zh-CN',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'zf_xiaoxiao',
    name: 'Xiaoxiao',
    lang: 'zh-CN',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'zf_xiaoyi',
    name: 'Xiaoyi',
    lang: 'zh-CN',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'zm_yunjian',
    name: 'Yunjian',
    lang: 'zh-CN',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'zm_yunxi',
    name: 'Yunxi',
    lang: 'zh-CN',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'zm_yunxia',
    name: 'Yunxia',
    lang: 'zh-CN',
    gender: 'male',
    supportsTimings: false,
  },
  {
    id: 'zm_yunyang',
    name: 'Yunyang',
    lang: 'zh-CN',
    gender: 'male',
    supportsTimings: false,
  },
];

/**
 * Every voice this provider can synthesize.
 *
 * All of them report `supportsTimings: false`: Kokoro returns audio and
 * nothing else, and SayLoud's rule is to highlight the whole sentence rather
 * than estimate where a word landed.
 */
/** The 5 Japanese voices: 4 female, 1 male. */
export const JAPANESE_VOICES: readonly Voice[] = [
  {
    id: 'jf_alpha',
    name: 'Alpha',
    lang: 'ja',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'jf_gongitsune',
    name: 'Gongitsune',
    lang: 'ja',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'jf_nezumi',
    name: 'Nezumi',
    lang: 'ja',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'jf_tebukuro',
    name: 'Tebukuro',
    lang: 'ja',
    gender: 'female',
    supportsTimings: false,
  },
  {
    id: 'jm_kumo',
    name: 'Kumo',
    lang: 'ja',
    gender: 'male',
    supportsTimings: false,
  },
];

export const KOKORO_VOICES: readonly Voice[] = [
  ...ENGLISH_VOICES,
  ...CHINESE_VOICES,
  ...JAPANESE_VOICES,
];
