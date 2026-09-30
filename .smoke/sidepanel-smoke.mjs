/**
 * Smoke check for the side panel, run in CI by `pnpm smoke:sidepanel`.
 *
 * Loads the production build in Chromium, opens sidepanel.html, and exercises
 * what static checks cannot see: that the panel renders, that each provider
 * gets its own form, that validation blocks a bad config, that saving persists
 * across a reload, and that Test Connection and Load Voices work against a
 * local stub.
 *
 * The tab list is walked rather than named: P4 adds a model tab, and this
 * script should not have to be rewritten for it. The two tabs it does drive by
 * id are the two it has an opinion about.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';

const EXTENSION_PATH = path.resolve(
  process.cwd(),
  process.env.SMOKE_EXTENSION ?? '.output/chrome-mv3'
);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function eventually(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function checkEventually(name, predicate, detail = '') {
  const ok = await eventually(predicate);
  check(name, ok, ok ? '' : detail);
}

function checkEqual(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    check(name, true);
  } catch {
    check(name, false, `got ${JSON.stringify(actual)}`);
  }
}

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  // The panel follows the browser's language when the setting is `auto`, and
  // the checks below are written in English. Pinned rather than inherited: a
  // developer on a Chinese machine would otherwise see every check fail.
  locale: 'en-US',
  args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
});

const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const extensionId = worker.url().split('/')[2];

const pageErrors = [];
const page = await context.newPage();
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
});

await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

const readingTab = page.locator('#tab-reading');
const settingsTab = page.locator('#tab-settings');
const providerRow = (id) => page.locator(`[data-provider="${id}"]`);
const settings = () => settingsTab.click();

/** The provider whose row is open, which is the form the checks type into. */
const openProvider = () =>
  page.locator('.provider-row[aria-expanded="true"]').getAttribute('data-provider');

// --- tabs -------------------------------------------------------------------
// The list, not the names: a third tab must need no change here beyond what
// the loop below already covers.
const tabList = await page
  .getByRole('tab')
  .evaluateAll((nodes) =>
    nodes.map((node) => ({ id: node.id, label: (node.textContent ?? '').trim() }))
  );
checkEqual(
  'the Reading and Settings tabs render in that order',
  tabList.slice(0, 2).map((tab) => tab.id),
  ['tab-reading', 'tab-settings']
);

let panelsOk = true;
for (const tab of tabList) {
  await page.locator(`#${tab.id}`).click();
  const panel = `#panel-${tab.id.replace('tab-', '')}`;
  const rendered =
    (await page.locator(panel).count()) === 1 &&
    (await page.locator(panel).getAttribute('role')) === 'tabpanel';
  panelsOk = panelsOk && rendered;
}
check('every tab in the list shows a panel of its own', panelsOk, JSON.stringify(tabList));

await readingTab.click();
check(
  'Reading tab is selected first',
  (await readingTab.getAttribute('aria-selected')) === 'true'
);
check(
  'Reading tab reports no provider configured',
  (await page.getByText('No provider is configured').count()) === 1
);
check(
  'Reading tab shows the session readout',
  (await page.getByText('Nothing is being read').count()) === 1
);

// --- settings: provider list ------------------------------------------------
await settings();
checkEqual(
  'all six providers are listed, in the schema order',
  await page
    .locator('[data-provider]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-provider'))),
  ['browser', 'dashscope', 'volcengine', 'openai-compat', 'elevenlabs', 'azure']
);
check(
  'the browser voice is the active row, and opens first',
  (await providerRow('browser').getAttribute('data-active')) === 'true' &&
    (await providerRow('browser').getAttribute('aria-expanded')) === 'true'
);
check(
  'browser voice shows a notice and no form fields',
  (await page.getByText('SayLoud will use the voices Chrome already has installed.').count()) ===
    1 && (await page.locator('.form').count()) === 0
);
check(
  'browser voice has no Test Connection button',
  (await page.getByRole('button', { name: 'Test Connection' }).count()) === 0
);

