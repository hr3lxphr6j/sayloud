/**
 * Two-layer, content-addressed cache for synthesized audio (spec §4).
 *
 * The key is a hash of everything that changes the bytes a provider returns —
 * the text, the voice, and the handful of config fields that steer synthesis
 * (model, output format, …). Credentials and other secrets are deliberately
 * absent: they identify the account, not the audio, and a hash is not a place
 * to keep a key.
 *
 * L1 is an in-memory LRU that dies with the offscreen document; L2 is an
 * IndexedDB store that survives it, which is what makes a second read of the
 * same article cheap after Chrome has recycled the document.
 */
import type { ProviderConfig, SynthesisResult, WordTiming } from './providers/types';

/** What identifies one piece of audio. */
export interface CacheIdentity {
  text: string;
  voiceId: string;
  config: ProviderConfig;
}

/** 50MB of decoded audio in memory: enough for a long article, bounded. */
const DEFAULT_MAX_L1_BYTES = 50 * 1024 * 1024;
/** 200MB on disk, pruned oldest-first. */
const DEFAULT_MAX_L2_BYTES = 200 * 1024 * 1024;

/**
 * How long an entry may go untouched before it is dropped.
 *
 * A month is far longer than any reading session and far shorter than the time
 * it takes to fill a disk: what accumulates here is audio for articles nobody
 * is going to read again, and a store that only ever grows is a store that
 * eventually evicts something the user just listened to.
 */
const EXPIRED_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const DB_NAME = 'sayloud-cache';
const DB_VERSION = 1;
const STORE = 'audio';
const TIMESTAMP_INDEX = 'timestamp';

/**
 * The record L2 stores.
 *
 * `timestamp` exists so the store can be pruned oldest-first; it is written on
 * every put and refreshed on every hit, so an entry that keeps being read
 * outlives one that was synthesized once and never needed again.
 */
interface L2Entry {
  key: string;
  audio: ArrayBuffer;
  mime: string;
  durationMs: number;
  timings?: WordTiming[];
  timestamp: number;
}

interface L1Entry {
  result: SynthesisResult;
  size: number;
}

/**
 * In-memory LRU over `Map`'s insertion order: re-inserting a key on read moves
 * it to the most-recently-used end, and the first key is always the coldest.
 */
export class L1Cache {
  private readonly entries = new Map<string, L1Entry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number = DEFAULT_MAX_L1_BYTES) {}

  get size(): number {
    return this.bytes;
  }

  get count(): number {
    return this.entries.size;
  }

  get(key: string): SynthesisResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.result;
  }

  put(key: string, result: SynthesisResult): void {
    const size = result.audio.byteLength;

    // A sentence bigger than the whole cache is not worth evicting everything
    // else for: the next sentence would evict it again immediately.
    if (size > this.maxBytes) return;

    this.delete(key);
    this.evictFor(size);
    this.entries.set(key, { result, size });
    this.bytes += size;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.size;
  }

  /** Drop the coldest entries until `size` more bytes fit. */
  private evictFor(size: number): void {
    for (const key of this.entries.keys()) {
      if (this.bytes + size <= this.maxBytes) return;
      this.delete(key);
    }
  }
}

export interface L2CacheOptions {
  /** Defaults to the page's IndexedDB. Injected so tests can use a fake. */
  factory?: IDBFactory;
  dbName?: string;
  maxBytes?: number;
}

/** The IndexedDB half of the cache. */
export class L2Cache {
  private readonly factory: IDBFactory;
  private readonly dbName: string;
  private maxBytes: number;
  private db: IDBDatabase | null = null;
  /** The in-flight `init()`, so two callers cannot open two connections. */
  private opening: Promise<void> | null = null;
  /** Running total, seeded by a full pass on `init()`. */
  private bytes = 0;
  /**
   * The keys on disk.
   *
   * Keys are content hashes, so a key that is written twice holds the same
   * audio and therefore the same number of bytes; tracking the set is what
   * keeps the byte total exact without reading the old record back.
   */
  private readonly keys = new Set<string>();

  constructor(options: L2CacheOptions = {}) {
    this.factory = options.factory ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? DB_NAME;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_L2_BYTES;
  }

  get size(): number {
    return this.bytes;
  }

  get entryCount(): number {
    return this.keys.size;
  }

