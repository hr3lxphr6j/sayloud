/**
 * A saved preference, turned into a command for the engine (spec §11 T4).
 *
 * This lives here rather than in `background.ts` because a service worker
 * entrypoint has no unit test in this repo: the rule "a rate change reaches a
 * running session, and is ignored when there is none" is worth more as a test
 * than as three lines nobody can call.
 */
import type { EnginePhase } from './protocol';
import type { Settings } from './settings-store';

/** The slice of `PlaybackEngine` the playback preferences touch. */
export interface PlaybackTarget {
  getStatus(): { phase: EnginePhase };
  setVolume(volume: number): void;
  dispatch(command: { type: 'setRate'; rate: number }): void;
}

/**
 * Apply the playback preferences to the engine.
 *
 * The volume goes in unconditionally: the engine keeps the value and hands it
 * to whichever speaker is current, so re-stating it costs nothing and saves a
 * second copy of the settings to compare against.
 *
 * The rate only goes to a session that exists. `setRate` re-speaks the sentence
 * in progress, and with nothing in progress there is nothing to re-speak — the
 * next `load` carries the rate instead (the content script reads it when it
 * starts reading).
 */
export function applyPlaybackSettings(
  target: PlaybackTarget,
  previous: Settings,
  next: Settings
): void {
  target.setVolume(next.volume);

  if (next.rate !== previous.rate && target.getStatus().phase !== 'idle') {
    target.dispatch({ type: 'setRate', rate: next.rate });
  }
}
