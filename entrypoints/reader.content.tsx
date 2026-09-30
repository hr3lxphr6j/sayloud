import { render } from 'preact';
import { browser } from 'wxt/browser';
import { OPEN_SETTINGS } from '~/lib/open-settings';
import { ReaderController } from './reader.content/ReaderController';
import { SidePlayer } from './reader.content/SidePlayer';
import styles from './reader.content/styles.css?inline';

/** Stable handle for the tests, and the guard against mounting twice. */
const HOST_ID = 'sayloud-host';

export default defineContentScript({
  matches: ['<all_urls>'],
  // Injected by the service worker on a toolbar click, so the extension holds
  // no standing access to any page until the reader asks for it.
  registration: 'runtime',
  cssInjectionMode: 'manual',

  async main(ctx) {
    // Clicking the icon again must not stack a second player.
    if (document.getElementById(HOST_ID)) return;

    const ui = await createShadowRootUi(ctx, {
      name: 'sayloud-player',
      position: 'inline',
      anchor: 'body',
      append: 'last',
      css: styles,
      onMount: (container, _shadow, shadowHost) => {
        shadowHost.id = HOST_ID;

        const controller = new ReaderController(shadowHost);
        controller.connect();
        render(
          <SidePlayer
            controller={controller}
            onOpenSettings={() => {
              // Sent synchronously: `sidePanel.open()` in the worker needs the
              // click's transient activation, which an `await` here would spend.
              void browser.runtime.sendMessage({ type: OPEN_SETTINGS });
            }}
          />,
          container
        );
        return controller;
      },
      onRemove: (controller) => controller?.dispose(),
    });

    ui.mount();
  },
});
