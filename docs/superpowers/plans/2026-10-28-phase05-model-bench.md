# Phase 0.5 モデル検証 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 翻訳・ASR・Clef・スロット分離を実機の llama.cpp で測る CLI 群を作り、①②で使うモデルと方式を決めて記録する。

**Architecture:**

- 拡張と同じ `extension-core` の LLM クライアントとプロンプトを使い、Node の CLI（`packages/bench/*`、ワークスペースのパッケージ `@chrome-toolbox/bench`。当初は `tools/bench/*` に置き、2026-11-05 に移した）から llama-server を呼ぶ。
- 結果は gitignore された `bench-data/results/` に JSONL で保存し、要約を `docs/adoption.md` に記録する。
- プロンプトと JSON Schema は `extension-core` に置き、①②がそのまま使う。

**Tech Stack:** Node 24 TypeScript (tools), Zod mini, Vitest 5 (`pnpm --filter @chrome-toolbox/bench test`), llama.cpp `llama-server`, whisper.cpp server (比較候補), macOS `say` / `afconvert`（合成音声 fixture）

**Spec:** `docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md`（§3, §4, §5, §6 対象言語, §7 Clef 代替, §9 基準機, §10 Phase 0.5）

## Global Constraints

- 推論先は設定した llama.cpp（と比較用の whisper.cpp server）だけ。クラウドの翻訳・LLM は使わない。
- 基準機: Apple M4 Max 36GB。llama-server は Chrome と同じ Mac。モデルの合計は 20GB まで。
- 字幕の目標: 原語の字幕表示 p50 ≤ 1.0 s、日本語の表示 p50 ≤ 2.0 s / p95 ≤ 3.0 s。
- 対象言語: en, id, ko, es, zh（中国語は CER、それ以外は WER）。
- 実際の配信から取ったデータは `bench-data/`（gitignore）に置き、コミットしない。コミットする fixture は自作の文だけ。
- `packages/*/src` の規約: throw / catch / `console` は使わない。async 関数は `Promise<Result<…>>` を返す。エラーは `@chrome-toolbox/contracts` の `capture`、`decode`、`failure` を使う。新しいエラーコードは `tools/errors/catalog.json` に定義してから `pnpm errors:generate` を実行する。
- `tools/` は既存の tools と同じく通常の Node TypeScript で書く（`tools/process.ts` の流儀）。
- 依存を追加する場合は、カタログで正確なバージョンに固定し、公開から 24 時間以上たったものに限る。

## Review Focus

- llama-server が起動していない、またはモデルのロード中（`/health` が 503）→ ベンチは即座に理由を表示して非ゼロ終了する。0 件の結果を記録しない（Task 4 でテスト）。
- `max_tokens` で切れた JSON や、Schema を満たさない出力 → その 1 件を `response_invalid` として数える。ベンチ全体は続ける（Task 1・Task 4 でテスト）。
- 無音、または空の参照文 → WER/CER の計算で 0 除算しない（Task 3 でテスト）。
- 英語と日本語が混ざったサンプル → 言語判別の正解ラベルは `mixed` 扱いにし、正答率の分母から外す（Task 5 でテスト）。
- 実データの誤コミット → `bench-data/` が `.gitignore` 済みであることを `git check-ignore` で確認する（Task 8 でテスト）。

---

### Task 1: LLM クライアントに JSON 出力・スロット・プロンプトキャッシュを追加

**Files:**

- Modify: `packages/extension-core/src/llm.ts`（`ChatRequest`、`LlamaClient`、`createLlamaClient`）
- Modify: `packages/extension-core/src/index.ts`
- Test: `packages/extension-core/src/llm.test.ts`

**Interfaces:**

