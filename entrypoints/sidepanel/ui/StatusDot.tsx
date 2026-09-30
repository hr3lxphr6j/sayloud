/**
 * The dot at the start of a provider row.
 *
 * Three states, no fourth: red would mean "the last test failed", and that
 * would have to be remembered across restarts, which this round does not do.
 *
 * The name is optional on purpose. In a provider row the words beside it
 * already say the same thing, and naming the dot as well would read the state
 * out twice in one accessible name; where a dot stands alone, pass `label` and
 * it becomes an image with a name.
 */
export type StatusDotState = 'active' | 'configured' | 'empty';

export interface StatusDotProps {
  state: StatusDotState;
  /** The state in words, for a dot with no text beside it. */
  label?: string;
}

export function StatusDot({ state, label }: StatusDotProps) {
  if (label === undefined) {
    return <span class="status-dot" data-state={state} aria-hidden="true" />;
  }
  return <span class="status-dot" data-state={state} role="img" aria-label={label} />;
}
