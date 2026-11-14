#!/usr/bin/env node
/**
 * EmbedPDF v2 stress-test driver.
 *
 * Loads the built MV3 extension, opens the POC page, and replays each fixture
 * scenario through `window.__pocStress.runScenario()` while sampling the
 * Chrome process tree's memory. Results go to
 * `docs/research/embedpdf-stress-results.json`, screenshots to
 * `docs/research/embedpdf-stress/`.
 *
 * Why a custom driver instead of a Playwright spec: the measurements need
 * whole-process memory (PDFium's wasm heap is invisible to `performance.memory`)
 * and a **fresh browser per run**, so one scenario's leftover wasm heap cannot
 * inflate the next one's baseline.
 *
 *   pnpm build
 *   node tests/e2e/pdf-poc-stress.mjs
 *   node tests/e2e/pdf-poc-stress.mjs --only large --layer tiling
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const EXTENSION = resolve(ROOT, '.output/chrome-mv3');
const OUT_JSON = resolve(ROOT, 'docs/research/embedpdf-stress-results.json');
const SHOTS = resolve(ROOT, 'docs/research/embedpdf-stress');
const PORT = Number(process.env.SAYLOUD_E2E_PORT ?? 8787);

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const onlyLayer = argv.includes('--layer') ? argv[argv.indexOf('--layer') + 1] : null;

/** Every entry gets its own browser process (see the header comment). */
const RUNS = [
  { scenario: 'hello', layer: 'render', label: 'hello baseline' },
  { scenario: 'zh', layer: 'render', label: 'CJK zh, embedded font' },
  { scenario: 'ja', layer: 'render', label: 'CJK ja, embedded font' },
  { scenario: 'zh-nofont', layer: 'render', label: 'CJK zh, no embedded font' },
  { scenario: 'ja-nofont', layer: 'render', label: 'CJK ja, no embedded font' },
  { scenario: 'two-column', layer: 'render', label: 'two-column, RenderLayer' },
  { scenario: 'two-column', layer: 'tiling', label: 'two-column, TilingLayer' },
  { scenario: 'attention', layer: 'render', label: 'arXiv paper, RenderLayer' },
  { scenario: 'wiki-zh', layer: 'render', label: 'real zh wiki PDF, RenderLayer' },
  { scenario: 'wiki-ja', layer: 'render', label: 'real ja wiki PDF, RenderLayer' },
  { scenario: 'large', layer: 'render', label: 'large 120p, RenderLayer' },
  { scenario: 'large', layer: 'tiling', label: 'large 120p, TilingLayer' },
];

const environment = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  chromeVersion: null,
  cpu: null,
  memoryGb: null,
  userAgent: null,
};
const generatedAt = new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureServer() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) return null;
  } catch {
    // not running yet
  }
  const child = spawn('node', ['tests/e2e/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, SAYLOUD_E2E_PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i += 1) {
    await sleep(100);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return child;
    } catch {
      // still starting
    }
  }
  child.kill();
  throw new Error('e2e static server did not come up');
}

/** pid -> {ppid, rss} for every process on the box. */
function processTable() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=']).toString();
  const table = new Map();
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, ppid, rss] = parts.map(Number);
    table.set(pid, { ppid, rss });
  }
  return table;
}

function subtreePids(rootPid) {
  const table = processTable();
  const children = new Map();
  for (const [pid, entry] of table) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(pid);
  }
  const pids = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    pids.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return pids;
}

/** Sum RSS (MB). Over-counts shared pages — kept only as a fast peak proxy. */
function treeRssMb(rootPid) {
  const table = processTable();
  return Math.round(
    subtreePids(rootPid).reduce((sum, pid) => sum + (table.get(pid)?.rss ?? 0), 0) / 1024
  );
}

/** Physical footprint (MB) of one pid; macOS-only, no root needed. */
function footprintMb(pid) {
  try {
    const out = execFileSync('footprint', [String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    }).toString();
    const match = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(out);
    if (!match) return 0;
    const value = Number(match[1]);
    return match[2] === 'GB' ? value * 1024 : match[2] === 'KB' ? value / 1024 : value;
  } catch {
    return 0;
  }
}

