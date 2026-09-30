/**
 * The on-device provider, end to end in a real browser.
 *
 * Two things are substituted, and both of them have to be for this to run at
 * all on CI:
 *
 * - **The model files.** They are 92–325 MB and CI has no network, so the
 *   tiers are either seeded straight into Cache Storage (which is what the
 *   downloader would write) or served by a Playwright route that stands in for
 *   the mirror. Everything downstream of `cache.put` is the real code.
 * - **The engine.** The e2e build wires `FakeLocalEngine` where production
 *   wires `WorkerLocalEngine` (see `entrypoints/offscreen/main.ts`), so the
 *   whole chain is real — provider adapter → WAV → offscreen document →
 *   TimelinePlayer → `<audio>` → sentence highlight — except that the audio is
 *   silence whose length follows the text.
 *
 * What is deliberately *not* asserted here: that a replay came from the audio
 * cache rather than from a second synthesis. The cloud spec can count requests
 * to its stub server; the on-device path makes no request at all, and the fake
 * engine is in another context with no record the test can read — and removing
 * the model files to force the question would only send the mismatch down the
 * browser-voice fallback, which looks exactly like success. What is asserted is
 * the part that can be wrong: that the offscreen document synthesized, that the
 * clips landed in its cache, and that replaying one writes nothing new.
 */
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { control, expect, test } from './fixtures';
import { sentenceHighlight, wordHighlight } from './helpers';

/** Must match `lib/models/urls.ts`, which e2e specs cannot import. */
const CANONICAL_HOST = 'https://model-cache.sayloud.invalid/';
const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** The files each tier needs, from `KOKORO_82M.tiers` in the registry. */
const TIER_FILES: Record<string, string[]> = {
  q8: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'],
  fp16: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_fp16.onnx'],
  fp32: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'],
};

function tierKeys(tier: string): string[] {
  const files = TIER_FILES[tier];
  if (!files) throw new Error(`no such tier: ${tier}`);
  return files.map((file) => `${CANONICAL_HOST}${REPO}/resolve/main/${file}`);
}

/** Open the panel, the way clicking the toolbar icon would. */
async function openPanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return page;
}

/**
 * Configure the on-device provider, as the settings panel and the voice picker
 * would have.
 *
 * Written from the service worker because the storage keys are shared: the
 * panel reads them on mount, and the router reads them again whenever they
 * change.
 */
async function useLocal(serviceWorker: Worker, tier: string): Promise<void> {
  await serviceWorker.evaluate(async (modelTier) => {
    const chrome = (
      globalThis as unknown as {
        chrome: { storage: { local: { set(items: object): Promise<void> } } };
      }
    ).chrome;

    const config = { provider: 'local', modelId: 'kokoro-82m', tier: modelTier };
    await chrome.storage.local.set({
      'sayloud:provider-config': config,
      'sayloud:provider-configs': { local: config },
      // A voice is what makes the router pick this provider at all; without one
      // it reads with the browser voice and says so in the console.
      'sayloud:selected-voices': { local: 'af_heart' },
      // A remembered source, so the download does not start with the `auto`
      // probe against two hosts the test would otherwise have to intercept.
      'sayloud:model-host-last-good': 'huggingface',
    });
  }, tier);
  // `storage.onChanged` → `speakers.refresh()` is asynchronous.
  await serviceWorker.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
}

/** Put the tier's files in Cache Storage, as a finished download would. */
async function seedTier(page: Page, tier: string): Promise<void> {
  await page.evaluate(async (keys) => {
    const cache = await caches.open('transformers-cache');
    for (const key of keys) await cache.put(key, new Response('seeded'));
  }, tierKeys(tier));
}

/** The row for a tier, which carries its own state. */
function tierRow(page: Page, tier: string) {
  return page.locator(`[data-tier="kokoro-82m:${tier}"]`);
}

test('tells the reader the model is missing, and takes them to the Models tab', async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  await useLocal(serviceWorker, 'q8');
  const panel = await openPanel(context, extensionId);

  // The panel asks the provider, not a copy of its logic: this is the same
  // check the engine runs before it synthesizes.
  await expect(panel.getByText('Model not downloaded yet')).toBeVisible();
  await panel.getByRole('button', { name: 'Go to model settings ›' }).click();

  await expect(panel.locator('#tab-models')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('#panel-models')).toBeVisible();
  await expect(tierRow(panel, 'q8')).toHaveAttribute('data-state', 'absent');
});

test('renders every tier, and downloads the one the source serves', async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  await useLocal(serviceWorker, 'q8');
  await context.route('https://huggingface.co/**', (route) =>
    route.fulfill({ status: 200, body: 'model-bytes', contentType: 'application/octet-stream' })
  );

  const panel = await openPanel(context, extensionId);
  await panel.locator('#tab-models').click();

  // Not downloaded: a size and a Download button, one per tier.
  await expect(panel.locator('[data-tier]')).toHaveCount(3);
  await expect(tierRow(panel, 'q8')).toHaveAttribute('data-state', 'absent');
  await expect(panel.getByRole('button', { name: 'Download' })).toHaveCount(3);
  await expect(tierRow(panel, 'q8')).toContainText('92.4 MB');

  // Downloading: a progress bar and a way out, and only for that row.
  await tierRow(panel, 'q8').getByRole('button', { name: 'Download' }).click();
  await expect(tierRow(panel, 'fp16')).toHaveAttribute('data-state', 'absent');

  // Downloaded: the tier in use is badged, and can be deleted.
  await expect(tierRow(panel, 'q8')).toHaveAttribute('data-state', 'downloaded', {
    timeout: 15_000,
  });
  await expect(tierRow(panel, 'q8')).toContainText('In use');
  await expect(tierRow(panel, 'q8')).toContainText('Delete');
  await expect(panel.getByRole('button', { name: 'Download' })).toHaveCount(2);

  // And the bytes are in the cache under the canonical keys, which is what the
  // engine will look up when it loads the model.
  const stored = await panel.evaluate(async (keys) => {
    const cache = await caches.open('transformers-cache');
    return Promise.all(keys.map(async (key) => (await cache.match(key)) !== undefined));
  }, tierKeys('q8'));
  expect(stored).toEqual([true, true, true, true]);
});

