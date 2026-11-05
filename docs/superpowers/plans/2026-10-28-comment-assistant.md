# ② comment-assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** YouTube と Twitch のチャット・コメントを、ローカル LLM で翻訳、分類、有害判定し、チャット欄の表示を切り替える。操作と要約はサイドパネルで行う。

**Architecture:**

- **content script**：DOM を読んで生のコメントを background に送り、返ってきた注釈を CSS 属性として DOM に反映するだけにする。
- **background**：次の流れで処理する。
  1. 言語を判定する。
  2. 重複を除いてバッチにまとめる（最大 3 件、または 500ms ごと。判断 R13）。
  3. Clef で有害判定をする。使えないときは LLM 分類で代わりに判定する。
  4. LLM の 1 回の呼び出しで、翻訳と分類を同時に行う。
  5. 結果を上限付きのストアに保存する。
- **サイドパネル**：フィルターと要約を扱う。
- メッセージの形は、拡張ごとのプロトコルとして定義する。

**Tech Stack:** WXT 0.21.5, React 19, Tailwind 4, Zod mini, Vitest 5 + WXT fake browser, Playwright 1.64（Chrome for Testing）

**Spec:** `docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md`（§5, §7, §9, §11）。依存する計画: `docs/superpowers/plans/2026-10-28-phase05-model-bench.md` の Task 1〜2（`chatJson`、`prompts.ts`）と Task 6（`CLEF_MODE`）。

## Global Constraints

- 操作と要約はサイドパネルに集約する。チャット欄では表示の切り替え（翻訳／ハイライト／伏せる／隠す）だけを行う（モック B）。
- コメントは DOM から読む。YouTube や Twitch の API とチャットの WebSocket には接続しない。プラットフォームへの追加リクエストは 0 件。
- 推論は 1 コメントにつき 1 回。日本語のコメントは翻訳せず、分類だけを行う。
- バッチは最大 3 件、または 500ms ごと（判断 R13: 実測で gemma4 の生成は毎秒約 37 トークン、20 件のバッチは約 25 秒かかったため）。翻訳できるのは毎秒約 1 件までで、追いつかない分は新しく見えている日本語以外のコメントを優先し、残りは原文のまま表示する。
- 保持するのは、直近 30 分か最大 5,000 件のうち少ない方。古い順に入れ替える。
- カテゴリ: abusive（攻撃的、Clef）、spam、spoiler、question、important、chatter。
- 要約: 5、15、30 分から選ぶ。手動で実行するか、サイドパネルを開いている間だけ 2 分ごとに自動で更新する。
- コメント機能の推論は、llama-server の `id_slot: 1` と `2` を使う（字幕は 0。`--parallel 3` のとき 2 つのバッチを同時に処理する。判断 R39）。
- メモリと CPU:
  - content script の JS ヒープは 30MB 以内。
  - 2 時間の負荷試験でヒープの増加は 10% 以内。
  - 拡張が原因で 50ms を超える長いタスクを出さない。
  - ポーリングはしない。
- 新着コメントの翻訳表示は、秒間 10 件までなら p50 2 秒以内。
- 削除やモデレーション操作はしない。コメントと音声はディスクに長期保存しない。
- `src/` の規約: throw / catch / `console` は使わない。async 関数は `Promise<Result<…>>` を返すか、名前付きの listener を `launch` に渡す。新しいエラーコードは `tools/errors/catalog.json` に定義してから `pnpm errors:generate` を実行する。
- UI の文言は日本語。

## Review Focus

- 秒間 100 件のような流量の急増 → 未処理のバッファは上限を超えたら古いものから捨て、捨てたコメントは原文のまま表示する。timer と observer は増えない（Task 5・Task 9 でテスト）。
- YouTube の SPA の遷移や、ライブチャットの iframe の再読み込み → observer と listener を解放し、チャンネルや動画が変わったらストアの区画を切り替える（Task 6・Task 9 でテスト）。
- 絵文字だけのコメント、スタンプ、スーパーチャットで本文が空 → LLM に送らず、`chatter` として扱う（Task 5 でテスト）。
- 配信の途中で llama.cpp が落ちる → コメントは原文のまま表示し、サイドパネルに「llama.cpp に接続できません」を出す。サーバーが戻れば、再読み込みなしで処理を再開する（Task 5・Task 9 でテスト）。
- 日本語のコメント → 翻訳の呼び出しをせず、分類だけを行う。プロンプトの Schema に `ja` を含めない（Task 5 でテスト）。

---

### Task 0: ルーターモード対応と、実測結果・既定値の反映

背景（2026-10-28 の実機確認）:

- llama.cpp の `llama-server` をルーターモードで動かし、`127.0.0.1:18083` で待ち受ける（判断 R21。構成は [docs/llama-server.md](../../llama-server.md)）。モデルは gemma4-e4b、gemma4-e2b、clef-flash。設定は `--models-max 2`、`--parallel 2`、`ctx-size 8192`。
- ルーターモードでは、すべてのリクエストに `model` が必要。`/props` はルーター自身の情報を返し、`total_slots` を含まない。モデルごとの値は `/props?model=<name>` で取れる。
- 実測（いずれも合成データ）:
  - gemma4-e4b の翻訳: 発話は p50 約 1.0 秒、2 件ずつのコメントのまとめ翻訳は約 2.2 秒。コメント 1 件ごとのタプル Schema も受け付けられる。
  - gemma4-e4b の `input_audio`: 5 言語すべてで言語判別が正しく、誤り率もほぼ 0。1 件あたり約 1.3〜1.5 秒。
  - clef-flash の systemone: 正答率 0.95、p50 364ms。読み込みに初回 74 秒かかる。
- 判断 R8 / R10 / R21: 既定の接続先は `http://127.0.0.1:18083`。翻訳と ASR は gemma4-e4b（llama.cpp の音声入力）、有害判定は clef-flash を使う。whisper.cpp は使わない。

**Files:**

- Modify: `packages/extension-core/src/llm.ts`（`props` にモデル名の引数を足す）
- Modify: `packages/extension-core/src/settings.ts`（既定の URL と、モデル名）
- Modify: `packages/extension-core/testing/playwright.ts`（スタブが `/props?model=` に応答する）
- Modify: `tools/bench/slots.ts`（`--model`）
- Modify: `docs/adoption.md`、`.agents/skills/extension/SKILL.md`
- Test: `packages/extension-core/src/llm.test.ts`、`packages/extension-core/src/settings.test.ts`（新規）、`tools/bench/slots.test.ts`

**Interfaces:**

- Produces:
  - `LlamaClient.props(this: void, options?: { model?: string; signal?: AbortSignal }): Promise<Result<ServerProps>>`
    - `model` があれば `GET /props?model=<encodeURIComponent(model)>`、なければ `GET /props`。
  - `settingsSchema = z.strictObject({ llamaBaseUrl: z.string(), models: z.strictObject({ translate: z.string(), clef: z.string(), asr: z.string() }) })`
    - 既定値: `{ llamaBaseUrl: 'http://127.0.0.1:18083', models: { translate: 'gemma4-e4b', clef: 'clef-flash', asr: 'gemma4-e4b' } }`
    - 以前の形（`llamaBaseUrl` だけ）で保存された値を読んだら、`models` に既定値を補って返す（移行）。
  - `bench:slots` の `--model <name>`: 2 つのクライアントのリクエストと `props` の両方に渡す。

- [ ] **Step 1: 失敗するテストを書く**
  - `props({ model: 'gemma4-e4b' })` が `/props?model=gemma4-e4b` を呼び、`total_slots` を読む。
  - 以前の形の設定（`{ llamaBaseUrl }` だけ）を `load` すると、`models` が既定値で補われる。
  - `bench:slots` が `--model` を、字幕とコメント両方のリクエストの `model` と、`props` に渡す。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test` と `pnpm test:tools -- tools/bench`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - スタブの llama サーバーは `/props` と `/props?model=` の両方に `{ total_slots: 2 }` を返す。
  - 3 本の拡張の接続確認は、既存の E2E が通ったままにする。
- [ ] **Step 4: 通ることを確認する**
  - Run: 上記のテストと、3 本の拡張の `test` と `test:e2e`
  - Expected: PASS
- [ ] **Step 5: 実機で計測して記録する**
  - Run: `pnpm bench:slots -- --server http://127.0.0.1:18082 --model gemma4-e4b --seconds 20`
    - 実行には、`docs/llama-server.md` の手順でルーターモードで起動したサーバーが必要。
  - `docs/adoption.md` の「2026-10 モデル検証」に、背景の実測値（合成データであることを明記）、slots の結果、サーバーの構成（ルーターモードの設定値、llama.cpp b11669 のソースビルド、macOS 26 でビルドされたバイナリが macOS 15 では動かないこと）、暫定の決定（R8 / R10）を記録する。
    - 実配信データでの計測と、ユーザーによる 20 文の確認は、引き続き PENDING とする。
    - Qwen 系との比較（qwen38-27b は 13GB で、Clef と合わせると 20GB の上限に近い）も PENDING とする。
  - `.agents/skills/extension/SKILL.md` の Benchmark 節に、サーバーの起動方法（`docs/llama-server.md` への参照）と、ルーターモードでは `--model` が必要なことを書く。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(extension-core): support llama.cpp router mode and default to the managed server"`

### Task 1: 拡張ごとに定義できるメッセージプロトコル

**Files:**

- Modify: `packages/extension-core/src/messages.ts`
- Modify: `packages/extension-core/src/index.ts`
- Modify: 3 本の拡張の `src/runtime.ts`（`createBackgroundRouter` の呼び出しを置き換える）
- Test: `packages/extension-core/src/messages.test.ts`

**Interfaces:**

- Produces:
  - `defineProtocol<P extends Record<string, { request: z.ZodMiniType; response: z.ZodMiniType }>>(protocol: P): Protocol<P>`
  - `Protocol<P>` の要素:
    - `route(handlers: { [K in keyof P]: (req: z.infer<P[K]['request']>) => Promise<Result<z.infer<P[K]['response']>>> }): (message: unknown) => Promise<Result<unknown>>`
    - `send<K extends keyof P>(send: (m: unknown) => Promise<unknown>, type: K, request: z.infer<P[K]['request']>): Promise<Result<z.infer<P[K]['response']>>>`
  - 送るメッセージの形は `{ type: K, payload: request }`。
  - `llmProtocol = defineProtocol({ 'llm/status': { request: z.strictObject({ baseUrl: z.string() }), response: connectionStatusSchema } })`
  - 共通のハンドラーは `llmHandlers({ fetch, queue })` として返す。各拡張はこれを自分のハンドラーにスプレッドで混ぜる。
  - 移行の範囲: 既存の `createRouter`、`createBackgroundRouter`、`sendRequest`、`extensionRequestSchema` を削除し、呼び出し元を置き換える。後方互換は残さない（YAGNI）。

- [ ] **Step 1: 失敗するテストを書く**
  - 既存の `messages.test.ts` を新しい API で書き直し、次のケースを追加する。

