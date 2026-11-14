/**
 * The PDF viewer page.
 *
 * A page of its own rather than a content script: the extension already has a
 * reading bar that talks to the engine, and this page only has to hand it a
 * document. Rendering is EmbedPDF/PDFium (`viewer.tsx`), and this file is the
 * shell around it: the toolbar, the file picker, the password prompt, and the
 * reader that reads the page's text aloud.
 *
 * Reading a whole PDF up front would make the first sentence wait for the last
 * page, so each page's text is handed over as soon as PDFium has extracted it,
 * and the reading document grows in page order. Because the engine has already
 * been given the first pages, an append is followed by another `load` with
 * `resume: true`: the growing list replaces the one the engine has, at the
 * sentence being read, without starting to speak. Sentence texts never change;
 * if a rebuild would change one, the append is abandoned and the old document
 * is kept.
 */

import type { PluginRegistry } from '@embedpdf/core';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { ReaderController } from '~/entrypoints/reader.content/ReaderController';
import { ReaderPanel } from '~/entrypoints/reader.content/ReaderPanel';
import type { Block } from '~/lib/extractor';
import { I18nProvider, type Lang, resolveLang, useT, useUiLanguage } from '~/lib/i18n';
import type { EmbedBlock } from '~/lib/pdf/embed/blocks';
import {
  closePdfDocuments,
  createPdfEngine,
  type EmbedEngine,
  EmbedOpenError,
  isPasswordError,
  MAX_PASSWORD_ATTEMPTS,
  type OpenedDocument,
  openPdfDocument,
  retryPdfDocument,
} from '~/lib/pdf/embed/document';
import { EmbedHighlightLayer } from '~/lib/pdf/embed/highlight';
import { buildReadingDoc, type ReadingDoc, type ReadingSentence } from '~/lib/reading-doc';
import { DEFAULT_SETTINGS, SettingsStore, type UiLang } from '~/lib/settings-store';
import '~/entrypoints/reader.content/styles.css';
import { appendSync } from './sync';
import { PdfViewer, type SidebarLabels, type ViewerApi, type ViewerSearchState } from './viewer';

/** How long a hash id gets to be answered before it is called missing. */
const MISSING_TIMEOUT_MS = 2_000;
/** Debounce between a keystroke in the search bar and the PDFium scan. */
const SEARCH_DEBOUNCE_MS = 180;

/** The page's root elements, all of which the HTML provides. */
const chromeEl = element('pdf-chrome');
const pagesEl = element('pdf-pages');
const host = element('sayloud-host');

const settings = new SettingsStore(browser.storage.local, browser.storage.onChanged);

/** What the strip above the pages is saying right now. */
type Notice = 'opening' | 'pick' | 'missing' | 'empty' | 'ready';

interface SearchUiState {
  open: boolean;
  /** What the reader typed; the plugin's own query lags behind the debounce. */
  query: string;
  /** 0-based index of the current match, or -1 when there is none. */
  active: number;
  total: number;
  loading: boolean;
}

interface ChromeState {
  notice: Notice;
  /** Current zoom factor, from EmbedPDF's zoom plugin. */
  zoom: number;
  /** Non-null while a password is being asked for; `wrong` after a rejection. */
  password: { wrong: boolean } | null;
  /** Whether a document is open, which is what the zoom control needs to know. */
  open: boolean;
  /** Current page (1-based) and the page count, from the scroll plugin. */
  page: number;
  total: number;
  /** Whether the thumbnail/outline rail is visible. */
  sidebar: boolean;
  search: SearchUiState;
}

let chrome: ChromeState = {
  notice: 'pick',
  zoom: 1,
  password: null,
  open: false,
  page: 1,
  total: 0,
  sidebar: false,
  search: { open: false, query: '', active: -1, total: 0, loading: false },
};

/** The zoom/paging/search controls, once the embedding tree has a document. */
let viewerApi: ViewerApi | null = null;
/** The open document's own bytes, kept for the download button. */
let documentBytes: ArrayBuffer | null = null;
let documentName = 'document.pdf';
/** The pending debounced search, so a fast typist only runs the last one. */
let searchTimer: number | null = null;

let passwordResolve: ((value: string | null) => void) | null = null;
let passwordAttempts = 0;

let engine: EmbedEngine | null = null;
let enginePromise: Promise<EmbedEngine> | null = null;
/** The language the chrome and the sidebar render in. */
let uiLang: Lang = resolveLang(DEFAULT_SETTINGS.uiLang, navigator.language);

