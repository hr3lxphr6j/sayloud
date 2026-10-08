import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';

test('build the production extension', () => {
  test.setTimeout(120_000);
  execFileSync('pnpm', ['build'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    stdio: 'inherit',
  });
});
