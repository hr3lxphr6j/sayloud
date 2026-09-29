import { describe, expect, it } from 'vitest';
import { needsReveal, ScrollSuspension } from '~/lib/autoscroll';

describe('needsReveal', () => {
  const viewport = 1000;

  it('is false while the sentence is comfortably inside the viewport', () => {
    expect(needsReveal({ top: 400, bottom: 460 }, viewport)).toBe(false);
  });

  it('is true when the sentence sits above the viewport', () => {
    expect(needsReveal({ top: -120, bottom: -60 }, viewport)).toBe(true);
  });

  it('is true when the sentence sits below the viewport', () => {
    expect(needsReveal({ top: 1100, bottom: 1160 }, viewport)).toBe(true);
  });

  it('leaves a sentence alone while enough of it is still on screen', () => {
    expect(needsReveal({ top: -10, bottom: 30 }, viewport)).toBe(false);
    expect(needsReveal({ top: 20, bottom: 60 }, viewport)).toBe(false);
  });

  it('scrolls back once barely any of the sentence is visible', () => {
    expect(needsReveal({ top: 990, bottom: 1_010 }, viewport)).toBe(true);
    expect(needsReveal({ top: -20, bottom: 10 }, viewport)).toBe(true);
  });

  it('honours a custom tolerance', () => {
    const rect = { top: 980, bottom: 1_020 };
    expect(needsReveal(rect, viewport, 10)).toBe(false);
    expect(needsReveal(rect, viewport, 30)).toBe(true);
  });

  it('never asks for a scroll when the viewport has no height', () => {
    expect(needsReveal({ top: 10, bottom: 20 }, 0)).toBe(false);
  });
});

describe('ScrollSuspension', () => {
  function clock(start = 0) {
    let now = start;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('is inactive until the user scrolls', () => {
    const suspension = new ScrollSuspension({ now: clock().now });
    expect(suspension.active).toBe(false);
  });

  it('suppresses auto-scroll for 5 seconds after a manual scroll', () => {
    const time = clock();
    const suspension = new ScrollSuspension({ now: time.now });

    suspension.noteScroll();
    expect(suspension.active).toBe(true);

    time.advance(4_999);
    expect(suspension.active).toBe(true);

    time.advance(1);
    expect(suspension.active).toBe(false);
  });

  it('restarts the window on every manual scroll', () => {
    const time = clock();
    const suspension = new ScrollSuspension({ now: time.now });

    suspension.noteScroll();
    time.advance(4_000);
    suspension.noteScroll();
    time.advance(4_000);

    expect(suspension.active).toBe(true);
  });

  it('ignores the scroll events our own smooth scroll produces', () => {
    const time = clock();
    const suspension = new ScrollSuspension({ now: time.now });

    suspension.noteProgrammatic();
    suspension.noteScroll();
    expect(suspension.active).toBe(false);

    // The window only covers the animation, not the rest of the session.
    time.advance(2_000);
    suspension.noteScroll();
    expect(suspension.active).toBe(true);
  });

  it('lets a caller resume immediately', () => {
    const time = clock();
    const suspension = new ScrollSuspension({ now: time.now });

    suspension.noteScroll();
    expect(suspension.active).toBe(true);

    suspension.resume();
    expect(suspension.active).toBe(false);
  });

  it('honours a custom pause window', () => {
    const time = clock();
    const suspension = new ScrollSuspension({ pauseMs: 100, now: time.now });

    suspension.noteScroll();
    time.advance(100);
    expect(suspension.active).toBe(false);
  });
});
