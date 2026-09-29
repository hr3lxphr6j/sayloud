import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '~/lib/protocol';
import { type SessionStorageArea, SNAPSHOT_KEY, SnapshotStore } from '~/lib/snapshot-store';

function fakeArea(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const area: SessionStorageArea = {
    async get(key) {
      return { [key]: data.get(key) };
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
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
  sentences: [
    { text: 'Hello world.', lang: 'en' },
    { text: 'Goodbye now.', lang: 'en' },
  ],
  index: 1,
  resumeOffset: 4,
  voice: 'Samantha',
  rate: 1.5,
  charsRead: 12,
};

describe('SnapshotStore', () => {
  let fake: ReturnType<typeof fakeArea>;
  let store: SnapshotStore;

  beforeEach(() => {
    fake = fakeArea();
    store = new SnapshotStore(fake.area);
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
    expect(fake.data.has(SNAPSHOT_KEY)).toBe(false);
  });

  describe('validation of stored values', () => {
    it('rejects values that are not objects', async () => {
      for (const value of [null, undefined, 42, 'nope', []]) {
        fake = fakeArea({ [SNAPSHOT_KEY]: value });
        expect(await new SnapshotStore(fake.area).load()).toBeNull();
      }
    });

    it('rejects a snapshot with no usable sentences', async () => {
      fake = fakeArea({ [SNAPSHOT_KEY]: { ...SNAPSHOT, sentences: [] } });
      expect(await new SnapshotStore(fake.area).load()).toBeNull();

      fake = fakeArea({ [SNAPSHOT_KEY]: { ...SNAPSHOT, sentences: [{ text: '' }] } });
      expect(await new SnapshotStore(fake.area).load()).toBeNull();
    });

    it('drops malformed sentences and fills in defaults', async () => {
      fake = fakeArea({
        [SNAPSHOT_KEY]: {
          sentences: [{ text: 'Keep me.' }, { text: 42 }, null, 'nope'],
          index: 'two',
          rate: Number.NaN,
          tabId: null,
        },
      });

      expect(await new SnapshotStore(fake.area).load()).toEqual({
        tabId: -1,
        docId: '',
        sentences: [{ text: 'Keep me.', lang: 'en' }],
        index: 0,
        resumeOffset: 0,
        voice: '',
        rate: 1,
        charsRead: 0,
      });
    });

    it('ignores non-finite numbers', async () => {
      fake = fakeArea({
        [SNAPSHOT_KEY]: { ...SNAPSHOT, index: Number.POSITIVE_INFINITY, charsRead: Number.NaN },
      });

      const loaded = await new SnapshotStore(fake.area).load();
      expect(loaded?.index).toBe(0);
      expect(loaded?.charsRead).toBe(0);
    });
  });
});
