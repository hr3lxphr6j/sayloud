/**
 * A deadline for one abortable operation.
 *
 * Adapters take an `AbortSignal` and rethrow the abort untouched — cancellation
 * is the caller's decision, not a provider failure — so a rejection on its own
 * cannot say whether the service hung or the panel moved on. This keeps that
 * distinction next to the timer that made it.
 */
export interface Deadline {
  readonly signal: AbortSignal;
  /** True once the deadline fired; false when `cancel()` ended it. */
  timedOut(): boolean;
  /** Ends the operation early: a newer request started, or the panel unmounted. */
  cancel(): void;
  /** Stops the timer. Call in a `finally`. */
  dispose(): void;
}

export function startDeadline(timeoutMs: number): Deadline {
  const controller = new AbortController();
  let expired = false;

  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => expired,
    cancel: () => controller.abort(),
    dispose: () => clearTimeout(timer),
  };
}
