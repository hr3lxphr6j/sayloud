/**
 * Recognising a PDF tab, and getting its bytes into the viewer.
 *
 * A PDF tab has no prose for the reader's extractor, and the extension cannot
 * read Chrome's built-in viewer from the inside, so a toolbar click has to
 * fetch the document in the tab itself and hand it to `pdf-viewer.html` through
 * the service worker. Both halves live here: the decision of which path a click
 * takes (`decideActivation`) and the two injections that implement the PDF one
 * (`createPdfHandoff`).
 *
 * The browser APIs arrive as narrow interfaces, like `SessionRouter` and
 * `OffscreenManager` do, so the branches are unit-tested without a browser.
 * What cannot be narrowed away is the page side: a function passed to
 * `scripting.executeScript({ func })` is serialised and run in the tab, so it
 * cannot close over anything in this module — not even `encodeBase64`. The two
 * base64 loops are deliberately separate copies.
 */

import { isOwnViewerUrl, isPdfTab, stagePdfBytes } from './tab';

/** The viewer's hash when the document could not be fetched at all. */
const MISSING_PDF = 'missing';

/** The slice of `chrome.scripting` this module uses. */
export interface TabScriptingApi {
  executeScript(injection: {
    target: { tabId: number };
    func: () => unknown;
  }): Promise<Array<{ result?: unknown }>>;
}

/** The slice of `chrome.tabs` this module uses. */
export interface TabsApi {
  create(options: { url: string }): Promise<unknown>;
}

export interface PdfHandoffDeps {
  scripting: TabScriptingApi;
  tabs: TabsApi;
  /** The viewer page's absolute URL, from `runtime.getURL`. */
  viewerUrl: string;
}

/** What the toolbar click can do with a tab. */
export interface PdfHandoff {
  /** The tab's own MIME type, or null when it cannot be inspected. */
  contentTypeOf(tabId: number): Promise<string | null>;
  /** Fetch the PDF in its own tab and open the viewer on the result. */
  openInViewer(tabId: number): Promise<void>;
}

export interface ActivationInput {
  /** The tab's URL. Absent for a tab the browser would not describe. */
  url: string | undefined;
  /** Whether the tab already holds a reader content script. */
  hasPort: boolean;
  /**
   * `document.contentType`, once the page has been asked.
   *
   * Omitted means "not asked yet", which is a decision of its own: probing
   * injects a script, and the branches above it make that unnecessary. `null`
   * means the page could not answer, and the reader path is all that is left.
   */
  contentType?: string | null;
}

/** What `activate` should do with the clicked tab. */
export type ActivationDecision =
  | { kind: 'ignore'; reason: 'own-viewer' | 'already-active' }
  | { kind: 'viewer' }
  | { kind: 'reader' }
  /** Ask the page for its content type, then decide again. */
  | { kind: 'probe' };

/**
 * Which path a toolbar click takes.
 *
 * The order is the behaviour, not an implementation detail:
 *
 * 1. SayLoud's own viewer first. A second viewer would nest inside the one
 *    already showing the document the click was aimed at.
 * 2. A URL that ends in `.pdf` next, because it is the cheap answer and the
 *    only one a `file:` tab has.
 * 3. Then the active port. A page the reader is already in is not a PDF, and a
 *    repeat click should not pay for an injection to find that out — which is
 *    also why the probe comes after this branch rather than before it.
 * 4. Only then the MIME type: a PDF served from an extension-less URL
 *    (`arxiv.org/pdf/2301.12345`, a `/download?id=…` link) is recognisable no
 *    other way.
 *
 * `title` is not part of the input: `isPdfTab` reads the URL alone, and a title
 * that says "paper.pdf" is a page about a PDF, not one.
 */
export function decideActivation({
  url,
  hasPort,
  contentType,
}: ActivationInput): ActivationDecision {
  if (url && isOwnViewerUrl(url)) return { kind: 'ignore', reason: 'own-viewer' };
  if (isPdfTab({ url })) return { kind: 'viewer' };
  if (hasPort) return { kind: 'ignore', reason: 'already-active' };
  if (contentType === undefined) return { kind: 'probe' };
  return contentType === 'application/pdf' ? { kind: 'viewer' } : { kind: 'reader' };
}

