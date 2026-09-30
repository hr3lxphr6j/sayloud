import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OffscreenCommand, SynthesizeReply } from '~/lib/offscreen-protocol';
import {
  type CommandChannel,
  OffscreenSpeaker,
  type RuntimeEventSource,
} from '~/lib/offscreen-speaker';
import type { ProviderConfig } from '~/lib/providers/types';

const CONFIG: ProviderConfig = { provider: 'dashscope', apiKey: 'k', model: 'cosyvoice-v3' };

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A fake command channel.
 *
 * `null` means the offscreen worker reported a failure: it answers with nothing
 * and the reason arrives as an `error` event instead.
 */
function fakeChannel(reply: SynthesizeReply | null = { durationMs: 1000, hasTimings: false }) {
  const commands: OffscreenCommand[] = [];
  const channel: CommandChannel = {
    sendCommand: vi.fn(async (command: OffscreenCommand) => {
      commands.push(command);
      return command.type === 'synthesize' ? (reply ?? undefined) : undefined;
    }),
  };
  return { channel, commands };
}

function fakeEvents() {
  const listeners = new Set<(message: unknown) => void>();
  const source: RuntimeEventSource = {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
  };
  return {
    source,
    deliver: (message: unknown): void => {
      for (const listener of [...listeners]) listener(message);
    },
    get listenerCount(): number {
      return listeners.size;
    },
  };
}

/** The id the speaker put on the nth (1-based) utterance it sent. */
function utteranceId(commands: OffscreenCommand[], index = 0): string {
  const command = commands[index];
  if (command?.type !== 'synthesize') throw new Error('no synthesis was sent');
  return command.id;
}

