import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [await WxtVitest(), preact()],
  test: {
    environment: 'happy-dom',
    globals: true,
  },
});
