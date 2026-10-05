/**
 * The coordinator and the real phonemizer, with the thread boundary removed.
 *
 * `worker-engine.test.ts` proves the scheduling with fakes on both sides, and
 * `phonemize-rust.test.ts` proves the pipeline. What neither can prove is that
 * the two fit: that the vocabulary and language the coordinator decides on reach
 * the wasm, and that the phonemes that come back are what the model is handed.
 * A seam that quietly passed the wrong language would satisfy both suites and
 * read Japanese as English.
 *
 * So the phonemize side here is the **real** `PhonemizeService` over the real
 * wasm, wrapped in a worker-shaped object that speaks the same protocol as
 * `entrypoints/offscreen/phonemize.worker.ts`. The only thing missing is the
 * isolate, which is what a unit test cannot have.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DictionaryBytes } from '~/lib/models/phonemize-dict';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';
import { PhonemizeService } from '~/lib/models/phonemize-service';
import {
  type PhonemizeWorkerRequest,
  phonemizeErrorCode,
} from '~/lib/models/phonemize-worker-protocol';
import { KOKORO_82M, type ModelTier, tierById } from '~/lib/models/registry';
import {
  type LocalWorkerEvents,
  type WorkerLike,
  WorkerLocalEngine,
} from '~/lib/models/worker-engine';
import type { SynthesizePiece, WorkerRequest } from '~/lib/models/worker-protocol';
import { FakeCaches, fakeFetch } from './fakes';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const WASM = new Uint8Array(
  readFileSync(resolve(ROOT, 'lib/models/phonemize-wasm/phonemize_bg.wasm'))
);

const IPADIC_URL = '/dictionaries/lindera-ipadic-ja.bin.zst';
const JIEBA_URL = '/dictionaries/jieba-zh-dict.bin.zst';

/**
 * Every text-normalization grammar the registry can ask for.
 *
 * All three languages read their numerals through the vendored WeText engine:
 * English's pair since phase 9B, Chinese's and Japanese's since 9E. They are
 * fetched on `prepare` like any other dictionary, and — unlike IPADic or
 * jieba's word list — they are parsed by `finish_loading`, so a stand-in frame
 * would fail rather than pass quietly.
 */
const WETEXT = [
  'wetext-en-tn-tagger',
  'wetext-en-tn-verbalizer',
  'wetext-zh-tn-tagger',
  'wetext-zh-tn-verbalizer',
  'wetext-ja-tn-tagger',
  'wetext-ja-tn-verbalizer',
] as const;

/** A shipped dictionary, or null when skipping was asked for. */
function asset(name: string): DictionaryBytes | null {
  const path = resolve(ROOT, `public/dictionaries/${name}.bin.zst`);
  try {
    return new Uint8Array(readFileSync(path));
  } catch (error) {
    if (process.env.PHONEMIZE_SKIP_DICT_TESTS === '1') {
      console.warn(`SKIPPING the dictionary-backed tests: no ${path}`);
      return null;
    }
    throw new Error(`no dictionary at ${path} (${String(error)})`);
  }
}

const REAL_IPADIC = asset('lindera-ipadic-ja');
const REAL_JIEBA = asset('jieba-zh-dict');

/** Every grammar, under the same missing-is-a-failure rule. */
const REAL_WETEXT = WETEXT.map((name) => [name, asset(name)] as const);

/** Every dictionary these tests serve, so `assembled({})` is still a full set. */
function shippedDictionaries(): Record<string, DictionaryBytes> {
  const routes: Record<string, DictionaryBytes> = {};
  for (const [name, bytes] of [
    ['lindera-ipadic-ja', REAL_IPADIC],
    ['jieba-zh-dict', REAL_JIEBA],
    ...REAL_WETEXT,
  ] as const) {
    if (bytes !== null) routes[`/dictionaries/${name}.bin.zst`] = bytes;
  }
  return routes;
}

/** A `WorkerLike` that runs the real phonemizer, as the worker would. */
class PhonemizeWorkerStub implements WorkerLike {
  readonly posted: PhonemizeWorkerRequest[] = [];
  terminated = 0;

  private listener: ((event: MessageEvent) => void) | null = null;

  constructor(private readonly service: PhonemizeService) {}

  postMessage(message: unknown): void {
    const request = message as PhonemizeWorkerRequest;
    this.posted.push(request);
    void this.answer(request);
  }

  addEventListener(type: string, listener: unknown): void {
    if (type === 'message') this.listener = listener as (event: MessageEvent) => void;
  }