```ts
const echo = defineProtocol({
  'x/echo': {
    request: z.strictObject({ n: z.number() }),
    response: z.strictObject({ n: z.number() }),
  },
});
it.each([
  { message: { type: 'x/echo', payload: { n: 1 } }, expected: Ok({ n: 1 }) },
  { message: { type: 'x/echo', payload: { n: 'a' } }, expected: 'input_invalid' },
  { message: { type: 'nope', payload: {} }, expected: 'input_invalid' },
])('routes $message', async ({ message, expected }) => {
  const route = echo.route({ 'x/echo': async (req) => Ok(req) });
  const result = await route(message);
  expect(typeof expected === 'string' ? !result.ok && result.error.internalCode : result).toEqual(
    expected,
  );
});
it('send decodes the remote Result envelope including failures', async () => {
  /* Err(failure('queue_full','d1')) が往復する */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL
- [ ] **Step 3: 実装し、3 本の拡張の runtime を移行する**
  - 既存の envelope の decode と、`internalCodes` の扱いは流用する。
- [ ] **Step 4: 通ることを確認する**
  - Run:
    - `pnpm --filter @chrome-toolbox/extension-core test`
    - `pnpm --filter "./packages/*-translator" --filter @chrome-toolbox/comment-assistant test`
    - 同じ 3 本の `test:e2e`
  - Expected: PASS。既存の接続 E2E も変わらず通る。
- [ ] **Step 5: Commit**
  - `git commit -m "refactor(extension-core): per-extension message protocols"`

### Task 2: 上限付きの部品（LRU、バッチャー、コメントストア）

**Files:**

- Create: `packages/extension-core/src/bounded.ts`
- Create: `packages/extension-core/src/comments.ts`
- Modify: `packages/extension-core/src/index.ts`
- Test: `packages/extension-core/src/bounded.test.ts`
- Test: `packages/extension-core/src/comments.test.ts`

**Interfaces:**

- Produces（`bounded.ts`）:
  - `createLruCache<K, V>(options: { max: number }): { get(k: K): V | undefined; set(k: K, v: V): void; size(): number; clear(): void }`
  - `createBatcher<T>(options: { maxItems: number; maxWaitMs: number; maxBuffered: number; flush: (items: T[]) => void; timers?: Timers }): { push(item: T): { dropped: T[] }; dispose(): void }`
    - `maxItems` に達したら即時に flush する。最初の 1 件から `maxWaitMs` 経過でも flush する。
    - 未 flush の件数が `maxBuffered` を超えたら、古いものから捨てて `dropped` で返す。
    - timer は常に 1 つ以下。`dispose` は timer を解除し、バッファを空にする。
  - `Timers = { set(fn: () => void, ms: number): number; clear(id: number): void }`（テストでは偽の時計を注入する）
- Produces（`comments.ts`）:
  - `commentRecordSchema = z.strictObject({ id: z.string(), site: z.enum(['youtube', 'twitch']), channel: z.string(), author: z.string(), text: z.string(), lang: z.string(), at: z.number(), translation: z.optional(z.string()), category: z.optional(commentCategorySchema), abusive: z.optional(z.number()), state: z.enum(['pending', 'done', 'skipped', 'failed']) })`
  - `CommentRecord = z.infer<typeof commentRecordSchema>`
  - `createCommentStore(options: { maxItems: number; maxAgeMs: number; now: () => number }): CommentStore`
  - `CommentStore` の要素:
    - `add(records: CommentRecord[]): CommentRecord[]`（同じ `id` は捨て、新しく追加したものだけを返す）
    - `update(id: string, patch: Partial<Pick<CommentRecord, 'translation' | 'category' | 'abusive' | 'state'>>): CommentRecord | undefined`
    - `since(ms: number): CommentRecord[]`
    - `size(): number`
    - `clear(): void`
  - 上限を超えた分と、`maxAgeMs` より古いものは、`add` のたびに古い順に削除する。
  - 既定値: `maxItems: 5000`、`maxAgeMs: 30 * 60_000`、バッチャーは `maxItems: 3`、`maxWaitMs: 500`、`maxBuffered: 200`、LRU は `max: 2000`。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { pushes: 20, advance: 0, flushes: [20] },
  { pushes: 3, advance: 499, flushes: [] },
  { pushes: 3, advance: 500, flushes: [3] },
])('batcher flushes $pushes items after $advance ms', ({ pushes, advance, flushes }) => {
  /* 偽の Timers で検証 */
});
it('batcher drops the oldest beyond maxBuffered and keeps one timer', () => {
  /* push 205 → dropped 5件、active timers 1 */
});
it('batcher dispose clears its timer', () => {
  /* active timers 0 */
});
it('lru evicts the least recently used', () => {
  /* max 2: set a,b; get a; set c → b が消える */
});
it.each([
  { name: 'count cap', maxItems: 3, ages: [0, 0, 0, 0], kept: 3 },
  { name: 'age cap', maxItems: 10, ages: [31 * 60_000, 0], kept: 1 },
])('store enforces $name', ({ maxItems, ages, kept }) => {
  /* ... */
});
it('store ignores duplicate ids', () => {
  /* add 同じ id 2回 → 2回目は [] */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - ストアは、挿入順の配列と、id からレコードへの Map で持つ。
  - 削除するときは、配列の先頭からまとめて切り落とす（`splice(0, n)`）。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): add bounded LRU, batcher and comment store"`

### Task 3: 言語判定

**Files:**

- Create: `packages/extension-core/src/language.ts`
- Modify: `packages/extension-core/src/index.ts`
- Test: `packages/extension-core/src/language.test.ts`

**Interfaces:**

- Produces:
  - `LanguageGuess = Readonly<{ lang: string; confidence: number }>`
  - `scriptLanguageGuess(text: string): LanguageGuess`
    - 文字種の比率で判定する。
      - かな → `ja`、confidence 0.9
      - ハングル → `ko`、0.9
      - 漢字のみ → `zh`、0.5（Task 5c: 全角の `ｗ`・`！`・`？`、`々`・`〆`・`〜`、または短い文の末尾の半角 `w` があれば `ja`、0.6。中国語に特有の字があれば `zh` のまま）
      - ラテン文字 → `und-Latn`、0.3
      - 絵文字や記号だけ → `und`、0
  - `createLanguageDetector(api: { create(): Promise<{ detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]> }> } | undefined): { detect(text: string): Promise<Result<LanguageGuess>> }`
    - Chrome の `LanguageDetector`（グローバル）を、アダプターとして受け取る。
    - 使えない、または confidence が 0.5 未満のときは、`scriptLanguageGuess` の結果を返す。
    - `create()` は一度だけ呼んでキャッシュする。
  - `needsTranslation(guess: LanguageGuess, target: 'ja'): boolean`（`ja` と `und` は false）

- [ ] **Step 1: 失敗するテストを書く**
  - テーブル形式で、`'こんにちは'`→ja、`'안녕하세요'`→ko、`'你好'`→zh、`'gg wp'`→und-Latn、`'🔥🔥'`→und を確かめる。
  - アダプターが `[{ detectedLanguage: 'id', confidence: 0.92 }]` を返すときは、`id` を採用する。
  - アダプターが `undefined` のときは、文字種による判定に落ちる。
  - `create` が 1 回しか呼ばれないことを確かめる。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): language detection with on-device API and script fallback"`

### Task 4: 有害判定ポート（Clef と代替方式）

**Files:**

- Create: `packages/extension-core/src/toxicity.ts`
- Modify: `packages/extension-core/src/index.ts`
- Test: `packages/extension-core/src/toxicity.test.ts`

**Interfaces:**

- Consumes: Phase 0.5 の Task 6 で確定した Clef のエンドポイントの形（`CLEF_MODE`）
- Produces:
  - `ToxicityJudge = { mode: 'clef' | 'llm'; judge(this: void, texts: readonly string[], signal?: AbortSignal): Promise<Result<number[]>> }`
    - 戻り値は、各テキストの「攻撃的である確率」（0〜1）。
  - `createClefJudge(options: { baseUrl: string; fetch: Fetch; queue: Queue; maxPromptChars?: number }): ToxicityJudge`
    - `POST /v1/systemone` だけを使う（判断 R3: Phase 0.5 の probe が `logprobs` を返した場合、それは Clef ではなくテキスト LLM が答えたことを意味するので、`llmCategoryJudge` に落とす）。
    - リクエストとレスポンスの形は、`docs/adoption.md` の「Clef sources and probe」と `tools/bench/clef.ts` に合わせる。
    - 1 回のリクエストは Clef サーバーのマイクロバッチ（`-ub`）に収まる大きさに分割する（判断 R4）。既定の `maxPromptChars` は 1,500 文字。分割した結果は元の順に連結して返す。
  - `llmCategoryJudge: ToxicityJudge`（`mode: 'llm'`）
    - `judge` は常に空配列の `Ok([])` を返す。
    - この場合、攻撃的かどうかは `commentBatchPrompt` の `abusive` カテゴリで判定する（spec §7 の代替方式）。
  - 攻撃的と判定するしきい値: `ABUSIVE_THRESHOLD = 0.5`（Task 5c で 0.8 に変更）

- [ ] **Step 1: 失敗するテストを書く**
  - 偽の fetch で次を検証する。
    - `/v1/systemone` の応答から、確率の配列が入力と同じ順で読み取れる。
    - `maxPromptChars` を超えるバッチは複数のリクエストに分割され、結果が元の順に連結される。
    - HTTP 501（Clef 以外のモデル）は、新しいエラーコード `clef_unavailable`（`tools/errors/catalog.json` に追加して `pnpm errors:generate`）で返る。パイプライン（Task 5）はこのコードを受けたら、以降のバッチで `llm` の代替方式に切り替える。
    - サーバーのエラーは `network_failed` になる。
    - `llmCategoryJudge` は fetch を呼ばない。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): toxicity judge port with Clef and LLM fallback"`

### Task 5: コメント処理パイプライン（background）

**Files:**

- Create: `packages/comment-assistant/src/pipeline.ts`
- Create: `packages/comment-assistant/src/protocol.ts`
- Test: `packages/comment-assistant/test/unit/pipeline.test.ts`

**Interfaces:**

