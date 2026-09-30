/**
 * The settings page.
 *
 * Same panel as the side panel, mounted as a full page. It exists for two
 * reasons: `sidePanel.open()` needs a live user gesture and the reader's gear
 * falls back here when that gesture has expired, and `chrome://extensions`
 * offers an "Extension options" entry point that users reach for on its own.
 *
 * The panel is deliberately the same component, not a second settings UI, so
 * the two can never disagree about which fields a provider has.
 */
import { render } from 'preact';
import { browser } from 'wxt/browser';
import { ConfigStore } from '~/lib/config-store';
import { createProviders } from '~/lib/providers/registry';
import { SessionWatch } from '~/lib/session-watch';
import { SettingsStore } from '~/lib/settings-store';
import { SnapshotStore } from '~/lib/snapshot-store';
import { SidePanel } from '../sidepanel/SidePanel';
import '../sidepanel/styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('the options root element is missing');

render(
  <SidePanel
    store={new ConfigStore(browser.storage.local)}
    providers={createProviders()}
    permissions={browser.permissions}
    settings={new SettingsStore(browser.storage.local, browser.storage.onChanged)}
    session={
      new SessionWatch(new SnapshotStore(browser.storage.session), browser.storage.onChanged)
    }
  />,
  root
);