let registry: PluginRegistry | null = null;
let pending: { bytes: ArrayBuffer; name: string } | null = null;
/**
 * The document whose pages are allowed to report text.
 *
 * Closing a document and opening another one are asynchronous, and a page's
 * text extraction can resolve in between; the id is what keeps the previous
 * document's blocks from being committed into the new one.
 */
let currentDocumentId: string | null = null;

/**
 * Page text, in page order.
 *
 * `results[i]` is page `i`'s blocks (null while PDFium has not reported yet,
 * and `[]` for a page without text). `done` says whether the page has
 * reported, so an empty page still advances the commit cursor: a scanned page
 * must not hold back every page after it.
 */
let pageResults: Array<EmbedBlock[] | null> = [];
let pageDone: boolean[] = [];
let commitCursor = 0;
let pageCount = 0;

/** The highlight layer per page, recreated only when the page's DOM is. */
const highlightLayers = new Map<number, EmbedHighlightLayer>();

let current: ReadingDoc | null = null;
let controller: ReaderController | null = null;
/** The controller's own state subscription, dropped when the controller is. */
let unsubscribeController: (() => void) | null = null;
let announced = false;
let starting = false;
let initialRate = 1;
let appendStopped = false;
/**
 * Pages arrived while the engine was speaking, so their `load` was held back.
 *
 * Sending it then would stop the audio: the engine stops the speaker before it
 * reads `resume`. The longer list stays in the local document and goes out on
 * the next sync that finds the engine quiet.
 */
let appendPending = false;
/** Bumped for every document opened, so a slow open cannot overwrite a newer one. */
let generation = 0;

/** A doc whose contents can be swapped under the controller. */
const redirect: ReadingDoc = {
  get blocks() {
    return current?.blocks ?? [];
  },
  get sentences() {
    return current?.sentences ?? [];
  },
  getSentence: (index) => current?.getSentence(index) ?? null,
  rangeForSentence: (index) => current?.rangeForSentence(index) ?? null,
  rangeForWord: (index, start, end) => current?.rangeForWord(index, start, end) ?? null,
  sentenceAt: (node, offset) => current?.sentenceAt(node, offset) ?? null,
};

/** The labels this page adds on top of the shared catalogue. */
interface PdfUiLabels {
  search: string;
  closeSearch: string;
  previousMatch: string;
  nextMatch: string;
  noMatches: string;
  sidebar: SidebarLabels;
  toggleSidebar: string;
  download: string;
  fitWidth: string;
  previousPage: string;
  nextPage: string;
  pageBefore: string;
  pageAfter: (total: number) => string;
}

const PDF_LABELS: Record<Lang, PdfUiLabels> = {
  en: {
    search: 'Search…',
    closeSearch: 'Close search',
    previousMatch: 'Previous match',
    nextMatch: 'Next match',
    noMatches: 'No matches',
    sidebar: { pages: 'Pages', contents: 'Contents', empty: 'No table of contents' },
    toggleSidebar: 'Toggle the thumbnail panel',
    download: 'Download the PDF',
    fitWidth: 'Fit the page width',
    previousPage: 'Previous page',
    nextPage: 'Next page',
    pageBefore: 'Page ',
    pageAfter: (total) => ` of ${total}`,
  },
  ja: {
    search: '検索…',
    closeSearch: '検索を閉じる',
    previousMatch: '前の一致',
    nextMatch: '次の一致',
    noMatches: '一致なし',
    sidebar: { pages: 'ページ', contents: '目次', empty: '目次はありません' },
    toggleSidebar: 'サムネイルを表示',
    download: 'PDF をダウンロード',
    fitWidth: '幅に合わせる',
    previousPage: '前のページ',
    nextPage: '次のページ',
    pageBefore: '',
    pageAfter: (total) => ` / ${total} ページ`,
  },
  'zh-CN': {
    search: '搜索…',
    closeSearch: '关闭搜索',
    previousMatch: '上一个匹配',
    nextMatch: '下一个匹配',
    noMatches: '没有匹配',
    sidebar: { pages: '页面', contents: '目录', empty: '这份 PDF 没有目录' },
    toggleSidebar: '切换缩略图侧边栏',
    download: '下载 PDF',
    fitWidth: '适合页面宽度',
    previousPage: '上一页',
    nextPage: '下一页',
    pageBefore: '第 ',
    pageAfter: (total) => ` 页 / 共 ${total} 页`,
  },
};

