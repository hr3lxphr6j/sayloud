/**
 * The handful of glyphs the panel draws.
 *
 * Inline SVG rather than an icon font or a sprite: there are four of them, they
 * inherit `currentColor` so the theme handles them for free, and the panel has
 * no network to fetch anything from.
 *
 * All of them are decorative — the control around them carries the name — so
 * each is `aria-hidden` and `focusable="false"` (the latter for IE-era focus
 * rings that some Chromium embeds still honour).
 */
const SIZE = 16;

export function ChevronRight() {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

export function ChevronLeft() {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 3.5 5.5 8 10 12.5" />
    </svg>
  );
}

/** The mark on the voice card: sound coming out of a speaker. */
export function SpeakerGlyph() {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 6h2.5L8.5 3.5v9L5.5 10H3z" />
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5" />
    </svg>
  );
}
