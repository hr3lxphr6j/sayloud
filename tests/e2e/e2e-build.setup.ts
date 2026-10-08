import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';

test('build the E2E extension', () => {
  test.setTimeout(120_000);
  execFileSync('pnpm', ['build:e2e'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    stdio: 'inherit',
  });
});