function drawChrome(): void {
  render(
    <Chrome
      settings={settings}
      state={chrome}
      api={viewerApi}
      onZoom={zoomBy}
      onFitWidth={fitWidth}
      onPick={pickFile}
      onPassword={answerPassword}
      onPage={goToPage}
      onSearchQuery={setSearchQuery}
      onSearchNext={nextMatch}
      onSearchPrevious={previousMatch}
      onSearchClose={closeSearch}
      onToggleSidebar={toggleSidebar}
      onDownload={downloadDocument}
    />,
    chromeEl
  );
}

function show(notice: Notice): void {
  chrome = { ...chrome, notice };
  drawChrome();
}

/** The toolbar, the search bar, and whatever is blocking the view. */
interface ChromeProps {
  settings: SettingsStore;
  state: ChromeState;
  api: ViewerApi | null;
  onZoom: (direction: 1 | -1) => void;
  onFitWidth: () => void;
  onPick: (file: File) => void;
  onPassword: (value: string | null) => void;
  onPage: (page: number) => void;
  onSearchQuery: (query: string) => void;
  onSearchNext: () => void;
  onSearchPrevious: () => void;
  onSearchClose: () => void;
  onToggleSidebar: () => void;
  onDownload: () => void;
}

function Chrome(props: ChromeProps) {
  const { lang } = useUiLanguage(props.settings);
  return (
    <I18nProvider lang={lang}>
      <ChromeBody {...props} labels={PDF_LABELS[lang]} />
    </I18nProvider>
  );
}

function ChromeBody({
  state,
  api,
  labels,
  onZoom,
  onFitWidth,
  onPick,
  onPassword,
  onPage,
  onSearchQuery,
  onSearchNext,
  onSearchPrevious,
  onSearchClose,
  onToggleSidebar,
  onDownload,
}: ChromeProps & { labels: PdfUiLabels }) {
  const t = useT();
  const canPick = state.notice === 'pick' || state.notice === 'missing' || state.notice === 'empty';
  const controls = state.open && api !== null;

  return (
    <>
      <div class="pdf-top">
        <button
          type="button"
          class="pdf-icon-button"
          aria-label={labels.toggleSidebar}
          aria-pressed={state.sidebar}
          disabled={!controls}
          onClick={onToggleSidebar}
        >
          ⊞
        </button>
        {/* Never dismissible: a multi-column paper read down the columns looks
            like broken ordering, and the line is what distinguishes the two. */}
        <p class="pdf-order-hint">{t('pdf.order.hint')}</p>
        {state.open && (
          <div class="pdf-page-nav">
            <button
              type="button"
              aria-label={labels.previousPage}
              disabled={!controls || state.page <= 1}
              onClick={() => onPage(state.page - 1)}
            >
              ←
            </button>
            <PageField
              page={state.page}
              total={state.total}
              before={labels.pageBefore}
              after={labels.pageAfter(state.total)}
              onGo={onPage}
            />
            <button
              type="button"
              aria-label={labels.nextPage}
              disabled={!controls || state.page >= state.total}
              onClick={() => onPage(state.page + 1)}
            >
              →
            </button>
          </div>
        )}
        {state.open && (
          <fieldset class="pdf-zoom">
            <button
              type="button"
              aria-label={t('pdf.zoom.out')}
              disabled={!controls}
              onClick={() => onZoom(-1)}
            >
              −
            </button>
            <span class="pdf-zoom-level" aria-live="polite">
              {Math.round(state.zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label={t('pdf.zoom.in')}
              disabled={!controls}
              onClick={() => onZoom(1)}
            >
              +
            </button>
            <button
              type="button"
              aria-label={labels.fitWidth}
              disabled={!controls}
              onClick={onFitWidth}
            >
              ⤢
            </button>
          </fieldset>
        )}
        {state.open && (
          <button
            type="button"
            class="pdf-text-button"
            aria-label={labels.search}
            aria-expanded={state.search.open}
            disabled={!controls}
            onClick={openSearch}
          >
            {labels.search.replace('…', '')}
          </button>
        )}
        {state.open && (
          <button
            type="button"
            class="pdf-icon-button"
            aria-label={labels.download}
            disabled={!controls}
            onClick={onDownload}
          >
            ↓
          </button>
        )}
      </div>

      {state.search.open && (
        <div class="pdf-search">
          <input
            type="text"
            aria-label={labels.search}
            placeholder={labels.search}
            value={state.search.query}
            autofocus
            onInput={(event) => onSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (event.shiftKey) onSearchPrevious();
              else onSearchNext();
            }}
          />
          <span class="pdf-search-count" aria-live="polite">
            {searchCount(state.search, labels)}
          </span>
          <button
            type="button"
            aria-label={labels.previousMatch}
            disabled={state.search.total === 0}
            onClick={onSearchPrevious}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={labels.nextMatch}
            disabled={state.search.total === 0}
            onClick={onSearchNext}
          >
            ↓
          </button>
          <button type="button" aria-label={labels.closeSearch} onClick={onSearchClose}>
            ×
          </button>
        </div>
      )}

      {state.notice === 'opening' && <p class="pdf-notice">{t('panel.loading')}</p>}

      {canPick && (
        <div class="pdf-notice">
          {state.notice !== 'pick' && (
            <p role="alert">{t(state.notice === 'missing' ? 'pdf.missing' : 'pdf.empty')}</p>
          )}
          <label class="pdf-pick">
            <span>{t('pdf.pick')}</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                // Clearing lets the same file be chosen again after an error.
                event.currentTarget.value = '';
                if (file) onPick(file);
              }}
            />
          </label>
        </div>
      )}

      {state.password && (
        <PasswordCard
          // A rejection remounts the form, which clears the previous attempt.
          key={state.password.wrong ? 'wrong' : 'first'}
          wrong={state.password.wrong}
          onAnswer={onPassword}
        />
      )}
    </>
  );
}

