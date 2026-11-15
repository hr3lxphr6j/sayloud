/**
 * The PDF viewer page.
 *
 * A page of its own rather than a content script: the extension already has a
 * reading bar that talks to the engine, and this page only has to hand it a
 * document. Rendering is EmbedPDF/PDFium (`viewer.tsx`), and this file is the
 * shell around it: the toolbar, the file picker, the password prompt, and the
 * reader that reads the page's text aloud. The document comes from one of three
 * places: a file the reader picked, an id the toolbar click staged in the
 * worker, or a `#url=…` fragment written by the DNR redirect (lib/pdf/dnr.ts).
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
import { browser } from 'wxt/browser';
import { ReaderController } from '~/entrypoints/reader.content/ReaderController';
import { ReaderPanel } from '~/entrypoints/reader.content/ReaderPanel';
import type { Block } from '~/lib/extractor';
import { type Lang, resolveLang } from '~/lib/i18n';
import { isInterceptHash, parseInterceptedUrl } from '~/lib/pdf/dnr';
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
import {
  buildReadingDoc,
  type ReadingDoc,
  type ReadingSentence,
  toEngineSentences,
} from '~/lib/reading-doc';
import { DEFAULT_SETTINGS, SettingsStore, type UiLang } from '~/lib/settings-store';
import '~/entrypoints/reader.content/styles.css';
import { Chrome, type ChromeState, type Notice, PDF_LABELS, type SearchUiState } from './chrome-ui';
import { DEFAULT_DOCUMENT_NAME, documentNameFromUrl, requestBytes } from './load-bytes';
import { appendSync } from './sync';
import { PdfViewer, type ViewerApi, type ViewerSearchState } from './viewer';

/** Debounce between a keystroke in the search bar and the PDFium scan. */
const SEARCH_DEBOUNCE_MS = 180;

/** How long a redirected document gets to arrive before it is called missing. */
const INTERCEPT_TIMEOUT_MS = 30_000;

/**
 * How long the download link's blob URL stays readable.
 *
 * The browser reads the URL asynchronously after the click; revoking it in the
 * same turn would race the fetch.
 */
const REVOKE_DELAY_MS = 10_000;

/** The page's root elements, all of which the HTML provides. */
const chromeEl = element('pdf-chrome');
const pagesEl = element('pdf-pages');
const host = element('sayloud-host');

const settings = new SettingsStore(browser.storage.local, browser.storage.onChanged);

/** The search bar with nothing in it; every update spreads rather than edits. */
const EMPTY_SEARCH: SearchUiState = {
  open: false,
  query: '',
  active: -1,
  total: 0,
  loading: false,
};

let chrome: ChromeState = {
  notice: 'pick',
  zoom: 1,
  password: null,
  open: false,
  page: 1,
  total: 0,
  sidebar: false,
  search: EMPTY_SEARCH,
};

/** The zoom/paging/search controls, once the embedding tree has a document. */
let viewerApi: ViewerApi | null = null;

let engine: EmbedEngine | null = null;
let enginePromise: Promise<EmbedEngine> | null = null;
/** The language the chrome and the sidebar render in. */
let uiLang: Lang = resolveLang(DEFAULT_SETTINGS.uiLang, navigator.language);

let registry: PluginRegistry | null = null;
/** Bumped for every document opened, so a slow open cannot overwrite a newer one. */
let generation = 0;

/**
 * Everything one open document owns.
 *
 * The page opens a document repeatedly — a picked file, a redirect, another
 * file after a failure — and each one has to be forgotten completely. Keeping
 * the fields together is what lets a reset be one call to the factory below
 * instead of twenty assignments that drift from the declarations.
 *
 * What is not here is deliberate: the engine, the plugin registry and the
 * interface language outlive a document, and `generation` only ever grows.
 */
