/**
 * What the machine can actually do.
 *
 * The question this module answers is narrow — is there a WebGPU adapter —
 * because that is the only capability left that changes what the engine can
 * use: Kokoro ships one full-precision tier, and the half-precision variant it
 * used to share the registry with was removed after it measured as unusable
 * (see `registry.ts`).
 *
 * `navigator.gpu` is typed by the DOM library, but this module takes a
 * structural slice of it: a unit test can then drive every branch — no GPU, no
 * adapter — without a browser that has WebGPU.
 */

/** The slice of `navigator.gpu` used here. */
export interface GpuLike {
  requestAdapter(): Promise<AdapterLike | null>;
}

/** The slice of a `GPUAdapter` used here. */
export interface AdapterLike {
  readonly info?: AdapterInfoLike | undefined;
}

/** The slice of `GPUAdapterInfo` used here. */
export interface AdapterInfoLike {
  readonly vendor?: string | undefined;
  readonly architecture?: string | undefined;
  readonly description?: string | undefined;
}

/** What the caller measured about the device, before picking a backend. */
export interface DeviceCaps {
  readonly webgpu: boolean;
}

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
  if (!gpu) return { caps: { webgpu: false } };

  let adapter: AdapterLike | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    // A blocked or driverless adapter rejects rather than returning null.
    return { caps: { webgpu: false } };
  }
  if (!adapter) return { caps: { webgpu: false } };

  const caps: DeviceCaps = { webgpu: true };
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
 * `auto` means "use the GPU if there is one".
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
