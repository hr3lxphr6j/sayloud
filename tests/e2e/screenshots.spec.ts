/**
 * The README images, and the Chrome Web Store screenshots.
 *
 * Not a test: it drives the same e2e bundle a spec does — a real Chrome, the
 * real extension, the bundled article and the stub TTS server — and writes PNGs
 * into `assets/` and `store-assets/`. Skipped unless `SAYLOUD_CAPTURE=1`, so
 * neither `pnpm test:e2e` nor CI ever writes images.
 *
 *     pnpm capture:screenshots
 *
 * The README images are the raw windows: the page with the reader injected, the
 * side panel at 380×820, the caption window at 420×180. The store images are
 * composed from those at 1280×800 (the size the Chrome Web Store asks for),
 * with the copy the listing will use. Composition happens in a blank page with
 * `setContent` and data URLs, so it needs no image library.
 *
 * Two things about what ends up in the frames. The host page is the test
 * fixture with a stylesheet added below, because the fixture deliberately ships
 * with none — the tests care about extraction and highlighting, not about how
 * the page looks. And the voice is the browser voice, because the images must
 * not depend on an API key or a 92 MB model download. Everything else in them is
 * the real thing, which also means they go stale when the UI moves: re-run the
 * command after a UI change and commit the diff.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { control, expect, test } from './fixtures';
import { saveSettings, sentenceHighlight } from './helpers';

const OUT = resolve(process.cwd(), 'assets');
const STORE = resolve(process.cwd(), 'store-assets');
const STORE_SHOTS = join(STORE, 'screenshots');
const STORE_SIZE = { width: 1280, height: 800 };
const PROMO_SIZE = { width: 440, height: 280 };

/**
 * A stylesheet for the article, so the screenshots show a page rather than a
 * browser default. Nothing the extension does depends on it.
 */
const ARTICLE_CSS = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    background: #fbfbfa;
    color: #24292f;
    font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  article { max-width: 40rem; margin: 0 auto; padding: 72px 40px 160px; }
  h1 { font-size: 2.1rem; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 0.4em; }
  p { margin: 0 0 1.35em; }
`;

const PANEL_SIZE = { width: 380, height: 820 };

/** What each tab has to be showing before its screenshot is worth taking. */
const TAB_READY = {
  Reading: 'Reading session',
  Settings: 'Interface language',
  Models: 'Download source',
} as const;

/** Start reading with the browser voice, which needs no key and no download. */
async function startReading(page: Page, activate: () => Promise<void>): Promise<void> {
  await page.goto('/article.html');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addStyleTag({ content: ARTICLE_CSS });
  await activate();
  await expect(control(page, 'Pause')).toBeVisible();
  await expect.poll(() => sentenceHighlight(page)).toContain('first sentence');
}

/** The side panel, on one of its tabs, sized like a real one. */
async function openPanel(
  context: BrowserContext,
  extensionId: string,
  tab: keyof typeof TAB_READY
): Promise<Page> {
  const panel = await context.newPage();
  await panel.setViewportSize(PANEL_SIZE);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('tab', { name: tab }).click();
  await expect(panel.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText(TAB_READY[tab])).toBeVisible();
  return panel;
}

/** The window a caption-button click opened, once Chromium has made it. */
async function captionWindow(context: BrowserContext, before: Page[]): Promise<Page> {
  const known = new Set(before);
  await expect.poll(() => context.pages().length).toBe(before.length + 1);
  const opened = context.pages().find((candidate) => !known.has(candidate));
  if (!opened) throw new Error('the caption window never appeared');
  return opened;
}

/** What the caption window shows, or '' while its document is still empty. */
async function captionText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body?.textContent ?? '');
  } catch {
    return '';
  }
}

/**
 * A screenshot at device pixel ratio 2.
 *
 * The composed slides display the caption at roughly 1.3× its CSS size, and a
 * 1× capture would be the one soft image on the page. The panel shots are only
 * ever scaled down, so they stay at 1×.
 */
async function screenshotAt2x(
  context: BrowserContext,
  page: Page,
  size: { width: number; height: number }
): Promise<Buffer> {
  const client = await context.newCDPSession(page);
  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    return await page.screenshot({ scale: 'device' });
  } finally {
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await client.detach();
  }
}

/** A file on disk as an `img` source, so `setContent` needs no server. */
async function dataUrl(path: string): Promise<string> {
  const file = await readFile(path);
  return `data:image/png;base64,${file.toString('base64')}`;
}

const STORE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
  body {
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1c1c1e;
    background: #f7faff;
    -webkit-font-smoothing: antialiased;
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    font-size: 21px; font-weight: 700; letter-spacing: -0.01em;
  }
  .brand img { width: 34px; height: 34px; border-radius: 9px; }
  .eyebrow {
    margin: 0 0 12px; font-size: 14px; font-weight: 700;
    letter-spacing: 0.14em; text-transform: uppercase; color: #0071e3;
  }
`;

