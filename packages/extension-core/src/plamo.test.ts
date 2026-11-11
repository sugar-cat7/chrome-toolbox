import { describe, expect, it } from 'vitest';
import {
  PLAMO_LANGUAGES,
  PLAMO_STOP,
  parsePlamoLine,
  plamoLanguage,
  plamoMaxTokens,
  plamoTranslateRequest,
  type PlamoInput,
} from './plamo.ts';

const base: PlamoInput = {
  line: 'Okay chat',
  sourceLang: 'en',
  previous: [],
  glossary: [],
  slot: 0,
};
const built = (input: Partial<PlamoInput>) => {
  const result = plamoTranslateRequest({ ...base, ...input });
  if (!result.ok) throw new Error(`expected a request, got ${result.error.internalCode}`);
  return result.value;
};

describe('plamoTranslateRequest', () => {
  it('builds one user message with the template kwargs and nothing that breaks PLaMo', () => {
    const line = 'Okay chat, the bridge is out.';
    const request = built({
      line,
      previous: ['We reached the gate.'],
      glossary: [
        { source: 'Fixturo', target: 'Fixturo' },
        { source: 'bridge', target: '橋' },
      ],
    });
    expect(request).toEqual({
      model: 'plamo-3-translate-2b',
      messages: [{ role: 'user', content: line }],
      templateKwargs: {
        target_lang: 'ja',
        source_lang: 'en',
        context: 'We reached the gate.',
        glossary: [{ source: 'bridge', target: '橋' }],
      },
      temperature: 0,
      maxTokens: 74,
      stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
      cachePrompt: true,
      slot: 0,
      tellRefusal: true,
    });
    expect(request).not.toHaveProperty('grammar');
    expect(request).not.toHaveProperty('jsonSchema');
    expect(request.messages.some((message) => message.role === 'system')).toBe(false);
  });

  it.each([
    { name: '字幕の枠', slot: 0, expected: 0 },
    { name: 'ページの枠', slot: 2, expected: 2 },
    { name: '枠の数が分からない', slot: undefined, expected: 'none' },
  ])('slot: $name', ({ slot, expected }) => {
    const request = built({ slot });
    expect('slot' in request ? request.slot : 'none').toBe(expected);
  });

  it('builds the page form: no glossary, no source language, the title and two units as context', () => {
    const request = built({
      line: 'Roll backward to dodge the light attack.',
      sourceLang: 'auto',
      glossary: [],
      slot: 1,
      maxTokensCap: 816,
      previous: ['Page: Fixture Wiki', 'Final Boss Guide', 'Phase two starts at half health.'],
    });
    expect(request.templateKwargs).toEqual({
      target_lang: 'ja',
      context: 'Page: Fixture Wiki\nFinal Boss Guide\nPhase two starts at half health.',
    });
    expect(request.templateKwargs).not.toHaveProperty('source_lang');
    expect(request.templateKwargs).not.toHaveProperty('glossary');
    expect(request.maxTokens).toBe(96);
    expect(request.slot).toBe(1);
  });

  it('leaves source_lang out when the language is unknown', () => {
    expect(built({ sourceLang: 'auto' }).templateKwargs).not.toHaveProperty('source_lang');
  });

  it.each([
    { name: '空', line: '', sourceLang: 'en' },
    { name: 'ASCII の空白だけ', line: ' \t\r\n', sourceLang: 'en' },
    { name: '予約トークン', line: 'gg <|plamo:tag|> ez', sourceLang: 'en' },
    { name: '対応していない言語', line: 'Bom dia chat', sourceLang: 'pt' },
  ])('rejects $name with input_invalid', ({ line, sourceLang }) => {
    const result = plamoTranslateRequest({ ...base, line, sourceLang });
    expect(result.ok ? 'ok' : result.error.internalCode).toBe('input_invalid');
  });

  it('keeps the last three usable previous lines, each cut to 200 code points', () => {
    const request = built({
      previous: ['one', 'two', 'x <|plamo:msg|> y', 'three', 'a'.repeat(250), '  '],
    });
    expect(request.templateKwargs?.context).toBe(`two\nthree\n${'a'.repeat(200)}`);
    expect(built({ previous: ['😀'.repeat(250)] }).templateKwargs?.context).toBe('😀'.repeat(200));
    expect(built({ previous: [] }).templateKwargs).not.toHaveProperty('context');
  });

  it('sends only glossary terms found in the line and leaves the key out when none are', () => {
    const glossary = [
      { source: 'Fixturo', target: 'Fixturo' },
      { source: 'castle', target: '城' },
      { source: '<|plamo:x', target: 'y' },
      { source: '', target: 'z' },
      { source: 'bridge', target: '' },
    ];
    expect(
      built({ line: 'FIXTURO crossed the bridge', glossary }).templateKwargs?.glossary,
    ).toEqual([{ source: 'Fixturo', target: 'Fixturo' }]);
    expect(built({ line: 'Okay chat', glossary }).templateKwargs).not.toHaveProperty('glossary');
  });

  it('caps max_tokens of the request at maxTokensCap', () => {
    const line = 'a'.repeat(400);
    expect(built({ line, slot: 1 }).maxTokens).toBe(256);
    expect(built({ line, slot: 1, maxTokensCap: 816 }).maxTokens).toBe(816);
  });
});

