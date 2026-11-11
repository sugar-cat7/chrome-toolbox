import { defineBackground } from 'wxt/utils/define-background';
import { startBackground } from '../runtime.ts';

// Every listener is registered in this first turn, so the event that woke the worker reaches it.
// The toolbar icon opens the side panel from its click handler (runtime.ts, S46); there is no
// popup.
export default defineBackground(() => {
  startBackground();
});
