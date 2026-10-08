import type { Page, Worker } from '@playwright/test';
import { BASE_URL, expect, test } from './fixtures';

const CONFIGS = 'sayloud:provider-configs';
const provider = (page: Page, id: string) => page.locator(`[data-provider="${id}"]`);
const toggle = (page: Page, id: string) => provider(page, id).locator('.provider-toggle');
const radio = (page: Page, id: string) => provider(page, id).locator('.provider-radio');
const settings = (page: Page) => page.locator('#tab-settings').click();

async function stored(worker: Worker, key: string): Promise<unknown> {
  return worker.evaluate(async (storageKey) => {
    const api = (
      globalThis as unknown as {
        chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
      }
    ).chrome;
    return (await api.storage.local.get(storageKey))[storageKey];
  }, key);
}

async function configureCloud(page: Page, worker: Worker): Promise<void> {
  await settings(page);
  await toggle(page, 'openai-compat').click();
  await page.locator('#field-baseUrl').fill(`${BASE_URL}/tts/v1`);
  await page.locator('#field-model').fill('kokoro');
  await page.locator('#field-captionedSpeech').check();
  await page.locator('#field-captionedSpeech').blur();
  await expect
    .poll(() => stored(worker, CONFIGS))
    .toMatchObject({
      'openai-compat': { baseUrl: `${BASE_URL}/tts/v1`, model: 'kokoro', captionedSpeech: true },
    });
}

async function openVoices(page: Page): Promise<void> {
  await page.locator('#tab-reading').click();
  await page.locator('.voice-card').click();
  await page.getByRole('searchbox', { name: 'Filter voices' }).focus();
  await expect(page.locator('.voice-list li').first()).toBeVisible();
}

test.beforeEach(async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.locator('#tab-reading')).toHaveAttribute('aria-selected', 'true');
});

test('production panel renders every tab and each provider form', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.reload();
  await expect(page.getByText('No provider is configured')).toBeVisible();
  await expect(page.getByText('Nothing is being read')).toBeVisible();
  const tabs = await page.getByRole('tab').evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(tabs.slice(0, 2)).toEqual(['tab-reading', 'tab-settings']);
  for (const id of tabs) {
    await page.locator(`#${id}`).click();
    await expect(page.locator(`#panel-${id.replace('tab-', '')}`)).toHaveAttribute(
      'role',
      'tabpanel'
    );
  }
  await settings(page);
  expect(
    await page
      .locator('[data-provider]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-provider')))
  ).toEqual([
    'browser',
    'local',
    'dashscope',
    'volcengine',
    'openai-compat',
    'elevenlabs',
    'azure',
  ]);
  await expect(provider(page, 'browser')).toHaveAttribute('data-active', 'true');
  await expect(toggle(page, 'browser')).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByText('SayLoud reads with the browser voice while its circle is selected.')
  ).toBeVisible();
  await expect(page.locator('.form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Test Connection' })).toHaveCount(0);
  await expect(radio(page, 'elevenlabs')).toBeDisabled();
  await expect(radio(page, 'dashscope')).toBeDisabled();
  await expect(radio(page, 'browser')).toBeEnabled();
  const fields: Record<string, string[]> = {
    dashscope: ['apiKey', 'workspaceId', 'region', 'model', 'baseUrl'],
    volcengine: ['apiKey', 'resourceId', 'baseUrl'],
    'openai-compat': ['baseUrl', 'apiKey', 'model', 'captionedSpeech', 'headers'],
    elevenlabs: ['apiKey', 'model', 'outputFormat', 'baseUrl'],
    azure: ['subscriptionKey', 'region', 'outputFormat', 'lang'],
    local: [],
  };
  for (const [id, expected] of Object.entries(fields)) {
    await toggle(page, id).click();
    expect(
      await page
        .locator('.form .field')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.querySelector('[id^="field-"]')?.id.replace('field-', '') ?? '?')
        )
    ).toEqual(expected);
    await expect(page.locator('.provider-form')).toHaveCount(1);
  }
  expect(errors).toEqual([]);
});

