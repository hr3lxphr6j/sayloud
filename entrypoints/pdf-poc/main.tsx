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
import { TilingPluginPackage } from '@embedpdf/plugin-tiling/preact';
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/preact';
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

type EngineMode = 'worker' | 'direct';

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

function recordError(message: string): void {
  probe.errors.push(message);
  console.error('[POC]', message);
}

function App() {
  const [mode, setMode] = useState<EngineMode>('worker');
  const [engine, setEngine] = useState<PdfEngine<Blob> | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<PluginRegistry | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [chunks, setChunks] = useState<number | null>(null);
  const [snippet, setSnippet] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const pendingFile = useRef<{ buffer: ArrayBuffer; name: string } | null>(null);

  const log = useCallback((line: string) => {
    console.log('[POC]', line);
    setLogs((prev) => [...prev.slice(-13), line]);
  }, []);

  // --- engine -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
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
  const openPending = useCallback(
    async (target: PluginRegistry, file: { buffer: ArrayBuffer; name: string }) => {
      const dm = target.getPlugin('document-manager');
      const capability = dm?.provides?.();
      if (!capability) {
        recordError('document-manager plugin not registered');
        return;
      }
      const started = performance.now();
      try {
        const response = await capability
          .openDocumentBuffer({ buffer: file.buffer, name: file.name })
          .toPromise();
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
    [log]
  );

  useEffect(() => {
    if (!registry) return;
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
      <div style="padding:8px;background:#f0f0f0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #ccc">
        <strong>EmbedPDF v2 POC</strong>
        <label>
          engine:{' '}
          <select
            value={mode}
            onChange={(e) => setMode((e.currentTarget as HTMLSelectElement).value as EngineMode)}
          >
            <option value="worker">worker (blob)</option>
            <option value="direct">direct (main thread)</option>
          </select>
        </label>
        <input type="file" accept="application/pdf,.pdf" onChange={handleFile} />
        <span>
          {engine ? 'engine ready' : 'engine…'}
          {engineFailed ? ` — ${engineError}` : ''}
        </span>
        {fileName ? <span>{fileName}</span> : null}
        <button type="button" disabled={!documentId || busy} onClick={() => void extractText()}>
          {busy ? 'extracting…' : 'Extract text (page 1)'}
        </button>
        {chunks !== null ? <span>{chunks} text chunks</span> : null}
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
                                  <RenderLayer
                                    documentId={activeDocumentId}
                                    pageIndex={pageIndex}
                                  />
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

        <div style="width:340px;flex-shrink:0;background:#1e1e1e;color:#ddd;padding:8px;overflow:auto;font:11px/1.5 ui-monospace,monospace">
          <div style="color:#8fd">log</div>
          {logs.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
          {snippet ? (
            <>
              <div style="color:#8fd;margin-top:8px">first page text</div>
              <div style="white-space:pre-wrap">{snippet}</div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
