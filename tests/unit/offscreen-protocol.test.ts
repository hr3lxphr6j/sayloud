import { describe, expect, it } from 'vitest';
import {
  CACHE_CLEARED,
  CACHE_POLICY_REQUEST,
  isCacheCleared,
  isCachePolicyMessage,
  isCachePolicyRequest,
  isOffscreenCommand,
  isOffscreenEvent,
  type OffscreenCommand,
} from '~/lib/offscreen-protocol';

const CONFIG = { provider: 'browser' } as const;
const POLICY = { persist: true, maxBytes: 200 * 1024 * 1024 };

describe('isOffscreenCommand', () => {
  const valid: OffscreenCommand[] = [
    { type: 'synthesize', id: 'a', text: 'hi', voiceId: 'v', lang: 'en-US', config: CONFIG },
    { type: 'prefetch', items: [{ text: 'hi', voiceId: 'v' }], config: CONFIG },
    { type: 'prefetch', items: [], config: CONFIG },
    { type: 'play', id: 'a', startTimeMs: 0 },
    { type: 'pause' },
    { type: 'setRate', rate: 1.5 },
    { type: 'setVolume', volume: 1.5 },
    { type: 'stop' },
  ];

  it.each(valid)('accepts $type', (command) => {
    expect(isOffscreenCommand(command)).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'synthesize'],
    ['an array', []],
    ['an unknown type', { type: 'explode' }],
    ['no type', { id: 'a' }],
    ['a synthesize without text', { type: 'synthesize', id: 'a', voiceId: 'v', lang: 'en-US', config: CONFIG }],
    [
      'a synthesize with a null config',
      { type: 'synthesize', id: 'a', text: 'hi', voiceId: 'v', lang: 'en-US', config: null },
    ],
    ['a synthesize with an empty id', { type: 'synthesize', id: '', text: 'hi', voiceId: 'v', lang: 'en-US' }],
    ['a prefetch without items', { type: 'prefetch', config: CONFIG }],
    ['a prefetch with non-array items', { type: 'prefetch', items: 'nope', config: CONFIG }],
    [
      'a prefetch item without a voice',
      { type: 'prefetch', items: [{ text: 'hi' }], config: CONFIG },
    ],
    [
      'a prefetch item with a non-string text',
      { type: 'prefetch', items: [{ text: 1, voiceId: 'v' }], config: CONFIG },
    ],
    ['a prefetch with a null config', { type: 'prefetch', items: [], config: null }],
    ['a play without a time', { type: 'play', id: 'a' }],
    ['a play with NaN', { type: 'play', id: 'a', startTimeMs: Number.NaN }],
    ['a setRate without a rate', { type: 'setRate' }],
    ['a setRate with Infinity', { type: 'setRate', rate: Number.POSITIVE_INFINITY }],
    ['a setVolume without a volume', { type: 'setVolume' }],
    ['a setVolume with NaN', { type: 'setVolume', volume: Number.NaN }],
  ])('rejects %s', (_label, value) => {
    expect(isOffscreenCommand(value)).toBe(false);
  });

  it('accepts a zero-length synthesis, which the worker skips', () => {
    expect(
      isOffscreenCommand({ type: 'synthesize', id: 'a', text: '', voiceId: 'v', lang: 'en-US', config: CONFIG })
    ).toBe(true);
  });
});

describe('isOffscreenEvent', () => {
  it('accepts every event shape', () => {
    expect(isOffscreenEvent({ type: 'ready', id: 'a', durationMs: 1200, hasTimings: true })).toBe(
      true
    );
    expect(isOffscreenEvent({ type: 'word', id: 'a', charStart: 0, charEnd: 3 })).toBe(true);
    expect(isOffscreenEvent({ type: 'sentence-end', id: 'a' })).toBe(true);
    expect(
      isOffscreenEvent({ type: 'error', id: 'a', code: 'rate-limit', message: 'slow down' })
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['an unknown type', { type: 'command' }],
    ['an event with no id', { type: 'sentence-end' }],
    ['an event with an empty id', { type: 'sentence-end', id: '' }],
    ['ready without a duration', { type: 'ready', id: 'a', hasTimings: false }],
    ['ready with a non-boolean flag', { type: 'ready', id: 'a', durationMs: 1, hasTimings: 'yes' }],
    ['word with a missing end', { type: 'word', id: 'a', charStart: 0 }],
    ['word with NaN offsets', { type: 'word', id: 'a', charStart: Number.NaN, charEnd: 3 }],
    ['error without a code', { type: 'error', id: 'a', message: 'boom' }],
  ])('rejects %s', (_label, value) => {
    expect(isOffscreenEvent(value)).toBe(false);
  });

  it('rejects a command, so the two channels cannot be confused', () => {
    expect(isOffscreenEvent({ type: 'play', id: 'a', startTimeMs: 0 })).toBe(false);
  });
});

describe('CACHE_CLEARED', () => {
  it('is the broadcast the settings panel sends', () => {
    expect(CACHE_CLEARED).toEqual({ type: 'cache-cleared' });
  });

  it('recognises the broadcast', () => {
    expect(isCacheCleared(CACHE_CLEARED)).toBe(true);
    expect(isCacheCleared({ ...CACHE_CLEARED })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'cache-cleared'],
    ['an array', []],
    ['another type', { type: 'stop' }],
    ['no type', { cache: 'cleared' }],
  ])('does not recognise %s', (_label, value) => {
    expect(isCacheCleared(value)).toBe(false);
  });

  it('is not a command, so the executor never handles it', () => {
    expect(isOffscreenCommand(CACHE_CLEARED)).toBe(false);
  });
});

describe('the cache policy messages', () => {
  it('recognises the boot request', () => {
    expect(CACHE_POLICY_REQUEST).toEqual({ type: 'cache-policy-request' });
    expect(isCachePolicyRequest(CACHE_POLICY_REQUEST)).toBe(true);
  });

  it('recognises a policy', () => {
    expect(isCachePolicyMessage({ type: 'cache-policy', cache: POLICY })).toBe(true);
  });

  it.each([
    ['a request where a policy belongs', CACHE_POLICY_REQUEST],
    ['a policy with no cache', { type: 'cache-policy' }],
    ['a cache that is not an object', { type: 'cache-policy', cache: 'all of it' }],
    ['a missing persist flag', { type: 'cache-policy', cache: { maxBytes: 8 } }],
    [
      'a budget that is not a size',
      { type: 'cache-policy', cache: { persist: true, maxBytes: 'big' } },
    ],
    ['a budget of zero', { type: 'cache-policy', cache: { persist: true, maxBytes: 0 } }],
  ])('rejects %s', (_label, value) => {
    expect(isCachePolicyMessage(value)).toBe(false);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['another type', { type: 'cache-cleared' }],
  ])('does not mistake %s for a boot request', (_label, value) => {
    expect(isCachePolicyRequest(value)).toBe(false);
  });

  it('is not a command, so the executor never handles it', () => {
    expect(isOffscreenCommand({ type: 'cache-policy', cache: POLICY })).toBe(false);
    expect(isOffscreenCommand(CACHE_POLICY_REQUEST)).toBe(false);
  });
});
