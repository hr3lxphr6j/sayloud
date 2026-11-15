import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCUMENT_NAME,
  documentNameFromUrl,
  fromBase64,
  toArrayBuffer,
} from '~/entrypoints/pdf-viewer/load-bytes';

/** The bytes of a buffer, so a test reads as the document it stands for. */
function bytesOf(buffer: ArrayBuffer | null): number[] {
  if (!buffer) throw new Error('expected bytes');
  return Array.from(new Uint8Array(buffer));
}

describe('fromBase64', () => {
  it('rebuilds the bytes the worker encoded', () => {
    // PDF's own magic is `%PDF`; `AQID` is the same idea in three bytes.
    expect(bytesOf(fromBase64('AQID'))).toEqual([1, 2, 3]);
  });

  it('keeps bytes above ascii intact', () => {
    expect(bytesOf(fromBase64('/wA='))).toEqual([255, 0]);
  });

  it('turns an empty string into an empty buffer', () => {
    expect(bytesOf(fromBase64(''))).toEqual([]);
  });

  it('reports a string that is not base64 as missing bytes', () => {
    expect(fromBase64('!!!')).toBeNull();
  });
});

describe('toArrayBuffer', () => {
  it('passes an ArrayBuffer through untouched', () => {
    const original = new Uint8Array([1, 2, 3]).buffer;
    expect(toArrayBuffer(original)).toBe(original);
  });

  it('decodes the base64 a message can carry', () => {
    expect(bytesOf(toArrayBuffer('AQID'))).toEqual([1, 2, 3]);
  });

  it('copies a view rather than its whole backing store', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    expect(bytesOf(toArrayBuffer(backing.subarray(1, 4)))).toEqual([1, 2, 3]);
  });

  it('reports a reply that carries no bytes as missing', () => {
    expect(toArrayBuffer(null)).toBeNull();
    expect(toArrayBuffer(42)).toBeNull();
  });
});

describe('documentNameFromUrl', () => {
  it('takes the last path segment', () => {
    expect(documentNameFromUrl('https://example.com/papers/attention.pdf')).toBe('attention.pdf');
  });

  it('decodes the escapes a url carries', () => {
    expect(documentNameFromUrl('https://example.com/attention%20is%20all.pdf')).toBe(
      'attention is all.pdf'
    );
    expect(documentNameFromUrl('https://example.com/%E4%B8%AD%E6%96%87.pdf')).toBe('中文.pdf');
  });

  it('ignores the query and the fragment', () => {
    expect(documentNameFromUrl('https://example.com/a/b.pdf?x=1#page=2')).toBe('b.pdf');
  });

  it('falls back when the url names no file', () => {
    expect(documentNameFromUrl('https://example.com/')).toBe(DEFAULT_DOCUMENT_NAME);
    expect(documentNameFromUrl('https://example.com')).toBe(DEFAULT_DOCUMENT_NAME);
  });

  it('falls back when the url cannot be read at all', () => {
    expect(documentNameFromUrl('not a url')).toBe(DEFAULT_DOCUMENT_NAME);
    expect(documentNameFromUrl('https://example.com/%E4%B8.pdf')).toBe(DEFAULT_DOCUMENT_NAME);
  });
});
