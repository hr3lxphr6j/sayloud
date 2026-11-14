/**
 * Where the pdf.js runtime files live inside the extension.
 *
 * pdf.js does not import its worker, its cMap tables or the standard 14 fonts —
 * it fetches them by URL at run time, so the bundler never sees them and they
 * have to be copied into the package (see the `build:done` hook in
 * `wxt.config.ts`) and declared as web-accessible.
 *
 * Every URL is resolved from the extension origin rather than hard-coded to a
 * `chrome-extension://<id>/` prefix, because the id differs between a dev
 * profile, the store build and the e2e build.
 */
export interface PdfAssetUrls {
  /** The pdf.js worker module. Assigned to `GlobalWorkerOptions.workerSrc`. */
  workerSrc: string;
  /** Directory holding the cMap files, used for CJK encodings. Trailing slash required. */
  cMapUrl: string;
  /** Directory holding the standard font data. Trailing slash required. */
  standardFontDataUrl: string;
}

/**
 * Build the pdf.js asset URLs for an extension origin.
 *
 * `extensionOrigin` is `chrome.runtime.getURL('')`, which already ends in `/`;
 * a missing slash is added rather than assumed, because `…/abc` + `pdfjs/…`
 * would otherwise produce `chrome-extension://abcpdfjs/…`.
 */
export function pdfAssetUrls(extensionOrigin: string): PdfAssetUrls {
  const base = extensionOrigin.endsWith('/') ? extensionOrigin : `${extensionOrigin}/`;
  return {
    workerSrc: `${base}pdfjs/pdf.worker.min.mjs`,
    cMapUrl: `${base}pdfjs/cmaps/`,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
  };
}