/** The "3/12" counter, or a state label when there is nothing to count. */
function searchCount(search: SearchUiState, labels: PdfUiLabels): string {
  if (search.query.trim() === '') return '';
  if (search.loading && search.total === 0) return '…';
  if (search.total === 0) return labels.noMatches;
  return `${search.active + 1}/${search.total}`;
}

/** The editable page number in the middle of the page navigation control. */
function PageField({
  page,
  total,
  before,
  after,
  onGo,
}: {
  page: number;
  total: number;
  before: string;
  after: string;
  onGo: (page: number) => void;
}) {
  const [value, setValue] = useState(String(page));
  const [editing, setEditing] = useState(false);

  // While the reader is typing, the field owns its value; otherwise it follows
  // the page the viewer is actually on (scrolling, page buttons, search).
  useEffect(() => {
    if (!editing) setValue(String(page));
  }, [page, editing]);

  return (
    <form
      class="pdf-page-field"
      onSubmit={(event) => {
        event.preventDefault();
        const next = Number.parseInt(value, 10);
        if (!Number.isFinite(next)) {
          setValue(String(page));
          return;
        }
        onGo(Math.min(Math.max(next, 1), Math.max(total, 1)));
      }}
    >
      {before && <span>{before}</span>}
      <input
        type="text"
        inputMode="numeric"
        aria-label="Page"
        value={value}
        onFocus={() => setEditing(true)}
        onInput={(event) => setValue(event.currentTarget.value)}
        onBlur={() => {
          setEditing(false);
          setValue(String(page));
        }}
      />
      <span>{after}</span>
    </form>
  );
}

interface PasswordCardProps {
  wrong: boolean;
  onAnswer: (value: string | null) => void;
}

function PasswordCard({ wrong, onAnswer }: PasswordCardProps) {
  const t = useT();
  const [value, setValue] = useState('');

  return (
    <form
      class="pdf-password"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(value);
      }}
    >
      <h2>{t('pdf.password.title')}</h2>
      {wrong && <p role="alert">{t('pdf.password.wrong')}</p>}
      <input
        type="password"
        aria-label={t('pdf.password.title')}
        autofocus
        value={value}
        onInput={(event) => setValue(event.currentTarget.value)}
      />
      <button type="submit" aria-label={t('pdf.password.title')}>
        →
      </button>
      <button type="button" onClick={() => onAnswer(null)}>
        {t('settings.cache.cancel')}
      </button>
    </form>
  );
}