  /**
   * Open the database and measure what is already stored.
   *
   * Concurrent callers share one opening: the offscreen document warms the
   * cache at startup, and the first sentence can ask for it before that
   * finishes.
   */
  async init(): Promise<void> {
    if (this.db) return;
    this.opening ??= this.openAndMeasure().finally(() => {
      this.opening = null;
    });
    await this.opening;
  }

  private async openAndMeasure(): Promise<void> {
    this.db = await this.open();
    this.seed(await this.measure());
    // A store nobody has opened for a month is a store nobody is reading; the
    // sweep happens here rather than on a timer because an offscreen document
    // does not live long enough to own one.
    await this.expire(EXPIRED_ENTRY_AGE_MS);
  }

  async get(key: string): Promise<SynthesisResult | undefined> {
    const db = await this.ready();
    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE);
    const entry = await request<L2Entry | undefined>(store.get(key));
    const result = toResult(entry);

    // A hit is the entry being used, and `prune()` evicts by last use, so the
    // timestamp is refreshed here. The record is already in hand, so this is
    // one write rather than a second read; a malformed one is left alone.
    if (result && entry) {
      entry.timestamp = Date.now();
      await request(store.put(entry));
    }

    await done;
    return result;
  }

  async put(key: string, result: SynthesisResult): Promise<void> {
    const db = await this.ready();
    const entry: L2Entry = {
      key,
      audio: result.audio,
      mime: result.mime,
      durationMs: result.durationMs,
      timestamp: Date.now(),
    };
    if (result.timings) entry.timings = result.timings;

    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    await request(tx.objectStore(STORE).put(entry));
    await done;

    if (!this.keys.has(key)) {
      this.keys.add(key);
      this.bytes += result.audio.byteLength;
    }
    await this.prune();
  }

  async clear(): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    await request(tx.objectStore(STORE).clear());
    await done;

    this.bytes = 0;
    this.keys.clear();
  }

  /**
   * Change the budget and bring the store down to it.
   *
   * A size that is not usable is ignored rather than applied: this setter is
   * fed from the saved settings, and a preference that could not be read must
   * not be the reason a whole store is deleted.
   */
  async setMaxBytes(bytes: number): Promise<void> {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.maxBytes = bytes;
    await this.prune();
  }

  /**
   * What the store holds, measured from disk.
   *
   * The counters this instance keeps can be out of date — the settings panel
   * has its own connection to the same store and can empty it while this one
   * is still counting — so a number shown to a user is measured instead. The
   * measurement doubles as a repair: it re-seeds the counters, which is what
   * keeps the next `prune()` from evicting entries to make room for bytes that
   * are already gone.
   */
  async usage(): Promise<{ bytes: number; entries: number }> {
    const measured = await this.measure();
    this.seed(measured);
    return { bytes: measured.bytes, entries: this.keys.size };
  }

  /**
   * The counters as they stand, without walking the store.
   *
   * `init()` has already measured, and every later mutation keeps these true, so
   * a caller that only wants to show a number does not pay for a second pass
   * over every record — which, with a full cache, means re-reading hundreds of
   * megabytes of audio.
   */
  counters(): { bytes: number; entries: number } {
    return { bytes: this.bytes, entries: this.keys.size };
  }

  /**
   * Drop every entry last touched more than `olderThanMs` ago.
   *
   * The timestamp index is ordered, so the scan stops at the first entry that
   * is recent enough instead of walking the whole store. Records written
   * without a timestamp are not in the index and cannot expire; `put()` always
   * writes one.
   */
  async expire(olderThanMs: number): Promise<void> {
    const cutoff = Date.now() - olderThanMs;
    const db = await this.ready();
    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    const cursor = tx.objectStore(STORE).index(TIMESTAMP_INDEX).openCursor();

    await new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row || timestampOf(row.value) >= cutoff) {
          resolve();
          return;
        }
        this.bytes -= storedBytes(row.value);
        const key = storedKey(row.value);
        if (key !== null) this.keys.delete(key);
        row.delete();
        row.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error('the audio cache is unreadable'));
    });
    await done;
  }

  /** Close the connection; the offscreen document calls this as it unloads. */
  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** The database, opened on first use. */
  private async ready(): Promise<IDBDatabase> {
    if (!this.db) await this.init();
    const db = this.db;
    if (!db) throw new Error('the audio cache could not be opened');
    return db;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const open = this.factory.open(this.dbName, DB_VERSION);

      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex(TIMESTAMP_INDEX, 'timestamp');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('the audio cache could not be opened'));
      open.onblocked = () =>
        reject(new Error('the audio cache is blocked by another open document'));
    });
  }

  /** Take a measurement as the new truth about both counters. */
  private seed(measured: { bytes: number; keys: string[] }): void {
    this.bytes = measured.bytes;
    this.keys.clear();
    for (const key of measured.keys) this.keys.add(key);
  }

  /** Every stored key and the total size, for the in-memory counters. */
  private async measure(): Promise<{ bytes: number; keys: string[] }> {
    const db = await this.ready();
    const tx = db.transaction(STORE, 'readonly');
    const done = transactionDone(tx);
    const cursor = tx.objectStore(STORE).openCursor();

    let bytes = 0;
    const keys: string[] = [];
    await new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) {
          resolve();
          return;
        }
        bytes += storedBytes(row.value);
        const key = storedKey(row.value);
        if (key !== null) keys.push(key);
        row.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error('the audio cache is unreadable'));
    });
    await done;

    return { bytes, keys };
  }

  /** Drop the oldest entries until the store fits its budget again. */
  private async prune(): Promise<void> {
    if (this.bytes <= this.maxBytes) return;

    const db = await this.ready();
    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    const cursor = tx.objectStore(STORE).index(TIMESTAMP_INDEX).openCursor();

    await new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row || this.bytes <= this.maxBytes) {
          resolve();
          return;
        }
        this.bytes -= storedBytes(row.value);
        const key = storedKey(row.value);
        if (key !== null) this.keys.delete(key);
        row.delete();
        row.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error('the audio cache is unreadable'));
    });
    await done;
  }
}