interface PdfSession {
  controller: ReaderController | null;
  /** The controller's own state subscription, dropped when the controller is. */
  unsubscribeController: (() => void) | null;
  /** The document the engine reads, grown page by page; null until it has text. */
  doc: ReadingDoc | null;
  /** The rate the reader had saved when the controller was built. */
  initialRate: number;
  /** Whether the document was handed to the engine, which is what syncDoc gates on. */
  announced: boolean;
  /** Whether `startReader()` is between its rate lookup and its controller. */
  starting: boolean;
  /** A rebuild changed a sentence already sent, so no further page may land. */
  appendStopped: boolean;
  /**
   * Pages arrived while the engine was speaking, so their `load` was held back.
   *
   * Sending it then would stop the audio: the engine stops the speaker before it
   * reads `resume`. The longer list stays in the local document and goes out on
   * the next sync that finds the engine quiet.
   */
  appendPending: boolean;
  /** The file waiting for the embedding tree, between `openBytes` and the open. */
  pending: { bytes: ArrayBuffer; name: string } | null;
  /**
   * The document whose pages are allowed to report text.
   *
   * Closing a document and opening another one are asynchronous, and a page's
   * text extraction can resolve in between; the id is what keeps the previous
   * document's blocks from being committed into the new one.
   */
  currentDocumentId: string | null;
  /**
   * Page text, in page order.
   *
   * `pageResults[i]` is page `i`'s blocks (null while PDFium has not reported
   * yet, and `[]` for a page without text). `pageDone` says whether the page has
   * reported, so an empty page still advances the commit cursor: a scanned page
   * must not hold back every page after it.
   */
  pageResults: Array<EmbedBlock[] | null>;
  pageDone: boolean[];
  commitCursor: number;
  pageCount: number;
  /** The highlight layer per page, recreated only when the page's DOM is. */
  highlightLayers: Map<number, EmbedHighlightLayer>;
  /** The open document's own bytes, kept for the download button. */
  documentBytes: ArrayBuffer | null;
  documentName: string;
  /** The pending debounced search, so a fast typist only runs the last one. */
  searchTimer: number | null;
  passwordResolve: ((value: string | null) => void) | null;
  passwordAttempts: number;
}

/** The state a document starts from, which is also the state a reset returns to. */
function createSession(): PdfSession {
  return {
    controller: null,
    unsubscribeController: null,
    doc: null,
    initialRate: 1,
    announced: false,
    starting: false,
    appendStopped: false,
    appendPending: false,
    pending: null,
    currentDocumentId: null,
    pageResults: [],
    pageDone: [],
    commitCursor: 0,
    pageCount: 0,
    highlightLayers: new Map(),
    documentBytes: null,
    documentName: DEFAULT_DOCUMENT_NAME,
    searchTimer: null,
    passwordResolve: null,
    passwordAttempts: 0,
  };
}

let session: PdfSession = createSession();

/** A doc whose contents can be swapped under the controller. */
const redirect: ReadingDoc = {
  get blocks() {
    return session.doc?.blocks ?? [];
  },
  get sentences() {
    return session.doc?.sentences ?? [];
  },
  getSentence: (index) => session.doc?.getSentence(index) ?? null,
  rangeForSentence: (index) => session.doc?.rangeForSentence(index) ?? null,
  rangeForWord: (index, start, end) => session.doc?.rangeForWord(index, start, end) ?? null,
  sentenceAt: (node, offset) => session.doc?.sentenceAt(node, offset) ?? null,
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
      onOpenSearch={openSearch}
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

/**
 * The viewer's entry point: a redirected URL, a staged hash id, or a file the
 * reader picks.
 */
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

  // A declarativeNetRequest redirect names the document in the fragment. It
  // takes precedence over the staged-id form because it is the whole reason
  // this page was navigated to.
  const intercepted = parseInterceptedUrl(location.hash);
  if (intercepted !== null) {
    show('opening');
    void openIntercepted(intercepted);
    return;
  }
  // A `#url=` that did not parse is a redirect we cannot follow, not a
  // staged document with an unusual id.
  if (isInterceptHash(location.hash)) {
    show('missing');
    return;
  }

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
    await openBytes(bytes, DEFAULT_DOCUMENT_NAME);
  })();
}

