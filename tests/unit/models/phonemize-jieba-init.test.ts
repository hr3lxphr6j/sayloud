/**
 * The uninitialised-jieba guard, on its own.
 *
 * It needs a module registry in which `chinese.ts` has never been imported, and
 * that is the whole reason this is a separate file rather than a test beside the
 * others. `vi.resetModules()` would also produce one, but it would hand the rest
 * of that file a *second* `ChinesePhonemizer` class — every `toBeInstanceOf`
 * below it would then fail against an object of the "same" class. A fresh file
 * gets a fresh registry for free, and no ordering to depend on.
 *
 * The failure this guards is worse than an error. `jieba-wasm`'s web build
 * closes over a module-level `wasm` binding, so calling `cut` before its `init`
 * has resolved throws something unrelated from deep inside the package. Naming
 * the actual mistake is the difference between a five-second fix and an
 * afternoon — and it is not hypothetical: the Node build self-initialises, so
 * every Node test passed while the browser path would have thrown.
 */
import { describe, expect, it } from 'vitest';
import { jiebaBoundaries } from '~/lib/models/phonemize/chinese';

describe('jieba before initialisation', () => {
  it('names the missing step instead of failing inside the wasm', () => {
    expect(() => jiebaBoundaries('你好')).toThrow(/await ensureJieba/);
  });
});
