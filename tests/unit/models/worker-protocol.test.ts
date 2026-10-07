/**
 * The kokoro worker's channel, from the side that has to trust it.
 *
 * `synthesize` carries pieces of prepared text rather than the sentence itself,
 * plus a `count`, so the guard is what keeps a stale worker from being handed a
 * message it would read as something else. A worker from a previous version
 * would see `synthesize` with no `text` and synthesize `undefined`.
 */
import { describe, expect, it } from 'vitest';
import { isWorkerReply, isWorkerRequest } from '~/lib/models/worker-protocol';

const SOURCE = { host: 'modelscope' } as const;

describe('isWorkerRequest', () => {
  it('accepts every request the engine sends', () => {
    expect(isWorkerRequest({ type: 'init', id: 1, source: SOURCE, allowFallback: false })).toBe(
      true
    );
    expect(
      isWorkerRequest({
        type: 'load',
        id: 2,
        modelId: 'kokoro-82m',
        tierId: 'fp16',
        device: 'wasm',
      })
    ).toBe(true);
    expect(isWorkerRequest({ type: 'count', id: 3, phonemes: 'həlˈoʊ' })).toBe(true);
    expect(
      isWorkerRequest({
        type: 'synthesize',
        id: 4,
        pieces: [{ ipa: 'həlˈoʊ' }],
        voiceId: 'af_heart',
        lang: 'en-US',
      })
    ).toBe(true);
    expect(isWorkerRequest({ type: 'cancel', id: 5 })).toBe(true);
    expect(isWorkerRequest({ type: 'dispose' })).toBe(true);
  });

  it('refuses a synthesize that still carries the raw sentence', () => {
    // The message a previous version of the engine sent. Accepting it would
    // mean synthesizing `undefined`.
    expect(
      isWorkerRequest({
        type: 'synthesize',
        id: 1,
        text: 'hello',
        voiceId: 'af_heart',
        lang: 'en-US',
      })
    ).toBe(false);
  });

  it('refuses pieces that are not pieces', () => {
    const base = { type: 'synthesize', id: 1, voiceId: 'af_heart', lang: 'en-US' };
    expect(isWorkerRequest({ ...base, pieces: [] })).toBe(false);
    expect(isWorkerRequest({ ...base, pieces: 'həlˈoʊ' })).toBe(false);
    // No `ipa` at all — the shape a previous version sent, when a piece carried
    // the raw text as well. It is refused for the same reason: `render` reads
    // `piece.ipa` and would tokenize `undefined`.
    expect(isWorkerRequest({ ...base, pieces: [{ text: 'hello' }] })).toBe(false);
    expect(isWorkerRequest({ ...base, pieces: [{ ipa: 7 }] })).toBe(false);
    expect(isWorkerRequest({ ...base, pieces: [{ ipa: undefined }] })).toBe(false);
    expect(isWorkerRequest({ ...base, pieces: [null] })).toBe(false);
    // And a piece that carries *only* the IPA is the shape that works.
    expect(isWorkerRequest({ ...base, pieces: [{ ipa: 'a' }] })).toBe(true);
    // Extra fields are not rejected — `isSynthesizePiece` is a type guard, not a
    // schema — so the one that used to travel is accepted as long as the IPA is
    // there. Asserted so the comment above is not mistaken for a validator.
    expect(isWorkerRequest({ ...base, pieces: [{ text: 'a', ipa: 'a' }] })).toBe(true);
  });

  it('refuses a count with nothing to count', () => {
    expect(isWorkerRequest({ type: 'count', id: 1 })).toBe(false);
    expect(isWorkerRequest({ type: 'count', id: 1, phonemes: 7 })).toBe(false);
  });
});

describe('isWorkerReply', () => {
  it('accepts every reply the worker sends', () => {
    expect(isWorkerReply({ type: 'ready', id: 1 })).toBe(true);
    expect(
      isWorkerReply({ type: 'loaded', id: 1, info: { device: 'wasm', sessionInitMs: 1 } })
    ).toBe(true);
    expect(isWorkerReply({ type: 'counted', id: 1, tokens: 0 })).toBe(true);
    expect(
      isWorkerReply({ type: 'pcm', id: 1, pcm: new Float32Array(2), sampleRate: 24_000 })
    ).toBe(true);
    expect(isWorkerReply({ type: 'error', id: 1, code: 'unknown', message: 'boom' })).toBe(true);
  });

  it('refuses a count that is not a number of tokens', () => {
    expect(isWorkerReply({ type: 'counted', id: 1 })).toBe(false);
    expect(isWorkerReply({ type: 'counted', id: 1, tokens: -1 })).toBe(false);
    expect(isWorkerReply({ type: 'counted', id: 1, tokens: '3' })).toBe(false);
  });

  it('refuses a type this build does not have', () => {
    expect(isWorkerReply({ type: 'phonemized', id: 1, phonemes: 'a' })).toBe(false);
    expect(isWorkerReply({ type: 'ready' })).toBe(false);
  });
});