// --- settings: every provider renders its own fields ------------------------
const expectedFields = {
  dashscope: ['apiKey', 'workspaceId', 'region', 'model', 'baseUrl'],
  volcengine: ['apiKey', 'resourceId', 'baseUrl'],
  'openai-compat': ['baseUrl', 'apiKey', 'model', 'captionedSpeech', 'headers'],
  elevenlabs: ['apiKey', 'model', 'outputFormat', 'baseUrl'],
  azure: ['subscriptionKey', 'region', 'outputFormat', 'lang'],
};

for (const [id, fields] of Object.entries(expectedFields)) {
  // Clicking a row opens it and closes whichever row was open: one at a time.
  await providerRow(id).click();
  const rendered = await page
    .locator('.form .field')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector('[id^="field-"]')?.id.replace('field-', '') ?? '?')
    );
  checkEqual(`${id} renders exactly its own fields`, rendered, fields);
}
check(
  'only the open row shows a form',
  (await page.locator('.provider-form').count()) === 1
);

// --- validation -------------------------------------------------------------
await providerRow('openai-compat').click();

await page.getByRole('button', { name: 'Save' }).click();
check(
  'saving an empty required field shows an inline error',
  (await page.getByText('Base URL is required.').count()) === 1
);

await page.locator('#field-baseUrl').fill('localhost:8880');
await page.getByRole('button', { name: 'Save' }).click();
check(
  'a URL without a scheme is rejected inline',
  (await page.getByText('Enter a full URL').count()) === 1
);

await page.locator('#field-headers').fill('# a note\nX-Gateway: abc');
await checkEventually(
  'a note in the headers box is reported instead of silently dropped',
  async () => (await page.locator('#field-headers-error').count()) === 1,
  await page
    .locator('#field-headers-error')
    .textContent()
    .catch(() => 'no error rendered')
);
await page.locator('#field-headers').fill('X-Gateway: abc\nX-Second: def');

await page.locator('#field-baseUrl').fill('');
await page.getByRole('button', { name: 'Load Voices' }).click();
check(
  'Load Voices refuses an incomplete form',
  (await page.getByText('Fill in the required fields above first.').count()) === 1
);

// A stale result must not survive an edit to the field it described.
await page.locator('#field-baseUrl').fill('http://127.0.0.1:8899/v1');
await checkEventually(
  'editing a field clears the previous error',
  async () => (await page.getByText('Fill in the required fields above first.').count()) === 0
);

// --- save + persistence across a reload ------------------------------------
await page.locator('#field-apiKey').fill('test-key-123');
await page.locator('#field-model').fill('kokoro');
await page.locator('#field-captionedSpeech').check();
await page.locator('#field-headers').fill('X-Gateway: abc\nX-Second: def');
await page.getByRole('button', { name: 'Save' }).click();
check('save reports success', (await page.getByText('Saved.').count()) === 1);

const stored = await worker.evaluate(() => chrome.storage.local.get(null));
checkEqual('the config lands in namespaced storage.local', stored['sayloud:provider-config'], {
  provider: 'openai-compat',
  baseUrl: 'http://127.0.0.1:8899/v1',
  apiKey: 'test-key-123',
  model: 'kokoro',
  captionedSpeech: true,
  headers: { 'X-Gateway': 'abc', 'X-Second': 'def' },
});

await page.reload();
await settings();
checkEqual(
  'the form is refilled from storage after a reload',
  [
    await page.locator('#field-baseUrl').inputValue(),
    await page.locator('#field-apiKey').inputValue(),
    await page.locator('#field-model').inputValue(),
    await page.locator('#field-captionedSpeech').isChecked(),
    await page.locator('#field-headers').inputValue(),
  ],
  ['http://127.0.0.1:8899/v1', 'test-key-123', 'kokoro', true, 'X-Gateway: abc\nX-Second: def']
);

