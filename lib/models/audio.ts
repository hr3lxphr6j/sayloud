/**
 * PCM to WAV, and the split that keeps a sentence inside Kokoro's limit
 * (P4 spec §3.9, §3.10).
 *
 * Kokoro returns raw Float32 samples at 24 kHz. SayLoud's whole playback path —
 * `TimelinePlayer`, the `<audio>` element, the L2 audio cache — already speaks
 * "one `ArrayBuffer` with a mime type", so the cheapest way to fit in is to
 * write a WAV header and hand over a buffer that needs no new code anywhere.
 * Both synthesis paths return the same `RawAudio` shape — and since phase 10
 * there is only one path, `generate_from_ids()`, for all three languages — so
 * this is one implementation for all of them.
 */

/** Kokoro's output rate. Not configurable — the model decides it. */
export const KOKORO_SAMPLE_RATE = 24_000;

/** Bytes of the canonical 16-bit mono PCM WAV header. */
const WAV_HEADER_BYTES = 44;

/** Kokoro's hard input limit, in tokens. */
export const KOKORO_TOKEN_LIMIT = 510;

/**
 * The size a piece is packed up to before another clause is added.
 *
 * Clauses are merged back together after splitting, because each synthesis call
 * has fixed cost and a sentence cut into many tiny calls is slower than the same
 * sentence cut into a few. `KOKORO_TOKEN_LIMIT` is 510; stopping at 250 leaves
 * room for the tokenizer to add its own special tokens without re-measuring.
 */
export const PIECE_TARGET_TOKENS = 250;

/**
 * The absolute ceiling for one piece.
 *
 * Below the model's 510 on purpose: the count this module takes comes from
 * `tokenizer(ipa)`, and the model's own limit applies to the ids it is finally
 * given. Keeping 60 tokens of headroom means a measurement that is off by a
 * little still does not get truncated.
 */
export const PIECE_HARD_CAP_TOKENS = 450;

/** The playback duration of a sample count, in milliseconds. */
export function durationMsFor(sampleCount: number, sampleRate: number): number {
  return (sampleCount / sampleRate) * 1000;
}

/** One 16-bit signed sample, clamped rather than wrapped. */
function toInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  // Asymmetric on purpose: a Float32 in [-1, 1) maps to [-32768, 32767), and
  // scaling +1 by 32768 would overflow into -32768 and turn a peak into a click.
  return Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
}

/**
 * A 16-bit mono PCM WAV holding `samples`.
 *
 * The header is written by hand rather than through a library: it is 44 bytes
 * of well-known layout, and the alternative is a dependency in the offscreen
 * worker for no benefit.
 */
export function pcmToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate * channels * bytes
  view.setUint16(32, 2, true); // block align = channels * bytes
  view.setUint16(34, 16, true); // bits per sample

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(WAV_HEADER_BYTES + i * 2, toInt16(samples[i] ?? 0), true);
  }

  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Join synthesized pieces back into one buffer.
 *
 * Same sample rate by construction — every piece came from the same model — so
 * the concatenation is exact and no resampling is involved.
 */
export function concatPcm(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const joined = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * Where a sentence can be cut without cutting a word: after clause punctuation,
 * keeping the punctuation with the clause it closes.
 *
 * Handles both the full-width marks the source text has and the ASCII ones
 * `mapPunctuation` produces, because this runs on the original text.
 */
export function splitClauses(text: string): string[] {
  // Built per call: a shared `g` regex carries a `lastIndex`, and this module's
  // callers are asynchronous.
  const boundary = /[，。！？；：、,.!?;:][”’"」』）)]*/g;

  const clauses: string[] = [];
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    clauses.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) clauses.push(text.slice(start));

  return clauses.map((clause) => clause.trim()).filter((clause) => clause !== '');
}

/** One synthesis call's worth of text. */
export interface Piece {
  /** The text this piece covers; the pieces of a sentence joined are the sentence. */
  readonly text: string;
  /** Its IPA, ready for the tokenizer. */
  readonly ipa: string;
  readonly tokens: number;
}

/**
 * Phonemize `text` and count its tokens.
 *
 * Injected so this module never needs a tokenizer: the real one lives with the
 * model, and a unit test has no business loading it.
 */
export type Measure = (text: string) => Promise<{ ipa: string; tokens: number }>;

/**
 * Cut `text` down until every piece fits, then pack pieces back up to the
 * target size.
 *
 * A sentence that fits (the overwhelmingly common case — measured Chinese
 * sentences run about 43 tokens and English ones 15–40, against a limit of 510)
 * comes back as exactly one piece, phonemized once, and nothing about it
 * changes. The splitting exists for the pathological paragraph, and it never
 * changes SayLoud's sentence granularity: the caller still gets one buffer for
 * one `segmentSentences` sentence, so highlighting is unaffected (spec §3.10).
 */
export async function planPieces(text: string, measure: Measure): Promise<Piece[]> {
  const pieces = await cutToFit(text, measure);
  return pack(pieces);
}

async function cutToFit(text: string, measure: Measure): Promise<Piece[]> {
  const { ipa, tokens } = await measure(text);
  if (tokens <= PIECE_HARD_CAP_TOKENS || text.length <= 1) {
    return [{ text, ipa, tokens }];
  }

  const clauses = splitClauses(text);
  const parts =
    clauses.length > 1
      ? clauses
      : // No punctuation to cut at — a single unbroken clause longer than the
        // model's limit. Halving is arbitrary but it is the only cut available,
        // and it terminates because every step strictly shrinks the text.
        [text.slice(0, Math.floor(text.length / 2)), text.slice(Math.floor(text.length / 2))];

  const cut = await Promise.all(parts.map((part) => cutToFit(part, measure)));
  return cut.flat();
}

/** Merge consecutive pieces while they stay within the target. */
function pack(pieces: readonly Piece[]): Piece[] {
  const packed: Piece[] = [];
  let current: Piece[] = [];
  let tokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    packed.push({
      text: current.map((piece) => piece.text).join(''),
      ipa: current.map((piece) => piece.ipa).join(' '),
      tokens,
    });
    current = [];
    tokens = 0;
  };

  for (const piece of pieces) {
    if (current.length > 0 && tokens + piece.tokens > PIECE_TARGET_TOKENS) flush();
    current.push(piece);
    tokens += piece.tokens;
  }
  flush();

  return packed;
}
