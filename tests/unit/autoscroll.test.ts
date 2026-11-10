import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FOLLOW_ANCHOR,
  FOLLOW_BAND,
  findScrollContainer,
  followDelta,
  SCROLL_PAUSE_MS,
  ScrollSuspension,
  scrollBehavior,
  scrollFrame,
  sentenceRect,
} from '~/lib/autoscroll';

describe('followDelta', () => {
  const viewportHeight = 1000;

  it('leaves the page alone while the sentence top is inside the band', () => {
    expect(followDelta({ top: 330, viewportTop: 0, viewportHeight })).toBe(0);
    // The band is 18%–48% at the default anchor and half-height.
    expect(followDelta({ top: 180, viewportTop: 0, viewportHeight })).toBe(0);
    expect(followDelta({ top: 480, viewportTop: 0, viewportHeight })).toBe(0);
  });

  it('scrolls up when the sentence has risen above the band', () => {
    expect(followDelta({ top: 100, viewportTop: 0, viewportHeight })).toBe(-230);
  });

  it('scrolls down when the sentence is below the band', () => {
    expect(followDelta({ top: 900, viewportTop: 0, viewportHeight })).toBe(570);
  });

  it('measures the band inside the scrollable area, not the window', () => {
    // A nested scroller starting 200px down the page: band 308–488.
    const geometry = { viewportTop: 200, viewportHeight: 600 };
    expect(followDelta({ top: 400, ...geometry })).toBe(0);
    expect(followDelta({ top: 700, ...geometry })).toBe(700 - (200 + 600 * FOLLOW_ANCHOR));
  });

  it('only considers the top edge, however tall the sentence is', () => {
    // A sentence spanning the whole viewport keeps its top where it is.
    expect(followDelta({ top: 330, viewportTop: 0, viewportHeight })).toBe(0);
  });

  it('honours a custom anchor and band', () => {
    const geometry = { viewportTop: 0, viewportHeight: 1000, anchor: 0.5, band: 0.1 };
    expect(followDelta({ top: 500, ...geometry })).toBe(0);
    expect(followDelta({ top: 450, ...geometry })).toBe(0);
    expect(followDelta({ top: 300, ...geometry })).toBe(-200);
  });

  it('never asks for a scroll when the viewport has no height', () => {
    expect(followDelta({ top: 900, viewportTop: 0, viewportHeight: 0 })).toBe(0);
  });

  it('documents the defaults', () => {
    expect(FOLLOW_ANCHOR).toBe(0.33);
    expect(FOLLOW_BAND).toBe(0.15);
  });
});

describe('sentenceRect', () => {
  it('uses the first rect that covers pixels', () => {
    const range = document.createRange();
    const rects = [
      { top: 10, bottom: 10, width: 0, height: 0 },
      { top: 40, bottom: 60, width: 200, height: 20 },
      { top: 60, bottom: 80, width: 120, height: 20 },
    ];
    Object.defineProperty(range, 'getClientRects', { value: () => rects });
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => ({ top: 40, bottom: 80 }),
    });

    expect(sentenceRect(range)).toEqual({ top: 40, bottom: 60 });
  });

  it('falls back to the bounding box when there are no client rects', () => {
    const range = document.createRange();
    Object.defineProperty(range, 'getClientRects', { value: () => [] });
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => ({ top: 12, bottom: 34 }),
    });

    expect(sentenceRect(range)).toEqual({ top: 12, bottom: 34 });
  });
});

describe('scrollFrame', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the page from scrollingElement', () => {
    const root = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(root, 'scrollTop', { configurable: true, value: 300 });
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 5_000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    expect(scrollFrame(null)).toEqual({
      scrollTop: 300,
      scrollHeight: 5_000,
      height: 800,
      top: 0,
    });
  });

  it('clips a nested container to the window and drops its border', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientTop', { configurable: true, value: 4 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 120 });
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 3_000 });
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, bottom: 704, left: 0, right: 800 }),
    });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });

    expect(scrollFrame(container)).toEqual({
      scrollTop: 120,
      scrollHeight: 3_000,
      height: 596,
      top: 104,
    });
  });
});

describe('findScrollContainer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function scrollable(element: HTMLElement): HTMLElement {
    element.style.overflowY = 'auto';
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 800 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 200 });
    return element;
  }

  it('finds the nearest vertical scroller above the text', () => {
    const outer = scrollable(document.createElement('div'));
    const inner = scrollable(document.createElement('div'));
    const paragraph = document.createElement('p');
    paragraph.textContent = 'text';
    inner.append(paragraph);
    outer.append(inner);
    document.body.append(outer);

    expect(findScrollContainer(paragraph.firstChild as Node)).toBe(inner);
  });

  it('ignores containers that cannot scroll', () => {
    const box = document.createElement('div');
    box.style.overflowY = 'auto';
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 200 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 200 });
    const paragraph = document.createElement('p');
    paragraph.textContent = 'text';
    box.append(paragraph);
    document.body.append(box);

    expect(findScrollContainer(paragraph.firstChild as Node)).toBeNull();
  });

  it('ignores overflow that the reader cannot move', () => {
    const box = document.createElement('div');
    box.style.overflowY = 'hidden';
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 800 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 200 });
    const paragraph = document.createElement('p');
    paragraph.textContent = 'text';
    box.append(paragraph);
    document.body.append(box);

    expect(findScrollContainer(paragraph.firstChild as Node)).toBeNull();
  });

  it('falls back to the page when nothing above scrolls', () => {
    document.body.innerHTML = '<article><p>text</p></article>';
    const text = document.querySelector('p')?.firstChild as Node;

    expect(findScrollContainer(text)).toBeNull();
  });
});

describe('scrollBehavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is instant when the reader asked for reduced motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as MediaQueryList);

    expect(scrollBehavior()).toBe('auto');
  });

  it('is smooth otherwise', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
    } as MediaQueryList);

    expect(scrollBehavior()).toBe('smooth');
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

  it('honours user input even while our own scroll is running', () => {
    const time = clock();
    const suspension = new ScrollSuspension({ now: time.now });

    suspension.noteProgrammatic();
    suspension.noteUserInput();

    expect(suspension.active).toBe(true);
  });

  it('ends the programmatic window early when the scroll settles', () => {
    const time = clock();
    const suspension = new ScrollSuspension({ now: time.now });

    suspension.noteProgrammatic();
    suspension.clearProgrammatic();
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

  it('documents the default pause', () => {
    expect(SCROLL_PAUSE_MS).toBe(5_000);
  });
});
