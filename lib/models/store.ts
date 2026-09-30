/**
 * The model manager the model tab talks to (P4 spec §3.6).
 *
 * It owns four things the UI must not have to know about: which download source
 * to use, what is already in Cache Storage, what a tier's removal may and may
 * not take with it, and how much space the two buckets cost.
 *
 * Like the other stores, everything read from storage is untrusted — this key
 * is shared with other versions of the extension — so a value that does not
 * normalize falls back to `auto` rather than being handed to `fetch`.
 */
import type { LocalStorageArea } from '../config-store';
import {
  cacheKeyUrl,
  type DownloadOptions,
  downloadFiles,
  type FetchLike,
  fileBytes,
  isCancellation,
  isSharedModelFile,
  type ModelCache,
  type ModelCacheStorage,
  tierPlan,
  VOICE_FILE_BYTES,
  voiceKey,
  voicePlan,
} from './downloader';
import { MODELS, type ModelTier, type OnDeviceModel } from './registry';
import {
  type ConcreteModelHost,
  canonicalModelUrl,
  isVoiceUrl,
  KOKORO_VOICES_CACHE,
  MODEL_HOSTS,
  type ModelHostId,
  type ModelSource,
  resolveUrl,
  TRANSFORMERS_CACHE,
  voiceUrlPrefix,
} from './urls';

/** The user's download-source choice. */
export const MODEL_SOURCE_KEY = 'sayloud:model-source';

/**
 * The source that last worked, so `auto` does not have to probe every time.
 *
 * A separate key from the choice above: what the user asked for and what the
 * network allowed are different facts, and overwriting one with the other
 * would lose the choice.
 */
export const MODEL_HOST_LAST_GOOD_KEY = 'sayloud:model-host-last-good';

/** How long one source gets to answer the `auto` probe. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** The file the `auto` probe asks for: tiny, and present on every source. */
const PROBE_FILE = 'config.json';

/** Voices fetched at once by a bulk download. */
const DEFAULT_VOICE_CONCURRENCY = 4;

/** What the user picked, before `auto` is resolved. */
export interface ModelSourceSetting {
  readonly host: ModelHostId;
  /** Only meaningful for `custom`. */
  readonly customHostUrl?: string;
}

export const DEFAULT_MODEL_SOURCE: ModelSourceSetting = { host: 'auto' };

/** What the two model buckets hold, measured against the registry's sizes. */
export interface ModelUsage {
  readonly modelBytes: number;
  readonly voiceBytes: number;
  readonly totalBytes: number;
  /** Voice files present, whatever language they speak. */
  readonly voiceCount: number;
}

/** One voice that could not be downloaded, and why. */
export interface VoiceDownloadFailure {
  readonly voiceId: string;
  readonly error: Error;
}

/** What a bulk voice download did. A failure is absent from `downloaded`. */
export interface VoiceDownloadReport {
  readonly downloaded: readonly string[];
  readonly failed: readonly VoiceDownloadFailure[];
}

export interface ModelStoreOptions {
  readonly storage: LocalStorageArea;
  /** Injected for tests; defaults to the page's `caches` and `fetch`. */
  readonly cacheStorage?: ModelCacheStorage;
  readonly fetch?: FetchLike;
  readonly probeTimeoutMs?: number;
  readonly voiceConcurrency?: number;
}

/** Neither mirror answered the `auto` probe. */
export class ModelHostUnreachableError extends Error {
  constructor(readonly hosts: readonly ConcreteModelHost[]) {
    super(`no download source answered (tried ${hosts.join(', ')})`);
    this.name = 'ModelHostUnreachableError';
  }
}

export class ModelStore {
  constructor(private readonly options: ModelStoreOptions) {}

  // --- the download source --------------------------------------------------

  /** The saved choice, normalized; `auto` when nothing usable is saved. */
  async getSource(): Promise<ModelSourceSetting> {
    const stored = await this.options.storage.get(MODEL_SOURCE_KEY);
    return normalizeModelSource(stored[MODEL_SOURCE_KEY]);
  }

  /**
   * Save the choice and report what was actually stored.
   *
   * Returning the normalized value matters: a `custom` source without a usable
   * URL falls back to `auto`, and the panel has to show that rather than keep
   * displaying a choice that was never written.
   */
  async setSource(source: ModelSourceSetting): Promise<ModelSourceSetting> {
    const normalized = normalizeModelSource(source);
    await this.options.storage.set({ [MODEL_SOURCE_KEY]: normalized });
    return normalized;
  }

