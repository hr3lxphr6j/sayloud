/** Registry keys; also the `::highlight()` names used by the injected styles. */
export const SENTENCE_HIGHLIGHT = 'sayloud-sentence';
export const WORD_HIGHLIGHT = 'sayloud-word';

const STYLE_MARKER = 'data-sayloud-highlight';

/**
 * P1 uses fixed colours; adaptive dark-page colours are deferred to P4.
 * The sentence layer is the baseline for every provider, the word layer is the
 * optional overlay that only appears when a provider returns word timings.
 */
export const HIGHLIGHT_STYLES = `
::highlight(${SENTENCE_HIGHLIGHT}) {
  background-color: rgba(255, 214, 0, 0.34);
}
::highlight(${WORD_HIGHLIGHT}) {
  background-color: #ffb300;
}
`;

interface HighlightLike {
  add(range: Range): void;
  clear(): void;
}

interface HighlightRegistryLike {
  set(key: string, highlight: HighlightLike): unknown;
  delete(key: string): unknown;
}

type HighlightCtor = new () => HighlightLike;

function defaultRegistry(): HighlightRegistryLike | null {
  const css = (globalThis as { CSS?: { highlights?: unknown } }).CSS;
  return css?.highlights ? (css.highlights as HighlightRegistryLike) : null;
}

function defaultHighlightCtor(): HighlightCtor | null {
  const ctor = (globalThis as { Highlight?: unknown }).Highlight;
  return typeof ctor === 'function' ? (ctor as HighlightCtor) : null;
}

/**
 * Owns the two CSS Custom Highlight layers.
 *
 * The API is absent on older Chrome versions, so an unsupported environment
 * yields a silent no-op rather than a crash: audio keeps playing without
 * highlighting instead of taking the whole page down.
 */
export class Highlighter {
  private readonly registry: HighlightRegistryLike | null;
  private readonly sentence: HighlightLike | null;
  private readonly word: HighlightLike | null;

  constructor(
    registry: HighlightRegistryLike | null = defaultRegistry(),
    create: HighlightCtor | null = defaultHighlightCtor()
  ) {
    if (registry && create) {
      this.registry = registry;
      this.sentence = new create();
      this.word = new create();
      registry.set(SENTENCE_HIGHLIGHT, this.sentence);
      registry.set(WORD_HIGHLIGHT, this.word);
    } else {
      this.registry = null;
      this.sentence = null;
      this.word = null;
    }
  }

  /** False when the CSS Custom Highlight API is unavailable. */
  get enabled(): boolean {
    return this.registry !== null;
  }

  /** Replace the sentence highlight; pass null to clear just this layer. */
  setSentence(range: Range | null): void {
    replaceRange(this.sentence, range);
  }

  /** Replace the word highlight; pass null to clear just this layer. */
  setWord(range: Range | null): void {
    replaceRange(this.word, range);
  }

  clearWord(): void {
    replaceRange(this.word, null);
  }

  /** Clear both layers but keep them registered. */
  clear(): void {
    replaceRange(this.sentence, null);
    replaceRange(this.word, null);
  }

  /** Clear both layers and unregister them. */
  dispose(): void {
    this.clear();
    this.registry?.delete(SENTENCE_HIGHLIGHT);
    this.registry?.delete(WORD_HIGHLIGHT);
  }
}

function replaceRange(highlight: HighlightLike | null, range: Range | null): void {
  if (!highlight) return;
  highlight.clear();
  if (range) highlight.add(range);
}

/** Documents already carrying the highlight rules, so installs stay idempotent. */
const styledDocuments = new WeakSet<Document>();

/**
 * Install the `::highlight()` rules.
 *
 * An adopted stylesheet keeps the page DOM untouched, which is the spec's
 * stated constraint; the style element is a fallback for environments without
 * constructable stylesheets.
 */
export function installHighlightStyles(doc: Document = document): void {
  if (styledDocuments.has(doc)) return;

  const Sheet = (globalThis as { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;

  if (Sheet && 'adoptedStyleSheets' in doc) {
    try {
      const sheet = new Sheet();
      sheet.replaceSync(HIGHLIGHT_STYLES);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      styledDocuments.add(doc);
      return;
    } catch {
      // Fall through to a style element.
    }
  }

  const style = doc.createElement('style');
  style.setAttribute(STYLE_MARKER, '');
  style.textContent = HIGHLIGHT_STYLES;
  doc.head?.append(style);
  styledDocuments.add(doc);
}
