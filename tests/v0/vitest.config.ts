/**
 * A separate Vitest project for the P6 V0 verification (`tests/v0/`).
 *
 * The main config only collects `tests/unit/**`, and V0 is not a unit test: it
 * is a one-off comparison harness whose *output* is JSON, not assertions. It
 * needs the same `~/` alias and happy-dom globals as the real suite, because
 * it drives the real `lib/models/phonemize/` chain rather than a stand-in.
 */
import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [await WxtVitest(), preact()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/v0/**/*.test.ts'],
    // kuroshiro + kuromoji load a 17 MB dictionary, jieba a 3.8 MB wasm, and
    // espeak a 1.3 MB one. All are one-time costs, but the default 5 s is not
    // enough for the first sample of each language.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
