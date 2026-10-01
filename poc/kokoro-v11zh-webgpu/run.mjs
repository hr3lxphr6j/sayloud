/**
 * Drives the POC page in Chromium and prints the matrix as JSON (throwaway).
 *
 *   node poc/kokoro-v11zh-webgpu/run.mjs
 *
 * Assumes `server.mjs` is already listening. WebGPU needs a secure context, so
 * the page must be loaded over http://127.0.0.1 — an about:blank page reports
 * `navigator.gpu === undefined` and would look like a WebGPU failure.
 */
import { chromium } from '@playwright/test';

const PORT = Number(process.env.POC_PORT ?? 8913);
const url = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'],
});
const page = await browser.newPage();
/** ONNX Runtime's C++ layer writes thousands of constant-fold warnings to
 * stderr for the fp16 graph; they would bury the results. */
const NOISE = ['constant_folding', 'VerifyEachNodeIsAssignedToAnEp', 'onnxruntime:'];
page.on('console', (m) => {
  const text = m.text();
  if (NOISE.some((n) => text.includes(n))) return;
  if (text.startsWith('{') || text.includes('webgpu adapter')) return;
  console.log('  [page]', text);
});
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

console.log(`opening ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });

try {
  await page.waitForFunction(() => window.__done === true, null, { timeout: 15 * 60 * 1000 });
} catch {
  console.log('TIMEOUT waiting for __done; page text:');
  console.log(await page.locator('#log').innerText());
  await browser.close();
  process.exit(1);
}

const result = await page.evaluate(() => window.__result);
console.log('\n===== RESULT JSON =====');
console.log(JSON.stringify(result, null, 2));
await browser.close();