- Consumes: Task 1（`defineProtocol`）、Task 2（バッチャー、ストア）、Task 3（`createLanguageDetector`、`needsTranslation`）、Task 4（`ToxicityJudge`）。Phase 0.5 の `chatJson`、`commentBatchPrompt`、`commentBatchOutputSchema`。
- Produces:
  - `RawComment = Readonly<{ id: string; author: string; text: string; at: number }>`
  - `Annotation = Readonly<{ id: string; translation?: string; category: CommentCategory; state: CommentRecord['state'] }>`
  - `commentProtocol = defineProtocol({ ... })` は、次の 3 つに `llmProtocol` の定義を加えたもの:
    - `'comments/ingest'`: `{ site, channel, comments: RawComment[] }` → `{ accepted: number; dropped: number }`
    - `'comments/summary'`: `{ site, channel, windowMinutes: 5 | 15 | 30 }` → `Summary`
    - `'comments/stats'`: `{ site, channel }` → `{ records: number; pending: number; dropped: number; failed: number; lastError?: string }`（`records` はストアの件数。Task 5h で `stored` は保存だけのコメントの数になった）
  - 注釈は `browser.tabs.sendMessage(tabId, { type: 'comments/annotations', payload: Annotation[] }, { frameId })` で、送り元のフレームに返す。この方向は fire-and-forget で、content script の受信側も Zod で decode する。
  - `createCommentPipeline(deps: { client: LlamaClient; judge: ToxicityJudge; detector: ReturnType<typeof createLanguageDetector>; context: () => string; emit: (target: { tabId: number; frameId: number }, annotations: Annotation[]) => void; now: () => number; timers?: Timers }): CommentPipeline`
  - `CommentPipeline` の要素:
    - `ingest(target: { tabId: number; frameId: number }, input: { site; channel; comments: RawComment[] }): { accepted: number; dropped: number }`
    - `store(site: string, channel: string): CommentStore`
    - `stats(site, channel)`
    - `dispose(): void`
  - バッチごとの流れ:
    1. 本文が空のもの（絵文字や記号だけ）を除く。除いたものは `chatter` / `skipped` として即座に emit する。
    2. `detector` で言語を判定する。
    3. `judge.judge`（mode が `clef` のときだけ）。
    4. `chatJson(commentBatchPrompt({ comments, context }), commentBatchOutputSchema)` を `slot: 1` で呼ぶ。
       - 判断 R6: `comments` の各要素に `translate: needsTranslation(guess, 'ja')` を付ける。プロンプトの JSON Schema はコメントごとに作られ、`translate: false` のコメントには `ja` を出力させない（日本語のコメントは分類だけ）。
       - 応答は、入力と同じ順・同じ id の固定長の配列になる。id が一致しない要素は、そのコメントを `failed` として扱う。
    5. `abusive` の確率がしきい値以上なら、カテゴリを `abusive` にする（Clef が LLM の分類より優先）。
    6. ストアを更新して emit する。
    - LLM が失敗したら、そのバッチを `failed` として emit し（原文のまま表示）、`lastError` を記録する。
    - バッチャーから捨てられたものは `skipped` として emit する。
  - ストアは `${site}:${channel}` ごとに 1 つ持ち、同時に保持するのは最大 4 つまで（LRU）。古い区画は `clear` する。

- [ ] **Step 1: 失敗するテストを書く**
  - 偽の LlamaClient、偽の judge、偽の時計を使う。

```ts
it('translates non-Japanese comments and only classifies Japanese ones in one call per batch', async () => {
  // comments: en 'how long is phase 2?', ja 'がんばれ' を 1 バッチで → chatJson 1回、comments[0].translate: true、comments[1].translate: false
  // 期待 emit: [{ id:'1', translation:'第2形態ってどのくらい?', category:'question', state:'done' }, { id:'2', category:'chatter', state:'done' }]（ja の translation なし）
});
it('sends only classification when the whole batch is Japanese', async () => {
  /* commentBatchPrompt の全コメントが translate: false、JSON Schema に ja が含まれない */
});
it('skips empty-text comments without calling the LLM', async () => {
  /* '🔥🔥' → chatJson 呼ばれない、state 'skipped' */
});
it('marks a failed batch and records lastError while llama.cpp is down, then recovers', async () => {
  /* 1回目 network_failed → state 'failed'、2回目 Ok → 'done' */
});
it('reports dropped comments under a flood instead of growing', async () => {
  /* 秒間100件相当 push → dropped>0、stats.pending ≤ 200 */
});
it('lets Clef override the LLM category when the score reaches 0.5', async () => {
  /* judge [0.8] + LLM 'chatter' → 'abusive' */
});
it.each([{ windowMinutes: 5 }, { windowMinutes: 15 }])(
  'summary uses only records within $windowMinutes min',
  async () => {
    /* Task 8 と共有 */
  },
);
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/comment-assistant test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `runtime.ts` の `startBackground` にパイプラインを組み込み、`dispose` を後片付けに含める。
  - キューは `createQueue({ concurrency: 1, maxPending: 16 })` を再利用する。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/comment-assistant test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(comment-assistant): batch translate, classify and judge comments in the background"`

### Task 5b: 処理量の最適化（キャッシュ、定型ルール、期限切れの破棄、並列推論）

背景（判断 R19、2026-10-28 の実配信での計測）: 英語の配信では、コメントが毎秒約 2.8 件流れてくるのに対して、翻訳できたのは毎秒約 0.55 件だった。処理待ちは 1 分で 114 件までたまり、遅延は p50 7 秒、p95 11 秒。ユーザーの方針は「高速な処理が肝」で、処理できないものや不要なものは捨て、簡単なキャッシュも組み合わせる。

**Files:**

- Create: `packages/comment-assistant/src/fastpath.ts`（正規化、定型ルール、テキストキャッシュ）
- Modify: `packages/comment-assistant/src/pipeline.ts`、`packages/comment-assistant/src/runtime.ts`
- Modify: `packages/extension-core/src/prompts.ts`（出力を短くする場合のみ）
- Test: `packages/comment-assistant/test/unit/fastpath.test.ts`、`packages/comment-assistant/test/unit/pipeline.test.ts`

**Interfaces:**

- Produces:
  - `normalizeComment(text: string): string`
    - NFKC、小文字化、前後の空白と連続する空白の正規化。
    - 同じ文字が 3 回以上続く場合は 3 回に縮める（例: `wwwwww` → `www`、`LETS GOOOOO` → `lets gooo`）。
  - `trivialVerdict(normalized: string): { category: CommentCategory; translation?: string } | undefined`
    - 定型の短い反応をルールで判定する。対象は `lol`、`lmao`、`www`、`w`、`草`、`gg`、`888`、`kekw`、`omegalul`、`pog`、`poggers`、`ez`、`f`、`?`、`!` と、数字・記号だけのもの。
    - 判定は `chatter`。訳は小さな辞書（例: `lol` → `（笑）`）にあるものだけを付ける。
  - テキストキャッシュ: `createLruCache<string, { category; translation?; abusive? }>({ max: 2000 })`。キーは `normalizeComment` の結果。モデルの応答が `done` のときだけ保存する。
  - パイプラインの処理順（変更後）:
    1. 空の本文はスキップ（既存）。
    2. `trivialVerdict` に当たるか、テキストキャッシュに当たれば、モデルも Clef も呼ばずに `done` で即座に返す。
    3. 残りをバッチャーに入れる（既存）。
  - 期限切れの破棄: 受け取ってから `staleAfterMs`（既定 8,000ms）を過ぎても推論に回っていないコメントは、`skipped` で確定して返す（原文のまま表示）。計測のため、stats に `expired` の件数を足す。
  - 並列推論: コメントの推論を同時に `commentConcurrency` 本まで流す。
    - 既定値は `max(1, total_slots - 1)` で、`props({ model })` から求める。1 本は字幕用に残す。
    - サーバーの処理枠が 2 なら 1 本のまま。並列にする効果は Step 0 で測る。
  - stats に `cached`、`trivial`、`expired` の件数を足す。

- [ ] **Step 0: 並列推論の効果を実機で測る**
  - ルーターモードのサーバーを `--parallel 3` で起動し直す。
  - 3 件のコメントのバッチを、1 本ずつ流した場合と 2 本並列で流した場合で、合計スループット（件/秒、トークン/秒）を比べる。
  - 2 本並列で合計スループットが 1.3 倍未満なら、`commentConcurrency` の既定を 1 にする。結果はレポートに記録する。
- [ ] **Step 1: 失敗するテストを書く**
  - `normalizeComment` の表（連続する文字、全角、大文字）。
  - `trivialVerdict` の表（当たるもの、当たらないもの。例: `lol` は当たり、`lol that was close` は当たらない）。
  - キャッシュに当たったコメントは chat も Clef も呼ばない。
  - 8 秒を過ぎたコメントは推論されず、`skipped` になり、`expired` が数えられる（偽の時計を使う）。
  - `commentConcurrency: 2` で、2 つのバッチが同時に処理中になる。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/comment-assistant test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: comment-assistant の `test` と `test:e2e`、`pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "perf(comment-assistant): cache repeats, fast-path trivial reactions, expire stale comments and parallelize inference"`

### Task 5c: 精度の改善とフィードバック学習（判断 R24・R25）

背景（2026-10-28 の実配信ログの採点）:

- 「攻撃的」（Clef、しきい値 0.5）: 日本語のゲーム配信 10 分で非表示にした 9 件がすべて誤判定（剥製、廃人、定番のネタ、親しみを込めた呼びかけ）。
- 翻訳: 256 件中 34 件の訳文に注釈やかっこ書きの原文が付き、3 件に HTML タグ（`</blockquote>`）が混ざった。漢字＋ｗの日本語（「倍以上ｗ」など）を中国語と判定して翻訳していた。
- ユーザーの要望: 非表示にしたコメントをあとで見返せること、問題ないものは元に戻せること、それを学習に使えること。

**Files:**

- Modify: `packages/extension-core/src/toxicity.ts`（しきい値）、`packages/extension-core/src/prompts.ts`（指示と文法）、`packages/extension-core/src/language.ts`（日本語の判定）
- Create: `packages/comment-assistant/src/feedback.ts`
- Modify: `packages/comment-assistant/src/pipeline.ts`、`runtime.ts`、`protocol.ts`、`fastpath.ts`
- Test: 各パッケージの単体テスト

**Interfaces:**

- 有害判定:
  - `ABUSIVE_THRESHOLD` を 0.8 にする。
  - 判定の基準値は、チャンネルごとのフィードバックで調整できるようにする（下記）。
  - Task 6 のフィルターの既定値で、`abusive` を `'hide'` ではなく `'blur'` にする（この計画の Task 6 の既定値を合わせて変更する）。
- 翻訳の品質:
  - system プロンプトに「訳文だけを出す。注釈、かっこ書き、原文の繰り返し、マークアップは出さない」を加える。
  - 文法で `ja` に `<` と `>` を含めない。
  - パース後に、訳文の末尾に付いた `(原文)` や `（注: …）` の形を取り除く（原文と同じ文字列のかっこ書きだけを対象にする）。
- 日本語の判定（`scriptLanguageGuess`）:
  - 漢字だけの文でも、全角の `ｗ`、全角の `！？`、日本語に特有の記号（`ー`、`々`、`〜` など）を含めば `ja` とする。
  - 漢字＋半角の `w` で終わる短い文（例: `反対側w`）も `ja` とする。
- 非表示にしたコメントの記録（`feedback.ts`）:
  - `HiddenEntry = { id, site, channel, text, translation?, category, abusive?, at }`
  - パイプラインは、`abusive`・`spam`・`spoiler` に分類したコメントを、チャンネルごとに直近 200 件まで記録する（メモリ上。古い順に入れ替え）。
  - `FeedbackStore`（`chrome.storage.local`。全体で最大 1,000 件、古い順に入れ替え）:
    - `record({ site, channel, text, category, abusive?, verdict: 'ok' | 'correct', at })`
    - `allowlist(site, channel): Set<string>`（`verdict: 'ok'` にした文の正規化済みテキスト）
    - `corrections(site, channel, limit = 5)`（新しい順の「問題なし」の例。分類プロンプトの、チャンネルごとの文脈部分に入れる）
    - `threshold(site, channel)`: 「問題なし」にした Clef の確率の平均が 0.8 以上で 3 件以上あれば、そのチャンネルの基準を 0.9 に上げる（上限 0.95）。
    - `export(): string`（JSONL。1 行 1 件、原文・訳・分類・確率・判定・時刻。投稿者名は入れない）
  - パイプライン:
    - 許可リストにある文は、分類の結果にかかわらず `chatter` にする（キャッシュより先に確認する）。
    - 「問題なし」にしたら、テキストキャッシュの該当エントリを消す。
