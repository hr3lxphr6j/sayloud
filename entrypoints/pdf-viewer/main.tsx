/**
 * The PDF viewer page.
 *
 * A page of its own rather than a content script: the extension already has a
 * reading bar that talks to the engine, and this page only has to hand it a
 * document. The PDF itself is drawn into the page — a canvas per page with a
 * text layer on top — and the text layer is what the reader highlights.
 *
 * Reading a whole PDF up front would make the first sentence wait for the last
 * page, so the first page is read before the bar appears and the rest arrive in
 * the background. Because the engine has already been given the first page, an
 * append is followed by another `load` with `resume: true`: the growing list
 * replaces the one the engine has, at the sentence being read, without starting
 * to speak. Sentence texts never change; if a rebuild would change one, the
 * append is abandoned and the old document is kept.
 */

import type { PDFPageProxy } from 'pdfjs-dist';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { ReaderController } from '~/entrypoints/reader.content/ReaderController';
import { ReaderPanel } from '~/entrypoints/reader.content/ReaderPanel';
import type { Block } from '~/lib/extractor';
import { SENTENCE_HIGHLIGHT } from '~/lib/highlighter';
import { I18nProvider, useT, useUiLanguage } from '~/lib/i18n';
import { pdfAssetUrls } from '~/lib/pdf/assets';
import { openPdf, type PdfDocument } from '~/lib/pdf/document';
import { pageBlock } from '~/lib/pdf/text-blocks';
import { buildReadingDoc, type ReadingDoc, type ReadingSentence } from '~/lib/reading-doc';
import { SettingsStore } from '~/lib/settings-store';
import '~/entrypoints/reader.content/styles.css';
import { renderCanvas, renderTextLayer } from './page-view';

/** The only zoom levels offered, as a readable choice instead of a slider. */
const SCALES = [1, 1.5] as const;

/** How long a hash id gets to be answered before it is called missing. */
const MISSING_TIMEOUT_MS = 2_000;

/** The page's root elements, all of which the HTML provides. */
const pagesEl = element('pdf-pages');
const chromeEl = element('pdf-chrome');
const host = element('sayloud-host');

const settings = new SettingsStore(browser.storage.local, browser.storage.onChanged);
const assets = pdfAssetUrls(browser.runtime.getURL(''));

/** What the strip above the pages is saying right now. */
type Notice = 'opening' | 'pick' | 'missing' | 'empty' | 'ready';

interface ChromeState {
  notice: Notice;
  scale: number;
  /** Non-null while a password is being asked for; `wrong` after a rejection. */
  password: { wrong: boolean } | null;
  /** Whether a document is open, which is what the zoom control needs to know. */
  open: boolean;
}

let chrome: ChromeState = { notice: 'pick', scale: 1, password: null, open: false };
let passwordResolve: ((value: string | null) => void) | null = null;
let passwordAttempts = 0;

/** One page's DOM and its place in the reading document. */
interface Slot {
  container: HTMLElement;
  page: PDFPageProxy | null;
  layer: HTMLElement | null;
  /** Null for a page with no readable text. */
  block: Block | null;
  /** The scale its layer was built at; a zoom makes every other layer stale. */
  scale: number;
  canvas: HTMLCanvasElement | null;
}

let pdf: PdfDocument | null = null;
let slots: Slot[] = [];
let current: ReadingDoc | null = null;
let controller: ReaderController | null = null;
let announced = false;
let scale: number = SCALES[0];
let initialRate = 1;
let appendStopped = false;
/** Bumped for every document opened, so a slow open cannot overwrite a newer one. */
let generation = 0;

/**
 * All page DOM work runs through one queue.
 *
 * Rendering, appending and zooming all mutate the same slots, and pdf.js will
 * refuse a second render on a page that is already painting. One chain makes
 * the order observable: whatever the reader asked for last runs last.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  queue = queue.then(task).catch((error: unknown) => {
    console.error('[SayLoud] the pdf viewer could not finish a page', error);
  });
  return queue;
}

/**
 * A doc whose contents can be swapped under the controller.
 *
 * `ReaderController` takes its document once, at construction, and the viewer
 * appends pages long after that. Redirecting through getters is what lets the
 * sentence list grow without rebuilding the controller (and without it ever
 * holding a document that has been replaced).
 */
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
      onScale={setScale}
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
  onScale: (scale: number) => void;
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

