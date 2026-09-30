/**
 * The on-device engine, inside a nested worker in the offscreen document
 * (P4 spec §3.3).
 *
 * Three things about where this runs drive everything below.
 *
 * **It is a worker, not the offscreen document's main thread.** That thread
 * also drives `TimelinePlayer`'s timers and playback, and an ONNX session that
 * blocks it for a second is a stutter in whatever is playing right now.
 *
 * **It has no `chrome.storage`.** Offscreen documents are given `runtime` and
 * `offscreen` and nothing else, so the download source arrives as an `init`
 * message rather than being read here.
 *
 * **It is recycled after ~30 seconds without audio.** Loading the model and
 * synthesizing the first sentence takes 1–2 seconds once the weights are in the
 * cache, so the normal path is safe — but this document must never be the one
 * that downloads them, which is why `model-missing` exists at all.
 */
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { concatPcm, KOKORO_SAMPLE_RATE, planPieces } from '~/lib/models/audio';
import { abortError, type DeviceInfo, type RawPcm } from '~/lib/models/engine';
import { installFetchPatch } from '~/lib/models/fetch-patch';
import { ChinesePhonemizer } from '~/lib/models/phonemize/chinese';
import { EnglishPhonemizer } from '~/lib/models/phonemize/english';
import { isChinese, type Phonemizer } from '~/lib/models/phonemize/types';
import { type ModelTier, modelById, tierById } from '~/lib/models/registry';
import { CANONICAL_HOST, type ModelSource } from '~/lib/models/urls';
import {
  isWorkerRequest,
  type WorkerReply,
  type WorkerRequest,
} from '~/lib/models/worker-protocol';
import type { ProviderErrorCode } from '~/lib/providers/errors';

/** The slice of `DedicatedWorkerGlobalScope` used here. */
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

// Not `DedicatedWorkerGlobalScope` itself: that type lives in `lib.webworker`,
// which cannot be combined with the DOM library the rest of the extension uses.
const scope = self as unknown as WorkerScope;

/**
 * ONNX Runtime, configured once, before any session exists.
 *
 * The `env` here is `@huggingface/transformers`' own — the same object
 * `kokoro-js` re-exports and proxies into, so configuring this one configures
 * the environment the model actually runs in. (`kokoro-js`'s re-export is typed
 * as a namespace holding only `wasmPaths`, which is why it cannot be the one
 * used here.)
 *
 * `numThreads = 1` because the extension is not cross-origin isolated and the
 * threaded build needs `SharedArrayBuffer` (verification V17). Measured: it
 * initialises fine that way, which is what lets the extension skip COOP/COEP
 * entirely — a global manifest change that would have put all six cloud
 * providers at risk.
 *
 * `wasmPaths` is deliberately *not* set. The bundler resolves ONNX Runtime's
 * own `new URL('...wasm', import.meta.url)` into an asset emitted inside the
 * extension, which is exactly the "the extension's own copy, never a CDN" the
 * spec asks for — and overriding it with a directory we would then have to keep
 * in step with the package is a second source of truth for a 21 MB file.
 */
function configureRuntime(): void {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // `backends` is typed `Partial<Env>`, so the wasm flags may be absent on a
  // build that does not ship the backend at all.
  const wasm = env.backends.onnx.wasm;
  if (wasm) wasm.numThreads = 1;
}

/**
 * Point transformers.js at the canonical host and patch the requests on the way
 * out, so a cached file is found again after the user switches download source.
 *
 * The revision in the template is `main` and stays `main`: the *key* must not
 * mention the source, and `resolveUrl` is what turns it into ModelScope's
 * `master` when that is where the bytes live.
 */
function configureSource(source: ModelSource, allowFallback: boolean): void {
  env.remoteHost = CANONICAL_HOST;
  env.remotePathTemplate = '{model}/resolve/{revision}/';
  installFetchPatch({ source, allowFallback });
}

/** One synthesis in flight, so a cancel can reach it. */
interface InFlight {
  readonly controller: AbortController;
}

/** The voice ids `kokoro-js` types as a union; ours come from its own list. */
type GenerateOptions = NonNullable<Parameters<KokoroTTS['generate']>[1]>;

class KokoroEngine {
  private tts: KokoroTTS | null = null;
  private tier: ModelTier | null = null;
  private device: DeviceInfo['device'] = 'wasm';
  private readonly inFlight = new Map<number, InFlight>();
  /** Built on first use: only one of the two is ever needed. */
  private english: Phonemizer | null = null;
  private chinese: Phonemizer | null = null;

  async load(modelId: string, tierId: string, device: DeviceInfo['device']): Promise<DeviceInfo> {
    const model = modelById(modelId);
    const tier = model ? tierById(model, tierId) : undefined;
    if (!model || !tier) throw new Error(`unknown model or tier: ${modelId}/${tierId}`);

    // Reuse the session when nothing about it changed. A seek, a new sentence
    // and a voice change all call this, and rebuilding a 163 MB session for
    // each would be the slowest thing in the extension.
    if (this.tts && this.tier?.id === tier.id && this.device === device) {
      return { device: this.device, sessionInitMs: 0 };
    }

    this.disposeSession();
    const started = Date.now();
    this.tts = await KokoroTTS.from_pretrained(model.repo, {
      dtype: tier.engineArg as 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16',
      device,
    });
    this.tier = tier;
    this.device = device;

    return { device, sessionInitMs: Date.now() - started };
  }