- メッセージ（`commentProtocol` に追加）:
  - `'comments/hidden'`: `{ site, channel }` → `HiddenEntry[]`
  - `'comments/feedback'`: `{ site, channel, id, verdict }` → `{}`。`'ok'` のときは、その id を表示に戻す注釈を、記録したフレームに送る（Task 6 の content script が受け取る）。
  - `'comments/export'`: `{}` → `{ jsonl: string }`

- [ ] **Step 1: 失敗するテストを書く**
  - しきい値: 0.79 は攻撃的にしない、0.8 は攻撃的にする。
  - プロンプト: system に新しい指示が入る。文法の `ja` 規則が `<` と `>` を除外する。かっこ書きの原文を取り除く表（取り除く例と、残す例）。
  - 日本語の判定の表: `倍以上ｗ`、`反対側w`、`3回行動！？`、`三回行動！` → ja。`你好世界` → zh のまま。
  - フィードバック: 記録の上限（200 件、1,000 件）、許可リスト、corrections の順序、しきい値の調整、export に投稿者名が含まれないこと。
  - パイプライン: 許可リストにある文は `chatter` になる。`'comments/feedback'` の `ok` で、表示に戻す注釈が送られ、キャッシュが消える。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test` と `pnpm --filter @chrome-toolbox/comment-assistant test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: 上記と、3 本の拡張の `test:e2e`、`pnpm test:tools -- tools/bench`、`pnpm check`
  - Expected: PASS
- [ ] **Step 5: 実機で確認する**
  - 記録済みのコメントを再生して、攻撃的と判定される件数と、訳文の注釈やタグの件数が減ったことを確かめる。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(comment-assistant): calibrate abuse judgments, clean translations and learn from local feedback"`

### Task 6: サイトアダプター（DOM の読み取りと表示の切り替え）

**Files:**

- Create: `packages/comment-assistant/src/sites/types.ts`
- Create: `packages/comment-assistant/src/sites/youtube-live-chat.ts`
- Create: `packages/comment-assistant/src/sites/youtube-comments.ts`
- Create: `packages/comment-assistant/src/sites/twitch-chat.ts`
- Create: `packages/comment-assistant/src/display.ts`
- Create: `packages/comment-assistant/src/entrypoints/chat.content.ts`
- Create: `packages/comment-assistant/test/fixtures/{youtube-live-chat,youtube-comments,twitch-chat}.html`
- Modify: `packages/comment-assistant/wxt.config.ts`（content script の matches）
- Test: `packages/comment-assistant/test/unit/sites.test.ts`
- Test: `packages/comment-assistant/test/unit/display.test.ts`

**Interfaces:**

- Consumes: Task 5 の `RawComment`、`Annotation`、`commentProtocol`
- Produces:
  - `SiteAdapter = { site: 'youtube' | 'twitch'; matches(url: URL): boolean; channel(doc: Document): string | undefined; container(doc: Document): Element | null; read(node: Element): RawComment | undefined; messageElement(root: Element, id: string): HTMLElement | null }`
  - `observeComments(adapter: SiteAdapter, doc: Document, onBatch: (comments: RawComment[]) => void): () => void`
    - コンテナに対して、`childList` の監視を 1 つだけ登録する。
    - コンテナが差し替わったら、`document.body` の浅い監視で付け替える。
    - 戻り値の関数で、すべての監視を解除する。
    - 既存のコメントは、初回に 1 回だけまとめて読む。
  - `applyAnnotations(root: Element, adapter: SiteAdapter, annotations: Annotation[], filters: FilterSettings): void`
    - メッセージ要素に `data-ca-category`、`data-ca-mode="show|highlight|blur|hide"`、`data-ca-label` を付ける。
    - 翻訳はテキストノードだけを差し替える。原文は `WeakMap<Text, string>` に保持する。
    - `filters.showOriginal` が true なら、原文を表示する。
    - 注釈に `override: 'show'` があれば（Task 5c の「問題なし」）、フィルター設定にかかわらず `data-ca-mode="show"` にし、隠す・ぼかすを解除する。
  - `injectStyles(doc: Document): () => void`
    - 次のスタイルを 1 つの `<style>` で注入する。
      - hide: 本文を隠し、`::before` に `非表示: attr(data-ca-label)` を表示する。クリックで `data-ca-revealed` を付ける。
      - blur（伏せる）: カテゴリの色の帯。子要素は `visibility: hidden`（行の高さは保ち、クリックは行に当たり、読み上げにも出ない）にし、`::before` に「伏せたコメント（attr(data-ca-label)）· クリックで表示」を表示する。クリックで `data-ca-revealed` を付ける（判断 R51。当初は `filter: blur(4px)` だったが、多くの行で描画を飽和させるため R45 でやめた）。
      - highlight: カテゴリ色の左ボーダーと背景
    - クリックは、コンテナに委譲した listener 1 つで受ける。
  - `FilterSettings = Readonly<{ translate: boolean; showOriginal: boolean; modes: Record<CommentCategory, 'show' | 'highlight' | 'blur' | 'hide'> }>`
    - 既定値: `abusive: 'blur'`（Task 5c で変更。フィードバックで精度が確認できるまで隠さない）、`spam: 'hide'`、`spoiler: 'blur'`、`question: 'highlight'`、`important: 'highlight'`、`chatter: 'show'`
  - manifest の `content_scripts`:
    - YouTube のライブチャット（iframe）: `https://www.youtube.com/live_chat*`、`https://www.youtube.com/live_chat_replay*`。`allFrames: true`
    - YouTube のコメント欄: `https://www.youtube.com/watch*`
    - Twitch: `https://www.twitch.tv/*`
    - 1 つのエントリポイントで、URL によってアダプターを選ぶ。
- [ ] **Step 0: DOM の調査**
  - 実際のページの DOM を取得し、fixture HTML を作る。取得には chrome-devtools MCP の `evaluate_script`、または DevTools を使う。
  - fixture は、メッセージ 5〜10 件分に絞る。本文と名前は、すべて自作の文に置き換える。
  - セレクターの候補（実際の DOM で確認する）:
    - YouTube のライブチャット: `yt-live-chat-text-message-renderer`（`#author-name`、`#message`、属性 `id`）
    - YouTube のコメント: `ytd-comment-thread-renderer`（`#content-text`）
    - Twitch: `[data-a-target="chat-line-message"]` または `.chat-line__message`（`[data-a-target="chat-message-text"]`）
  - セレクターは各アダプターの先頭に定数としてまとめる。
- [ ] **Step 1: 失敗するテストを書く**
  - jsdom で fixture を読み込んで検証する。

```ts
it.each([
  ['youtube-live-chat', 'youtube', 5],
  ['youtube-comments', 'youtube', 3],
  ['twitch-chat', 'twitch', 5],
])('%s adapter reads every fixture message', (fixture, site, count) => {
  /* read() の件数・id・text */
});
it('observeComments reports appended messages once and disconnects on cleanup', async () => {
  /* append 2 → onBatch 1回 2件、cleanup 後 append → 呼ばれない */
});
it.each([
  { category: 'spam', mode: 'hide' },
  { category: 'abusive', mode: 'blur' },
  { category: 'spoiler', mode: 'blur' },
  { category: 'question', mode: 'highlight' },
])('applies $mode to $category', ({ category, mode }) => {
  /* data-ca-mode */
});
it('swaps only text nodes and restores the original exactly', () => {
  /* innerHTML が元と一致（リンク・絵文字 img を保持） */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/comment-assistant test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `chat.content.ts` は `defineContentScript` を使い、`main(ctx)` の中で次を行う。
    - アダプターを選ぶ。
    - `injectStyles` と `observeComments` を起動する。
    - 受け取ったコメントを `commentProtocol.send(…'comments/ingest')` で送る。
    - `browser.runtime.onMessage` で注釈を受けて、`applyAnnotations` で反映する。
    - フィルター設定を `storage.onChanged` で受け取る。
  - すべての後片付けは `ctx.onInvalidated` に登録する。
  - YouTube の SPA の遷移（`yt-navigate-finish`）では、チャンネルを読み直し、監視をやり直す。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/comment-assistant test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(comment-assistant): site adapters and in-chat display control"`

### Task 7: サイドパネル（フィルター、非表示の見返し、設定）と配信の文脈

背景（2026-10-28 までの決定）:

- 判断 R24: 非表示にしたコメントをサイドパネルで見返し、「問題なし」で表示に戻し、「正しい」で確認できるようにする。フィードバックは端末の中だけに保存し、JSONL で書き出せる。処理部分（`comments/hidden`、`comments/feedback`、`comments/export`、`comments/feedback/clear`。拡張の画面からだけ呼べる）は Task 5c で実装済み。
- 判断 R29: フィルター設定とフィードバック（許可リスト、訂正例、しきい値）は、配信ではなく配信者（チャンネル）単位で持つ。コメントの記録と要約は、配信ごとの区画（チャットは `<videoId>`、動画のコメントは `<videoId>#comments`）のままにする。
- Task 5b からの持ち越し: テキストキャッシュのキーに、配信者と文脈の識別子を含める（文脈によって分類が変わるため）。
- 判断 R25 (d): 配信タイトルを分類と翻訳の文脈に入れて、固有名詞の誤訳を減らす。

**Files:**

- Create: `packages/comment-assistant/src/filters.ts`、`packages/comment-assistant/src/stream-context.ts`
- Create: `packages/comment-assistant/src/entrypoints/sidepanel/App.tsx`、`SummaryTab.tsx`（Task 8 の中身が入るまでは空の状態の表示）、`FilterTab.tsx`、`HiddenTab.tsx`、`SettingsTab.tsx`
- Modify: `packages/comment-assistant/src/entrypoints/sidepanel/main.tsx`、`src/chat.ts`、`src/runtime.ts`、`src/pipeline.ts`、`src/protocol.ts`
- Test: `test/unit/filters.test.ts`、`test/unit/stream-context.test.ts`、`test/unit/sidepanel.test.tsx`

**Interfaces:**

- 配信の文脈（`stream-context.ts`）:
  - `StreamContext = { site; partition; streamer?: string; title?: string; spoilerNote?: string }`
    - YouTube の視聴ページ（トップのフレーム）から、配信者のチャンネル ID（`<meta itemprop="channelId">` などの DOM から）とタイトルを読む。ライブチャットの iframe は動画 ID しか分からないので、background が動画 ID と文脈の対応表を持つ（上限付き、最大 16 件）。
    - Twitch は URL のチャンネル名を配信者とし、タイトルはページから読む。Twitch の画面内での移動（チャンネルの切り替え）にも追従する（Task 6 からの持ち越し）。
  - content script → background: `'comments/context'`（`{ site, partition, streamer?, title? }` → `{}`）。視聴ページの読み込み時と画面遷移時に送る。
  - パイプラインの `context(site, partition)` は、タイトルとネタバレ対象（サイドパネルで手入力）を返す。
  - フィードバックの許可リスト、訂正例、しきい値は、`streamer` が分かればそれを、分からなければ区画をキーにする。
  - テキストキャッシュのキーは、`streamer`（なければ区画）と文脈の短いハッシュと、正規化した本文を組み合わせたものにする。
- フィルター（`filters.ts`）:
  - `filterStore(area)`: `load(site, streamer)` / `save(site, streamer, settings)`。キーは `filters:<site>:<streamer>`。未保存なら既定値（Task 6、`abusive: 'blur'`）。
  - content script は、現在の配信者のフィルターを読み、`storage.onChanged` で反映する（Task 6 の仕組みを配信者キーに合わせる）。