describe('plamoLanguage', () => {
  it.each([
    { code: 'en', expected: { kind: 'send', code: 'en' } },
    { code: 'EN-us', expected: { kind: 'send', code: 'en' } },
    { code: 'ceb', expected: { kind: 'send', code: 'ceb' } },
    { code: 'zh-CN', expected: { kind: 'send', code: 'zh-hans' } },
    { code: 'zh-Hans', expected: { kind: 'send', code: 'zh-hans' } },
    { code: 'zh_TW', expected: { kind: 'send', code: 'zh-hant' } },
    { code: 'zh-Hant-HK', expected: { kind: 'send', code: 'zh-hant' } },
    { code: 'zh', expected: { kind: 'omit' } },
    { code: 'auto', expected: { kind: 'omit' } },
    { code: '', expected: { kind: 'omit' } },
    { code: 'zh-CN-pinyin', expected: { kind: 'send', code: 'zh-hans' } },
    { code: 'zh-TW-pinyin', expected: { kind: 'send', code: 'zh-hant' } },
    { code: 'pt', expected: { kind: 'unsupported' } },
    { code: 'pt-BR', expected: { kind: 'unsupported' } },
  ])('plamoLanguage($code)', ({ code, expected }) => {
    expect(plamoLanguage(code)).toEqual(expected);
  });

  it('lists the 53 languages of the model card and the two stop strings', () => {
    expect(PLAMO_LANGUAGES).toHaveLength(53);
    expect(PLAMO_STOP).toEqual(['<|plamo:tag|>', '<|plamo:bos|>']);
  });
});

describe('plamoMaxTokens', () => {
  it.each([
    { name: '短い行', line: 'Okay chat', cap: undefined, expected: 34 },
    { name: '200 文字は 256 まで', line: 'a'.repeat(200), cap: undefined, expected: 256 },
    { name: '上限を上げても短い行は同じ', line: 'Okay chat', cap: 816, expected: 34 },
    { name: 'ページの 400 文字', line: 'a'.repeat(400), cap: 816, expected: 816 },
  ])('plamoMaxTokens: $name', ({ line, cap, expected }) => {
    expect(cap === undefined ? plamoMaxTokens(line) : plamoMaxTokens(line, cap)).toBe(expected);
  });
});

describe('parsePlamoLine', () => {
  it.each([
    { name: '1 行', text: '  よしチャット\n', finish: 'stop', expected: 'よしチャット' },
    { name: '内側の改行', text: 'よし\n  チャット', finish: 'stop', expected: 'よし チャット' },
    {
      name: '印はそのまま',
      text: '<1>ここ</1>を押す\n',
      finish: 'stop',
      expected: '<1>ここ</1>を押す',
    },
    { name: '切れた', text: 'よしチャ', finish: 'length', expected: 'response_invalid' },
    { name: '空', text: ' \n', finish: 'stop', expected: 'response_invalid' },
    {
      name: '予約トークン',
      text: 'よし<|plamo:tag|>',
      finish: 'stop',
      expected: 'response_invalid',
    },
    { name: '上限ちょうど', text: 'あ'.repeat(34), finish: 'stop', expected: 'あ'.repeat(34) },
    { name: '絵文字は 1 文字', text: '😀'.repeat(34), finish: 'stop', expected: '😀'.repeat(34) },
    { name: '上限を超えた', text: 'あ'.repeat(35), finish: 'stop', expected: 'response_invalid' },
    {
      name: '言語タグ（タブ）',
      text: 'en\tよしチャット',
      finish: 'stop',
      expected: 'よしチャット',
    },
    { name: '言語タグ（空白）', text: 'en よしチャット', finish: 'stop', expected: 'よしチャット' },
    {
      name: '小文字の英単語で始まる行は残す',
      text: 'it was great',
      finish: 'stop',
      expected: 'it was great',
    },
  ])('parsePlamoLine: $name', ({ text, finish, expected }) => {
    const result = parsePlamoLine(
      { text, timing: undefined, finishReason: finish },
      plamoMaxTokens('Okay chat'),
      'Okay chat',
    );
    expect(result.ok ? result.value : result.error.internalCode).toBe(expected);
  });
});
