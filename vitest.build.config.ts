import { defineConfig } from 'vitest/config';

/**
 * The build-output assertions, in a config of their own.
 *
 * They read `.output/chrome-mv3`, which only exists after `pnpm build`, so they
 * must not be collected by `pnpm test` — a suite that runs without a build
 * would either fail on a fresh clone or, worse, skip and stop testing anything.
 * `pnpm test:build` builds first and then runs this.
 *
 * No plugins and no DOM: the test reads files and counts bytes.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/build/**/*.test.ts'],
  },
});
