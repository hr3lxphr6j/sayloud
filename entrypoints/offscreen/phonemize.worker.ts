/**
 * The phonemize worker (P6 spec §2.4, phase 7): Rust wasm and dictionaries, and
 * nothing else.
 *
 * It exists so that phonemizing is not a wall the model's session has to wait
 * behind. Neither half blocks the offscreen document's main thread — both are
 * in workers already — so the cost of sharing one thread was never a stutter in
 * playback; it was that a prefetch could not phonemize while the sentence being
 * listened to was being synthesized. Two workers is what lets those overlap,
 * and it is also the structure a heavier phonemizer would need anyway.
 *
 * The wasm instance has to live *here* and cannot be handed over: without
 * cross-origin isolation there is no `SharedArrayBuffer` (COOP/COEP are
 * deliberately off — see `wxt.config.ts`), so a wasm module cannot cross a
 * thread boundary. That is why this is a worker and not a function.
 *
 * This module is the worker's edges only. What it can do lives in
 * `PhonemizeService`, which has tests; all that is left here is the message
 * switch and the one decision it makes — which provider code a failure travels
 * as.
 */

import { PhonemizeService } from '~/lib/models/phonemize-service';
import {
  isPhonemizeWorkerRequest,
  type PhonemizeWorkerReply,
  type PhonemizeWorkerRequest,
  phonemizeErrorCode,
} from '~/lib/models/phonemize-worker-protocol';

/** The slice of `DedicatedWorkerGlobalScope` used here. */
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
}

// Not `DedicatedWorkerGlobalScope` itself: that type lives in `lib.webworker`,
// which cannot be combined with the DOM library the rest of the extension uses.
const scope = self as unknown as WorkerScope;

const service = new PhonemizeService();

scope.addEventListener('message', (event: MessageEvent) => {
  const request: unknown = event.data;
  if (!isPhonemizeWorkerRequest(request)) return;
  void handle(request);
});

async function handle(request: PhonemizeWorkerRequest): Promise<void> {
  // Handled before the `try`, because it carries no id and so has no reply to
  // fail with: every other request can be answered with an error naming it.
  if (request.type === 'dispose') {
    service.dispose();
    return;
  }

  try {
    switch (request.type) {
      case 'init':
        await service.init();
        reply({ type: 'ready', id: request.id });
        return;

      case 'prepare':
        await service.prepare(request.frontend, request.lang);
        reply({ type: 'prepared', id: request.id });
        return;

      case 'phonemize': {
        const result = service.phonemize(request.text, request.frontend, request.lang);
        // `warnings` is sent only when there are some, because the Rust side
        // omits the field when there is nothing to report and an empty array
        // would be a second spelling of "none" for every caller to handle.
        reply(
          result.warnings === undefined
            ? { type: 'phonemized', id: request.id, phonemes: result.phonemes }
            : {
                type: 'phonemized',
                id: request.id,
                phonemes: result.phonemes,
                warnings: result.warnings,
              }
        );
        return;
      }

      default: {
        // Unreachable, and a compile error if a request type is ever added
        // without a branch here.
        const unhandled: never = request;
        return unhandled;
      }
    }
  } catch (error) {
    reply({
      type: 'error',
      id: request.id,
      code: phonemizeErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function reply(message: PhonemizeWorkerReply): void {
  scope.postMessage(message);
}
