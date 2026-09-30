import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSpeaker,
  isSupportedVoice,
  pickVoice,
  supportedVoices,
  type TtsApi,
  type TtsEventLike,
  type TtsSpeakOptions,
  type TtsVoiceLike,
} from '~/lib/speaker';

/** Captures the options passed to `speak` so tests can replay TTS events. */
function fakeTts(voices: TtsVoiceLike[] = []) {
  const calls: Array<{ text: string; options: TtsSpeakOptions }> = [];
  const tts: TtsApi = {
    speak(text, options) {
      calls.push({ text, options });
    },
    stop: vi.fn(),
    getVoices: async () => voices,
  };

  const emit = (event: TtsEventLike, callIndex = calls.length - 1): void => {
    calls[callIndex]?.options.onEvent?.(event);
  };

  return { tts, calls, emit };
}

describe('BrowserSpeaker', () => {
  let fake: ReturnType<typeof fakeTts>;
  let speaker: BrowserSpeaker;

  beforeEach(() => {
    fake = fakeTts();
    speaker = new BrowserSpeaker(fake.tts);
  });

  it('has no prefetch, so the engine has nothing to warm', () => {
    expect('prefetch' in speaker).toBe(false);
  });

  it('passes the sentence and speech options to chrome.tts', () => {
    speaker.speak({ text: 'Hello world.', voice: 'Samantha', rate: 1.5, lang: 'en-US' });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.text).toBe('Hello world.');
    expect(fake.calls[0]?.options).toMatchObject({
      voiceName: 'Samantha',
      rate: 1.5,
      lang: 'en-US',
      enqueue: false,
    });
  });

  it('flushes queued speech before speaking a new sentence', () => {
    speaker.speak({ text: 'First.', rate: 1, lang: 'en' });
    speaker.speak({ text: 'Second.', rate: 1, lang: 'en' });

    // Once before the first utterance and once before the second.
    expect(fake.tts.stop).toHaveBeenCalledTimes(2);
  });

  it('reports start and end', () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    speaker.on('start', onStart);
    speaker.on('end', onEnd);

    speaker.speak({ text: 'Hello world.', rate: 1, lang: 'en' });
    fake.emit({ type: 'start', charIndex: 0 });
    fake.emit({ type: 'end', charIndex: 12 });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('maps a word event to a sentence-relative span', () => {
    const onWord = vi.fn();
    speaker.on('word', onWord);

    speaker.speak({ text: 'Hello world.', rate: 1, lang: 'en' });
    fake.emit({ type: 'word', charIndex: 6, length: 5 });

    expect(onWord).toHaveBeenCalledWith({ charStart: 6, charEnd: 11 });
  });

  it('drops word events without a usable length instead of estimating', () => {
    const onWord = vi.fn();
    speaker.on('word', onWord);

    speaker.speak({ text: 'Hello world.', rate: 1, lang: 'en' });
    fake.emit({ type: 'word', charIndex: 6, length: -1 });
    fake.emit({ type: 'word', charIndex: 6 });
    fake.emit({ type: 'word', charIndex: 6, length: 0 });

    expect(onWord).not.toHaveBeenCalled();
  });

  it('clamps a word span that runs past the sentence', () => {
    const onWord = vi.fn();
    speaker.on('word', onWord);

    speaker.speak({ text: 'Hi there', rate: 1, lang: 'en' });
    fake.emit({ type: 'word', charIndex: 3, length: 99 });

    expect(onWord).toHaveBeenCalledWith({ charStart: 3, charEnd: 8 });
  });

  it('reports the error message from the engine', () => {
    const onError = vi.fn();
    speaker.on('error', onError);

    speaker.speak({ text: 'Hello.', rate: 1, lang: 'en' });
    fake.emit({ type: 'error', errorMessage: 'voice not found' });

    expect(onError).toHaveBeenCalledWith('voice not found');
  });

  it('falls back to a generic message when the engine sends none', () => {
    const onError = vi.fn();
    speaker.on('error', onError);

    speaker.speak({ text: 'Hello.', rate: 1, lang: 'en' });
    fake.emit({ type: 'error' });

    expect(onError).toHaveBeenCalledWith('browser voice failed');
  });

  it('ignores events that belong to a replaced utterance', () => {
    const onWord = vi.fn();
    const onEnd = vi.fn();
    speaker.on('word', onWord);
    speaker.on('end', onEnd);

    speaker.speak({ text: 'First sentence.', rate: 1, lang: 'en' });
    speaker.speak({ text: 'Second sentence.', rate: 1, lang: 'en' });

    // Events from the first utterance arrive late; they must not move the cursor.
    fake.emit({ type: 'word', charIndex: 0, length: 5 }, 0);
    fake.emit({ type: 'end', charIndex: 15 }, 0);
    expect(onWord).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();

    // The current utterance still reports normally.
    fake.emit({ type: 'word', charIndex: 0, length: 6 }, 1);
    expect(onWord).toHaveBeenCalledWith({ charStart: 0, charEnd: 6 });
  });

  it('ignores events that arrive after stop()', () => {
    const onWord = vi.fn();
    const onEnd = vi.fn();
    speaker.on('word', onWord);
    speaker.on('end', onEnd);

    speaker.speak({ text: 'Hello world.', rate: 1, lang: 'en' });
    speaker.stop();
    fake.emit({ type: 'word', charIndex: 6, length: 5 });
    fake.emit({ type: 'end', charIndex: 12 });

    expect(onWord).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(fake.tts.stop).toHaveBeenCalledTimes(2);
  });

  it('ignores event types it does not act on', () => {
    const onStart = vi.fn();
    const onWord = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    speaker.on('start', onStart);
    speaker.on('word', onWord);
    speaker.on('end', onEnd);
    speaker.on('error', onError);

    speaker.speak({ text: 'Hello world.', rate: 1, lang: 'en' });
    for (const type of ['interrupted', 'cancelled', 'sentence', 'marker', 'pause', 'resume']) {
      fake.emit({ type, charIndex: 0 });
    }

    expect(onStart).not.toHaveBeenCalled();
    expect(onWord).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops delivering events after the listener unsubscribes', () => {
    const onWord = vi.fn();
    const off = speaker.on('word', onWord);

    speaker.speak({ text: 'Hello world.', rate: 1, lang: 'en' });
    fake.emit({ type: 'word', charIndex: 0, length: 5 });
    off();
    fake.emit({ type: 'word', charIndex: 6, length: 5 });

    expect(onWord).toHaveBeenCalledTimes(1);
  });

  it('stops speaking and forgets listeners on dispose', () => {
    const onWord = vi.fn();
    speaker.on('word', onWord);

    speaker.speak({ text: 'Hello world.', rate: 1, lang: 'en' });
    speaker.dispose();
    fake.emit({ type: 'word', charIndex: 0, length: 5 });

    expect(fake.tts.stop).toHaveBeenCalled();
    expect(onWord).not.toHaveBeenCalled();
  });
});

