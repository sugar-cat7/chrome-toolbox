import { describe, expect, it, onTestFinished } from 'vitest';
import { capture, relayCommentSchema, type RelayComment } from '@chrome-toolbox/contracts';
import { createClefJudge, createLlamaClient, createQueue } from '../src/index.ts';
import { createRelayPipeline } from '@chrome-toolbox/extension-core/relay';
import { defaultResponder, startLlamaStub, withPlamo, type StubRequest } from './llama-stub.ts';

/** Exercises both wire parsers over real loopback HTTP; no platform, IPC or model process is used. */
describe('relay loopback transport', () => {
  it('publishes only Clef-approved comments, with the PLaMo request contract and input order', async () => {
    const stub = await startLlamaStub();
    onTestFinished(async () => {
      await stub.stop();
    });
    const sent: StubRequest[] = [];
    const respond = withPlamo(defaultResponder);
    stub.respond = (request) => {
      sent.push(request);
      return respond(request);
    };
    const baseUrl = stub.origin;
    const resultFetch = (input: string, init?: RequestInit) =>
      capture(() => globalThis.fetch(input, init), 'network_failed');
    let complete!: (comments: RelayComment[]) => void;
    const published = new Promise<RelayComment[]>((resolve) => {
      complete = resolve;
    });
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const pipeline = createRelayPipeline({
      sessionId,
      threshold: 0.8,
      translate: true,
      plamoSlot: 0,
      now: Date.now,
      judge: createClefJudge({ baseUrl, model: 'clef-flash', resultFetch, queue: createQueue() }),
      plamo: createLlamaClient({ baseUrl, resultFetch, timeoutMs: 30_000 }),
      publish: complete,
    });
    onTestFinished(() => pipeline.dispose());
    expect(
      await pipeline.ingest({
        sessionId,
        batchId: '22222222-2222-4222-8222-222222222222',
        site: 'youtube',
        channel: 'self-written',
        comments: [
          { id: '1', author: 'viewer', text: 'hello world', at: 0 },
          { id: '2', author: 'viewer', text: 'HARSH fixture', at: 0 },
          { id: '3', author: 'viewer', text: 'こんにちは', at: 0 },
        ],
      }),
    ).toMatchObject({ ok: true, value: { accepted: 3, dropped: 0 } });
    const comments = await published;
    expect(
      comments.map((comment) => [comment.id, comment.translationState, comment.translation]),
    ).toEqual([
      ['1', 'translated', '訳P:hello world'],
      ['3', 'unnecessary', null],
    ]);
    expect(comments.every((comment) => relayCommentSchema.safeParse(comment).success)).toBe(true);
    expect(sent.filter((request) => request.path === '/v1/systemone')).toHaveLength(3);
    expect(sent.filter((request) => request.path === '/v1/chat/completions')).toHaveLength(1);
    expect(sent.map((request) => request.path).sort()).toEqual([
      '/v1/chat/completions',
      '/v1/systemone',
      '/v1/systemone',
      '/v1/systemone',
    ]);
    for (const request of sent.filter((request) => request.path === '/v1/systemone')) {
      expect(request.body).toMatchObject({
        model: 'clef-flash',
        questions: { c1: { type: 'noul' } },
      });
      expect(Object.keys(Object(request.body).questions)).toEqual(['c1']);
    }
    const translation = sent.find((request) => request.chat)?.chat;
    expect(translation).toMatchObject({
      model: 'plamo-3-translate-2b',
      messages: [{ role: 'user', content: 'hello world' }],
      id_slot: 0,
      temperature: 0,
      stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
      chat_template_kwargs: { target_lang: 'ja' },
    });
    expect(translation?.response_format).toBeUndefined();
    expect(translation?.grammar).toBeUndefined();
    expect(translation?.max_tokens).toBeLessThanOrEqual(256);
  });
});