/**
 * Fetch the document a redirect named in the fragment.
 *
 * The page does the fetching rather than the worker: the navigation replaced
 * the PDF's own tab, so there is no document left to ask for its bytes. Host
 * access is granted with the settings toggle that installed the redirect rule,
 * which is also what lets this cross-origin request read the response;
 * `credentials: 'include'` keeps a PDF behind a session cookie readable where
 * the browser is willing to send that cookie.
 */
async function openIntercepted(url: string): Promise<void> {
  let bytes: ArrayBuffer | null = null;
  try {
    const response = await fetch(url, {
      credentials: 'include',
      signal: AbortSignal.timeout(INTERCEPT_TIMEOUT_MS),
    });
    if (response.ok) bytes = await response.arrayBuffer();
  } catch (error) {
    console.error('[SayLoud] cannot fetch the redirected pdf', error);
  }

  if (!bytes) {
    show('missing');
    return;
  }
  await openBytes(bytes, documentNameFromUrl(url));
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

  drawViewer();
  session.pending = { bytes, name };
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
  if (documentId !== session.currentDocumentId) return;

  const existing = session.highlightLayers.get(pageIndex);
  if (!existing || existing.container !== layer) {
    session.highlightLayers.set(pageIndex, new EmbedHighlightLayer(layer));
  }

  session.pageResults[pageIndex] = blocks;
  session.pageDone[pageIndex] = true;

  while (session.commitCursor < session.pageDone.length && session.pageDone[session.commitCursor]) {
    session.commitCursor += 1;
  }
  syncDoc();
}

/** Open the file that was just chosen, asking for a password when PDFium does. */
async function openPending(run: number): Promise<void> {
  if (run !== generation || !session.pending || !registry) return;
  const file = session.pending;
  session.pending = null;

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
    session.passwordAttempts = 0;
    chrome = { ...chrome, password: null };
    drawChrome();
  }

  if (run !== generation) {
    await closePdfDocuments(registry);
    return;
  }

  session.currentDocumentId = result.documentId;
  session.documentBytes = file.bytes;
  session.documentName = file.name;
  const pageCount = result.document.pages.length;
  session.pageCount = pageCount;
  session.pageResults = new Array<EmbedBlock[] | null>(pageCount).fill(null);
  session.pageDone = new Array<boolean>(pageCount).fill(false);
  session.commitCursor = 0;
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
      if (session.passwordAttempts >= MAX_PASSWORD_ATTEMPTS) throw error;

      password = await askPassword();
      if (run !== generation) throw 'cancelled';
      if (password === null) throw 'cancelled';
      session.passwordAttempts += 1;
    }
  }
}