function ChromeBody({ state, onScale, onPick, onPassword }: ChromeProps) {
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
            {SCALES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={state.scale === value}
                onClick={() => onScale(value)}
              >
                {value}×
              </button>
            ))}
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
    await openBytes(bytes);
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
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return null;
}

async function pickFile(file: File): Promise<void> {
  try {
    await openBytes(await file.arrayBuffer());
  } catch (error) {
    console.error('[SayLoud] cannot read the chosen file', error);
    show('missing');
  }
}

async function openBytes(bytes: ArrayBuffer): Promise<void> {
  const run = ++generation;
  resetViewer();
  show('opening');

  let opened: PdfDocument;
  try {
    opened = await openPdf(bytes, assets, askPassword);
  } catch (error) {
    // A cancelled prompt is the reader's own choice; the rest are failures.
    if (run === generation) show(error === 'cancelled' ? 'pick' : 'missing');
    return;
  } finally {
    if (run === generation) {
      passwordAttempts = 0;
      chrome = { ...chrome, password: null };
    }
  }

  // Another file was chosen while this one was opening. Its own run owns the
  // page now; this document's worker would otherwise stay alive for nothing.
  if (run !== generation) {
    void opened.destroy().catch(() => undefined);
    return;
  }
  pdf = opened;

  if (pdf.pageCount === 0) {
    show('empty');
    return;
  }

  for (let number = 1; number <= pdf.pageCount; number++) {
    const container = document.createElement('div');
    container.className = 'pdf-page';
    container.dataset.page = String(number);
    pagesEl.appendChild(container);
    slots.push({ container, page: null, layer: null, block: null, scale, canvas: null });
  }
  chrome = { ...chrome, open: true };

  // The first page must be readable before the bar appears; everything else can
  // arrive while the reader is already listening.
  await enqueue(() => ensureText(1, run));
  if (run !== generation) return;
  show(current && current.sentences.length > 0 ? 'ready' : 'empty');

  initialRate = await settings
    .load()
    .then((loaded) => loaded.rate)
    .catch((error: unknown) => {
      console.error('[SayLoud] cannot read the saved rate', error);
      return 1;
    });

  controller = new ReaderController(host, { initialRate, settings, doc: redirect });
  controller.connect();
  announced = true;
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

  scheduleVisiblePages();
  for (let number = 2; number <= pdf.pageCount && !appendStopped; number++) {
    void enqueue(() => ensureText(number, run));
  }
}

/** Read one page's text layer, build its block and fold it into the document. */
async function ensureText(number: number, run = generation): Promise<void> {
  if (run !== generation) return;
  const slot = slots[number - 1];
  if (!slot) return;
  if (slot.layer && slot.scale === scale) return;

  if (slot.layer) {
    // A layer at another scale is stale geometry; its text nodes would move
    // nowhere when the page is redrawn.
    slot.container.replaceChildren();
    slot.layer = null;
    slot.canvas = null;
  }

  if (!slot.page) {
    if (!pdf) return;
    slot.page = await pdf.getPage(number);
  }
  const page = slot.page;
  const built = await renderTextLayer(page, scale, slot.container);
  slot.layer = built.layer;
  slot.scale = scale;
  slot.block = pageBlock(built.items, built.layer);
  syncDoc();
}

/** Paint a page that already has its text layer. */
async function paint(number: number, run = generation): Promise<void> {
  if (run !== generation) return;
  const slot = slots[number - 1];
  if (!slot || slot.canvas || !slot.page || !slot.layer) return;
  slot.canvas = await renderCanvas(slot.page, scale, slot.container);
}

/**
 * Fold the blocks into a document, appending only.
 *
 * If a rebuild would change the text of a sentence the engine already has, the
 * append is abandoned: a changed sentence is a different document, and the
 * engine would be reading offsets from the old one.
 */
function syncDoc(): void {
  if (appendStopped) return;

  const blocks = slots.map((slot) => slot.block).filter((block): block is Block => block !== null);
  const next = buildReadingDoc(blocks);
  const previous = current?.sentences ?? [];

  if (!isAppendOnly(previous, next.sentences)) {
    appendStopped = true;
    console.warn('[SayLoud] the pdf text order changed; keeping the sentences already read');
    return;
  }

  const grew = next.sentences.length > previous.length;
  const hadText = previous.length > 0;
  current = next;

  if (!hadText && next.sentences.length > 0 && chrome.notice === 'empty') show('ready');
  if (grew && announced) resend();

  // A later page arrived with the same block order but a new layer, which is
  // what a zoom looks like. The highlight has to point into the new nodes.
  if (!grew && hadText) refreshHighlight();
}

