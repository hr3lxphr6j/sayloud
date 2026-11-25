/**
 * The Kokoro session: build one, speak through it, let it go.
 *
 * It lives here rather than inside the worker because it needed tests, and a
 * class buried in a worker module cannot have any. The bug that forced the move
 * was a race between two `load()` calls: both saw `this.tts === null`, both
 * built a session, and the slower one was written over — leaving a 325 MB
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
import { Tensor } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import type { WordTiming } from '../providers/types';
import { concatPcm, KOKORO_SAMPLE_RATE } from './audio';
import { voiceKey } from './downloader';
import { abortError, type DeviceInfo, type RawPcm } from './engine';
import { type ModelTier, modelById, type OnDeviceModel, tierById } from './registry';
import { KOKORO_VOICES_CACHE } from './urls';
import { readStyleVector } from './voice-file';
import { wordTimings } from './word-timings';
import type { SynthesizePiece } from './worker-protocol';

/** One synthesis in flight, so a cancel can reach it. */
interface InFlight {
  readonly controller: AbortController;
}

/**
 * What a test may stand in for.
 *
 * The real voice loader reads Cache Storage, which a unit test has no business
 * owning; everything else this class does is ordinary mocking.
 */
export interface KokoroEngineDeps {
  /** The style vector for one voice, as the model's `style` input wants it. */
  readonly loadVoice?: (model: OnDeviceModel, voiceId: string) => Promise<Float32Array>;
}

export class KokoroEngine {
  constructor(private readonly deps: KokoroEngineDeps = {}) {}

  private tts: KokoroTTS | null = null;
  private tier: ModelTier | null = null;
  private model: OnDeviceModel | null = null;
  private device: DeviceInfo['device'] = 'wasm';
  private readonly inFlight = new Map<number, InFlight>();
  /** The voice style vectors, one fetch per voice for the session's life. */
  private readonly voices = new Map<string, Promise<Float32Array>>();
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
    // and a voice change all call this, and rebuilding a 325 MB session for
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
    this.model = model;
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
      const timings: WordTiming[] = [];
      // Each piece's audio starts where the ones before it ended, and the
      // spans' character offsets are already sentence-relative — so only the
      // times are shifted here, by the audio that came before the piece.
      let samplesSoFar = 0;
      for (const piece of pieces) {
        if (inFlight.controller.signal.aborted) throw abortError();
        const rendered = await this.render(piece, voiceId, lang);
        chunks.push(rendered.audio);
        console.warn('[dbg] spans?', piece.spans !== undefined, 'durs?', rendered.durations !== undefined, JSON.stringify(rendered.durations));
        if (piece.spans !== undefined && rendered.durations !== undefined) {
          timings.push(
            ...wordTimings(
              piece.ipa,
              rendered.durations,
              piece.spans,
              rendered.audio.length,
              samplesSoFar / (KOKORO_SAMPLE_RATE / 1000)
            )
          );
        }
        samplesSoFar += rendered.audio.length;
      }
      return {
        pcm: concatPcm(chunks),
        sampleRate: KOKORO_SAMPLE_RATE,
        timings: timings.length > 0 ? timings : undefined,
      };
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
  ): Promise<{ audio: Float32Array; durations?: Float32Array }> {
    const tts = this.tts;
    if (!tts) throw new Error('the model is not loaded');

    const encoded = tts.tokenizer(piece.ipa, { truncation: false });
    const inputIds = encoded.input_ids;

    // The model is called directly rather than through `generate_from_ids()`,
    // which destructures only `waveform` and throws the durations away. The
    // feeds are the ones `generate_from_ids()` builds — same style slice, same
    // speed — so the audio is the audio the library would have produced, and
    // `durationMs`-style parity tests hold on the waveform alone.
    const offset = STYLE_SPAN * Math.min(Math.max((inputIds.dims.at(-1) ?? 0) - 2, 0), 509);
    const style = new Tensor(
      'float32',
      (await this.voice(voiceId)).slice(offset, offset + STYLE_SPAN),
      [1, STYLE_SPAN]
    );
    const speed = new Tensor('float32', new Float32Array([1]), [1]);

    // The timestamped model adds a `durations` output: per input token, how
    // many frames the model spoke it for. A model without it — the plain
    // weights — returns `undefined` here, and the sentence then plays without
    // word timings rather than with guessed ones.
    const output = await tts.model({ input_ids: inputIds, style, speed });
    const durations = output.durations?.data as Float32Array | undefined;
    // `generate_from_ids()` wraps `waveform.data` in a `RawAudio`; this is that
    // data, straight out of the tensor.
    const audio = output.waveform.data as Float32Array;
    return { audio, durations };
  }

  /**
   * The style vector for `voiceId`, fetched once per session.
   *
   * The same file the downloader wrote under the model's repository, read back
   * through the cache the engine's own fetch already resolves. `Float32Array`
   * is what the style tensor is sliced from, per kokoro-js's own loading.
   */
  private voice(voiceId: string): Promise<Float32Array> {
    const cached = this.voices.get(voiceId);
    if (cached) return cached;

    const model = this.model;
    if (!model) throw new Error('the model is not loaded');
    if (this.deps.loadVoice) {
      const injected = this.deps.loadVoice(model, voiceId);
      this.voices.set(voiceId, injected);
      return injected;
    }
    const loading = (async () => {
      // `voiceKey` resolves the model's own `voiceFile` template — passing it a
      // path instead of the id doubles every segment (`voices/x.bin.bin`), which
      // is exactly the 404 this once was.
      const key = voiceKey(model, voiceId);
      const bucket = await caches.open(KOKORO_VOICES_CACHE);
      return readStyleVector(
        voiceId,
        key,
        async () => (await bucket.match(key)) ?? undefined,
        () => fetch(key)
      );
    })();
    this.voices.set(voiceId, loading);
    return loading;
  }

  private disposeSession(): void {
    this.tts?.model?.dispose?.();
    this.tts = null;
    this.tier = null;
    this.model = null;
    this.voices.clear();
    // Not left at whatever the last session used: the next `load` with the
    // default preference must not be mistaken for a session that is still here.
    this.device = 'wasm';
  }
}

/**
 * One style vector, in floats.
 *
 * The model takes one per synthesis, sliced out of the voice file at an offset
 * that grows with the token count — the arithmetic `generate_from_ids()` has
 * always used, and the reason a piece cut to the model's limit slices at most
 * 256 × 509 floats into the file.
 */
const STYLE_SPAN = 256;

/**
 * The characters that survive the model's tokenizer, verbatim.
 *
 * The Rust phonemizer's vocabulary gate refuses any phoneme string holding a
 * character outside the model's vocabulary, and every vocabulary character
 * survives the tokenizer's own normalizer — measured against `tokenizer.json`
 * the same way `crates/phonemize`'s `KOKORO_PUNCTUATION` was — so a phoneme's
 * character index *is* its token index, offset by the BOS the tokenizer adds.
 * The length check below is what catches that assumption breaking, instead of
 * letting a misaligned highlight ship.
 */
