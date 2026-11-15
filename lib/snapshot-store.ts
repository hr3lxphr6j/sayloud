import type { EngineSentence, SessionSnapshot } from './protocol';
import { isRecord } from './records';

export const SNAPSHOT_KEY = 'sayloud-session';
export const SNAPSHOT_BACKUP_KEY = 'sayloud-session-backup';

/** The slice of `chrome.storage.session` this module needs. */
export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The slice of `chrome.storage.local` this module needs for backup. */
export interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Persists the session with dual-layer storage for reliability.
 *
 * Primary storage: `chrome.storage.session` - fast, in-memory, survives service
 * worker recycling but not browser restart.
 *
 * Backup storage: `chrome.storage.local` - persistent, on-disk, survives browser
 * restart and service worker termination.
 *
 * Session storage survives service worker recycling. The local backup is used
 * when session storage has no usable snapshot, including after a browser restart.
 */
export class SnapshotStore {
  private pendingWrite: Promise<void> = Promise.resolve();
  constructor(
    private readonly session: SessionStorageArea,
    private readonly local: LocalStorageArea
  ) {}

  async save(snapshot: SessionSnapshot | null): Promise<void> {
    const write = this.pendingWrite.catch(() => {}).then(() => this.write(snapshot));
    this.pendingWrite = write;
    await write;
  }

  private async write(snapshot: SessionSnapshot | null): Promise<void> {
    if (snapshot) {
      // Dual-write: session for speed, local for durability
      await Promise.all([
        this.session.set({ [SNAPSHOT_KEY]: snapshot }),
        this.local.set({ [SNAPSHOT_BACKUP_KEY]: snapshot }),
      ]);
      return;
    }
    // Clear both storages when session ends.
    await Promise.all([this.session.remove(SNAPSHOT_KEY), this.local.remove(SNAPSHOT_BACKUP_KEY)]);
  }

  async load(): Promise<SessionSnapshot | null> {
    try {
      // Try session storage first (fast path)
      const stored = await this.session.get(SNAPSHOT_KEY);
      let snapshot = parseSnapshot(stored[SNAPSHOT_KEY], 'session');

      // Fallback to local storage if session is empty
      if (!snapshot) {
        const backup = await this.local.get(SNAPSHOT_BACKUP_KEY);
        snapshot = parseSnapshot(backup[SNAPSHOT_BACKUP_KEY], 'local');

        // Restore to session storage for future fast access
        if (snapshot) await this.session.set({ [SNAPSHOT_KEY]: snapshot });
      }

      return snapshot;
    } catch (error) {
      console.error('[SayLoud] snapshot load failed with exception', error);
      return null;
    }
  }
}

function parseSnapshot(value: unknown, source: 'session' | 'local'): SessionSnapshot | null {
  if (!isRecord(value)) {
    if (value !== undefined) {
      console.warn(`[SayLoud] snapshot parse failed (${source}): value is not an object`, {
        value,
      });
    }
    return null;
  }
  const raw = value;

  // Backward compatibility: if the old format (with sentences array) is found,
  // convert it to the new format. The sentences exist only here: what is stored
  // is their statistics, so the counts are computed rather than read.
  if (Array.isArray(raw.sentences)) {
    const sentences: EngineSentence[] = [];
    let skipped = 0;
    for (const item of raw.sentences) {
      if (!item || typeof item !== 'object') {
        skipped++;
        continue;
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry.text !== 'string' || entry.text.length === 0) {
        skipped++;
        continue;
      }
      sentences.push({ text: entry.text, lang: readString(entry.lang, 'en') });
    }

    if (sentences.length === 0) {
      console.warn(`[SayLoud] snapshot parse failed (${source}): no valid sentences`, {
        rawCount: raw.sentences.length,
        skipped,
      });
      return null;
    }

    return readSnapshot(raw, {
      sentenceCount: sentences.length,
      charsTotal: sentences.reduce((sum, s) => sum + s.text.length, 0),
    });
  }

  // New format: just statistics, no sentences
  const sentenceCount = readNumber(raw.sentenceCount, 0);
  const charsTotal = readNumber(raw.charsTotal, 0);

  // Reject snapshots with no sentences (nothing to restore)
  if (sentenceCount === 0) {
    console.warn(`[SayLoud] snapshot parse failed (${source}): sentenceCount is 0`);
    return null;
  }

  return readSnapshot(raw, { sentenceCount, charsTotal });
}

/**
 * Build the snapshot both formats end up as.
 *
 * Everything but the two counts is stored the same way in both, so the counts
 * are the only thing a caller has to supply: the old format had to count the
 * sentences it was given, the new one reads what was written.
 */
function readSnapshot(
  raw: Record<string, unknown>,
  counts: { sentenceCount: number; charsTotal: number }
): SessionSnapshot {
  return {
    tabId: readNumber(raw.tabId, -1),
    docId: readString(raw.docId, ''),
    sentenceCount: counts.sentenceCount,
    charsTotal: counts.charsTotal,
    index: readNumber(raw.index, 0),
    resumeOffset: readNumber(raw.resumeOffset, 0),
    voice: readString(raw.voice, ''),
    rate: readNumber(raw.rate, 1),
    charsRead: readNumber(raw.charsRead, 0),
    resumeTimeMs: readNumber(raw.resumeTimeMs, 0),
  };
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
