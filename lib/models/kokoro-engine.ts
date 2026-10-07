/**
 * The Kokoro session: build one, speak through it, let it go.
 *
 * It lives here rather than inside the worker because it needed tests, and a
 * class buried in a worker module cannot have any. The bug that forced the move
 * was a race between two `load()` calls: both saw `this.tts === null`, both
 * built a session, and the slower one was written over — leaving a 163 MB
 * session that nothing could reach to dispose. That is only reachable by
 * calling `load()` twice before the first resolves, which is exactly what a
 * test can do and a browser cannot be asked to reproduce on demand.
 *
 * Nothing here knows about messages. The worker owns the protocol and the
 * ONNX Runtime configuration; this owns the model.
 *
 * It also owns no phonemization at all. What arrives is text that
 * has already been phonemized and already been cut to fit the model's limit,
 * because cutting needs a token count (here) and phonemizing needs a dictionary
 * (in the other worker). That leaves this class with exactly the model, which is
 * the split `kokoro.worker.ts` is named after.
 */
import { KokoroTTS } from 'kokoro-js';
import { concatPcm, KOKORO_SAMPLE_RATE } from './audio';
import { abortError, type DeviceInfo, type RawPcm } from './engine';
import { type ModelTier, modelById, tierById } from './registry';
import type { SynthesizePiece } from './worker-protocol';

/** One synthesis in flight, so a cancel can reach it. */
interface InFlight {
  readonly controller: AbortController;
}

/** The voice ids `kokoro-js` types as a union; ours come from its own list. */
type GenerateOptions = NonNullable<Parameters<KokoroTTS['generate']>[1]>;

export class KokoroEngine {
  private tts: KokoroTTS | null = null;
  private tier: ModelTier | null = null;
  private device: DeviceInfo['device'] = 'wasm';
  private readonly inFlight = new Map<number, InFlight>();
  /**
   * Bumped by every `load`, so one that finishes late cannot install itself
   * over the session a newer call built.
   */
  private loads = 0;

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

    const generation = ++this.loads;
    this.disposeSession();
    const started = Date.now();
    const session = await KokoroTTS.from_pretrained(model.repo, {
      dtype: tier.engineArg as 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16',
      device,
    });

    // A newer load started while this one was building — a seek during the
    // first session, most likely, since that is the only stretch long enough
    // for one to fit inside. The stale session has no owner left to dispose
    // it, so it disposes itself rather than holding its weights for the life
    // of the document.
    if (generation !== this.loads) {
      session.model?.dispose?.();
      throw new Error('superseded by a newer load');
    }

    this.tts = session;
    this.tier = tier;
    this.device = device;

    return { device, sessionInitMs: Date.now() - started };
  }

  /**
   * How many tokens the model's tokenizer makes of this IPA.
   *
   * Without truncation, so this is the real length. `generate()` itself passes
   * `truncation: true`, which is why the split exists at all: the model would
   * otherwise cut an over-long sentence off mid-word and say nothing.
   *
   * Public because the coordinator is what cuts a sentence to fit — it is the
   * only place that can reach both this count and the phonemes it is a count
   * of.
   */
  countTokens(ipa: string): number {
    const tts = this.tts;
    if (!tts) throw new Error('the model is not loaded');
    return tts.tokenizer(ipa, { truncation: false }).input_ids.dims.at(-1) ?? 0;
  }

  /**
   * Audio for a sentence that has already been phonemized and cut up.
   *
   * `id` is the request's, so a cancel that arrives mid-sentence reaches the
   * pieces still to come rather than only the one being rendered.
   */
  async synthesize(
    id: number,
    pieces: readonly SynthesizePiece[],
    voiceId: string,
    lang: string
  ): Promise<RawPcm> {
    if (!this.tts) throw new Error('the model is not loaded');

    const inFlight: InFlight = { controller: new AbortController() };
    this.inFlight.set(id, inFlight);

    try {
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

  /**
   * Audio for one piece.
   *
   * **All three languages enter the model the same way**, through
   * `generate_from_ids()`. English used to go through `generate()`, the
   * library's own supported path, which runs `kokoro-js`'s front end on the raw
   * text: espeak, then the number, punctuation and character substitutions it
   * applies afterwards. The reason to stop is that the words arriving here were
   * already phonemized — by the Rust module, for all three languages — so
   * `generate()` was a second, invisible front end that the token count in
   * `countTokens()` did not describe.
   *
   * `truncation: false`, the same as `countTokens()`. A piece the coordinator got
   * wrong would otherwise be silently cut at the model's limit, mid-word, in a
   * way that reads as a bad sentence rather than as a bug; `planPieces` cuts at
   * clause boundaries against this same tokenizer, so the limit is not reached
   * legitimately.
   *
   * `lang` is not read. It stays in the signature because the request names a
   * voice and a voice speaks exactly one language, and because the one per-voice
   * rendering decision already known — `kokoro-js` rewrites `nˈaɪntɪ` to
   * `nˈaɪndi` for en-US and for no other variety — would need it. Making it a
   * silent parameter rather than a re-plumbing job is the cheaper half of that
   * trade.
   */
  private async render(
    piece: SynthesizePiece,
    voiceId: string,
    _lang: string
  ): Promise<Float32Array> {
    const tts = this.tts;
    if (!tts) throw new Error('the model is not loaded');
    const options = { voice: voiceId } as GenerateOptions;

    const encoded = tts.tokenizer(piece.ipa, { truncation: false });
    const audio = await tts.generate_from_ids(encoded.input_ids, options);
    return audio.audio;
  }

  private disposeSession(): void {
    this.tts?.model?.dispose?.();
    this.tts = null;
    this.tier = null;
    // Not left at whatever the last session used: the next `load` with the
    // default preference must not be mistaken for a session that is still here.
    this.device = 'wasm';
  }
}
