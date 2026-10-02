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

  constructor({ engine, snapshots, voices }: SessionRouterDeps) {
    this.engine = engine;
    this.snapshots = snapshots;
    this.voices = voices;
  }

  /** Restore a previous session and warm the voice cache. */
  async start(): Promise<void> {
    try {
      await this.voices.refresh();
    } catch (err) {
      // If the provider has no voice selected, fail the engine immediately
      // instead of waiting for a load command.
      console.error('[SayLoud] voice refresh failed:', err);
      this.engine.reportError(err instanceof Error ? err.message : String(err));
    }

    const snapshot = await this.snapshots.load();
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

    this.unsubscribe?.();
    this.unsubscribe = this.engine.subscribe((event) => this.onEngineEvent(event));
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
    port.onMessage((message) => void this.onCommand(tabId, message));
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
      // Single session: a new document supersedes whatever was playing.
      if (this.activeTabId !== null && this.activeTabId !== tabId) this.engine.stop();
      this.activeTabId = tabId;
      this.engine.setTabId(tabId);
      // A cold cache would resolve to no voice and fail the load.
      if (this.voices.isEmpty) await this.voices.refresh();
    }

    this.engine.dispatch(message);
    this.persist();
  }

  private onEngineEvent(event: EngineEvent): void {
    const tabId = this.activeTabId;
    if (tabId !== null) this.ports.get(tabId)?.postMessage(event);
    this.persist();
  }

  private endSession(): void {
    this.engine.stop();
    this.activeTabId = null;
    this.persist();
  }

  /** Fire-and-forget: persistence must never block message routing. */
  private persist(): void {
    const snapshot: SessionSnapshot | null = this.engine.getSnapshot();
    void this.snapshots.save(snapshot).catch(() => {
      // Losing a snapshot only costs a resume position, never playback.
    });
  }
}

function isEngineCommand(message: unknown): message is EngineCommand {
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && KNOWN_COMMANDS.has(type as EngineCommand['type']);
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
