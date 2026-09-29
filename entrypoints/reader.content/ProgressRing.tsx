import type { EnginePhase } from '~/lib/protocol';

/** Radius of the ring, in the SVG's own 20x20 coordinate space. */
const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ProgressRingProps {
  /** How much of the page has been read, from 0 to 1. */
  progress: number;
  /** Describes the ring for screen readers. */
  label: string;
  phase: EnginePhase | null;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onClick?: () => void;
}

/**
 * How far through the page we are, drawn in the bar's 28px width.
 *
 * The spec puts the remaining time here rather than in its own control: the
 * ring is the compact form, and the bubble card carries the exact figure.
 * An errored session replaces the ring with an exclamation mark, since 28px
 * has no room for a message.
 */
export function ProgressRing({
  progress,
  label,
  phase,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: ProgressRingProps) {
  if (phase === 'error') {
    return (
      <span class="ring ring-error" role="img" aria-label={label}>
        !
      </span>
    );
  }

  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;

  return (
    <button
      type="button"
      class="ring"
      aria-label={label}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle class="ring-track" cx="10" cy="10" r={RADIUS} />
        <circle
          class="ring-value"
          cx="10"
          cy="10"
          r={RADIUS}
          stroke-dasharray={`${clamped * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      </svg>
    </button>
  );
}