  /**
   * The source to actually download from.
   *
   * `auto` uses whatever worked last and only probes when there is no such
   * record. An explicit choice is returned untouched: if it fails, the failure
   * belongs to the user rather than being papered over with another source they
   * did not pick (spec §3.4).
   */
  async resolveSource(model: OnDeviceModel): Promise<ModelSource> {
    const setting = await this.getSource();
    if (setting.host !== 'auto') {
      return setting.host === 'custom'
        ? { host: 'custom', customHostUrl: setting.customHostUrl }
        : { host: setting.host };
    }

    const remembered = await this.getLastGood();
    if (remembered) return { host: remembered };

    const winner = await this.probe(model);
    await this.setLastGood(winner);
    return { host: winner };
  }

  // --- model tiers ----------------------------------------------------------

  /** True when every file of the tier is in the cache. */
  async isTierDownloaded(model: OnDeviceModel, tier: ModelTier): Promise<boolean> {
    return tierFilesPresent(model, tier, await this.modelKeys());
  }

  /** The tiers of this model that are fully downloaded. */
  async downloadedTiers(model: OnDeviceModel): Promise<ModelTier[]> {
    const present = await this.modelKeys();
    return (model.tiers ?? []).filter((tier) => tierFilesPresent(model, tier, present));
  }

  /** Fetch a tier's files. Files already cached are counted, not re-fetched. */
  async downloadTier(
    model: OnDeviceModel,
    tier: ModelTier,
    options: DownloadOptions = {}
  ): Promise<void> {
    const source = await this.resolveSource(model);
    await downloadFiles(tierPlan(model, tier, source), this.downloadOptions(options));
    await this.rememberHost(source.host);
  }

  /**
   * Delete one tier, keeping what another downloaded tier still needs.
   *
   * All three tiers share `config.json` and the two tokenizer files, so the
   * tier's own ONNX is not the only thing a delete touches — and removing a
   * shared file while another tier is still installed would silently break it.
   */
  async deleteTier(model: OnDeviceModel, tier: ModelTier): Promise<void> {
    const cache = await this.bucket(TRANSFORMERS_CACHE);
    const present = await presentKeys(cache);

    for (const file of tier.files) {
      if (isSharedModelFile(file) && sharedFileStillNeeded(model, file, tier, present)) continue;
      await cache.delete(canonicalModelUrl(model.repo, file));
    }
  }

  // --- voices ---------------------------------------------------------------

  /** True when this voice's file is cached. A failed download is not. */
  async isVoiceDownloaded(model: OnDeviceModel, voiceId: string): Promise<boolean> {
    const cache = await this.bucket(KOKORO_VOICES_CACHE);
    return (await cache.match(voiceKey(model, voiceId))) !== undefined;
  }

  /** Which of `voiceIds` are already cached, in the order they were given. */
  async downloadedVoiceIds(model: OnDeviceModel, voiceIds: readonly string[]): Promise<string[]> {
    const present = await this.voiceKeys();
    return voiceIds.filter((voiceId) => present.has(voiceKey(model, voiceId)));
  }

  /**
   * Fetch one voice, on demand.
   *
   * Voices are small (about 522 KB) and are fetched when the user picks one, so
   * a first playback waits for this rather than failing quietly.
   */
  async downloadVoice(
    model: OnDeviceModel,
    voiceId: string,
    options: DownloadOptions = {}
  ): Promise<void> {
    const source = await this.resolveSource(model);
    await downloadFiles(voicePlan(model, voiceId, source), this.downloadOptions(options));
    await this.rememberHost(source.host);
  }

  /**
   * Fetch many voices, reporting progress over the batch.
   *
   * One voice failing does not abandon the others, and a failed voice is never
   * reported as downloaded — "downloaded" is read from the cache, not from a
   * flag this method could get wrong. Cancelling does stop the whole batch,
   * because that is the user's decision rather than a failure.
   */
  async downloadAllVoices(
    model: OnDeviceModel,
    voiceIds: readonly string[],
    options: DownloadOptions = {}
  ): Promise<VoiceDownloadReport> {
    const source = await this.resolveSource(model);
    const totalBytes = voiceIds.length * VOICE_FILE_BYTES;
    const fetched = new Map<string, number>();
    const report = (path: string, index: number): void => {
      options.onProgress?.({
        bytes: sumValues(fetched.values()),
        totalBytes,
        path,
        fileIndex: index + 1,
        fileCount: voiceIds.length,
      });
    };

    const downloaded: string[] = [];
    const failed: VoiceDownloadFailure[] = [];

    await pool(
      voiceIds,
      this.options.voiceConcurrency ?? DEFAULT_VOICE_CONCURRENCY,
      async (voiceId, index) => {
        const plan = voicePlan(model, voiceId, source);
        const path = plan[0]?.path ?? voiceId;
        try {
          await downloadFiles(plan, {
            ...this.downloadOptions({ signal: options.signal }),
            onProgress: (progress) => {
              fetched.set(voiceId, progress.bytes);
              report(path, index);
            },
          });
          fetched.set(voiceId, VOICE_FILE_BYTES);
          downloaded.push(voiceId);
        } catch (error) {
          if (isCancellation(error)) throw error;
          // The bytes already transferred stay counted: a bar that moves
          // backwards reads as a bug, and what failed is reported separately.
          failed.push({ voiceId, error: toError(error) });
        }
        report(path, index);
      }
    );

    await this.rememberHost(source.host);
    return { downloaded, failed };
  }

