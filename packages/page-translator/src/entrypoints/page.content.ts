import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { extensionGone, runInjection } from '../content/claim.ts';
import { startSession } from '../content/session.ts';

export default defineContentScript({
  // Injected on demand into a tab's top frame (`scripting.executeScript`, PAGE_SCRIPT), or by
  // the always sites' registration; without `matches` the manifest lists no content script and
  // asks for no site.
  registration: 'runtime',
  // WXT would also post `<extension id>:page:wxt:content-script-started` to the page at each
  // injection, telling its scripts the extension and when the button was pressed. Its document
  // event, which ends an older copy's context, stays.
  noScriptStartedPostMessage: true,
  main(ctx) {
    // The first injection into the isolated world claims the page and runs the session for as
    // long as the document lives: `pagehide` lets it go (restoring a page that goes into the
    // bfcache first), `pageshow` takes it up again. A second injection leaves the page to it.
    // WXT ends the running script's context whenever the script starts again on the page. From a
    // second press nothing happens then (P18). From the new version of a reloaded or updated
    // extension, the session restores the page at once and ends (P28).
    runInjection({
      scope: globalThis,
      start: () => startSession(document, browser),
      gone: () => extensionGone(browser),
      onInvalidated: (listener) => {
        ctx.onInvalidated(listener);
      },
    });
  },
});
