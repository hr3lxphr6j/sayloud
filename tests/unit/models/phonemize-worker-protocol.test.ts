/**
 * The phonemize worker's channel, from the side that has to trust it.
 *
 * A worker's `message` event is not a trusted boundary, and a worker left over
 * from a previous version of the extension is a real possibility — so both
 * directions are validated, and this is what says which messages survive. The
 * `error` reply is the other half: it carries the provider code the engine
 * above switches on, so a code that did not arrive would turn "the voice cannot
 * speak this language" into "something went wrong".
 */
import { describe, expect, it } from 'vitest';
import { DictionaryLoadError } from '~/lib/models/phonemize-dict';
import {
  isPhonemizeWorkerReply,
  isPhonemizeWorkerRequest,
  phonemizeErrorCode,
} from '~/lib/models/phonemize-worker-protocol';

describe('isPhonemizeWorkerRequest', () => {
  it('accepts every request the coordinator sends', () => {
    expect(isPhonemizeWorkerRequest({ type: 'init', id: 1 })).toBe(true);
    expect(
      isPhonemizeWorkerRequest({ type: 'prepare', id: 2, frontend: 'kokoro-v1', lang: 'ja-JP' })
    ).toBe(true);
    expect(
      isPhonemizeWorkerRequest({
        type: 'phonemize',
        id: 3,
        text: '経営',
        frontend: 'kokoro-v11-zh',
        lang: 'zh-CN',
      })
    ).toBe(true);
    expect(isPhonemizeWorkerRequest({ type: 'dispose' })).toBe(true);
  });

  it('refuses a message from a version that no longer exists', () => {
    expect(isPhonemizeWorkerRequest({ type: 'phonemise', id: 1, text: 'a' })).toBe(false);
    expect(isPhonemizeWorkerRequest({ type: 'init' })).toBe(false);
    expect(isPhonemizeWorkerRequest(null)).toBe(false);
    expect(isPhonemizeWorkerRequest('init')).toBe(false);
  });

  it('refuses an id that could never match a reply', () => {
    // Zero and negatives are what an off-by-one in an id counter looks like,
    // and a request carrying one would wait forever.
    expect(isPhonemizeWorkerRequest({ type: 'init', id: 0 })).toBe(false);
    expect(isPhonemizeWorkerRequest({ type: 'init', id: -1 })).toBe(false);
    expect(isPhonemizeWorkerRequest({ type: 'init', id: 1.5 })).toBe(false);
    expect(isPhonemizeWorkerRequest({ type: 'init', id: '1' })).toBe(false);
  });

  it('refuses a frontend this build does not know', () => {
    // The wasm would reject it, but not before the request crossed a thread
    // boundary and a worker went looking for a dictionary that cannot exist.
    expect(
      isPhonemizeWorkerRequest({ type: 'prepare', id: 1, frontend: 'kokoro-v2', lang: 'en-US' })
    ).toBe(false);
    expect(
      isPhonemizeWorkerRequest({
        type: 'phonemize',
        id: 1,
        text: 'a',
        frontend: undefined,
        lang: 'en-US',
      })
    ).toBe(false);
  });

  it('requires the text a phonemize request is about', () => {
    expect(
      isPhonemizeWorkerRequest({ type: 'phonemize', id: 1, frontend: 'kokoro-v1', lang: 'en-US' })
    ).toBe(false);
    expect(
      isPhonemizeWorkerRequest({
        type: 'phonemize',
        id: 1,
        text: 7,
        frontend: 'kokoro-v1',
        lang: 'en-US',
      })
    ).toBe(false);
  });
});

describe('isPhonemizeWorkerReply', () => {
  it('accepts every reply the worker sends', () => {
    expect(isPhonemizeWorkerReply({ type: 'ready', id: 1 })).toBe(true);
    expect(isPhonemizeWorkerReply({ type: 'prepared', id: 1 })).toBe(true);
    expect(isPhonemizeWorkerReply({ type: 'phonemized', id: 1, phonemes: 'həlˈoʊ' })).toBe(true);
    expect(
      isPhonemizeWorkerReply({ type: 'phonemized', id: 1, phonemes: '', warnings: ['dropped'] })
    ).toBe(true);
    expect(isPhonemizeWorkerReply({ type: 'error', id: 1, code: 'unknown', message: 'boom' })).toBe(
      true
    );
  });

  it('refuses a reply that is missing what the caller reads', () => {
    expect(isPhonemizeWorkerReply({ type: 'phonemized', id: 1 })).toBe(false);
    expect(isPhonemizeWorkerReply({ type: 'phonemized', id: 1, phonemes: 7 })).toBe(false);
    expect(
      isPhonemizeWorkerReply({ type: 'phonemized', id: 1, phonemes: 'a', warnings: 'no' })
    ).toBe(false);
    expect(isPhonemizeWorkerReply({ type: 'error', id: 1, message: 'boom' })).toBe(false);
    expect(isPhonemizeWorkerReply({ type: 'ready' })).toBe(false);
  });
});

/**
 * Which code a failure travels as.
 *
 * The code is the part the panel turns into a sentence and the part a caller
 * switches on, so a dictionary failure reported as `unknown` would throw away
 * the only actionable half of it.
 */
describe('phonemizeErrorCode', () => {
  it('reports a voice that cannot speak the language as a voice mismatch', () => {
    // The one failure here a user can fix by picking something else, which is
    // why it is the one that gets a code of its own (P6 spec §2.2, §8.1).
    expect(phonemizeErrorCode(new DictionaryLoadError('unsupported-language', 'no ja here'))).toBe(
      'voice-mismatch'
    );
  });

  it('reports the extension\\u2019s own files failing to load as a load failure', () => {
    for (const reason of [
      'network',
      'status',
      'dictionary-format',
      'dictionary-decompress',
      'unknown-dictionary',
      'missing-dictionaries',
      'unknown-frontend',
    ] as const) {
      expect(phonemizeErrorCode(new DictionaryLoadError(reason, 'nope'))).toBe('model-load-failed');
    }
  });

  it('falls back to unknown for anything else', () => {
    expect(phonemizeErrorCode(new Error('boom'))).toBe('unknown');
    expect(phonemizeErrorCode('boom')).toBe('unknown');
    expect(phonemizeErrorCode(undefined)).toBe('unknown');
  });
});
