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

const DB_NAME = 'sayloud-cache';
const DB_VERSION = 1;
const STORE = 'audio';
const TIMESTAMP_INDEX = 'timestamp';

/**
 * The record L2 stores.
 *
 * `timestamp` exists so the store can be pruned oldest-first; it is written on
 * every put, so re-synthesizing a sentence makes it the most recent entry.
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
  private readonly maxBytes: number;
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

    const measured = await this.measure();
    this.bytes = measured.bytes;
    this.keys.clear();
    for (const key of measured.keys) this.keys.add(key);
  }

  async get(key: string): Promise<SynthesisResult | undefined> {
    const db = await this.ready();
    const tx = db.transaction(STORE, 'readonly');
    const done = transactionDone(tx);
    const entry = await request<L2Entry | undefined>(tx.objectStore(STORE).get(key));
    await done;

    return toResult(entry);
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

  /** L1, then L2 — promoting an L2 hit so the next sentence boundary is free. */
  async get(key: string): Promise<SynthesisResult | undefined> {
    const cached = this.l1.get(key);
    if (cached) return cached;

    const stored = await this.l2.get(key);
    if (stored) this.l1.put(key, stored);
    return stored;
  }

  /** Write to both layers; L1 is synchronous and L2 is awaited. */
  async put(key: string, result: SynthesisResult): Promise<void> {
    this.l1.put(key, result);
    await this.l2.put(key, result);
  }

  /** Live byte counts, for tests and the P3 cache readout. */
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
