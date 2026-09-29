/**
 * Shared MSW wiring for provider tests.
 *
 * Provider test files must start with `// @vitest-environment node`: MSW
 * patches Node's global `fetch`, but happy-dom installs its own `fetch` on the
 * Window object and MSW does not reach it, so under the default environment
 * every request would escape to the real network.
 *
 * `onUnhandledFrame: 'error'` (MSW 3's replacement for `onUnhandledRequest`)
 * makes that failure mode loud instead of letting a test pass because the real
 * network happened to refuse the connection.
 */
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const server = setupServer();

/** Register the MSW lifecycle hooks for the calling test file. */
export function useMswServer(): void {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

/** Build a `text/event-stream` body from provider event payloads. */
export function sse(...payloads: unknown[]): string {
  return payloads
    .map((payload) =>
      typeof payload === 'string'
        ? `data: ${payload}\n\n`
        : `event: result\ndata: ${JSON.stringify(payload)}\n\n`
    )
    .join('');
}

/** Base64 of `text`, as the providers send audio. */
export function base64Of(text: string): string {
  return btoa(text);
}
