/**
 * Read the text currently under a highlight layer.
 *
 * The content script registers the ranges in the shared `CSS.highlights`
 * registry, so the page's own world can see them.
 */
export async function highlighted(page: import('@playwright/test').Page, name: string) {
  return page.evaluate((key) => {
    const highlight = CSS.highlights.get(key);
    if (!highlight) return '';
    return Array.from(highlight)
      .map((range) => range.toString())
      .join('');
  }, name);
}

export function sentenceHighlight(page: import('@playwright/test').Page) {
  return highlighted(page, 'sayloud-sentence');
}

export function wordHighlight(page: import('@playwright/test').Page) {
  return highlighted(page, 'sayloud-word');
}

/** The bubble card, wherever the player has opened one. */
export function bubble(page: import('@playwright/test').Page) {
  return page.getByRole('status');
}

/**
 * Kill the extension's service worker, the way Chrome's idle timeout would.
 *
 * MV3 terminates an idle worker without warning, and the only way to reproduce
 * that from a test is to close the worker's target over CDP.
 */
export async function terminateServiceWorker(
  context: import('@playwright/test').BrowserContext,
  page: import('@playwright/test').Page
): Promise<void> {
  const client = await context.newCDPSession(page);
  const { targetInfos } = await client.send('Target.getTargets');
  const worker = targetInfos.find((target) => target.type === 'service_worker');
  if (!worker) throw new Error('no service worker target to terminate');
  await client.send('Target.closeTarget', { targetId: worker.targetId });
  await client.detach();
}
