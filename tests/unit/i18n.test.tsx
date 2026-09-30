import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import type { LocalStorageArea } from '~/lib/config-store';
import { createTranslator, I18nProvider, resolveLang, useT, useUiLanguage } from '~/lib/i18n';
import { en, type MessageKey } from '~/lib/i18n/messages.en';
import { zh } from '~/lib/i18n/messages.zh';
import { SETTINGS_KEY, SettingsStore, type StorageChangeApi } from '~/lib/settings-store';

/** Every `{name}` in a message, so a translation cannot drop one. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
}

describe('the message catalogues', () => {
  const keys = Object.keys(en) as MessageKey[];

  it('translates every English key', () => {
    // The `Record<MessageKey, string>` type on `zh` catches a missing key at
    // typecheck time; this catches one that was added as an empty string.
    for (const key of keys) expect(zh[key], key).toBeTruthy();
  });

  it('holds no key the English catalogue does not', () => {
    expect(Object.keys(zh).sort()).toEqual([...keys].sort());
  });

  it('leaves no message empty in either language', () => {
    for (const [key, value] of [...Object.entries(en), ...Object.entries(zh)]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('keeps the placeholders of a message in both languages', () => {
    // A translation that drops `{name}` silently prints half a sentence.
    for (const key of keys) expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
  });
});

describe('resolveLang', () => {
  it('uses the saved choice when there is one', () => {
    expect(resolveLang('en', 'zh-CN')).toBe('en');
    expect(resolveLang('zh-CN', 'en-US')).toBe('zh-CN');
  });

  it('follows the browser for auto', () => {
    expect(resolveLang('auto', 'zh')).toBe('zh-CN');
    expect(resolveLang('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveLang('auto', 'zh-TW')).toBe('zh-CN');
    expect(resolveLang('auto', 'ZH-cn')).toBe('zh-CN');
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
