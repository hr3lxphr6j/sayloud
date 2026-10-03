/**
 * The two checks every worker protocol makes before it reads a message.
 *
 * Both protocols validate what crosses their `message` boundary — a worker's
 * `message` event is not a trusted channel, and a worker left over from a
 * previous version is a real possibility — and both need the same two
 * primitives to do it. They live here rather than being written twice because
 * "what counts as an id" is a decision, not a detail: two copies would drift,
 * and the drift would show up as one direction accepting a reply the other
 * refuses to answer.
 */

/** The `type` of a message, when it has one. */
export function messageTypeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

/**
 * True for a request id.
 *
 * Positive integers only. Zero and negatives are what a `NaN`-producing
 * arithmetic mistake looks like, and a request that carries one could never be
 * matched to its reply.
 */
export function isMessageId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * The failure reply both protocols spell the same way.
 *
 * Every worker answers a request it could not serve with `{ type: 'error',
 * code, message }`, and the engine above turns that into a rejected promise
 * whose `name` is the code — which is how a caller switches on the reason
 * without parsing a sentence. Shared so the two clients cannot disagree about
 * which field is which.
 */
export interface ErrorReply {
  readonly id: number;
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
}

/** True for that reply. */
export function isErrorReply(value: unknown): value is ErrorReply {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'error' &&
    isMessageId(message.id) &&
    typeof message.code === 'string' &&
    typeof message.message === 'string'
  );
}
