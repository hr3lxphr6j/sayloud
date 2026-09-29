import { useEffect, useState } from 'preact/hooks';

/** Hints fade on their own, but only after the reader has had time to read them. */
export const AUTO_HIDE_MS = 6_000;

export interface BubbleCardAction {
  label: string;
  onClick: () => void;
}

export interface BubbleCardProps {
  message: string;
  title?: string;
  /** A card offering a choice stays until the reader chooses. */
  action?: BubbleCardAction;
  onDismiss?: () => void;
  autoHideMs?: number;
}

/**
 * The single way SayLoud says anything in words.
 *
 * The 28px bar has no room for text, so every hint, error and remaining-time
 * figure arrives in one of these, opening to the left of the bar. Cards fade
 * after a few seconds; hovering holds them, and a card with a button never
 * disappears on its own.
 */
export function BubbleCard({ message, title, action, onDismiss, autoHideMs }: BubbleCardProps) {
  const [hovered, setHovered] = useState(false);
  const timeout = autoHideMs ?? (action ? 0 : AUTO_HIDE_MS);

  useEffect(() => {
    if (hovered || timeout <= 0 || !onDismiss) return;
    const timer = window.setTimeout(onDismiss, timeout);
    return () => window.clearTimeout(timer);
  }, [hovered, timeout, onDismiss]);

  return (
    <div
      class="bubble"
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {title && <div class="bubble-title">{title}</div>}
      <div class="bubble-message">{message}</div>
      {action && (
        <button type="button" class="bubble-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
