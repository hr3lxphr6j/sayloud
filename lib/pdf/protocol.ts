/**
 * The one-shot handoff of a PDF's bytes from the service worker to the viewer.
 *
 * The toolbar click fetches the document in its own tab and stages the bytes in
 * the worker; the viewer, which cannot reach that tab, asks for them by the id
 * in its own fragment. Both ends of that exchange are written here because the
 * shape is a decision, not a detail: a viewer that asks with the wrong `type`
 * gets no answer at all, and the failure is a page that sits on its "opening"
 * card until the timeout rather than an error anyone can see.
 *
 * The bytes are base64. `runtime.sendMessage` is JSON-only and an `ArrayBuffer`
 * does not survive the trip, so the worker encodes and the viewer decodes.
 */

/** The viewer asking for the bytes staged under `id`. */
export const PDF_BYTES = 'pdf-bytes';

/** The worker's answer when the id is unknown or already claimed. */
export const PDF_MISSING = 'pdf-missing';

export interface PdfBytesRequest {
  type: typeof PDF_BYTES;
  id: string;
}

export interface PdfBytesReply {
  type: typeof PDF_BYTES;
  /** Base64, because the reply channel is JSON. */
  bytes: string;
}

export interface PdfMissingReply {
  type: typeof PDF_MISSING;
}

export type PdfBytesResponse = PdfBytesReply | PdfMissingReply;

/** True for a well-formed request. */
export function isPdfBytesRequest(value: unknown): value is PdfBytesRequest {
  return isMessage(value, PDF_BYTES) && typeof (value as { id?: unknown }).id === 'string';
}

/** True for either reply — the bytes, or the news that there are none. */
export function isPdfBytesResponse(value: unknown): value is PdfBytesResponse {
  if (isMessage(value, PDF_MISSING)) return true;
  return isMessage(value, PDF_BYTES) && typeof (value as { bytes?: unknown }).bytes === 'string';
}

function isMessage(value: unknown, type: string): value is { type: string } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === type;
}
