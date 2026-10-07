/**
 * How the on-device engine learns where to download from.
 *
 * The user's choice lives in `ModelStore` under `sayloud:model-source`, which
 * means `chrome.storage` — and an offscreen document is given `runtime` and
 * `offscreen` and nothing else. So the choice travels as a message, exactly the
 * way the cache policy does, and for exactly the same reason.
 *
 * Asking rather than being told is also what survives Chrome closing the
 * document: a document that starts up mid-article asks for the source before
 * its first sentence, instead of waiting for a message that was sent while
 * nothing was listening.
 *
 * The service worker does the resolving, not this side, because `auto` means
 * probing both mirrors and remembering the winner — and the memory is in
 * storage, which only the worker can reach.
 */
import type { RuntimeApi } from '../offscreen-manager';
import {
  isModelSourceMessage,
  MODEL_SOURCE_REQUEST,
  type ModelSourceMessage,
} from '../offscreen-protocol';
import type { ModelSource } from './urls';

/** A source, and whether the user chose it. */
export interface SourceResolution {
  readonly source: ModelSource;
  /** True when it came from `auto`, so one retry against the other mirror is allowed. */
  readonly allowFallback: boolean;
}

/** The message a worker sends in reply. */
export function modelSourceMessage(
  source: ModelSource,
  allowFallback: boolean
): ModelSourceMessage {
  return { type: 'model-source', source, allowFallback };
}

/**
 * Ask the service worker where to download from.
 *
 * Rejects when there is no answer. That is deliberately not swallowed: a
 * guessed source would be a wrong one, and the caller — the local provider —
 * turns the rejection into an error the user can see rather than into a
 * download from a host they did not choose.
 */
export async function pullModelSource(runtime: RuntimeApi): Promise<SourceResolution> {
  const reply = await runtime.sendMessage(MODEL_SOURCE_REQUEST);
  if (!isModelSourceMessage(reply)) {
    throw new Error('the service worker did not answer with a download source');
  }
  return { source: reply.source, allowFallback: reply.allowFallback };
}
