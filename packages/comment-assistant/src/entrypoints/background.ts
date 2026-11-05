import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { launch } from '@chrome-toolbox/contracts';
import { startBackground } from '../runtime.ts';

export default defineBackground(() => {
  startBackground();
  // The toolbar action opens the side panel; there is no popup. A failure leaves
  // the panel reachable from Chrome's side panel menu, so it needs no recovery.
  launch(
    () => browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
    () => undefined,
  );
});
