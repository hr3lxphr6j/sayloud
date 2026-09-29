import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  vite: () => ({ plugins: [preact()] }),
  manifest: ({ mode }) => ({
    name: 'SayLoud',
    version: '0.1.0',
    permissions: ['activeTab', 'scripting', 'storage', 'tts'],
    action: {},
    ...(mode === 'e2e' && { host_permissions: ['http://127.0.0.1/*'] }),
  }),
  outDir: process.env.SAYLOUD_E2E ? '.output-e2e' : '.output',
  // WXT's default template appends the mode, which would put the e2e build in
  // `.output-e2e/chrome-mv3-e2e`. The e2e build already has its own outDir, so
  // drop the suffix and give the Playwright fixtures a stable path.
  ...(process.env.SAYLOUD_E2E && { outDirTemplate: '{{browser}}-mv{{manifestVersion}}' }),
});
