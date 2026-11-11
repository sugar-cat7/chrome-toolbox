import { defineContentScript } from 'wxt/utils/define-content-script';
import { installBridge } from '../captions/bridge.ts';

export default defineContentScript({
  // Every YouTube page, from the start: the player fetches captions on the first load and after
  // each in-app navigation, and the bridge must wrap fetch and XMLHttpRequest before it does.
  matches: ['https://www.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installBridge(window);
  },
});