/** The viewer's entry point: a hash id, or a file the reader picks. */
function start(): void {
  document.addEventListener('keydown', handleKeydown);
  // The chrome is drawn before the settings answer so the picker is not
  // blocked on storage; the language arrives as soon as it does.
  settings
    .load()
    .then((loaded) => applyUiLang(loaded.uiLang))
    .catch((error: unknown) => {
      console.error('[SayLoud] cannot read the interface language', error);
    });
  settings.subscribe((loaded) => applyUiLang(loaded.uiLang));
  drawChrome();

  const id = location.hash.replace(/^#/, '');
  if (!id) return; // the picker is already on screen

  if (id === 'missing') {
    show('missing');
    return;
  }

  show('opening');
  void (async () => {
    const bytes = await requestBytes(id);
    if (!bytes) {
      show('missing');
      return;
    }
    await openBytes(bytes, 'document.pdf');
  })();
}

/**
 * Ask the service worker for the staged bytes.
 *
 * The handler belongs to a later task; until it exists a missing answer is the
 * expected one, so a rejection and a timeout are treated the same. The timeout
 * is for a worker that accepted the message and never answered.
 */
function requestBytes(id: string): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (bytes: ArrayBuffer | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(bytes);
    };
    const timer = window.setTimeout(() => finish(null), MISSING_TIMEOUT_MS);

    try {
      void browser.runtime
        .sendMessage({ type: 'pdf-bytes', id })
        .then((reply: unknown) => {
          const message = reply as { type?: string; bytes?: unknown } | undefined;
          finish(message?.type === 'pdf-bytes' ? toArrayBuffer(message.bytes) : null);
        })
        .catch(() => finish(null));
    } catch {
      finish(null);
    }
  });
}

function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  // The worker cannot send an `ArrayBuffer`: `runtime.sendMessage` is JSON-only,
  // so the bytes arrive as base64 and are rebuilt here.
  if (typeof value === 'string') return fromBase64(value);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return null;
}

function fromBase64(encoded: string): ArrayBuffer | null {
  try {
    const binary = atob(encoded);
    const octets = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      octets[index] = binary.charCodeAt(index);
    }
    return octets.buffer;
  } catch {
    return null;
  }
}

async function pickFile(file: File): Promise<void> {
  try {
    await openBytes(await file.arrayBuffer(), file.name);
  } catch (error) {
    console.error('[SayLoud] cannot read the chosen file', error);
    show('missing');
  }
}

async function openBytes(bytes: ArrayBuffer, name: string): Promise<void> {
  const run = ++generation;
  resetDocument();
  show('opening');

  if (bytes.byteLength === 0) {
    show('empty');
    return;
  }

  try {
    await ensureEngine();
  } catch (error) {
    console.error('[SayLoud] cannot start the pdf engine', error);
    if (run === generation) show('missing');
    return;
  }
  if (run !== generation) return;

  mountViewer();
  pending = { bytes, name };
  // `pending` is consumed either by the registry callback (the usual path) or
  // here, if the embedding tree was already up from a previous file.
  await openPending(run);
}

/** Create the engine once; a failure leaves the promise unset so picking retries. */
function ensureEngine(): Promise<EmbedEngine> {
  if (engine) return Promise.resolve(engine);
  enginePromise ??= createPdfEngine()
    .then((created) => {
      engine = created;
      return created;
    })
    .catch((error: unknown) => {
      enginePromise = null;
      throw error;
    });
  return enginePromise;
}

/** Mount (or update) the EmbedPDF tree; it is reused for every document. */
function mountViewer(): void {
  drawViewer();
}

function drawViewer(): void {
  if (!engine) return;
  render(
    <PdfViewer
      engine={engine}
      sidebarOpen={chrome.sidebar}
      sidebarLabels={PDF_LABELS[uiLang].sidebar}
      onRegistry={handleRegistry}
      onApi={handleViewerApi}
      onScale={handleScale}
      onPage={handlePageState}
      onSearch={handleSearchState}
      onPageBlocks={handlePageBlocks}
    />,
    pagesEl
  );
}

function handleRegistry(next: PluginRegistry | null): void {
  registry = next;
  if (next) void openPending(generation);
}

function handleViewerApi(api: ViewerApi | null): void {
  viewerApi = api;
  drawChrome();
}

function handleScale(scale: number): void {
  // The zoom plugin reports on every document change; only a real move is
  // worth a re-render of the toolbar.
  if (Math.abs(chrome.zoom - scale) < 0.001) return;
  chrome = { ...chrome, zoom: scale };
  drawChrome();
}

function handlePageState(page: number, total: number): void {
  if (chrome.page === page && chrome.total === total) return;
  chrome = { ...chrome, page, total };
  drawChrome();
}