- Produces:
  - `ChatRequest` の追加フィールド: `slot?: number`（→ `id_slot`）、`cachePrompt?: boolean`（→ `cache_prompt`、既定 true）、`jsonSchema?: Record<string, unknown>`（→ `response_format: { type: 'json_schema', json_schema: { name: 'output', schema } }`）
  - `LlamaClient.chatJson<T>(this: void, request: ChatRequest & { jsonSchema: Record<string, unknown> }, output: z.ZodMiniType<T>): Promise<Result<T>>`
    - 本文の JSON parse に失敗したら `response_invalid`、Schema 検証に失敗したら `decode` の結果を返す。
  - `ChatTiming = { promptMs: number; predictedMs: number; predictedTokens: number }`。llama-server の `timings` から読み、`chatJson` と `chat` の成功値に付ける。
    - 戻り値の型: `Result<{ value: T; timing: ChatTiming | undefined }>`、`chat` は `Result<{ text: string; timing: ChatTiming | undefined }>`。
    - 既存の `chat` 呼び出し元（現状なし）も合わせる。

- [ ] **Step 1: 失敗するテストを書く**（`llm.test.ts` に追加。既存のテーブル形式に揃える）

```ts
it.each([
  { name: 'slot と cache', request: { slot: 1 }, body: { id_slot: 1, cache_prompt: true } },
  { name: 'cache 無効', request: { cachePrompt: false }, body: { cache_prompt: false } },
  {
    name: 'json schema',
    request: { jsonSchema: { type: 'object' } },
    body: {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'output', schema: { type: 'object' } },
      },
    },
  },
])('chat sends $name', async ({ request, body }) => {
  const sent: unknown[] = [];
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:8080',
    fetch: async (_u, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ message: { content: '{"a":1}' } }],
        timings: { prompt_ms: 5, predicted_ms: 7, predicted_n: 3 },
      });
    },
  });
  await client.chat({ messages: [{ role: 'user', content: 'x' }], ...request });
  expect(sent[0]).toMatchObject(body);
});

it.each([
  { content: '{"a":1}', expected: 'ok' },
  { content: '{"a":', expected: 'response_invalid' },
  { content: '{"b":1}', expected: 'response_invalid' },
])('chatJson decodes $content', async ({ content, expected }) => {
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:8080',
    fetch: async () => Response.json({ choices: [{ message: { content } }] }),
  });
  const result = await client.chatJson(
    { messages: [], jsonSchema: {} },
    z.strictObject({ a: z.number() }),
  );
  expect(result.ok ? 'ok' : result.error.internalCode).toBe(expected);
});

it('reports llama-server timings', async () => {
  // fetch は timings { prompt_ms: 5, predicted_ms: 7, predicted_n: 3 } を返す
  // 期待値: Ok({ text: '{"a":1}', timing: { promptMs: 5, predictedMs: 7, predictedTokens: 3 } })
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL（`chatJson` がない、`id_slot` が送られていない）
- [ ] **Step 3: 実装する**
  - 実装場所: `llm.ts`。
  - `chatSchema` に任意項目 `timings: z.optional(z.object({ prompt_ms: z.number(), predicted_ms: z.number(), predicted_n: z.number() }))` を足す。
  - `chatJson` は `chat` の結果を受けて、`captureSync(() => JSON.parse(text), 'response_invalid')` してから `decode(output, …)` する。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): add json output, slot pinning and timings to llama client"`

### Task 2: 共有プロンプトと出力 Schema

**Files:**

- Create: `packages/extension-core/src/prompts.ts`
- Modify: `packages/extension-core/src/index.ts`
- Test: `packages/extension-core/src/prompts.test.ts`

**Interfaces:**

