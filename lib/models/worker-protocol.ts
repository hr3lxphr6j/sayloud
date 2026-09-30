/**
 * The wire protocol between `WorkerLocalEngine` and the offscreen document's
 * nested worker.
 *
 * ONNX inference must not run on the offscreen document's main thread: that
 * thread also drives `TimelinePlayer`'s timers and playback, and a synthesis
 * that blocks it for a second is a stutter in the audio that is playing now.
 * So the model lives in a worker and this is the only way in or out.
 *
 * Every message is validated before use, the same as the service worker's
 * channel: a worker's `message` event is not a trusted boundary, and a stale
 * worker from a previous version is a real possibility.
 */
import type { ProviderErrorCode } from '../providers/errors';
import type { Device } from './device';
import type { DeviceInfo } from './engine';
import type { ModelSource } from './urls';

/** Main thread → worker. */
export type WorkerRequest =
  | {
      /**
       * Point the fetch patch at a download source, before anything is fetched.
       *
       * Has to be its own message rather than part of `load`: the patch must be
       * installed before transformers.js makes its first request, and `load` is
       * what makes that request.
       */
      type: 'init';
      id: number;
      source: ModelSource;
      /** True when `source` came from `auto`, so one retry is allowed. */
      allowFallback: boolean;
    }
  | { type: 'load'; id: number; modelId: string; tierId: string; device: Device }
  | { type: 'synthesize'; id: number; text: string; voiceId: string; lang: string }
  | { type: 'cancel'; id: number }
  | { type: 'dispose' };

/** Worker → main thread. */
export type WorkerReply =
  | { type: 'ready'; id: number }
  | { type: 'loaded'; id: number; info: DeviceInfo }
  | { type: 'pcm'; id: number; pcm: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; code: ProviderErrorCode; message: string };

const REQUEST_TYPES: ReadonlySet<string> = new Set([
  'init',
  'load',
  'synthesize',
  'cancel',
  'dispose',
]);

function typeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** True for a well-formed request. */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
  const type = typeOf(value);
  if (type === null || !REQUEST_TYPES.has(type)) return false;
  const message = value as Record<string, unknown>;

  switch (type) {
    case 'init':
      return (
        isId(message.id) &&
        isModelSource(message.source) &&
        typeof message.allowFallback === 'boolean'
      );
    case 'load':
      return (
        isId(message.id) &&
        typeof message.modelId === 'string' &&
        typeof message.tierId === 'string' &&
        (message.device === 'webgpu' || message.device === 'wasm')
      );
    case 'synthesize':
      return (
        isId(message.id) &&
        typeof message.text === 'string' &&
        typeof message.voiceId === 'string' &&
        typeof message.lang === 'string'
      );
    case 'cancel':
      return isId(message.id);
    default:
      return true;
  }
}

/** A resolved source, as it can arrive from another context. */
function isModelSource(value: unknown): value is ModelSource {
  if (typeof value !== 'object' || value === null) return false;
  const host = (value as { host?: unknown }).host;
  if (host === 'huggingface' || host === 'modelscope') return true;
  if (host !== 'custom') return false;
  return typeof (value as { customHostUrl?: unknown }).customHostUrl === 'string';
}

/** True for a well-formed reply. */
export function isWorkerReply(value: unknown): value is WorkerReply {
  const type = typeOf(value);
  if (type === null || !isId((value as { id?: unknown }).id)) return false;
  const message = value as Record<string, unknown>;

  switch (type) {
    case 'ready':
      return true;
    case 'loaded':
      return typeof message.info === 'object' && message.info !== null;
    case 'pcm':
      return message.pcm instanceof Float32Array && typeof message.sampleRate === 'number';
    case 'error':
      return typeof message.code === 'string' && typeof message.message === 'string';
    default:
      return false;
  }
}