function handleSearchState(next: ViewerSearchState): void {
  // Results keep arriving after the bar is closed (the plugin finishes a scan
  // in flight); the closed bar must not be reopened by them.
  if (!chrome.search.open) return;
  const search = chrome.search;
  if (
    search.active === next.active &&
    search.total === next.total &&
    search.loading === next.loading
  ) {
    return;
  }
  chrome = { ...chrome, search: { ...search, ...next } };
  drawChrome();
}

/** Update the interface language when the settings load or change. */
function applyUiLang(preference: UiLang): void {
  const next = resolveLang(preference, navigator.language);
  if (next === uiLang) return;
  uiLang = next;
  drawChrome();
  drawViewer();
}

/**
 * One page's text is ready.
 *
 * Reported in whatever order PDFium finishes, so the reading document only
 * advances over a contiguous prefix of pages. That keeps every `load` an
 * append: a document that gained page 5 before page 3 would otherwise be
 * rewritten in the middle, and the engine would be reading offsets of a list
 * that no longer matches.
 */
function handlePageBlocks(
  documentId: string,
  pageIndex: number,
  blocks: EmbedBlock[],
  layer: HTMLElement
): void {
  if (documentId !== currentDocumentId) return;

  const existing = highlightLayers.get(pageIndex);
  if (!existing || existing.container !== layer) {
    highlightLayers.set(pageIndex, new EmbedHighlightLayer(layer));
  }

  pageResults[pageIndex] = blocks;
  pageDone[pageIndex] = true;

  while (commitCursor < pageDone.length && pageDone[commitCursor]) commitCursor += 1;
  syncDoc();
}

/** Open the file that was just chosen, asking for a password when PDFium does. */
async function openPending(run: number): Promise<void> {
  if (run !== generation || !pending || !registry) return;
  const file = pending;
  pending = null;

  let result: OpenedDocument;
  try {
    result = await openWithPassword(file, run);
  } catch (error) {
    if (run !== generation) return;
    await closePdfDocuments(registry);
    if (error === 'cancelled') show('pick');
    else {
      console.error('[SayLoud] cannot open the pdf', error);
      show('missing');
    }
    return;
  } finally {
    passwordAttempts = 0;
    chrome = { ...chrome, password: null };
    drawChrome();
  }

  if (run !== generation) {
    await closePdfDocuments(registry);
    return;
  }

  currentDocumentId = result.documentId;
  documentBytes = file.bytes;
  documentName = file.name;
  pageCount = result.document.pages.length;
  pageResults = new Array<EmbedBlock[] | null>(pageCount).fill(null);
  pageDone = new Array<boolean>(pageCount).fill(false);
  commitCursor = 0;
  chrome = { ...chrome, open: true, page: 1, total: pageCount };

  if (pageCount === 0) {
    show('empty');
    return;
  }
  drawChrome();
}

/**
 * Open (or retry) a document until PDFium stops asking for a password.
 *
 * A wrong password is reported as a failed open, and `retryDocument` re-runs
 * only the authentication step: the bytes are already in PDFium, so a typo
 * does not re-parse the file. A cancel is the reader's own choice and must not
 * look like a broken file.
 */
async function openWithPassword(
  file: { bytes: ArrayBuffer; name: string },
  run: number
): Promise<OpenedDocument> {
  let password: string | null = null;
  let documentId: string | null = null;

  for (;;) {
    try {
      if (documentId === null) {
        return await openPdfDocument(registry, file.bytes, file.name);
      }
      return await retryPdfDocument(registry, documentId, password ?? '');
    } catch (error) {
      const failure = error instanceof EmbedOpenError ? error : null;
      documentId = failure?.documentId ?? documentId;
      const reason = failure?.reason ?? null;

      if (!isPasswordError(reason) || !documentId) throw error;
      if (passwordAttempts >= MAX_PASSWORD_ATTEMPTS) throw error;

      password = await askPassword();
      if (run !== generation) throw 'cancelled';
      if (password === null) throw 'cancelled';
      passwordAttempts += 1;
    }
  }
}

/** Fold the committed pages into a document, appending only. */
function syncDoc(): void {
  if (appendStopped) return;

  const blocks: Block[] = [];
  for (let index = 0; index < commitCursor; index++) {
    const page = pageResults[index];
    if (page) blocks.push(...page);
  }

  const next = buildReadingDoc(blocks);
  const previous = current?.sentences ?? [];

  if (!isAppendOnly(previous, next.sentences)) {
    appendStopped = true;
    console.warn('[SayLoud] the pdf text order changed; keeping the sentences already read');
    return;
  }

  const grew = next.sentences.length > previous.length;
  current = next;

  if (grew && announced) resend();
  syncHighlight();

  if (!announced && !starting) {
    if (next.sentences.length > 0) {
      show('ready');
      void startReader();
    } else if (commitCursor >= pageCount && pageCount > 0) {
      show('empty');
    }
  }
}