- サイドパネル（モック B に合わせる）:
  - タブは「要約」「フィルター」「非表示」「設定」。
  - 現在のタブの配信は、`tabs.query({ active: true, currentWindow: true })` と、background の対応表から求める。
  - 「非表示」タブ:
    - `comments/hidden` の一覧（原文、訳、理由、Clef の確率、時刻）。
    - 行ごとに「問題なし」「正しい」ボタン。`comments/feedback` の `persisted: false` のときは「あとで保存します」と表示する。
    - 「書き出す（JSONL）」は、ファイルとして保存させる（`URL.createObjectURL` と `<a download>`。サイドパネルは拡張の画面なので使える）。
    - 「フィードバックを消去」は確認を挟んでから `comments/feedback/clear` を呼ぶ。
  - 「フィルター」タブ: カテゴリごとの表示方法（表示、ハイライト、伏せる、隠す）、翻訳のオン・オフ、原文の表示、ネタバレ対象の入力。配信者単位で保存する。
  - 「設定」タブ: 既存の `ConnectionPanel`、モデル名（翻訳、Clef）、Clef が使えるかの表示（stats の `judge`）。
- [ ] **Step 1: 失敗するテストを書く**
  - `filterStore` の往復と、未保存時に既定値が返ること。
  - 文脈: 視聴ページの DOM の fixture から配信者とタイトルを読む。対応表の上限。キャッシュのキーが配信者と文脈で分かれること。フィードバックが配信者単位で効くこと（同じ配信者の別の配信でも許可リストが効く）。
  - サイドパネル（Testing Library）: 「ネタバレ」を「隠す」に変えると `save` が呼ばれる。「非表示」タブで「問題なし」を押すと `comments/feedback` が呼ばれ、その行が消える。書き出しとフィードバックの消去。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: comment-assistant の `test` と `test:e2e`、`pnpm check`
- [ ] **Step 5: Commit**
  - `git commit -m "feat(comment-assistant): side panel for filters, hidden-comment review and settings with stream context"`

### Task 5d: 高速なチャットでの分類の精度（判断 R31）

背景（2026-10-29 のストレステスト。視聴者約 3 万人の Twitch 配信を 15 分間）: 抜き取って確認した結果、攻撃的は 19 件中 14 件が正しかったが、スパムは 19 件中 6 件、ネタバレは 7 件中 0 件しか正しくなかった。スパムの誤りは、ティア投票の「S」や「#PR」いじり。ネタバレの誤りは、ネタバレ対象を設定していない配信でのティア表の予想。

**Files:**

- Modify: `packages/comment-assistant/src/fastpath.ts`、`src/pipeline.ts`、`src/display.ts`（既定値）、`packages/extension-core/src/prompts.ts`
- Test: 対応する単体テスト

**Interfaces:**

- ネタバレ: 配信にネタバレ対象（`spoilerNote`）がないときは、モデルが `spoiler` と返しても `chatter` にする。プロンプトには、ネタバレ対象があるときだけネタバレの定義を入れる。キャッシュのキーは既存の文脈ハッシュで分かれる。
- ルール判定（`trivialVerdict` の拡張）:
  - 1〜2 文字のティアや評価の投票（`S`、`A+`、`SS`、`B`、`5`、`10点` など。全角も含む）→ `chatter`
  - 短いハッシュタグだけの文（`#PR`、`＃pr`。16 文字以下）→ `chatter`
- コピペの検出（新規 `isCopypasta(text)`）: 同じ 2 文字以上の語句が 1 つのコメントの中で 3 回以上続けて繰り返される場合は、モデルを呼ばずに `spam` と判定する（判定の理由を `rule` として hidden の記録に残す）。
- 表示の既定値: モデルだけでスパムと判定したもの（`rule` でないもの）は `'blur'`、ルールで判定したコピペは `'hide'`。`Annotation` に判定元（`source: 'rule' | 'model' | 'clef'`）を足し、content script は判定元に応じて既定の表示を選ぶ。ユーザーが「フィルター」タブで設定した表示は、判定元にかかわらず優先する。

- [ ] **Step 1: 失敗するテストを書く**（ティア投票、ハッシュタグ、コピペの表。ネタバレ対象がないときの `spoiler` → `chatter`。判定元ごとの既定の表示）
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**（comment-assistant と extension-core の `test`、3 本の拡張の `test:e2e`、`pnpm check`）
- [ ] **Step 5: 実機で確認する**（ストレステストで記録したログを、ローカルで再生して、spam と spoiler の件数の変化を数える。チャットの本文はレポートに書かない）
- [ ] **Step 6: Commit** — `git commit -m "feat(comment-assistant): rule out tier votes and hashtag memes, detect copypasta and gate spoilers on a note"`

### Task 5e: 実配信での表示の精度（判断 R38）

背景（2026-10-29 の実配信テスト。Twitch の英語配信［約 2 万人］、Twitch の日本語配信、YouTube の VTuber の配信［英語・スペイン語］、YouTube の日本語配信。各 8 分）:

- メンションの二重表示: `@name …` の訳にメンションが含まれ、残したメンションの要素と並んで `@name@name` と表示された。
- 訳に注記が付く:
  - `LO (Laugh Out Loud)`
  - `ドンマイ (Donmai) (気にしないで)`
  - `いけー！/がんばれ！/わーい！ (depending on context)`
  - `<原文> (<訳>)`（原文の後ろに括弧で訳）
- 掛け声やエモートをカタカナにする: `VAMOS` → `ワモース`、`PauseChamp` → `ポーズチャンプ`。誤った訳がキャッシュで広がる。
- 質問の判定が広すぎる: 依頼、指示、提案（`do one more`、`switch to the other map`、`need more power`）まで質問としてハイライトされた。英語の配信では、ハイライトの約半分が誤りだった。
- 配信者のチャンネルからの自動投稿（再生中の動画へのリンク）がスパムとしてぼかされた。
- 期限切れで原文のまま残ったコメントは、質問（末尾が `?`）でもハイライトされない。

**Files:**

- Modify:
  - `packages/comment-assistant/src/display.ts`（訳からメンションとリンクの文字列を除く）
  - `packages/extension-core/src/prompts.ts`（システム文、訳の後処理）
  - `packages/comment-assistant/src/pipeline.ts`、`src/fastpath.ts`
  - `src/sites/*.ts`（投稿者の役割）、`protocol.ts`
- Test: 対応する単体テスト、`test/fixtures/*`（役割のバッジを足す）

**Interfaces:**

- メンションの重複:
  - `translate()` は、`keep` に当たる要素（メンション、リンク）の文字列が訳の中にあれば取り除き、空白を詰めてから書き込む。
  - 取り除いた結果が空なら、原文を残す。
- 訳の後処理（`cleanTranslation`、既存の後処理に足す）:
  - 原文に括弧がないのに訳の末尾に付いた括弧書きは、次の場合に取り除く:
    - ローマ字の読み（ASCII だけ）
    - `depending on context` のような注記
    - 原文の繰り返し
  - 原文がそのまま入り、その後ろに括弧で訳が続く形（`<原文> (<訳>)`）は、括弧の中の訳だけにする。
  - `A/B/C` の言い換えの列挙は、最初の 1 つにする。
- システム文（固定のまま。キャッシュのため、配信ごとの部分には入れない）に足す:
  - 訳だけを出す（注記、読み、ローマ字、言い換え、原文は書かない）。
  - エモートの名前（`PauseChamp`、`KEKW` のような CamelCase の 1 語）、@メンション、URL は訳に含めない。
  - 掛け声は意味で訳す（`vamos` → `いけー！`）。人名や固有名詞以外を、カタカナの音写にしない。
- 質問:
  - 定義を「答えや情報を求める文」にする。依頼、指示、提案、推測、感嘆は、配信者宛てでも chatter とする。
  - ラテン文字のコメントは、次のどちらかに当てはまらなければ chatter にする（日本語のコメントには適用しない）:
    - `?`／`？` を含む
    - 疑問詞で始まる（who, what, when, where, why, how, which, is, are, am, do, does, did, can, could, would, will, should, have, has; qué, cómo, cuándo, dónde, por qué, quién）
- 投稿者の役割:
  - アダプターは、投稿者の役割を `role?: 'owner' | 'moderator' | 'verified'` として読む。
    - YouTube: メッセージ要素の `author-type` 属性（`owner`、`moderator`、`member`）と、認証済みのバッジ。
    - Twitch: 配信者とモデレーターのバッジ。
  - `owner`、`moderator`、`verified` のコメントは、abusive・spam・spoiler にしない。
    - モデルが spam と判定したか、URL を含む場合は `important`。
    - それ以外はモデルの判定のまま。
- 期限切れのコメント: モデルに届かずに期限が切れたコメントのうち、`?`／`？` で終わるものは、ルールで `question` にする（翻訳はしない）。

- [ ] **Step 1: 失敗するテストを書く**（各項目の表。メンションの二重表示は display のテストで、DOM に `@name` の要素と訳を置いて確かめる）
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**（comment-assistant と extension-core の `test`、comment-assistant の `test:e2e`、`pnpm check`）
- [ ] **Step 5: 実機で確認する**（記録した実配信のコメントをローカルで再生し、注記、カタカナ化、質問の件数を前後で比べる。チャットの本文はレポートに書かない）
- [ ] **Step 6: Commit** — `git commit -m "fix(comment-assistant): clean live-stream translations, narrow questions and trust the streamer's own posts"`

### Task 5f: 英語の速いチャットでの処理量（判断 R39）

背景（同じテスト）:

- 英語の Twitch 配信（毎秒約 3 件）では、処理が追いつかず約 3 割が原文のまま期限切れになり、表示までの p50 が 3.45 秒になった（目標は毎秒 10 件まで p50 2 秒以内）。
- 内訳:
  - Clef は 1 件ごとに約 0.25〜0.3 秒 GPU を使い、GPU 時間の約半分を占めた。
  - 1 語だけのコメントが全体の 40〜54% を占めた（`YES`、`HOLD`、`PauseChamp`、`VAMOS` のような反応、エモート、掛け声）。
  - 同時に 2 件を推論すると、合計の生成速度は 1 件のときの約 1.55 倍（75 → 115 トークン/秒）になる。1 件ごとは約 2 割遅くなる。

**Files:**

- Modify:
  - `packages/comment-assistant/src/fastpath.ts`（エモートと 1 語のコメント）
  - `packages/comment-assistant/src/pipeline.ts`（Clef を省く条件）
  - `docs/llama-server.md`（`--parallel 3`、`ctx-size`）、`docs/adoption.md`（測定値）
- Test: `test/unit/fastpath.test.ts`、`test/unit/pipeline.test.ts`

**Interfaces:**

- エモート:
  - 自作の一覧 `TWITCH_EMOTES`（Twitch、BTTV、FFZ、7TV のよく使われる名前を約 100 語）を用意する。
  - 一覧の語、笑い、既存の定型の反応だけでできたコメントは、ルールで `chatter`、訳なし。モデルも Clef も呼ばない。
- 1 語のコメントでは Clef を呼ばない:
  - 対象は、ラテン文字だけでできた 1 語（伸ばしを詰めて 15 文字以下）。
  - 自作の短い罵倒語の一覧（英語・スペイン語、20 語程度）に当たる語だけは、Clef に送る。
  - それ以外は、モデルの判定（翻訳と分類）だけで決める。
