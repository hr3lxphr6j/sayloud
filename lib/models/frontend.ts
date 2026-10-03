/**
 * Which phoneme inventory a voice needs (P6 spec §1.3, §2.2).
 *
 * A frontend is not a language. v1.0 and v1.1-zh are two models with two
 * *inventories* — IPA with arrow tones against zhuyin with digit tones — and
 * the same Chinese text phonemizes to different characters for each. So the
 * frontend follows the **voice**, exactly as the language does, and both are
 * known before the first sentence (`lib/providers/local.ts`).
 *
 * It lives in a module of its own rather than beside the phonemizer that uses
 * it because `lib/models/registry.ts` has to name one per model, and the
 * registry is imported by the side panel — which must never reach the
 * phonemizer's wasm. A type-only import would be erased today and a value
 * import would not, and nothing about that distinction is visible at the import
 * site; a module with no imports of its own is what makes it structural.
 */

/** The phoneme inventories this build can produce. */
export type FrontendId = 'kokoro-v1' | 'kokoro-v11-zh';

/** Every frontend, so a validator does not have to list them twice. */
export const FRONTEND_IDS: readonly FrontendId[] = ['kokoro-v1', 'kokoro-v11-zh'];

/** True for a string that names a frontend this build knows. */
export function isFrontendId(value: unknown): value is FrontendId {
  return typeof value === 'string' && (FRONTEND_IDS as readonly string[]).includes(value);
}
