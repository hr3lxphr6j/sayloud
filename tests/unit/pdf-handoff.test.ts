import { describe, expect, it, vi } from 'vitest';
import {
  createPdfHandoff,
  decideActivation,
  decodeBase64,
  encodeBase64,
  type TabScriptingApi,
  type TabsApi,
} from '~/lib/pdf/handoff';

const VIEWER_URL = 'chrome-extension://abc/pdf-viewer.html';

describe('decideActivation', () => {
  it('ignores the viewer page itself before anything else', () => {
    // A second viewer would nest inside the one already showing the document,
    // so even a `#…` hash that happens to name a PDF must not reopen it.
    expect(decideActivation({ url: `${VIEWER_URL}#missing`, hasPort: false })).toEqual({
      kind: 'ignore',
      reason: 'own-viewer',
    });
  });

  it('opens the viewer for a url that ends in .pdf, without probing', () => {
    expect(decideActivation({ url: 'https://example.com/a.pdf', hasPort: false })).toEqual({
      kind: 'viewer',
    });
  });

  it('reads a file: pdf, which has no other way to be recognised', () => {
    expect(decideActivation({ url: 'file:///tmp/a.pdf', hasPort: false })).toEqual({
      kind: 'viewer',
    });
  });

  it('follows Chrome’s built-in viewer to the document it opened', () => {
    expect(
      decideActivation({
        url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?https://example.com/a.pdf',
        hasPort: false,
      })
    ).toEqual({ kind: 'viewer' });
  });

  it('prefers the url over an active port', () => {
    // The `.pdf` check comes first: a port in a PDF tab means the reader was
    // injected before this build learned about PDFs, not that the tab is prose.
    expect(decideActivation({ url: 'https://example.com/a.pdf', hasPort: true })).toEqual({
      kind: 'viewer',
    });
  });

  it('ignores a tab the reader is already in, before asking for its MIME type', () => {
    // No probe: the content type cannot change the answer, and injecting a
    // script to learn it would be paid for on every repeat click.
    expect(decideActivation({ url: 'https://example.com/article', hasPort: true })).toEqual({
      kind: 'ignore',
      reason: 'already-active',
    });
    expect(
      decideActivation({
        url: 'https://example.com/article',
        hasPort: true,
        contentType: 'application/pdf',
      })
    ).toEqual({ kind: 'ignore', reason: 'already-active' });
  });

  it('asks for the content type when nothing cheaper answers', () => {
    expect(decideActivation({ url: 'https://arxiv.org/pdf/2301.12345', hasPort: false })).toEqual({
      kind: 'probe',
    });
  });

  it('asks for the content type on a tab without a url', () => {
    expect(decideActivation({ url: undefined, hasPort: false })).toEqual({ kind: 'probe' });
  });

  it('opens the viewer for a PDF served from an extension-less url', () => {
    expect(
      decideActivation({
        url: 'https://arxiv.org/pdf/2301.12345',
        hasPort: false,
        contentType: 'application/pdf',
      })
    ).toEqual({ kind: 'viewer' });
  });

  it('reads an html page, and one whose content type could not be read', () => {
    expect(
      decideActivation({
        url: 'https://example.com/article',
        hasPort: false,
        contentType: 'text/html',
      })
    ).toEqual({ kind: 'reader' });
    // `null` is "the page would not answer" — restricted pages reject the
    // injection, and the reader injection is what reports that.
    expect(
      decideActivation({ url: 'chrome://settings', hasPort: false, contentType: null })
    ).toEqual({ kind: 'reader' });
  });
});

describe('base64', () => {
  function bytes(...values: number[]): ArrayBuffer {
    return new Uint8Array(values).buffer;
  }

  it('round-trips an empty buffer', () => {
    expect(new Uint8Array(decodeBase64(encodeBase64(bytes()))).byteLength).toBe(0);
  });

  it('round-trips bytes that are not ASCII', () => {
    const original = bytes(0, 1, 0x7f, 0x80, 0xff, 0x25);
    expect([...new Uint8Array(decodeBase64(encodeBase64(original)))]).toEqual([
      0, 1, 0x7f, 0x80, 0xff, 0x25,
    ]);
  });

  it('round-trips a buffer larger than one chunk', () => {
    // The encoder walks the buffer in 0x8000-byte slices; a buffer that is one
    // byte past a chunk boundary is where an off-by-one would drop or repeat.
    const original = new Uint8Array(0x8000 + 1).map((_, index) => index % 256);
    const decoded = new Uint8Array(decodeBase64(encodeBase64(original.buffer)));
    expect(decoded.byteLength).toBe(original.byteLength);
    expect(decoded).toEqual(original);
  });
});

describe('createPdfHandoff', () => {
  function handoff(result: unknown, reject = false) {
    const executeScript = reject
      ? vi.fn(() => Promise.reject(new Error('cannot inject')))
      : vi.fn(() => Promise.resolve([{ result }]));
    const scripting: TabScriptingApi = { executeScript };
    const create = vi.fn(() => Promise.resolve({}));
    const tabs: TabsApi = { create };
    return {
      handoff: createPdfHandoff({ scripting, tabs, viewerUrl: VIEWER_URL }),
      executeScript,
      create,
    };
  }

  it('reports the content type the page answered with', async () => {
    const { handoff: pdf, executeScript } = handoff('application/pdf');
    expect(await pdf.contentTypeOf(7)).toBe('application/pdf');
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7 } }));
  });

  it('answers null for a page it may not inspect', async () => {
    const { handoff: pdf } = handoff(undefined, true);
    expect(await pdf.contentTypeOf(7)).toBeNull();
  });

  it('opens the viewer on a missing document when the tab gives no bytes', async () => {
    // Not a dead end: the viewer says the document could not be read and
    // offers the file picker, which is the failure the user can act on.
    const { handoff: pdf, create } = handoff(undefined);
    await pdf.openInViewer(7);
    expect(create).toHaveBeenCalledWith({ url: `${VIEWER_URL}#missing` });
  });
});