export interface CacheManagerOptions extends L2CacheOptions {
  maxL1Bytes?: number;
}

/** The cache the audio worker talks to: L1 first, then L2. */
export class CacheManager {
  private readonly l1: L1Cache;
  private readonly l2: L2Cache;
  /**
   * Whether the durable layer is in use.
   *
   * On unless the user turns it off, which is why this is not simply read from
   * the settings: the cache has to work before anyone has read one.
   */
  private persist = true;

  constructor(options: CacheManagerOptions = {}) {
    this.l1 = new L1Cache(options.maxL1Bytes ?? DEFAULT_MAX_L1_BYTES);
    this.l2 = new L2Cache(options);
  }

  /** Opens the IndexedDB half; a failure here only costs the L2 hits. */
  async init(): Promise<void> {
    await this.l2.init();
  }

  /** SHA-256 of the text, the voice, and the audio-affecting config. */
  async computeKey(identity: CacheIdentity): Promise<string> {
    const payload = stableJson({
      text: identity.text,
      voiceId: identity.voiceId,
      config: audioIdentity(identity.config),
    });
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(payload)
    );
    return toHex(digest);
  }

  getL1(key: string): SynthesisResult | undefined {
    return this.l1.get(key);
  }

  getL2(key: string): Promise<SynthesisResult | undefined> {
    return this.l2.get(key);
  }

  putL1(key: string, result: SynthesisResult): void {
    this.l1.put(key, result);
  }

  putL2(key: string, result: SynthesisResult): Promise<void> {
    return this.l2.put(key, result);
  }

  clearL1(): void {
    this.l1.clear();
  }

  clearL2(): Promise<void> {
    return this.l2.clear();
  }

  /**
   * Turn the durable layer on or off.
   *
   * Off means "memory only", which is why the store is emptied: the user asked
   * for nothing to be written, not for what is already written to be read back
   * later. The flag is set before the clear is awaited, so a sentence being
   * synthesized right now cannot land in the store afterwards.
   */
  async setPersist(persist: boolean): Promise<void> {
    this.persist = persist;
    if (!persist) await this.l2.clear();
  }

  /** Change how much the durable layer may hold, and prune down to it. */
  setMaxBytes(bytes: number): Promise<void> {
    return this.l2.setMaxBytes(bytes);
  }

  /** Empty both layers; the settings panel's "clear cache". */
  async clear(): Promise<void> {
    this.l1.clear();
    await this.l2.clear();
  }

  /**
   * What the durable layer holds, measured.
   *
   * L1 is deliberately not part of this: it is the offscreen document's own
   * memory and dies with the document, so there is nothing a user could do
   * about a number for it.
   */
  usage(): Promise<{ bytes: number; entries: number }> {
    return this.l2.usage();
  }

  /** L1, then L2 — promoting an L2 hit so the next sentence boundary is free. */
  async get(key: string): Promise<SynthesisResult | undefined> {
    const cached = this.l1.get(key);
    if (cached) return cached;
    // With persistence off, the memory layer is the whole cache: reading a
    // record out of the store would be reading back what was just deleted.
    if (!this.persist) return undefined;

    const stored = await this.l2.get(key);
    if (stored) this.l1.put(key, stored);
    return stored;
  }

  /** Write to both layers; L1 is synchronous and L2 is awaited. */
  async put(key: string, result: SynthesisResult): Promise<void> {
    this.l1.put(key, result);
    if (this.persist) await this.l2.put(key, result);
  }

  /** The byte counts this instance keeps; `usage()` is what a user is shown. */
  stats(): { l1Bytes: number; l2Bytes: number; l2Entries: number } {
    return { l1Bytes: this.l1.size, l2Bytes: this.l2.size, l2Entries: this.l2.entryCount };
  }
}

