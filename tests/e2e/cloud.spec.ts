/**
 * Cloud playback end to end, without a key or a network.
 *
 * The e2e server stands in for Kokoro-FastAPI (see `server.mjs`), so this runs
 * the whole cloud path in a real browser: the saved config, the router picking
 * the cloud speaker, the offscreen document, the provider adapter, the cache,
 * the `<audio>` element and the word timeline — everything the unit tests fake.
 *
 * The stub's audio is silence of a known length (0.35 s per word), so the
 * timings are deterministic enough to assert on without listening to anything.
 */
import type { Page, Worker } from '@playwright/test';
import { BASE_URL, control, expect, test } from './fixtures';
import { bubble, sentenceHighlight, wordHighlight } from './helpers';

const TTS_BASE = `${BASE_URL}/tts/v1`;

interface StubRequest {
  path: string;
  input: string;
  voice?: string;
  stream?: boolean;
}

/** What the stub has been asked for since the last reset. */
async function stubRequests(page: Page): Promise<StubRequest[]> {
  const response = await page.request.get(`${BASE_URL}/tts/control`);
  return ((await response.json()) as { requests: StubRequest[] }).requests;
}

async function controlStub(page: Page, body: { reset?: boolean; failNext?: number }) {
  await page.request.post(`${BASE_URL}/tts/control`, { data: body });
}

/**
 * Save an openai-compat config the way the settings panel does, and wait for
 * the worker's router to pick it up.
 */
async function useStubProvider(serviceWorker: Worker, captionedSpeech: boolean): Promise<void> {
  await serviceWorker.evaluate(
    async ({ baseUrl, captioned }) => {
      const chrome = (
        globalThis as unknown as {
          chrome: { storage: { local: { set(items: object): Promise<void> } } };
        }
      ).chrome;
      const config = {
        provider: 'openai-compat',
        baseUrl,
        model: 'kokoro',
        captionedSpeech: captioned,
      };
      await chrome.storage.local.set({
        'sayloud:provider-config': config,
        'sayloud:provider-configs': { 'openai-compat': config },
        'sayloud:selected-voices': { 'openai-compat': 'af_stub' },
      });
    },
    { baseUrl: TTS_BASE, captioned: captionedSpeech }
  );
  // `storage.onChanged` → `speakers.refresh()` is asynchronous.
  await serviceWorker.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
}

test.beforeEach(async ({ page }) => {
  await controlStub(page, { reset: true });
});

test('reads through the cloud provider and highlights words from its timestamps', async ({
  page,
  serviceWorker,
  activate,
}) => {
  await useStubProvider(serviceWorker, true);
  await page.goto('/article.html');
  await activate();

  await expect.poll(() => sentenceHighlight(page), { timeout: 10_000 }).toContain('first sentence');

  // The word layer is driven by the provider's timestamps, not by chrome.tts.
  await expect.poll(() => wordHighlight(page), { timeout: 10_000 }).not.toBe('');

  await expect.poll(async () => (await stubRequests(page)).length).toBeGreaterThan(0);
  const requests = await stubRequests(page);
  expect(requests[0]).toMatchObject({
    path: '/tts/v1/dev/captioned_speech',
    voice: 'af_stub',
    // Kokoro only answers with one JSON body when streaming is off (spec V7).
    stream: false,
  });
  expect(requests[0]?.input).toContain('first sentence');

  // It moves on by itself when the audio ends.
  await expect
    .poll(() => sentenceHighlight(page), { timeout: 15_000 })
    .toContain('second sentence');
});

test('prefetches the sentences ahead of the one playing', async ({
  page,
  serviceWorker,
  activate,
}) => {
  await useStubProvider(serviceWorker, true);
  await page.goto('/article.html');
  await activate();

  await expect.poll(() => sentenceHighlight(page), { timeout: 10_000 }).toContain('first sentence');

  // By the time the first sentence plays, the next ones have been asked for.
  await expect
    .poll(async () => (await stubRequests(page)).length, { timeout: 10_000 })
    .toBeGreaterThan(2);
  const inputs = (await stubRequests(page)).map((request) => request.input);
  expect(inputs.some((input) => input.includes('second sentence'))).toBe(true);
});

