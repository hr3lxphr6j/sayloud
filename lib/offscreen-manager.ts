/**
 * Owns the offscreen document's lifetime.
 *
 * The document is created lazily, on the first command that needs it, and never
 * explicitly closed: Chrome reclaims it on its own, and `hasDocument()` is the
 * only reliable way to know whether it is there. Two callers asking at the same
 * time share one creation — `createDocument` rejects if a document already
 * exists, so a second concurrent call would fail for no reason.
 */
import {
  OFFSCREEN_PATH,
  OFFSCREEN_REASON,
  type OffscreenCommand,
  type SynthesizeReply,
} from './offscreen-protocol';

/** The slice of `chrome.offscreen` this module uses. */
export interface OffscreenApi {
  hasDocument(): Promise<boolean>;
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
}

/** The slice of `chrome.runtime` this module uses. */
export interface RuntimeApi {
  sendMessage(message: unknown): Promise<unknown>;
}

export interface OffscreenManagerDeps {
  offscreen: OffscreenApi;
  runtime: RuntimeApi;
  /** Injected in tests to skip the retry wait. */
  delay?: (ms: number) => Promise<void>;
  /** How many times a command is retried while the document is starting. */
  attempts?: number;
}

/**
 * The document is created and then immediately sent a command. The listener is
 * registered as the page loads, so the first send can lose that race by a
 * millisecond; a retry is cheaper than a failed sentence.
 */
const RETRY_DELAY_MS = 50;
const DEFAULT_ATTEMPTS = 3;

export interface SendOptions {
  /**
   * Whether the document may be created to deliver this command.
   *
   * Commands that only tidy up — `stop` — pass false: creating a document in
   * order to tell it to stop playing something is absurd, and the engine calls
   * `stop` on every load even when nothing has ever played.
   */
  create?: boolean;
}

export class OffscreenManager {
  private readonly offscreen: OffscreenApi;
  private readonly runtime: RuntimeApi;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly attempts: number;
  private creating: Promise<void> | null = null;

  constructor(deps: OffscreenManagerDeps) {
    this.offscreen = deps.offscreen;
    this.runtime = deps.runtime;
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.attempts = deps.attempts ?? DEFAULT_ATTEMPTS;
  }

  /** True while a document is being created by this manager. */
  get isCreating(): boolean {
    return this.creating !== null;
  }

  /** Create the document if it is not there, and wait for it. */
  ensureReady(): Promise<void> {
    // The lock is taken synchronously, so callers that arrive in the same tick
    // share one creation and one `hasDocument` probe. `createDocument` rejects
    // if a document already exists, so a second creation is never wanted.
    if (this.creating) return this.creating;

    this.creating = this.ensure().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  private async ensure(): Promise<void> {
    if (await this.offscreen.hasDocument()) return;
    await this.create();
  }

  /**
   * Send a command to the document.
   *
   * Resolves with the reply to a `synthesize`; every other command answers with
   * nothing.
   */
  async sendCommand(
    command: OffscreenCommand,
    options: SendOptions = {}
  ): Promise<SynthesizeReply | undefined> {
    if (options.create === false) {
      if (!(await this.offscreen.hasDocument())) return undefined;
    } else {
      await this.ensureReady();
    }

    return this.send(command);
  }

  private async create(): Promise<void> {
    await this.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [OFFSCREEN_REASON],
      justification: 'Synthesize and play cloud text-to-speech audio',
    });
  }

  private async send(command: OffscreenCommand): Promise<SynthesizeReply | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        return toReply(await this.runtime.sendMessage(command));
      } catch (error) {
        if (attempt >= this.attempts || !isMissingReceiver(error)) throw error;
        await this.delay(RETRY_DELAY_MS);
      }
    }
  }
}

/**
 * True for the error Chrome throws when a message has no listener yet.
 *
 * There is no error code to test, only this message, and the message is not
 * localised. Exported because sending anything to the offscreen document has
 * to recognise it: a document that is not running is not a delivery failure.
 */
export function isMissingReceiver(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /receiving end does not exist|could not establish connection/i.test(error.message);
}

/**
 * Send a message only a live offscreen document can care about.
 *
 * Resolves both when it was delivered and when there was nothing to deliver it
 * to, because a document Chrome has already reclaimed is the normal case rather
 * than a failure. Nothing is created to receive it either: this is for keeping
 * up with a document that is already running, not for starting one.
 */
export async function sendToOffscreen(runtime: RuntimeApi, message: unknown): Promise<void> {
  try {
    await runtime.sendMessage(message);
  } catch (error) {
    if (!isMissingReceiver(error)) {
      console.warn('[SayLoud] the offscreen document could not be reached', error);
    }
  }
}

/**
 * A reply, or undefined.
 *
 * The offscreen document is another context: whatever answers is untrusted, and
 * a reply of the wrong shape must not be handed to the speaker.
 */
function toReply(value: unknown): SynthesizeReply | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const reply = value as { durationMs?: unknown; hasTimings?: unknown };
  if (typeof reply.durationMs !== 'number' || !Number.isFinite(reply.durationMs)) return undefined;
  if (typeof reply.hasTimings !== 'boolean') return undefined;
  return { durationMs: reply.durationMs, hasTimings: reply.hasTimings };
}
