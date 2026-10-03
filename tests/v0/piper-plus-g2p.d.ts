/**
 * Minimal ambient types for `@piper-plus/g2p`, for the V0 harness only.
 *
 * The package *does* ship `types/index.d.ts` (30 KB, accurate) and sets a
 * top-level `"types"` field — but its `exports` map lists only `.` → `./src/index.js`
 * with no `types` condition:
 *
 *   "exports": { ".": "./src/index.js", ... }
 *
 * With `moduleResolution: "Bundler"`, `exports` wins and the top-level `types`
 * field is never consulted, so TypeScript reports TS7016 and the import becomes
 * implicitly `any`. That is a defect in the package, not in this repo; the
 * proper fix is upstream.
 *
 * Rather than patch `tsconfig.json` (which belongs to the project, not to a
 * throwaway verification harness) or sprinkle `@ts-expect-error` over the
 * calls, this declares just the surface V0 actually touches. It is deliberately
 * narrow: if the harness ever needs more of the API, add it here rather than
 * widening to `any`, because the whole point of V0 is to find out what the API
 * really does.
 */
declare module '@piper-plus/g2p' {
  /** A1/A2/A3 accent features; only Japanese produces these. */
  export interface ProsodyInfo {
    a1: number;
    a2: number;
    a3: number;
  }

  /** What `phonemize()` returns. Tokens are IPA strings. */
  export interface PhonemizeResult {
    tokens: string[];
    prosody: (ProsodyInfo | null)[];
    language?: string;
  }

  /** English front end: pure JS, synchronous, rule-based. */
  export class EnglishG2P {
    phonemize(text: string): PhonemizeResult;
  }

  /**
   * Chinese front end.
   *
   * `mode` is `'wasm'` when a WASM phonemizer was injected and `'fallback'`
   * otherwise — and `'fallback'` is character-level passthrough, which is the
   * finding V0 documents.
   */
  export class ChineseG2P {
    readonly mode: 'wasm' | 'fallback';
    readonly lastError: string | null;
    phonemize(text: string): PhonemizeResult;
  }

  /** Unified multilingual entry point. */
  export class G2P {
    static create(options?: {
      languages?: string[];
      openjtalkModule?: unknown;
      jaDict?: unknown;
      customDicts?: unknown[];
    }): Promise<G2P>;
    phonemize(text: string, options?: { language?: string }): PhonemizeResult;
    detectLanguage(text: string): string;
    dispose(): void;
  }
}
