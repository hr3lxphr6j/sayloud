/**
 * PCM → WAV and the token-budget split (P4 spec §3.9, §3.10).
 *
 * The split is measured, never guessed from character counts, so the tests
 * inject the measurement the way the worker will inject the real tokenizer.
 */
import { describe, expect, it } from 'vitest';
import {
  concatPcm,
  durationMsFor,
  KOKORO_SAMPLE_RATE,
  KOKORO_TOKEN_LIMIT,
  PIECE_HARD_CAP_TOKENS,
  pcmToWav,
  planPieces,
  splitClauses,
} from '~/lib/models/audio';

/** Read the 44-byte header back as the fields a decoder would. */
function readHeader(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...new Uint8Array(buffer, offset, length));

  return {
    riff: ascii(0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
  };
}

function sampleAt(buffer: ArrayBuffer, index: number): number {
  return new DataView(buffer).getInt16(44 + index * 2, true);
}

describe('pcmToWav', () => {
  it('writes a 16-bit mono PCM header', () => {
    const header = readHeader(pcmToWav(new Float32Array(100), KOKORO_SAMPLE_RATE));

    expect(header.riff).toBe('RIFF');
    expect(header.wave).toBe('WAVE');
    expect(header.fmt).toBe('fmt ');
    expect(header.fmtSize).toBe(16);
    expect(header.format).toBe(1);
    expect(header.channels).toBe(1);
    expect(header.sampleRate).toBe(24_000);
    expect(header.byteRate).toBe(48_000);
    expect(header.blockAlign).toBe(2);
    expect(header.bitsPerSample).toBe(16);
    expect(header.data).toBe('data');
  });

  it('sizes both the file and the data chunk from the sample count', () => {
    const buffer = pcmToWav(new Float32Array(1234), KOKORO_SAMPLE_RATE);
    expect(buffer.byteLength).toBe(44 + 1234 * 2);

    const header = readHeader(buffer);
    expect(header.dataSize).toBe(1234 * 2);
    expect(header.riffSize).toBe(36 + 1234 * 2);
  });

  it('keeps the sample rate it was given', () => {
    expect(readHeader(pcmToWav(new Float32Array(1), 48_000)).sampleRate).toBe(48_000);
  });

  it('encodes samples little-endian and in range', () => {
    const buffer = pcmToWav(new Float32Array([0, 1, -1, 0.5, -0.5]), KOKORO_SAMPLE_RATE);
    expect(sampleAt(buffer, 0)).toBe(0);
    expect(sampleAt(buffer, 1)).toBe(32767);
    expect(sampleAt(buffer, 2)).toBe(-32768);
    expect(sampleAt(buffer, 3)).toBe(16384);
    expect(sampleAt(buffer, 4)).toBe(-16384);
  });

  it('clamps rather than wrapping a sample outside [-1, 1]', () => {
    // Wrapping would turn a loud peak into the opposite extreme, which is an
    // audible click rather than a limit.
    const buffer = pcmToWav(new Float32Array([2, -2]), KOKORO_SAMPLE_RATE);
    expect(sampleAt(buffer, 0)).toBe(32767);
    expect(sampleAt(buffer, 1)).toBe(-32768);
  });

  it('produces a header for an empty buffer', () => {
    const buffer = pcmToWav(new Float32Array(0), KOKORO_SAMPLE_RATE);
    expect(buffer.byteLength).toBe(44);
    expect(readHeader(buffer).dataSize).toBe(0);
  });
});

describe('durationMsFor', () => {
  it('is a second for a second of 24 kHz samples', () => {
    expect(durationMsFor(24_000, KOKORO_SAMPLE_RATE)).toBe(1000);
    expect(durationMsFor(12_000, KOKORO_SAMPLE_RATE)).toBe(500);
    expect(durationMsFor(0, KOKORO_SAMPLE_RATE)).toBe(0);
  });
});

describe('concatPcm', () => {
  it('joins in order', () => {
    const joined = concatPcm([new Float32Array([1, 2]), new Float32Array([3])]);
    expect([...joined]).toEqual([1, 2, 3]);
  });

  it('handles nothing at all', () => {
    expect(concatPcm([])).toHaveLength(0);
  });
});

