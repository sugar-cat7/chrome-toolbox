import { describe, expect, it } from 'vitest';
import { relayCommentSchema } from './obs-relay.ts';

const comment = {
  v: 1,
  sessionId: '11111111-1111-4111-8111-111111111111',
  id: 'c1',
  seq: 1,
  site: 'youtube',
  channel: 'stream',
  author: 'viewer',
  original: 'hello',
  translation: 'こんにちは',
  translationState: 'translated',
  at: 0,
  receivedAt: 1,
  publishedAt: 2,
  filter: { verdict: 'allowed', probability: 0.79 },
  translator: 'plamo-3-translate-2b',
};

describe('RelayComment', () => {
  it('accepts the published contract and rejects hidden or unjudged payloads', () => {
    expect(relayCommentSchema.safeParse(comment).success).toBe(true);
    expect(
      relayCommentSchema.safeParse({ ...comment, filter: { verdict: 'hidden', probability: 0.1 } })
        .success,
    ).toBe(false);
    expect(relayCommentSchema.safeParse({ ...comment, filter: undefined }).success).toBe(false);
    expect(relayCommentSchema.safeParse({ ...comment, role: 'owner' }).success).toBe(false);
  });

  it.each([
    { seq: Number.MAX_SAFE_INTEGER + 1 },
    { original: 'a'.repeat(1001) },
    { translation: '😀'.repeat(1001) },
    { at: -1 },
    { filter: { verdict: 'allowed', probability: Number.NaN } },
  ])('rejects invalid bounds %o', (patch) => {
    expect(relayCommentSchema.safeParse({ ...comment, ...patch }).success).toBe(false);
  });
});
