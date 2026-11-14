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
import type { PdfBookmarkObject, PdfPageObject, PdfTextRectObject } from '@embedpdf/models';
import { calculateDegree } from '@embedpdf/models';
import { BookmarkPluginPackage, useBookmarkCapability } from '@embedpdf/plugin-bookmark/preact';
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
import {
  Scroller,
  ScrollPluginPackage,
  ScrollStrategy,
  useScroll,
} from '@embedpdf/plugin-scroll/preact';
import { SearchLayer, SearchPluginPackage, useSearch } from '@embedpdf/plugin-search/preact';
import {
  ThumbImg,
  ThumbnailPluginPackage,
  ThumbnailsPane,
} from '@embedpdf/plugin-thumbnail/preact';
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/preact';
import { useZoom, ZoomMode, ZoomPluginPackage } from '@embedpdf/plugin-zoom/preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { buildEmbedBlocks, type EmbedBlock } from '~/lib/pdf/embed/blocks';
import { type EmbedEngine, pageTextRects } from '~/lib/pdf/embed/document';

/** What the page's chrome needs from the embedding tree. */
export interface ViewerApi {
  zoomIn(): void;
  zoomOut(): void;
  /** Fit the page width to the viewport (`0` in the keyboard shortcuts). */
  fitWidth(): void;
  nextPage(): void;
  previousPage(): void;
  goToPage(page: number): void;
  /** Run a full-text search; an empty query clears the highlights. */
  search(query: string): void;
  nextMatch(): void;
  previousMatch(): void;
  /** Close the search session and drop its highlights. */
  stopSearch(): void;
}

/** The live result count the search toolbar shows. */
export interface ViewerSearchState {
  /** 0-based index of the current match, or -1 when there is none. */
  active: number;
  total: number;
  loading: boolean;
}

export interface ViewerProps {
  engine: EmbedEngine;
  /** Whether the thumbnail/outline sidebar is on screen. */
  sidebarOpen: boolean;
  /** Sidebar tab names, supplied by the page so this file carries no copy. */
  sidebarLabels: SidebarLabels;
  /** Called once when the plugin registry is ready, and null when it goes away. */
  onRegistry: (registry: PluginRegistry | null) => void;
  /** Viewer controls, as soon as the plugins are available for a document. */
  onApi: (api: ViewerApi | null) => void;
  /** Current zoom factor, for the percentage in the viewer's toolbar. */
  onScale: (scale: number) => void;
  /** Current page (1-based) and the page count, for the page navigation field. */
  onPage: (page: number, total: number) => void;
  /** Search progress, for the match counter in the search bar. */
  onSearch: (state: ViewerSearchState) => void;
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
  const searchLayerRef = useRef<HTMLDivElement>(null);
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

    // The text and the search layer share PDFium's own coordinate space (top
    // left, y down), so they are laid out and rotated together.
    applyPageTransform(layer, page, scale);
    if (searchLayerRef.current) applyPageTransform(searchLayerRef.current, page, scale);

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
        {/* The search plugin paints its own rectangles in PDF points; the
            wrapper gives it the page's scale and rotation. */}
        <div class="pdf-search-layer" ref={searchLayerRef}>
          <SearchLayer documentId={documentId} pageIndex={layout.pageIndex} scale={scale} />
        </div>
      </div>
    </>
  );
}

/**
 * Bridges the plugins to the viewer's own chrome.
 *
 * Headless on purpose: the toolbar, the search bar and the page field live in
 * `#pdf-chrome`, outside EmbedPDF's tree, so the capabilities are pushed out
 * through callbacks rather than pulled in through render props.
 */
function ViewerController({
  documentId,
  onApi,
  onScale,
  onPage,
  onSearch,
}: {
  documentId: string;
  onApi: ViewerProps['onApi'];
  onScale: ViewerProps['onScale'];
  onPage: ViewerProps['onPage'];
  onSearch: ViewerProps['onSearch'];
}) {
  const zoom = useZoom(documentId);
  const scroll = useScroll(documentId);
  const search = useSearch(documentId);

  const zoomScope = zoom.provides;
  const scrollScope = scroll.provides;
  const searchScope = search.provides;

  useEffect(() => {
    if (!zoomScope || !scrollScope || !searchScope) {
      onApi(null);
      return;
    }
    onApi({
      zoomIn: () => zoomScope.zoomIn(),
      zoomOut: () => zoomScope.zoomOut(),
      fitWidth: () => zoomScope.requestZoom(ZoomMode.FitWidth),
      nextPage: () => scrollScope.scrollToNextPage('smooth'),
      previousPage: () => scrollScope.scrollToPreviousPage('smooth'),
      goToPage: (page: number) =>
        scrollScope.scrollToPage({
          pageNumber: Math.min(Math.max(page, 1), scrollScope.getTotalPages()),
          behavior: 'smooth',
        }),
      search: (query: string) => {
        void searchScope.searchAllPages(query);
      },
      nextMatch: () => {
        searchScope.nextResult();
      },
      previousMatch: () => {
        searchScope.previousResult();
      },
      stopSearch: () => searchScope.stopSearch(),
    });
    return () => onApi(null);
  }, [zoomScope, scrollScope, searchScope, onApi]);

  useEffect(() => {
    onScale(zoom.state.currentZoomLevel);
  }, [zoom.state.currentZoomLevel, onScale]);

  useEffect(() => {
    onPage(scroll.state.currentPage, scroll.state.totalPages);
  }, [scroll.state.currentPage, scroll.state.totalPages, onPage]);

  useEffect(() => {
    onSearch({
      active: search.state.activeResultIndex,
      total: search.state.total,
      loading: search.state.loading,
    });
  }, [search.state.activeResultIndex, search.state.total, search.state.loading, onSearch]);

  // The search plugin moves the active match but does not scroll; following
  // the active index is what makes "next result" land on screen.
  useEffect(() => {
    if (!searchScope || !scrollScope) return;
    return searchScope.onActiveResultChange((index) => {
      const result = searchScope.getState().results[index];
      if (!result) return;
      scrollScope.scrollToPage({ pageNumber: result.pageIndex + 1, behavior: 'smooth' });
    });
  }, [searchScope, scrollScope]);

  return null;
}

