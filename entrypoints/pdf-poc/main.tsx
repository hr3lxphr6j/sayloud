import { createPluginRegistration, type PluginRegistry } from '@embedpdf/core';
import { EmbedPDF } from '@embedpdf/core/preact';
import { createPdfiumEngine as createDirectEngine } from '@embedpdf/engines/pdfium-direct-engine';
import { createPdfiumEngine as createWorkerEngine } from '@embedpdf/engines/pdfium-worker-engine';
import type { PdfEngine } from '@embedpdf/models';
import {
  DocumentContent,
  DocumentManagerPluginPackage,
} from '@embedpdf/plugin-document-manager/preact';
import {
  GlobalPointerProvider,
  InteractionManagerPluginPackage,
  PagePointerProvider,
} from '@embedpdf/plugin-interaction-manager/preact';
import { RenderLayer, RenderPluginPackage } from '@embedpdf/plugin-render/preact';
import { Scroller, ScrollPluginPackage, ScrollStrategy } from '@embedpdf/plugin-scroll/preact';
import { TilingLayer, TilingPluginPackage } from '@embedpdf/plugin-tiling/preact';
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/preact';
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

/*
 * EmbedPDF v2 stress-test harness.
 *
 * Everything on this page is throwaway POC code: the goal is to measure how
 * the 2.15.1 stack behaves on real-world PDFs (large files, CJK fonts that are
 * or are not embedded, two-column layouts) and to compare `RenderLayer` with
 * `TilingLayer`. The integration plan lives in
 * `docs/research/embedpdf-integration-plan.md`, the results in
 * `docs/research/embedpdf-stress-test-report.md`.
 *
 * Fixtures are *not* committed (they are up to 26 MB). Generate them with
 * `tests/fixtures/pdf/generate_fixtures.py`, then serve them with the e2e
 * static server so the extension page can fetch them:
 *
 *   node tests/e2e/server.mjs          # serves tests/fixtures/pdf at /pdf/
 *   pnpm build && load .output/chrome-mv3
 *   chrome-extension://<id>/pdf-poc.html?fixtures=http://127.0.0.1:8787/pdf/
 *
 * `?fixtures=` is optional; it defaults to the e2e server above.
 */

type EngineMode = 'worker' | 'direct';
type LayerMode = 'render' | 'tiling';

interface ScenarioSpec {
  id: string;
  label: string;
  file: string;
  /** What the scenario is supposed to prove. */
  note: string;
}

const SCENARIOS: ScenarioSpec[] = [
  {
    id: 'large',
    label: '大文件 120 页',
    file: 'large-120p.pdf',
    note: '>10 MB / 100+ pages, text + per-page raster images',
  },
  {
    id: 'zh',
    label: '中文 PDF',
    file: 'cjk-zh.pdf',
    note: 'Simplified Chinese, embedded Songti subset',
  },
  {
    id: 'ja',
    label: '日文 PDF',
    file: 'cjk-ja.pdf',
    note: 'Japanese, embedded Arial Unicode subset',
  },
  {
    id: 'zh-nofont',
    label: '中文（无嵌入字体）',
    file: 'cjk-zh-nofont.pdf',
    note: 'CID font not embedded → PDFium builtin fallback',
  },
  {
    id: 'ja-nofont',
    label: '日文（无嵌入字体）',
    file: 'cjk-ja-nofont.pdf',
    note: 'CID font not embedded → PDFium builtin fallback',
  },
  {
    id: 'two-column',
    label: '双栏论文',
    file: 'two-column.pdf',
    note: 'two columns, vector chart, raster figure, table',
  },
  {
    id: 'attention',
    label: '真实论文（arXiv, 双栏）',
    file: 'attention.pdf',
    note: 'Attention Is All You Need (arXiv:1706.03762), Type1 fonts, figures',
  },
  {
    id: 'wiki-zh',
    label: '真实中文（维基百科 PDF）',
    file: 'wiki-zh.pdf',
    note: 'zh.wikipedia 漢語, rendered by Wikimedia (embedded fonts, images)',
  },
  {
    id: 'wiki-ja',
    label: '真实日文（维基百科 PDF）',
    file: 'wiki-ja.pdf',
    note: 'ja.wikipedia 日本語, rendered by Wikimedia (embedded fonts, images)',
  },
  {
    id: 'hello',
    label: 'hello.pdf（基线）',
    file: 'hello.pdf',
    note: '1 KB baseline from the first POC',
  },
];

function fixtureBaseUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get('fixtures');
  return fromQuery ?? 'http://127.0.0.1:8787/pdf/';
}

interface FpsSample {
  frames: number;
  avgFps: number;
  minFps: number;
  p95FrameMs: number;
  longFrames: number;
  scrollHeight: number;
  durationMs: number;
  /** Long tasks (>50 ms) observed by PerformanceObserver while scrolling. */
  longTasks: number;
  /** Total blocking time: sum of (long task duration - 50 ms). */
  blockingMs: number;
  /** Page bitmaps present at the end of the scroll (scroll plugin virtualizes). */
  imagesAtEnd: number;
}

interface RunMetrics {
  scenario: string;
  label: string;
  file: string;
  engineMode: EngineMode;
  layerMode: LayerMode;
  fileSizeBytes: number | null;
  pageCount: number | null;
  fetchMs: number | null;
  openMs: number | null;
  firstPaintMs: number | null;
  textMs: number | null;
  textChars: number | null;
  badChars: number | null;
  cjkChars: number | null;
  jsHeapStartMB: number | null;
  jsHeapPeakMB: number | null;
  jsHeapAfterScrollMB: number | null;
  fps: FpsSample | null;
  snippet: string;
  errors: string[];
}

interface PocProbe {
  mode: EngineMode | null;
  engineReady: boolean;
  pluginsReady: boolean;
  documentId: string | null;
  textChunkCount: number;
  plainTextLength: number;
  firstTextSnippet: string;
  errors: string[];
}

declare global {
  interface Window {
    /** Test hook: lets the Playwright/cdp driver read POC state without scraping the DOM. */
    __poc?: PocProbe;
    __pocRuns?: RunMetrics[];
    /** Test hook for the stress harness (same idea, wider surface). */
    __pocStress?: {
      runs: RunMetrics[];
      scrollTest: (durationMs?: number) => Promise<FpsSample | null>;
      runScenario: (
        scenarioId: string,
        options?: { scrollMs?: number }
      ) => Promise<RunMetrics | null>;
      setLayerMode: (mode: LayerMode) => void;
      current: () => RunMetrics | null;
      environment: () => Record<string, unknown>;
    };
  }
}

const probe: PocProbe = {
  mode: null,
  engineReady: false,
  pluginsReady: false,
  documentId: null,
  textChunkCount: 0,
  plainTextLength: 0,
  firstTextSnippet: '',
  errors: [],
};
window.__poc = probe;

const runs: RunMetrics[] = [];
window.__pocRuns = runs;

function recordError(message: string): void {
  probe.errors.push(message);
  console.error('[POC]', message);
}

const MB = 1024 * 1024;