describe('OffscreenSpeaker', () => {
  let channel: ReturnType<typeof fakeChannel>;
  let events: ReturnType<typeof fakeEvents>;
  let speaker: OffscreenSpeaker;
  let started: number;
  let words: Array<{ charStart: number; charEnd: number }>;
  let ends: number;
  let errors: string[];

  beforeEach(() => {
    channel = fakeChannel();
    events = fakeEvents();
    speaker = new OffscreenSpeaker({
      manager: channel.channel,
      config: CONFIG,
      events: events.source,
    });

    started = 0;
    words = [];
    ends = 0;
    errors = [];
    speaker.on('start', () => {
      started += 1;
    });
    speaker.on('word', (span) => words.push(span));
    speaker.on('end', () => {
      ends += 1;
    });
    speaker.on('error', (message) => errors.push(message));
  });

  describe('speak', () => {
    it('synthesizes, sets the rate, plays, and reports the start', async () => {
      speaker.speak({ text: 'hello', voice: 'v1', rate: 1.5, lang: 'en-US' });
      await tick();

      expect(channel.commands).toEqual([
        {
          type: 'synthesize',
          id: utteranceId(channel.commands),
          text: 'hello',
          voiceId: 'v1',
          config: CONFIG,
        },
        { type: 'setRate', rate: 1.5 },
        { type: 'play', id: utteranceId(channel.commands), startTimeMs: 0 },
      ]);
      expect(started).toBe(1);
    });

    it('sets the rate before playing, so the timeline starts at the right speed', async () => {
      speaker.speak({ text: 'hello', voice: 'v1', rate: 2, lang: 'en' });
      await tick();

      const types = channel.commands.map((command) => command.type);
      expect(types).toEqual(['synthesize', 'setRate', 'play']);
    });

    it('sets the volume before playing, so the first word is at the right loudness', async () => {
      speaker.speak({ text: 'hello', voice: 'v1', rate: 2, lang: 'en', volume: 1.2 });
      await tick();

      const types = channel.commands.map((command) => command.type);
      expect(types).toEqual(['synthesize', 'setRate', 'setVolume', 'play']);
      expect(channel.commands).toContainEqual({ type: 'setVolume', volume: 1.2 });
    });

    it('sends an empty voice id when the engine resolved no voice', async () => {
      speaker.speak({ text: 'hello', rate: 1, lang: 'en' });
      await tick();

      expect(channel.commands[0]).toMatchObject({ type: 'synthesize', voiceId: '' });
    });

    it('gives each utterance its own id', async () => {
      speaker.speak({ text: 'one', voice: 'v1', rate: 1, lang: 'en' });
      await tick();
      speaker.speak({ text: 'two', voice: 'v1', rate: 1, lang: 'en' });
      await tick();

      expect(utteranceId(channel.commands, 0)).not.toBe(utteranceId(channel.commands, 3));
    });

    it('stops after a synthesis the offscreen worker could not complete', async () => {
      channel = fakeChannel(null);
      speaker = new OffscreenSpeaker({
        manager: channel.channel,
        config: CONFIG,
        events: events.source,
      });
      const failures: string[] = [];
      speaker.on('error', (message) => failures.push(message));

      speaker.speak({ text: 'hello', voice: 'v1', rate: 1, lang: 'en' });
      await tick();

      // The worker already sent an `error` event; the speaker must not repeat
      // it, or the engine would fall back twice.
      expect(failures).toEqual([]);
      expect(channel.commands.map((command) => command.type)).toEqual(['synthesize']);
    });

    it('reports a command channel failure', async () => {
      vi.mocked(channel.channel.sendCommand).mockRejectedValue(new Error('no offscreen document'));

      speaker.speak({ text: 'hello', voice: 'v1', rate: 1, lang: 'en' });
      await tick();

      expect(errors).toEqual(['no offscreen document']);
      expect(started).toBe(0);
    });

    it('reports a playback failure', async () => {
      vi.mocked(channel.channel.sendCommand).mockImplementation(async (command) => {
        if (command.type === 'play') throw new Error('audio is not loaded');
        return command.type === 'synthesize' ? { durationMs: 1, hasTimings: false } : undefined;
      });

      speaker.speak({ text: 'hello', voice: 'v1', rate: 1, lang: 'en' });
      await tick();

      expect(errors).toEqual(['audio is not loaded']);
      expect(started).toBe(0);
    });
  });

  describe('setVolume', () => {
    it('changes the volume of the sentence that is playing, without creating a document', async () => {
      speaker.speak({ text: 'hello', voice: 'v1', rate: 1, lang: 'en' });
      await tick();

      speaker.setVolume(0.3);
      await tick();

      expect(channel.channel.sendCommand).toHaveBeenCalledWith(
        { type: 'setVolume', volume: 0.3 },
        { create: false }
      );
    });

    it('does not supersede the utterance that is playing', async () => {
      speaker.speak({ text: 'hello', voice: 'v1', rate: 1, lang: 'en' });
      await tick();
      const id = utteranceId(channel.commands);

      speaker.setVolume(0.3);
      await tick();
      events.deliver({ type: 'sentence-end', id });

      expect(ends).toBe(1);
    });

    it('survives a volume change that cannot be delivered', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(channel.channel.sendCommand).mockRejectedValue(new Error('no document'));

      speaker.setVolume(0.3);
      await tick();

      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('events from the offscreen document', () => {
    beforeEach(async () => {
      speaker.speak({ text: 'hello', voice: 'v1', rate: 1, lang: 'en' });
      await tick();
    });

    it('reports a word', () => {
      events.deliver({
        type: 'word',
        id: utteranceId(channel.commands),
        charStart: 0,
        charEnd: 5,
      });

      expect(words).toEqual([{ charStart: 0, charEnd: 5 }]);
    });

    it('reports the end of the sentence', () => {
      events.deliver({ type: 'sentence-end', id: utteranceId(channel.commands) });

      expect(ends).toBe(1);
    });

    it('reports an error', () => {
      events.deliver({
        type: 'error',
        id: utteranceId(channel.commands),
        code: 'rate-limit',
        message: 'too many requests',
      });

      expect(errors).toEqual(['too many requests']);
    });

    it('ignores the ready event, which the command reply already carried', () => {
      events.deliver({
        type: 'ready',
        id: utteranceId(channel.commands),
        durationMs: 1000,
        hasTimings: false,
      });

      expect(started).toBe(1);
      expect(words).toEqual([]);
      expect(ends).toBe(0);
      expect(errors).toEqual([]);
    });

    it.each([
      ['another sentence', { type: 'word', id: 'someone-else', charStart: 0, charEnd: 1 }],
      ['a command', { type: 'play', id: 'x', startTimeMs: 0 }],
      ['null', null],
      ['a string', 'sentence-end'],
      ['a malformed word', { type: 'word', id: 'sayloud-1', charStart: 'x' }],
    ])('ignores %s', (_label, message) => {
      events.deliver(message);

      expect(words).toEqual([]);
      expect(ends).toBe(0);
      expect(errors).toEqual([]);
    });
  });

  describe('superseding', () => {
    it('ignores events from an utterance that was replaced', async () => {
      speaker.speak({ text: 'one', voice: 'v1', rate: 1, lang: 'en' });
      await tick();
      const first = utteranceId(channel.commands);

      speaker.speak({ text: 'two', voice: 'v1', rate: 1, lang: 'en' });
      await tick();

      events.deliver({ type: 'word', id: first, charStart: 0, charEnd: 3 });
      events.deliver({ type: 'sentence-end', id: first });

      expect(words).toEqual([]);
      expect(ends).toBe(0);
    });

    it('does not play a synthesis that came back after a newer utterance', async () => {
      const pending: Array<(reply: SynthesizeReply | undefined) => void> = [];
      vi.mocked(channel.channel.sendCommand).mockImplementation(
        (command) =>
          new Promise((resolve) => {
            if (command.type === 'synthesize') {
              pending.push(resolve);
              return;
            }
            resolve(undefined);
          })
      );

      speaker.speak({ text: 'one', voice: 'v1', rate: 1, lang: 'en' });
      speaker.speak({ text: 'two', voice: 'v1', rate: 1, lang: 'en' });
      // The first synthesis finishes after the second was requested.
      pending[0]?.({ durationMs: 100, hasTimings: false });
      await tick();

      expect(channel.commands.filter((command) => command.type === 'play')).toEqual([]);
      expect(started).toBe(0);
    });
  });

  describe('stop', () => {
    it('tells the offscreen document to stop, without creating one', async () => {
      speaker.stop();
      await tick();

      expect(channel.commands).toEqual([{ type: 'stop' }]);
      expect(channel.channel.sendCommand).toHaveBeenCalledWith({ type: 'stop' }, { create: false });
    });

    it('ignores events from the utterance it stopped', async () => {
      speaker.speak({ text: 'one', voice: 'v1', rate: 1, lang: 'en' });
      await tick();
      const id = utteranceId(channel.commands);

      speaker.stop();
      events.deliver({ type: 'word', id, charStart: 0, charEnd: 3 });
      events.deliver({ type: 'sentence-end', id });

      expect(words).toEqual([]);
      expect(ends).toBe(0);
    });

    it('survives a stop that cannot be delivered', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(channel.channel.sendCommand).mockRejectedValue(new Error('no document'));

      speaker.stop();
      await tick();

      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('prefetch', () => {
    it('forwards a prefetch without creating a document or superseding the utterance', async () => {
      speaker.speak({ text: 'hello', voice: 'v1', rate: 1, lang: 'en' });
      await tick();
      const id = utteranceId(channel.commands);

      speaker.prefetch([{ text: 'next', voice: 'v1' }]);
      await tick();

      expect(channel.commands).toContainEqual({
        type: 'prefetch',
        items: [{ text: 'next', voiceId: 'v1' }],
        config: CONFIG,
      });
      expect(channel.channel.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'prefetch' }),
        { create: false }
      );

      // The sentence that is playing is untouched: its events still arrive.
      events.deliver({ type: 'sentence-end', id });
      expect(ends).toBe(1);
      expect(started).toBe(1);
    });

    it('sends an empty voice id when a request has none', async () => {
      speaker.prefetch([{ text: 'next' }]);
      await tick();

      expect(channel.commands).toContainEqual({
        type: 'prefetch',
        items: [{ text: 'next', voiceId: '' }],
        config: CONFIG,
      });
    });

    it('does not send an empty prefetch', async () => {
      speaker.prefetch([]);
      await tick();

      expect(channel.commands).toEqual([]);
    });

    it('survives a prefetch that cannot be delivered', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(channel.channel.sendCommand).mockRejectedValue(new Error('no document'));

      speaker.prefetch([{ text: 'next', voice: 'v1' }]);
      await tick();

      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('listeners', () => {
    it('stops delivering after an unsubscribe', async () => {
      const seen: number[] = [];
      const unsubscribe = speaker.on('end', () => seen.push(1));
      unsubscribe();

      speaker.speak({ text: 'one', voice: 'v1', rate: 1, lang: 'en' });
      await tick();
      events.deliver({ type: 'sentence-end', id: utteranceId(channel.commands) });

      expect(seen).toEqual([]);
    });

    it('survives an event when nothing is listening', async () => {
      const bare = new OffscreenSpeaker({
        manager: channel.channel,
        config: CONFIG,
        events: events.source,
      });
      bare.speak({ text: 'hello', voice: 'v1', rate: 1, lang: 'en' });
      await tick();
      const id = utteranceId(channel.commands);

      expect(() => {
        events.deliver({ type: 'start', id });
        events.deliver({ type: 'word', id, charStart: 0, charEnd: 1 });
        events.deliver({ type: 'sentence-end', id });
        events.deliver({ type: 'error', id, code: 'unknown', message: 'boom' });
      }).not.toThrow();
    });

    it('unsubscribes from the runtime on dispose', () => {
      expect(events.listenerCount).toBe(1);

      speaker.dispose();

      expect(events.listenerCount).toBe(0);
    });
  });
});
