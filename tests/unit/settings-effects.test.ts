import { describe, expect, it, vi } from 'vitest';
import type { EnginePhase } from '~/lib/protocol';
import { applyPlaybackSettings, type PlaybackTarget } from '~/lib/settings-effects';
import { DEFAULT_SETTINGS, type Settings } from '~/lib/settings-store';

/** A playback target that records what it was told, in order. */
function fakeTarget(phase: EnginePhase = 'playing') {
  const calls: string[] = [];
  const target: PlaybackTarget = {
    getStatus: () => ({ phase }),
    setVolume: vi.fn((volume: number) => calls.push(`volume:${volume}`)),
    dispatch: vi.fn((command) => calls.push(`rate:${command.rate}`)),
  };
  return { target, calls };
}

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('applyPlaybackSettings', () => {
  it('applies the volume on every change', () => {
    const { target, calls } = fakeTarget();

    applyPlaybackSettings(target, settings({ volume: 1 }), settings({ volume: 1.5 }));

    expect(calls).toEqual(['volume:1.5']);
  });

  it('re-applies an unchanged volume rather than tracking it', () => {
    // The engine stores the value and passes it to the current speaker, so a
    // redundant call costs nothing and saves a second copy of the settings.
    const { target, calls } = fakeTarget();

    applyPlaybackSettings(target, settings(), settings({ rate: 2 }));

    expect(calls).toContain('volume:1');
  });

  it('changes the rate of a session that is playing', () => {
    const { target, calls } = fakeTarget('playing');

    applyPlaybackSettings(target, settings({ rate: 1 }), settings({ rate: 2 }));

    expect(calls).toEqual(['volume:1', 'rate:2']);
  });

  it('ignores a rate change while the engine is idle', () => {
    // `setRate` re-speaks the sentence in progress; with no session there is
    // nothing to re-speak, and the next `load` carries the rate anyway.
    const { target, calls } = fakeTarget('idle');

    applyPlaybackSettings(target, settings({ rate: 1 }), settings({ rate: 2 }));

    expect(calls).toEqual(['volume:1']);
  });

  it('does not re-speak a sentence when the rate is unchanged', () => {
    const { target, calls } = fakeTarget('playing');

    applyPlaybackSettings(target, settings({ rate: 2 }), settings({ rate: 2 }));

    expect(calls).toEqual(['volume:1']);
  });

  it('applies a volume and a rate change in one pass', () => {
    const { target, calls } = fakeTarget('paused');

    applyPlaybackSettings(
      target,
      settings({ volume: 1, rate: 1 }),
      settings({ volume: 0.5, rate: 1.5 })
    );

    expect(calls).toEqual(['volume:0.5', 'rate:1.5']);
  });
});
