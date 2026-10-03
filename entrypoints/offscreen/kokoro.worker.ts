/**
 * The kokoro worker: ONNX Runtime and the model, and nothing else (P6 spec
 * §2.4, phase 7).
 *
 * This module is the worker's edges: it configures ONNX Runtime, points
 * transformers.js at the chosen download source, and turns messages into calls
 * on a `KokoroEngine`. The model itself lives in `lib/models/kokoro-engine.ts`,
 * where it can be tested — a class buried in a worker module cannot be.
 *
 * Until phase 7 this worker also phonemized, which is the one thing it no
 * longer does: text now arrives phonemized and already cut to fit, from
 * `phonemize.worker.ts` through the coordinator in `lib/models/worker-engine.ts`.
 * The reason is overlap rather than blocking — both halves were already off the
 * offscreen document's main thread, but on one thread a prefetch's
 * phonemization could not happen while the sentence being listened to was being
 * synthesized.
 *
 * Three things about where this runs drive everything below.
 *
 * **It is a worker, not the offscreen document's main thread.** That thread
 * also drives `TimelinePlayer`'s timers and playback, and an ONNX session that
 * blocks it for a second is a stutter in whatever is playing right now.
 *
 * **It has no `chrome.storage`.** Offscreen documents are given `runtime` and
 * `offscreen` and nothing else, so the download source arrives as an `init`
 * message rather than being read here.
 *
 * **It is recycled after ~30 seconds without audio.** Loading the model and
 * synthesizing the first sentence takes 1–2 seconds once the weights are in the
 * cache, so the normal path is safe — but this document must never be the one
 * that downloads them, which is why `model-missing` exists at all.
 */
import { env } from '@huggingface/transformers';
import { installFetchPatch } from '~/lib/models/fetch-patch';
import { KokoroEngine } from '~/lib/models/kokoro-engine';
import { CANONICAL_HOST, type ModelSource } from '~/lib/models/urls';
import {
  isWorkerRequest,
  type WorkerReply,
  type WorkerRequest,
} from '~/lib/models/worker-protocol';
import type { ProviderErrorCode } from '~/lib/providers/errors';
// The URLs the bundle emitted for ONNX Runtime's wasm pair.
//
// Spelled as a path into `node_modules` because `@huggingface/transformers`
// exports only its entry points, and `?url` because ORT builds this path at
// runtime and `import()`s it — nothing else lets a bundler see the file, and
// without it the glue module is left out of the build entirely, ORT falls back
// to its jsdelivr default, and `script-src 'self'` blocks it.
import ortGlueUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasmUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url';

/** The slice of `DedicatedWorkerGlobalScope` used here. */
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

// Not `DedicatedWorkerGlobalScope` itself: that type lives in `lib.webworker`,
// which cannot be combined with the DOM library the rest of the extension uses.
const scope = self as unknown as WorkerScope;

/**
 * ONNX Runtime, configured once, before any session exists.
 *
 * The `env` here is `@huggingface/transformers`' own — the same object
 * `kokoro-js` re-exports and proxies into, so configuring this one configures
 * the environment the model actually runs in. (`kokoro-js`'s re-export is typed
 * as a namespace holding only `wasmPaths`, which is why it cannot be the one
 * used here.)
 *
 * `numThreads = 1` because the extension is not cross-origin isolated and the
 * threaded build needs `SharedArrayBuffer` (verification V17). Measured: it
 * initialises fine that way, which is what lets the extension skip COOP/COEP
 * entirely — a global manifest change that would have put all six cloud
 * providers at risk.
 *
 * `wasmPaths` **must** name both files, and this is the one thing that has to be
 * spelled out rather than inferred. ONNX Runtime assembles that path at runtime
 * and `import()`s the result, so no bundler can rewrite it: the wasm binary
 * happens to arrive as an asset because ORT also mentions it in a static
 * `new URL(...)`, but the glue module does not — it was left out of the build
 * altogether, ORT fell back to its jsdelivr default, and the extension's
 * `script-src 'self'` blocked it. The symptom was "no available backend found"
 * on every synthesis, with the model downloaded and the GPU sitting right there.
 */
function configureRuntime(): void {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // `backends` is typed `Partial<Env>`, so the wasm flags may be absent on a
  // build that does not ship the backend at all.
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.numThreads = 1;
    // Absolute, because ONNX Runtime hands these straight to `import()` and to
    // `fetch` from inside a worker whose base URL is this file's own path.
    // Resolved against `self.location` rather than left as the bundle's
    // root-relative spelling, so no assumption about that resolution has to
    // hold.
    wasm.wasmPaths = {
      mjs: new URL(ortGlueUrl, self.location.href).href,
      wasm: new URL(ortWasmUrl, self.location.href).href,
    };
  }

  // ONNX Runtime logs at `warning` by default, and its warnings are performance
  // notes: "some nodes were not assigned to the preferred execution providers"
  // is the ordinary report for a WebGPU session, where shape ops go to the CPU
  // on purpose. Chrome files anything an extension page logs under "Errors",
  // so a note that is always true read as a defect the user was meant to act
  // on. Failures still come through.
  env.backends.onnx.logLevel = 'error';
}

/**
 * Point transformers.js at the canonical host and patch the requests on the way
 * out, so a cached file is found again after the user switches download source.
 *
 * The revision in the template is `main` and stays `main`: the *key* must not
 * mention the source, and `resolveUrl` is what turns it into ModelScope's
 * `master` when that is where the bytes live.
 */
function configureSource(source: ModelSource, allowFallback: boolean): void {
  env.remoteHost = CANONICAL_HOST;
  env.remotePathTemplate = '{model}/resolve/{revision}/';
  installFetchPatch({ source, allowFallback });
}

const engine = new KokoroEngine();

scope.addEventListener('message', (event: MessageEvent) => {
  const request: unknown = event.data;
  if (!isWorkerRequest(request)) return;
  void handle(request);
});

async function handle(request: WorkerRequest): Promise<void> {
  switch (request.type) {
    case 'init':
      try {
        configureSource(request.source, request.allowFallback);
        reply({ type: 'ready', id: request.id });
      } catch (error) {
        fail(request.id, 'model-load-failed', error);
      }
      return;

    case 'load':
      try {
        const info = await engine.load(request.modelId, request.tierId, request.device);
        reply({ type: 'loaded', id: request.id, info });
      } catch (error) {
        fail(request.id, 'model-load-failed', error);
      }
      return;

    case 'count':
      try {
        reply({ type: 'counted', id: request.id, tokens: engine.countTokens(request.phonemes) });
      } catch (error) {
        fail(request.id, 'unknown', error);
      }
      return;

    case 'synthesize':
      try {
        const { pcm, sampleRate } = await engine.synthesize(
          request.id,
          request.pieces,
          request.voiceId,
          request.lang
        );
        // Transferred rather than copied: a ten-second sentence is 960 KB, and
        // this side has no further use for it.
        scope.postMessage({ type: 'pcm', id: request.id, pcm, sampleRate }, [pcm.buffer]);
      } catch (error) {
        // A cancellation is the caller's own decision and it has already
        // rejected its own promise; answering with an error would be noise.
        if (isAbort(error)) return;
        fail(request.id, 'unknown', error);
      }
      return;

    case 'cancel':
      engine.cancel(request.id);
      return;

    default:
      engine.dispose();
  }
}

function reply(message: WorkerReply): void {
  scope.postMessage(message);
}

function fail(id: number, code: ProviderErrorCode, error: unknown): void {
  reply({ type: 'error', id, code, message: messageOf(error) });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Structural, so it also matches a rejection reason from another realm. */
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

configureRuntime();
