import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import type { LocalStorageArea } from '~/lib/config-store';
import { createTranslator, I18nProvider, resolveLang, useT, useUiLanguage } from '~/lib/i18n';
import { en, type MessageKey } from '~/lib/i18n/messages.en';
import { ja } from '~/lib/i18n/messages.ja';
import { zh } from '~/lib/i18n/messages.zh';
import { SETTINGS_KEY, SettingsStore, type StorageChangeApi } from '~/lib/settings-store';

/** Every "{name}" in a message, so a translation cannot drop one. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
}

/**
 * Every catalogue that is not the English source, named for the failure.
 *
 * "SayLoud" is a product, not an English word, and it appears in the Chinese
 * copy unchanged. Two, not zero: a registry so the tests below can be written
 * once rather than per language.
 */
const TRANSLATIONS = [
  ['zh', zh],
  ['ja', ja],
] as const;

/**
 * Kana, Han or full-width punctuation: anything that cannot be in English.
 *
 * Used to catch prose that was copied from the English catalogue and never
 * translated.
 */
const NON_LATIN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

/**
 * Words that only occur in English *prose*, never in a product name or a
 * technical string.
 *
 * The catalogue is full of the latter — `WebGPU`, `MP3 16 kHz 32 kbit/s`,
 * `Kokoro 82M`, `Hugging Face` — and every one of them is meant to read the
 * same in all three languages. Counting words cannot tell those from a
 * sentence (`MP3 16 kHz 32 kbit/s` is five), but a function word can: `No voice
 * selected` and `Follow the browser` have one and the technical strings have
 * none.
 */
const ENGLISH_PROSE =
  /\b(?:the|a|an|is|are|was|be|been|to|of|in|on|at|for|with|and|or|not|no|this|that|these|those|your|you|it|its|will|can|cannot|has|have|do|does|when|while|than|then|as|by|from|into|over|out|up|down|more|less|all|any|some|each|every|other|another)\b/i;