  async synthesize(id: number, text: string, voiceId: string, lang: string): Promise<RawPcm> {
    if (!this.tts) throw new Error('the model is not loaded');

    const inFlight: InFlight = { controller: new AbortController() };
    this.inFlight.set(id, inFlight);

    try {
      // Measured, not guessed: `planPieces` needs a token count, and the only
      // way to get one is to phonemize and ask the tokenizer.
      const pieces = await planPieces(text, async (piece) => {
        const ipa = await this.phonemize(piece, lang);
        return { ipa, tokens: this.countTokens(ipa) };
      });

      const chunks: Float32Array[] = [];
      for (const piece of pieces) {
        if (inFlight.controller.signal.aborted) throw abortError();
        chunks.push(await this.render(piece, voiceId, lang));
      }

      return { pcm: concatPcm(chunks), sampleRate: KOKORO_SAMPLE_RATE };
    } finally {
      this.inFlight.delete(id);
    }
  }

  cancel(id: number): void {
    this.inFlight.get(id)?.controller.abort();
  }

  dispose(): void {
    for (const inFlight of this.inFlight.values()) inFlight.controller.abort();
    this.inFlight.clear();
    this.disposeSession();
  }

  /** The IPA for one piece, through whichever pipeline the language needs. */
  private async phonemize(text: string, lang: string): Promise<string> {
    if (isChinese(lang)) {
      this.chinese ??= new ChinesePhonemizer();
      return this.chinese.phonemize(text, lang);
    }
    this.english ??= new EnglishPhonemizer();
    return this.english.phonemize(text, lang);
  }

  /**
   * How many tokens the model's tokenizer makes of this IPA.
   *
   * Without truncation, so this is the real length. `generate()` itself passes
   * `truncation: true`, which is why the split exists at all: the model would
   * otherwise cut an over-long sentence off mid-word and say nothing.
   */
  private countTokens(ipa: string): number {
    const tts = this.tts;
    if (!tts) throw new Error('the model is not loaded');
    return tts.tokenizer(ipa, { truncation: false }).input_ids.dims.at(-1) ?? 0;
  }

  /**
   * Audio for one piece.
   *
   * English goes through `generate()`, the library's own supported path: it
   * validates the voice and phonemizes the way the model was trained. Chinese
   * cannot — `generate()` rejects every voice outside its 28-voice English list
   * (verification §1.1.1) — so it phonemizes here and enters through
   * `generate_from_ids()`, which does no voice validation.
   */
  private async render(
    piece: { text: string; ipa: string },
    voiceId: string,
    lang: string
  ): Promise<Float32Array> {
    const tts = this.tts;
    if (!tts) throw new Error('the model is not loaded');
    const options = { voice: voiceId } as GenerateOptions;

    if (isChinese(lang)) {
      const encoded = tts.tokenizer(piece.ipa, { truncation: false });
      const audio = await tts.generate_from_ids(encoded.input_ids, options);
      return audio.audio;
    }

    const audio = await tts.generate(piece.text, options);
    return audio.audio;
  }

  private disposeSession(): void {
    this.tts?.model?.dispose?.();
    this.tts = null;
    this.tier = null;
  }
}

const engine = new KokoroEngine();

scope.addEventListener('message', (event: MessageEvent) => {
  const request: unknown = event.data;
  if (!isWorkerRequest(request)) return;
  void handle(request);
});

async function handle(request: WorkerRequest): Promise<void> {
  switch (request.type) {
    case 'init':
      try {
        configureSource(request.source, request.allowFallback);
        reply({ type: 'ready', id: request.id });
      } catch (error) {
        fail(request.id, 'model-load-failed', error);
      }
      return;

    case 'load':
      try {
        const info = await engine.load(request.modelId, request.tierId, request.device);
        reply({ type: 'loaded', id: request.id, info });
      } catch (error) {
        fail(request.id, 'model-load-failed', error);
      }
      return;

    case 'synthesize':
      try {
        const { pcm, sampleRate } = await engine.synthesize(
          request.id,
          request.text,
          request.voiceId,
          request.lang
        );
        // Transferred rather than copied: a ten-second sentence is 960 KB, and
        // this side has no further use for it.
        scope.postMessage({ type: 'pcm', id: request.id, pcm, sampleRate }, [pcm.buffer]);
      } catch (error) {
        // A cancellation is the caller's own decision and it has already
        // rejected its own promise; answering with an error would be noise.
        if (isAbort(error)) return;
        fail(request.id, 'unknown', error);
      }
      return;

    case 'cancel':
      engine.cancel(request.id);
      return;

    default:
      engine.dispose();
  }
}

function reply(message: WorkerReply): void {
  scope.postMessage(message);
}

function fail(id: number, code: ProviderErrorCode, error: unknown): void {
  reply({ type: 'error', id, code, message: messageOf(error) });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Structural, so it also matches a rejection reason from another realm. */
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

configureRuntime();
