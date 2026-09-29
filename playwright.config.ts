import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.SAYLOUD_E2E_PORT ?? 8787);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  // The e2e bundle carries a test hook and host access to 127.0.0.1, so it has
  // to be rebuilt before every run rather than reused.
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
  },
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
});
