import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { PdfAssetUrls } from '~/lib/pdf/assets';
import { openPdf } from '~/lib/pdf/document';

interface RecordedCall {
  params: Record<string, unknown>;
  dataByteLength: number;
}

const { calls } = vi.hoisted(() => ({ calls: [] as RecordedCall[] }));

/**
 * Wrap pdf.js only to observe what `openPdf` passes in. Parsing stays real:
 * a stub would make the fixture assertions meaningless.
 */
vi.mock('pdfjs-dist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdfjs-dist')>();
  return {
    ...actual,
    getDocument: (params: Parameters<typeof actual.getDocument>[0]) => {
      const data = (params as { data?: ArrayBuffer | Uint8Array }).data;
      calls.push({
        params: { ...(params as Record<string, unknown>) },
        dataByteLength: data?.byteLength ?? -1,
      });
      return actual.getDocument(params);
    },
  };
});

/**
 * The test process cannot load a `chrome-extension://` worker, so the assets
 * point at the vendored pdf.js files. Production passes the real extension
 * origin (see `pdfAssetUrls`); nothing below reaches the network.
 */
const PDFJS_ROOT = join(process.cwd(), 'node_modules/pdfjs-dist');

function localAssetUrl(path: string, trailingSlash = false): string {
  const url = pathToFileURL(join(PDFJS_ROOT, path)).href;
  return trailingSlash ? `${url}/` : url;
}

const assets: PdfAssetUrls = {
  workerSrc: localAssetUrl('build/pdf.worker.min.mjs'),
  cMapUrl: localAssetUrl('cmaps', true),
  standardFontDataUrl: localAssetUrl('standard_fonts', true),
};

function fixture(name: string): ArrayBuffer {
  const buffer = readFileSync(join(process.cwd(), 'tests/fixtures/pdf', name));
  // `readFileSync` may hand out a view into a shared pool, so copy the exact range.
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

function neverAsked(): Mock<() => Promise<string | null>> {
  return vi.fn(async () => null);
}

beforeEach(() => {
  calls.length = 0;
});

describe('openPdf', () => {
  it('opens an unencrypted document and returns its text items in emission order', async () => {
    const askPassword = neverAsked();

    const doc = await openPdf(fixture('hello.pdf'), assets, askPassword);
    const page = await doc.getPageText(1);

    expect(doc.pageCount).toBe(1);
    expect(page.pageNumber).toBe(1);
    expect(page.items.map((item) => item.str).join(' ')).toContain('Hello');
    expect(page.items.map((item) => item.nodeIndex)).toEqual(page.items.map((_, index) => index));
    for (const item of page.items) {
      expect(typeof item.str).toBe('string');
      expect(typeof item.hasEOL).toBe('boolean');
    }
    expect(askPassword).not.toHaveBeenCalled();

    await doc.destroy();
  });

  it('rejects empty bytes before parsing and without asking for a password', async () => {
    const askPassword = neverAsked();

    await expect(openPdf(new ArrayBuffer(0), assets, askPassword)).rejects.toBe('empty');

    expect(askPassword).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('rejects non-empty bytes that pdf.js cannot parse as invalid', async () => {
    await expect(
      openPdf(new Uint8Array([1, 2, 3, 4, 5]).buffer, assets, neverAsked())
    ).rejects.toBe('invalid');
  });

  it('rejects the encrypted fixture as cancelled when the prompt is dismissed', async () => {
    const askPassword = neverAsked();

    await expect(openPdf(fixture('encrypted.pdf'), assets, askPassword)).rejects.toBe('cancelled');

    expect(askPassword).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('re-prompts after a wrong password and opens on the correct one', async () => {
    const askPassword = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce('secret');

    const doc = await openPdf(fixture('encrypted.pdf'), assets, askPassword);
    const page = await doc.getPageText(1);

    expect(askPassword).toHaveBeenCalledTimes(2);
    // A wrong password must retry inside the one task instead of re-parsing.
    expect(calls).toHaveLength(1);
    expect(doc.pageCount).toBe(1);
    expect(page.items.map((item) => item.str).join(' ')).toContain('Hello');

    await doc.destroy();
  });

  it('gives up as password after three wrong answers instead of prompting a fourth time', async () => {
    const askPassword = vi.fn(async () => 'wrong');

    await expect(openPdf(fixture('encrypted.pdf'), assets, askPassword)).rejects.toBe('password');

    expect(askPassword).toHaveBeenCalledTimes(3);
    expect(calls).toHaveLength(1);
  });

  it('disables eval and passes the bundled asset locations to pdf.js', async () => {
    const doc = await openPdf(fixture('hello.pdf'), assets, neverAsked());
    await doc.destroy();

    expect(calls).toHaveLength(1);
    const { params, dataByteLength } = calls[0] as RecordedCall;
    expect(params.data).toBeInstanceOf(Uint8Array);
    expect(dataByteLength).toBe(fixture('hello.pdf').byteLength);
    expect(params.isEvalSupported).toBe(false);
    expect(params.useSystemFonts).toBe(false);
    expect(params.cMapPacked).toBe(true);
    expect(params.cMapUrl).toBe(assets.cMapUrl);
    expect(params.standardFontDataUrl).toBe(assets.standardFontDataUrl);
    expect(GlobalWorkerOptions.workerSrc).toBe(assets.workerSrc);
  });

  it('tears the pdf.js document down on destroy', async () => {
    const doc = await openPdf(fixture('hello.pdf'), assets, neverAsked());
    await doc.getPageText(1);

    await expect(doc.destroy()).resolves.toBeUndefined();
    await expect(doc.getPageText(1)).rejects.toThrow();
  });
});