function isAppendOnly(
  previous: readonly ReadingSentence[],
  next: readonly ReadingSentence[]
): boolean {
  if (next.length < previous.length) return false;
  return previous.every((sentence, index) => next[index]?.text === sentence.text);
}

/** Build the reader once the first page's sentences exist. */
async function startReader(): Promise<void> {
  if (controller || starting || !current) return;
  starting = true;

  initialRate = await settings
    .load()
    .then((loaded) => loaded.rate)
    .catch((error: unknown) => {
      console.error('[SayLoud] cannot read the saved rate', error);
      return 1;
    });

  if (!current || controller) {
    starting = false;
    return;
  }

  controller = new ReaderController(host, { initialRate, settings, doc: redirect });
  controller.connect();
  announced = true;
  starting = false;
  // A page appended while the engine was speaking is held back; this is what
  // sends it once the engine goes quiet, which is the only moment a `load`
  // cannot cut the audio off.
  unsubscribeController = controller.subscribe(() => {
    if (appendPending) resend();
    syncHighlight();
  });
  render(
    <ReaderPanel
      controller={controller}
      settings={settings}
      host={host}
      onOpenSettings={() => void browser.runtime.openOptionsPage()}
      onClose={closeReader}
    />,
    host
  );
}

/**
 * Give the engine the document again, at the sentence being read.
 *
 * Only while the engine is quiet. A `load` stops the speaker before it looks
 * at `resume`, so one sent while audio is coming out cuts the reading off; the
 * sentences stay in the local document and this is tried again on the next
 * sync. `resume` is what keeps a quiet engine from starting to speak just
 * because a later page arrived.
 */
function resend(): void {
  if (!controller || !current) return;
  const status = controller.getState().status;

  const decision = appendSync(status?.phase);
  if (!decision.send) {
    appendPending = true;
    return;
  }

  appendPending = false;
  controller.sendCommand({
    type: 'load',
    sentences: current.sentences.map((sentence) => ({
      text: sentence.text,
      lang: sentence.lang,
    })),
    startIndex: status?.index ?? 0,
    rate: status?.rate ?? initialRate,
    resume: decision.resume,
  });
}

/**
 * Paint the sentence being read onto its page.
 *
 * The reader controller still registers its own `CSS.highlights` range — that
 * is what the word highlight and the e2e assertions read — but the sentence's
 * visible paint is these rectangles: they are PDFium's own text boxes, so they
 * stay on the glyphs even when the invisible text layer's font metrics do not.
 * The page's CSS makes the sentence highlight transparent for that reason (see
 * `index.html`).
 */
function syncHighlight(): void {
  for (const layer of highlightLayers.values()) layer.clear();

  const status = controller?.getState().status;
  const index = status?.index;
  if (index === undefined) return;
  if (status?.phase === 'idle' || status?.phase === 'ended') return;

  const sentence = current?.getSentence(index);
  if (!sentence) return;
  const block = current?.blocks[sentence.blockIndex];
  if (!block) return;
  const embed = block as EmbedBlock;
  const layer = highlightLayers.get(embed.pageIndex);
  if (!layer) return;

  const rects = embed.run
    .filter((run) => run.end > sentence.start && run.start < sentence.end)
    .map((run) => run.rect);
  layer.setRects(rects, index);
}

/** Zoom through the embedding tree's own plugin. */
function zoomBy(direction: 1 | -1): void {
  if (!viewerApi) return;
  if (direction === 1) viewerApi.zoomIn();
  else viewerApi.zoomOut();
}

function fitWidth(): void {
  viewerApi?.fitWidth();
}

function goToPage(page: number): void {
  viewerApi?.goToPage(page);
}

function nextPage(): void {
  if (!chrome.open) return;
  viewerApi?.nextPage();
}

function previousPage(): void {
  if (!chrome.open) return;
  viewerApi?.previousPage();
}