/**
 * The config fields that change the audio.
 *
 * Everything else — keys, tokens, workspace ids — is an account detail: two
 * configs that differ only in their credentials produce the same bytes, and
 * hashing a key would put a secret in the cache key for no benefit. A self-
 * hosted endpoint is different: another server is another engine, so
 * `openai-compat` includes its base URL.
 */
function audioIdentity(config: ProviderConfig): Record<string, unknown> {
  switch (config.provider) {
    case 'browser':
      return { lang: config.lang ?? null };
    case 'dashscope':
      return { model: config.model ?? null, region: config.region ?? null };
    case 'volcengine':
      // The resource id decides both the model version and the billing mode, so
      // there is no separate model to fold in.
      return { resourceId: config.resourceId ?? null };
    case 'openai-compat':
      return {
        baseUrl: config.baseUrl,
        model: config.model ?? null,
        captionedSpeech: config.captionedSpeech === true,
      };
    case 'elevenlabs':
      return {
        model: config.model ?? null,
        outputFormat: config.outputFormat ?? null,
        voiceSettings: config.voiceSettings ?? null,
      };
    case 'azure':
      return {
        outputFormat: config.outputFormat ?? null,
        lang: config.lang ?? null,
      };
    case 'local':
      // The tier and the device both change the audio, and both are things the
      // user can change at will — so both belong in the key, or switching to a
      // sharper tier would keep replaying the old one's cached sentences.
      return {
        model: config.modelId ?? 'kokoro-82m',
        tier: config.tier ?? null,
        device: config.device ?? 'auto',
      };
    default: {
      // A new provider must decide what steers its audio rather than silently
      // sharing another provider's identity.
      const unhandled: never = config;
      return unhandled;
    }
  }
}

/** JSON with object keys sorted, so key order cannot change the hash. */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function toHex(buffer: ArrayBuffer): string {
  let hex = '';
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** A stored record, or undefined when it is missing or malformed. */
function toResult(entry: L2Entry | undefined): SynthesisResult | undefined {
  if (!entry || !(entry.audio instanceof ArrayBuffer)) return undefined;
  if (typeof entry.mime !== 'string') return undefined;

  const result: SynthesisResult = {
    audio: entry.audio,
    mime: entry.mime,
    durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : 0,
  };

  const timings = toTimings(entry.timings);
  if (timings.length > 0) result.timings = timings;
  return result;
}

/** Only well-formed timings survive a read; a bad one is dropped, not fatal. */
function toTimings(value: unknown): WordTiming[] {
  if (!Array.isArray(value)) return [];

  const timings: WordTiming[] = [];
  for (const word of value) {
    if (typeof word !== 'object' || word === null) continue;
    const { charStart, charEnd, startMs, endMs } = word as Record<string, unknown>;
    if (!isNumber(charStart) || !isNumber(charEnd) || !isNumber(startMs) || !isNumber(endMs)) {
      continue;
    }
    timings.push({ charStart, charEnd, startMs, endMs });
  }
  return timings;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function storedBytes(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const audio = (value as { audio?: unknown }).audio;
  return audio instanceof ArrayBuffer ? audio.byteLength : 0;
}

function storedKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const key = (value as { key?: unknown }).key;
  return typeof key === 'string' && key !== '' ? key : null;
}

/** When a stored record was last touched; 0 for one the index cannot order. */
function timestampOf(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const timestamp = (value as { timestamp?: unknown }).timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : 0;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('the audio cache request failed'));
  });
}

/**
 * Resolves when the transaction commits.
 *
 * Attach this immediately after creating the transaction: a transaction that
 * finishes before the handlers are attached would otherwise never settle.
 */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('the audio cache transaction was aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('the audio cache transaction failed'));
  });
}
