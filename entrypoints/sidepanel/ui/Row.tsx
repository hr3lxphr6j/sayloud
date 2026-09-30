/**
 * A labelled line inside a card: the words on the left, the control on the
 * right.
 *
 * The label here is for the eye. Every control in this folder carries its own
 * accessible name (`aria-label`), and duplicating it into a `<label for>` would
 * only work for the form controls anyway — a `role="switch"` button is reachable
 * and nameable on its own.
 */
import type { ComponentChildren } from 'preact';

export interface RowProps {
  label: string;
  /** A second, quieter line under the label: what the control actually does. */
  help?: string;
  /** The control, at the end of the row. */
  children: ComponentChildren;
}

export function Row({ label, help, children }: RowProps) {
  return (
    <div class="row">
      <div class="row-text">
        <span class="row-label">{label}</span>
        {help !== undefined && <span class="row-help">{help}</span>}
      </div>
      <div class="row-control">{children}</div>
    </div>
  );
}
