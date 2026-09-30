/**
 * A range input with its own label and value readout.
 *
 * The two callbacks are the point of this component. Dragging a handle fires
 * `input` on every step, and a slider that saved on `input` would write
 * `storage.local` thirty times for one gesture — waking the service worker each
 * time, to react to a number the user has not settled on. So `onInput` moves the
 * display and `onCommit` — a range input's `change`, which Chrome fires when the
 * handle is released — is what gets saved.
 *
 * Preact maps `onChange` to the DOM `change` event, not React's synthetic
 * `input`, so the two are genuinely the two events meant here.
 *
 * `display` does double duty: it is what the reader sees next to the label and
 * the `aria-valuetext` a screen reader announces, so a percentage is never read
 * out as "1.5".
 */
export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  /** Every move of the handle; display only. */
  onInput: (value: number) => void;
  /** The handle being released; the value to keep. */
  onCommit: (value: number) => void;
  id?: string;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onInput,
  onCommit,
  id,
}: SliderProps) {
  return (
    <div class="slider">
      <div class="slider-head">
        <span class="row-label">{label}</span>
        <span class="slider-value">{display}</span>
      </div>
      <input
        id={id}
        class="slider-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={display}
        onInput={(event) => onInput(event.currentTarget.valueAsNumber)}
        onChange={(event) => onCommit(event.currentTarget.valueAsNumber)}
      />
    </div>
  );
}
