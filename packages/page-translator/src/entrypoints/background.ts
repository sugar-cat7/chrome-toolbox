import { defineBackground } from 'wxt/utils/define-background';
import { startBackground } from '../runtime.ts';

// The toolbar action opens the popup (`action.default_popup`); the options page holds the
// llama.cpp settings. The service worker also adds 「選択範囲を翻訳」 to the context menu on
// install, answers it and the shortcut, and keeps the always sites' registration in line with the
// page settings and Chrome's grants (startBackground).
export default defineBackground(() => {
  startBackground();
});
