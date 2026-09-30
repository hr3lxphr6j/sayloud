/**
 * What the caption window shows: the sentence being read, the word being
 * spoken marked inside it, and a line saying which sentence this is.
 *
 * Rendered by `CaptionWindow` into the picture-in-picture document, which is a
 * document of its own — the shadow root's stylesheet cannot reach it, and the
 * window injects its own styles there.
 */
import type { CaptionState } from './CaptionWindow';

export interface CaptionViewProps {
  state: CaptionState;
}

export function CaptionView({ state }: CaptionViewProps) {
  const word = wordRange(state);

  return (
    <div class="caption">
      <p class="caption-sentence">
        {word ? (
          <>
            {state.text.slice(0, word.start)}
            <mark class="caption-word">{state.text.slice(word.start, word.end)}</mark>
            {state.text.slice(word.end)}
          </>
        ) : (
          state.text
        )}
      </p>
      {state.total > 0 && <p class="caption-counter">{state.counter}</p>}
    </div>
  );
}

/**
 * The span of the sentence the spoken word covers, or null when there is none.
 *
 * `charStart === -1` is the engine's "the provider gave no word timings", read
 * exactly as the page highlight reads it: an estimate would drift against the
 * audio, so the sentence is shown unmarked instead.
 */
function wordRange(state: CaptionState): { start: number; end: number } | null {
  const { charStart, charEnd, text } = state;
  if (charStart < 0 || charEnd <= charStart || charStart >= text.length) return null;
  return { start: charStart, end: Math.min(charEnd, text.length) };
}