  /**
   * Delete every voice file of this model.
   *
   * Scoped to the model's repository so a second model sharing the bucket —
   * `kokoro-voices` is `kokoro-js`'s name for it, not ours — keeps its own.
   */
  async deleteAllVoices(model: OnDeviceModel): Promise<void> {
    const cache = await this.bucket(KOKORO_VOICES_CACHE);
    const prefix = voiceUrlPrefix(model.repo);

    for (const entry of await cache.keys()) {
      const url = cacheKeyUrl(entry);
      if (url?.startsWith(prefix)) await cache.delete(url);
    }
  }

  // --- what it all costs ----------------------------------------------------

  /**
   * What the model buckets hold.
   *
   * Counted by key, so the three files every tier shares are counted once no
   * matter how many tiers are installed. Sizes come from the registry's
   * measured constants rather than from reading the bodies back: a user asking
   * "how much space" must not cost a 325 MB read.
   *
   * Only tiers carry a measured size, so a `files`-shaped model (shapes B and
   * C, none of which P4 ships) would not be counted until it has one.
   */
  async usage(): Promise<ModelUsage> {
    const modelKeys = await this.modelKeys();
    const counted = new Set<string>();
    let modelBytes = 0;

    for (const model of MODELS) {
      for (const tier of model.tiers ?? []) {
        for (const file of tier.files) {
          const key = canonicalModelUrl(model.repo, file);
          if (!modelKeys.has(key) || counted.has(key)) continue;
          counted.add(key);
          modelBytes += fileBytes(tier, file);
        }
      }
    }

    const voices = await this.voiceKeys();
    const voiceBytes = voices.size * VOICE_FILE_BYTES;
    return {
      modelBytes,
      voiceBytes,
      totalBytes: modelBytes + voiceBytes,
      voiceCount: voices.size,
    };
  }

  // --- internals ------------------------------------------------------------

  private cacheStorage(): ModelCacheStorage {
    return this.options.cacheStorage ?? globalThis.caches;
  }

