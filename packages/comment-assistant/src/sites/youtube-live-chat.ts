import { youtubeLiveChat as chatDom } from '@chrome-toolbox/extension-core/chat-dom';
import type { SiteAdapter } from './types.ts';

/** The shared live chat reader with the extension's optional metadata surface. */
export const youtubeLiveChat: SiteAdapter = chatDom;