/** Sum of physical footprint (MB); the honest memory number on macOS. */
function treeFootprintMb(rootPid) {
  const total = subtreePids(rootPid).reduce((sum, pid) => sum + footprintMb(pid), 0);
  return Math.round(total);
}

function chromePid(userDataDir) {
  const out = execFileSync('ps', ['-axo', 'pid=,args=']).toString();
  for (const line of out.split('\n')) {
    if (line.includes(`--user-data-dir=${userDataDir}`) && !line.includes('--type=')) {
      return Number(line.trim().split(/\s+/)[0]);
    }
  }
  return null;
}

async function launch(userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    // `channel: 'chromium'` is required: Playwright's default headless build is
    // the headless shell, which ignores `--load-extension`.
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 20_000 }).catch(() => null);
  }
  if (!worker) {
    await context.close();
    throw new Error('extension service worker never registered');
  }
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  const log = [];
  page.on('console', (message) => {
    if (message.type() === 'error') log.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => log.push(`pageerror: ${error.message}`));
  page.on('crash', () => log.push('page crashed'));

  const cdp = await context.newCDPSession(page);
  const browserVersion = await cdp.send('Browser.getVersion');
  environment.chromeVersion ??= browserVersion.product;
  environment.userAgent ??= browserVersion.userAgent;

  const browserPid = chromePid(userDataDir);
  if (!browserPid) {
    await context.close();
    throw new Error('could not find the chrome process');
  }
  return { context, page, log, cdp, extensionId, browserPid };
}

async function runOne(run, session, userDataDir) {
  const { context, page, log, cdp, extensionId, browserPid } = session;
  log.length = 0;
  const url = `chrome-extension://${extensionId}/pdf-poc.html?fixtures=http://127.0.0.1:${PORT}/pdf/`;

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__pocStress !== undefined, null, { timeout: 60_000 });
  await page.waitForFunction(
    () => window.__poc?.pluginsReady === true && window.__poc?.engineReady === true,
    null,
    { timeout: 120_000 }
  );
  // the wasm heap is allocated during engine init; baseline after it settles
  await sleep(1200);
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  await sleep(400);
  const rssBaseline = treeRssMb(browserPid);
  const footprintBaseline = treeFootprintMb(browserPid);

  await page.evaluate((mode) => window.__pocStress.setLayerMode(mode), run.layer);
  await sleep(200);

  let rssPeak = rssBaseline;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      rssPeak = Math.max(rssPeak, treeRssMb(browserPid));
      await sleep(250);
    }
  })();

  const startedAt = Date.now();
  let metrics = null;
  let fps = null;
  let footprintPeak = footprintBaseline;
  try {
    // Phase 1: load + first paint + text extraction, no scrolling, so the
    // "at rest" memory number is not contaminated by render churn.
    metrics = await Promise.race([
      page.evaluate((id) => window.__pocStress.runScenario(id, { scrollMs: 0 }), run.scenario),
      sleep(300_000).then(() => {
        throw new Error('scenario timed out after 300s');
      }),
    ]);
    const footprintAfterLoad = treeFootprintMb(browserPid);
    footprintPeak = Math.max(footprintPeak, footprintAfterLoad);

    // Phase 2: scroll the whole document while tracking peak footprint.
    let scrolling = true;
    const footprintSampler = (async () => {
      while (scrolling) {
        footprintPeak = Math.max(footprintPeak, treeFootprintMb(browserPid));
        await sleep(400);
      }
    })();
    fps = await page.evaluate(() => window.__pocStress.scrollTest(4000));
    scrolling = false;
    await footprintSampler;
    metrics.fps = fps;
    metrics.jsHeapAfterScrollMB = await page.evaluate(() =>
      performance.memory
        ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10
        : null
    );
    metrics.footprintAfterLoadMb = footprintAfterLoad;
  } catch (error) {
    log.push(`driver: ${error.message}`);
  }
  sampling = false;
  await sampler;
  rssPeak = Math.max(rssPeak, treeRssMb(browserPid));
  const elapsed = Date.now() - startedAt;

  if (!metrics) {
    return {
      ...run,
      error: log.slice(-5).join(' | '),
      rssBaselineMb: rssBaseline,
      rssPeakMb: rssPeak,
      footprintBaselineMb: footprintBaseline,
      wallMs: elapsed,
    };
  }

  const safe = `${run.scenario}-${run.layer}`;
  await page.evaluate(() => {
    const viewport = document.getElementById('pdf-viewport');
    if (viewport) viewport.scrollTop = 0;
  });
  await sleep(1500);
  await page.screenshot({ path: join(SHOTS, `${safe}-top.png`) });
  await page.evaluate(() => {
    const viewport = document.getElementById('pdf-viewport');
    if (viewport) viewport.scrollTop = viewport.scrollHeight * 0.45;
  });
  await sleep(2500);
  await page.screenshot({ path: join(SHOTS, `${safe}-mid.png`) });
  const mid = await page.evaluate(() => {
    const memory = performance.memory;
    const images = [...document.querySelectorAll('#pdf-viewport img')].filter(
      (img) => img.complete && img.naturalWidth > 0
    );
    return {
      jsHeapMB: memory ? Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10 : null,
      scrollTop: document.getElementById('pdf-viewport')?.scrollTop ?? null,
      scrollHeight: document.getElementById('pdf-viewport')?.scrollHeight ?? null,
      imagesDecoded: images.length,
      imagesInDom: document.querySelectorAll('#pdf-viewport img').length,
      imageSizes: images.slice(0, 3).map((img) => `${img.naturalWidth}x${img.naturalHeight}`),
    };
  });
  const rssAfterMid = treeRssMb(browserPid);
  const footprintAfterScroll = Math.max(footprintPeak, treeFootprintMb(browserPid));
  // Does the renderer hand the memory back once the document is at rest?
  await sleep(6000);
  const footprintAfterSettle = treeFootprintMb(browserPid);

  return {
    ...run,
    ...metrics,
    rssBaselineMb: rssBaseline,
    rssPeakMb: rssPeak,
    rssAfterScrollMb: rssAfterMid,
    footprintBaselineMb: footprintBaseline,
    footprintAfterScrollMb: footprintAfterScroll,
    footprintAfterSettleMb: footprintAfterSettle,
    wallMs: elapsed,
    mid,
    pageLog: log.slice(-10),
  };
}

