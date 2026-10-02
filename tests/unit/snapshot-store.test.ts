import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '~/lib/protocol';
import {
  type LocalStorageArea,
  type SessionStorageArea,
  SNAPSHOT_BACKUP_KEY,
  SNAPSHOT_KEY,
  SnapshotStore,
} from '~/lib/snapshot-store';

function fakeArea(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const area: SessionStorageArea = {
    async get(key) {
      return { [key]: data.get(key) };
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        // Chrome storage API behavior: setting undefined removes the key
        if (value === undefined) {
          data.delete(key);
        } else {
          data.set(key, value);
        }
      }
    },
    async remove(key) {
      data.delete(key);
    },
  };
  return { area, data };
}

const SNAPSHOT: SessionSnapshot = {
  tabId: 3,
  docId: 'doc-1',
  sentenceCount: 2,
  charsTotal: 24, // 'Hello world.' (12) + 'Goodbye now.' (12)
  index: 1,
  resumeOffset: 4,
  voice: 'Samantha',
  rate: 1.5,
  charsRead: 12,
  resumeTimeMs: 0,
};

describe('SnapshotStore', () => {
  let fakeSession: ReturnType<typeof fakeArea>;
  let fakeLocal: ReturnType<typeof fakeArea>;
  let store: SnapshotStore;

  beforeEach(() => {
    fakeSession = fakeArea();
    fakeLocal = fakeArea();
    store = new SnapshotStore(fakeSession.area, fakeLocal.area);
    // Suppress console logs during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a session snapshot', async () => {
    await store.save(SNAPSHOT);
    expect(await store.load()).toEqual(SNAPSHOT);
  });

  it('returns null when nothing was saved', async () => {
    expect(await store.load()).toBeNull();
  });

  it('clears the stored snapshot when passed null', async () => {
    await store.save(SNAPSHOT);
    await store.save(null);

    expect(await store.load()).toBeNull();
    expect(fakeSession.data.has(SNAPSHOT_KEY)).toBe(false);
    expect(fakeLocal.data.has(SNAPSHOT_BACKUP_KEY)).toBe(false);
  });

  it('writes to both session and local storage', async () => {
    await store.save(SNAPSHOT);

    expect(fakeSession.data.has(SNAPSHOT_KEY)).toBe(true);
    expect(fakeLocal.data.has(SNAPSHOT_BACKUP_KEY)).toBe(true);
    expect(fakeSession.data.get(SNAPSHOT_KEY)).toEqual(SNAPSHOT);
    expect(fakeLocal.data.get(SNAPSHOT_BACKUP_KEY)).toEqual(SNAPSHOT);
  });

  it('falls back to local storage when session is empty', async () => {
    // Simulate session storage being cleared (service worker restart)
    fakeLocal.data.set(SNAPSHOT_BACKUP_KEY, SNAPSHOT);

    const loaded = await store.load();
    expect(loaded).toEqual(SNAPSHOT);

    // Should restore to session storage
    expect(fakeSession.data.get(SNAPSHOT_KEY)).toEqual(SNAPSHOT);
  });

  describe('validation of stored values', () => {
    it('rejects values that are not objects', async () => {
      for (const value of [null, undefined, 42, 'nope', []]) {
        const testSession = fakeArea({ [SNAPSHOT_KEY]: value });
        const testLocal = fakeArea();
        expect(await new SnapshotStore(testSession.area, testLocal.area).load()).toBeNull();
      }
    });

    it('accepts old format snapshots and migrates them', async () => {
      const oldFormat = {
        ...SNAPSHOT,
        sentences: [
          { text: 'Hello world.', lang: 'en' },
          { text: 'Goodbye now.', lang: 'en' },
        ],
        // Old format didn't have these fields
        sentenceCount: undefined,
        charsTotal: undefined,
      };
      delete (oldFormat as any).sentenceCount;
      delete (oldFormat as any).charsTotal;

      const testSession = fakeArea({ [SNAPSHOT_KEY]: oldFormat });
      const testLocal = fakeArea();
      const migrated = await new SnapshotStore(testSession.area, testLocal.area).load();

      expect(migrated).toEqual({
        ...SNAPSHOT,
        sentenceCount: 2,
        charsTotal: 24,
      });
    });

    it('migrates old format with malformed sentences and fills in defaults', async () => {
      const testSession = fakeArea({
        [SNAPSHOT_KEY]: {
          sentences: [{ text: 'Keep me.' }, { text: 42 }, null, 'nope'],
          index: 'two',
          rate: Number.NaN,
          tabId: null,
        },
      });
      const testLocal = fakeArea();

      expect(await new SnapshotStore(testSession.area, testLocal.area).load()).toEqual({
        tabId: -1,
        docId: '',
        sentenceCount: 1,
        charsTotal: 8, // 'Keep me.'
        index: 0,
        resumeOffset: 0,
        voice: '',
        rate: 1,
        charsRead: 0,
        resumeTimeMs: 0,
      });
    });

    it('ignores non-finite numbers', async () => {
      const testSession = fakeArea({
        [SNAPSHOT_KEY]: { ...SNAPSHOT, index: Number.POSITIVE_INFINITY, charsRead: Number.NaN },
      });
      const testLocal = fakeArea();

      const loaded = await new SnapshotStore(testSession.area, testLocal.area).load();
      expect(loaded?.index).toBe(0);
      expect(loaded?.charsRead).toBe(0);
    });
  });
});
