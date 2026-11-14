/**
 * Appending to a PDF the engine is already reading.
 *
 * Sending `load` while the engine is speaking stops the audio: the engine's
 * first act on `load` is to stop the speaker, and `resume` only means "don't
 * start again". So an appended page is held back until the engine is quiet,
 * and sent then with `resume` so the longer list arrives without speaking.
 *
 * The viewer's other moving part — rebuilding the text layer on a zoom — is
 * no longer a pure helper: EmbedPDF's page layout drives the rebuild and
 * `lib/pdf/embed/blocks.ts` produces the new blocks.
 */
import { describe, expect, it } from 'vitest';
import { appendSync } from '~/entrypoints/pdf-viewer/sync';

describe('appending a page', () => {
  it('does not send a load while the engine is speaking or about to', () => {
    expect(appendSync('playing').send).toBe(false);
    expect(appendSync('loading').send).toBe(false);
  });

  it('sends the longer list with resume once the engine is paused', () => {
    expect(appendSync('paused')).toEqual({ send: true, resume: true });
  });

  it('sends with resume after the engine stopped on an error', () => {
    expect(appendSync('error')).toEqual({ send: true, resume: true });
  });
});
