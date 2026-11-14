import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPdfTab, stagePdfBytes, takePdfBytes } from '~/lib/pdf/tab';

describe('isPdfTab', () => {
  it('recognises a local pdf', () => {
    expect(isPdfTab({ url: 'file:///tmp/a.pdf' })).toBe(true);
  });

  it('recognises an online pdf and ignores its query', () => {
    expect(isPdfTab({ url: 'https://example.com/a.pdf?x=1' })).toBe(true);
  });

  it('is not fooled by an ordinary page', () => {
    expect(isPdfTab({ url: 'https://example.com/article' })).toBe(false);
  });

  it('ignores the hash and the case of the extension', () => {
    expect(isPdfTab({ url: 'https://example.com/A.PDF#page=2' })).toBe(true);
  });

  it('does not treat the pdf viewer page as a document to read', () => {
    expect(
      isPdfTab({
        url: 'chrome-extension://abc/pdf-viewer.html#3f4d2c1a-0000-4000-8000-000000000000',
      })
    ).toBe(false);
  });

  it('follows the built-in viewer to the document it opened', () => {
    expect(
      isPdfTab({
        url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?https://example.com/a.pdf',
      })
    ).toBe(true);
    expect(
      isPdfTab({
        url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?https://example.com/a',
      })
    ).toBe(false);
  });

  it('answers false for a tab without a url', () => {
    expect(isPdfTab({})).toBe(false);
  });
});

describe('staged pdf bytes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands the bytes over exactly once', () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const id = stagePdfBytes(bytes);

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const taken = takePdfBytes(id);
    expect(taken).not.toBeNull();
    expect(new Uint8Array(taken as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));

    expect(takePdfBytes(id)).toBeNull();
  });

  it('gives every document its own id', () => {
    const first = stagePdfBytes(new ArrayBuffer(1));
    const second = stagePdfBytes(new ArrayBuffer(1));
    expect(first).not.toBe(second);
  });

  it('drops bytes nobody asked for within a minute', () => {
    vi.useFakeTimers();
    const id = stagePdfBytes(new ArrayBuffer(1));

    vi.advanceTimersByTime(59_000);
    expect(takePdfBytes(id)).not.toBeNull();
  });

  it('deletes staged bytes after sixty seconds', () => {
    vi.useFakeTimers();
    const id = stagePdfBytes(new ArrayBuffer(1));

    vi.advanceTimersByTime(60_000);
    expect(takePdfBytes(id)).toBeNull();
  });
});
