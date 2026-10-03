/**
 * The phonemize worker's behaviour, without the worker (P6 spec §2.4, phase 7).
 *
 * Split out for the same reason `KokoroEngine` is not inside `kokoro.worker.ts`:
 * a class buried in a worker module cannot have tests, and the two decisions
 * worth testing here are which errors are retried and which are remembered.
 * `phonemize.worker.ts` is left with the message switch.
 *
 * The instance is held rather than the promise that built it, so a failed
 * `init` leaves nothing behind: a `RustPhonemizer` whose `ready` rejected has
 * no wasm behind it, and handing the same rejection back would make the retry
 * meaningless.
 */
import { type FrontendId, type PhonemizeResult, RustPhonemizer } from './phonemize-rust';

export interface PhonemizeServiceDeps {
  /**
   * Builds the phonemizer. Injected so a test can hand it wasm bytes and a
   * dictionary source — the real constructor resolves both from URLs that only
   * exist in the extension.
   */
  readonly create?: () => RustPhonemizer;
}

export class PhonemizeService {
  private phonemizer: RustPhonemizer | null = null;

  constructor(private readonly deps: PhonemizeServiceDeps = {}) {}

  /**
   * Instantiate the wasm. Idempotent, and retried after a failure.
   *
   * Idempotent because `init` is the one message the coordinator may repeat —
   * its own handshake is not memoized on failure either, and both sides
   * forgetting the same way is what keeps a retry from paying for a second
   * instantiation of 5 MB of wasm.
   */
  async init(): Promise<void> {
    const existing = this.phonemizer;
    if (existing) {
      await existing.ready;
      return;
    }

    const created = (this.deps.create ?? (() => new RustPhonemizer()))();
    await created.ready;
    this.phonemizer = created;
  }

  /**
   * Load the dictionaries `(frontend, lang)` needs.
   *
   * Not cached here: the coordinator already keys its own `prepare` by
   * `(frontend, lang)`, and a second cache would be a second thing to
   * invalidate. The wasm keeps the dictionaries it has loaded, so a repeated
   * call costs a fetch that hits Cache Storage and a decompression that the
   * wasm skips.
   */
  async prepare(frontend: FrontendId, lang: string): Promise<void> {
    await this.require().prepare(frontend, lang);
  }

  /** Text to phonemes. Synchronous once the wasm is instantiated. */
  phonemize(text: string, frontend: FrontendId, lang: string): PhonemizeResult {
    return this.require().phonemize(text, { frontend, lang });
  }

  /**
   * Drop the instance.
   *
   * The worker is terminated straight after, which is what actually returns the
   * wasm's linear memory — wasm-bindgen frees nothing on its own. This makes
   * that ordering a fact rather than a hope, and keeps the message meaningful
   * if the coordinator ever reuses a worker instead of replacing it.
   */
  dispose(): void {
    this.phonemizer = null;
  }

  private require(): RustPhonemizer {
    if (!this.phonemizer) throw new Error('the phonemizer was not initialised');
    return this.phonemizer;
  }
}