function jsHeapMB(): number | null {
  // `performance.memory` is Chrome-only and non-standard, which is exactly the
  // browser we target. It reports the *JS* heap: PDFium's wasm heap lives
  // outside it, so the Playwright driver also samples the renderer RSS.
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (!memory) return null;
  return Math.round((memory.usedJSHeapSize / MB) * 10) / 10;
}

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** Poll until the first page bitmap has decoded (works for both layer types). */
function waitForFirstPaint(startedAt: number, timeoutMs = 60_000): Promise<number | null> {
  return new Promise((resolve) => {
    const check = () => {
      const image = document.querySelector<HTMLImageElement>('#pdf-viewport img[src^="blob:"]');
      if (image && image.complete && image.naturalWidth > 0) {
        resolve(Math.round(performance.now() - startedAt));
        return;
      }
      if (performance.now() - startedAt > timeoutMs) {
        resolve(null);
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

function App() {
  const [mode, setMode] = useState<EngineMode>('worker');
  const [layerMode, setLayerMode] = useState<LayerMode>('render');
  const [engine, setEngine] = useState<PdfEngine<Blob> | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<PluginRegistry | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [chunks, setChunks] = useState<number | null>(null);
  const [snippet, setSnippet] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<RunMetrics | null>(null);
  const [, forceRuns] = useState(0);
  const [fps, setFps] = useState<FpsSample | null>(null);
  const pendingFile = useRef<{ buffer: ArrayBuffer; name: string } | null>(null);
  // Engine/registry/document refs are read from async callbacks that outlive a
  // render; keeping them in refs avoids stale closures in the test hooks.
  const engineRef = useRef<PdfEngine<Blob> | null>(null);
  const registryRef = useRef<PluginRegistry | null>(null);
  const heapPeak = useRef<number>(0);
  const heapTimer = useRef<number | null>(null);

  const log = useCallback((line: string) => {
    console.log('[POC]', line);
    setLogs((prev) => [...prev.slice(-40), line]);
  }, []);

  // --- engine -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    engineRef.current = null;
    setEngine(null);
    setEngineError(null);
    setRegistry(null);
    setDocumentId(null);
    probe.mode = mode;
    probe.engineReady = false;

    // WXT types `getURL` against a generated union of *tracked* public assets,
    // and `public/pdfium.wasm` is deliberately not checked in; widen the
    // signature instead of adding a 4.4 MB binary to git.
    const wasmUrl = (browser.runtime.getURL as (path: string) => string)('pdfium.wasm');
    const started = performance.now();
    log(`[${mode}] wasm url: ${wasmUrl}`);

    const create = async () => {
      try {
        const created =
          mode === 'worker'
            ? createWorkerEngine(wasmUrl, { fontFallback: null })
            : await createDirectEngine(wasmUrl, { fontFallback: null });
        if (cancelled) {
          void created.destroy?.();
          return;
        }
        probe.engineReady = true;
        engineRef.current = created;
        log(`[${mode}] engine created in ${Math.round(performance.now() - started)} ms`);
        setEngine(created);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordError(`engine (${mode}) failed: ${message}`);
        setEngineError(message);
      }
    };

    void create();

    return () => {
      cancelled = true;
    };
  }, [mode, log]);

  // --- document -----------------------------------------------------------
  const closeOpenDocuments = useCallback(async (target: PluginRegistry) => {
    const capability = target.getPlugin('document-manager')?.provides?.();
    if (!capability) return;
    for (const state of capability.getOpenDocuments()) {
      try {
        await capability.closeDocument(state.id).toPromise();
      } catch (err) {
        log(`closeDocument(${state.id}) failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }, [log]);

  const openPending = useCallback(
    async (target: PluginRegistry, file: { buffer: ArrayBuffer; name: string }) => {
      const dm = target.getPlugin('document-manager');
      const capability = dm?.provides?.();
      if (!capability) {
        recordError('document-manager plugin not registered');
        return;
      }
      await closeOpenDocuments(target);
      const started = performance.now();
      setChunks(null);
      setSnippet('');
      try {
        // `openDocumentBuffer` resolves as soon as the id is allocated; the
        // parse itself is `response.task`. Awaiting both is what makes the
        // timing comparable across fixtures.
        const response = await capability.openDocumentBuffer({
          buffer: file.buffer,
          name: file.name,
        })
          .toPromise();
        await response.task.toPromise();
        probe.documentId = response.documentId;
        setDocumentId(response.documentId);
        log(
          `document opened "${file.name}" (${response.documentId}) in ${Math.round(
            performance.now() - started
          )} ms`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        recordError(`openDocumentBuffer failed: ${message}`);
      }
    },
    [closeOpenDocuments, log]
  );

  useEffect(() => {
    if (!registry) return;
    registryRef.current = registry;
    const file = pendingFile.current;
    if (!file) return;
    pendingFile.current = null;
    void openPending(registry, file);
  }, [registry, openPending]);

  const handleFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const buffer = await file.arrayBuffer();
    log(`file selected: ${file.name} (${(buffer.byteLength / 1024).toFixed(0)} KB)`);
    if (registry) void openPending(registry, { buffer, name: file.name });
    else pendingFile.current = { buffer, name: file.name };
  };

  // --- text extraction ----------------------------------------------------
  const extractText = useCallback(async () => {
    if (!engine || !registry || !documentId) return;
    const dm = registry.getPlugin('document-manager');
    const doc = dm?.provides?.()?.getDocument(documentId) ?? null;
    const page = doc?.pages[0];
    if (!doc || !page) {
      recordError('extractText: no document/page loaded');
      return;
    }
    setBusy(true);
    const started = performance.now();
    try {
      const rects = await engine.getPageTextRects(doc, page).toPromise();
      const plain = await engine.extractText(doc, [0]).toPromise();
      probe.textChunkCount = rects.length;
      probe.plainTextLength = plain.length;
      probe.firstTextSnippet = plain.slice(0, 120);
      setChunks(rects.length);
      setSnippet(plain.slice(0, 300));
      log(
        `text: ${rects.length} rect chunks, ${plain.length} chars in ${Math.round(
          performance.now() - started
        )} ms`
      );
      console.log('[POC] first 5 chunks:', rects.slice(0, 5));
    } catch (err) {
      const message = err instanceof Error ? err.message : JSON.stringify(err);
      recordError(`text extraction failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }, [engine, registry, documentId, log]);

  // Re-extract automatically once the document finishes loading.
  const extractedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!documentId || !engine || !registry) return;
    if (extractedFor.current === documentId) return;
    extractedFor.current = documentId;
    void extractText();
  }, [documentId, engine, registry, extractText]);

  // --- stress harness -----------------------------------------------------
  const startHeapSampling = useCallback(() => {
    heapPeak.current = jsHeapMB() ?? 0;
    if (heapTimer.current !== null) clearInterval(heapTimer.current);
    heapTimer.current = window.setInterval(() => {
      const heap = jsHeapMB();
      if (heap !== null && heap > heapPeak.current) heapPeak.current = heap;
    }, 150);
  }, []);

  const stopHeapSampling = useCallback(() => {
    if (heapTimer.current !== null) {
      clearInterval(heapTimer.current);
      heapTimer.current = null;
    }
  }, []);

  const scrollTest = useCallback(async (durationMs = 4000): Promise<FpsSample | null> => {
    const viewport = document.getElementById('pdf-viewport');
    if (!viewport) {
      recordError('scrollTest: #pdf-viewport missing');
      return null;
    }
    const distance = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (distance === 0) {
      log('scrollTest: nothing to scroll');
    }
    setFps(null);
    const frameTimes: number[] = [];
    const longTaskDurations: number[] = [];
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTaskDurations.push(entry.duration);
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
    let previous = performance.now();
    const startedAt = previous;
    const sample = await new Promise<FpsSample>((resolve) => {
      const step = (now: number) => {
        frameTimes.push(now - previous);
        previous = now;
        const progress = Math.min(1, (now - startedAt) / durationMs);
        viewport.scrollTop = distance * easeInOut(progress);
        if (progress < 1) requestAnimationFrame(step);
        else {
          longTaskObserver.disconnect();
          const sorted = [...frameTimes].sort((a, b) => a - b);
          const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
          const total = frameTimes.reduce((sum, value) => sum + value, 0);
          resolve({
            frames: frameTimes.length,
            avgFps: Math.round((1000 / (total / frameTimes.length)) * 10) / 10,
            minFps: Math.round((1000 / Math.max(...frameTimes)) * 10) / 10,
            p95FrameMs: Math.round(p95 * 10) / 10,
            longFrames: frameTimes.filter((value) => value > 50).length,
            scrollHeight: viewport.scrollHeight,
            durationMs: Math.round(now - startedAt),
            longTasks: longTaskDurations.length,
            blockingMs: Math.round(
              longTaskDurations.reduce((sum, value) => sum + Math.max(0, value - 50), 0)
            ),
            imagesAtEnd: document.querySelectorAll('#pdf-viewport img[src^="blob:"]').length,
          });
        }
      };
      requestAnimationFrame(step);
    });
    setFps(sample);
    log(
      `scroll: ${sample.frames} frames, avg ${sample.avgFps} fps, p95 frame ${sample.p95FrameMs} ms, ` +
        `${sample.longTasks} long tasks (${sample.blockingMs} ms blocking), ${sample.imagesAtEnd} bitmaps live`
    );
    return sample;
  }, [log]);

  const runScenario = useCallback(
    async (scenarioId: string, options?: { scrollMs?: number }): Promise<RunMetrics | null> => {
      const spec = SCENARIOS.find((entry) => entry.id === scenarioId);
      if (!spec) {
        recordError(`unknown scenario: ${scenarioId}`);
        return null;
      }
      const activeRegistry = registryRef.current;
      const dm = activeRegistry?.getPlugin('document-manager')?.provides?.();
      if (!activeRegistry || !dm) {
        recordError('scenario: plugins not ready');
        return null;
      }

      const metrics: RunMetrics = {
        scenario: spec.id,
        label: spec.label,
        file: spec.file,
        engineMode: mode,
        layerMode,
        fileSizeBytes: null,
        pageCount: null,
        fetchMs: null,
        openMs: null,
        firstPaintMs: null,
        textMs: null,
        textChars: null,
        badChars: null,
        cjkChars: null,
        jsHeapStartMB: jsHeapMB(),
        jsHeapPeakMB: null,
        jsHeapAfterScrollMB: null,
        fps: null,
        snippet: '',
        errors: [],
      };
      const fail = (message: string) => {
        metrics.errors.push(message);
        recordError(`${spec.id}: ${message}`);
      };

      setBusy(true);
      setCurrent(metrics);
      startHeapSampling();
      try {
        log(`scenario "${spec.label}" → ${fixtureBaseUrl()}${spec.file}`);
        const fetchStarted = performance.now();
        const response = await fetch(`${fixtureBaseUrl()}${spec.file}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        metrics.fetchMs = Math.round(performance.now() - fetchStarted);
        metrics.fileSizeBytes = buffer.byteLength;
        log(
          `fetched ${(buffer.byteLength / MB).toFixed(2)} MB in ${metrics.fetchMs} ms`
        );

        setFileName(spec.file);
        const openStarted = performance.now();
        await closeOpenDocuments(activeRegistry);
        const openStartedAt = performance.now();
        const opened = await dm
          .openDocumentBuffer({ buffer, name: spec.file })
          .toPromise();
        const doc = await opened.task.toPromise();
        metrics.openMs = Math.round(performance.now() - openStartedAt);
        metrics.pageCount = doc.pages.length;
        probe.documentId = opened.documentId;
        setDocumentId(opened.documentId);
        log(
          `opened ${doc.pages.length} pages in ${metrics.openMs} ms ` +
            `(buffer prep ${Math.round(openStartedAt - openStarted)} ms)`
        );

        metrics.firstPaintMs = await waitForFirstPaint(openStartedAt);
        log(`first page bitmap: ${metrics.firstPaintMs} ms`);

        // --- text extraction (page 1 + middle page) ----------------------
        const activeEngine = engineRef.current;
        if (activeEngine && doc.pages[0]) {
          const textStarted = performance.now();
          const firstPage = await activeEngine.extractText(doc, [0]).toPromise();
          const middleIndex = Math.floor((metrics.pageCount ?? 1) / 2);
          const middlePage =
            middleIndex > 0
              ? await activeEngine.extractText(doc, [middleIndex]).toPromise()
              : '';
          metrics.textMs = Math.round(performance.now() - textStarted);
          const combined = `${firstPage}\n${middlePage}`;
          metrics.textChars = firstPage.length;
          metrics.badChars = countMatches(combined, /\uFFFD/g);
          metrics.cjkChars = countMatches(combined, /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g);
          metrics.snippet = firstPage.slice(0, 200);
          setSnippet(firstPage.slice(0, 300));
          log(
            `text: ${metrics.textChars} chars on page 1 in ${metrics.textMs} ms, ` +
              `${metrics.badChars} replacement chars, ${metrics.cjkChars} CJK glyphs`
          );
        }

        // give the eager render tasks a moment to settle
        await new Promise((resolve) => setTimeout(resolve, 800));

        // --- scroll --------------------------------------------------------
        // scrollMs === 0 means "load only": the driver measures memory at rest
        // first, then drives the scroll itself.
        if (options?.scrollMs !== 0) {
          const sample = await scrollTest(options?.scrollMs ?? 4000);
          metrics.fps = sample;
          metrics.jsHeapAfterScrollMB = jsHeapMB();
        }
        metrics.jsHeapPeakMB = heapPeak.current > 0 ? Math.round(heapPeak.current * 10) / 10 : null;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      } finally {
        stopHeapSampling();
        setBusy(false);
        runs.push(metrics);
        window.__pocRuns = runs;
        forceRuns((value) => value + 1);
      }
      return metrics;
    },
    [closeOpenDocuments, layerMode, log, mode, scrollTest, startHeapSampling, stopHeapSampling]
  );

  useEffect(() => {
    window.__pocStress = {
      runs,
      scrollTest,
      runScenario,
      setLayerMode: (next: LayerMode) => setLayerMode(next),
      current: () => runs[runs.length - 1] ?? null,
      environment: () => ({
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGB: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
        devicePixelRatio: window.devicePixelRatio,
        crossOriginIsolated: window.crossOriginIsolated,
        fixtureBase: fixtureBaseUrl(),
      }),
    };
  }, [closeOpenDocuments, runScenario, scrollTest]);

  const plugins = useMemo(
    () => [
      createPluginRegistration(DocumentManagerPluginPackage, {}),
      createPluginRegistration(ViewportPluginPackage, { viewportGap: 10 }),
      createPluginRegistration(ScrollPluginPackage, { defaultStrategy: ScrollStrategy.Vertical }),
      createPluginRegistration(InteractionManagerPluginPackage),
      createPluginRegistration(RenderPluginPackage),
      createPluginRegistration(TilingPluginPackage, { tileSize: 768 }),
    ],
    []
  );

  const engineFailed = engineError !== null;

  return (
    <div style="display:flex;flex-direction:column;height:100%">
      <div style="padding:6px 8px;background:#f0f0f0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #ccc;font:12px system-ui,sans-serif">
        <strong>EmbedPDF v2 stress</strong>
        <label>
          engine{' '}
          <select
            value={mode}
            onChange={(e) => setMode((e.currentTarget as HTMLSelectElement).value as EngineMode)}
          >
            <option value="worker">worker (blob)</option>
            <option value="direct">direct (main thread)</option>
          </select>
        </label>
        <label>
          layer{' '}
          <select
            value={layerMode}
            onChange={(e) =>
              setLayerMode((e.currentTarget as HTMLSelectElement).value as LayerMode)
            }
          >
            <option value="render">RenderLayer</option>
            <option value="tiling">TilingLayer (768px tiles)</option>
          </select>
        </label>
        <span style="color:#666">{engine ? 'engine ready' : 'engine…'}</span>
        {engineFailed ? <span style="color:#b00">{engineError}</span> : null}
        {fileName ? <span style="color:#444">{fileName}</span> : null}
        <input type="file" accept="application/pdf,.pdf" onChange={handleFile} />
        <button type="button" disabled={!documentId || busy} onClick={() => void extractText()}>
          {busy ? 'extracting…' : 'Extract text (page 1)'}
        </button>
        <button type="button" disabled={!documentId || busy} onClick={() => void scrollTest()}>
          Scroll FPS test
        </button>
        {chunks !== null ? <span>{chunks} text chunks</span> : null}
        {fps ? (
          <span>
            {fps.avgFps} fps avg · {fps.p95FrameMs} ms p95 · {fps.longFrames} long
          </span>
        ) : null}
      </div>

      <div style="padding:6px 8px;background:#fafafa;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #ddd;font:11px system-ui,sans-serif">
        <span style="color:#666">scenarios:</span>
        {SCENARIOS.map((spec) => (
          <button
            key={spec.id}
            type="button"
            title={spec.note}
            disabled={busy}
            onClick={() => void runScenario(spec.id)}
          >
            {spec.label}
          </button>
        ))}
        <span style="color:#999">
          fixtures: {fixtureBaseUrl()} (needs `node tests/e2e/server.mjs`)
        </span>
      </div>

      <div style="flex:1;display:flex;min-height:0">
        <div style="flex:1;min-width:0;position:relative;background:#525659">
          {engine ? (
            <EmbedPDF
              engine={engine}
              plugins={plugins}
              onInitialized={async (ready) => {
                log('plugins initialized');
                probe.pluginsReady = true;
                setRegistry(ready);
              }}
            >
              {({ pluginsReady, activeDocumentId }) => {
                if (!pluginsReady) {
                  return <div style="padding:20px;color:#ddd">Initializing plugins…</div>;
                }
                if (!activeDocumentId) {
                  return <div style="padding:20px;color:#ddd">Please select a PDF file</div>;
                }
                return (
                  <DocumentContent documentId={activeDocumentId}>
                    {({ isLoaded, isError }) => {
                      if (isError) return <div style="padding:20px;color:#f99">Document error</div>;
                      if (!isLoaded) return <div style="padding:20px;color:#ddd">Loading PDF…</div>;
                      return (
                        <GlobalPointerProvider documentId={activeDocumentId}>
                          <Viewport
                            id="pdf-viewport"
                            documentId={activeDocumentId}
                            style="position:absolute;inset:0;overflow:auto"
                          >
                            <Scroller
                              documentId={activeDocumentId}
                              renderPage={({ pageIndex }) => (
                                <PagePointerProvider
                                  documentId={activeDocumentId}
                                  pageIndex={pageIndex}
                                >
                                  {layerMode === 'tiling' ? (
                                    <TilingLayer
                                      documentId={activeDocumentId}
                                      pageIndex={pageIndex}
                                    />
                                  ) : (
                                    <RenderLayer
                                      documentId={activeDocumentId}
                                      pageIndex={pageIndex}
                                    />
                                  )}
                                </PagePointerProvider>
                              )}
                            />
                          </Viewport>
                        </GlobalPointerProvider>
                      );
                    }}
                  </DocumentContent>
                );
              }}
            </EmbedPDF>
          ) : (
            <div style="padding:20px;color:#ddd">Creating engine…</div>
          )}
        </div>

        <div style="width:380px;flex-shrink:0;background:#1e1e1e;color:#ddd;padding:8px;overflow:auto;font:11px/1.5 ui-monospace,monospace">
          <div style="color:#8fd">metrics</div>
          {current ? (
            <table style="border-collapse:collapse;width:100%">
              <tbody>
                {[
                  ['file', `${current.file}`],
                  ['size', current.fileSizeBytes ? `${(current.fileSizeBytes / MB).toFixed(2)} MB` : '—'],
                  ['pages', current.pageCount ?? '—'],
                  ['engine / layer', `${current.engineMode} / ${current.layerMode}`],
                  ['fetch', current.fetchMs !== null ? `${current.fetchMs} ms` : '—'],
                  ['open', current.openMs !== null ? `${current.openMs} ms` : '—'],
                  ['first paint', current.firstPaintMs !== null ? `${current.firstPaintMs} ms` : '—'],
                  ['text extract', current.textMs !== null ? `${current.textMs} ms` : '—'],
                  ['chars (p1)', current.textChars ?? '—'],
                  ['replacement chars', current.badChars ?? '—'],
                  ['CJK glyphs', current.cjkChars ?? '—'],
                  ['JS heap start', current.jsHeapStartMB !== null ? `${current.jsHeapStartMB} MB` : '—'],
                  ['JS heap peak', current.jsHeapPeakMB !== null ? `${current.jsHeapPeakMB} MB` : '—'],
                  ['JS heap after scroll', current.jsHeapAfterScrollMB !== null ? `${current.jsHeapAfterScrollMB} MB` : '—'],
                  ['scroll avg fps', current.fps ? `${current.fps.avgFps} (${current.fps.frames} frames)` : '—'],
                  ['scroll p95 frame', current.fps ? `${current.fps.p95FrameMs} ms` : '—'],
                  ['scroll long frames', current.fps ? `${current.fps.longFrames}` : '—'],
                  [
                    'long tasks / blocking',
                    current.fps ? `${current.fps.longTasks} / ${current.fps.blockingMs} ms` : '—',
                  ],
                  ['bitmaps live at scroll end', current.fps ? `${current.fps.imagesAtEnd}` : '—'],
                ].map(([key, value]) => (
                  <tr key={key}>
                    <td style="color:#8fd;padding-right:8px;vertical-align:top">{key}</td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style="color:#888">no run yet</div>
          )}
          {current?.errors.length ? (
            <>
              <div style="color:#f88;margin-top:8px">errors</div>
              {current.errors.map((line, index) => (
                <div key={index} style="color:#f99;white-space:pre-wrap">
                  {line}
                </div>
              ))}
            </>
          ) : null}
          {current?.snippet ? (
            <>
              <div style="color:#8fd;margin-top:8px">first 200 chars (page 1)</div>
              <div style="white-space:pre-wrap">{current.snippet}</div>
            </>
          ) : snippet ? (
            <>
              <div style="color:#8fd;margin-top:8px">first page text</div>
              <div style="white-space:pre-wrap">{snippet}</div>
            </>
          ) : null}
          <div style="color:#8fd;margin-top:10px">all runs ({runs.length})</div>
          <table style="border-collapse:collapse;width:100%;font-size:10px">
            <thead>
              <tr style="color:#8fd">
                <th align="left">file</th>
                <th align="right">open</th>
                <th align="right">paint</th>
                <th align="right">heap</th>
                <th align="right">fps</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, index) => (
                <tr key={index}>
                  <td>
                    {run.file}
                    <span style="color:#888">/{run.layerMode}</span>
                  </td>
                  <td align="right">{run.openMs ?? '—'}</td>
                  <td align="right">{run.firstPaintMs ?? '—'}</td>
                  <td align="right">{run.jsHeapPeakMB ?? '—'}</td>
                  <td align="right">{run.fps?.avgFps ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style="color:#8fd;margin-top:10px">log</div>
          {logs.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
