/**
 * A separate Vitest project for the P6 V1 verification (`tests/v1/`).
 *
 * Same reasoning as `tests/v0/vitest.config.ts`: the main config only collects
 * `tests/unit/**`, and V1 is a measurement harness whose output is JSON, not
 * assertions. It needs the real `~/` alias and happy-dom globals because it
 * drives the shipping `lib/models/phonemize/` chain as the reference side of
 * the comparison.
 *
 * `piper-plus` resolves through the `tests/v1/node_modules` symlink that
 * `tests/v1/setup.sh` creates, so the harness imports the documented entry
 * point (`piper-plus/wasm/multilingual`) rather than a hard-coded file path.
 */
import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [await WxtVitest(), preact()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/v1/**/*.test.ts'],
    // The reference chain loads a 17 MB kuromoji dictionary, a 3.8 MB jieba
    // wasm and a 1.3 MB espeak wasm; the candidate instantiates a 57 MB wasm.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
