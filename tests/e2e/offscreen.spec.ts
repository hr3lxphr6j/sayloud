/**
 * The offscreen document, in a real browser.
 *
 * Cloud playback cannot be tested here — it needs a provider key and a network
 * — but the plumbing that is easiest to get wrong can: the `offscreen`
 * permission, the page the manager opens, and the message channel between the
 * service worker and the document. If the page is missing from the build, or
 * the document's listener never registers, the send below rejects instead of
 * answering.
 */
import { expect, test } from './fixtures';

/** The parts of the extension APIs this spec drives, from inside the worker. */
interface ChromeLike {
  offscreen: {
    hasDocument(): Promise<boolean>;
    createDocument(options: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
}

test('the service worker can open the offscreen document and reach its worker', async ({
  serviceWorker,
}) => {
  const result = await serviceWorker.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: ChromeLike }).chrome;
    const opened = await api.offscreen.hasDocument();

    if (!opened) {
      await api.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'the e2e suite checks that the audio document answers',
      });
    }

    // `stop` is the one command that needs no provider, no key and no network:
    // the audio worker always answers it. A promise that resolves at all is
    // proof that the document is loaded and listening, because a message with
    // no receiver rejects with "Could not establish connection".
    await api.runtime.sendMessage({ type: 'stop' });

    return { opened };
  });

  expect(result.opened).toBe(false);
});

test('a malformed message is ignored rather than crashing the document', async ({
  serviceWorker,
}) => {
  const reply = await serviceWorker.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: ChromeLike }).chrome;
    if (!(await api.offscreen.hasDocument())) {
      await api.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'the e2e suite checks that the audio document answers',
      });
    }

    // Anything in the extension can post to the runtime, so a command that is
    // not a command must be dropped.
    return api.runtime.sendMessage({ type: 'not-a-command' });
  });

  expect(reply).toBeUndefined();
});
