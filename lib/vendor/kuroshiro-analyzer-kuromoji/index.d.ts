/**
 * Types for the vendored Kuromoji analyzer.
 *
 * Declared beside the code rather than in `types/` because this is a real path
 * inside the project: TypeScript resolves `…/kuroshiro-analyzer-kuromoji/index.js`
 * to this file on its own, whereas a `declare module` would have to repeat the
 * `~/` alias and could silently stop matching.
 *
 * The analyzer is vendored (see `docs/phonemization-architecture.md`) only to
 * point its import at the ESM copy of kuromoji; its own surface is upstream's
 * and unchanged.
 */
export default class KuromojiAnalyzer {
  /**
   * `dictPath` is a path within the extension, not a URL. Turning it into one
   * is `BrowserDictionaryLoader`'s job, and it does so differently depending on
   * whether it is running in the worker or in a document.
   */
  constructor(options?: { dictPath?: string });

  /** Fetches and decompresses the dictionary. This is the only slow step. */
  init(): Promise<void>;

  /** Tokenizes with part-of-speech and reading attached to each token. */
  parse(text: string): Promise<unknown[]>;
}
