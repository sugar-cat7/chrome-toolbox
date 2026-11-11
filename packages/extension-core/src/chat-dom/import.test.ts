import { expect, it } from 'vitest';
import {
  clip,
  createTwitchChat,
  rawComment,
  youtubeLiveChat,
} from '@chrome-toolbox/extension-core/chat-dom';

it('loads the chat-dom subpath and creates adapters without DOM or extension globals', () => {
  expect(typeof globalThis.document).toBe('undefined');
  expect(createTwitchChat('session').site).toBe('twitch');
  expect(youtubeLiveChat.site).toBe('youtube');
  expect(clip('  hello   world  ', 7)).toBe('hello w');
  expect(rawComment('line', 'viewer', 'hello')?.text).toBe('hello');
});
