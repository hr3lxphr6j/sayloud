/**
 * The message catalogue and the little machinery around it.
 *
 * Not `chrome.i18n`: `getMessage` can only follow the browser's own UI
 * language, and the settings offer a manual choice that has to take effect
 * while the extension is running. A dictionary plus one function is smaller
 * than the workaround would be, and it is type-checked and unit-testable.
 *
 * Non-component code never imports a translator singleton — it returns keys and
 * parameters, or takes a `Translator` as an argument (see
 * `lib/providers/errors.ts`), so nothing has to be mocked to test it.
 */
import { type ComponentChildren, createContext } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS, type SettingsStore, type UiLang } from '../settings-store';
import { en, type MessageKey } from './messages.en';
import { zh } from './messages.zh';

/** The two languages SayLoud ships. */
export type Lang = 'en' | 'zh-CN';

/** What a message's `{placeholders}` can be filled with. */
export type MessageParams = Record<string, string | number>;

/** Renders a message key in one language. */
export type Translator = (key: MessageKey, params?: MessageParams) => string;

export type { MessageKey };

const CATALOGUES: Record<Lang, Record<MessageKey, string>> = { en, 'zh-CN': zh };

/**
 * The language to render in.
 *
 * `auto` means "whatever the browser is set to", and is the only case where the
 * browser is consulted at all: an explicit choice wins over it, so switching to
 * English on a Chinese machine sticks.
 */
export function resolveLang(setting: UiLang, browserLang: string): Lang {
  if (setting !== 'auto') return setting;
  return browserLang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** A translator for one language. Pure, so it can be passed into anything. */
export function createTranslator(lang: Lang): Translator {
  const catalogue = CATALOGUES[lang];

  return (key, params) => {
    const template = catalogue[key];
    if (params === undefined) return template;

    // A placeholder with no value is left as written rather than throwing: a
    // missing parameter is a bug in our own call site, and the reader should
    // still see the rest of the sentence.
    return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : placeholder
    );
  };
}

const LanguageContext = createContext<Lang>('en');

export interface I18nProviderProps {
  lang: Lang;
  children: ComponentChildren;
}

/**
 * Renders its children in one language.
 *
 * The context's own default is English, so a component rendered without a
 * provider — every unit test written before i18n existed — keeps the English
 * copy it asserts on, and no component is ever left without a language.
 */
export function I18nProvider({ lang, children }: I18nProviderProps) {
  useEffect(() => {
    // Screen readers and the browser's own spellchecking read this.
    document.documentElement.lang = lang;
  }, [lang]);

  return <LanguageContext.Provider value={lang}>{children}</LanguageContext.Provider>;
}

/** The translator for the nearest provider's language. */
export function useT(): Translator {
  const lang = useContext(LanguageContext);
  return useMemo(() => createTranslator(lang), [lang]);
}

export interface UiLanguage {
  /** The saved preference, which is what the settings row shows. */
  uiLang: UiLang;
  /** The language actually being rendered. */
  lang: Lang;
  /** Saves a new preference; the UI re-renders before storage answers. */
  setUiLang: (next: UiLang) => void;
}

/**
 * The UI language, read from the settings when there is a store.
 *
 * Both the side panel and the content script need this, and neither keeps the
 * settings in state: the store is the one copy, and `storage.onChanged` is what
 * keeps two contexts in step. Without a store — tests, and any context built
 * without one — the documented defaults apply, which resolves to English.
 */
export function useUiLanguage(settings?: SettingsStore): UiLanguage {
  const [uiLang, setStored] = useState<UiLang>(DEFAULT_SETTINGS.uiLang);

  useEffect(() => {
    if (!settings) return;
    let active = true;

    settings
      .load()
      .then((loaded) => {
        if (active) setStored(loaded.uiLang);
      })
      .catch((error: unknown) => {
        console.error('[SayLoud] cannot read the saved settings', error);
      });

    const unsubscribe = settings.subscribe((loaded) => setStored(loaded.uiLang));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [settings]);

  const setUiLang = useCallback(
    (next: UiLang) => {
      // Applied locally as well as in storage: a write only comes back through
      // `onChanged`, and a store built without that API would never re-render.
      setStored(next);
      void settings?.update({ uiLang: next }).catch((error: unknown) => {
        console.error('[SayLoud] cannot save the interface language', error);
      });
    },
    [settings]
  );

  return { uiLang, lang: resolveLang(uiLang, navigator.language), setUiLang };
}
