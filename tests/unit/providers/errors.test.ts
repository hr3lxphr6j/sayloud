import { describe, expect, it } from 'vitest';
import { createTranslator } from '~/lib/i18n';
import {
  errorFromStatus,
  errorMessage,
  formatProviderError,
  isAbortError,
  isProviderError,
  messageFromBody,
  networkError,
  ProviderError,
  type ProviderErrorCode,
  providerErrorSummary,
  readBodyText,
} from '~/lib/providers/errors';
import { requireConfig } from '~/lib/providers/types';

describe('ProviderError', () => {
  it('carries the unified code, message and details', () => {
    const details = { status: 401 };
    const error = new ProviderError('invalid-key', 'bad key', details);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProviderError');
    expect(error.code).toBe('invalid-key');
    expect(error.message).toBe('bad key');
    expect(error.details).toBe(details);
  });

  it('is optional to supply details', () => {
    expect(new ProviderError('unknown', 'nope').details).toBeUndefined();
  });
});

describe('isProviderError', () => {
  it('recognizes only ProviderError', () => {
    expect(isProviderError(new ProviderError('unknown', 'x'))).toBe(true);
    expect(isProviderError(new Error('x'))).toBe(false);
    expect(isProviderError('x')).toBe(false);
    expect(isProviderError(null)).toBe(false);
  });
});

describe('isAbortError', () => {
  it('recognizes an AbortError', () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(isAbortError(aborted)).toBe(true);
  });

  it('rejects other errors and non-errors', () => {
    expect(isAbortError(new Error('nope'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('networkError', () => {
  it('wraps the cause and keeps its message', () => {
    const cause = new TypeError('Failed to fetch');
    const error = networkError(cause);

    expect(error.code).toBe('network-error');
    expect(error.message).toBe('Failed to fetch');
    expect(error.details).toBe(cause);
  });

  it('stringifies a non-Error cause', () => {
    expect(networkError('socket hang up').message).toBe('socket hang up');
  });
});

describe('errorFromStatus', () => {
  it.each([
    [401, 'invalid-key'],
    [403, 'invalid-key'],
    [402, 'no-quota'],
    [429, 'rate-limit'],
    [500, 'service-unavailable'],
    [503, 'service-unavailable'],
    [400, 'unknown'],
    [404, 'unknown'],
    [418, 'unknown'],
  ])('maps %i to %s', (status, code) => {
    const details = { status };
    const error = errorFromStatus(status, `HTTP ${status}`, details);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe(code);
    expect(error.message).toBe(`HTTP ${status}`);
    expect(error.details).toBe(details);
  });
});

describe('messageFromBody', () => {
  it('prefers a nested error.message', () => {
    expect(messageFromBody('{"error":{"message":"nested"}}', 'fallback')).toBe('nested');
  });

  it.each(['message', 'msg', 'Message', 'error_msg', 'detail'])('reads a top-level %s', (key) => {
    expect(messageFromBody(JSON.stringify({ [key]: 'top level' }), 'fallback')).toBe('top level');
  });

  it('reads a bare JSON string', () => {
    expect(messageFromBody('"just a string"', 'fallback')).toBe('just a string');
  });

  it('falls back when the body is empty or whitespace', () => {
    expect(messageFromBody('', 'fallback')).toBe('fallback');
    expect(messageFromBody('   ', 'fallback')).toBe('fallback');
  });

  it('falls back when JSON carries no usable message', () => {
    expect(messageFromBody('{"code":45000030}', 'fallback')).toBe('{"code":45000030}');
    expect(messageFromBody('{"message":""}', 'fallback')).toBe('{"message":""}');
  });

  it('returns plain text as-is', () => {
    expect(messageFromBody('Bad Gateway', 'fallback')).toBe('Bad Gateway');
  });

  it('truncates an over-long body', () => {
    const message = messageFromBody('x'.repeat(250), 'fallback');

    expect(message).toHaveLength(201);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('readBodyText', () => {
  it('reads the body', async () => {
    const response = new Response('hello');
    await expect(readBodyText(response)).resolves.toBe('hello');
  });

  it('returns an empty string when reading fails', async () => {
    const response = {
      text: () => Promise.reject(new Error('stream already consumed')),
    } as unknown as Response;

    await expect(readBodyText(response)).resolves.toBe('');
  });
});

describe('requireConfig', () => {
  it('returns the matching config', () => {
    const config = { provider: 'elevenlabs', apiKey: 'k' } as const;

    expect(requireConfig(config, 'elevenlabs')).toBe(config);
  });

  it('throws when the config belongs to another provider', () => {
    const config = { provider: 'azure', subscriptionKey: 'k', region: 'eastasia' } as const;

    expect(() => requireConfig(config, 'elevenlabs')).toThrowError(ProviderError);
    expect(() => requireConfig(config, 'elevenlabs')).toThrowError(
      /expected a elevenlabs config, received azure/
    );
  });
});

describe('errorMessage', () => {
  it('reads the message of an Error, which includes a DOMException', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new DOMException('gone', 'TimeoutError'))).toBe('gone');
  });

  it('falls back to the name of a rejection reason that is not an Error', () => {
    expect(errorMessage({ name: 'TimeoutError' })).toBe('TimeoutError');
  });

  it('stringifies anything else', () => {
    expect(errorMessage('boom')).toBe('boom');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('providerErrorSummary', () => {
  const t = createTranslator('en');
  /** The line the panel shows, which is what a user reads. */
  const describe = (error: unknown): string => formatProviderError(providerErrorSummary(error), t);

  it('leads with what the code means and appends the provider message', () => {
    const described = describe(new ProviderError('invalid-key', 'InvalidApiKey'));

    expect(described).toMatch(/^The API key was rejected/);
    expect(described).toContain('(InvalidApiKey)');
  });

  it('has a message for every code', () => {
    const codes: ProviderErrorCode[] = [
      'invalid-key',
      'service-unavailable',
      'rate-limit',
      'no-quota',
      'network-error',
      'unknown',
    ];

    for (const code of codes) {
      const described = describe(new ProviderError(code, ''));
      expect(described).not.toBe('');
      expect(described).not.toMatch(/undefined/);
    }
  });

  it('translates the same failure into the other language', () => {
    const summary = providerErrorSummary(new ProviderError('invalid-key', ''));

    expect(formatProviderError(summary, createTranslator('zh-CN'))).toMatch(/^API 密钥被拒绝/);
  });

  it('does not repeat a message that says the same thing as the code', () => {
    const summary = describe(new ProviderError('no-quota', ''));

    expect(describe(new ProviderError('no-quota', summary))).toBe(summary);
  });

  it('reports a cancellation as one, not as a failure', () => {
    expect(describe(new DOMException('aborted', 'AbortError'))).toBe('The request was cancelled.');
  });

  it('says so plainly when the failure is not a provider error', () => {
    expect(describe(new Error('boom'))).toBe('Unexpected failure: boom.');
    expect(describe(undefined)).toBe('Unexpected failure: undefined.');
  });

  it('never leaks the provider details, which can hold a whole response body', () => {
    const error = new ProviderError('unknown', 'nope', { body: 'secret-token-abc' });

    expect(describe(error)).not.toContain('secret-token-abc');
  });
});
