import { describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '~/lib/protocol';
import { SessionWatch, type StorageChangeApi } from '~/lib/session-watch';
import { type SessionStorageArea, SNAPSHOT_KEY, SnapshotStore } from '~/lib/snapshot-store';

const SNAPSHOT: SessionSnapshot = {
  tabId: 3,
  docId: 'doc-1',
  sentenceCount: 1,
  charsTotal: 12, // 'Hello world.'
  index: 0,
  resumeOffset: 0,
  voice: 'Samantha',
  rate: 1,
  charsRead: 4,
  resumeTimeMs: 0,
};

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
    const fakeSession = fakeArea({ [SNAPSHOT_KEY]: SNAPSHOT });
    const fakeLocal = fakeArea();
    const watch = new SessionWatch(
      new SnapshotStore(fakeSession.area, fakeLocal.area),
      fakeChanges().changes
    );

    expect(await watch.load()).toEqual(SNAPSHOT);
  });

  it('reports no session when the snapshot is absent', async () => {
    const fakeSession = fakeArea();
    const fakeLocal = fakeArea();
    const watch = new SessionWatch(
      new SnapshotStore(fakeSession.area, fakeLocal.area),
      fakeChanges().changes
    );

    expect(await watch.load()).toBeNull();
  });

  it('ignores a snapshot that fails validation', async () => {
    const fakeSession = fakeArea({ [SNAPSHOT_KEY]: { tabId: 'three' } });
    const fakeLocal = fakeArea();
    const watch = new SessionWatch(
      new SnapshotStore(fakeSession.area, fakeLocal.area),
      fakeChanges().changes
    );

    expect(await watch.load()).toBeNull();
  });

  it('calls the listener when the snapshot changes', () => {
    const fakeSession = fakeArea();
    const fakeLocal = fakeArea();
    const changeApi = fakeChanges();
    const watch = new SessionWatch(
      new SnapshotStore(fakeSession.area, fakeLocal.area),
      changeApi.changes
    );
    const listener = vi.fn();

    watch.subscribe(listener);
    changeApi.fire('session', [SNAPSHOT_KEY]);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores changes to other keys in the session area', () => {
    const fakeSession = fakeArea();
    const fakeLocal = fakeArea();
    const changeApi = fakeChanges();
    const watch = new SessionWatch(
      new SnapshotStore(fakeSession.area, fakeLocal.area),
      changeApi.changes
    );
    const listener = vi.fn();

    watch.subscribe(listener);
    changeApi.fire('session', ['something-else']);

    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores changes in another area', () => {
    const fakeSession = fakeArea();
    const fakeLocal = fakeArea();
    const changeApi = fakeChanges();
    const watch = new SessionWatch(
      new SnapshotStore(fakeSession.area, fakeLocal.area),
      changeApi.changes
    );
    const listener = vi.fn();

    watch.subscribe(listener);
    changeApi.fire('local', [SNAPSHOT_KEY]);

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops listening once unsubscribed', () => {
    const fakeSession = fakeArea();
    const fakeLocal = fakeArea();
    const changeApi = fakeChanges();
    const watch = new SessionWatch(
      new SnapshotStore(fakeSession.area, fakeLocal.area),
      changeApi.changes
    );
    const listener = vi.fn();

    const unsubscribe = watch.subscribe(listener);
    unsubscribe();
    changeApi.fire('session', [SNAPSHOT_KEY]);

    expect(listener).not.toHaveBeenCalled();
    expect(changeApi.listenerCount()).toBe(0);
  });
});