/** The two injections, wired to the browser APIs the worker has. */
export function createPdfHandoff({ scripting, tabs, viewerUrl }: PdfHandoffDeps): PdfHandoff {
  /**
   * The clicked tab's own MIME type, or null when it cannot be inspected.
   *
   * Injected under `activeTab`, granted by the click that got us here.
   * `executeScript` rejects on pages the extension may not touch (chrome://, the
   * Web Store, another extension's page); none of them has prose to read
   * either, so the caller carries on and the reader injection reports it.
   */
  async function contentTypeOf(tabId: number): Promise<string | null> {
    try {
      const [injection] = await scripting.executeScript({
        target: { tabId },
        func: contentTypeInPage,
      });
      const value = injection?.result;
      return typeof value === 'string' ? value : null;
    } catch (error) {
      console.warn('[SayLoud] cannot inspect this tab', error);
      return null;
    }
  }

  /**
   * The original tab is left alone: the user can read the PDF itself while the
   * sayloud bar reads it from the copy in the viewer. A fetch that fails is not
   * a dead end — the viewer says the document could not be read and offers the
   * file picker, which is the failure the user can act on.
   */
  async function openInViewer(tabId: number): Promise<void> {
    let bytes: ArrayBuffer | null = null;
    try {
      bytes = await readPdfInTab(tabId);
    } catch (error) {
      console.warn('[SayLoud] cannot fetch the pdf from this tab', error);
    }

    const hash = bytes ? stagePdfBytes(bytes) : MISSING_PDF;
    await tabs.create({ url: `${viewerUrl}#${hash}` });
  }

  /**
   * Ask the document for its own bytes.
   *
   * It has to be the page that fetches: the document is same-origin there, the
   * session cookies are already sent, and `file:` is reachable at all only
   * through the tab's own access. The result is base64 because an
   * `executeScript` result is JSON-serialised and an `ArrayBuffer` is not.
   */
  async function readPdfInTab(tabId: number): Promise<ArrayBuffer> {
    const [injection] = await scripting.executeScript({
      target: { tabId },
      func: readDocumentInPage,
    });
    const encoded = injection?.result;
    if (typeof encoded !== 'string' || encoded.length === 0) {
      throw new Error('the tab returned no pdf bytes');
    }
    return decodeBase64(encoded);
  }

  return { contentTypeOf, openInViewer };
}

/**
 * `runtime.sendMessage` is JSON-only, so the bytes travel as base64.
 *
 * The viewer decodes this back into the `ArrayBuffer` it opens. Chunked
 * `fromCharCode` avoids spreading a multi-megabyte array into an argument list.
 */
export function encodeBase64(bytes: ArrayBuffer): string {
  const octets = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < octets.byteLength; index += chunk) {
    binary += String.fromCharCode(...octets.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** The other end of `encodeBase64`, for the viewer's own `#…` bytes. */
export function decodeBase64(encoded: string): ArrayBuffer {
  const binary = atob(encoded);
  const octets = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    octets[index] = binary.charCodeAt(index);
  }
  return octets.buffer;
}

/**
 * Runs in the tab, not in the worker.
 *
 * `document.contentType` is the response's own MIME type as Chrome decided to
 * render it. It is the only thing that recognises a PDF served from an
 * extension-less URL, and it says `text/html` for a page, which is what sends
 * the click down the reader path.
 *
 * Self-contained on purpose: `executeScript` serialises this function, so it
 * must not reference anything from this module.
 */
function contentTypeInPage(): string {
  return document.contentType;
}

/**
 * Runs in the PDF tab, not in the worker.
 *
 * `credentials: 'include'` keeps the request identical to the one that loaded
 * the document, so a PDF behind a session cookie is readable too. The base64
 * loop is a copy of `encodeBase64`'s rather than a call to it: this function is
 * serialised into the page, where `encodeBase64` does not exist.
 */
async function readDocumentInPage(): Promise<string> {
  const response = await fetch(location.href, { credentials: 'include' });
  if (!response.ok) throw new Error(`the pdf answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('the pdf is empty');

  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.byteLength; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