/** Fold the committed pages into a document, appending only. */
function syncDoc(): void {
  if (session.appendStopped) return;

  const blocks: Block[] = [];
  for (let index = 0; index < session.commitCursor; index++) {
    const page = session.pageResults[index];
    if (page) blocks.push(...page);
  }

  const next = buildReadingDoc(blocks);
  const previous = session.doc?.sentences ?? [];

  if (!isAppendOnly(previous, next.sentences)) {
    session.appendStopped = true;
    console.warn('[SayLoud] the pdf text order changed; keeping the sentences already read');
    return;
  }

  const grew = next.sentences.length > previous.length;
  session.doc = next;

  if (grew && session.announced) resend();
  syncHighlight();

  if (!session.announced && !session.starting) {
    if (next.sentences.length > 0) {
      show('ready');
      void startReader();
    } else if (session.commitCursor >= session.pageCount && session.pageCount > 0) {
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
  if (session.controller || session.starting || !session.doc) return;
  session.starting = true;

  session.initialRate = await settings
    .load()
    .then((loaded) => loaded.rate)
    .catch((error: unknown) => {
      console.error('[SayLoud] cannot read the saved rate', error);
      return 1;
    });

  if (!session.doc || session.controller) {
    session.starting = false;
    return;
  }

  session.controller = new ReaderController(host, {
    initialRate: session.initialRate,
    settings,
    doc: redirect,
  });
  session.controller.connect();
  session.announced = true;
  session.starting = false;
  // A page appended while the engine was speaking is held back; this is what
  // sends it once the engine goes quiet, which is the only moment a `load`
  // cannot cut the audio off.
  session.unsubscribeController = session.controller.subscribe(() => {
    if (session.appendPending) resend();
    syncHighlight();
  });
  render(
    <ReaderPanel
      controller={session.controller}
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
 *
 * The command is built here rather than through the controller's own
 * `sendLoad`, which always sends the rate the controller was built with: this
 * one has to send the rate the engine is on now, or a page arriving after the
 * reader picked a speed would snap it back to the saved default and re-speak
 * the rest at the old one. The sentence mapping is shared
 * (`toEngineSentences`); the rate is why the command itself is not.
 */
function resend(): void {
  if (!session.controller || !session.doc) return;
  const status = session.controller.getState().status;

  const decision = appendSync(status?.phase);
  if (!decision.send) {
    session.appendPending = true;
    return;
  }

  session.appendPending = false;
  session.controller.sendCommand({
    type: 'load',
    sentences: toEngineSentences(session.doc.sentences),
    startIndex: status?.index ?? 0,
    rate: status?.rate ?? session.initialRate,
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
  for (const layer of session.highlightLayers.values()) layer.clear();

  const status = session.controller?.getState().status;
  const index = status?.index;
  if (index === undefined) return;
  if (status?.phase === 'idle' || status?.phase === 'ended') return;

  const sentence = session.doc?.getSentence(index);
  if (!sentence) return;
  const block = session.doc?.blocks[sentence.blockIndex];
  if (!block) return;
  const embed = block as EmbedBlock;
  const layer = session.highlightLayers.get(embed.pageIndex);
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

/** Stop the debounced scan; the timer id only lives in the current session. */
function clearSearchTimer(): void {
  if (session.searchTimer === null) return;
  window.clearTimeout(session.searchTimer);
  session.searchTimer = null;
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
  clearSearchTimer();
  viewerApi?.stopSearch();
  chrome = { ...chrome, search: EMPTY_SEARCH };
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

  clearSearchTimer();
  session.searchTimer = window.setTimeout(() => {
    session.searchTimer = null;
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
  if (!session.documentBytes) return;
  const blob = new Blob([session.documentBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = session.documentName || DEFAULT_DOCUMENT_NAME;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** Whether a shortcut key should type into the focused control instead. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
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
    session.passwordResolve = resolve;
    chrome = { ...chrome, password: { wrong: session.passwordAttempts > 0 } };
    drawChrome();
  });
}

/** Resolve the open prompt; null is a cancel and is never asked again. */
function answerPassword(value: string | null): void {
  const resolve = session.passwordResolve;
  session.passwordResolve = null;
  chrome = { ...chrome, password: null };
  drawChrome();
  resolve?.(value);
}

function closeReader(): void {
  session.unsubscribeController?.();
  session.unsubscribeController = null;
  session.controller?.dispose();
  session.controller = null;
  session.announced = false;
  render(null, host);
  window.close();
}

/**
 * Tear down the previous document, if there was one.
 *
 * The assignments are the factory's job; what is left here is the teardown a
 * new state cannot perform on its own. A pending password prompt has to be
 * answered or the open awaiting it never settles, the controller owns listeners
 * and a port that are not garbage collected, the debounce holds a live timer
 * id, and the worker still holds the old document.
 */
function resetDocument(): void {
  answerPassword(null);
  session.unsubscribeController?.();
  session.unsubscribeController = null;
  session.controller?.dispose();
  // Cleared before the state is replaced: the id lives in the old session.
  clearSearchTimer();
  session = createSession();
  render(null, host);
  void closePdfDocuments(registry);
  chrome = {
    ...chrome,
    open: false,
    password: null,
    page: 1,
    total: 0,
    search: EMPTY_SEARCH,
  };
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the pdf viewer is missing #${id}`);
  return found;
}

start();
