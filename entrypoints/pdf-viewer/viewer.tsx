/**
 * The EmbedPDF tree the PDF viewer page mounts.
 *
 * This file owns everything that must live *inside* EmbedPDF's context
 * providers: the plugin registrations, the viewport/scroller, and the
 * transparent text layer that gives each page real DOM text. Everything about
 * reading — the reading document, the reader panel, the sentence list — stays
 * in `main.tsx`, because it must outlive a document being closed or replaced.
 *
 * The text layer is the load-bearing part. `RenderLayer` paints the page as an
 * `<img>`, so there are no text nodes for `Block.rangeFor` to return a range
 * over, for the browser to select, or for `CSS.highlights` to paint. The layer
 * below covers the page with one transparent span per PDFium text rectangle
 * and hands the resulting blocks to `main.tsx`, which builds the reading
 * document from them exactly as it did for the pdf.js viewer.
 */

import { createPluginRegistration, type PluginRegistry } from '@embedpdf/core';
import { EmbedPDF, useDocumentState } from '@embedpdf/core/preact';
import type { PdfPageObject, PdfTextRectObject } from '@embedpdf/models';
import { calculateDegree } from '@embedpdf/models';
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
import type { PageLayout } from '@embedpdf/plugin-scroll';
import { Scroller, ScrollPluginPackage, ScrollStrategy } from '@embedpdf/plugin-scroll/preact';
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/preact';
import { useZoom, ZoomMode, ZoomPluginPackage } from '@embedpdf/plugin-zoom/preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildEmbedBlocks, type EmbedBlock } from '~/lib/pdf/embed/blocks';
import { type EmbedEngine, pageTextRects } from '~/lib/pdf/embed/document';

/** What the page's chrome needs from the embedding tree. */
export interface ViewerApi {
  zoomIn(): void;
  zoomOut(): void;
}

export interface ViewerProps {
  engine: EmbedEngine;
  /** Called once when the plugin registry is ready, and null when it goes away. */
  onRegistry: (registry: PluginRegistry | null) => void;
  /** Zoom controls, as soon as the zoom plugin is available for a document. */
  onApi: (api: ViewerApi | null) => void;
  /** Current zoom factor, for the percentage in the viewer's toolbar. */
  onScale: (scale: number) => void;
  /**
   * One page finished extracting its text.
   *
   * `layer` is the text-layer element the spans live in; the viewer creates its
   * highlight layer over it and rebuilds the reading document from `blocks`.
   */
  onPageBlocks: (
    documentId: string,
    pageIndex: number,
    blocks: EmbedBlock[],
    layer: HTMLElement
  ) => void;
}

/** Page width after applying `/Rotate`, which is what the layout uses. */
function rotatedWidth(page: PdfPageObject): number {
  return calculateDegree(page.rotation) % 180 === 0 ? page.size.width : page.size.height;
}

/**
 * Place and orient the text layer over the rendered page.
 *
 * PDFium's text rectangles are in the page's *unrotated* space, while the
 * layout box is the rotated size. Rotating the layer itself (rather than each
 * span) keeps the span coordinates naive and, more importantly, keeps the
 * highlight layer — which is a child of this element — in the same space.
 */
function applyPageTransform(layer: HTMLElement, page: PdfPageObject, scale: number): void {
  const width = page.size.width * scale;
  const height = page.size.height * scale;
  layer.style.width = `${width}px`;
  layer.style.height = `${height}px`;
  layer.style.transformOrigin = '0 0';

  switch (calculateDegree(page.rotation)) {
    case 90:
      // (x, y) → (height - y, x) in a box of `height` × `width`.
      layer.style.transform = `translateX(${height}px) rotate(90deg)`;
      break;
    case 180:
      layer.style.transform = `translate(${width}px, ${height}px) rotate(180deg)`;
      break;
    case 270:
      // (x, y) → (y, width - x) in a box of `height` × `width`.
      layer.style.transform = `translateY(${width}px) rotate(-90deg)`;
      break;
    default:
      layer.style.transform = '';
      break;
  }
}

interface PageTextLayerProps {
  documentId: string;
  layout: PageLayout;
  engine: EmbedEngine;
  onPageBlocks: ViewerProps['onPageBlocks'];
}

/**
 * One page: the raster, its transparent text, and nothing else.
 *
 * `layout` carries the page's box at the document's current scale, which is
 * how the text layer learns the zoom without subscribing to it. A zoom changes
 * `layout.width`, the effect below re-runs and re-lays the same cached
 * rectangles out at the new scale.
 */