test('pauses and resumes the cloud audio', async ({ page, serviceWorker, activate }) => {
  await useStubProvider(serviceWorker, true);
  await page.goto('/article.html');
  await activate();

  await expect(control(page, 'Pause')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => wordHighlight(page), { timeout: 10_000 }).not.toBe('');

  await control(page, 'Pause').click();
  await expect(control(page, 'Play')).toBeVisible();

  // Paused means no progress: the sentence stays put across a whole sentence's
  // worth of audio.
  const held = await sentenceHighlight(page);
  await page.waitForTimeout(3_000);
  expect(await sentenceHighlight(page)).toBe(held);

  await control(page, 'Play').click();
  await expect(control(page, 'Pause')).toBeVisible();
  await expect.poll(() => sentenceHighlight(page), { timeout: 15_000 }).not.toBe(held);
});

test('replays a sentence from the cache instead of synthesizing it again', async ({
  page,
  serviceWorker,
  activate,
}) => {
  await useStubProvider(serviceWorker, true);
  await page.goto('/article.html');
  await activate();

  await expect
    .poll(() => sentenceHighlight(page), { timeout: 15_000 })
    .toContain('second sentence');

  const firstSentenceRequests = () =>
    stubRequests(page).then(
      (requests) => requests.filter((request) => request.input.includes('first sentence')).length
    );
  expect(await firstSentenceRequests()).toBe(1);

  // Back to the first sentence: it was synthesized once, so it plays from the
  // cache and the stub is not asked again.
  await control(page, 'Previous sentence').click();
  await expect.poll(() => sentenceHighlight(page), { timeout: 10_000 }).toContain('first sentence');
  await expect.poll(() => wordHighlight(page), { timeout: 10_000 }).not.toBe('');
  expect(await firstSentenceRequests()).toBe(1);
});

test('highlights whole sentences when the endpoint reports no timings', async ({
  page,
  serviceWorker,
  activate,
}) => {
  await useStubProvider(serviceWorker, false);
  await page.goto('/article.html');
  await activate();

  await expect.poll(() => sentenceHighlight(page), { timeout: 10_000 }).toContain('first sentence');
  // The sentence is highlighted as soon as it starts loading, before the
  // request has necessarily reached the stub.
  await expect
    .poll(async () => (await stubRequests(page))[0]?.path, { timeout: 10_000 })
    .toBe('/tts/v1/audio/speech');

  // No timestamps and no estimation: the word layer stays empty while the
  // sentence plays through to the next one.
  await expect
    .poll(() => sentenceHighlight(page), { timeout: 15_000 })
    .toContain('second sentence');
  expect(await wordHighlight(page)).toBe('');
});

test('reports a failed service instead of falling back to the browser voice', async ({
  page,
  serviceWorker,
  activate,
}) => {
  await useStubProvider(serviceWorker, true);
  // Enough failures to cover the playing sentence and its prefetches.
  await controlStub(page, { failNext: 50 });
  await page.goto('/article.html');
  await activate();

  // The document arrives and the highlight follows it; what fails is the
  // service that was asked to speak it.
  await expect.poll(() => sentenceHighlight(page), { timeout: 10_000 }).toContain('first sentence');

  // No fallback to `chrome.tts`. The user chose this provider, so the failure is
  // reported and the decision to switch is theirs: reading on in the browser
  // voice would hide a broken endpoint behind audio that sounds fine. The
  // disabled play button is the same statement from the other side — there is no
  // session to toggle until the provider works.
  //
  // The card's body is the service's own message, untranslated: it is the one
  // thing that says whether this was a rejected key, a bad URL or a dead
  // server, and no wording of ours can say it for it.
  await expect(bubble(page)).toContainText('stub is failing on purpose');
  await expect(control(page, 'Play')).toBeDisabled();
});