describe('the message catalogues', () => {
  const keys = Object.keys(en) as MessageKey[];

  it('translates every English key', () => {
    // The `Record<MessageKey, string>` type on each catalogue catches a missing
    // key at typecheck time; this catches one that was added as an empty string.
    for (const [name, catalogue] of TRANSLATIONS) {
      for (const key of keys) expect(catalogue[key], `${name}: ${key}`).toBeTruthy();
    }
  });

  it('holds no key the English catalogue does not', () => {
    for (const [name, catalogue] of TRANSLATIONS) {
      expect(Object.keys(catalogue).sort(), name).toEqual([...keys].sort());
    }
  });

  it('leaves no message empty in any language', () => {
    for (const [name, catalogue] of [['en', en], ...TRANSLATIONS] as const) {
      for (const [key, value] of Object.entries(catalogue)) {
        expect(value.trim(), `${name}: ${key}`).not.toBe('');
      }
    }
  });

  it('keeps the placeholders of a message in every language', () => {
    // A translation that drops `{name}` silently prints half a sentence.
    for (const [name, catalogue] of TRANSLATIONS) {
      for (const key of keys) {
        expect(placeholders(catalogue[key]), `${name}: ${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it('does not leave English prose untranslated', () => {
    // The checks above cannot see the likeliest mistake of all: a message
    // copied from English and never touched is a non-empty string with the
    // right placeholders in the right number. This is about prose, so the
    // product names and technical strings — which are meant to stay as they are
    // — are not asked for kana or kanji.
    for (const [name, catalogue] of TRANSLATIONS) {
      for (const key of keys) {
        if (!ENGLISH_PROSE.test(en[key])) continue;
        expect(NON_LATIN.test(catalogue[key]), `${name}: ${key} = ${catalogue[key]}`).toBe(true);
      }
    }
  });
});

describe('resolveLang', () => {
  it('uses the saved choice when there is one', () => {
    expect(resolveLang('en', 'zh-CN')).toBe('en');
    expect(resolveLang('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveLang('ja', 'en-US')).toBe('ja');
  });

  it('follows the browser for auto', () => {
    expect(resolveLang('auto', 'zh')).toBe('zh-CN');
    expect(resolveLang('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveLang('auto', 'zh-TW')).toBe('zh-CN');
    expect(resolveLang('auto', 'ZH-cn')).toBe('zh-CN');
  });

  it('resolves a region-less or regional Japanese tag alike', () => {
    expect(resolveLang('auto', 'ja')).toBe('ja');
    expect(resolveLang('auto', 'ja-JP')).toBe('ja');
    // Chrome reports `ja` for most Japanese installs, but not all of them.
    expect(resolveLang('auto', 'JA-jp')).toBe('ja');
  });

  it('prefers a region over a language it has no catalogue for', () => {
    // `zh-Hant` is Traditional, which the Simplified catalogue is not — but
    // falling back to English would be worse for a reader who asked for
    // Chinese of some kind. Japanese has no such split to worry about.
    expect(resolveLang('auto', 'zh-Hant-TW')).toBe('zh-CN');
    expect(resolveLang('auto', 'ja-JP-u-ca-japanese')).toBe('ja');
  });

  it('falls back to English for anything else', () => {
    expect(resolveLang('auto', 'en-US')).toBe('en');
    expect(resolveLang('auto', 'fr')).toBe('en');
    expect(resolveLang('auto', '')).toBe('en');
  });

  it('resolves to English in the test environment', () => {
    // The whole suite asserts on English copy; `auto` has to be a no-op here.
    expect(resolveLang('auto', navigator.language)).toBe('en');
  });
});

describe('createTranslator', () => {
  it('returns the message in the language it was built for', () => {
    expect(createTranslator('en')('sideplayer.play')).toBe('Play');
    expect(createTranslator('zh-CN')('sideplayer.play')).toBe('播放');
    expect(createTranslator('ja')('sideplayer.play')).toBe(ja['sideplayer.play']);
  });

  it('fills in one parameter', () => {
    expect(createTranslator('en')('error.required', { field: 'API key' })).toBe(
      'API key is required.'
    );
  });

  it('fills several parameters and accepts a number', () => {
    expect(createTranslator('en')('panel.sentence-progress', { index: 1, total: 3, rate: 1 })).toBe(
      'Sentence 1 of 3 at 1×'
    );
  });

  it('leaves a placeholder it has no value for, rather than throwing', () => {
    // A missing parameter is a bug in our own call site; a crash in the reader
    // bar would be a worse way to find out.
    expect(createTranslator('en')('error.required', { other: 'x' })).toBe('{field} is required.');
    expect(createTranslator('en')('error.required')).toBe('{field} is required.');
  });
});

function Probe() {
  const t = useT();
  return <span>{t('sideplayer.play')}</span>;
}

describe('I18nProvider', () => {
  it('renders in English when no provider is above it', () => {
    render(<Probe />);

    expect(screen.getByText('Play')).toBeTruthy();
    expect(screen.queryByText('播放')).toBeNull();
  });

  it('renders in the language the provider selected', () => {
    render(
      <I18nProvider lang="zh-CN">
        <Probe />
      </I18nProvider>
    );

    expect(screen.getByText('播放')).toBeTruthy();
  });

  it('tells the document which language it rendered in', () => {
    const { unmount } = render(
      <I18nProvider lang="zh-CN">
        <Probe />
      </I18nProvider>
    );

    expect(document.documentElement.lang).toBe('zh-CN');

    unmount();
    document.documentElement.lang = 'en';
  });

  it('tags the element it was given instead of the document', () => {
    // What the content script does: the page's `<html lang>` is not ours.
    const host = document.createElement('div');
    document.body.append(host);

    render(
      <I18nProvider lang="zh-CN" langElement={host}>
        <Probe />
      </I18nProvider>
    );

    expect(host.lang).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('en');

    host.remove();
  });

  it('switches language when the provider is re-rendered', () => {
    const { rerender } = render(
      <I18nProvider lang="en">
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByText('Play')).toBeTruthy();

    rerender(
      <I18nProvider lang="zh-CN">
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByText('播放')).toBeTruthy();
  });
});

function fakeArea(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const area: LocalStorageArea = {
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of wanted) result[key] = data.get(key);
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
  };
  return area;
}

/** A `storage.onChanged` that records its listeners so a test can fire them. */
function fakeChanges() {
  const listeners = new Set<(changes: Record<string, unknown>, areaName: string) => void>();
  const api: StorageChangeApi = {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
  };
  return {
    api,
    fire: (settings: unknown): void => {
      for (const listener of [...listeners]) {
        listener({ [SETTINGS_KEY]: { newValue: settings } }, 'local');
      }
    },
  };
}

function LanguageProbe({ settings }: { settings?: SettingsStore }) {
  const { uiLang, lang, setUiLang } = useUiLanguage(settings);
  return (
    <div>
      <span>{`${lang}:${uiLang}`}</span>
      <button type="button" onClick={() => setUiLang('zh-CN')}>
        switch
      </button>
    </div>
  );
}

describe('useUiLanguage', () => {
  it('resolves to English without a settings store', () => {
    render(<LanguageProbe />);

    expect(screen.getByText('en:auto')).toBeTruthy();
  });

  it('reads the saved choice', async () => {
    const store = new SettingsStore(fakeArea({ [SETTINGS_KEY]: { uiLang: 'zh-CN' } }));
    render(<LanguageProbe settings={store} />);

    expect(await screen.findByText('zh-CN:zh-CN')).toBeTruthy();
  });

  it('reads a saved Japanese choice', async () => {
    // `auto` never resolves to Japanese on a test machine, so a choice that was
    // made in the settings is the only way this language is reached.
    const store = new SettingsStore(fakeArea({ [SETTINGS_KEY]: { uiLang: 'ja' } }));
    render(<LanguageProbe settings={store} />);

    expect(await screen.findByText('ja:ja')).toBeTruthy();
  });

  it('saves a new choice and re-renders immediately', async () => {
    const area = fakeArea();
    const store = new SettingsStore(area);
    render(<LanguageProbe settings={store} />);
    await screen.findByText('en:auto');

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    expect(await screen.findByText('zh-CN:zh-CN')).toBeTruthy();
    await waitFor(async () => expect((await store.load()).uiLang).toBe('zh-CN'));
  });

  it('follows a change made in another context', async () => {
    // The panel and the service worker write the one storage key; `onChanged`
    // is what carries a change between them.
    const changes = fakeChanges();
    const store = new SettingsStore(fakeArea(), changes.api);
    render(<LanguageProbe settings={store} />);
    await screen.findByText('en:auto');

    act(() => changes.fire({ uiLang: 'zh-CN' }));

    expect(await screen.findByText('zh-CN:zh-CN')).toBeTruthy();
  });
});