describe('splitClauses', () => {
  it('cuts after punctuation and keeps it with the clause', () => {
    expect(splitClauses('你好，世界。')).toEqual(['你好，', '世界。']);
  });

  it('understands the ASCII punctuation phonemization produces', () => {
    expect(splitClauses('one, two. three')).toEqual(['one,', 'two.', 'three']);
  });

  it('keeps a closing quote with the clause it closes', () => {
    // The cut has to land after the quote, not between it and the full stop,
    // or the piece would end on an opening mark the next piece never closes.
    expect(splitClauses('好。”然后走了')).toEqual(['好。”', '然后走了']);
  });

  it('returns the whole text when there is nothing to cut at', () => {
    expect(splitClauses('一段没有标点的文字')).toEqual(['一段没有标点的文字']);
  });

  it('drops empty clauses', () => {
    expect(splitClauses('好。。。')).toEqual(['好。', '。', '。']);
  });
});

/** A measurement that charges one token per character, so tests can be exact. */
const perCharacter = async (text: string) => ({ ipa: `<${text}>`, tokens: text.length });

/** A measurement with a fixed cost per call, for the packing tests. */
function fixed(cost: number) {
  return async (text: string) => ({ ipa: `<${text}>`, tokens: cost });
}

describe('planPieces', () => {
  it('returns one piece for a sentence that fits', async () => {
    const pieces = await planPieces('你好世界', perCharacter);
    expect(pieces).toEqual([{ text: '你好世界', ipa: '<你好世界>', tokens: 4 }]);
  });

  it('treats a sentence exactly at the cap as fitting', async () => {
    const text = 'a'.repeat(PIECE_HARD_CAP_TOKENS);
    await expect(planPieces(text, perCharacter)).resolves.toHaveLength(1);
  });

  it('cuts an over-long sentence at its clause boundaries', async () => {
    const text = 'a,'.repeat(300); // 600 tokens, 300 clauses
    const pieces = await planPieces(text, perCharacter);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.tokens).toBeLessThanOrEqual(PIECE_HARD_CAP_TOKENS);
    }
    // Every cut lands on a clause boundary, so the pieces rejoin exactly.
    expect(pieces.map((piece) => piece.text).join('')).toBe(text);
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.text.endsWith(',')).toBe(true);
    }
  });

  it('halves a single clause too long to fit any other way', async () => {
    // No punctuation at all: the only cut available is the middle.
    const text = 'a'.repeat(1000);
    const pieces = await planPieces(text, perCharacter);

    expect(pieces.map((piece) => piece.text).join('')).toBe(text);
    for (const piece of pieces) {
      expect(piece.tokens).toBeLessThanOrEqual(PIECE_HARD_CAP_TOKENS);
    }
  });

  it('never emits a piece the model would truncate', async () => {
    // Mixed: clauses of wildly different sizes, one of them over the cap.
    const text = `${'a,'.repeat(200)}${'b'.repeat(700)}${'c,'.repeat(200)}`;
    const pieces = await planPieces(text, perCharacter);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.tokens).toBeLessThanOrEqual(PIECE_HARD_CAP_TOKENS);
      expect(piece.tokens).toBeLessThan(KOKORO_TOKEN_LIMIT);
    }
  });

  it('packs clauses up towards the target rather than emitting one each', async () => {
    // 300 clauses of 2 tokens each: 600 tokens, cut into 250-token pieces.
    const pieces = await planPieces('a,'.repeat(300), perCharacter);
    expect(pieces.map((piece) => piece.tokens)).toEqual([250, 250, 100]);
  });

  it('gives a single oversized clause a piece of its own', async () => {
    const pieces = await planPieces('ab', fixed(PIECE_HARD_CAP_TOKENS + 1));
    // Two halves, each still over the cap, but there is nothing left to cut.
    expect(pieces.map((piece) => piece.tokens)).toEqual([451, 451]);
  });

  it('joins the IPA of the pieces it merges', async () => {
    const pieces = await planPieces('ab', perCharacter);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.ipa).toBe('<ab>');
  });
});
