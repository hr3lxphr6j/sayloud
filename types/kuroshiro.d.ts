/**
 * Types for `kuroshiro`, which ships none of its own (`@types/kuroshiro` does
 * not exist).
 *
 * Only the surface `lib/models/phonemize/japanese.ts` uses is declared. A full
 * transcription of the upstream API would be guesswork nobody exercises, and a
 * wrong signature is worse than a missing one — it type-checks code that fails
 * at runtime.
 *
 * The vendored analyzer is *not* declared here: it lives at a real path inside
 * the project, so TypeScript finds `lib/vendor/kuroshiro-analyzer-kuromoji/index.d.ts`
 * beside it.
 */
declare module 'kuroshiro' {
  /**
   * `mode` and `romajiSystem` are listed for completeness but unused: the
   * phonemizer asks for katakana in `normal` mode and derives IPA itself, so
   * the okurigana/furigana modes and romaji systems never come up.
   */
  export interface ConvertOptions {
    to: 'hiragana' | 'katakana' | 'romaji';
    mode?: 'normal' | 'spaced' | 'okurigana' | 'furigana';
    romajiSystem?: 'nippon' | 'passport' | 'hepburn';
    delimiter_start?: string;
    delimiter_end?: string;
  }

  /**
   * What `init` accepts: kuroshiro checks for exactly these two methods before
   * taking an analyzer, and `lib/vendor/kuroshiro-analyzer-kuromoji` is the
   * only implementation this project passes.
   */
  export interface Analyzer {
    init(): Promise<void>;
    parse(text: string): Promise<unknown[]>;
  }

  export default class Kuroshiro {
    /** Rejects on an analyzer that is malformed or cannot load its dictionary. */
    init(analyzer: Analyzer): Promise<void>;
    convert(text: string, options: ConvertOptions): Promise<string>;
  }
}
