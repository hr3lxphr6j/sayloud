/**
 * The two decisions that keep a growing PDF readable.
 *
 * Sending `load` while the engine is speaking stops the audio: the engine's
 * first act on `load` is to stop the speaker, and `resume` only means "don't
 * start again". So an appended page is held back until the engine is quiet,
 * and sent then with `resume` so the longer list arrives without speaking.
 *
 * A zoom throws every text layer away. The blocks the reader already holds
 * point at those nodes, so every page — not just the visible ones — has to be
 * rebuilt, or a sentence past the fold highlights a range that is no longer
 * in the document and the page never scrolls to it.
 */
import { describe, expect, it } from 'vitest';
import { appendSync, rescaleTextLayers } from '~/entrypoints/pdf-viewer/sync';
import type { Block } from '~/lib/extractor';
import { pageBlock } from '~/lib/pdf/text-blocks';
import type { PdfTextItem } from '~/lib/pdf/types';
import { buildReadingDoc } from '~/lib/reading-doc';

describe('appending a page', () => {
  it('does not send a load while the engine is speaking or about to', () => {
    expect(appendSync('playing').send).toBe(false);
    expect(appendSync('loading').send).toBe(false);
  });

  it('sends the longer list with resume once the engine is paused', () => {
    expect(appendSync('paused')).toEqual({ send: true, resume: true });
  });
});

describe('zooming', () => {
  /** A text layer of one item, the smallest thing `pageBlock` will accept. */
  function layerFor(text: string, fontSize: number): { layer: HTMLElement; items: PdfTextItem[] } {
    const layer = document.createElement('div');
    const span = document.createElement('span');
    span.style.fontSize = `${fontSize}px`;
    span.appendChild(document.createTextNode(text));
    layer.appendChild(span);
    return { layer, items: [{ str: text, hasEOL: false, nodeIndex: 0 }] };
  }

  it('skips unopened pages and does not throw', async () => {
    document.body.innerHTML = '';

    const visible = document.createElement('div');
    const unopened = document.createElement('div');
    document.body.append(visible, unopened);

    const first = layerFor('On the page.', 12);
    visible.append(first.layer);

    const pages = [
      {
        container: visible,
        layer: first.layer,
        block: pageBlock(first.items, first.layer) as Block,
      },
      {
        container: unopened,
        layer: null,
        block: null,
      },
    ];

    let callCount = 0;
    await rescaleTextLayers(pages, 1.5, async (scale, container) => {
      callCount += 1;
      if (container === unopened) {
        // Unopened: no page proxy, no PDF text.
        return { layer: document.createElement('div'), items: [] };
      }
      const built = layerFor('On the page.', 12 * scale);
      container.appendChild(built.layer);
      return built;
    });

    expect(callCount).toBe(2);
    expect(pages[0]?.block).not.toBeNull();
    expect(pages[1]?.block).toBeNull();
    expect(pages[1]?.layer).toBeNull();
  });

  it('after rescale, syncDoc rebuilds current to point at new nodes', async () => {
    document.body.innerHTML = '';

    const visible = document.createElement('div');
    const offscreen = document.createElement('div');
    document.body.append(visible, offscreen);

    const first = layerFor('On the page.', 12);
    const second = layerFor('Past the fold.', 12);
    visible.append(first.layer);
    offscreen.append(second.layer);

    const pages = [
      {
        container: visible,
        layer: first.layer,
        block: pageBlock(first.items, first.layer) as Block,
      },
      {
        container: offscreen,
        layer: second.layer,
        block: pageBlock(second.items, second.layer) as Block,
      },
    ];

    const before = buildReadingDoc(pages.map((page) => page.block));
    const stale = before.rangeForSentence(1);
    expect(stale?.startContainer.isConnected).toBe(true);

    // Simulate rescaleTextLayers rebuilding blocks.
    await rescaleTextLayers(pages, 1.5, async (scale, container) => {
      const text = container === offscreen ? 'Past the fold.' : 'On the page.';
      const built = layerFor(text, 12 * scale);
      container.appendChild(built.layer);
      return built;
    });

    // Old nodes are gone, but blocks are fresh.
    expect(stale?.startContainer.isConnected).toBe(false);

    // When syncDoc rebuilds current from the fresh blocks,
    // rangeForSentence returns a range pointing at live new nodes.
    const after = buildReadingDoc(pages.map((page) => page.block));
    const fresh = after.rangeForSentence(1);
    expect(fresh).not.toBeNull();
    if (!fresh) throw new Error('fresh range should not be null');
    expect(fresh.startContainer.isConnected).toBe(true);
    expect(fresh.startContainer.textContent).toBe('Past the fold.');
  });

  it('rebuilds an offscreen page so its ranges point at nodes that are still connected', async () => {
    document.body.innerHTML = '';

    const visible = document.createElement('div');
    const offscreen = document.createElement('div');
    document.body.append(visible, offscreen);

    const first = layerFor('On the page.', 12);
    const second = layerFor('Past the fold.', 12);
    visible.append(first.layer);
    offscreen.append(second.layer);

    const pages = [
      {
        container: visible,
        layer: first.layer,
        block: pageBlock(first.items, first.layer) as Block,
      },
      {
        container: offscreen,
        layer: second.layer,
        block: pageBlock(second.items, second.layer) as Block,
      },
    ];

    const before = buildReadingDoc(pages.map((page) => page.block));
    const stale = before.rangeForSentence(1);
    expect(stale?.startContainer.isConnected).toBe(true);

    await rescaleTextLayers(pages, 1.5, async (scale, container) => {
      const text = container === offscreen ? 'Past the fold.' : 'On the page.';
      const built = layerFor(text, 12 * scale);
      container.append(built.layer);
      return built;
    });

    // The nodes the old block pointed at were removed, not left behind for the
    // reader to keep highlighting.
    expect(stale?.startContainer.isConnected).toBe(false);

    const after = buildReadingDoc(pages.map((page) => page.block));
    const fresh = after.rangeForSentence(1);
    expect(fresh?.startContainer.isConnected).toBe(true);
    expect(fresh?.startContainer.textContent).toBe('Past the fold.');
    expect(fresh?.startContainer.parentElement?.style.fontSize).toBe('18px');
  });
});
