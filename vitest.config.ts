import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [await WxtVitest(), preact()],
  test: {
    environment: 'happy-dom',
    globals: true,
    // `tests/e2e` holds Playwright specs, which need a browser and the e2e
    // server. Vitest would otherwise collect them and fail on both.
    include: ['tests/unit/**/*.test.{ts,tsx}'],
  },
});
