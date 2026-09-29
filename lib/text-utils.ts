export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().normalize('NFC');
}

/** True when `Intl.Segmenter` accepts the tag, so callers can fall back safely. */
export function isSupportedLang(lang: string): boolean {
  if (!lang) return false;
  try {
    new Intl.Segmenter(lang, { granularity: 'sentence' });
    return true;
  } catch {
    return false;
  }
}

export interface Segment {
  text: string;
  start: number;
  end: number;
}

export function segmentSentences(text: string, lang: string): Segment[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
  const segments: Segment[] = [];
  for (const part of seg.segment(text)) {
    // `Intl.Segmenter` keeps trailing whitespace inside a sentence, so trim it
    // and shift `start` accordingly: consumers slice the source with
    // [start, end), which only works while `text.length === end - start`.
    const trimmed = part.segment.trim();
    if (trimmed.length === 0) continue;
    const start = part.index + (part.segment.length - part.segment.trimStart().length);
    segments.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return segments;
}

export function segmentWords(text: string, lang: string): Segment[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'word' });
  return Array.from(seg.segment(text))
    .filter((s) => s.isWordLike)
    .map((s) => ({ text: s.segment, start: s.index, end: s.index + s.segment.length }));
}
