import type { PlaybackEngine } from './playback-engine';
import type { EngineCommand, EngineEvent, SessionSnapshot } from './protocol';
import type { SnapshotStore } from './snapshot-store';
import type { VoiceCache } from './voice-cache';

/** The slice of `chrome.runtime.Port` the router needs. */
export interface RouterPort {
  senderTabId?: number;
  postMessage(message: EngineEvent): void;
  onMessage(handler: (message: unknown) => void): void;
  onDisconnect(handler: () => void): void;
}

export interface SessionRouterDeps {
  engine: PlaybackEngine;
  snapshots: SnapshotStore;
  voices: VoiceCache;
}

/**
 * Routes messages between content scripts and the single playback session.
 *
 * There is one session at a time: starting playback in another tab stops the
 * running one. Engine events go back only to the owning tab's port, and every
 * state change is mirrored into `storage.session` so a recycled service worker
 * can resume.
 */
export class SessionRouter {
  private readonly engine: PlaybackEngine;
  private readonly snapshots: SnapshotStore;
  private readonly voices: VoiceCache;
  private readonly ports = new Map<number, RouterPort>();
  private activeTabId: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private sessionVersion = 0;

  constructor({ engine, snapshots, voices }: SessionRouterDeps) {
    this.engine = engine;
    this.snapshots = snapshots;
    this.voices = voices;
  }