- サーバーの推奨設定:
  - `--parallel 3`。字幕にスロット 0、コメントにスロット 1 と 2 を使う。既存の `setServerSlots` で 2 並列になる。
  - Gemma の `ctx-size = 12288`（1 スロット 4,096 を保つ）。
  - 字幕の遅延を `pnpm bench:slots` で測り、`docs/adoption.md` に記録する。

- [ ] **Step 1: 失敗するテストを書く**（エモートだけのコメントがモデルにも Clef にも行かない。1 語のコメントは Clef に行かず、罵倒語の一覧に当たる語は行く。3 スロットのサーバーでバッチが 2 並列になる［既存のテストがあれば流用］）
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
- [ ] **Step 5: 実機で確認する**（`--parallel 3` のサーバーで、記録した英語チャットを再生して、期限切れの割合と p50 を前後で比べる。`bench:slots` で字幕の遅延を測る）
- [ ] **Step 6: Commit** — `git commit -m "perf(comment-assistant): skip emotes and lone words past Clef and run two batches on a three-slot server"`

### Task 5g: Clef を呼ぶコメントを絞る（判断 R43）

背景（2026-10-29 の測定）:

- Clef（約 6.7 GB）は、プロンプト全体を毎回 1 回で評価するため、前の要求の結果を使い回せない。1 件ごとに約 0.25〜0.3 秒 GPU を使う。
- Task 5f の後も、英語の速いチャットでは約 2 割が期限切れになった。
- 実配信の記録で調べた結果:
  - Gemma の分類だけでは、Clef が攻撃的とした日本語のコメントの 47%、英語の 27% しか拾えない。
  - 「Gemma が abusive と判定した」か「罵倒語の手がかりを含む」の組み合わせなら、日本語の 90%、英語の 86% を拾う。拾わなかったのは、ほとんどが Clef の誤検出だった（食べ物を褒める言い方、ゲームの指示、相手のいない汚い言葉）。
  - Clef に送るのは、普通のコメントの約 4% になる。

**Files:**

- Modify:
  - `packages/comment-assistant/src/fastpath.ts`（罵倒語の手がかり。Task 5f の罵倒語の一覧を広げる）
  - `packages/comment-assistant/src/pipeline.ts`（Clef を呼ぶ条件と順序）
  - `src/protocol.ts`（`clefSkipped` の説明）
  - `README.md`、`docs/adoption.md`
- Test: `test/unit/fastpath.test.ts`、`test/unit/pipeline.test.ts`

**Interfaces:**

- `hasAbuseCue(normalized: string): boolean`:
  - 自作の罵倒語の手がかり（日本語、英語、スペイン語）を 1 つでも含むか。日本語は部分一致、英語とスペイン語は語単位で一致させる。
  - 長音、伸ばし、全角、アクセント、スペイン語の -a と -o の違いは吸収する。
  - 一覧は、侮辱語、死や暴力を求める語、差別語の代表的なものを含める。
- Clef を呼ぶ条件:
  - 手がかりがあるコメントは、今と同じくバッチと並行して Clef に送る。
  - 手がかりがないコメントのうち、モデルが `abusive` と判定したものは、その返事の後で Clef に送る。表示は Clef の結果を待つ。
  - それ以外は Clef を呼ばない。モデルの判定がそのまま決まる。
  - 役割（配信者、モデレーター、認証済み）の扱いは変えない。
- `clefSkipped` は「Clef を呼ばずに決めたコメントの数」とする。
- Task 5f のレビューで出た小さな修正をあわせて行う:
  - 笑いの反応は、伸ばしを詰めてから既存の訳（`lol` → （笑） など）を使う。
  - スペイン語の女性形。
  - 先頭の ¡ と ¿。
  - 罵倒語とほかのコメントが混ざったバッチで Clef が失敗したときのテスト。
  - 笑いの語を名前に持つメンション（`@xdd` など）は、ルールのチャットにしない。
  - 文書のずれ: `summary.ts` の説明、設計書とグローバル制約の「スロット 1」、1.55 倍の数値を `docs/adoption.md` に記録する。

- [ ] **Step 1: 失敗するテストを書く**
  - `hasAbuseCue` の表。
  - 手がかりのないコメントは Clef に行かない。
  - モデルが `abusive` としたコメントだけが、後から Clef に行き、Clef の点数で決まる。
  - 手がかりのあるコメントは、並行して Clef に行く。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**（comment-assistant と extension-core の `test`、comment-assistant の `test:e2e`、`pnpm check`）
- [ ] **Step 5: 実機で確認する**
  - 記録した英語のチャットを、3 スロットのサーバーで再生する。期限切れの割合、p50 と p95、Clef の呼び出し回数を前後で比べる。
  - 日本語の記録（攻撃的と判定された集合）で、拾える割合を確かめる。
- [ ] **Step 6: Commit** — `git commit -m "perf(comment-assistant): ask Clef only about comments with an abuse cue or an abusive model verdict"`

### Task 5h: 前面に出ているものだけを処理する（判断 R44）

背景（2026-10-29）:

- `sites/observe.ts` は、タブが裏にあってもコメントが流れるように、タイマーで送っている。
- そのため、見ていないタブの配信も翻訳と有害判定を続け、前面の配信と GPU を取り合う。
- ユーザーの方針: 前面に出ているものだけ処理すればよい。

**Files:**

- Modify:
  - `packages/comment-assistant/src/sites/observe.ts`、`src/chat.ts`（表示状態と画面内の判定）
  - `src/protocol.ts`（取り込みのモード）
  - `src/pipeline.ts`（保存だけのコメントと、待ち行列の破棄）
  - `src/summary.ts`（保存だけのコメントの扱い）
  - `README.md`
- Test: 対応する単体テストと e2e

**Interfaces:**

- 裏のタブと隠れたチャット:
  - 対象は次の 2 つ:
    - タブが裏にある、またはウィンドウが最小化されている（`document.visibilityState === 'hidden'`）。
    - チャット欄が画面に出ていない（チャットを閉じた、折りたたんだ。コンテナを `IntersectionObserver` で見る）。
  - その間、コメントは読んで保存するが、モデルにも Clef にも送らない。取り込みに `process: false` を付ける。
  - 保存だけのコメントは `state: 'stored'` にする。
  - チャットが前面から外れたとき（`left: true`。`leave()` だけが送る）、そのフレームだけが宛先の待ち行列（まだモデルに渡していないもの）を、すぐに `stored` として外す。前面にある別のフレームのコメントは外さない（判断 R49）。
  - 前面にあるチャットの画面外の行は、保存だけにする。待ち行列は外さない。
- 前面に戻ったとき:
  - 画面に出ている行のうち、まだ結果のないもの（外されたものも含む）を、新しい順に処理する。
  - 画面に出ていない、保存だけのコメントは翻訳しない。
- 動画のコメント（視聴ページの下）は、画面の近く（`rootMargin` 1 画面分）に来たものだけを処理する。
- 要約:
  - 件数と盛り上がりには、保存だけのコメントも数える。
  - モデルに渡す行には、保存だけのコメントの原文を入れてよい（日本語以外も原文のまま）。
  - 期間中に保存だけのコメントがあったことを、要約に `unprocessed: number` として返す。
  - サイドパネルに「画面に出ていなかった N 件は未翻訳」と表示する。
- stats に `stored: number`（保存だけのコメントの数）を足す。

- [ ] **Step 1: 失敗するテストを書く**
  - 表示状態が hidden の間、取り込みは `process: false`。モデルと Clef の呼び出しは 0。
  - hidden になったとき、その配信の待ち行列が `stored` になる。
  - 前面に戻ると、画面に出ている行だけが新しい順に送られる。
  - チャット欄が画面外のときも同じ扱い。
  - 要約が保存だけのコメントを数え、`unprocessed` を返す。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**（comment-assistant と extension-core の `test`、comment-assistant の `test:e2e`、`pnpm check`）
- [ ] **Step 5: 実機で確認する**
  - 配信を 2 つのタブで開き、片方を裏にする。裏のタブのモデルと Clef の呼び出しが 0 になることを、サーバーへの要求数で確かめる。
  - 前面のタブの p50 を、2 つとも処理していたときと比べる。
- [ ] **Step 6: Commit** — `git commit -m "perf(comment-assistant): process only the chat in front of the viewer"`

### Task P: プロファイルに基づく削減（判断 R45）

背景（2026-10-30 のプロファイル。詳細は SDD のワークスペースと scratchpad の report.md）:

- `filter: blur` は、多くの行をぼかすと描画を飽和させる。50 件/秒で全行をぼかしたとき、メインスレッドは 926 ms/s、表示のままなら 225 ms/s。
- YouTube のアダプターは、行ごとに同じ id（`#message`）を持つ DOM で `querySelector` を使う。これが実配信で content script の JS の 69%（676 µs/コメントのうち 466 µs）を占めた。
- 表示の書き込みが、ページ自身の描画とは別に毎回描画を起こす（+2.7〜4.3 回/秒のレイアウト）。
- 要約で、記録ごとに約 7 回正規化する（1 回あたり 165〜200 ms の長いタスク）。
- `isCopypasta` は文字数の 2 乗で遅くなる（1,000 文字で 6.7〜17.6 ms）。
- 効果がなかったもの（行わない）:
  - TreeWalker の置き換え
  - rAF でのまとめ書き
  - 画面外の行の DOM 処理の省略
  - background の zod の省略
  - 文法の再利用
  - 送るデータの縮小

**Files:**

- Modify:
  - `packages/comment-assistant/src/display.ts`
  - `src/sites/youtube-live-chat.ts`、`src/sites/twitch-chat.ts`
  - `src/chat.ts`、`src/summary.ts`、`src/fastpath.ts`
- Test: 単体テスト、ブラウザーの性能テスト（`test/browser/perf.spec.ts`）

**Interfaces:**

1. ぼかしの置き換え:
   - `filter: blur` をやめる。文字を透明にし、`text-shadow` でぼかしたように見せる。エモートの画像は薄くする。
   - 50 件/秒で全行をぼかしたとき、メインスレッドの時間と GPU が「表示」の 1.2 倍以内であること。
   - 満たせなければ、単色の背景で隠す。
2. YouTube のアダプター:
   - `#message` と `#author-name` を、行の子要素をたどって探す（`#content` → `#message`）。
   - または、`read()` で見つけた要素を WeakMap に覚える。
3. 表示の書き込み:
   - background からの結果は、すぐに書かずにためておく。
   - ページの次の変更（MutationObserver の呼び出し）か、100 ms のタイマーのうち早い方でまとめて書く。
4. 要約:
   - 記録ごとの正規化を 1 回にする。
   - `partsOf` は 1 回の要求で 1 回だけ作る。
5. `isCopypasta`:
   - 6 文字の並びを O(n) で数える。3 回以上出る並びがなければ false。
   - 3 回以上出る並びの開始位置だけを調べる。
   - 結果は今と同じであること（性質テストで確かめる）。
6. Twitch:
   - `observeComments` が見つけたコンテナを使い、バッチごとに探し直さない。
   - `read()` で見つけた行を id → WeakRef で覚え、`messageElement` でコンテナを走査しない。
7. content script の zod:
   - `onPing` は、`type` を先に見てから decode する。
   - `roleNamed` は、zod の enum ではなく Set を使う。