- Consumes: Task 1 の `ChatRequest`
- Produces（すべて純粋関数。戻り値は `Readonly<{ messages: ChatMessage[]; jsonSchema: Record<string, unknown> }>` と、対応する出力の zod schema）:
  - `subtitlePrompt(input: { source: string; sourceLang: string; previous: readonly string[]; glossary: readonly GlossaryEntry[]; withEnglish: boolean })`
    - 対応する Schema: `subtitleOutputSchema = z.strictObject({ ja: z.string(), en: z.optional(z.string()) })`
  - `commentBatchPrompt(input: { comments: readonly { id: string; text: string; lang: string }[]; context: string; translate: boolean })`
    - 対応する Schema: `commentBatchOutputSchema = z.strictObject({ items: z.array(z.strictObject({ id: z.string(), ja: z.optional(z.string()), category: commentCategorySchema })) })`
  - `commentCategorySchema = z.enum(['abusive', 'spam', 'spoiler', 'question', 'important', 'chatter'])`、`CommentCategory = z.infer<typeof commentCategorySchema>`
  - `summaryPrompt(input: { comments: readonly { text: string; category: CommentCategory }[]; windowMinutes: 5 | 15 | 30 })`
    - 対応する Schema: `summaryOutputSchema = z.strictObject({ topics: z.array(z.string()), questions: z.array(z.strictObject({ text: z.string(), count: z.number() })), important: z.array(z.string()) })`
  - `GlossaryEntry = Readonly<{ source: string; target: string }>`
  - `jsonSchema` は zod schema から手書きで並記せず、`z.toJSONSchema(schema)` で生成する。zod mini で使えない場合は、`zod` 本体の `toJSONSchema` を使う（同じパッケージのため依存は増えない）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  [
    'subtitle',
    () =>
      subtitlePrompt({
        source: 'hi',
        sourceLang: 'en',
        previous: ['a'],
        glossary: [{ source: 'Fixture Ch', target: 'フィクスチャ' }],
        withEnglish: false,
      }),
  ],
  [
    'comments',
    () =>
      commentBatchPrompt({
        comments: [{ id: '1', text: 'hi', lang: 'en' }],
        context: 'ELDEN RING',
        translate: true,
      }),
  ],
  [
    'summary',
    () => summaryPrompt({ comments: [{ text: 'gg', category: 'chatter' }], windowMinutes: 15 }),
  ],
])('%s prompt keeps the fixed part first for prompt caching', (_name, build) => {
  const a = build();
  const b = build();
  expect(a).toEqual(b); // 決定的
  expect(a.messages[0]?.role).toBe('system'); // 固定部分が先頭
  expect(a.jsonSchema).toHaveProperty('type', 'object');
});

it('subtitle prompt puts glossary and previous lines in the user turn, after the fixed system turn', () => {
  const p = subtitlePrompt({
    source: 'hi',
    sourceLang: 'id',
    previous: ['x'],
    glossary: [{ source: 'Fixture Ch', target: 'フィクスチャ' }],
    withEnglish: true,
  });
  expect(p.messages[0]?.content).not.toContain('Fixture Ch');
  expect(p.messages.at(-1)?.content).toContain('Fixture Ch');
  expect(p.messages.at(-1)?.content).toContain('id');
  expect(p.jsonSchema).toMatchObject({ required: ['ja', 'en'] });
});

it('comment prompt asks only for categories when translate is false', () => {
  const p = commentBatchPrompt({
    comments: [{ id: '1', text: 'こんにちは', lang: 'ja' }],
    context: '',
    translate: false,
  });
  expect(JSON.stringify(p.jsonSchema)).not.toContain('"ja"');
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL（モジュールがない）
- [ ] **Step 3: `prompts.ts` を実装する**
  - system には、役割、出力言語（日本語）、カテゴリの定義を英語で書く。
    - 小型モデルでの指示追従を安定させるため、英語にする。
    - 固定の文言なので、同一文字列になる。
  - 可変部分（文脈、用語集、直前の文、本文）は最後の user メッセージにまとめる。
  - `withEnglish` または `translate` が false のときは、出力 Schema からそのフィールドを外す。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): add shared subtitle, comment and summary prompts"`

### Task 3: ベンチ用の指標関数

**Files:**

- Create: `packages/bench/metrics.ts`
- Test: `packages/bench/metrics.test.ts`

**Interfaces:**

- Produces:
  - `percentile(values: readonly number[], p: number): number | undefined`（最近傍順位法。空配列は `undefined`）
  - `errorRate(reference: string, hypothesis: string, unit: 'word' | 'char'): number`（Levenshtein 距離 ÷ 参照の単位数。参照が空なら、仮説も空なら 0、それ以外は 1）
  - `normalizeForScoring(text: string): string`（NFKC、小文字化、句読点除去、空白の正規化）

- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { values: [], p: 50, expected: undefined },
  { values: [3, 1, 2], p: 50, expected: 2 },
  { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], p: 95, expected: 10 },
])('percentile $p of $values', ({ values, p, expected }) =>
  expect(percentile(values, p)).toBe(expected),
);