const PANEL_CSS = `
  body.panel {
    display: flex; align-items: center; gap: 60px; padding: 56px 72px;
    background:
      radial-gradient(900px 620px at 82% 18%, #e2efff 0%, rgba(226, 239, 255, 0) 62%),
      linear-gradient(165deg, #fbfdff 0%, #eef5ff 100%);
  }
  .copy { width: 520px; flex: none; }
  .copy .eyebrow { margin-top: 46px; }
  h1 { margin: 0; font-size: 52px; line-height: 1.06; letter-spacing: -0.025em; }
  .lede { margin: 20px 0 26px; font-size: 20px; line-height: 1.5; color: #4c4c53; }
  ul { margin: 0; padding: 0; list-style: none; }
  li {
    position: relative; padding-left: 34px; margin: 14px 0;
    font-size: 19px; line-height: 1.4; color: #313136;
  }
  li::before {
    content: ""; position: absolute; left: 0; top: 3px;
    width: 21px; height: 21px; border-radius: 50%; background: #0071e3;
  }
  li::after {
    content: ""; position: absolute; left: 6px; top: 9px;
    width: 9px; height: 5px; border-left: 2px solid #fff; border-bottom: 2px solid #fff;
    transform: rotate(-45deg);
  }
  .visual { flex: 1; display: flex; align-items: center; justify-content: center; }
  .panel-shot {
    height: 700px; width: auto; border-radius: 16px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    box-shadow: 0 30px 70px rgba(0, 45, 110, 0.22), 0 2px 6px rgba(0, 0, 0, 0.08);
  }
`;

const HERO_CSS = `
  body.hero { background: #fbfbfa; }
  .backdrop { position: absolute; inset: 0; width: 1280px; height: 800px; }
  .fade {
    position: absolute; inset: 0;
    background: linear-gradient(180deg, rgba(255,255,255,0) 28%, rgba(255,255,255,0.97) 50%, #fff 56%);
  }
  .hero .brand { position: absolute; left: 64px; top: 52px; }
  .hero-copy { position: absolute; left: 64px; bottom: 62px; width: 640px; }
  .hero-copy .eyebrow { margin-bottom: 14px; }
  h1 { margin: 0; font-size: 58px; line-height: 1.04; letter-spacing: -0.03em; }
  .lede { margin: 18px 0 14px; font-size: 21px; line-height: 1.45; color: #3c3c42; }
  .note { margin: 0; font-size: 17px; color: #6b6b70; }
`;

