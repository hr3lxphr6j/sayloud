/**
 * The style-vector read, with the checks that turn a bad read into a nameable
 * failure.
 *
 * The failure this exists for is a mirror that answers 200 with an error page:
 * the bytes land in the cache as if they were the voice, and every sentence
 * would then die on "byte length of Float32Array should be a multiple of 4" —
 * a message with no file, no source and no byte count in it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStyleVector } from '~/lib/models/voice-file';

/** A Response with `body` as its bytes. */
function responseOf(body: ArrayBuffer | string, status = 200): Response {
  return new Response(body, { status });
}

describe('readStyleVector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a cache hit that really is a style vector', async () => {
    const network = vi.fn();
    const vector = await readStyleVector(
      'af_heart',
      'key',
      async () => responseOf(new ArrayBuffer(522_240)),
      network
    );
    expect(vector.byteLength).toBe(522_240);
    expect(network).not.toHaveBeenCalled();
  });

  it('evicts a cache hit that is not, and reads the network instead', async () => {
    // A mirror that answered 200 with a page, once, poisons the bucket: without
    // the eviction the same bytes would be served to every sentence forever.
    const bucket = { deleted: [] as string[] };
    const globalCache = {
      open: async () => ({
        match: async () => undefined,
        delete: async (key: string) => {
          bucket.deleted.push(key);
        },
      }),
    };
    vi.stubGlobal('caches', globalCache);

    const vector = await readStyleVector(
      'af_heart',
      'the-key',
      async () => responseOf('<html>rate limited</html>'),
      async () => responseOf(new ArrayBuffer(522_240))
    );

    expect(vector.byteLength).toBe(522_240);
    expect(bucket.deleted).toEqual(['the-key']);
  });

  it('names the status of a request the mirror refused', async () => {
    await expect(
      readStyleVector(
        'af_heart',
        'the-key',
        async () => undefined,
        async () => responseOf('denied', 403)
      )
    ).rejects.toThrow('answered 403');
  });

  it('names the byte count when even the network is not a style vector', async () => {
    await expect(
      readStyleVector(
        'af_heart',
        'the-key',
        async () => undefined,
        async () => responseOf('<html>almost a page</html>')
      )
    ).rejects.toThrow('is not a style vector');
  });
});