it.each([
  { ref: 'the cat sat', hyp: 'the cat sat', unit: 'word', expected: 0 },
  { ref: 'the cat sat', hyp: 'the bat sat', unit: 'word', expected: 1 / 3 },
  { ref: '你好世界', hyp: '你好', unit: 'char', expected: 0.5 },
  { ref: '', hyp: '', unit: 'word', expected: 0 },
  { ref: '', hyp: 'noise', unit: 'word', expected: 1 },
  { ref: 'Hello, World!', hyp: 'hello world', unit: 'word', expected: 0 },
])('errorRate($ref, $hyp)', ({ ref, hyp, unit, expected }) =>
  expect(errorRate(ref, hyp, unit as 'word' | 'char')).toBeCloseTo(expected),
);
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `errorRate` は、内部で `normalizeForScoring` を両辺に適用してから分割する。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(bench): add percentile and error-rate metrics"`

### Task 4: 翻訳ベンチ CLI（遅延と自動採点）

**Files:**

- Create: `packages/bench/datasets.ts`
- Create: `packages/bench/translate.ts`
- Create: `packages/bench/fixtures/text/{en,id,ko,es,zh}.jsonl`（各 5 行、自作の配信風の文）
- Modify: `packages/bench/package.json`（scripts: `"bench:translate": "node translate.ts"`。dependencies に `"@chrome-toolbox/extension-core": "workspace:*"`）
- Modify: `.gitignore`（`bench-data/`）
- Test: `packages/bench/translate.test.ts`

**Interfaces:**

- Consumes: Task 1 の `createLlamaClient`、`chatJson`。Task 2 の `subtitlePrompt`、`commentBatchPrompt`、`subtitleOutputSchema`、`commentBatchOutputSchema`。Task 3 の `percentile`。
- Produces:
  - `TextSample = { id: string; lang: 'en' | 'id' | 'ko' | 'es' | 'zh' | 'mixed'; kind: 'speech' | 'chat'; text: string }`（JSONL 1 行 = 1 件）
  - `loadTextSamples(dir: string): TextSample[]`（不正な行は行番号付きで throw する）
  - `runTranslationBench(options: { client: LlamaClient; samples: TextSample[]; slot?: number; judge?: LlamaClient }): Promise<TranslationReport>`
    - `TranslationReport = { rows: TranslationRow[]; p50Ms?: number; p95Ms?: number; failures: Record<string, number>; meanScore?: number }`
    - `TranslationRow = { id; lang; kind; output?: string; ms: number; error?: string; score?: 1|2|3|4|5 }`
  - CLI: `pnpm --filter @chrome-toolbox/bench bench:translate -- --server <url> [--model <id>] [--set <dir>] [--slot <n>] [--judge-server <url>] [--out <file>]`
    - 既定値: `--set packages/bench/fixtures/text`、`--out bench-data/results/translate-<model>-<timestamp>.jsonl`
    - 最後に表形式の要約（p50、p95、失敗数、平均点）を出力する。

- [ ] **Step 1: 失敗するテストを書く**（fetch は偽物を渡す）