await readingTab.click();
check(
  'the Reading tab reflects the saved provider and its timings',
  (await page.getByText('OpenAI-compatible').count()) === 1 &&
    (await page.getByText('Word by word').count()) === 1
);
check(
  'the Reading tab falls back to the default voice',
  (await page.getByText('Default voice').count()) === 1
);
await settings();

// --- Test Connection + Load Voices against a local stub --------------------
const server = createServer((request, response) => {
  // Extension pages fetch cross-origin, and the real Kokoro answers `*` (V7).
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors).end();
    return;
  }
  const json = (body) => {
    response.writeHead(200, { ...cors, 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  if (request.url?.startsWith('/v1/audio/voices')) {
    json({ voices: ['af_bella', 'am_adam'] });
    return;
  }
  if (request.url?.startsWith('/v1/dev/captioned_speech')) {
    json({
      audio: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAIA+AAABAAgAZGF0YQAAAAA=',
      audio_format: 'audio/wav',
      timestamps: [],
    });
    return;
  }
  response.writeHead(404, { ...cors, 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'not found' } }));
});
await new Promise((resolve) => server.listen(8899, '127.0.0.1', resolve));

await page.getByRole('button', { name: 'Load Voices' }).click();
await page.waitForSelector('.voice-list li', { timeout: 8000 }).catch(() => {});
const voiceRows = await page.locator('.voice-list li').allTextContents();
checkEqual('Load Voices lists the voices the server returned', voiceRows, [
  'af_bellaaf_bella',
  'am_adamam_adam',
]);
check(
  'openai-compat voices are not badged, since it advertises no per-voice timings',
  (await page.locator('.badge').count()) === 0
);

await page.locator('.voice-list input[type=radio]').first().check();
await page.waitForTimeout(200);
const voiceStore = await worker.evaluate(() => chrome.storage.local.get('sayloud:selected-voices'));
checkEqual('picking a voice persists it', voiceStore['sayloud:selected-voices'], {
  'openai-compat': 'af_bella',
});

// The Reading tab shows the same choice, which it reads from the store.
await readingTab.click();
check(
  'the Reading tab shows the voice that was picked',
  (await page.getByText('af_bella').count()) === 1
);
await settings();

await page.getByRole('button', { name: 'Test Connection' }).click();
await page.waitForSelector('.form-results .result', { timeout: 15000 }).catch(() => {});
checkEqual(
  'Test Connection succeeds against the stub',
  await page.locator('.form-results .result').first().textContent(),
  'Connection succeeded.'
);

// --- timings badges, from a provider that advertises them -------------------
await providerRow('dashscope').click();
await page.locator('#field-apiKey').fill('sk-test');
await page.getByRole('button', { name: 'Load Voices' }).click();
await page.waitForSelector('.voice-list li', { timeout: 8000 }).catch(() => {});
const diagnostics = await page.evaluate(() => ({
  provider: document.querySelector('.provider-row[aria-expanded="true"]')?.dataset.provider,
  apiKey: document.querySelector('#field-apiKey')?.value,
  fields: [...document.querySelectorAll('.form [id^=field-]')].map((n) => n.id),
  voiceItems: document.querySelectorAll('.voice-list li').length,
  statuses: [...document.querySelectorAll('.result, .field-error')].map((n) => n.textContent),
}));
console.log('  dashscope diagnostics:', JSON.stringify(diagnostics));
const dashVoices = await page.locator('.voice-list li').count();
const dashBadges = await page.locator('.badge').count();
check('DashScope lists its catalogue without a network call', dashVoices > 0, `${dashVoices} voices`);
check(
  'every DashScope voice is badged for word timings',
  dashBadges === dashVoices,
  `${dashBadges}/${dashVoices}`
);

