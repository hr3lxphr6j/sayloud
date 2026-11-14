/**
 * Drawing one PDF page in the viewer.
 *
 * A page is two layers: a canvas with the pixels, and a text layer with one
 * absolutely positioned span per pdf.js text item. The text layer is what the
 * reader highlights and what a click lands in — the canvas is opaque and
 * carries no DOM.
 *
 * The text layer's shape is not decorative. `pageBlock` matches each item to
 * the layer child whose `nodeIndex` names it, and refuses a layer where an item
 * is missing, duplicated or backed by anything but a single text node. So every
 * item gets its own span here, including ones with an empty `str`: a skipped
 * empty item would shift every later index and throw.
 */
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist';
import type { PdfTextItem } from '~/lib/pdf/types';

/** A built text layer and the items it was built from, in the same order. */
export interface TextLayer {
  layer: HTMLElement;
  items: PdfTextItem[];
}

/** What pdf.js hands us for one item; only the geometry and the string matter. */
interface TextEntry {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
}

/**
 * Draw a page's text layer and its canvas into `container`.
 *
 * The caller owns the container and clears it before a redraw; this function
 * appends to whatever is already there, canvas first so the text sits above it.
 * The container is sized to the viewport, which is also what makes the page's
 * place in the scroll list correct before the canvas has painted.
 */
export async function renderPage(
  pdfPage: PDFPageProxy,
  scale: number,
  container: HTMLElement
): Promise<TextLayer> {
  await renderCanvas(pdfPage, scale, container);
  return renderTextLayer(pdfPage, scale, container);
}

/**
 * Build only the text layer.
 *
 * Text has to be available for the whole document, not just the pages near the
 * viewport: the reader needs their sentences, and their blocks need the live
 * text nodes that the highlights point into. The canvas is the expensive part,
 * so it is rendered separately and only when a page is close to the viewport.
 */
export async function renderTextLayer(
  pdfPage: PDFPageProxy,
  scale: number,
  container: HTMLElement
): Promise<TextLayer> {
  const viewport = pdfPage.getViewport({ scale });
  sizeContainer(container, viewport);

  const content = await pdfPage.getTextContent({ includeMarkedContent: false });
  const layer = document.createElement('div');
  layer.className = 'pdf-text-layer';

  const items: PdfTextItem[] = [];
  for (const entry of content.items) {
    // Marked-content markers have no `str` and no text of their own.
    if (!('str' in entry)) continue;
    const nodeIndex = items.length;
    items.push({ str: entry.str, hasEOL: entry.hasEOL ?? false, nodeIndex });
    layer.appendChild(textItemElement(entry, viewport));
  }

  container.appendChild(layer);
  return { layer, items };
}

/** Paint the page's pixels. Returns the canvas so the caller can unload it. */
export async function renderCanvas(
  pdfPage: PDFPageProxy,
  scale: number,
  container: HTMLElement
): Promise<HTMLCanvasElement> {
  const viewport = pdfPage.getViewport({ scale });
  sizeContainer(container, viewport);

  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-page-canvas';
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  await pdfPage.render({
    canvas,
    viewport,
    ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
  }).promise;

  // The text layer may already be in the container (it is built for every page,
  // while the canvas is not), so the canvas goes underneath it rather than
  // after it.
  container.insertBefore(canvas, container.firstChild);
  return canvas;
}

/** One span, one text node — the exact shape `pageBlock` validates. */
function textItemElement(entry: TextEntry, viewport: PageViewport): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'pdf-text-item';
  span.dir = entry.dir || 'ltr';
  // `textContent = ''` would leave no child at all; a Text node is created
  // explicitly so an empty item still satisfies the one-node rule.
  span.appendChild(document.createTextNode(entry.str));

  const tx = multiply(viewport.transform, entry.transform);
  const fontHeight = Math.hypot(tx[2], tx[3]);
  span.style.left = `${tx[4]}px`;
  span.style.top = `${tx[5] - fontHeight}px`;
  span.style.fontSize = `${fontHeight}px`;

  const angle = Math.atan2(tx[1], tx[0]);
  if (angle !== 0) span.style.transform = `rotate(${angle}rad)`;

  return span;
}

/** Size the page box before anything is appended to it, so layout does not jump. */
function sizeContainer(container: HTMLElement, viewport: PageViewport): void {
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;
}

/**
 * `m1 × m2` for PDF's 3×2 affine matrices, matching pdf.js's own `Util.transform`.
 *
 * The viewport transform maps pdf.js's bottom-up text space onto the page; the
 * item transform places one run of text inside it.
 */
function multiply(m1: number[], m2: number[]): [number, number, number, number, number, number] {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = m1;
  const [a2 = 0, b2 = 0, c2 = 0, d2 = 0, e2 = 0, f2 = 0] = m2;

  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}