```ts
it('stops before measuring when the server is not ready', async () => {
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => new Response('', { status: 503 }),
  });
  await expect(runTranslationBench({ client, samples: [sample('en')] })).rejects.toThrow(
    /llama-server is not ready/,
  );
});

it('records invalid JSON as a counted failure and keeps going', async () => {
  // 1 件目は '{"ja":' を返し、2 件目は '{"ja":"こんにちは"}' を返す偽の fetch
  const report = await runTranslationBench({ client, samples: [sample('en'), sample('ko')] });
  expect(report.failures).toEqual({ response_invalid: 1 });
  expect(report.rows.map((row) => row.output)).toEqual([undefined, 'こんにちは']);
  expect(report.p50Ms).toBeTypeOf('number');
});

it('asks the judge for a 1-5 score per translated row', async () => {
  // judge は {"score":4} を返す
  expect((await runTranslationBench({ client, judge, samples: [sample('es')] })).meanScore).toBe(4);
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - 開始時に `client.health()` を呼び、失敗なら `llama-server is not ready: <internalCode>` で throw する。
  - サンプルは直列に実行する（遅延の測定を汚さないため）。
  - 遅延は `performance.now()` の差で測る。
  - `kind: 'speech'` には `subtitlePrompt`（直前の 3 文を文脈として渡す）を、`kind: 'chat'` には 1 件ずつの `commentBatchPrompt` を使う。
  - judge のプロンプトは原文と訳を渡し、`{ score: 1..5 }` を JSON Schema で返させる。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: PASS
- [ ] **Step 5: 実機で動作確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench bench:translate -- --server http://127.0.0.1:8080`（手元に llama-server がある場合）
  - Expected: 25 行と要約表が出る。llama-server がない場合は「not ready」で終了コード 1。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(bench): add translation latency and judge benchmark"`

### Task 5: ASR ベンチ CLI（whisper.cpp と llama.cpp 音声入力の比較）

**Files:**

- Create: `packages/bench/asr.ts`
- Create: `packages/bench/make-audio.ts`（macOS の `say` → `afconvert` で 16kHz mono WAV を生成する）
- Create: `packages/bench/fixtures/audio.jsonl`（`{ id, lang, voice, transcript }`。音声ファイル自体は生成物なので、`bench-data/audio/` に出力する）
- Modify: `packages/bench/package.json`（`"bench:asr": "node asr.ts"`、`"bench:make-audio": "node make-audio.ts"`）
- Test: `packages/bench/asr.test.ts`

**Interfaces:**

- Consumes: Task 3 の `errorRate`、`percentile`
- Produces:
  - `AsrEngine = 'whisper' | 'llama'`
  - `transcribe(engine: AsrEngine, server: string, wav: Uint8Array, options: { model?: string; fetch?: typeof fetch }): Promise<{ text: string; lang?: string; ms: number }>`
    - whisper: `POST /inference`（multipart: `file`、`response_format=verbose_json`、`language=auto`）。`text` と `language` を読む。
    - llama: `POST /v1/chat/completions`。`content: [{ type: 'input_audio', input_audio: { data: <base64>, format: 'wav' } }, { type: 'text', text: <transcribe and detect language, JSON> }]`。応答は `{ text, lang }` の JSON Schema で縛る。
  - `runAsrBench(options): Promise<AsrReport>`
    - `AsrReport = { rows; byLang: Record<lang, { errorRate: number; langAccuracy: number; p50Ms?: number; p95Ms?: number }> }`
    - zh は `unit: 'char'`、ほかは `'word'`。`lang: 'mixed'` は langAccuracy の分母から外す。
  - CLI: `pnpm --filter @chrome-toolbox/bench bench:asr -- --engine whisper|llama --server <url> [--model <id>] [--set bench-data/audio]`

- [ ] **Step 1: 失敗するテストを書く**
  - 偽の fetch を使い、エンジンごとのリクエストの形と、byLang の集計を検証する。

