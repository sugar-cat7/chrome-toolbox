import { defineBackground } from 'wxt/utils/define-background';
import { startBackground } from '../runtime.ts';

// The toolbar action opens the popup (`action.default_popup`); the options page holds the
// llama.cpp settings.
export default defineBackground(() => {
  startBackground();
});
