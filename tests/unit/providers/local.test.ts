/**
 * The on-device provider, from the side that has to decide what to do when the
 * engine behind it dies.
 *
 * The engine is injected, which is what makes this testable without a worker,
 * a model or a GPU — and what makes the failure worth testing: a worker that
 * crashed cannot answer any later request, so the provider has to notice and
 * build a fresh engine rather than retrying into a corpse.
 */
import { describe, expect, it } from 'vitest';
import {
  type DeviceInfo,
  type OnDeviceEngine,
  type RawPcm,
  WORKER_DEAD,
} from '~/lib/models/engine';
import { KOKORO_82M } from '~/lib/models/registry';
import { canonicalModelUrl, TRANSFORMERS_CACHE } from '~/lib/models/urls';
import { LocalProvider } from '~/lib/providers/local';
import type { LocalConfig, SynthesizeRequest } from '~/lib/providers/types';
import { FakeCaches, requireTier } from '../models/fakes';

const CONFIG: LocalConfig = { provider: 'local', modelId: 'kokoro-82m', tier: 'fp16' };

/** An engine whose failures the test chooses. */
class FakeEngine implements OnDeviceEngine {
  readonly family = 'kokoro' as const;
  loads = 0;
  disposed = 0;
  /** Thrown by `load` when set; null means it succeeds. */
  failure: Error | null = null;

  async load(): Promise<DeviceInfo> {
    this.loads += 1;
    if (this.failure) throw this.failure;
    return { device: 'webgpu', sessionInitMs: 1 };
  }

  async synthesize(): Promise<RawPcm> {
    return { pcm: new Float32Array(24), sampleRate: 24_000 };
  }

  dispose(): void {
    this.disposed += 1;
  }
}

/** The failure a crashed worker produces: the name is the whole contract. */
function deadWorkerError(message = 'the GPU process went away'): Error {
  const error = new Error(message);
  error.name = WORKER_DEAD;
  return error;
}

function request(text = 'hello'): SynthesizeRequest {
  return { text, voiceId: 'af_heart', signal: new AbortController().signal };
}

/** A provider whose tier is on disk, with engines built by `makeEngine`. */
function setup(makeEngine: (index: number) => FakeEngine = () => new FakeEngine()) {
  const caches = new FakeCaches();
  const tier = requireTier(KOKORO_82M, 'fp16');
  const bucket = caches.bucket(TRANSFORMERS_CACHE);
  for (const file of tier.files) bucket.seed(canonicalModelUrl(KOKORO_82M.repo, file));

  const engines: FakeEngine[] = [];
  const provider = new LocalProvider({
    cacheStorage: caches,
    probe: async () => ({ caps: { webgpu: true, shaderF16: true } }),
    resolveSource: async () => ({ source: { host: 'modelscope' }, allowFallback: false }),
    createEngine: async () => {
      const engine = makeEngine(engines.length);
      engines.push(engine);
      return engine;
    },
  });

  return { provider, engines, caches, bucket, tier };
}

describe('LocalProvider', () => {
  it('builds one engine and reuses it across sentences', async () => {
    const { provider, engines } = setup();

    await provider.synthesize(request(), CONFIG);
    await provider.synthesize(request('a second sentence'), CONFIG);

    expect(engines).toHaveLength(1);
    // Loading the same tier twice reuses the session rather than rebuilding it.
    expect(engines[0]?.loads).toBe(2);
  });

  it('builds a new engine after the worker behind the old one died', async () => {
    const { provider, engines } = setup((index) => {
      const engine = new FakeEngine();
      if (index === 0) engine.failure = deadWorkerError();
      return engine;
    });

    await expect(provider.synthesize(request(), CONFIG)).rejects.toThrow(
      'the GPU process went away'
    );
    expect(engines).toHaveLength(1);

    // The next sentence must not be answered by the engine that just died.
    await expect(provider.synthesize(request(), CONFIG)).resolves.toBeDefined();
    expect(engines).toHaveLength(2);
  });

  it('keeps the engine when the failure is not about the worker', async () => {
    const { provider, engines } = setup((index) => {
      const engine = new FakeEngine();
      if (index === 0) engine.failure = new Error('voice af_heart does not exist');
      return engine;
    });

    await expect(provider.synthesize(request(), CONFIG)).rejects.toThrow('does not exist');
    // Retrying is the caller's business; rebuilding would pay for the ONNX
    // session a second time for an error that was never about the engine.
    await expect(provider.synthesize(request(), CONFIG)).rejects.toThrow('does not exist');

    expect(engines).toHaveLength(1);
  });

  it('reports a missing tier before building anything', async () => {
    const caches = new FakeCaches();
    const engines: FakeEngine[] = [];
    const provider = new LocalProvider({
      cacheStorage: caches,
      probe: async () => ({ caps: { webgpu: true, shaderF16: true } }),
      resolveSource: async () => ({ source: { host: 'modelscope' }, allowFallback: false }),
      createEngine: async () => {
        const engine = new FakeEngine();
        engines.push(engine);
        return engine;
      },
    });

    await expect(provider.validate(CONFIG, new AbortController().signal)).rejects.toMatchObject({
      code: 'model-missing',
    });

    // Nothing is downloaded and nothing is built: the check exists to fail
    // early, not to discover the problem after a 163 MB session build.
    expect(engines).toHaveLength(0);
  });

  it('speaks from a tier that is on disk', async () => {
    const { provider } = setup();

    await expect(provider.validate(CONFIG, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('refuses to synthesize in a context with no engine factory', async () => {
    // The side panel builds this provider to render its settings form and must
    // never be able to reach ONNX Runtime — so the missing factory is the
    // guarantee, and it has to produce a message rather than a hang.
    const caches = new FakeCaches();
    const tier = requireTier(KOKORO_82M, 'fp16');
    const bucket = caches.bucket(TRANSFORMERS_CACHE);
    for (const file of tier.files) bucket.seed(canonicalModelUrl(KOKORO_82M.repo, file));

    const provider = new LocalProvider({
      cacheStorage: caches,
      probe: async () => ({ caps: { webgpu: true, shaderF16: true } }),
    });

    await expect(provider.synthesize(request(), CONFIG)).rejects.toThrow('not wired up');
  });
});