  private fetcher(): FetchLike {
    return this.options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private downloadOptions(options: DownloadOptions): DownloadOptions {
    return {
      signal: options.signal,
      onProgress: options.onProgress,
      cacheStorage: this.cacheStorage(),
      fetch: this.fetcher(),
    };
  }

  private bucket(name: string): Promise<ModelCache> {
    return this.cacheStorage().open(name);
  }

  /** The canonical keys present in the model bucket. */
  private async modelKeys(): Promise<Set<string>> {
    return presentKeys(await this.bucket(TRANSFORMERS_CACHE));
  }

  /** The voice keys present in the voice bucket. */
  private async voiceKeys(): Promise<Set<string>> {
    const present = await presentKeys(await this.bucket(KOKORO_VOICES_CACHE));
    const voices = new Set<string>();
    for (const url of present) {
      if (isVoiceUrl(url)) voices.add(url);
    }
    return voices;
  }

  private async getLastGood(): Promise<ConcreteModelHost | null> {
    const stored = await this.options.storage.get(MODEL_HOST_LAST_GOOD_KEY);
    return normalizeLastGood(stored[MODEL_HOST_LAST_GOOD_KEY]);
  }

  private async setLastGood(host: ConcreteModelHost): Promise<void> {
    await this.options.storage.set({ [MODEL_HOST_LAST_GOOD_KEY]: host });
  }

  /**
   * Remember a source that just worked.
   *
   * `auto` only ever picks one of the two mirrors, so a custom mirror is not
   * recorded: it would be remembered for a question it can never answer.
   */
  private async rememberHost(host: ConcreteModelHost): Promise<void> {
    if (host === 'custom') return;
    await this.setLastGood(host);
  }

  /**
   * Ask both mirrors for one small file and take the first to answer.
   *
   * Racing rather than trying one after the other: a mirror that is slow to
   * connect is exactly the case this is here to avoid, and a sequential try
   * would wait the full timeout on it before trying the other.
   */
  private async probe(model: OnDeviceModel): Promise<ConcreteModelHost> {
    const candidates: readonly ConcreteModelHost[] = ['huggingface', 'modelscope'];
    const controllers: AbortController[] = [];
    const attempts = candidates.map((host) => {
      const controller = new AbortController();
      controllers.push(controller);
      return this.probeOne(model, host, controller);
    });

    try {
      return await Promise.any(attempts);
    } catch {
      throw new ModelHostUnreachableError(candidates);
    } finally {
      // The loser is still in flight and nobody is waiting for it.
      for (const controller of controllers) controller.abort();
    }
  }

  private async probeOne(
    model: OnDeviceModel,
    host: ConcreteModelHost,
    controller: AbortController
  ): Promise<ConcreteModelHost> {
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    );

    try {
      const key = canonicalModelUrl(model.repo, PROBE_FILE);
      const response = await this.fetcher()(resolveUrl(key, { host }), {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${host} answered ${response.status}`);
      // A captive portal answers 200 with an HTML page; a `config.json` that is
      // not JSON is not a source we can download from.
      await response.json();
      return host;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * A stored value read as a source choice.
 *
 * Unknown hosts become `auto`, and `custom` without a usable URL does too: the
 * alternative is a download that fails at `fetch` time with no way for the
 * panel to explain why. A valid mirror URL is kept whatever the host is, so
 * switching away from `custom` and back does not lose what the user typed.
 */
export function normalizeModelSource(value: unknown): ModelSourceSetting {
  const raw = asRecord(value);
  const host = isModelHostId(raw.host) ? raw.host : DEFAULT_MODEL_SOURCE.host;
  const customHostUrl = isHttpsUrl(raw.customHostUrl) ? raw.customHostUrl.trim() : undefined;

  if (host === 'custom' && !customHostUrl) return DEFAULT_MODEL_SOURCE;
  return customHostUrl ? { host, customHostUrl } : { host };
}

/** The remembered source, or null when there is none worth using. */
export function normalizeLastGood(value: unknown): ConcreteModelHost | null {
  return value === 'huggingface' || value === 'modelscope' ? value : null;
}

function isModelHostId(value: unknown): value is ModelHostId {
  return typeof value === 'string' && MODEL_HOSTS.some((host) => host === value);
}

/** An absolute `https://` URL. The spec requires https for a custom mirror. */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith('https://')) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** Every file of the tier is in the cache. */
export function tierFilesPresent(
  model: OnDeviceModel,
  tier: ModelTier,
  present: ReadonlySet<string>
): boolean {
  return tier.files.every((file) => present.has(canonicalModelUrl(model.repo, file)));
}

/**
 * The canonical model keys Cache Storage holds.
 *
 * Exported because "is this tier downloaded" is asked in two places — the
 * model tab (through `ModelStore`) and the local provider's `validate()`, which
 * runs in the offscreen document where there is no `chrome.storage` to build a
 * whole `ModelStore` over. Both go through `tierFilesPresent` so the answer
 * cannot drift.
 */
export async function modelKeysInCache(cacheStorage: ModelCacheStorage): Promise<Set<string>> {
  return presentKeys(await cacheStorage.open(TRANSFORMERS_CACHE));
}

/**
 * Whether another tier that is actually installed still needs this shared file.
 *
 * "Installed" means its own weights are there: an orphaned `config.json` left
 * behind by a tier whose ONNX is gone is dead weight, and keeping it forever
 * would make the space count drift upwards.
 */
function sharedFileStillNeeded(
  model: OnDeviceModel,
  file: string,
  excluding: ModelTier,
  present: ReadonlySet<string>
): boolean {
  return (model.tiers ?? []).some((other) => {
    if (other.id === excluding.id || !other.files.includes(file)) return false;
    return other.files
      .filter((own) => !isSharedModelFile(own))
      .every((own) => present.has(canonicalModelUrl(model.repo, own)));
  });
}

/** The URLs stored in a bucket, ignoring anything without one. */
async function presentKeys(cache: ModelCache): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const entry of await cache.keys()) {
    const url = cacheKeyUrl(entry);
    if (url !== null) keys.add(url);
  }
  return keys;
}

/**
 * Run `worker` over `items`, `limit` at a time.
 *
 * Rejects as soon as a worker does, without waiting for the others: a
 * cancellation should not have to finish the voices already in flight.
 */
async function pool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const size = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const runners = Array.from({ length: size }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      await worker(item, index);
    }
  });

  await Promise.all(runners);
}

function sumValues(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
