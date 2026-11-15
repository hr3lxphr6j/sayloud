/**
 * Getting a document's bytes into the viewer page.
 *
 * The bytes come from two places — the worker, which holds the ones the icon
 * click staged, and the page's own `fetch`, for a redirect the page followed
 * itself — and both hand back something that has to be turned into an
 * `ArrayBuffer`. None of it touches the viewer's state, so it lives apart from
 * the page and is tested on its own.
 */

import { browser } from 'wxt/browser';
import { isPdfBytesResponse, PDF_BYTES } from '~/lib/pdf/protocol';

/** How long a hash id gets to be answered before it is called missing. */
const MISSING_TIMEOUT_MS = 2_000;

/** The name a download falls back to when the document arrived without one. */
export const DEFAULT_DOCUMENT_NAME = 'document.pdf';

/**
 * Ask the service worker for the staged bytes.
 *
 * The handler belongs to a later task; until it exists a missing answer is the
 * expected one, so a rejection and a timeout are treated the same. The timeout
 * is for a worker that accepted the message and never answered.
 */
export function requestBytes(id: string): Promise<ArrayBuffer | null> {
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
        .sendMessage({ type: PDF_BYTES, id })
        .then((reply: unknown) => {
          finish(
            isPdfBytesResponse(reply) && reply.type === PDF_BYTES
              ? toArrayBuffer(reply.bytes)
              : null
          );
        })
        .catch(() => finish(null));
    } catch {
      finish(null);
    }
  });
}

/** A readable name from the URL's last path segment. */
export function documentNameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop();
    if (name) return decodeURIComponent(name);
  } catch {
    // The fetch already succeeded, so this is only a label; fall through.
  }
  return DEFAULT_DOCUMENT_NAME;
}

export function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  // The worker cannot send an `ArrayBuffer`: `runtime.sendMessage` is JSON-only,
  // so the bytes arrive as base64 and are rebuilt here.
  if (typeof value === 'string') return fromBase64(value);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return null;
}

export function fromBase64(encoded: string): ArrayBuffer | null {
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