  /** Restore a previous session and warm the voice cache. */
  async start(): Promise<void> {
    const version = this.sessionVersion;
    // Subscribe before the first await. A reader reconnects ~250ms after its
    // port died with the old worker — while this method is still waiting on the
    // voice list — and its `sync` is the only thing that can rebuild a session
    // the worker lost. An event emitted into an unsubscribed engine is gone for
    // good: the reader believes it already sent its sentences, so it never asks
    // again, and pressing play does nothing at all.
    this.unsubscribe?.();
    this.unsubscribe = this.engine.subscribe((event) => this.onEngineEvent(event));

    try {
      await this.voices.refresh();
    } catch (err) {
      // If the provider has no voice selected, fail the engine immediately
      // instead of waiting for a load command.
      console.error('[SayLoud] voice refresh failed:', err);
      this.engine.reportError(err instanceof Error ? err.message : String(err));
    }

    // A reader may have rebuilt the session while this was still awaiting: its
    // `sync` was answered with `session-lost`, it sent its sentences, and they
    // are in the engine right now. Restoring a snapshot that carries no
    // sentences over that would drop them — a recovery that undoes itself.
    if (version !== this.sessionVersion || this.activeTabId !== null || this.hasSession()) return;

    const snapshot = await this.snapshots.load();
    // A command may have claimed the session while storage was being read.
    // Never let the stale snapshot overwrite that newer session.
    if (version !== this.sessionVersion || this.activeTabId !== null || this.hasSession()) return;
    if (snapshot && snapshot.tabId >= 0) {
      this.activeTabId = snapshot.tabId;
      this.engine.setTabId(snapshot.tabId);
      this.engine.restore(snapshot);
    } else {
      // Worth saying out loud. With no session here, the first `sync` from a
      // reader that already sent its sentences reaches an engine with nothing
      // to answer with — and the reader has no way to know that, so it waits.
      // The two numbers are what tell the causes apart: a snapshot that was
      // never written, versus one whose tab id was never set.
      console.warn('[SayLoud] no session to restore', {
        found: snapshot !== null,
        tabId: snapshot?.tabId ?? null,
        sentenceCount: snapshot?.sentenceCount ?? 0,
      });
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ports.clear();
  }

  handlePort(port: RouterPort): void {
    const tabId = port.senderTabId;
    if (tabId === undefined) return;

    this.ports.set(tabId, port);
    port.onMessage((message) => {
      if (this.ports.get(tabId) !== port) return;
      void this.onCommand(tabId, message).catch((error: unknown) => {
        console.error('[SayLoud] command failed', error);
      });
    });
    port.onDisconnect(() => {
      // Only forget the port if it is still the one registered for this tab.
      if (this.ports.get(tabId) === port) this.ports.delete(tabId);
    });
  }

  handleTabRemoved(tabId: number): void {
    this.ports.delete(tabId);
    if (this.activeTabId === tabId) this.endSession();
  }

  /** A navigation in the owning tab means the extracted document is gone. */
  handleTabUpdated(tabId: number, changeInfo: { url?: string }): void {
    if (!changeInfo.url) return;
    if (this.activeTabId === tabId) this.endSession();
  }

  /**
   * Only one tab plays at a time, so leaving the playing tab pauses it.
   *
   * `continueInBackground` is the user's choice to be read to while looking at
   * something else. It gates the pause and nothing else: the single-session
   * rule still holds — starting playback in another tab stops this one — and a
   * closed or navigated tab still ends the session.
   */
  handleTabActivated(tabId: number, continueInBackground = false): void {
    if (continueInBackground) return;
    if (this.activeTabId === null || this.activeTabId === tabId) return;
    if (this.engine.getStatus().phase === 'idle') return;
    this.engine.pause();
    this.persist();
  }

  private async onCommand(tabId: number, message: unknown): Promise<void> {
    if (!isEngineCommand(message)) return;

    if (message.type === 'load') {
      const version = ++this.sessionVersion;
      // Single session: a new document supersedes whatever was playing.
      if (this.activeTabId !== null && this.activeTabId !== tabId) this.engine.stop();
      this.activeTabId = tabId;
      this.engine.setTabId(tabId);
      // A cold cache would resolve to no voice and fail the load.
      if (this.voices.isEmpty) await this.voices.refresh();
      if (version !== this.sessionVersion) return;
    } else if (message.type === 'sync' && this.activeTabId === null) {
      this.sessionVersion++;
      // A reader reconnecting to a worker that lost its session is the only
      // thing that can rebuild it, so this sync claims the session. Without it
      // the `session-lost` the engine is about to answer with has no tab to go
      // to, and the reader waits for an answer that was thrown away.
      this.activeTabId = tabId;
      this.engine.setTabId(tabId);
    }

    // A tab other than the owner may observe the session, but cannot control
    // or clear it. A load above is the explicit operation that transfers
    // ownership.
    if (this.activeTabId !== tabId) return;
    if (message.type === 'stop') this.sessionVersion++;

    try {
      this.engine.dispatch(message);
    } catch (error) {
      console.error('[SayLoud] command failed:', error);
      return;
    }
    this.persist();
  }

  private onEngineEvent(event: EngineEvent): void {
    const tabId = this.activeTabId;
    if (tabId !== null) this.ports.get(tabId)?.postMessage(event);
    this.persist();
  }

  private endSession(): void {
    this.sessionVersion++;
    this.engine.stop();
    this.activeTabId = null;
    this.persist();
  }

  /** Fire-and-forget: persistence must never block message routing. */
  private persist(): void {
    const snapshot: SessionSnapshot | null = this.engine.getSnapshot();
    // A null snapshot means "nothing to save", which is also what forgetting a
    // session looks like. Only an idle engine justifies forgetting: a paused
    // one without sentences is waiting for its reader to send them back, and
    // the stored snapshot is the only record of where that session was.
    if (snapshot === null && this.engine.getStatus().phase !== 'idle') return;
    void this.snapshots.save(snapshot).catch(() => {
      // Losing a snapshot only costs a resume position, never playback.
    });
  }

  /** Whether the engine is already holding a session worth keeping. */
  private hasSession(): boolean {
    return this.engine.getStatus().total > 0;
  }
}

function isEngineCommand(message: unknown): message is EngineCommand {
  if (!message || typeof message !== 'object') return false;
  const command = message as Record<string, unknown>;
  const type = command.type;
  if (typeof type !== 'string' || !KNOWN_COMMANDS.has(type as EngineCommand['type'])) return false;
  const finiteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  switch (type) {
    case 'load':
      return (
        Array.isArray(command.sentences) &&
        command.sentences.every(
          (sentence) =>
            !!sentence &&
            typeof sentence === 'object' &&
            typeof (sentence as Record<string, unknown>).text === 'string' &&
            typeof (sentence as Record<string, unknown>).lang === 'string'
        ) &&
        finiteNumber(command.startIndex) &&
        finiteNumber(command.rate) &&
        (command.resume === undefined || typeof command.resume === 'boolean')
      );
    case 'seek':
      return finiteNumber(command.index);
    case 'setRate':
      return finiteNumber(command.rate);
    case 'sync':
      return typeof command.docId === 'string';
    default:
      return true;
  }
}

const KNOWN_COMMANDS = new Set<EngineCommand['type']>([
  'load',
  'play',
  'pause',
  'toggle',
  'next',
  'prev',
  'seek',
  'setRate',
  'stop',
  'sync',
]);