```ts
it.each([
  { engine: 'whisper', path: '/inference', reply: { text: 'halo semua', language: 'id' } },
  {
    engine: 'llama',
    path: '/v1/chat/completions',
    reply: { choices: [{ message: { content: '{"text":"halo semua","lang":"id"}' } }] },
  },
])('$engine transcribes through $path', async ({ engine, path, reply }) => {
  const calls: string[] = [];
  const result = await transcribe(engine as AsrEngine, 'http://127.0.0.1:9', new Uint8Array(44), {
    fetch: async (url) => {
      calls.push(new URL(String(url)).pathname);
      return Response.json(reply);
    },
  });
  expect(calls).toEqual([path]);
  expect(result).toMatchObject({ text: 'halo semua', lang: 'id' });
});

it('scores zh by characters and excludes mixed samples from language accuracy', async () => {
  // rows: zh 参照 '你好世界' / 仮説 '你好' / lang 'zh'、mixed 参照 'ok いいね' / lang 'en'
  // 期待値: byLang.zh.errorRate 0.5、byLang.zh.langAccuracy 1、byLang.mixed.langAccuracy は NaN ではなく除外（undefined）
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `make-audio.ts` は `say -v <voice> -o <tmp>.aiff <transcript>` を実行し、次に `afconvert -f WAVE -d LEI16@16000 -c 1` で変換する。
  - 声の候補は `say -v '?'` の出力から、言語ごとに 1 つ選ぶ。en: Samantha、id: Damayanti、ko: Yuna、es: Mónica、zh: Tingting。存在しない声はスキップして警告する。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: PASS
- [ ] **Step 5: 実機で比べる**
  - Run:
    - `pnpm --filter @chrome-toolbox/bench bench:make-audio`
    - `pnpm --filter @chrome-toolbox/bench bench:asr -- --engine whisper --server <whisper-url>`
    - `pnpm --filter @chrome-toolbox/bench bench:asr -- --engine llama --server <llama-audio-url>`
  - Expected: 5 言語の表が出る。
  - 合成音声はきれいすぎるので、実配信のクリップ（`bench-data/audio/real/`、手元のみ）でも同じコマンドを実行する。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(bench): add multilingual ASR benchmark for whisper.cpp and llama.cpp audio"`

### Task 6: Clef プローブ

**Files:**

- Create: `packages/bench/clef.ts`
- Create: `packages/bench/fixtures/clef.jsonl`（自作のコメント 20 件と正解ラベル `{ text, toxic: boolean }`。攻撃的な例は穏当な自作の文にとどめる）
- Modify: `packages/bench/package.json`（`"bench:clef": "node clef.ts"`）
- Test: `packages/bench/clef.test.ts`

**Interfaces:**

- Produces:
  - `probeClef(server: string, options: { fetch?: typeof fetch }): Promise<ClefProbe>`
    - `ClefProbe = { mode: 'systemone' | 'logprobs' | 'unavailable'; detail: string }`
    - 判定順:
      1. `POST /v1/systemone` が 2xx を返し、選択肢の確率が得られれば `systemone`。
      2. 1 がだめでも、`/v1/chat/completions` に `logprobs: true, top_logprobs: 5` を付け、選択肢 `yes`/`no` の 1 トークン出力で確率が取れれば `logprobs`。
      3. どちらもだめなら `unavailable`。
  - `scoreClef(server, probe, samples): Promise<{ accuracy: number; p50Ms?: number }>`
  - CLI の出力の最終行は、①②がそのまま使う形にする: `CLEF_MODE=<mode>`
- [ ] **Step 0: 調査（コードを書く前に）**
  - llama.cpp の現行ソースで `systemone` を検索し、リクエストとレスポンスの形を確認する（`tools/server` 配下）。Cloudflare の Clef モデルカードも確認する。
  - 公式の URL、コミット SHA、日付を `docs/adoption.md` の下書きに残す。
  - 形が記事の記述と違えば、ここで Interfaces を実際の形に合わせて直す。
- [ ] **Step 1: 失敗するテストを書く**
  - 偽の fetch で、3 つのモード（`systemone`、`logprobs`、`unavailable`）がそれぞれ判定されることを、テーブル形式で検証する。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: PASS
- [ ] **Step 5: 実機で確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench bench:clef -- --server <clef-flash-url>`
  - Expected: `CLEF_MODE=…` と正答率が出る。`unavailable` なら、②は LLM 分類による代替方式で進める（spec §7）。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(bench): probe Clef decision API on llama.cpp"`

### Task 7: スロット分離ベンチ

**Files:**

- Create: `packages/bench/slots.ts`
- Modify: `packages/bench/package.json`（`"bench:slots": "node slots.ts"`）
- Test: `packages/bench/slots.test.ts`

**Interfaces:**

