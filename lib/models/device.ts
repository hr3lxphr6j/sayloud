/**
 * What the machine can actually do (P4 spec §3.3, §3.7.2).
 *
 * The tier a machine should use is not "GPU or not": the measurements found
 * that a quantised model gains *nothing* from WebGPU, because its
 * dequantisation nodes fall back to the CPU, while `fp16`/`fp32` gain 6–8×.
 * So the question this module answers is narrower — is there a WebGPU adapter,
 * and does it have `shader-f16` — and `preferredTier` in the registry turns
 * that into a tier.
 *
 * `navigator.gpu` is typed by the DOM library, but this module takes a
 * structural slice of it: a unit test can then drive every branch — no GPU, no
 * adapter, f16, no f16 — without a browser that has WebGPU.
 */
import type { DeviceCaps } from './registry';

/** The slice of `navigator.gpu` used here. */
export interface GpuLike {
  requestAdapter(): Promise<AdapterLike | null>;
}

/** The slice of a `GPUAdapter` used here. */
export interface AdapterLike {
  readonly features: { has(feature: string): boolean };
  readonly info?: AdapterInfoLike | undefined;
}

/** The slice of `GPUAdapterInfo` used here. */
export interface AdapterInfoLike {
  readonly vendor?: string | undefined;
  readonly architecture?: string | undefined;
  readonly description?: string | undefined;
}

/** The feature name that decides between `fp16` and `fp32`. */
export const SHADER_F16 = 'shader-f16';

/** What a probe found. */
export interface DeviceProbe {
  readonly caps: DeviceCaps;
  /**
   * A readable adapter name for the model tab's "running on" line, when the
   * browser would tell us. Absent is normal — several browsers ship
   * `adapter.info` empty for fingerprinting reasons.
   */
  readonly adapterName?: string;
}

/** How the user asked for the model to be run. */
export type DevicePreference = 'auto' | 'webgpu' | 'wasm';

/** The device the engine will actually use. */
export type Device = 'webgpu' | 'wasm';

/**
 * Raised when the user asked for a device this machine does not have.
 *
 * Only ever thrown for an explicit `webgpu` request: `auto` falls back to
 * `wasm` silently, because that is what the user asked for by leaving it on
 * `auto`. An explicit request failing is worth telling them about, since the
 * only way out is to change the setting.
 */
export class DeviceUnavailableError extends Error {
  constructor(readonly device: Device) {
    super(`this machine has no ${device}`);
    this.name = 'DeviceUnavailableError';
  }
}

/**
 * Measure the machine.
 *
 * Never throws: a browser without WebGPU, an adapter that refuses to be
 * created, and a probe that rejects all mean the same thing to the caller —
 * `wasm` — and none of them is worth failing a synthesis over.
 */
export async function probeDevice(gpu: GpuLike | null | undefined): Promise<DeviceProbe> {
  if (!gpu) return { caps: { webgpu: false, shaderF16: false } };

  let adapter: AdapterLike | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    // A blocked or driverless adapter rejects rather than returning null.
    return { caps: { webgpu: false, shaderF16: false } };
  }
  if (!adapter) return { caps: { webgpu: false, shaderF16: false } };

  const caps: DeviceCaps = { webgpu: true, shaderF16: adapter.features.has(SHADER_F16) };
  const adapterName = describeAdapter(adapter.info);
  return adapterName === undefined ? { caps } : { caps, adapterName };
}

/** The browser's own words for the adapter, if it offers any. */
function describeAdapter(info: AdapterInfoLike | undefined): string | undefined {
  if (!info) return undefined;
  const description = info.description?.trim();
  if (description) return description;

  const parts = [info.vendor, info.architecture]
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part !== '');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * The device to run on, given what the user asked for and what the machine has.
 *
 * `auto` means "use the GPU if there is one" (spec §3.3); the tier chosen on
 * top of that is what decides whether the GPU is actually worth using.
 */
export function resolveDevice(preference: DevicePreference, caps: DeviceCaps): Device {
  switch (preference) {
    case 'wasm':
      return 'wasm';
    case 'webgpu':
      if (!caps.webgpu) throw new DeviceUnavailableError('webgpu');
      return 'webgpu';
    default:
      return caps.webgpu ? 'webgpu' : 'wasm';
  }
}
