/**
 * The two decisions the PDF viewer makes about a document that is still growing.
 *
 * Both are pure so they can be tested without mounting the page. The viewer
 * calls them; it does not re-implement them.
 */
import type { Block } from '~/lib/extractor';
import { pageBlock } from '~/lib/pdf/text-blocks';
import type { PdfTextItem } from '~/lib/pdf/types';
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

/** One page's text layer, as the viewer holds it. */
export interface PageLayer {
  container: HTMLElement;
  layer: HTMLElement | null;
  /** Null for a page that has not been read yet, or has no readable text. */
  block: Block | null;
}

/**
 * Rebuild every page's text layer at a new scale.
 *
 * A zoom throws the old text nodes away, and the blocks the reader already
 * holds point at them. Rebuilding only the visible pages would leave the rest
 * highlighting ranges that are no longer in the document, which also means the
 * page never scrolls to them and so never gets rebuilt. Every page is rebuilt
 * here; the canvas is left to the caller, since only pages near the viewport
 * need one.
 *
 * `buildLayer` is the viewer's own text-layer renderer. A page it cannot match
 * to a block keeps its old one: a mismatch is a broken layer, and the previous
 * block is still a readable document.
 */
export async function rescaleTextLayers(
  pages: readonly PageLayer[],
  scale: number,
  buildLayer: (
    scale: number,
    container: HTMLElement
  ) => Promise<{ layer: HTMLElement; items: PdfTextItem[] }>
): Promise<void> {
  for (const page of pages) {
    page.container.replaceChildren();
    page.layer = null;

    const built = await buildLayer(scale, page.container);
    const block = pageBlock(built.items, built.layer);
    if (!block) continue;

    page.layer = built.layer;
    page.block = block;
  }
}
