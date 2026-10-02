import type { EngineSentence, SessionSnapshot } from './protocol';

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
 * When loading, the session storage is checked first (fast path). If empty
 * (service worker was terminated and session cleared), falls back to local
 * storage and restores the session automatically.
 *
 * This solves the "long pause breaks playback" issue where Chrome terminates
 * the service worker and clears session storage after 30 seconds of inactivity.
 */
export class SnapshotStore {
  constructor(
    private readonly session: SessionStorageArea,
    private readonly local: LocalStorageArea
  ) {}

  async save(snapshot: SessionSnapshot | null): Promise<void> {
    if (snapshot) {
      // Dual-write: session for speed, local for durability
      await Promise.all([
        this.session.set({ [SNAPSHOT_KEY]: snapshot }),
        this.local.set({ [SNAPSHOT_BACKUP_KEY]: snapshot }),
      ]);
      return;
    }
    // Clear both storages when session ends
    // Note: session.remove is available, but local storage uses set with undefined
    // to maintain compatibility with LocalStorageArea from config-store
    await Promise.all([
      this.session.remove(SNAPSHOT_KEY),
      // Chrome storage API: setting undefined removes the key
      this.local.set({ [SNAPSHOT_BACKUP_KEY]: undefined }),
    ]);
  }

  async load(): Promise<SessionSnapshot | null> {
    try {
      // Try session storage first (fast path)
      const stored = await this.session.get(SNAPSHOT_KEY);
      const hasKey = SNAPSHOT_KEY in stored;
      console.log('[SayLoud] snapshot session storage query', {
        hasKey,
        valueType: hasKey ? typeof stored[SNAPSHOT_KEY] : 'undefined',
      });

      let snapshot = parseSnapshot(stored[SNAPSHOT_KEY], 'session');

      // Fallback to local storage if session is empty
      if (!snapshot) {
        console.log('[SayLoud] session storage empty, trying local backup');
        const backup = await this.local.get(SNAPSHOT_BACKUP_KEY);
        const hasBackup = SNAPSHOT_BACKUP_KEY in backup;
        console.log('[SayLoud] snapshot local storage query', {
          hasKey: hasBackup,
          valueType: hasBackup ? typeof backup[SNAPSHOT_BACKUP_KEY] : 'undefined',
        });

        snapshot = parseSnapshot(backup[SNAPSHOT_BACKUP_KEY], 'local');

        // Restore to session storage for future fast access
        if (snapshot) {
          console.log('[SayLoud] restored snapshot from local backup to session');
          await this.session.set({ [SNAPSHOT_KEY]: snapshot });
        }
      }

      return snapshot;
    } catch (error) {
      console.error('[SayLoud] snapshot load failed with exception', error);
      return null;
    }
  }
}

function parseSnapshot(value: unknown, source: 'session' | 'local'): SessionSnapshot | null {
  if (!value || typeof value !== 'object') {
    if (value !== undefined) {
      console.warn(`[SayLoud] snapshot parse failed (${source}): value is not an object`, {
        value,
      });
    }
    return null;
  }
  const raw = value as Record<string, unknown>;

  if (!Array.isArray(raw.sentences)) {
    console.warn(`[SayLoud] snapshot parse failed (${source}): sentences is not an array`, {
      hasSentences: 'sentences' in raw,
      sentencesType: typeof raw.sentences,
    });
    return null;
  }
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
  // A snapshot without sentences has nothing to resume.
  if (sentences.length === 0) {
    console.warn(`[SayLoud] snapshot parse failed (${source}): no valid sentences`, {
      rawCount: raw.sentences.length,
      skipped,
      tabId: raw.tabId,
      docId: raw.docId,
    });
    return null;
  }

  const snapshot = {
    tabId: readNumber(raw.tabId, -1),
    docId: readString(raw.docId, ''),
    sentences,
    index: readNumber(raw.index, 0),
    resumeOffset: readNumber(raw.resumeOffset, 0),
    voice: readString(raw.voice, ''),
    rate: readNumber(raw.rate, 1),
    charsRead: readNumber(raw.charsRead, 0),
    resumeTimeMs: readNumber(raw.resumeTimeMs, 0),
  };

  console.log(`[SayLoud] snapshot loaded successfully from ${source}`, {
    tabId: snapshot.tabId,
    docId: snapshot.docId,
    sentenceCount: sentences.length,
    index: snapshot.index,
    resumeTimeMs: snapshot.resumeTimeMs,
  });

  return snapshot;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