function isAppendOnly(
  previous: readonly ReadingSentence[],
  next: readonly ReadingSentence[]
): boolean {
  if (next.length < previous.length) return false;
  return previous.every((sentence, index) => next[index]?.text === sentence.text);
}

/**
 * Give the engine the document again, at the sentence being read.
 *
 * `resume` is what keeps a growing document from restarting playback: the
 * reader may have paused, and new pages are not a request to speak.
 */
function resend(): void {
  if (!controller || !current) return;
  const status = controller.getState().status;
  controller.sendCommand({
    type: 'load',
    sentences: current.sentences.map((sentence) => ({
      text: sentence.text,
      lang: sentence.lang,
    })),
    startIndex: status?.index ?? 0,
    rate: status?.rate ?? initialRate,
    resume: true,
  });
}

/** How many pages around the viewport are drawn: one before, one after. */
function visibleRange(): { first: number; last: number } {
  const viewport = pagesEl.clientHeight || window.innerHeight;
  const top = pagesEl.scrollTop - viewport;
  const bottom = pagesEl.scrollTop + viewport * 2;

  let first = -1;
  let last = -1;
  slots.forEach((slot, index) => {
    const start = slot.container.offsetTop;
    const end = start + slot.container.offsetHeight;
    if (end < top || start > bottom) return;
    if (first === -1) first = index;
    last = index;
  });

  // Before layout has run there is no page on screen yet; the first one is the
  // only sensible guess and the scroll listener corrects it.
  if (first === -1) return { first: 0, last: 0 };
  return { first, last };
}

function scheduleVisiblePages(): void {
  if (slots.length === 0) return;
  const { first, last } = visibleRange();

  slots.forEach((slot, index) => {
    if (index < first || index > last) {
      // The canvas is the expensive part; the text layer stays so the DOM
      // ranges the reader highlights remain attached.
      slot.canvas?.remove();
      slot.canvas = null;
      return;
    }

    void enqueue(async () => {
      await ensureText(index + 1);
      await paint(index + 1);
    });
  });
}

function setScale(next: number): void {
  if (next === scale || !pdf) return;
  scale = next;
  chrome = { ...chrome, scale: next };
  drawChrome();

  // Every page is now the wrong size. Visible ones are redrawn below; the rest
  // are cleared and rebuilt when they come back into view.
  for (const slot of slots) {
    slot.canvas?.remove();
    slot.canvas = null;
    slot.container.replaceChildren();
    slot.layer = null;
  }

  scheduleVisiblePages();
  // After the visible pages are back, point the sentence highlight at the new
  // text nodes: the controller's own range died with the old ones.
  void enqueue(async () => refreshHighlight());
}

/**
 * Re-place the sentence highlight after its text nodes were replaced.
 *
 * Reached through the registry rather than a second `Highlighter`: constructing
 * one would register its own objects under the same keys, and the controller's
 * later updates would then go to an instance nobody is drawing.
 */
function refreshHighlight(): void {
  const registry = (
    globalThis as {
      CSS?: { highlights?: Map<string, { clear(): void; add(range: Range): void }> };
    }
  ).CSS?.highlights;
  const highlight = registry?.get(SENTENCE_HIGHLIGHT);
  if (!highlight) return;

  const index = controller?.getState().status?.index;
  highlight.clear();
  if (index === undefined) return;

  const range = current?.rangeForSentence(index) ?? null;
  if (range) highlight.add(range);
}

/** Ask for a password, and remember where the answer goes. */
function askPassword(): Promise<string | null> {
  return new Promise((resolve) => {
    passwordResolve = resolve;
    chrome = { ...chrome, password: { wrong: passwordAttempts > 0 } };
    passwordAttempts += 1;
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
  controller?.dispose();
  controller = null;
  announced = false;
  render(null, host);
  window.close();
}

/** Tear down the previous document, if there was one. */
function resetViewer(): void {
  answerPassword(null);
  controller?.dispose();
  controller = null;
  announced = false;
  appendStopped = false;
  current = null;
  slots = [];
  pagesEl.replaceChildren();
  render(null, host);
  void pdf?.destroy().catch(() => undefined);
  pdf = null;
  chrome = { ...chrome, open: false, password: null };
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the pdf viewer is missing #${id}`);
  return found;
}

pagesEl.addEventListener('scroll', scheduleVisiblePages, { passive: true });
window.addEventListener('resize', scheduleVisiblePages);

start();