async function main() {
  const server = await ensureServer();
  const userDataDir = await mkdtemp(join(tmpdir(), 'embedpdf-stress-'));
  await mkdir(SHOTS, { recursive: true });
  environment.cpu = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim();
  environment.memoryGb = Math.round(
    Number(execFileSync('sysctl', ['-n', 'hw.memsize']).toString()) / 1024 ** 3
  );

  const results = [];
  const runs = RUNS.filter(
    (run) =>
      (!only || run.scenario === only || run.label.includes(only)) &&
      (!onlyLayer || run.layer === onlyLayer)
  );

  for (const run of runs) {
    console.log(`\n=== ${run.label} (${run.scenario}, ${run.layer}) ===`);
    const session = await launch(userDataDir);
    try {
      const record = await runOne(run, session, userDataDir);
      results.push(record);
      if (record.error) {
        console.log(`  FAILED: ${record.error}`);
      } else {
        console.log(
          `  open ${record.openMs} ms | first paint ${record.firstPaintMs} ms | ` +
            `pages ${record.pageCount} | jsHeap peak ${record.jsHeapPeakMB} MB | ` +
            `footprint ${record.footprintBaselineMb} baseline / ${record.footprintAfterLoadMb} loaded / ` +
            `${record.footprintAfterScrollMb} peak / ${record.footprintAfterSettleMb} settled MB | ` +
            `scroll ${record.fps?.avgFps} fps, ${record.fps?.longTasks} long tasks ` +
            `(${record.fps?.blockingMs} ms), ${record.fps?.imagesAtEnd} bitmaps | ` +
            `text ${record.textChars} chars, ${record.badChars} bad | ` +
            `imgs ${record.mid?.imagesDecoded}/${record.mid?.imagesInDom}`
        );
      }
      if (record.errors?.length) console.log('  errors:', record.errors.join(' | '));
    } finally {
      await session.context.close();
      await sleep(500);
    }
  }

  await writeFile(OUT_JSON, `${JSON.stringify({ environment, generatedAt, results }, null, 2)}\n`);
  console.log(`\nwrote ${OUT_JSON}`);
  server?.kill();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
