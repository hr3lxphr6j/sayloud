export interface RectLike {
  top: number;
  bottom: number;
}

/** How long a manual scroll keeps auto-scrolling off. */
export const SCROLL_PAUSE_MS = 5_000;

/**
 * How long after our own smooth scroll we keep ignoring scroll events.
 * `scrollIntoView({ behavior: 'smooth' })` fires scroll events for as long as
 * the animation runs, and those must not read as the user scrolling away.
 */
export const PROGRAMMATIC_SCROLL_MS = 1_000;

/**
 * How little of the sentence may remain on screen before we scroll it back.
 * Small on purpose: a sentence the reader can already see must not be moved,
 * or auto-scrolling would fight the reader's own position.
 */
export const EDGE_TOLERANCE = 24;

/**
 * True when the sentence has effectively left the viewport, i.e. less than
 * `tolerance` pixels of it are still on screen.
 */
export function needsReveal(
  rect: RectLike,
  viewportHeight: number,
  tolerance = EDGE_TOLERANCE
): boolean {
  if (!(viewportHeight > 0)) return false;
  const visible = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
  return visible < tolerance;
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
 * The page fires the same `scroll` event for our own smooth scrolling and for
 * the user dragging the page, so the caller announces its own scrolls with
 * `noteProgrammatic()` and only real user scrolls suspend auto-scrolling.
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

  /** Every `scroll` event on the page goes through here. */
  noteScroll(): void {
    if (this.now() < this.ignoreUntil) return;
    this.suspendedUntil = this.now() + this.pauseMs;
  }

  /** Clear the suspension, e.g. after the user asked to go back. */
  resume(): void {
    this.suspendedUntil = 0;
    this.ignoreUntil = 0;
  }
}
