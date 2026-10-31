import { describe, expect, it, vi } from 'vitest';
import { hasProviderAccess, requestProviderAccess, requiredOrigins } from '~/lib/provider-origins';

describe('requiredOrigins', () => {
  it('asks for the default Volcengine host', () => {
    expect(requiredOrigins({ provider: 'volcengine', apiKey: 'k' })).toEqual([
      'https://openspeech.bytedance.com/*',
    ]);
  });

  it('asks for nothing when a custom baseUrl points at an undeclared host', () => {
    // Chrome only grants origins listed in `optional_host_permissions`, and
    // that list is `openspeech.bytedance.com` alone. A proxy has to answer the
    // CORS preflight itself.
    expect(
      requiredOrigins({
        provider: 'volcengine',
        apiKey: 'k',
        baseUrl: 'https://proxy.example.com:8443/tts/api/v3',
      })
    ).toEqual([]);
  });

  it('drops the path from a baseUrl on the declared host', () => {
    expect(
      requiredOrigins({
        provider: 'volcengine',
        apiKey: 'k',
        baseUrl: 'https://openspeech.bytedance.com/tts/api/v3',
      })
    ).toEqual(['https://openspeech.bytedance.com/*']);
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

describe('hasProviderAccess', () => {
  it('needs nothing for a service that answers the preflight', async () => {
    const contains = vi.fn(() => Promise.resolve(false));

    await expect(
      hasProviderAccess({ provider: 'dashscope', apiKey: 'k' }, { request: vi.fn(), contains })
    ).resolves.toBe(true);
    expect(contains).not.toHaveBeenCalled();
  });

  it('asks whether the grant is already there, without prompting', async () => {
    const contains = vi.fn(() => Promise.resolve(true));

    await expect(
      hasProviderAccess({ provider: 'volcengine', apiKey: 'k' }, { request: vi.fn(), contains })
    ).resolves.toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ['https://openspeech.bytedance.com/*'] });
  });

  it('reports no access when there is no way to ask', async () => {
    await expect(
      hasProviderAccess({ provider: 'volcengine', apiKey: 'k' }, undefined)
    ).resolves.toBe(false);
    await expect(
      hasProviderAccess({ provider: 'volcengine', apiKey: 'k' }, { request: vi.fn() })
    ).resolves.toBe(false);
  });
});