test('cancels a download, then deletes one and falls back to the first tier', async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  // The tier in use is fp16, so deleting it has to move the choice rather than
  // leave a config pointing at a file that is gone.
  await useLocal(serviceWorker, 'fp16');

  let delayMs = 0;
  await context.route('https://huggingface.co/**', async (route) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      status: 200,
      body: 'model-bytes',
      contentType: 'application/octet-stream',
    });
  });

  const panel = await openPanel(context, extensionId);
  await panel.locator('#tab-models').click();
  await expect(panel.locator('[data-tier]')).toHaveCount(3);

  // Cancelling puts the row back where it started, and says why.
  delayMs = 3_000;
  await tierRow(panel, 'q8').getByRole('button', { name: 'Download' }).click();
  await expect(tierRow(panel, 'q8')).toHaveAttribute('data-state', 'downloading');
  await tierRow(panel, 'q8').getByRole('button', { name: 'Cancel' }).click();
  await expect(tierRow(panel, 'q8')).toHaveAttribute('data-state', 'absent');
  await expect(tierRow(panel, 'q8')).toContainText('Download cancelled.');

  // A real download, from the same routed source.
  delayMs = 0;
  await tierRow(panel, 'fp16').getByRole('button', { name: 'Download' }).click();
  await expect(tierRow(panel, 'fp16')).toHaveAttribute('data-state', 'downloaded', {
    timeout: 15_000,
  });
  await expect(tierRow(panel, 'fp16')).toContainText('In use');

  // Deleting the tier in use warns first.
  await tierRow(panel, 'fp16').getByRole('button', { name: 'Delete' }).click();
  await expect(
    panel.getByText("After deleting, you'll need to download again to read aloud.")
  ).toBeVisible();
  await tierRow(panel, 'fp16').getByRole('button', { name: 'Delete anyway' }).click();

  await expect(tierRow(panel, 'fp16')).toHaveAttribute('data-state', 'absent');
  await expect(tierRow(panel, 'q8')).toContainText('Download');

  const saved = await serviceWorker.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } };
      }
    ).chrome;
    return chrome.storage.local.get('sayloud:provider-configs');
  });
  const configs = saved['sayloud:provider-configs'] as { local?: { tier?: string } };
  expect(configs.local?.tier).toBe('q8');
});

test('synthesizes on device, highlights whole sentences, and caches the audio', async ({
  context,
  serviceWorker,
  extensionId,
  page,
  activate,
}) => {
  await useLocal(serviceWorker, 'q8');
  const panel = await openPanel(context, extensionId);
  await seedTier(panel, 'q8');

  await page.goto('/article.html');
  await activate();

  // The fake engine speaks, so a sentence highlight appears without any word
  // highlight: Kokoro returns no timestamps and SayLoud does not estimate.
  await expect.poll(() => sentenceHighlight(page), { timeout: 15_000 }).toContain('first sentence');
  await expect(control(page, 'Pause')).toBeVisible();
  expect(await wordHighlight(page)).toBe('');

  // It advances by itself when the audio ends.
  await expect
    .poll(() => sentenceHighlight(page), { timeout: 20_000 })
    .toContain('second sentence');

  // The audio really was produced through the offscreen document: its L2 cache
  // is the only thing that writes there, and nothing else in this run could
  // have put a clip in it.
  await panel.locator('#tab-settings').click();
  const usedLine = panel.getByText(/^Used [\d.]+ [KM]?B · \d+ clips$/);
  await expect(usedLine).toBeVisible({ timeout: 15_000 });
  const afterFirstPlay = await usedLine.textContent();
  expect(afterFirstPlay).not.toContain('0 clips');

  // Replaying a sentence that was already synthesized writes nothing new: the
  // prefetcher may have warmed more than one, but the set never grows for
  // audio that is already there.
  await panel.locator('#tab-reading').click();
  await control(page, 'Previous sentence').click();
  await expect.poll(() => sentenceHighlight(page), { timeout: 15_000 }).toContain('first sentence');
  await panel.locator('#tab-settings').click();
  await expect(usedLine).toBeVisible();
  expect(await usedLine.textContent()).toBe(afterFirstPlay);
});

test('the panel loads with no page errors on the Models tab', async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  await useLocal(serviceWorker, 'q8');
  const panel = await openPanel(context, extensionId);
  const errors: string[] = [];
  panel.on('pageerror', (error) => errors.push(error.message));

  await panel.locator('#tab-models').click();
  await expect(panel.locator('#panel-models')).toBeVisible();
  await expect(panel.getByLabel('Download source')).toBeVisible();
  await expect(panel.getByLabel('Mirror URL')).toHaveCount(0);

  await panel.getByLabel('Download source').selectOption('custom');
  await expect(panel.getByLabel('Mirror URL')).toBeVisible();
  // Nothing usable is stored, so the panel says so instead of pretending.
  await expect(panel.getByText('Enter a complete https:// URL.')).toBeVisible();

  await panel.getByLabel('Mirror URL').fill('https://mirror.test/models');
  await panel.getByLabel('Mirror URL').blur();
  await expect(panel.getByText('Source saved.')).toBeVisible();

  expect(errors).toEqual([]);
});
