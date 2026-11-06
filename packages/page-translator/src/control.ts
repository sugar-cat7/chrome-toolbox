import { capture, Ok, type Result } from '@chrome-toolbox/contracts';

/** The page script as WXT builds `entrypoints/page.content.ts` (`registration: 'runtime'`). */
export const PAGE_SCRIPT = 'content-scripts/page.js';

/** The part of `chrome.scripting` the background uses; tests pass a fake with this shape. */
export type ScriptingApi = {
  executeScript(injection: {
    target: { tabId: number; frameIds: number[] };
    files: string[];
  }): Promise<unknown>;
};

/**
 * Injects the page script into the tab's top frame. Chrome refuses a page the extension may not
 * script (`chrome://`, the Web Store, a tab without the `activeTab` grant or a host permission,
 * a closed tab): that is `page_restricted`.
 */
export async function injectPage(api: ScriptingApi, tabId: number): Promise<Result<void>> {
  const injected = await capture(
    () => api.executeScript({ target: { tabId, frameIds: [0] }, files: [PAGE_SCRIPT] }),
    'page_restricted',
  );
  return injected.ok ? Ok(undefined) : injected;
}