- Consumes: Task 1（`slot`）、Task 2（`subtitlePrompt`、`commentBatchPrompt`）、Task 3（`percentile`）
- Produces:
  - `runSlotBench(options: { client: LlamaClient; seconds: number; subtitleEveryMs: number; commentBatchSize: number; pinSlots: boolean }): Promise<{ idle: Stats; loaded: Stats }>`
    - `Stats = { p50Ms?: number; p95Ms?: number; count: number }`
    - 字幕のリクエストは slot 0 に 1.5 秒ごと、コメントのバッチ（20 件）は slot 1 に連続で送る。
    - `pinSlots: false` のときは `slot` を付けない（比較用）。
    - 各クライアントには、それぞれ `concurrency: 1` の専用キューを渡す。共有キューだと、スロット分離の効果を測れないため。
  - CLI: `pnpm --filter @chrome-toolbox/bench bench:slots -- --server <url> [--seconds 60]`
    - 前提: サーバーは `--parallel 2` で起動していること。`/props` の `total_slots` を確認し、2 未満なら理由を表示して終了する。

- [ ] **Step 1: 失敗するテストを書く**
  - 偽の fetch で次の 2 点を確かめる。
    - 字幕のリクエストに `id_slot: 0`、コメントのリクエストに `id_slot: 1` が付く。
    - `total_slots: 1` のときは throw する。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: PASS
- [ ] **Step 5: 実機で確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench bench:slots -- --server http://127.0.0.1:8080`
  - Expected: 字幕の遅延について、idle と loaded、pin あり・なしの表が出る。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(bench): measure subtitle latency under comment load with slot pinning"`

### Task 8: 結果の記録と、モデル・方式の決定

**Files:**

- Modify: `docs/adoption.md`（「2026-10 モデル検証」節）
- Modify: `docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md`（§15 のリスクの解消状況と、§6・§7 の確定事項）
- Create: `bench-data/README.md`
  - このファイルは gitignore されるため、ローカルにのみ置く。リポジトリには、同じ手順を `.agents/skills/extension/SKILL.md` の「Benchmark」節として追記する。
- Modify: `.agents/skills/extension/SKILL.md`

- [ ] **Step 1: 実データでベンチを実行する**
  - Task 4〜7 のベンチを、実データ（各 100 文の発話とチャット、5 言語の音声）で実行する。
  - 候補モデルは 4 つ: Gemma 系と Qwen 系それぞれの、4B 前後と 12〜14B（いずれも Q4_K_M）。
  - モデルのメモリ使用量は `ps -o rss= -p <llama-server pid>` で記録する。
- [ ] **Step 2: ユーザーに抜き取り確認を依頼する**
  - ユーザーに 20 文の抜き取り確認を依頼する（spec §10）。
  - judge の点数と人の評価がずれていたら、その事実を記録する。
- [ ] **Step 3: 決定を記録する**
  - `docs/adoption.md` に記録する項目:
    - 採用した翻訳モデル（字幕用、コメント用。同じでもよい）
    - ASR エンジンとモデル
    - Clef のモード
    - `--parallel` の値
    - 言語ごとの p50 / p95 と、合計メモリ
    - 未達の言語があれば、spec §6 の「遅延が 2 秒を超えるとき」の順で対処すること
  - あわせて、モデルの入手元 URL、ファイルのハッシュ、日付も記録する。
  - whisper.cpp を採用する場合は、ユーザーの確認を取ったことを記録する（spec §10）。
- [ ] **Step 4: 実データがコミット対象外か確かめる**
  - Run: `git check-ignore -v bench-data/results bench-data/audio`
  - Expected: 2 行とも `.gitignore` のルールが表示される。
- [ ] **Step 5: 品質ゲートを通す**
  - Run: `pnpm gate:pre-pr -- --base <このブランチの分岐元 SHA>`
  - Expected: 新しく追加した部分がすべて pass する。web の既知の VRT 差分は別件として扱う。
- [ ] **Step 6: Commit**
  - `git commit -m "docs: record phase 0.5 model and ASR decisions"`