8. 隠す表示のルール（`[data-ca-mode="hide"]…>*`）:
   - 隠す行にだけ付ける別の属性に変える。モードの書き込みのたびに子孫を無効化しないようにする。
9. `keptPattern`: 残す要素の文字列ごとに、コンパイルしたものを覚える（上限付き）。

- [ ] **Step 1: 失敗するテストを書く**
  - 性能テスト（`perf.spec.ts`。50 件/秒）:
    - 全行をぼかしたとき、メインスレッドの時間が「表示」の 1.2 倍以内。
    - レイアウトの回数が、拡張なしの 1.05 倍以内。
  - YouTube のアダプター: 同じ id が 250 行あり、行が出入りする DOM で、`read()` と `textElement()` が 1 行 10 µs 未満。
  - `isCopypasta`: 新旧の結果が一致する性質テストと、1,000 文字で 0.2 ms 未満のベンチ。
  - 要約: 5,000 件で、今より速いこと（余裕を持った上限）。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**（comment-assistant と extension-core の `test`、comment-assistant の `test:e2e`、`pnpm check`）
- [ ] **Step 5: プロファイルを取り直す**（同じ fixture と同じ手順。前後の表を `docs/adoption.md` に記録する）
- [ ] **Step 6: Commit** — `git commit -m "perf(comment-assistant): cheaper concealment, adapter lookups and batched display writes"`

### Task 5i: 判定してからチャットに流す（判断 R52）

背景（2026-11-02 の実配信テスト。視聴者約 3 万人の日本語の Twitch 配信、毎秒約 6.5 件）:

- 伏せたコメント 47 件は、伏せるまでに中央値 0.79 秒、最大 4.9 秒、そのまま見えていた。
- 0.3 秒以内に伏せられたのは 13 件だけ。
- 流れが速いと、見えた後で伏せることになり、あまり意味がない。
- ユーザーの方針: 判定してからコメントを流す。メモリとリソースには気をつける。

**Files:**

- Modify:
  - `packages/comment-assistant/src/display.ts`、`src/chat.ts`
  - `src/filters.ts`（設定）
  - `src/entrypoints/sidepanel/FilterTab.tsx`、`text.ts`
  - `README.md`
- Test: 単体テスト、`test/browser/comments.spec.ts`

**Interfaces:**

- 判定待ちの行:
  - content script が新しい行を処理に回すとき、その行に `data-ca-wait` を付け、`display:none` で出さない。
    - 隙間ができないようにする。
    - サイトの DOM にある行をそのまま使い、コピーは作らない。
  - 結果（翻訳、カテゴリ、表示方法）を書くときに `data-ca-wait` を外す。
  - 外す順番は、投稿の順にする。前の行が待っている間は、後の行も出さない。
  - 待つのは最大 2 秒。2 秒を過ぎた行は原文のまま出し、後で結果が来たら今と同じく書き換える。
  - ルールやキャッシュで即座に答えが出る行は、待たない。
  - 前面にない間（R44）に保存だけした行や、画面外の行は待たせない。
- スクロール:
  - サイトは新しい行を足したときに一番下へスクロールするが、待たせた行を出すときにはスクロールしない。
  - そのため、行を出す直前にチャット欄が一番下にあったなら、出した後も一番下に合わせる。ユーザーが上にスクロールして読んでいる間は動かさない。
- 上限: 待っている行の一覧は、最大 300 件。超えたら古いものから出す。
- 設定:
  - フィルターに `holdUntilJudged: boolean` を足す。既定は true。
  - フィルタータブのスイッチ「判定してから表示する（最大 2 秒）」。
  - false のときは今と同じ動作にする。
- llama.cpp につながらないとき（stats の `lastError`）は待たせない。

- [ ] **Step 1: 失敗するテストを書く**
  - 新しい行は、結果が来るまで出ない。結果が来ると出る。
  - 後の行の結果が先に来ても、前の行が出るまで出ない。
  - 2 秒で原文のまま出る。
  - ルールで答えが出る行は、すぐ出る。
  - 一番下にいるときは、出した後も一番下に合わせる。上にスクロールしているときは動かさない。
  - 設定が false なら待たない。
  - つながらないときは待たない。
  - 上限 300。
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**（comment-assistant と extension-core の `test`、comment-assistant の `test:e2e`、`pnpm check`）
- [ ] **Step 5: 実機で確認する**
  - YouTube と Twitch の速い配信で確かめる:
    - 伏せる行が一度も見えないこと（`data-ca-wait` が外れたときに、すでに伏せた状態になっている）。
    - 待ち時間の p50 と p95。
    - スクロールが一番下に保たれること。
    - ページのヒープと CPU を、今と比べる。
- [ ] **Step 6: Commit** — `git commit -m "feat(comment-assistant): let a comment into the chat once it is judged"`

### Task 5j: 実配信の再テストで見つかった精度の問題（判断 R60）

背景（2026-11-02 の実配信テスト）:

- 漢字だけの日本語（「主人公」「完璧」）が中国語と判定され、翻訳に回された。日本語の配信で、漢字だけの行 78 件のうち 58 件。同じ語がそのまま返るか、「時刻絵図」→「時刻表」のように崩れる。
- モデルだけがスパムとしたコメントの多くは、広告への不満（`L ADS`）や助言だった。英語の速い配信では 48 件のうち、リンクを含むものは 0 件。本当のスパム（配信者のボットのグッズや動画のリンク）は、リンクを含んでいた。
- 配信の企画名（「馬鹿凸」「バカ凸」）が、罵倒語の手がかりと Clef で攻撃的と判定された。
- 訳の後処理で、本文と同じ括弧書き（`TLです。 (TLです。)`）と、漢字語の後ろのかなの読み（`神風 (かみかぜ)`）が残った。
- 英語の感嘆（`WHAT??`、`UM????`）が質問としてハイライトされた。
- `isCopypasta` は長い文で遅い。繰り返しの単位の長さに上限を置くと速くなる（Rust の試作での測定）。

**Files:**

- Modify:
  - `packages/extension-core/src/language.ts`（チャンネルの言語の傾向）
  - `packages/comment-assistant/src/pipeline.ts`（スパムの判定、言語の判定）
  - `src/fastpath.ts`（手がかりの例外、感嘆、`isCopypasta`）
  - `packages/extension-core/src/prompts.ts`（訳の後処理）
- Test: 対応する単体テスト

**Interfaces:**

- 漢字だけの行:
  - 漢字（と数字、記号）だけでできた行は、そのチャンネルの直近 200 件のうち日本語が半数以上なら `ja` とする。翻訳はしない。
  - 傾向は、パイプラインがチャンネルごとに数える（上限付き）。
- スパム:
  - モデルの `spam` は、リンク（`https?://` か `www.`）を含む場合だけ残す。それ以外は `chatter`。
  - コピペのルールによる `spam` は、今のまま。
- 罵倒語の手がかりの例外:
  - `馬鹿凸`、`バカ凸`、`ばかとつ`、`バカとつ` を手がかりにしない。
  - 例外の一覧は、既存の無害な語の例外と同じ場所に置く。
- 訳の後処理:
  - 本文と同じ文の括弧書きを除く。
  - 原文の漢字語の読み（かなだけの括弧書き）が、その語の直後にある場合は除く。
- 感嘆:
  - ラテン文字の 1 語で、感嘆詞（`what`、`huh`、`um`、`uh`、`eh`、`wtf`、`omg`、`bruh`、`wait`）に `?` や `!` だけが付いたものは `chatter`。
  - `why?` のような疑問詞は質問のまま。
- `isCopypasta`:
  - 繰り返しの単位の長さに上限（コメントの長さの 1/3）を置き、結果は今と同じにする（性質テストで確かめる）。
  - 1,000 文字の英文で 0.1 ms 未満。

- [ ] **Step 1: 失敗するテストを書く**（各項目の表。実配信の文は使わず、自作の文で）
- [ ] **Step 2: 失敗を確認する**
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**（comment-assistant と extension-core の `test`、comment-assistant の `test:e2e`、`pnpm check`）
- [ ] **Step 5: 実機で確認する**
  - 記録した実配信のコメントで、次の件数を前後で比べる:
    - 漢字だけの行の翻訳
    - モデルのスパム
    - 括弧書きの残り
    - 感嘆の質問
  - チャットの本文はレポートに書かない。
- [ ] **Step 6: Commit** — `git commit -m "fix(comment-assistant): keep kanji-only Japanese untranslated and trust model spam only with a link"`

### Task 8: 要約（判断 R32）

背景（2026-10-29 の実測）: llama-server は 1 スロットあたり 4,096 トークンしか持たない（`--parallel 2`、ctx 8,192）。コメント 300 件をそのまま渡すと入りきらない。また、要約はコメントと同じスロット 1 を使うため、要約の推論中はコメントの処理が止まる。そこで、LLM に任せるのは「話題」「似た質問のまとめ」「盛り上がりの見出し」だけにし、件数・言語・山・重要コメントは保存済みのデータから数える。

**Files:**

- Create: `packages/comment-assistant/src/summary.ts`
- Modify: `packages/extension-core/src/prompts.ts`（`summaryPrompt` を行形式と GBNF に置き換える。`summaryOutputSchema` は削除）
- Modify: `packages/comment-assistant/src/pipeline.ts`（要約をバッチの合間にスロットで実行する `exclusive`）
- Modify: `packages/comment-assistant/src/protocol.ts`、`src/runtime.ts`（`'comments/summary'`。自動更新はサイドパネルが持つ。判断 R35）
- Modify: `packages/comment-assistant/src/entrypoints/sidepanel/SummaryTab.tsx`
- Test: `packages/comment-assistant/test/unit/summary.test.ts`、`packages/extension-core/src/prompts.test.ts`、`test/unit/sidepanel.test.tsx`

**Interfaces:**

