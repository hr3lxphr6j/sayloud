import { describe, expect, it } from 'vitest';
import { pdfAssetUrls } from '~/lib/pdf/assets';

describe('pdfAssetUrls', () => {
  it('points worker, cmaps and standard fonts at the extension origin', () => {
    const urls = pdfAssetUrls('chrome-extension://abc/');
    expect(urls.workerSrc).toBe('chrome-extension://abc/pdfjs/pdf.worker.min.mjs');
    expect(urls.cMapUrl).toBe('chrome-extension://abc/pdfjs/cmaps/');
    expect(urls.standardFontDataUrl).toBe('chrome-extension://abc/pdfjs/standard_fonts/');
  });

  it('adds the missing trailing slash instead of gluing the path onto the host', () => {
    const urls = pdfAssetUrls('chrome-extension://abc');
    expect(urls.workerSrc).toBe('chrome-extension://abc/pdfjs/pdf.worker.min.mjs');
    expect(urls.cMapUrl).toBe('chrome-extension://abc/pdfjs/cmaps/');
    expect(urls.standardFontDataUrl).toBe('chrome-extension://abc/pdfjs/standard_fonts/');
  });
});
