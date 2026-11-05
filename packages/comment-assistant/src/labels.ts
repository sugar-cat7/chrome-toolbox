import type { CommentCategory } from '@chrome-toolbox/extension-core';

/**
 * Each category's name in Japanese: the label on a concealed chat line, the reason in the side
 * panel's hidden list and, unless `filterLabel` says more, its filter row. The content script and
 * the side panel both read this one map.
 */
export const CATEGORY_NAMES: Readonly<Record<CommentCategory, string>> = {
  abusive: '攻撃的',
  spam: 'スパム',
  spoiler: 'ネタバレ',
  question: '質問',
  important: '重要情報',
  chatter: '雑談',
  // The genre categories (R62).
  instruction: '指示',
  relay: '他配信の話題',
  ghosting: 'ゴースティング',
  privacy: 'プライバシー',
  sensitive: 'センシティブ',
};
