import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import type { test } from './tests/e2e/fixtures';

const PORT = Number(process.env.SAYLOUD_E2E_PORT ?? 8787);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig<Parameters<typeof test.use>[0]>({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
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
      name: 'build-e2e',
      testMatch: '**/e2e-build.setup.ts',
    },
    {
      name: 'build-production',
      testMatch: '**/production-build.setup.ts',
    },
    {
      name: 'chromium',
      dependencies: ['build-e2e'],
      testMatch: '**/*.spec.ts',
      testIgnore: '**/production-sidepanel.spec.ts',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
    {
      name: 'production',
      dependencies: ['build-production'],
      testMatch: '**/production-sidepanel.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        extensionPath: path.resolve(process.cwd(), '.output/chrome-mv3'),
      },
    },
  ],
});
