/**
 * A stand-in for `phonemizer`, which is `kokoro-js`'s espeak-ng binding.
 *
 * Phase 10 stopped rendering English from `KokoroTTS.generate()`, because that
 * method runs a *second* front end — espeak, then `kokoro-js`'s own number,
 * punctuation and character substitutions — over text the Rust phonemizer had
 * already phonemized. Every language now renders from IPA through
 * `generate_from_ids()`.
 *
 * Removing the call is not removing the bytes. `kokoro-js` imports `phonemize`
 * at module scope, so espeak-ng's wasm is in the graph from the moment the kokoro
 * worker exists, whether or not `generate()` is ever called — measured at 1.3 MB
 * of the shipped extension. The only way to drop it is for the *specifier* not to
 * resolve to the real package, which is what the alias in `wxt.config.ts` does
 * and what this file exists to be the target of. It is the mirror image of phase
 * 8's lesson: a bundler follows the import graph, so dead code still costs what
 * the import costs.
 *
 * **Nothing calls this.** A call would mean `KokoroEngine.render` had gone back
 * to `generate()`, and the failure should be loud rather than a silently
 * different pronunciation: the message names this file and the phase, because the
 * stack trace would otherwise end inside minified `kokoro-js`.
 *
 * Typed as returning `Promise<string[]>` rather than `never` so it stays a
 * structural stand-in for the real export; the throw is what makes it unusable
 * rather than the type.
 */
export function phonemize(): Promise<string[]> {
  throw new Error(
    'phonemize() is not available: this build renders English from IPA through ' +
      'generate_from_ids(), and the espeak-ng binding was aliased away in phase 10 ' +
      '(see lib/models/phonemizer-stub.ts and wxt.config.ts).'
  );
}