describe('voice selection', () => {
  const voices: TtsVoiceLike[] = [
    { voiceName: 'Tingting', lang: 'zh-CN', eventTypes: ['word'] },
    { voiceName: 'Samantha', lang: 'en-US', eventTypes: ['word'] },
    { voiceName: 'Daniel', lang: 'en-GB' },
    { voiceName: 'Kyoko', lang: 'ja-JP' },
    { voiceName: 'Anna', lang: 'de-DE' },
    { voiceName: 'Cloud', lang: 'en-US', remote: true },
  ];

  it('filters to the supported languages', () => {
    expect(supportedVoices(voices).map((v) => v.voiceName)).toEqual([
      'Tingting',
      'Samantha',
      'Daniel',
      'Kyoko',
      'Cloud',
    ]);
    expect(isSupportedVoice({ lang: 'de-DE' })).toBe(false);
    expect(isSupportedVoice({ lang: 'zh' })).toBe(true);
    expect(isSupportedVoice({})).toBe(false);
  });

  it('prefers an exact language match', () => {
    expect(pickVoice(voices, 'en-GB')?.voiceName).toBe('Daniel');
  });

  it('falls back to the same primary subtag', () => {
    expect(pickVoice(voices, 'zh-TW')?.voiceName).toBe('Tingting');
  });

  it('prefers a local voice over a remote one for the same language', () => {
    expect(pickVoice(voices, 'en-US')?.voiceName).toBe('Samantha');
  });

  it('falls back to English for an unsupported page language', () => {
    expect(pickVoice(voices, 'fr-FR')?.voiceName).toBe('Samantha');
  });

  it('never picks a voice for an unsupported language', () => {
    expect(pickVoice([{ voiceName: 'Anna', lang: 'de-DE' }], 'de-DE')).toBeNull();
    expect(pickVoice([], 'en-US')).toBeNull();
  });
});
