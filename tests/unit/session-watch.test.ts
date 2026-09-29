import { describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '~/lib/protocol';
import { SessionWatch, type StorageChangeApi } from '~/lib/session-watch';
import { type SessionStorageArea, SNAPSHOT_KEY, SnapshotStore } from '~/lib/snapshot-store';

const SNAPSHOT: SessionSnapshot = {
  tabId: 3,
  docId: 'doc-1',
  sentences: [{ text: 'Hello world.', lang: 'en' }],
  index: 0,
  resumeOffset: 0,
  voice: 'Samantha',
  rate: 1,
  charsRead: 4,
};

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

/** A `storage.onChanged` that records its listeners so a test can fire them. */
function fakeChanges() {
  const listeners = new Set<(changes: Record<string, unknown>, areaName: string) => void>();
  const changes: StorageChangeApi = {
    addListener: (listener) => void listeners.add(listener),
    removeListener: (listener) => void listeners.delete(listener),
  };
  const fire = (areaName: string, keys: string[]) => {
    const payload: Record<string, unknown> = {};
    for (const key of keys) payload[key] = { newValue: undefined };
    for (const listener of listeners) listener(payload, areaName);
  };
  return { changes, fire, listenerCount: () => listeners.size };
}

describe('SessionWatch', () => {
  it('reads the snapshot the service worker published', async () => {
    const fake = fakeArea({ [SNAPSHOT_KEY]: SNAPSHOT });
    const watch = new SessionWatch(new SnapshotStore(fake.area), fakeChanges().changes);

    expect(await watch.load()).toEqual(SNAPSHOT);
  });

  it('reports no session when the snapshot is absent', async () => {
    const fake = fakeArea();
    const watch = new SessionWatch(new SnapshotStore(fake.area), fakeChanges().changes);

    expect(await watch.load()).toBeNull();
  });

  it('ignores a snapshot that fails validation', async () => {
    const fake = fakeArea({ [SNAPSHOT_KEY]: { tabId: 'three' } });
    const watch = new SessionWatch(new SnapshotStore(fake.area), fakeChanges().changes);

    expect(await watch.load()).toBeNull();
  });

  it('calls the listener when the snapshot changes', () => {
    const fake = fakeArea();
    const changeApi = fakeChanges();
    const watch = new SessionWatch(new SnapshotStore(fake.area), changeApi.changes);
    const listener = vi.fn();

    watch.subscribe(listener);
    changeApi.fire('session', [SNAPSHOT_KEY]);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores changes to other keys in the session area', () => {
    const fake = fakeArea();
    const changeApi = fakeChanges();
    const watch = new SessionWatch(new SnapshotStore(fake.area), changeApi.changes);
    const listener = vi.fn();

    watch.subscribe(listener);
    changeApi.fire('session', ['something-else']);

    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores changes in another area', () => {
    const fake = fakeArea();
    const changeApi = fakeChanges();
    const watch = new SessionWatch(new SnapshotStore(fake.area), changeApi.changes);
    const listener = vi.fn();

    watch.subscribe(listener);
    changeApi.fire('local', [SNAPSHOT_KEY]);

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops listening once unsubscribed', () => {
    const fake = fakeArea();
    const changeApi = fakeChanges();
    const watch = new SessionWatch(new SnapshotStore(fake.area), changeApi.changes);
    const listener = vi.fn();

    const unsubscribe = watch.subscribe(listener);
    unsubscribe();
    changeApi.fire('session', [SNAPSHOT_KEY]);

    expect(listener).not.toHaveBeenCalled();
    expect(changeApi.listenerCount()).toBe(0);
  });
});
