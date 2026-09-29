/**
 * Reads the reading session the service worker has in flight.
 *
 * The side panel is an extension page, so it can read `storage.session` and is
 * sent its change events — which is what makes a live status readout possible
 * without opening a second message channel to the service worker. Reading is
 * all this does: playback stays the service worker's business, and a snapshot
 * is the only thing the two share.
 *
 * A snapshot can outlive its session (the worker is killed and nothing
 * reconnects), so the panel presents what it finds as the last known session
 * rather than as proof that audio is playing right now.
 */
import type { SessionSnapshot } from './protocol';
import { SNAPSHOT_KEY, type SnapshotStore } from './snapshot-store';

/** The slice of `chrome.storage.onChanged` this module needs. */
export interface StorageChangeApi {
  addListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
  removeListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
}

export class SessionWatch {
  constructor(
    private readonly snapshots: SnapshotStore,
    private readonly changes: StorageChangeApi
  ) {}

  load(): Promise<SessionSnapshot | null> {
    return this.snapshots.load();
  }

  /** Calls `listener` whenever the snapshot changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    const handler = (changes: Record<string, unknown>, areaName: string) => {
      // `session` is where the snapshot lives. The other area is the provider
      // config, which this readout does not show.
      if (areaName !== 'session' || !(SNAPSHOT_KEY in changes)) return;
      listener();
    };

    this.changes.addListener(handler);
    return () => this.changes.removeListener(handler);
  }
}