function PageTextLayer({ documentId, layout, engine, onPageBlocks }: PageTextLayerProps) {
  const documentState = useDocumentState(documentId);
  const doc = documentState?.document ?? null;
  const page = doc?.pages[layout.pageIndex] ?? null;

  const layerRef = useRef<HTMLDivElement>(null);
  const pageElRef = useRef<HTMLDivElement>(null);
  const [rasterVisible, setRasterVisible] = useState(false);

  const scale = page ? layout.rotatedWidth / Math.max(rotatedWidth(page), 1) : 1;

  // The raster is the expensive half of a page: a decoded bitmap per page is
  // hundreds of megabytes on a long document. Text, on the other hand, has to
  // exist for every page up front (the reader spends its sentences), so the
  // pages stay mounted and only their images are windowed here. One viewport
  // of margin in each direction keeps scrolling from showing an empty page.
  useEffect(() => {
    const element = pageElRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setRasterVisible(entry.isIntersecting);
      },
      { rootMargin: '100% 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!doc || !page || !layer) return;

    let cancelled = false;
    void pageTextRects(engine, doc, layout.pageIndex)
      .then((rects: PdfTextRectObject[]) => {
        if (cancelled || !layerRef.current) return;
        const target = layerRef.current;
        // A zoom keeps the same rectangles and rebuilds only the spans; the
        // old ones are detached so the blocks built from them are replaced in
        // the same turn (see `onPageBlocks`).
        target.replaceChildren();
        const blocks = buildEmbedBlocks(
          rects,
          { textLayer: target, pageEl: pageElRef.current ?? target },
          scale
        );
        for (const block of blocks) block.pageIndex = layout.pageIndex;
        applyPageTransform(target, page, scale);
        onPageBlocks(documentId, layout.pageIndex, blocks, target);
      })
      .catch((error: unknown) => {
        console.error('[SayLoud] cannot read the text of a pdf page', error);
      });

    return () => {
      cancelled = true;
    };
  }, [doc, page, engine, documentId, layout.pageIndex, scale, onPageBlocks]);

  return (
    <>
      {rasterVisible && (
        <RenderLayer class="pdf-page-raster" documentId={documentId} pageIndex={layout.pageIndex} />
      )}
      <div class="pdf-page-layer" ref={pageElRef}>
        <div class="pdf-text-layer" ref={layerRef} />
      </div>
    </>
  );
}

/**
 * Bridges the zoom plugin to the viewer's own toolbar.
 *
 * Headless on purpose: the buttons live in `#pdf-chrome`, outside EmbedPDF's
 * tree, so the capability is pushed out through callbacks rather than pulled
 * in through a render prop.
 */
function ZoomBridge({
  documentId,
  onApi,
  onScale,
}: {
  documentId: string;
  onApi: ViewerProps['onApi'];
  onScale: ViewerProps['onScale'];
}) {
  const { state, provides } = useZoom(documentId);

  useEffect(() => {
    if (!provides) {
      onApi(null);
      return;
    }
    onApi({ zoomIn: () => provides.zoomIn(), zoomOut: () => provides.zoomOut() });
    return () => onApi(null);
  }, [provides, onApi]);

  useEffect(() => {
    onScale(state.currentZoomLevel);
  }, [state.currentZoomLevel, onScale]);

  return null;
}

export function PdfViewer({ engine, onRegistry, onApi, onScale, onPageBlocks }: ViewerProps) {
  const plugins = useMemo(
    () => [
      createPluginRegistration(DocumentManagerPluginPackage, {}),
      createPluginRegistration(ViewportPluginPackage, { viewportGap: 10 }),
      createPluginRegistration(ScrollPluginPackage, {
        defaultStrategy: ScrollStrategy.Vertical,
        // Every page is mounted, not just the pages around the viewport.
        //
        // The scroll plugin only renders items within `bufferSize` pages of the
        // viewport, and an unmounted page has no text layer — which would mean
        // the reader could only ever see the first few pages of a long PDF,
        // while the audio still needs the whole document. Rendering the *text*
        // of every page is cheap and is what the pdf.js viewer did too; the
        // bitmaps are windowed separately by `PageTextLayer`'s IntersectionObserver.
        defaultBufferSize: Number.MAX_SAFE_INTEGER,
      }),
      createPluginRegistration(InteractionManagerPluginPackage),
      createPluginRegistration(RenderPluginPackage),
      createPluginRegistration(ZoomPluginPackage, {
        // Fit-width, not a fixed 1×. The zoom plugin gates the viewport until
        // its first request, and it only makes that request itself for an
        // automatic level: a numeric default leaves the viewport empty forever
        // (the scroll plugin never gets a layout, so no page mounts). Fit-width
        // also reads better on a wide window than a 612 pt page in a 1280 px
        // one, and the toolbar still zooms in and out from there.
        defaultZoomLevel: ZoomMode.FitWidth,
        minZoom: 0.25,
        maxZoom: 4,
      }),
    ],
    []
  );

  const initialized = useCallback(
    async (registry: PluginRegistry) => {
      onRegistry(registry);
    },
    [onRegistry]
  );

  return (
    <EmbedPDF engine={engine} plugins={plugins} onInitialized={initialized}>
      {({ pluginsReady, activeDocumentId }) => {
        if (!pluginsReady || !activeDocumentId) return null;
        return (
          <DocumentContent documentId={activeDocumentId}>
            {({ isLoaded, isError }) => {
              if (isError || !isLoaded) return null;
              return (
                <GlobalPointerProvider documentId={activeDocumentId}>
                  <ZoomBridge documentId={activeDocumentId} onApi={onApi} onScale={onScale} />
                  <Viewport
                    id="pdf-viewport"
                    documentId={activeDocumentId}
                    style="position:absolute;inset:0;overflow:auto"
                  >
                    <Scroller
                      documentId={activeDocumentId}
                      renderPage={(layout) => (
                        <PagePointerProvider
                          documentId={activeDocumentId}
                          pageIndex={layout.pageIndex}
                        >
                          <PageTextLayer
                            documentId={activeDocumentId}
                            layout={layout}
                            engine={engine}
                            onPageBlocks={onPageBlocks}
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
  );
}
