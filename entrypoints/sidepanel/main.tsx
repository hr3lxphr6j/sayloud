/**
 * Side panel entry point.
 *
 * The one place concrete implementations are built, mirroring `createApp` in
 * the service worker: the components take narrow interfaces, so they stay
 * callable with plain fakes and the panel holds no browser globals of its own.
 */
import { render } from 'preact';
import { browser } from 'wxt/browser';
import { clearCache, readCacheUsage } from '~/lib/cache-admin';
import { ConfigStore } from '~/lib/config-store';
import { probeDevice } from '~/lib/models/device';
import { ModelStore } from '~/lib/models/store';
import { createProviders } from '~/lib/providers/registry';
import { SessionWatch } from '~/lib/session-watch';
import { SettingsStore } from '~/lib/settings-store';
import { SnapshotStore } from '~/lib/snapshot-store';
import { SidePanel } from './SidePanel';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('the side panel root element is missing');

render(
  <SidePanel
    store={new ConfigStore(browser.storage.local)}
    providers={createProviders()}
    permissions={browser.permissions}
    settings={new SettingsStore(browser.storage.local, browser.storage.onChanged)}
    cache={{
      readUsage: () => readCacheUsage(),
      // The broadcast to a live offscreen document happens in `clearCache`.
      clear: () => clearCache(browser.runtime),
    }}
    version={browser.runtime.getManifest().version}
    models={{
      // The model tab downloads and deletes; it never runs the model, so this
      // is the only on-device collaborator the panel is given.
      store: new ModelStore({ storage: browser.storage.local }),
      probe: () => probeDevice(navigator.gpu),
    }}
    session={
      new SessionWatch(new SnapshotStore(browser.storage.session), browser.storage.onChanged)
    }
  />,
  root
);
