import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

/**
 * The phonemization benchmark, in a config of its own.
 *
 * It reads the real wasm, the real IPADic dictionary and the real Chinese word
 * list, and it measures wall-clock time — so it is not something a test run
 * should do on the way past. `pnpm test` collects `tests/unit/**` only and never
 * sees this; CI does not run it either, because a shared runner's timing is not
 * the machine anyone listens on.
 *
 * Run it with `pnpm test:performance`. The numbers it prints belong in the phase
 * record when they move.
 *
 * Plugins are the same as `vitest.config.ts` for the same reason: `~/…` is a WXT
 * alias, and the module under test reaches for browser globals through the
 * environment WXT sets up.
 */
export default defineConfig({
  plugins: [await WxtVitest(), preact()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/performance/**/*.test.ts'],
    // The default reporter swallows `console.log` from a passing test, and the
    // numbers *are* this suite's output — a benchmark that prints nothing is a
    // pass/fail bit where a measurement belongs. `verbose` prints stdout next
    // to the test that produced it.
    reporters: ['verbose'],
  },
});
