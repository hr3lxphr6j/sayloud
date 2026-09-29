/** Where an async action got to, and what to say about it. */
export type AsyncStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

export interface StatusLineProps {
  status: AsyncStatus;
}

/**
 * The one-line result under an action button.
 *
 * `role="alert"` on failures so a screen reader hears the reason without the
 * user having to hunt for it; successes are quieter, since they are the
 * expected outcome of a button press.
 */
export function StatusLine({ status }: StatusLineProps) {
  if (status.kind === 'ok') {
    return (
      <p class="result ok" role="status">
        {status.message}
      </p>
    );
  }
  if (status.kind === 'error') {
    return (
      <p class="result error" role="alert">
        {status.message}
      </p>
    );
  }
  return null;
}
