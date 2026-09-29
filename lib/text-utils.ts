export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().normalize('NFC');
}

export interface Segment {
  text: string;
  start: number;
  end: number;
}

export function segmentSentences(text: string, lang: string): Segment[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
  return Array.from(seg.segment(text))
    .map((s) => ({ text: s.segment.trim(), start: s.index, end: s.index + s.segment.length }))
    .filter((s) => s.text.length > 0);
}

export function segmentWords(text: string, lang: string): Segment[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'word' });
  return Array.from(seg.segment(text))
    .filter((s) => s.isWordLike)
    .map((s) => ({ text: s.segment, start: s.index, end: s.index + s.segment.length }));
}