const CAPTION_CSS = `
  body.caption-slide { background: #fbfbfa; }
  .backdrop {
    position: absolute; inset: -28px;
    width: calc(100% + 56px); height: calc(100% + 56px);
    filter: blur(9px);
  }
  .scrim { position: absolute; inset: 0; background: rgba(255, 255, 255, 0.62); }
  .center {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; text-align: center;
  }
  .caption-slide .eyebrow { margin-bottom: 12px; }
  h1 { margin: 0; font-size: 50px; line-height: 1.06; letter-spacing: -0.025em; }
  .lede { margin: 16px 0 34px; font-size: 20px; color: #4c4c53; }
  .caption-shot {
    width: 520px; border-radius: 16px; border: 1px solid rgba(0, 0, 0, 0.08);
    box-shadow: 0 26px 60px rgba(0, 0, 0, 0.2);
  }
`;

const PROMO_CSS = `
  html, body { width: 440px; height: 280px; }
  body.promo {
    display: flex; align-items: center; gap: 22px; padding: 0 40px;
    background:
      radial-gradient(420px 300px at 88% 6%, #d8ebff 0%, rgba(216, 235, 255, 0) 70%),
      linear-gradient(155deg, #ffffff 0%, #eef5ff 100%);
  }
  .promo-icon { width: 96px; height: 96px; border-radius: 24px; box-shadow: 0 12px 28px rgba(0, 60, 140, 0.2); }
  .promo-name { font-size: 42px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.1; }
  .promo-tag { margin-top: 6px; font-size: 19px; color: #3c3c42; }
`;