await page.locator('#field-model').fill('cosyvoice-v2');
check(
  'the capability note follows the model',
  (await page.getByText('reports no word timings').count()) === 1
);
await page.getByRole('button', { name: 'Load Voices' }).click();
await page.waitForTimeout(400);
check(
  'and the voices stop being badged',
  (await page.locator('.badge').count()) === 0
);

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

// A failing service must surface readable copy, not a stack trace.
await providerRow('openai-compat').click();
await page.getByRole('button', { name: 'Test Connection' }).click();
await page.waitForTimeout(3000);
server.close();
await page.getByRole('button', { name: 'Test Connection' }).click();
await page.waitForTimeout(4000);
const unreachable = String(await page.locator('.form-results .result').first().textContent());
check(
  'Test Connection reports an unreachable service readably',
  /could not reach the service/.test(unreachable),
  unreachable
);

// --- tab switching keeps the saved config ----------------------------------
await readingTab.click();
await settings();
check(
  'switching tabs keeps the saved provider selected',
  (await providerRow('openai-compat').getAttribute('data-active')) === 'true' &&
    (await openProvider()) === 'openai-compat'
);

// --- the settings the panel exists to change -------------------------------
await readingTab.click();

const volume = page.locator('#volume-slider');
const captionSwitch = page.getByRole('switch', { name: 'Caption window' });
check(
  'the Reading tab carries the volume slider and the caption switch',
  (await volume.count()) === 1 && (await captionSwitch.count()) === 1
);

await volume.fill('1.5');
await checkEventually(
  'releasing the volume slider saves it, and the readout follows',
  async () => {
    const saved = await worker.evaluate(() => chrome.storage.local.get('sayloud:settings'));
    return (
      saved['sayloud:settings']?.volume === 1.5 &&
      (await page.getByText('150%').count()) === 1
    );
  },
  'the volume never reached storage'
);

await settings();
await page.locator('#ui-lang').selectOption('zh-CN');
const inChinese =
  (await page.getByRole('tab', { name: '朗读' }).count()) === 1 &&
  (await page.getByText('界面语言').count()) >= 1;
await page.locator('#ui-lang').selectOption('en');
const backInEnglish = (await page.getByRole('tab', { name: 'Reading' }).count()) === 1;
check(
  'the interface language switches to Chinese and back',
  inChinese && backInEnglish,
  `chinese ${inChinese}, english ${backInEnglish}`
);

check(
  'the cache card is the audio cache, and says so',
  (await page.getByText('Cache').count()) >= 1 &&
    (await page.getByText('Audio only. On-device models are stored separately.').count()) === 1 &&
    (await page.locator('#cache-max').count()) === 1
);
await checkEventually(
  'the cache reports how much it holds',
  async () => (await page.getByText(/^Used \d/).count()) === 1,
  'no usage line'
);

await page.locator('#cache-clear').click();
const confirming =
  (await page.getByRole('button', { name: 'Clear' }).count()) === 1 &&
  (await page.getByRole('button', { name: 'Cancel' }).count()) === 1;
check('emptying the cache is confirmed in the card, not by a modal', confirming);
if (confirming) await page.getByRole('button', { name: 'Clear' }).click();
await checkEventually(
  'clearing the cache empties it',
  async () => (await page.getByText('Used 0 B · 0 clips').count()) === 1,
  'the usage line never reached zero'
);

// --- the narrowest panel Chrome allows -------------------------------------
// A side panel is about 320px wide and the user cannot widen it, so anything
// that pushes the page sideways is a bug with no workaround.
await page.setViewportSize({ width: 320, height: 720 });
await readingTab.click();
const readingOverflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
await settings();
const settingsOverflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
check(
  'no horizontal scroll at 320px',
  readingOverflow <= 0 && settingsOverflow <= 0,
  `reading overflows by ${readingOverflow}, settings by ${settingsOverflow}`
);

await context.close();

const failures = results.filter((result) => !result.ok);
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
if (failures.length > 0) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.detail}`);
  process.exit(1);
}
