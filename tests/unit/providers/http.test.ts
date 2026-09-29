// @vitest-environment node
// MSW intercepts Node's global fetch; happy-dom installs its own `fetch` on
// the Window, which MSW does not patch, so provider tests run under node.
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { isProviderError } from '~/lib/providers/errors';
import {
  concatChunks,
  decodeBase64,
  ensureOk,
  errorResponse,
  isRecord,
  parseJsonChunks,
  parseSse,
  readArray,
  readFirstNumber,
  readFirstString,
  readNumber,
  readRecord,
  readString,
  sendRequest,
} from '~/lib/providers/http';
import { server, useMswServer } from './server';

useMswServer();

const URL_UNDER_TEST = 'https://example.test/tts';

describe('sendRequest', () => {
  it('returns the response for a successful request', async () => {
    server.use(http.post(URL_UNDER_TEST, () => HttpResponse.text('ok')));

    const response = await sendRequest(URL_UNDER_TEST, { method: 'POST' });

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe('ok');
  });

  it('returns a non-2xx response instead of throwing, so callers can read the body', async () => {
    server.use(
      http.post(URL_UNDER_TEST, () => HttpResponse.json({ code: 'InvalidApiKey' }, { status: 401 }))
    );

    const response = await sendRequest(URL_UNDER_TEST, { method: 'POST' });

    expect(response.status).toBe(401);
  });

  it('maps a transport failure to a network-error', async () => {
    server.use(http.post(URL_UNDER_TEST, () => HttpResponse.error()));

    await expect(sendRequest(URL_UNDER_TEST, { method: 'POST' })).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'network-error',
    });
  });

  it('rethrows an abort untouched', async () => {
    server.use(http.post(URL_UNDER_TEST, () => HttpResponse.text('late')));

    const controller = new AbortController();
    controller.abort();

    // Aborts are a caller decision (seek/stop), so they must not be wrapped —
    // otherwise every skip would look like a provider failure.
    await expect(
      sendRequest(URL_UNDER_TEST, { method: 'POST', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ensureOk', () => {
  it('passes a 2xx through', async () => {
    await expect(ensureOk(new Response('fine', { status: 200 }))).resolves.toBeUndefined();
  });

  it('maps the status and body message', async () => {
    const response = new Response(JSON.stringify({ message: 'quota exhausted' }), { status: 402 });

    await expect(ensureOk(response)).rejects.toMatchObject({
      code: 'no-quota',
      message: 'quota exhausted',
    });
  });

  it('falls back to the status when the body has no message', async () => {
    await expect(ensureOk(new Response('', { status: 503 }))).rejects.toMatchObject({
      code: 'service-unavailable',
      message: 'HTTP 503',
    });
  });
});

describe('errorResponse', () => {
  it('uses the caller fallback when the body carries no message', async () => {
    const error = await errorResponse(new Response('', { status: 400 }), 'bad request');

    expect(error.message).toBe('bad request');
    expect(error.code).toBe('unknown');
  });

  it('keeps the status and body in details for the error UI', async () => {
    const error = await errorResponse(new Response('nope', { status: 429 }), 'fallback');

    expect(error.details).toEqual({ status: 429, body: 'nope' });
  });
});

describe('decodeBase64', () => {
  const bytesOf = (buffer: ArrayBuffer): number[] => Array.from(new Uint8Array(buffer));

  it('decodes standard base64', () => {
    expect(bytesOf(decodeBase64(btoa('hello')))).toEqual([...'hello'].map((c) => c.charCodeAt(0)));
  });

  it('decodes URL-safe base64', () => {
    // 0xfb 0xff encodes to "+/8=" in standard base64 and "-_8=" URL-safe.
    const standard = bytesOf(decodeBase64('+/8='));
    const urlSafe = bytesOf(decodeBase64('-_8='));

    expect(urlSafe).toEqual(standard);
    expect(urlSafe).toEqual([0xfb, 0xff]);
  });

  it('tolerates missing padding and embedded whitespace', () => {
    expect(bytesOf(decodeBase64('aGVs\nbG8'))).toEqual([...'hello'].map((c) => c.charCodeAt(0)));
  });

  it('decodes an empty string to no bytes', () => {
    expect(decodeBase64('').byteLength).toBe(0);
  });
});

describe('concatChunks', () => {
  it('joins chunks in order', () => {
    const first = new Uint8Array([1, 2]).buffer;
    const second = new Uint8Array([3]).buffer;

    expect(Array.from(new Uint8Array(concatChunks([first, second])))).toEqual([1, 2, 3]);
  });

  it('returns an empty buffer for no chunks', () => {
    expect(concatChunks([]).byteLength).toBe(0);
  });
});

describe('parseSse', () => {
  it('parses a named event', () => {
    expect(parseSse('event: result\ndata: {"a":1}\n\n')).toEqual([
      { event: 'result', data: '{"a":1}' },
    ]);
  });

  it('parses an event with no name', () => {
    expect(parseSse('data: hello\n\n')).toEqual([{ event: undefined, data: 'hello' }]);
  });

  it('joins multiple data lines with newlines', () => {
    expect(parseSse('data: a\ndata: b\n\n')).toEqual([{ event: undefined, data: 'a\nb' }]);
  });

  it('skips comment lines', () => {
    expect(parseSse(': keep-alive\ndata: x\n\n')).toEqual([{ event: undefined, data: 'x' }]);
  });

  it('handles CRLF line endings', () => {
    expect(parseSse('event: result\r\ndata: x\r\n\r\n')).toEqual([{ event: 'result', data: 'x' }]);
  });

  it('accepts a field with no space after the colon', () => {
    expect(parseSse('data:{"a":1}\n\n')).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it('flushes a final event that has no trailing blank line', () => {
    expect(parseSse('data: tail')).toEqual([{ event: undefined, data: 'tail' }]);
  });

  it('parses several events in one body', () => {
    expect(parseSse('data: 1\n\ndata: 2\n\n')).toEqual([
      { event: undefined, data: '1' },
      { event: undefined, data: '2' },
    ]);
  });

  it('ignores an event block with no data', () => {
    expect(parseSse('event: ping\n\ndata: x\n\n')).toEqual([{ event: undefined, data: 'x' }]);
  });

  it('returns nothing for an empty body', () => {
    expect(parseSse('')).toEqual([]);
  });
});

describe('parseJsonChunks', () => {
  it('parses newline-delimited JSON', () => {
    expect(parseJsonChunks('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('parses objects that are concatenated without a separator', () => {
    expect(parseJsonChunks('{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('keeps nested objects as one chunk', () => {
    expect(parseJsonChunks('{"a":{"b":[1,2]}}')).toEqual([{ a: { b: [1, 2] } }]);
  });

  it('does not treat braces inside strings as structure', () => {
    expect(parseJsonChunks('{"a":"}{"}')).toEqual([{ a: '}{' }]);
  });

  it('honours escaped quotes inside strings', () => {
    expect(parseJsonChunks('{"a":"he said \\"hi\\""}')).toEqual([{ a: 'he said "hi"' }]);
  });

  it('skips a malformed frame without discarding the rest', () => {
    expect(parseJsonChunks('{bad}{"ok":1}')).toEqual([{ ok: 1 }]);
  });

  it('ignores a trailing partial object', () => {
    expect(parseJsonChunks('{"a":1}{"b":')).toEqual([{ a: 1 }]);
  });

  it('ignores non-JSON noise between objects', () => {
    expect(parseJsonChunks('chunk 1\n{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it('returns nothing for an empty body', () => {
    expect(parseJsonChunks('')).toEqual([]);
  });
});

describe('record readers', () => {
  it('isRecord accepts objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('reads the right primitive type and ignores the rest', () => {
    const record = { text: 'hi', count: 3, list: [1], nested: { a: 1 }, bad: Number.NaN };

    expect(readString(record, 'text')).toBe('hi');
    expect(readString(record, 'count')).toBeUndefined();
    expect(readNumber(record, 'count')).toBe(3);
    expect(readNumber(record, 'text')).toBeUndefined();
    expect(readNumber(record, 'bad')).toBeUndefined();
    expect(readArray(record, 'list')).toEqual([1]);
    expect(readArray(record, 'text')).toBeUndefined();
    expect(readRecord(record, 'nested')).toEqual({ a: 1 });
    expect(readRecord(record, 'list')).toBeUndefined();
  });

  it('falls back across field aliases', () => {
    const record = { word: 'hi', start_time: 10 };

    expect(readFirstString(record, ['text', 'word'])).toBe('hi');
    expect(readFirstString(record, ['missing', 'word'])).toBe('hi');
    expect(readFirstString(record, ['missing'])).toBeUndefined();
    expect(readFirstNumber(record, ['startMs', 'start_time'])).toBe(10);
    expect(readFirstNumber(record, ['missing'])).toBeUndefined();
  });

  it('produces ProviderError instances for status mapping', async () => {
    const error = await errorResponse(new Response('', { status: 500 }), 'boom');

    expect(isProviderError(error)).toBe(true);
  });
});
