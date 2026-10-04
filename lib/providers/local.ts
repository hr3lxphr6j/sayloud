/**
 * The on-device provider (P4 spec §3.2, §3.12, §3.15).
 *
 * It is a `Provider` like any other — same `capabilities`, `listVoices`,
 * `validate`, `synthesize` — because everything above it (the audio worker, the
 * cache, the engine, the settings panel) should not need to know that the audio
 * came from this machine instead of a server. What differs is only what the
 * four methods do:
 *
 * - there are no credentials, so `validate` checks a *download* rather than a
 *   key;
 * - the voices are a static table, so `listVoices` never touches the network;
 * - synthesis is inference, so `concurrency` is 1 and there are no timings.
 *
 * **The engine is injected, not imported.** The offscreen document supplies it,
 * and nothing else does: `WorkerLocalEngine` starts a worker whose chunk
 * carries ONNX Runtime and a 21 MB wasm binary, and the side panel — which also
 * builds a provider registry, to render the settings form — must never be able
 * to load that. A dynamic `import()` would still emit the chunk and leave it
 * reachable from the side panel's bundle; leaving it out of this module
 * entirely is what makes the guarantee structural rather than a convention.
 */
import { durationMsFor, pcmToWav } from '../models/audio';
import type { Device, DevicePreference, DeviceProbe } from '../models/device';
import { DeviceUnavailableError, probeDevice, resolveDevice } from '../models/device';
import type { ModelCacheStorage } from '../models/downloader';
import { isWorkerDeadError, type OnDeviceEngine } from '../models/engine';
import {
  KOKORO_82M,
  type ModelTier,
  modelById,
  type OnDeviceModel,
  preferredTier,
  tierById,
} from '../models/registry';
import { modelKeysInCache, tierFilesPresent } from '../models/store';
import type { ModelSource } from '../models/urls';
import { errorMessage, ProviderError } from './errors';
import type {
  LocalConfig,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  SynthesisResult,
  SynthesizeRequest,
  Voice,
} from './types';
import { requireConfig } from './types';

/** The model used when the config names none. */
export const DEFAULT_MODEL_ID = KOKORO_82M.id;

/** One synthesis at a time: a single machine's GPU or CPU is the bottleneck. */
const CONCURRENCY = 1;

/** What one call may be given. Sentences are far shorter; this is a guard. */
const MAX_CHARS = 2000;

/** A resolved download source, plus whether the user chose it. */
export interface SourceResolution {
  readonly source: ModelSource;
  /** True when the source came from `auto`, so one retry against the other mirror is allowed. */
  readonly allowFallback: boolean;
}

export interface LocalProviderDeps {
  /**
   * Builds the engine on first use.
   *
   * Absent means `synthesize` cannot work — which is correct for the side
   * panel, where nothing synthesizes and where the engine's chunk must not be
   * loadable.
   */
  readonly createEngine?: (source: ModelSource, allowFallback: boolean) => Promise<OnDeviceEngine>;
  /** Where to ask for the download source. */
  readonly resolveSource?: () => Promise<SourceResolution>;
  /** Injected for tests; defaults to the page's Cache Storage. */
  readonly cacheStorage?: ModelCacheStorage;
  /** Injected for tests; defaults to probing `navigator.gpu`. */
  readonly probe?: () => Promise<DeviceProbe>;
}

/**
 * The language a voice speaks, from its id.
 *
 * The prefix is the reliable signal — it is how the model repository names its
 * voices, and it is the only thing a voice id carries — and it is what decides
 * which phonemization pipeline the engine uses. Getting it wrong sends the
 * sentence down the wrong frontend, which reads it as the wrong language rather
 * than failing: a `zh` voice with `en-US` phonemizes English text with the
 * Chinese word list.
 */
export function voiceLanguage(voiceId: string): string | undefined {
  const prefix = voiceId.slice(0, 2);
  if (prefix === 'zf' || prefix === 'zm') return 'zh-CN';
  if (prefix === 'jf' || prefix === 'jm') return 'ja-JP';
  if (prefix === 'af' || prefix === 'am') return 'en-US';
  if (prefix === 'bf' || prefix === 'bm') return 'en-GB';
  return undefined;
}

export class LocalProvider implements Provider {
  readonly id = 'local' as const;
  readonly name = 'On this device';

  private engine: Promise<OnDeviceEngine> | null = null;

  constructor(private readonly deps: LocalProviderDeps = {}) {}

  capabilities(config: ProviderConfig): ProviderCapabilities {
    // Read for its side effect: a mismatched config is a wiring bug.
    requireConfig(config, 'local');
    return { timings: 'none', maxChars: MAX_CHARS, concurrency: CONCURRENCY };
  }

  /**
   * The voices this model can speak.
   *
   * Filtered by the model's declared languages rather than returned wholesale:
   * a second model family would otherwise be offered the first one's voices.
   * The table is imported on demand, so the offscreen document — which only
   * synthesizes — never carries it.
   */
  async listVoices(config: ProviderConfig, _signal: AbortSignal): Promise<Voice[]> {
    const model = modelFor(requireConfig(config, 'local'));
    const { KOKORO_VOICES } = await import('./kokoro-voices');
    const languages = new Set(model.languages);
    return KOKORO_VOICES.filter(
      (voice) => voice.lang !== undefined && languages.has(voice.lang)
    ).map((voice) => ({ ...voice }));
  }

