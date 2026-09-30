import { useEffect, useState } from 'preact/hooks';
import { remainingMessage } from '~/lib/format-time';
import { type MessageKey, useT } from '~/lib/i18n';
import type { EngineCommand } from '~/lib/protocol';
import { BubbleCard } from './BubbleCard';
import { ProgressRing } from './ProgressRing';
import type { ReaderError, ReaderState } from './ReaderController';

/** The slice of `ReaderController` the player needs, so tests can stand in. */
export interface PlayerController {
  getState(): ReaderState;
  subscribe(listener: (state: ReaderState) => void): () => void;
  sendCommand(command: EngineCommand): void;
  returnToPosition(): void;
}

export interface SidePlayerProps {
  controller: PlayerController;
  /**
   * Show the settings panel.
   *
   * Injected rather than called here because a content script cannot reach
   * `chrome.sidePanel` at all; the reader passes a function that sends the
   * request on to the service worker. It must not await anything before
   * sending — see `lib/open-settings.ts`.
   */
  onOpenSettings: () => void;
}

/** Speeds the reader can step through, slow to fast. */
export const RATE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** The next speed in the cycle, wrapping around at the end. */
export function nextRate(current: number): number {
  const index = RATE_STEPS.findIndex((rate) => Math.abs(rate - current) < 0.01);
  // An unrecognised rate (a snapshot from a later version) restarts the cycle.
  return RATE_STEPS[index === -1 ? 0 : (index + 1) % RATE_STEPS.length] ?? 1;
}

/** `1.5×`, without the trailing zeros `toFixed` would add. */
export function formatRate(rate: number): string {
  return `${rate.toFixed(2).replace(/\.?0+$/, '')}×`;
}

export const HINTS: Record<ReaderError, { titleKey: MessageKey; messageKey: MessageKey }> = {
  'no-content': {
    titleKey: 'sideplayer.hint.no-content.title',
    messageKey: 'sideplayer.hint.no-content.message',
  },
  'no-voice': {
    titleKey: 'sideplayer.hint.no-voice.title',
    messageKey: 'sideplayer.hint.no-voice.message',
  },
  'tts-error': {
    titleKey: 'sideplayer.hint.tts-error.title',
    messageKey: 'sideplayer.hint.tts-error.message',
  },
};

/**
 * The 28px bar.
 *
 * Playback state lives in the service worker, so this component is a view: it
 * renders the last `ReaderState` it was handed and sends commands back. The
 * spec fixes the controls to remaining time, play/pause, previous, next and
 * speed, with the voice picker and settings deferred to P3.
 */
