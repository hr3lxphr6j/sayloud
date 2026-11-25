/**
 * Reading a voice's style vector, with the checks that make a bad read name
 * its cause.
 *
 * Split out of the engine because it is the one part of synthesis that talks
 * to a file rather than to the model, and because its failure modes — a mirror
 * that answers 200 with an error page, a cache entry that holds one — are
 * worth testing without an ONNX session in the room.
 */
import { KOKORO_VOICES_CACHE } from './urls';

/**
 * A style vector read out of a response, with the checks that make a bad read
 * name its cause.
 *
 * The bytes have to be a float array, or the model's `style` tensor cannot be
 * built from them — and the failure a caller would otherwise see is a bare
 * "byte length of Float32Array should be a multiple of 4" that says nothing
 * about which file, from where, was wrong. A cache hit that fails the check is
 * evicted and the fetch is retried once: a response that *looked* like a
 * success when it was downloaded (a mirror answering 200 with an error page)
 * must not be served to every sentence forever.
 *
 * The shape is deliberately the same for both sources, so the caller stays
 * ignorant of which one answered.
 *
 * @param voiceId the voice the file belongs to, for the error messages.
 * @param key the Cache Storage key the file lives under, and the URL the
 *   network fetch goes to (the engine's fetch patch resolves it).
 * @param cached the cache lookup, so the caller owns its bucket.
 * @param network the fetch, so the caller owns its patch.
 */
export async function readStyleVector(
  voiceId: string,
  key: string,
  cached: () => Promise<Response | undefined>,
  network: () => Promise<Response>
): Promise<Float32Array> {
  const hit = await cached();
  if (hit) {
    const vector = await styleVector(voiceId, hit, `cache: ${key}`);
    if (vector) return vector;
    // The cache held bytes that are not a style vector — an error page some
    // mirror once answered with a 200. Evict it and give the network its
    // chance, instead of serving the same bad bytes to every sentence.
    const bucket = await caches.open(KOKORO_VOICES_CACHE);
    await bucket.delete(key);
  }

  const response = await network();
  if (!response.ok) {
    throw new Error(`the voice file request for ${voiceId} answered ${response.status} (${key})`);
  }
  const vector = await styleVector(voiceId, response, key);
  if (!vector) {
    throw new Error(
      `the voice file for ${voiceId} is not a style vector: ${response.url} did not answer with one`
    );
  }
  return vector;
}

/** The style vector in `response`, or `undefined` when the bytes are not one. */
async function styleVector(
  voiceId: string,
  response: Response,
  from: string
): Promise<Float32Array | undefined> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) {
    console.warn(
      `[SayLoud] the voice file for ${voiceId} is not a style vector: ${buffer.byteLength} bytes from ${from}`
    );
    return undefined;
  }
  return new Float32Array(buffer);
}