/** Open the search bar (or just put the caret back in it). */
function openSearch(): void {
  if (!chrome.open) return;
  if (!chrome.search.open) {
    chrome = { ...chrome, search: { ...chrome.search, open: true } };
    drawChrome();
  }
  const input = chromeEl.querySelector<HTMLInputElement>('.pdf-search input');
  input?.focus();
  input?.select();
}

function closeSearch(): void {
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer);
    searchTimer = null;
  }
  viewerApi?.stopSearch();
  chrome = {
    ...chrome,
    search: { open: false, query: '', active: -1, total: 0, loading: false },
  };
  drawChrome();
}

/**
 * The reader typed: show the query at once and scan after a short pause.
 *
 * The plugin aborts an older scan when a new one starts, but each keystroke
 * would still cross the worker; the debounce keeps a fast typist to one scan.
 */
function setSearchQuery(query: string): void {
  const loading = query.trim().length > 0;
  chrome = {
    ...chrome,
    search: { ...chrome.search, query, active: -1, total: 0, loading },
  };
  drawChrome();

  if (searchTimer !== null) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    if (!chrome.search.open) return;
    viewerApi?.search(chrome.search.query);
  }, SEARCH_DEBOUNCE_MS);
}

function nextMatch(): void {
  if (!chrome.search.open || chrome.search.total === 0) return;
  viewerApi?.nextMatch();
}

function previousMatch(): void {
  if (!chrome.search.open || chrome.search.total === 0) return;
  viewerApi?.previousMatch();
}

function toggleSidebar(): void {
  chrome = { ...chrome, sidebar: !chrome.sidebar };
  drawChrome();
  drawViewer();
}

/** Save the open document through the browser's download machinery. */
function downloadDocument(): void {
  if (!documentBytes) return;
  const blob = new Blob([documentBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = documentName || 'document.pdf';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download reads the URL asynchronously; revoking it in the same turn
  // would race the fetch.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Whether a shortcut key should type into the focused control instead. */
function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return (
    element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'
  );
}

function handleKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    if (!chrome.open) return;
    event.preventDefault();
    openSearch();
    return;
  }

  if (event.key === 'Escape' && chrome.search.open) {
    event.preventDefault();
    closeSearch();
    return;
  }

  if (isEditable(event.target)) return;
  if (!chrome.open) return;

  switch (event.key) {
    case 'PageDown':
    case 'ArrowRight':
      event.preventDefault();
      nextPage();
      break;
    case 'PageUp':
    case 'ArrowLeft':
      event.preventDefault();
      previousPage();
      break;
    case '+':
    case '=':
      event.preventDefault();
      zoomBy(1);
      break;
    case '-':
      event.preventDefault();
      zoomBy(-1);
      break;
    case '0':
      event.preventDefault();
      fitWidth();
      break;
    case 'Enter':
      if (chrome.search.open) {
        event.preventDefault();
        nextMatch();
      }
      break;
    default:
      break;
  }
}

/** Ask for a password, and remember where the answer goes. */
function askPassword(): Promise<string | null> {
  return new Promise((resolve) => {
    passwordResolve = resolve;
    chrome = { ...chrome, password: { wrong: passwordAttempts > 0 } };
    drawChrome();
  });
}

/** Resolve the open prompt; null is a cancel and is never asked again. */
function answerPassword(value: string | null): void {
  const resolve = passwordResolve;
  passwordResolve = null;
  chrome = { ...chrome, password: null };
  drawChrome();
  resolve?.(value);
}

function closeReader(): void {
  unsubscribeController?.();
  unsubscribeController = null;
  controller?.dispose();
  controller = null;
  announced = false;
  render(null, host);
  window.close();
}

/** Tear down the previous document, if there was one. */
function resetDocument(): void {
  answerPassword(null);
  unsubscribeController?.();
  unsubscribeController = null;
  controller?.dispose();
  controller = null;
  announced = false;
  starting = false;
  appendStopped = false;
  appendPending = false;
  current = null;
  currentDocumentId = null;
  pending = null;
  pageResults = [];
  pageDone = [];
  commitCursor = 0;
  pageCount = 0;
  documentBytes = null;
  documentName = 'document.pdf';
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer);
    searchTimer = null;
  }
  highlightLayers.clear();
  passwordAttempts = 0;
  render(null, host);
  void closePdfDocuments(registry);
  chrome = {
    ...chrome,
    open: false,
    password: null,
    page: 1,
    total: 0,
    search: { open: false, query: '', active: -1, total: 0, loading: false },
  };
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the pdf viewer is missing #${id}`);
  return found;
}

start();
