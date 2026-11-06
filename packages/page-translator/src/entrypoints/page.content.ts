import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { claimPage } from '../content/claim.ts';
import { pageCommandMessageSchema } from '../protocol.ts';

/** Answers the background's commands; this task's page script only says that it runs. */
function answer(
  message: unknown,
  _sender: unknown,
  sendResponse: (response: unknown) => void,
): undefined {
  const command = pageCommandMessageSchema.safeParse(message);
  if (command.success && command.data.payload.action === 'ping') sendResponse({ ready: true });
}

export default defineContentScript({
  // Injected on demand into a tab's top frame (`scripting.executeScript`, PAGE_SCRIPT); without
  // `matches` the manifest lists no content script and asks for no site.
  registration: 'runtime',
  // WXT would also post `<extension id>:page:wxt:content-script-started` to the page at each
  // injection, telling its scripts the extension and when the button was pressed. Its document
  // event, which ends an older copy's context, stays.
  noScriptStartedPostMessage: true,
  main() {
    // A second injection into the same isolated world leaves the page to the first one.
    if (!claimPage(globalThis)) return;
    // The listener lasts as long as the document. It is not removed on `ctx.onInvalidated`: WXT
    // ends the running script's context whenever the script starts again on the page, also for
    // that second injection, which claims nothing and must leave this one answering. Once the
    // extension itself ends (update, reload, removal), its runtime listeners are never called.
    browser.runtime.onMessage.addListener(answer);
  },
});
