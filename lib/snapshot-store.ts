import type { EngineSentence, SessionSnapshot } from './protocol';

export const SNAPSHOT_KEY = 'sayloud-session';

/** The slice of `chrome.storage.session` this module needs. */
export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Persists the session so a recycled service worker can pick it back up.
 *
 * `chrome.storage.session` is the right home: it survives worker recycling but
 * not a browser restart, which matches a reading session's lifetime. Values read
 * back are untrusted — storage is shared with older extension versions — so
 * everything is validated before use.
 */
export class SnapshotStore {
  constructor(private readonly area: SessionStorageArea) {}

  async save(snapshot: SessionSnapshot | null): Promise<void> {
    if (snapshot) {
      await this.area.set({ [SNAPSHOT_KEY]: snapshot });
      return;
    }
    await this.area.remove(SNAPSHOT_KEY);
  }

  async load(): Promise<SessionSnapshot | null> {
    const stored = await this.area.get(SNAPSHOT_KEY);
    return parseSnapshot(stored[SNAPSHOT_KEY]);
  }
}

function parseSnapshot(value: unknown): SessionSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  if (!Array.isArray(raw.sentences)) return null;
  const sentences: EngineSentence[] = [];
  for (const item of raw.sentences) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.text !== 'string' || entry.text.length === 0) continue;
    sentences.push({ text: entry.text, lang: readString(entry.lang, 'en') });
  }
  // A snapshot without sentences has nothing to resume.
  if (sentences.length === 0) return null;

  return {
    tabId: readNumber(raw.tabId, -1),
    docId: readString(raw.docId, ''),
    sentences,
    index: readNumber(raw.index, 0),
    resumeOffset: readNumber(raw.resumeOffset, 0),
    voice: readString(raw.voice, ''),
    rate: readNumber(raw.rate, 1),
    charsRead: readNumber(raw.charsRead, 0),
  };
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
