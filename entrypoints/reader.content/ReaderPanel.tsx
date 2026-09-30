/**
 * The player, in the reader's chosen language.
 *
 * The content script reads the language itself rather than being told over the
 * port: a content script has `chrome.storage`, and the language is a UI
 * preference rather than part of the reading session. Kept apart from the
 * entrypoint so the wiring is testable without a mounted content script.
 */
import { I18nProvider, useUiLanguage } from '~/lib/i18n';
import type { SettingsStore } from '~/lib/settings-store';
import { type PlayerController, SidePlayer } from './SidePlayer';

export interface ReaderPanelProps {
  controller: PlayerController;
  /** The saved preferences; the language is read from them and kept in step. */
  settings: SettingsStore;
  /** The shadow host the player is mounted in, which carries the language. */
  host: HTMLElement;
  onOpenSettings: () => void;
}

export function ReaderPanel({ controller, settings, host, onOpenSettings }: ReaderPanelProps) {
  const { lang } = useUiLanguage(settings);

  return (
    <I18nProvider lang={lang} langElement={host}>
      <SidePlayer controller={controller} onOpenSettings={onOpenSettings} />
    </I18nProvider>
  );
}