test('production forms validate, autosave and preserve values and focus across reloads', async ({
  page,
  serviceWorker,
}) => {
  await settings(page);
  await toggle(page, 'openai-compat').click();
  await page.locator('#field-baseUrl').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByText('Base URL is required.')).toBeVisible();
  await expect(page.getByText('Not saved: fix the highlighted fields.')).toBeVisible();
  await page.locator('#field-baseUrl').fill('localhost:8880');
  await page.keyboard.press('Tab');
  await expect(page.getByText('Enter a full URL')).toBeVisible();
  await page.locator('#field-headers').fill('# a note\nX-Gateway: abc');
  await expect(page.locator('#field-headers-error')).toBeVisible();
  await page.locator('#field-baseUrl').fill(`${BASE_URL}/tts/v1`);
  await expect(page.getByText('Enter a full URL')).toHaveCount(0);
  await page.locator('#field-apiKey').fill('test-key-123');
  await page.locator('#field-model').fill('kokoro');
  await page.locator('#field-captionedSpeech').check();
  await page.locator('#field-headers').fill('X-Gateway: abc\nX-Second: def');
  await page.keyboard.press('Tab');
  await expect(
    page.getByText('Saved, but not in use. Use the circle beside the name to switch to it.')
  ).toBeVisible();
  const config = {
    provider: 'openai-compat',
    baseUrl: `${BASE_URL}/tts/v1`,
    apiKey: 'test-key-123',
    model: 'kokoro',
    captionedSpeech: true,
    headers: { 'X-Gateway': 'abc', 'X-Second': 'def' },
  };
  await expect.poll(() => stored(serviceWorker, CONFIGS)).toEqual({ 'openai-compat': config });
  expect(await stored(serviceWorker, 'sayloud:provider-config')).toBeUndefined();
  await expect(page.locator('.provider-delete')).toHaveCount(1);
  await toggle(page, 'azure').click();
  await expect(page.locator('.provider-delete')).toHaveCount(0);
  await page.reload();
  await settings(page);
  await toggle(page, 'openai-compat').click();
  await expect(page.locator('#field-baseUrl')).toHaveValue(config.baseUrl);
  await expect(page.locator('#field-apiKey')).toHaveValue(config.apiKey);
  await expect(page.locator('#field-model')).toHaveValue(config.model);
  await expect(page.locator('#field-captionedSpeech')).toBeChecked();
  await expect(page.locator('#field-headers')).toHaveValue('X-Gateway: abc\nX-Second: def');
  await page.locator('#field-apiKey').fill('test-key-1234');
  await page.keyboard.press('Tab');
  await expect
    .poll(() => stored(serviceWorker, CONFIGS))
    .toMatchObject({
      'openai-compat': { apiKey: 'test-key-1234' },
    });
  await expect(page.locator('#field-model')).toBeFocused();
});

test('production provider activation, voice selection and connection checks work', async ({
  page,
  serviceWorker,
  request,
}) => {
  await request.post(`${BASE_URL}/tts/control`, { data: { reset: true } });
  await configureCloud(page, serviceWorker);
  await radio(page, 'openai-compat').check();
  await expect(provider(page, 'openai-compat')).toHaveAttribute('data-active', 'true');
  await expect(provider(page, 'browser')).toHaveAttribute('data-active', 'false');
  await page.locator('#tab-reading').click();
  await expect(page.getByText('No voice selected')).toBeVisible();
  await expect(page.getByText('Reading in the browser voice for now')).toBeVisible();
  await openVoices(page);
  await expect(page.locator('.voice-list li')).toHaveText(['Stubaf_stub']);
  await expect(page.locator('.badge')).toHaveCount(0);
  await page.locator('.voice-list input[type=radio]').first().check();
  await expect
    .poll(() => stored(serviceWorker, 'sayloud:selected-voices'))
    .toEqual({
      'openai-compat': 'af_stub',
    });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('.voice-card-name')).toHaveText('Stub');
  await expect(page.locator('.voice-card-meta')).toHaveText('OpenAI-compatible · Word by word');
  await settings(page);
  await expect(toggle(page, 'openai-compat')).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Test Connection' }).click();
  await expect(page.locator('.form-results > .result').first()).toHaveText(
    'Connection succeeded.',
    { timeout: 15_000 }
  );
  await page.locator('#field-baseUrl').fill('http://127.0.0.1:1/v1');
  await page.locator('#field-baseUrl').blur();
  await expect
    .poll(() => stored(serviceWorker, CONFIGS))
    .toMatchObject({
      'openai-compat': { baseUrl: 'http://127.0.0.1:1/v1' },
    });
  await page.getByRole('button', { name: 'Test Connection' }).click();
  await expect(page.locator('.form-results > .result').first()).toContainText(
    'could not reach the service',
    { timeout: 15_000 }
  );
  await page.locator('#tab-reading').click();
  await settings(page);
  await expect(provider(page, 'openai-compat')).toHaveAttribute('data-active', 'true');
  await expect(toggle(page, 'openai-compat')).toHaveAttribute('aria-expanded', 'true');
});