  removeEventListener(_type: keyof LocalWorkerEvents, listener: unknown): void {
    if (this.listener === listener) this.listener = null;
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** The message switch of `phonemize.worker.ts`, minus the isolate. */
  private async answer(request: PhonemizeWorkerRequest): Promise<void> {
    // One hop, so a reply never lands before the caller has finished posting —
    // which is the ordering a real worker cannot violate either.
    await Promise.resolve();

    if (request.type === 'dispose') {
      this.service.dispose();
      return;
    }

    try {
      switch (request.type) {
        case 'init':
          await this.service.init();
          this.reply({ type: 'ready', id: request.id });
          return;
        case 'prepare':
          await this.service.prepare(request.vocab, request.lang);
          this.reply({ type: 'prepared', id: request.id });
          return;
        default: {
          const result = this.service.phonemize(request.text, request.vocab, request.lang);
          this.reply({ type: 'phonemized', id: request.id, phonemes: result.phonemes });
        }
      }
    } catch (error) {
      this.reply({
        type: 'error',
        id: request.id,
        code: phonemizeErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private reply(message: unknown): void {
    this.listener?.({ data: message } as MessageEvent);
  }
}

/** A `WorkerLike` that stands in for the model, and remembers what it was told. */
class KokoroWorkerStub implements WorkerLike {
  readonly posted: WorkerRequest[] = [];
  /** Every piece handed over to be spoken, in order. */
  readonly pieces: SynthesizePiece[] = [];
  /** What the tokenizer is pretending to make of a string. */
  tokens: (phonemes: string) => number = () => 1;
  terminated = 0;

  private listener: ((event: MessageEvent) => void) | null = null;

  postMessage(message: unknown): void {
    const request = message as WorkerRequest;
    this.posted.push(request);
    void this.answer(request);
  }

  addEventListener(type: string, listener: unknown): void {
    if (type === 'message') this.listener = listener as (event: MessageEvent) => void;
  }

  removeEventListener(_type: keyof LocalWorkerEvents, listener: unknown): void {
    if (this.listener === listener) this.listener = null;
  }

  terminate(): void {
    this.terminated += 1;
  }

  private async answer(request: WorkerRequest): Promise<void> {
    await Promise.resolve();

    switch (request.type) {
      case 'init':
        this.reply({ type: 'ready', id: request.id });
        return;
      case 'load':
        this.reply({
          type: 'loaded',
          id: request.id,
          info: { device: 'wasm', sessionInitMs: 1 },
        });
        return;
      case 'count':
        this.reply({ type: 'counted', id: request.id, tokens: this.tokens(request.phonemes) });
        return;
      case 'synthesize':
        this.pieces.push(...request.pieces);
        this.reply({
          type: 'pcm',
          id: request.id,
          pcm: new Float32Array([0.5, -0.5]),
          sampleRate: 24_000,
        });
        return;
      default:
        return;
    }
  }

  private reply(message: unknown): void {
    this.listener?.({ data: message } as MessageEvent);
  }
}

function tierOf(id: string): ModelTier {
  const tier = tierById(KOKORO_82M, id);
  if (!tier) throw new Error(`the registry has no ${id} tier`);
  return tier;
}

/**
 * The engine, both workers, with the real phonemizer behind the seam.
 *
 * `dictionaries` is layered over the shipped set rather than replacing it, so a
 * test about Japanese does not have to remember that English now needs two
 * grammars as well — `prepare` for any language is what runs, and it asks for
 * whatever that language's table lists.
 *
 * A `null` removes a route instead, which is how "the install does not have this
 * file" is spelled now that the default is a full set.
 */
async function assembled(dictionaries: Record<string, DictionaryBytes | null>) {
  const routes: Record<string, DictionaryBytes> = { ...shippedDictionaries() };
  for (const [url, bytes] of Object.entries(dictionaries)) {
    if (bytes === null) delete routes[url];
    else routes[url] = bytes;
  }

  const fetch = fakeFetch(
    Object.fromEntries(Object.entries(routes).map(([url, bytes]) => [url, { bytes }]))
  );
  const service = new PhonemizeService({
    create: () => new RustPhonemizer({ wasm: WASM, fetch, cacheStorage: new FakeCaches() }),
  });
  const kokoro = new KokoroWorkerStub();
  const phonemizer = new PhonemizeWorkerStub(service);
  const engine = new WorkerLocalEngine({
    worker: kokoro,
    phonemizeWorker: phonemizer,
    source: { host: 'modelscope' },
  });

  await engine.load(KOKORO_82M, tierOf('fp16'), 'wasm');
  return { engine, kokoro, phonemizer };
}

describe('WorkerLocalEngine with the real phonemizer', () => {
  it('hands the model the English phonemes the pipeline produced', async () => {
    const { engine, kokoro } = await assembled({});
    const signal = new AbortController().signal;

    await engine.synthesize('hello world', 'af_heart', 'en-US', signal);

    // The exact string `en_g2p.rs` pins on the Rust side, so a change on either
    // side of the seam shows up here. Since phase 10 the model is handed IPA and
    // nothing else — see `SynthesizePiece`.
    expect(kokoro.pieces).toEqual([{ ipa: 'həlˈoʊ wˈɜːld' }]);
  });

  it.skipIf(REAL_IPADIC === null)('hands the model Japanese phonemes', async () => {
    const { engine, kokoro, phonemizer } = await assembled({
      [IPADIC_URL]: REAL_IPADIC ?? new Uint8Array(),
    });
    const signal = new AbortController().signal;

    await engine.synthesize('経営', 'jf_alpha', 'ja-JP', signal);

    // The dictionary was asked for by the *phonemize* worker, not by the model:
    // `prepare` is what makes the language usable, and nothing else loads it.
    expect(phonemizer.posted[1]).toMatchObject({ type: 'prepare', lang: 'ja-JP' });
    expect(kokoro.pieces).toEqual([{ ipa: 'keiei' }]);
  });

  it.skipIf(REAL_JIEBA === null)('hands the model Chinese phonemes', async () => {
    const { engine, kokoro } = await assembled({
      [JIEBA_URL]: REAL_JIEBA ?? new Uint8Array(),
    });
    const signal = new AbortController().signal;

    await engine.synthesize('你好', 'zf_xiaobei', 'zh-CN', signal);

    // `ni↗xau↓`: 你好 is two third tones in a row and phase 9D's tone sandhi makes
    // the first a second — *ní hǎo*. This test is about the seam between the two
    // workers and not about the reading, so all it needs from here is that the
    // string arrived; `tests/tone_sandhi.rs` is what pins it.
    expect(kokoro.pieces).toEqual([{ ipa: 'ni↗xau↓' }]);
  });

  it('keeps every character of a sentence it has to cut up', async () => {
    // Cutting is the coordinator's job, and the risk of moving it here is that
    // a piece stops describing what the one it replaced described. The sentence
    // has to survive the round trip whole, and every piece that reaches the
    // model has to have something to say — an empty IPA is a piece that plays
    // as silence.
    const { engine, kokoro, phonemizer } = await assembled({});
    kokoro.tokens = (phonemes) => (phonemes.length > 8 ? 600 : 5);
    const signal = new AbortController().signal;

    await engine.synthesize('hello world', 'af_heart', 'en-US', signal);

    // Measured whole, found too long, halved (there is no punctuation to cut
    // at), then measured again — and phonemized for real each time. The text is
    // what travels here, so this is where "every character survived the cut" is
    // asserted: the three requests are the whole sentence and its two halves.
    const asked = phonemizer.posted.filter((message) => message.type === 'phonemize');
    expect(asked.map((message) => message.text)).toEqual(['hello world', 'hello', ' world']);
    expect(
      asked
        .map((message) => message.text)
        .slice(1)
        .join('')
    ).toBe('hello world');

    // Packed back into one call, because two small pieces cost more to
    // synthesize than one — the cut exists for the paragraph, not the sentence.
    // Since phase 10 the model is handed IPA and not text, so this is as much as
    // can be said here about the join: one call, and every piece audible.
    expect(kokoro.pieces).toHaveLength(1);
    for (const piece of kokoro.pieces) expect(piece.ipa.trim()).not.toBe('');
  });

  it('reports a dictionary the install does not have as a load failure', async () => {
    // The extension's own file is missing, which is a reinstall rather than a
    // setting. `unknown` would read as "something went wrong" and throw away
    // the only actionable half — and this is the path a user takes to find out:
    // pick a Japanese voice, and the first sentence fails.
    //
    // `null` removes the route rather than serving a body, so the fake transport
    // answers exactly what a missing file does: nothing.
    const { engine } = await assembled({ [IPADIC_URL]: null });

    const error = await engine
      .synthesize('経営', 'jf_alpha', 'ja-JP', new AbortController().signal)
      .catch((thrown: unknown) => thrown);

    expect((error as Error).name).toBe('model-load-failed');
    expect((error as Error).message).toContain(IPADIC_URL);
  });
});
