/**
 * The on-device engine seam (P4 spec §3.8).
 *
 * One family is one adapter. Adding a model family should mean adding an
 * `OnDeviceEngine` and a registry entry — not touching the manager, the
 * provider, or the UI — so this interface is deliberately the whole contract:
 * load a tier onto a device, synthesize a sentence, and let go.
 *
 * It lives outside the worker it usually runs in. `WorkerLocalEngine` is the
 * implementation that talks to the offscreen document's nested worker, and
 * `FakeLocalEngine` is the one the e2e build uses, because CI cannot download a
 * 92–325 MB model and the whole point of the seam is that it does not have to.
 */
import { abortError } from '../providers/errors';
import type { Device } from './device';
import type { ModelTier, OnDeviceFamily, OnDeviceModel } from './registry';

/**
 * The `name` an engine error carries when the worker behind it is gone.
 *
 * Told apart from an ordinary failure because the fix is different: a voice the
 * model does not have is worth retrying with another voice, while a terminated
 * worker can only answer with the same error forever, so the caller has to
 * build a new engine instead of asking this one again.
 *
 * A string rather than a class because it travels back from a worker, where the
 * prototypes do not survive structured cloning.
 */
export const WORKER_DEAD = 'worker-dead';

/** Whether a thrown value means the engine's worker is gone. */
export function isWorkerDeadError(error: unknown): boolean {
  return error instanceof Error && error.name === WORKER_DEAD;
}

/** What a load actually did, for the model tab's "running on" line. */
export interface DeviceInfo {
  readonly device: Device;
  /** The adapter's own name, when the browser will say. */
  readonly adapterName?: string;
  /** How long building the session took, in milliseconds. */
  readonly sessionInitMs: number;
}

/** Raw audio, exactly as the model produced it. */
export interface RawPcm {
  readonly pcm: Float32Array;
  readonly sampleRate: number;
}

export interface OnDeviceEngine {
  readonly family: OnDeviceFamily;

  /**
   * Load a tier onto a device. Loading the same tier twice reuses the session.
   *
   * `device` is not `'auto'`: the caller has already resolved it against the
   * machine's capabilities, because that decision also picks the tier and the
   * two must agree.
   */
  load(model: OnDeviceModel, tier: ModelTier, device: Device): Promise<DeviceInfo>;

  /**
   * Synthesize one sentence.
   *
   * `lang` is required rather than optional because it selects the
   * phonemization path, and the paths are not interchangeable: Chinese needs a
   * word list and tone arrows, Japanese a dictionary, and English neither —
   * its CMU dictionary is compiled into the wasm (P6 spec §2.3). Since phase 10
   * it does *not* select the rendering path: all three languages reach the model
   * as IPA. Callers derive it from the voice id's prefix when the user has not
   * set one.
   */
  synthesize(text: string, voiceId: string, lang: string, signal: AbortSignal): Promise<RawPcm>;

  /** Release the session. Safe to call when nothing is loaded. */
  dispose(): void;
}

export interface FakeLocalEngineOptions {
  /** How long `load()` takes, for tests of the "preparing" state. */
  readonly loadDelayMs?: number;
  /** Milliseconds of audio per character of text. */
  readonly msPerCharacter?: number;
  readonly device?: Device;
  readonly adapterName?: string;
  /** Reject `synthesize` when the text contains this, for the failure path. */
  readonly failOn?: string;
}

/** One recorded `load` call. */
export interface FakeLoad {
  readonly modelId: string;
  readonly tierId: string;
  readonly device: Device;
}

/** One recorded `synthesize` call. */
export interface FakeSynthesis {
  readonly text: string;
  readonly voiceId: string;
  readonly lang: string;
}

/**
 * An engine that makes silence, so the whole chain can be exercised without a
 * model, a worker or a GPU.
 *
 * It is not a stub that returns a constant: the audio's length follows the
 * text, so the timeline, the highlight and the cache all see a plausible
 * duration and the e2e run can assert that playback actually progressed.
 */
export class FakeLocalEngine implements OnDeviceEngine {
  readonly family: OnDeviceFamily = 'kokoro';
  readonly loads: FakeLoad[] = [];
  readonly synthesized: FakeSynthesis[] = [];
  disposed = 0;

  private loaded: { tierId: string; device: Device } | null = null;

  constructor(private readonly options: FakeLocalEngineOptions = {}) {}

  async load(model: OnDeviceModel, tier: ModelTier, device: Device): Promise<DeviceInfo> {
    const delay = this.options.loadDelayMs ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

    this.loads.push({ modelId: model.id, tierId: tier.id, device });
    this.loaded = { tierId: tier.id, device };

    const adapterName = this.options.adapterName;
    return adapterName === undefined
      ? { device, sessionInitMs: delay }
      : { device, adapterName, sessionInitMs: delay };
  }

  async synthesize(
    text: string,
    voiceId: string,
    lang: string,
    signal: AbortSignal
  ): Promise<RawPcm> {
    this.synthesized.push({ text, voiceId, lang });

    if (signal.aborted) throw abortError();
    if (this.options.failOn !== undefined && text.includes(this.options.failOn)) {
      throw new Error(`FakeLocalEngine was told to fail on ${JSON.stringify(this.options.failOn)}`);
    }
    // Synthesizing without loading is a wiring bug in the caller, and the real
    // engine would fail on it too — with a much less useful message.
    if (this.loaded === null) throw new Error('FakeLocalEngine.synthesize() before load()');

    const msPerCharacter = this.options.msPerCharacter ?? 50;
    const samples = Math.max(1, Math.round((text.length * msPerCharacter * 24_000) / 1000));
    return { pcm: new Float32Array(samples), sampleRate: 24_000 };
  }

  dispose(): void {
    this.disposed += 1;
    this.loaded = null;
  }
}

/**
 * An abort rejection the repo's `isAbortError` recognises.
 *
 * Re-exported rather than defined here so the engine seam and the audio worker
 * share one factory: two of them would be two things to keep in step with
 * `isAbortError`.
 */
export { abortError };