  /**
   * Whether this config could actually speak.
   *
   * There is no key to test, so what is checked is the thing that would fail
   * first: the tier's files have to be in Cache Storage. An offscreen document
   * that had to download 163 MB would be killed long before it finished
   * (spec §3.12.3), so "not downloaded" is a fact worth reporting early and
   * precisely.
   */
  async validate(config: ProviderConfig, _signal: AbortSignal): Promise<void> {
    const local = requireConfig(config, 'local');
    const model = modelFor(local);
    const tier = await tierFor(model, local);

    if (!(await this.isDownloaded(model, tier))) {
      throw new ProviderError(
        'model-missing',
        `${model.id} tier ${tier.id} has not been downloaded`
      );
    }
  }

  async synthesize(request: SynthesizeRequest, config: ProviderConfig): Promise<SynthesisResult> {
    const local = requireConfig(config, 'local');
    const model = modelFor(local);
    const tier = await tierFor(model, local);

    if (!(await this.isDownloaded(model, tier))) {
      throw new ProviderError(
        'model-missing',
        `${model.id} tier ${tier.id} has not been downloaded`
      );
    }

    const device = await this.deviceFor(local);
    const engine = await this.engineFor();

    try {
      // Idempotent for an unchanged tier and device, so this is cheap on every
      // sentence and only rebuilds when the user actually changed something.
      await engine.load(model, tier, device);

      const lang = local.lang ?? voiceLanguage(request.voiceId) ?? 'en-US';
      const { pcm, sampleRate } = await engine.synthesize(
        request.text,
        request.voiceId,
        lang,
        request.signal
      );

      // No timings, ever: Kokoro returns audio and nothing else, and SayLoud
      // highlights the whole sentence rather than estimating word positions.
      return {
        audio: pcmToWav(pcm, sampleRate),
        mime: 'audio/wav',
        durationMs: durationMsFor(pcm.length, sampleRate),
      };
    } catch (error) {
      // A worker that died cannot answer anything again, so this instance is
      // kept no longer: the next sentence builds a fresh one. Every other
      // failure — an unknown voice, a tier that will not load, an aborted
      // request — leaves the engine in place, because rebuilding it would pay
      // for the ONNX session a second time for an error that is not about it.
      if (isWorkerDeadError(error)) {
        this.engine = null;
        // Reported as a load failure rather than as itself: the code travels to
        // the panel, which has a sentence for "the model could not be loaded"
        // and none for a worker that stopped. The worker's own message is kept
        // as the detail, since it is the only actionable half.
        throw new ProviderError('model-load-failed', errorMessage(error), error);
      }
      throw error;
    }
  }

  private async isDownloaded(model: OnDeviceModel, tier: ModelTier): Promise<boolean> {
    const cacheStorage = this.deps.cacheStorage ?? globalThis.caches;
    return tierFilesPresent(model, tier, await modelKeysInCache(cacheStorage));
  }

  /** The device to run on, from the user's preference and the machine. */
  private async deviceFor(local: LocalConfig): Promise<Device> {
    const preference: DevicePreference = local.device ?? 'auto';
    if (preference === 'wasm') return 'wasm';

    const probe = this.deps.probe ?? probeThisMachine;
    const { caps } = await probe();
    try {
      return resolveDevice(preference, caps);
    } catch (error) {
      if (error instanceof DeviceUnavailableError) {
        throw new ProviderError('device-unavailable', error.message, error);
      }
      throw error;
    }
  }

  private engineFor(): Promise<OnDeviceEngine> {
    if (this.engine) return this.engine;

    const create = this.deps.createEngine;
    const resolve = this.deps.resolveSource;
    if (!create || !resolve) {
      return Promise.reject(
        new ProviderError(
          'unknown',
          'the local engine is not wired up in this context — only the offscreen document can synthesize on device'
        )
      );
    }

    this.engine = resolve().then(({ source, allowFallback }) => create(source, allowFallback));
    // A failed creation must not be remembered: the next sentence deserves a
    // fresh attempt rather than the same rejection forever.
    this.engine.catch(() => {
      this.engine = null;
    });
    return this.engine;
  }
}

/** The model a config names, falling back to the one P4 ships. */
function modelFor(local: LocalConfig): OnDeviceModel {
  const model = modelById(local.modelId ?? DEFAULT_MODEL_ID);
  if (!model) {
    throw new ProviderError('unknown', `unknown on-device model ${JSON.stringify(local.modelId)}`);
  }
  return model;
}

/**
 * The tier a config names, or the one this machine should use.
 *
 * The fallback is not "the first tier": it is what the device measurements
 * recommend, which is the whole reason `preferredTier` exists.
 */
async function tierFor(model: OnDeviceModel, local: LocalConfig): Promise<ModelTier> {
  if (local.tier !== undefined) {
    const named = tierById(model, local.tier);
    if (!named) {
      throw new ProviderError('unknown', `unknown tier ${JSON.stringify(local.tier)}`);
    }
    return named;
  }

  const caps = await probeThisMachine();
  const tier = preferredTier(model, caps.caps);
  if (!tier) throw new ProviderError('unknown', `${model.id} has no tiers`);
  return tier;
}

/** Measure the machine's GPU, through the DOM's own WebGPU typings. */
async function probeThisMachine(): Promise<DeviceProbe> {
  return probeDevice(navigator.gpu);
}
