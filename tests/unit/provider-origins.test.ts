import { describe, expect, it, vi } from 'vitest';
import { requestProviderAccess, requiredOrigins } from '~/lib/provider-origins';

describe('requiredOrigins', () => {
  it('asks for the default Volcengine host', () => {
    expect(requiredOrigins({ provider: 'volcengine', apiKey: 'k' })).toEqual([
      'https://openspeech.bytedance.com/*',
    ]);
  });

  it('asks for the configured host only, without its path', () => {
    expect(
      requiredOrigins({
        provider: 'volcengine',
        apiKey: 'k',
        baseUrl: 'https://proxy.example.com:8443/tts/api/v3',
      })
    ).toEqual(['https://proxy.example.com:8443/*']);
  });

  it('asks for nothing for services that answer the CORS preflight', () => {
    expect(requiredOrigins({ provider: 'dashscope', apiKey: 'k' })).toEqual([]);
    expect(
      requiredOrigins({ provider: 'azure', subscriptionKey: 'k', region: 'eastasia' })
    ).toEqual([]);
    expect(requiredOrigins({ provider: 'browser' })).toEqual([]);
  });
});

describe('requestProviderAccess', () => {
  it('requests the origins synchronously, before the caller awaits', () => {
    const request = vi.fn(() => Promise.resolve(true));

    void requestProviderAccess({ provider: 'volcengine', apiKey: 'k' }, { request });

    // The user gesture is gone after the first await, so the call has to have
    // happened already.
    expect(request).toHaveBeenCalledWith({ origins: ['https://openspeech.bytedance.com/*'] });
  });

  it('reports a declined prompt', async () => {
    const request = vi.fn(() => Promise.resolve(false));

    await expect(
      requestProviderAccess({ provider: 'volcengine', apiKey: 'k' }, { request })
    ).resolves.toBe(false);
  });

  it('does not prompt when nothing is needed', async () => {
    const request = vi.fn(() => Promise.resolve(false));

    await expect(
      requestProviderAccess({ provider: 'dashscope', apiKey: 'k' }, { request })
    ).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