test('production DashScope voice badges follow the selected model capabilities', async ({
  page,
  serviceWorker,
}) => {
  await settings(page);
  await toggle(page, 'dashscope').click();
  await page.locator('#field-apiKey').fill('sk-test');
  await page.locator('#field-apiKey').blur();
  await expect
    .poll(() => stored(serviceWorker, CONFIGS))
    .toMatchObject({
      dashscope: { apiKey: 'sk-test' },
    });
  expect(await stored(serviceWorker, 'sayloud:provider-config')).toBeUndefined();
  await radio(page, 'dashscope').check();
  await openVoices(page);
  const voices = await page.locator('.voice-list li').count();
  expect(voices).toBeGreaterThan(0);
  await expect(page.locator('.badge')).toHaveCount(voices);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await settings(page);
  await page.locator('#field-model').fill('cosyvoice-v2');
  await expect(page.getByText('reports no word timings')).toBeVisible();
  await page.locator('#field-model').blur();
  await expect
    .poll(() => stored(serviceWorker, CONFIGS))
    .toMatchObject({
      dashscope: { model: 'cosyvoice-v2' },
    });
  await openVoices(page);
  await expect(page.locator('.badge')).toHaveCount(0);
});

test('production settings and model controls work without horizontal overflow', async ({
  page,
  serviceWorker,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await expect(page.getByRole('switch', { name: 'Caption window' })).toBeVisible();
  await page.locator('#volume-slider').fill('1.5');
  await expect(page.getByText('150%')).toBeVisible();
  await expect.poll(() => stored(serviceWorker, 'sayloud:settings')).toMatchObject({ volume: 1.5 });
  await settings(page);
  await page.locator('#ui-lang').selectOption('zh-CN');
  await expect(page.getByRole('tab', { name: '朗读' })).toBeVisible();
  await expect(page.getByText('界面语言')).toBeVisible();
  await page.locator('#ui-lang').selectOption('en');
  await expect(page.getByRole('tab', { name: 'Reading' })).toBeVisible();
  await expect(page.getByText('Audio only. On-device models are stored separately.')).toBeVisible();
  await expect(page.locator('#cache-max')).toBeVisible();
  await expect(page.getByText(/^Used \d/)).toBeVisible();
  await page.locator('#cache-clear').click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByText('Used 0 B · 0 clips')).toBeVisible();
  await page.locator('#tab-models').click();
  expect(
    await page
      .locator('#model-source option')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('value')))
  ).toEqual(['auto', 'huggingface', 'modelscope', 'custom']);
  await expect(page.locator('#model-source')).toHaveValue('auto');
  await expect(page.locator('#model-source-url')).toHaveCount(0);
  expect(
    await page
      .locator('[data-tier]')
      .evaluateAll((nodes) =>
        nodes.map((node) => `${node.getAttribute('data-tier')}:${node.getAttribute('data-state')}`)
      )
  ).toEqual(['kokoro-82m:q8:absent', 'kokoro-82m:fp16:absent', 'kokoro-82m:fp32:absent']);
  await expect(page.locator('[data-tier] button')).toHaveText(['Download', 'Download', 'Download']);
  await expect(page.getByRole('link', { name: 'Licence: Apache-2.0' })).toBeVisible();
  await expect(page.getByText(/41 voices/)).toBeVisible();
  await expect(page.getByText('Storage used')).toBeVisible();
  await expect(page.locator('.row-value').first()).toHaveText(/^(WASM|WebGPU|Not loaded)/);
  await page.locator('#device-preference').selectOption('wasm');
  await expect
    .poll(() => stored(serviceWorker, CONFIGS))
    .toMatchObject({ local: { device: 'wasm' } });
  await page.locator('#device-preference').selectOption('auto');
  await expect
    .poll(() => stored(serviceWorker, CONFIGS))
    .toMatchObject({ local: { device: 'auto' } });
  await expect(page.getByText(/Voices are downloaded on demand/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Import/ })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 720 });
  const tabs = await page.getByRole('tab').evaluateAll((nodes) => nodes.map((node) => node.id));
  for (const id of tabs) {
    await page.locator(`#${id}`).click();
    await expect
      .poll(() => page.evaluate(() => document.body.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});