/** The labels the sidebar needs, kept in the page so this file stays text-free. */
export interface SidebarLabels {
  pages: string;
  contents: string;
  empty: string;
}

/** The thumbnail/outline rail to the left of the pages. */
function PdfSidebar({ documentId, labels }: { documentId: string; labels: SidebarLabels }) {
  const [tab, setTab] = useState<'pages' | 'contents'>('pages');
  const scroll = useScroll(documentId);
  const currentPage = scroll.state.currentPage;

  const goTo = (pageNumber: number): void => {
    scroll.provides?.scrollToPage({ pageNumber, behavior: 'smooth' });
  };

  return (
    <aside class="pdf-sidebar">
      <div class="pdf-sidebar-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pages'}
          onClick={() => setTab('pages')}
        >
          {labels.pages}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'contents'}
          onClick={() => setTab('contents')}
        >
          {labels.contents}
        </button>
      </div>
      {tab === 'pages' ? (
        <ThumbnailsPane documentId={documentId} class="pdf-thumbs-pane">
          {(meta) => (
            <div
              class="pdf-thumb"
              style={{ top: `${meta.top}px`, height: `${meta.wrapperHeight}px` }}
            >
              <button
                type="button"
                class={meta.pageIndex + 1 === currentPage ? 'pdf-thumb-current' : ''}
                aria-current={meta.pageIndex + 1 === currentPage ? 'page' : undefined}
                onClick={() => goTo(meta.pageIndex + 1)}
              >
                <ThumbImg
                  documentId={documentId}
                  meta={meta}
                  class="pdf-thumb-image"
                  style={{ width: `${meta.width}px`, height: `${meta.height}px` }}
                />
                <span class="pdf-thumb-label">{meta.pageIndex + 1}</span>
              </button>
            </div>
          )}
        </ThumbnailsPane>
      ) : (
        <PdfOutline documentId={documentId} emptyLabel={labels.empty} onGo={goTo} />
      )}
    </aside>
  );
}

/** The PDF's own table of contents, as a tree of jump targets. */
function PdfOutline({
  documentId,
  emptyLabel,
  onGo,
}: {
  documentId: string;
  emptyLabel: string;
  onGo: (pageNumber: number) => void;
}) {
  const { provides } = useBookmarkCapability();
  const [items, setItems] = useState<PdfBookmarkObject[] | null>(null);

  useEffect(() => {
    if (!provides) {
      setItems(null);
      return;
    }
    let cancelled = false;
    setItems(null);
    try {
      provides
        .forDocument(documentId)
        .getBookmarks()
        .toPromise()
        .then((result) => {
          if (!cancelled) setItems(result.bookmarks);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          console.warn('[SayLoud] cannot read the pdf outline', error);
          setItems([]);
        });
    } catch (error) {
      console.warn('[SayLoud] cannot read the pdf outline', error);
      setItems([]);
    }
    return () => {
      cancelled = true;
    };
  }, [provides, documentId]);

  return (
    <div class="pdf-outline">
      {items === null ? null : items.length === 0 ? (
        <p class="pdf-outline-empty">{emptyLabel}</p>
      ) : (
        <OutlineList items={items} onGo={onGo} />
      )}
    </div>
  );
}

function OutlineList({
  items,
  onGo,
}: {
  items: readonly PdfBookmarkObject[];
  onGo: (pageNumber: number) => void;
}) {
  return (
    <ul>
      {items.map((item, index) => {
        const page =
          item.target?.type === 'destination' ? item.target.destination.pageIndex + 1 : null;
        return (
          <li key={`${index}-${item.title}`}>
            <button
              type="button"
              disabled={page === null}
              onClick={() => {
                if (page !== null) onGo(page);
              }}
            >
              {item.title}
            </button>
            {item.children && item.children.length > 0 && (
              <OutlineList items={item.children} onGo={onGo} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PdfViewer({
  engine,
  sidebarOpen,
  onRegistry,
  onApi,
  onScale,
  onPage,
  onSearch,
  onPageBlocks,
  sidebarLabels,
}: ViewerProps) {
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
      createPluginRegistration(RenderPluginPackage, { withAnnotations: true }),
      createPluginRegistration(SearchPluginPackage, { showAllResults: true }),
      createPluginRegistration(ThumbnailPluginPackage, {
        width: 120,
        gap: 8,
        labelHeight: 16,
        paddingY: 8,
        autoScroll: true,
      }),
      createPluginRegistration(BookmarkPluginPackage),
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
                  <div class="pdf-viewer-root">
                    {sidebarOpen && (
                      <PdfSidebar documentId={activeDocumentId} labels={sidebarLabels} />
                    )}
                    <div class="pdf-viewer-main">
                      <ViewerController
                        documentId={activeDocumentId}
                        onApi={onApi}
                        onScale={onScale}
                        onPage={onPage}
                        onSearch={onSearch}
                      />
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
                    </div>
                  </div>
                </GlobalPointerProvider>
              );
            }}
          </DocumentContent>
        );
      }}
    </EmbedPDF>
  );
}
