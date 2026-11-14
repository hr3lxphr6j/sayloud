/**
 * Which tabs hold a PDF, and the one-shot handoff of its bytes to the viewer.
 *
 * A PDF tab has no prose for the reader's extractor, and the extension cannot
 * read Chrome's built-in viewer from the inside, so the toolbar click fetches
 * the document in the tab and passes it to `pdf-viewer.html` through the
 * service worker. That handoff is a module-level map rather than storage: the
 * bytes are worth nothing after the viewer has them, and `storage` would keep a
 * copy of every PDF on disk.
 */

/** How long staged bytes wait for the viewer before they are dropped. */
export const PDF_BYTES_TTL_MS = 60_000;

/** Chrome's PDF viewer, which reports itself instead of the document it shows. */
const BUILT_IN_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

interface Staged {
  bytes: ArrayBuffer;
  expires: ReturnType<typeof setTimeout>;
}

const staged = new Map<string, Staged>();

/**
 * Whether the tab is showing a PDF.
 *
 * `tab.url` is the document, not Chrome's viewer: under the built-in viewer it
 * is still the PDF's own URL, which is why the trailing `.pdf` check is the
 * whole rule for local and online files alike. The viewer forms below are kept
 * because older Chrome builds did report the viewer page, with the document in
 * its query.
 */
export function isPdfTab(tab: { url?: string; title?: string }): boolean {
  const url = tab.url;
  if (!url) return false;
  // Already the reader: opening a second viewer would nest one inside another.
  if (isOwnViewer(url)) return false;
  return isPdfUrl(isBuiltInViewer(url) ? documentInViewer(url) : url);
}

/** Stage bytes for the viewer and return the id that claims them. */
export function stagePdfBytes(bytes: ArrayBuffer): string {
  const id = crypto.randomUUID();
  const expires = setTimeout(() => {
    staged.delete(id);
  }, PDF_BYTES_TTL_MS);
  // Node (and therefore the unit tests) would otherwise keep the process alive
  // for the whole minute; a browser timer has no such handle.
  unref(expires);
  staged.set(id, { bytes, expires });
  return id;
}

/** Take the bytes staged under `id`, which can only be done once. */
export function takePdfBytes(id: string): ArrayBuffer | null {
  const entry = staged.get(id);
  if (!entry) return null;
  staged.delete(id);
  clearTimeout(entry.expires);
  return entry.bytes;
}

function isOwnViewer(url: string): boolean {
  return url.startsWith('chrome-extension://') && url.includes('pdf-viewer.html');
}

function isBuiltInViewer(url: string): boolean {
  return url.startsWith(BUILT_IN_VIEWER) || url.includes('/pdf_viewer.html');
}

/** The document URL a built-in viewer page was opened on, or an empty string. */
function documentInViewer(url: string): string {
  const query = url.split('#')[0]?.split('?').slice(1).join('?') ?? '';
  for (const entry of query.split('&')) {
    const separator = entry.indexOf('=');
    const raw = separator === -1 ? entry : entry.slice(separator + 1);
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      continue;
    }
    if (/^(https?|file):/i.test(value)) return value;
  }
  return '';
}

/** The path of `url`, without its query or hash, ending in `.pdf`. */
function isPdfUrl(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? '';
  return path.toLowerCase().endsWith('.pdf');
}

/** `setTimeout` returns a number in a browser and a handle with `unref` in Node. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
}
