import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';

/**
 * wasm-pack's generated JS resolves `phonemize_bg.wasm` with a URL relative to
 * itself and `fetch`es it. The unit environment has no server to answer that, so
 * the binary is read off disk and handed over directly — `init` takes bytes as
 * readily as a URL.
 */
const WASM = new Uint8Array(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../lib/models/phonemize-wasm/phonemize_bg.wasm'
    )
  )
);

describe('RustPhonemizer', () => {
  it('loads the wasm module', async () => {
    const phonemizer = new RustPhonemizer(WASM);
    await phonemizer.ready;
    expect(phonemizer).toBeDefined();
  });

  /**
   * `ready` resolving is not by itself proof that the wasm instance was
   * constructed — a wrapper that forgot `new WasmPhonemizer()` would pass the
   * test above. Reaching the phonemize seam proves the instance exists.
   *
   * The phase-1 stub returns no phonemes; this asserts the shape, not the
   * output, so it does not have to change when the real pipeline lands.
   */
  it('exposes a callable phonemize seam once ready', async () => {
    const phonemizer = new RustPhonemizer(WASM);
    await phonemizer.ready;

    const result = phonemizer.phonemize('你好', { frontend: 'kokoro-v1', lang: 'zh-CN' });

    expect(typeof result.phonemes).toBe('string');
  });
});
