/**
 * A `Phonemizer` that returns fixed IPA, so no test needs real wasm.
 *
 * Two uses: the unit tests of everything *around* phonemization (the engine,
 * the worker protocol, the provider adapter), and the e2e build, which has to
 * run the whole chain without downloading a model or loading espeak.
 */
import type { Phonemizer } from './types';

export interface FakePhonemizerOptions {
  /** What every call returns. Defaults to a short, plausible IPA string. */
  ipa?: string;
  /**
   * Return the input text unchanged instead of `ipa`.
   *
   * For a test that asserts which text reached the phonemizer, where any
   * transformation would hide the thing under test.
   */
  echo?: boolean;
  /**
   * Reject when the input contains this substring.
   *
   * Lets a test drive the "phonemization failed" path — which must surface as a
   * provider error, not as silence — without a real engine.
   */
  failOn?: string;
}

/** Every call the fake received, in order. */
export interface PhonemizeCall {
  readonly text: string;
  readonly lang: string;
}

export class FakePhonemizer implements Phonemizer {
  readonly calls: PhonemizeCall[] = [];
  private readonly ipa: string;
  private readonly echo: boolean;
  private readonly failOn: string | undefined;

  constructor(options: FakePhonemizerOptions = {}) {
    this.ipa = options.ipa ?? 'fəˈnɛm';
    this.echo = options.echo ?? false;
    this.failOn = options.failOn;
  }

  async phonemize(text: string, lang: string): Promise<string> {
    this.calls.push({ text, lang });
    if (this.failOn !== undefined && text.includes(this.failOn)) {
      throw new Error(`FakePhonemizer was told to fail on ${JSON.stringify(this.failOn)}`);
    }
    return this.echo ? text : this.ipa;
  }
}
