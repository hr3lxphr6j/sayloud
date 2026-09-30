/**
 * A switch, in the accessibility sense: `role="switch"` plus `aria-checked`.
 *
 * Not a bare `<input type="checkbox">`. A checkbox reads as "checked", and the
 * thing on the other end of it here is a preference that is on or off in the
 * present tense; a switch is what assistive technology announces for that, and
 * what every other settings panel on the platform uses.
 *
 * The visible label belongs to the `Row` beside it, so the name is passed in.
 */
export interface SwitchProps {
  checked: boolean;
  /** The accessible name; the visible one is the row's label. */
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** For the checks that look a control up by name. */
  id?: string;
}

export function Switch({ checked, label, onChange, disabled, id }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      class="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span class="switch-knob" />
    </button>
  );
}
