/**
 * Side panel entry point.
 *
 * The one place concrete implementations are built, mirroring `createApp` in
 * the service worker: the components take narrow interfaces, so they stay
 * callable with plain fakes and the panel holds no browser globals of its own.
 */
import { render } from 'preact';
import { browser } from 'wxt/browser';
import { ConfigStore } from '~/lib/config-store';
import { createProviders } from '~/lib/providers/registry';
import { SessionWatch } from '~/lib/session-watch';
import { SnapshotStore } from '~/lib/snapshot-store';
import { SidePanel } from './SidePanel';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('the side panel root element is missing');

render(
  <SidePanel
    store={new ConfigStore(browser.storage.local)}
    providers={createProviders()}
    session={
      new SessionWatch(new SnapshotStore(browser.storage.session), browser.storage.onChanged)
    }
  />,
  root
);
