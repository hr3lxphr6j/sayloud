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
 * Since phase 7 it also owns no phonemization at all. What arrives is text that
 * has already been phonemized and already been cut to fit the model's limit,
 * because cutting needs a token count (here) and phonemizing needs a dictionary
 * (in the other worker). That leaves this class with exactly the model, which is
 * the split `kokoro.worker.ts` is named after.
 */
import { KokoroTTS } from 'kokoro-js';
import { concatPcm, KOKORO_SAMPLE_RATE } from './audio';
import { abortError, type DeviceInfo, type RawPcm } from './engine';
import { isChinese, isJapanese } from './language';
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
   * English goes through `generate()`, the library's own supported path: it
   * phonemizes the way the model was trained — espeak plus the number,
   * punctuation and character substitutions `kokoro-js` applies afterwards —
   * and re-implementing that here is how the two would drift apart. Chinese and
   * Japanese cannot: `generate()` rejects every voice outside its 28-voice
   * English list (verification §1.1.1), so their IPA enters through
   * `generate_from_ids()`, which does no voice validation.
   *
   * That is also why a piece carries both its text and its IPA rather than
   * whichever half its language needs: the split is by language, and the
   * language is the caller's to know.
   */
  private async render(
    piece: SynthesizePiece,
    voiceId: string,
    lang: string
  ): Promise<Float32Array> {
    const tts = this.tts;
    if (!tts) throw new Error('the model is not loaded');
    const options = { voice: voiceId } as GenerateOptions;

    if (isChinese(lang) || isJapanese(lang)) {
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
    // Not left at whatever the last session used: the next `load` with the
    // default preference must not be mistaken for a session that is still here.
    this.device = 'wasm';
  }
}