function slide(styles: string, className: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STORE_CSS}${styles}</style></head><body class="${className}">${body}</body></html>`;
}

function panelSlide(opts: {
  icon: string;
  eyebrow: string;
  title: string;
  lede: string;
  points: string[];
  shot: string;
}): string {
  const points = opts.points.map((point) => `<li>${point}</li>`).join('');
  return slide(
    PANEL_CSS,
    'panel',
    `<div class="copy">
        <div class="brand"><img src="${opts.icon}" alt=""><span>SayLoud</span></div>
        <p class="eyebrow">${opts.eyebrow}</p>
        <h1>${opts.title}</h1>
        <p class="lede">${opts.lede}</p>
        <ul>${points}</ul>
      </div>
      <div class="visual"><img class="panel-shot" src="${opts.shot}" alt=""></div>`
  );
}

/** Write one composed slide and close its page. */
async function compose(
  context: BrowserContext,
  html: string,
  size: { width: number; height: number },
  path: string
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.setViewportSize(size);
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path, animations: 'disabled' });
  } finally {
    await page.close();
  }
}

test.describe('README and Chrome Web Store images', () => {
  test.skip(!process.env.SAYLOUD_CAPTURE, 'SAYLOUD_CAPTURE=1 writes the images');

  test('writes them', async ({ context, extensionId, page, activate }) => {
    await mkdir(OUT, { recursive: true });

    // The bar's caption button only appears once the reader has been told to
    // offer it, which is a setting.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await saveSettings(options, { captionWindow: true });
    // The Reading tab shows "No provider is configured" until a config exists,
    // even though the browser voice is the default. Pick it explicitly so the
    // store screenshot shows the panel as a configured user sees it.
    await options.evaluate(() => {
      const api = (
        globalThis as unknown as {
          chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };
        }
      ).chrome;
      return api.storage.local.set({ 'sayloud:provider-config': { provider: 'browser' } });
    });
    await options.close();

    await startReading(page, activate);
    await page.screenshot({ path: join(OUT, 'reading.png') });

    for (const tab of ['Reading', 'Settings', 'Models'] as const) {
      const panel = await openPanel(context, extensionId, tab);
      await panel.screenshot({ path: join(OUT, `panel-${tab.toLowerCase()}.png`) });
      await panel.close();
    }

    const before = context.pages();
    await control(page, 'Caption window').click();
    const caption = await captionWindow(context, before);
    await expect.poll(() => captionText(caption)).toMatch(/Sentence 1 of \d+/);
    // Chromium hands Playwright the window as a page with the *browser's*
    // viewport, so the capture would be the caption centred in 1280x720 of white.
    // Tell it the size the window was requested at instead.
    await caption.setViewportSize({ width: 420, height: 180 });
    await caption.screenshot({ path: join(OUT, 'caption.png') });
    const caption2x = await screenshotAt2x(context, caption, { width: 420, height: 180 }).catch(
      () => null
    );

    // ---- Chrome Web Store assets -------------------------------------------
    await mkdir(STORE_SHOTS, { recursive: true });
    await copyFile(join(process.cwd(), 'public/icon-128.png'), join(STORE, 'icon-128.png'));

    const icon = await dataUrl(join(process.cwd(), 'public/icon-128.png'));
    const reading = await dataUrl(join(OUT, 'reading.png'));
    const captionShot = caption2x
      ? `data:image/png;base64,${caption2x.toString('base64')}`
      : await dataUrl(join(OUT, 'caption.png'));

    await compose(
      context,
      slide(
        HERO_CSS,
        'hero',
        `<img class="backdrop" src="${reading}" alt="">
         <div class="fade"></div>
         <div class="brand"><img src="${icon}" alt=""><span>SayLoud</span></div>
         <div class="hero-copy">
           <p class="eyebrow">Text to speech for Chrome</p>
           <h1>Read any page<br>aloud.</h1>
           <p class="lede">Sentence highlighting, 0.5×–3× speed, and playback that keeps going when you switch tabs.</p>
           <p class="note">Works out of the box with your browser’s voices — no account, no API key.</p>
         </div>`
      ),
      STORE_SIZE,
      join(STORE_SHOTS, '01-read-any-page.png')
    );

    const panels = [
      {
        file: '02-controls',
        html: panelSlide({
          icon,
          eyebrow: 'The control bar',
          title: 'Everything within reach',
          lede: 'A slim bar on the right edge, not another settings window to keep open.',
          points: [
            'Play, pause and skip sentences',
            'Change speed and volume for the sentence playing now',
            'A progress ring shows time remaining',
          ],
          shot: await dataUrl(join(OUT, 'panel-reading.png')),
        }),
      },
      {
        file: '03-models',
        html: panelSlide({
          icon,
          eyebrow: 'On-device voices',
          title: 'Runs on your device',
          lede: 'Download a speech model once, then read without sending a word anywhere.',
          points: [
            'Hugging Face, ModelScope, or your own mirror',
            'WebGPU when available, CPU otherwise',
            'No account and no API key',
          ],
          shot: await dataUrl(join(OUT, 'panel-models.png')),
        }),
      },
      {
        file: '04-settings',
        html: panelSlide({
          icon,
          eyebrow: 'Settings',
          title: 'Make it yours',
          lede: 'The details are one tab away and every one of them is optional.',
          points: [
            'Interface in English, 中文, or 日本語',
            'Cache size and one-click clearing',
            'Captions, auto-scroll, and skip-on-click',
          ],
          shot: await dataUrl(join(OUT, 'panel-settings.png')),
        }),
      },
    ] as const;

    for (const { file, html } of panels) {
      await compose(context, html, STORE_SIZE, join(STORE_SHOTS, `${file}.png`));
    }

    await compose(
      context,
      slide(
        CAPTION_CSS,
        'caption-slide',
        `<img class="backdrop" src="${reading}" alt="">
         <div class="scrim"></div>
         <div class="center">
           <p class="eyebrow">Captions that follow along</p>
           <h1>Never lose your place.</h1>
           <p class="lede">A floating caption shows the current sentence while you work in another tab.</p>
           <img class="caption-shot" src="${captionShot}" alt="">
         </div>`
      ),
      STORE_SIZE,
      join(STORE_SHOTS, '05-captions.png')
    );

    await compose(
      context,
      slide(
        PROMO_CSS,
        'promo',
        `<img class="promo-icon" src="${icon}" alt="">
         <div>
           <div class="promo-name">SayLoud</div>
           <div class="promo-tag">Read any page aloud</div>
         </div>`
      ),
      PROMO_SIZE,
      join(STORE, 'promo-440x280.png')
    );
  });
});
