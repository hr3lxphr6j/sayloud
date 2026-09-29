import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Build the e2e bundle before the run.
 *
 * The e2e build differs from the shipped one: it carries the `sayloudActivate`
 * hook and host access to 127.0.0.1. Building here keeps `pnpm test:e2e` from
 * silently testing a stale bundle.
 */
export default function globalSetup(): void {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  execFileSync('pnpm', ['build:e2e'], { cwd: root, stdio: 'inherit' });
}
