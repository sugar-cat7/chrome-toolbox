import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { claimPage } from '../content/claim.ts';
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
  main() {
    // A second injection into the same isolated world leaves the page to the first one.
    if (!claimPage(globalThis)) return;
    // The session lasts as long as the document: `pagehide` lets it go (restoring a page that
    // goes into the bfcache first), `pageshow` takes it up again. Nothing is restored or torn
    // down on `ctx.onInvalidated` (P18): WXT ends the running script's context whenever the
    // script starts again on the page, also for that second injection, which claims nothing and
    // must leave this one translating. Once the extension itself ends (update, reload, removal),
    // its runtime listeners are never called and the page keeps its text until it is left.
    startSession(document, browser);
  },
});
