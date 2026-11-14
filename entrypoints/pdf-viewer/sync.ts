/**
 * The one decision the PDF viewer makes about a document that is still growing.
 *
 * Pure so it can be tested without mounting the page. The viewer calls it; it
 * does not re-implement it.
 */
import type { EnginePhase } from '~/lib/protocol';

/**
 * What to do with an appended page, given the phase the engine last reported.
 *
 * A `load` stops the speaker before it looks at `resume`, so sending one while
 * the engine is `playing` — or `loading`, which is playing that has not started
 * yet — cuts the audio off. The longer sentence list stays in the local
 * document and is sent on the next sync that finds the engine quiet, with
 * `resume` so it replaces the list without starting to speak.
 */
export function appendSync(
  phase: EnginePhase | undefined
): { send: false } | { send: true; resume: true } {
  if (phase === 'playing' || phase === 'loading') return { send: false };
  return { send: true, resume: true };
}
