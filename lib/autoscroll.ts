/** The vertical extent of something on screen, in viewport pixels. */
export interface RectLike {
  top: number;
  bottom: number;
}

/** How long a manual scroll keeps auto-scrolling off. */
export const SCROLL_PAUSE_MS = 5_000;

/**
 * How long after our own smooth scroll we keep ignoring scroll events.
 * `scrollTo({ behavior: 'smooth' })` fires scroll events for as long as the
 * animation runs, and those must not read as the user scrolling away. The
 * window is a fallback: `scrollend` ends it early where it is supported.
 */
export const PROGRAMMATIC_SCROLL_MS = 1_000;

/** Where the top of the sentence being read should sit, 0=top, 1=bottom. */
export const FOLLOW_ANCHOR = 0.33;

/**
 * Half the height of the comfort band. While the sentence's top edge is inside
 * `anchor ± band`, auto-scrolling leaves the page alone — a band rather than a
 * point is what keeps a page from twitching sentence after sentence.
 */
export const FOLLOW_BAND = 0.15;

export interface FollowGeometry {
  /** The sentence's top edge, in viewport coordinates. */
  top: number;
  /** The top of the scrollable area, in viewport coordinates; 0 for the page. */
  viewportTop: number;
  /** The height of the scrollable area visible on screen. */
  viewportHeight: number;
  anchor?: number;
  band?: number;
}

/**
 * How far the page should scroll to put `top` back at the anchor, in pixels.
 *
 * Zero means the sentence's top edge is already inside the comfort band and the
 * page must not move. Only the top edge is considered: a sentence taller than
 * the band can never be fully inside it, and chasing its bottom edge would make
 * the page lurch once per line.
 */
export function followDelta({
  top,
  viewportTop,
  viewportHeight,
  anchor = FOLLOW_ANCHOR,
  band = FOLLOW_BAND,
}: FollowGeometry): number {
  if (!(viewportHeight > 0)) return 0;

  const bandTop = viewportTop + viewportHeight * (anchor - band);
  const bandBottom = viewportTop + viewportHeight * (anchor + band);
  // Half a pixel of slack: `anchor ± band` is floating point, and a sentence
  // sitting exactly on the edge must count as inside rather than twitch.
  const slack = 0.5;
  if (top >= bandTop - slack && top <= bandBottom + slack) return 0;

  return top - (viewportTop + viewportHeight * anchor);
}

/**
 * The first client rect of `range` that actually covers pixels.
 *
 * A range's bounding box is the union of every line it spans, so a sentence
 * that begins at the end of one line and continues on the next can report a top
 * edge belonging to the previous line. The first non-empty rect is the sentence
 * itself. Falling back to the bounding box keeps the caller working in browsers
 * that report no client rects.
 */
export function sentenceRect(range: Range): RectLike {
  const rects = range.getClientRects();
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (rect && rect.width > 0 && rect.height > 0) {
      return { top: rect.top, bottom: rect.bottom };
    }
  }
  const rect = range.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

export interface ScrollFrame {
  scrollTop: number;
  scrollHeight: number;
  /** The visible height: the element's content box clipped to the window. */
  height: number;
  /** The top of the visible area, in viewport coordinates. */
  top: number;
}

/**
 * The scrolling state of `el`, or of the page when `el` is null.
 *
 * A nested scroller may extend past the window, so its usable viewport is the
 * intersection of its content box with the window — anchoring to a band drawn
 * outside the screen would scroll to the wrong place.
 */
export function scrollFrame(el: Element | null): ScrollFrame {
  if (el) {
    const rect = el.getBoundingClientRect();
    const contentTop = rect.top + el.clientTop;
    const top = Math.max(contentTop, 0);
    const bottom = Math.min(contentTop + el.clientHeight, window.innerHeight);
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      height: Math.max(0, bottom - top),
      top,
    };
  }

  // `scrollingElement` rather than `documentElement`: in quirks mode and in
  // pages that scroll on `<body>`, it is the element that actually moves.
  const root = document.scrollingElement ?? document.documentElement;
  return {
    scrollTop: root?.scrollTop ?? window.scrollY,
    scrollHeight: root?.scrollHeight ?? 0,
    height: window.innerHeight,
    top: 0,
  };
}

/**
 * The nearest ancestor of `node` that scrolls vertically, or null for the page.
 *
 * Found by walking up rather than by watching scroll events: a container's
 * scroll events do not bubble to the window, and the container's height is the
 * one the comfort band has to be measured against.
 */
export function findScrollContainer(node: Node): Element | null {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  while (el) {
    if (isScrollable(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function isScrollable(el: Element): boolean {
  // The page's own root is handled by `scrollFrame(null)`.
  if (el === document.scrollingElement) return false;
  const overflowY = getComputedStyle(el).overflowY;
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false;
  return el.scrollHeight > el.clientHeight + 4;
}

/**
 * The scroll animation to ask for.
 *
 * `'smooth'` is skipped when the reader asked for reduced motion, and when the
 * browser predates scroll-behavior (Safari before 15.4) — the enum is ignored
 * there, so the explicit fallback is what actually keeps the scroll instant.
 */
export function scrollBehavior(): ScrollBehavior {
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return 'auto';
  if (!('scrollBehavior' in document.documentElement.style)) return 'auto';
  return 'smooth';
}

export interface ScrollSuspensionOptions {
  /** How long a manual scroll suppresses auto-scrolling. */
  pauseMs?: number;
  /** How long our own scroll animation is ignored. */
  programmaticMs?: number;
  now?: () => number;
}

/**
 * Decides whether auto-scrolling is allowed right now.
 *
 * User intent is recognised from input events (`noteUserInput`) and, as a
 * fallback for scrolls that produce no such event — dragging the scrollbar,
 * Ctrl+F, an in-page anchor — from the page's own scroll events. The latter is
 * ambiguous with our own scrolling, so `noteProgrammatic` opens a short window
 * during which scroll events are ignored; input events bypass that window, or a
 * reader who grabs the wheel mid-animation would be overruled by us.
 */
export class ScrollSuspension {
  private readonly pauseMs: number;
  private readonly programmaticMs: number;
  private readonly now: () => number;
  private suspendedUntil = 0;
  private ignoreUntil = 0;

  constructor(options: ScrollSuspensionOptions = {}) {
    this.pauseMs = options.pauseMs ?? SCROLL_PAUSE_MS;
    this.programmaticMs = options.programmaticMs ?? PROGRAMMATIC_SCROLL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** True while a recent manual scroll suppresses auto-scrolling. */
  get active(): boolean {
    return this.now() < this.suspendedUntil;
  }

  /** Announce an auto-scroll we are about to perform. */
  noteProgrammatic(): void {
    this.ignoreUntil = this.now() + this.programmaticMs;
  }

  /** End the ignore window early, when the browser says the scroll settled. */
  clearProgrammatic(): void {
    this.ignoreUntil = 0;
  }

  /** A user input that scrolls — honoured even during our own animation. */
  noteUserInput(): void {
    this.suspendedUntil = this.now() + this.pauseMs;
  }

  /** A scroll event with no matching input event, e.g. a scrollbar drag. */
  noteScroll(): void {
    if (this.now() < this.ignoreUntil) return;
    this.noteUserInput();
  }

  /** Clear the suspension, e.g. after the user asked to go back. */
  resume(): void {
    this.suspendedUntil = 0;
    this.ignoreUntil = 0;
  }
}