export function SidePlayer({ controller, onOpenSettings }: SidePlayerProps) {
  const t = useT();
  const [state, setState] = useState<ReaderState>(() => controller.getState());
  const [dismissed, setDismissed] = useState<ReaderError | null>(null);
  const [showRemaining, setShowRemaining] = useState(false);

  useEffect(() => controller.subscribe(setState), [controller]);

  // A retry can fail the same way again, so a dismissed hint must come back.
  useEffect(() => {
    if (state.error === null) setDismissed(null);
  }, [state.error]);

  const status = state.status;
  const phase = status?.phase ?? null;
  const active = phase === 'playing' || phase === 'loading';
  const hasSentences = (status?.total ?? 0) > 0;

  const canPrev = hasSentences && (status?.index ?? 0) > 0;
  const canNext = hasSentences && (status?.index ?? 0) < (status?.total ?? 0) - 1;
  const canToggle = hasSentences && phase !== 'error';

  const progress = status && status.charsTotal > 0 ? status.charsRead / status.charsTotal : 0;
  const percent = Math.round(progress * 100);
  // The phrase around the clock is translated, so the two are kept apart until
  // the very last moment.
  const remaining = status
    ? remainingMessage(status.charsTotal - status.charsRead, status.charsPerSec)
    : null;
  const remainingText = remaining ? t(remaining.key, remaining.params) : '';

  const hint = state.error !== null && state.error !== dismissed ? HINTS[state.error] : null;

  const onKeyDown = (event: KeyboardEvent) => {
    // Space on a focused button already activates that button.
    const fromButton = event.target instanceof HTMLElement && event.target.tagName === 'BUTTON';

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      controller.sendCommand({ type: 'prev' });
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      controller.sendCommand({ type: 'next' });
      return;
    }
    if (event.key === ' ' && !fromButton) {
      event.preventDefault();
      controller.sendCommand({ type: 'toggle' });
    }
  };

  return (
    <div
      class="side-player"
      role="toolbar"
      aria-label="SayLoud"
      aria-orientation="vertical"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a toolbar is interactive; it needs focus for its arrow-key shortcuts.
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setShowRemaining(true)}
      onMouseLeave={() => setShowRemaining(false)}
    >
      <ProgressRing
        progress={progress}
        phase={phase}
        label={
          remainingText
            ? t('sideplayer.progress-remaining', { percent, remaining: remainingText })
            : t('sideplayer.progress', { percent })
        }
        onClick={() => setShowRemaining(true)}
      />

      <button
        type="button"
        class="control play-pause"
        aria-label={active ? t('sideplayer.pause') : t('sideplayer.play')}
        disabled={!canToggle}
        onClick={() => controller.sendCommand({ type: 'toggle' })}
      >
        {phase === 'loading' ? (
          <span class="spinner" aria-hidden="true" />
        ) : active ? (
          <PauseIcon />
        ) : (
          <PlayIcon />
        )}
      </button>

      <button
        type="button"
        class="control"
        aria-label={t('sideplayer.previous')}
        disabled={!canPrev}
        onClick={() => controller.sendCommand({ type: 'prev' })}
      >
        <PrevIcon />
      </button>

      <button
        type="button"
        class="control"
        aria-label={t('sideplayer.next')}
        disabled={!canNext}
        onClick={() => controller.sendCommand({ type: 'next' })}
      >
        <NextIcon />
      </button>

      <button
        type="button"
        class="control rate"
        aria-label={t('sideplayer.rate', { rate: formatRate(status?.rate ?? 1) })}
        disabled={!hasSentences}
        onClick={() =>
          controller.sendCommand({ type: 'setRate', rate: nextRate(status?.rate ?? 1) })
        }
      >
        {formatRate(status?.rate ?? 1)}
      </button>

      <button
        type="button"
        class="control"
        aria-label={t('sideplayer.settings')}
        onClick={onOpenSettings}
      >
        <GearIcon />
      </button>

      {hint && (
        <BubbleCard
          title={t(hint.titleKey)}
          message={t(hint.messageKey)}
          onDismiss={() => setDismissed(state.error)}
        />
      )}

      {!hint && state.scrolledAway && (
        <BubbleCard
          message={t('bubble.scrolled-away')}
          action={{
            label: t('bubble.back-to-position'),
            onClick: () => controller.returnToPosition(),
          }}
        />
      )}

      {!hint && !state.scrolledAway && showRemaining && remainingText && (
        <BubbleCard message={remainingText} />
      )}
    </div>
  );
}

const ICON_SIZE = 14;

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true">
      <path d="M4 2.5 12.5 8 4 13.5Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true">
      <rect x="3.5" y="3" width="3.5" height="10" rx="1" fill="currentColor" />
      <rect x="9" y="3" width="3.5" height="10" rx="1" fill="currentColor" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg viewBox="0 0 16 16" width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true">
      <path d="M12.5 3 5 8l7.5 5Z" fill="currentColor" />
      <rect x="3" y="3" width="2" height="10" rx="1" fill="currentColor" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 16 16" width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true">
      <path d="M3.5 3 11 8l-7.5 5Z" fill="currentColor" />
      <rect x="11" y="3" width="2" height="10" rx="1" fill="currentColor" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true">
      <path
        d="M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      />
      <path
        d="M7 1.5h2l.3 1.8a4.5 4.5 0 0 1 1.5.9l1.7-.6 1 1.7-1.3 1.3c.2.5.3 1 .3 1.5s-.1 1-.3 1.5l1.3 1.3-1 1.7-1.7-.6a4.5 4.5 0 0 1-1.5.9L9 14.5H7l-.3-1.8a4.5 4.5 0 0 1-1.5-.9l-1.7.6-1-1.7 1.3-1.3A4.5 4.5 0 0 1 3.5 8c0-.5.1-1 .3-1.5L2.5 5.2l1-1.7 1.7.6a4.5 4.5 0 0 1 1.5-.9L7 1.5Z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
      />
    </svg>
  );
}