- Consumes: Task 2 の `CommentStore.since`。Task 5b の `normalizeComment`。Task 5 のパイプライン（バッチのスロット管理）。
- Produces:
  - `Summary`（protocol の `summarySchema` を更新）:
    - `windowMinutes: 5 | 15 | 30`、`total`、`languages`（多い順の言語コード）、`from`（使った記録の中で最も古い時刻。保存上限 5,000 件で窓より短くなったことを表示に使う）、`generatedAt`
    - `topics: string[]`（最大 4）
    - `questions: { text: string; count: number }[]`（最大 5。`count` は LLM ではなく、まとめた元のコメントの件数の合計）
    - `peaks: { minute: number; count: number; label?: string }[]`（上位 3。`minute` はその 1 分の開始時刻）
    - `important: { author: string; text: string; at: number }[]`（新しい順に最大 5。同じ文は 1 件）
  - `peaksOf(records, now, windowMinutes)`: 1 分ごとの件数の上位 3 つ。LLM は使わない。
  - `summaryInput(records, now, windowMinutes)`: LLM に渡す行を作る。
    - 対象は `abusive`・`spam`・`spoiler` 以外の、`done` か `skipped` の記録。文は訳（日本語のコメントは原文）。
    - `normalizeComment` で同じ文をまとめ、`×N` を付ける。1 行は 60 文字まで。
    - 入れる順: 質問（最大 40）→ 山ごとの代表（各 8）→ その他（多い順、同数なら新しい順）。
    - 行の合計は 2,400 文字まで（スロットの 4,096 トークンに、システム文と出力 256 トークンを足しても収まる値）。
  - `summaryPrompt`（extension-core）: 入力は番号付きの行（`Q1 ×3 …`、`P1 …`、`C1 …`）、出力は GBNF で縛った行形式で、`max_tokens` は 256。
    - `T <話題>`（最大 4 行）
    - `Q <番号,番号…> <まとめた質問>`（最大 5 行）
    - `P<k> <見出し>`（山ごとに最大 1 行）
  - `summarize(client, records, windowMinutes, now, run)`: 数える部分と LLM の結果を合わせて `Result<Summary>` を返す。
    - LLM が失敗したら、数える部分（件数、言語、山、重要コメント、まとめていない質問）だけで返す。
    - 質問がなく、そのほかの行もないときは LLM を呼ばない。
  - `pipeline.exclusive(fn: (slot: number) => Promise<T>): Promise<T>`: 空いているコメント用スロットを 1 つ確保して `fn` を実行する。実行中、新しいバッチはそのスロットを使わない。同じ配信・同じ期間の要約は同時に 1 回だけ実行し、記録が増えていなければ前回の結果を返す。
  - 自動更新:
    - 判断 R35: サイドパネルが `setInterval(…, 120_000)` を持ち、そのたびに `'comments/summary'` を呼ぶ。動かすのは、パネルが開いていて `document.visibilityState === 'visible'` で、自動更新のトグルが ON のときだけ。background は要約のためのタイマーを持たない（port は使わない）。
    - 判断 R36: 要約がスロットを返したとき、待っているバッチがあれば先にバッチを動かす。要約は配信ごとに 1 つだけ待ち、同じ配信の新しい要求（期間は問わない）が、まだ始まっていない要約を置き換える。置き換えられた要求には、LLM を呼ばずに数える部分だけを返す。
- [ ] **Step 1: 失敗するテストを書く**
  - 期間（`it.each`）:
    - 5 分の窓では、1・4・6 分前の記録のうち 2 件だけを使う。
    - 15 分の窓では、1・14・16 分前のうち 2 件だけを使う。
  - `peaksOf`: 1 分ごとの件数の上位 3 つを返す。
  - `summaryInput` の除外: `abusive`・`spam`・`spoiler` と `pending`・`failed` を除く。
  - `summaryInput` のまとめ: 同じ文を `×N` にまとめる。
  - `summaryInput` の上限: 500 件から 2,400 文字以内の行を作り、質問はすべて入れる。
  - 行形式のパース:
    - `Q 1,3 …` の件数は、元の `×N` の合計。
    - 存在しない番号は無視する。
    - 文法外の行は捨てる。
  - LLM の失敗: 数える部分だけで返す。
  - `exclusive`:
    - 実行中は、バッチが同じスロットを使わない。
    - 同時に 2 回呼んでも LLM の呼び出しは 1 回。
    - 記録が増えていなければ LLM を呼ばない。
  - 自動更新（偽のタイマー、R35）: インターバルは自動更新が ON でパネルが見えている間だけ 1 つあり、OFF・非表示・アンマウントで 0 になる。1 回ごとに、いまの期間で要求する。background は要約のためのタイマーを作らない。
  - 要約とバッチの順番（R36）: 要約 → 待ちのバッチ → 2 つ目の要約の順になる。期間を 3 回切り替えても待つ要約は 1 つで、前の要求には数える部分だけを返す。バッチが続いても要約は止まらない。
  - `SummaryTab`: 期間を切り替えると要求の `windowMinutes` が変わる。エラーのときは前回の要約を残してエラーを表示する。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/comment-assistant test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `SummaryTab` はモックの要約タブの構成に合わせる:
    - 期間の切り替え（5・15・30 分）、自動更新のトグル、最終更新時刻
    - 主な話題、よくある質問（×件数）、盛り上がり（時刻、見出し）、重要コメント（投稿者：本文）
    - 対象の件数と言語。保存上限で窓より短いときは「直近 N 分ぶん」と書く。
- [ ] **Step 4: 通ることを確認する**
  - Run: comment-assistant と extension-core の `test`、comment-assistant の `test:e2e`、`pnpm check`
  - Expected: PASS
- [ ] **Step 5: 実機で確認する**
  - 実サーバー（`127.0.0.1:18083`、`gemma4-e4b`）で、ローカルの記録（`bench-data/live/`、コミットしない）から 5・15・30 分の要約を作る。
  - 測るもの: プロンプトと出力のトークン数、所要時間。
  - レポートには数値だけを書き、チャットの本文は書かない。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(comment-assistant): windowed chat summary with auto refresh while open"`

### Task 9: E2E と負荷試験（soak）

**Files:**

- Modify: `packages/extension-core/testing/playwright.ts`
  - llama のスタブが `/v1/chat/completions` に応答できるようにする（`responder` を差し替え可能にする）。
  - `platformRequests` を記録する仕組みを足す。
- Create: `packages/comment-assistant/test/browser/fixtures/live-chat.html`
  - 自作のチャット。`?rate=20` で秒間の投稿数を指定できる。投稿者と本文は自作の文を回す。
- Create: `packages/comment-assistant/test/browser/comments.spec.ts`
- Create: `packages/comment-assistant/test/browser/soak.spec.ts`

**Interfaces:**

- Consumes: Task 5〜8 のすべて
- Produces:
  - `test.extend` に追加するフィクスチャ:
    - `platform`: `context.route('https://www.youtube.com/**', …)` で fixture を返し、記録した URL の配列を公開する。
    - `longTasks(page): Promise<number[]>`: `PerformanceObserver({ type: 'longtask', buffered: true })` の duration を集める。
  - llama のスタブの既定 responder:
    - `commentBatchPrompt` の user 本文から id を取り出し、`{ items: [{ id, ja: '訳:' + id, category: id.endsWith('q') ? 'question' : 'chatter' }] }` を返す。
    - 本文に `BAD` を含むコメントは `abusive` にする。
  - 環境変数 `SOAK_MINUTES`（既定 2。手動または夜間は 120）。
- [ ] **Step 1: 失敗するテストを書く**

```ts
test('translates, highlights and hides comments in the live chat iframe without extra platform requests', async ({
  context,
  platform,
  llama,
}) => {
  // live-chat.html?rate=5 を 5 秒間表示
  // 期待値:
  //   - 'question' のメッセージは data-ca-mode="highlight"
  //   - 'BAD' を含むメッセージは data-ca-mode="blur"（abusive の既定値。Task 5c）
  //   - 翻訳文 '訳:' が表示される
  //   - platform.requests は fixture ドキュメントの 1 件だけ
});
test('shows originals and a connection error while llama.cpp is down, then recovers', async () => {
  /* llama.stop() → '接続できません'、llama.start() → 翻訳再開 */
});
test('side panel summary reflects the last 5 minutes', async () => {
  /* 要約タブで topics が描画される */
});
// soak.spec.ts
test('20 msg/s for SOAK_MINUTES keeps heap and long tasks within budget', async ({
  context,
  platform,
  serviceWorker,
}) => {
  // 測るもの: 開始時と終了時の usedHeap（content frame と sidePanel）、longTasks(page)
  // 期待値:
  //   - content frame の heap < 30MB
  //   - 終了時は開始時の 1.10 倍以下
  //   - longTasks の 50ms 超が 0 件
  //   - comments/stats の records ≤ 5000
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/comment-assistant test:e2e`
  - Expected: FAIL
- [ ] **Step 3: 足りない配線を直す**
  - テストを通すために本体のコードを直す場合は、該当するタスクの単体テストにも、同じケースを追加する。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/comment-assistant test:e2e`
  - Expected: PASS（soak は 2 分版）
- [ ] **Step 5: 長時間版と実サイトで確認する**
  - 長時間版: `SOAK_MINUTES=120 pnpm --filter @chrome-toolbox/comment-assistant test:e2e -- soak` を手動で実行し、結果を `docs/adoption.md` に記録する。
  - 実サイト（手動）: 実際の YouTube と Twitch のライブで、拡張の skill の手順どおりに読み込んで確認する。DevTools の Performance で 1 分間記録し、長いタスクとヒープを確かめる。
- [ ] **Step 6: 品質ゲートを通す**
  - Run: `pnpm gate:pre-pr -- --base <分岐元 SHA>`
  - Expected: comment-assistant と extension-core の項目がすべて pass する。
- [ ] **Step 7: Commit**
  - `git commit -m "test(comment-assistant): end-to-end chat flow and soak budget"`

### Task H: 公開リポジトリ向けの整理と README

背景（判断 R22、2026-10-28）: このリポジトリは公開する。ユーザーの方針は「秘匿情報や個人の環境に依存する情報を含めず、必要なものだけを品質高くコミットする」「サービスが分かれているなら README もきちんと直す」。

**Files:**

- Modify: `README.md`（テンプレートの説明を置き換え、chrome-toolbox の README にする）
- Create: `packages/{comment-assistant,subtitle-translator,page-translator,extension-core,ui,contracts,observability,web}/README.md`
- Create: `docs/llama-server.md`（誰でも再現できる llama-server の構成手順）
- Modify: `docs/adoption.md`、`.agents/skills/extension/SKILL.md`、`docs/superpowers/specs/*.md`、`docs/superpowers/plans/*.md`（個人の環境に依存する記述を一般的な説明に置き換える）

**要件:**

- 次の情報を、追跡対象のファイルに含めない: ローカルの絶対パス、ホームディレクトリ配下のパス、非公開リポジトリの名前や URL、個人の管理ツールのコマンドや workspace 名、実際の配信のチャットの内容、個人名やメールアドレス（コミットの作成者情報は除く）。
- 計測値は残してよい。ハードウェア（Apple M4 Max 36GB）とソフトウェアの版（llama.cpp 620d222 / b11669）は、再現に必要な条件として書く。
- `docs/llama-server.md` には次を書く:
  - llama.cpp のビルドまたは入手方法と、使った版。
  - モデルの入手元（公開されている Hugging Face のリポジトリとファイル名）。
  - ルーターモードの preset（`models.ini`）の例。モデルごとに `threads`、`poll`、`lazy-mode` を指定し、テキストだけで使うモデルは `mmproj` を書かない。
  - 起動コマンドの例（`--host 127.0.0.1 --port 18083 --models-max 2 --parallel 2`）。
  - macOS で常駐させる場合の注意（launchd の `ProcessType` を `Background` にすると遅くなる。実測値を添える）。
  - 拡張の設定（接続先 URL とモデル名）との対応。
- README は、それぞれのパッケージの役割、状態（実装済みか、骨組みだけか）、使い方、開発コマンド、テストの実行方法を、実際のコードと合う内容で書く。ルートの README には、全体像、プライバシーの方針（推論はローカルだけで行い、クラウドには送らない）、必要なもの、始め方、パッケージの一覧を書く。
- push の前に、非公開の文字列の一覧（リポジトリの外に置く）で `node tools/quality/sanitize.ts --rules <rules.json>` を実行し、0 件であることを確かめる。

- [ ] **Step 1: 非公開の文字列の一覧を作って、現状を検査する**
- [ ] **Step 2: `docs/llama-server.md` を書き、個人の環境に依存する記述をそこへの参照に置き換える**
- [ ] **Step 3: ルートと各パッケージの README を書く**
- [ ] **Step 4: `pnpm check` と sanitize の検査を通す**
- [ ] **Step 5: Commit**
  - `git commit -m "docs: document the extensions and a reproducible llama-server setup for the public repository"`
