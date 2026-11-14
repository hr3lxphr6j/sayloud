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
import { useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { ReaderController } from '~/entrypoints/reader.content/ReaderController';
import { ReaderPanel } from '~/entrypoints/reader.content/ReaderPanel';
import type { Block } from '~/lib/extractor';
import { I18nProvider, useT, useUiLanguage } from '~/lib/i18n';
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
import { SettingsStore } from '~/lib/settings-store';
import '~/entrypoints/reader.content/styles.css';
import { appendSync } from './sync';
import { PdfViewer, type ViewerApi } from './viewer';

/** How long a hash id gets to be answered before it is called missing. */
const MISSING_TIMEOUT_MS = 2_000;

/** The page's root elements, all of which the HTML provides. */
const chromeEl = element('pdf-chrome');
const pagesEl = element('pdf-pages');
const host = element('sayloud-host');

const settings = new SettingsStore(browser.storage.local, browser.storage.onChanged);

/** What the strip above the pages is saying right now. */
type Notice = 'opening' | 'pick' | 'missing' | 'empty' | 'ready';

interface ChromeState {
  notice: Notice;
  /** Current zoom factor, from EmbedPDF's zoom plugin. */
  zoom: number;
  /** Non-null while a password is being asked for; `wrong` after a rejection. */
  password: { wrong: boolean } | null;
  /** Whether a document is open, which is what the zoom control needs to know. */
  open: boolean;
}

let chrome: ChromeState = {
  notice: 'pick',
  zoom: 1,
  password: null,
  open: false,
};

/** The zoom controls, once the embedding tree has a document to zoom. */
let viewerApi: ViewerApi | null = null;

let passwordResolve: ((value: string | null) => void) | null = null;
let passwordAttempts = 0;

let engine: EmbedEngine | null = null;
let enginePromise: Promise<EmbedEngine> | null = null;
let viewerMounted = false;

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

function drawChrome(): void {
  render(
    <Chrome
      settings={settings}
      state={chrome}
      api={viewerApi}
      onZoom={zoomBy}
      onPick={pickFile}
      onPassword={answerPassword}
    />,
    chromeEl
  );
}

function show(notice: Notice): void {
  chrome = { ...chrome, notice };
  drawChrome();
}

/** The reading-order line, the zoom control, and whatever is blocking the view. */
interface ChromeProps {
  settings: SettingsStore;
  state: ChromeState;
  api: ViewerApi | null;
  onZoom: (direction: 1 | -1) => void;
  onPick: (file: File) => void;
  onPassword: (value: string | null) => void;
}

function Chrome(props: ChromeProps) {
  const { lang } = useUiLanguage(props.settings);
  return (
    <I18nProvider lang={lang}>
      <ChromeBody {...props} />
    </I18nProvider>
  );
}

function ChromeBody({ state, api, onZoom, onPick, onPassword }: ChromeProps) {
  const t = useT();
  const canPick = state.notice === 'pick' || state.notice === 'missing' || state.notice === 'empty';

  return (
    <>
      <div class="pdf-top">
        {/* Never dismissible: a multi-column paper read down the columns looks
            like broken ordering, and the line is what distinguishes the two. */}
        <p class="pdf-order-hint">{t('pdf.order.hint')}</p>
        {state.open && (
          <fieldset class="pdf-zoom">
            <button
              type="button"
              aria-label={t('pdf.zoom.out')}
              disabled={!api}
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
              disabled={!api}
              onClick={() => onZoom(1)}
            >
              +
            </button>
          </fieldset>
        )}
      </div>

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

  let created: EmbedEngine;
  try {
    created = await ensureEngine();
  } catch (error) {
    console.error('[SayLoud] cannot start the pdf engine', error);
    if (run === generation) show('missing');
    return;
  }
  if (run !== generation) return;

  mountViewer(created);
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

/** Mount the EmbedPDF tree once; it is reused for every document. */
function mountViewer(created: EmbedEngine): void {
  if (viewerMounted) return;
  viewerMounted = true;
  render(
    <PdfViewer
      engine={created}
      onRegistry={handleRegistry}
      onApi={handleViewerApi}
      onScale={handleScale}
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
  pageCount = result.document.pages.length;
  pageResults = new Array<EmbedBlock[] | null>(pageCount).fill(null);
  pageDone = new Array<boolean>(pageCount).fill(false);
  commitCursor = 0;
  chrome = { ...chrome, open: true };

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
  highlightLayers.clear();
  passwordAttempts = 0;
  render(null, host);
  void closePdfDocuments(registry);
  chrome = { ...chrome, open: false, password: null };
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the pdf viewer is missing #${id}`);
  return found;
}

start();
