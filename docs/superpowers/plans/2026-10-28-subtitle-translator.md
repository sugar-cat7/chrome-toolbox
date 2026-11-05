# ① subtitle-translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** YouTube の動画と配信に、原語と日本語の 2 段字幕を重ねて表示する。字幕トラックがあればそれを先読みして翻訳し、なければタブの音声を多言語 ASR で文字起こしして 2 秒以内に訳す。

**Architecture:**

- **content script**：映像の上の字幕描画（Shadow DOM）と再生位置の同期だけを担う。
- **MAIN world のスクリプト**：プレイヤーが自分で取得した字幕トラックの応答を読み取る。
- **background**：キャプションの先読み翻訳、セッション管理、ASR と翻訳の呼び出しを行う。
- **offscreen document**：タブ音声の取得、16kHz への変換、VAD による発話の区切りを行う。
- **翻訳の推論**：`id_slot: 0` を使う。

**Tech Stack:** WXT 0.21.5, React 19（ポップアップ）, Web Audio（AudioWorklet）, `chrome.tabCapture` + `chrome.offscreen`, Zod mini, Vitest 5, Playwright 1.64

**Spec:** `docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md`（§6, §9, §11, §15）。依存する計画:

- `2026-10-28-phase05-model-bench.md` の Task 1〜2（`chatJson`、`subtitlePrompt`）と Task 5・8（ASR エンジンとモデルの決定）
- `2026-10-28-comment-assistant.md` の Task 1〜3（`defineProtocol`、`createLruCache`、`createBatcher`、`createLanguageDetector`）

## Global Constraints

- 映像の上に 2 段で表示する。上の段は原語（既定）で小さく、下の段は日本語で大きく（モック A）。上の段は「原語／英語訳／なし」から選べる。
- 字幕の取得元: 自動／字幕トラック／音声。自動は、字幕トラックがあればそれを使い、なければポップアップでボタンを押すよう案内する。
- 字幕トラックの経路: 表示のずれは 200ms 以内。字幕トラックの取得は 1 本の動画につき 1 回まで。
- 音声の経路:
  - 発話の終わりから原語の表示まで p50 ≤ 1.0 s、日本語の表示まで p50 ≤ 2.0 s / p95 ≤ 3.0 s。
  - VAD で区切る。区切りが来なくても 1〜1.5 秒で強制的に区切る。
- 音声の取得は、タブごとに 1 回ユーザーが開始する（ツールバーのポップアップから）。
  - YouTube 内の SPA の遷移では止めない。
  - 止めるのは、タブを閉じた、ユーザーが停止した、対象サイトから離れた、一時停止が 10 分続いた、のいずれか。
- 取得した音声は `AudioContext.destination` に戻して、タブがミュートにならないようにする。
- 言語:
  - 多言語に対応し、自動で判別する。判別は開始直後に行い、その後は確からしさが下がった区間だけやり直す。
  - 日本語なら翻訳しない。
  - 英語以外で上の段に「英語訳」を選んだときは、日本語訳と英語訳を 1 回の推論でまとめて出す。
- 精度の工夫: 直前の 3 文を文脈として渡し、チャンネルごとの用語集を使う。文が完結したら訳を差し替える。
- 「ライブの再生を後ろにずらす」方式は採用しない。2 秒を超えたら、区切る長さを短くする → モデルを小さくする → 原語だけを先に出す、の順で対処する。
- メモリと CPU:
  - content script の JS ヒープは 30MB 以内。2 時間の連続再生でヒープの増加は 10% 以内。
  - 50ms を超える長いタスクを出さない。ポーリングはしない。
  - offscreen は、音声を取得している間だけ存在させる。
- `src/` の規約: throw / catch / `console` は使わない。async 関数は Result を返す。エラーコードは `tools/errors/catalog.json` に定義してから `pnpm errors:generate` を実行する。
- UI の文言は日本語。

## Review Focus

- 字幕トラックがない動画で、まだ音声を開始していない → ピルに「字幕なし・ポップアップから音声で開始」と出る。何も推論しない（Task 3・Task 4 でテスト）。
- アーカイブでシークや早送りをした → 先読みの範囲を新しい位置から組み直す。古い位置の訳は表示しない（Task 2 でテスト）。
- YouTube の広告が再生中（`#movie_player.ad-showing`）→ 字幕を描かず、音声の経路も ASR を止める。広告の音声を文脈に混ぜない（Task 3・Task 7 でテスト）。
- 無音や BGM だけの長い区間 → VAD は区切りを出さず、ASR を呼ばず、メモリも増えない（Task 6 でテスト）。
- 音声の取得中にタブを閉じた → MediaStream の track を stop し、AudioContext を close する。セッションが 0 件になれば offscreen を閉じる（Task 8 でテスト）。

---

### Task 1: 字幕トラックの取得（MAIN world）

**Files:**

- Create: `packages/subtitle-translator/src/captions/tracks.ts`
- Create: `packages/subtitle-translator/src/entrypoints/player-bridge.content.ts`（`world: 'MAIN'`）
- Create: `packages/subtitle-translator/test/fixtures/{player-response.json,timedtext.json3.json}`
- Test: `packages/subtitle-translator/test/unit/tracks.test.ts`

**Interfaces:**

- Produces:
  - `CaptionTrack = Readonly<{ languageCode: string; kind: 'asr' | 'manual'; baseUrl: string; name: string }>`
  - `listTracks(playerResponse: unknown): Result<CaptionTrack[]>`
    - `captions.playerCaptionsTracklistRenderer.captionTracks` を Zod で decode する。
  - `pickSourceTrack(tracks: CaptionTrack[], videoLang?: string): CaptionTrack | undefined`
    - 優先順: 動画の原語の manual → 原語の asr → 先頭の manual → 先頭の asr。翻訳トラック（`tlang`）は使わない。
  - `Cue = Readonly<{ startMs: number; endMs: number; text: string }>`
  - `parseJson3(body: unknown): Result<Cue[]>`
    - `events[].segs[].utf8` を連結し、空の event や `\n` だけの event は捨てる。
  - MAIN world のブリッジ: `window.postMessage({ source: 'st-bridge', type: 'tracks' | 'cues', ... }, location.origin)`
    - isolated 側は `event.source === window` と `source` フィールドを確かめて受け取る。
- [ ] **Step 0: スパイク（使い捨て）**
  - 実際の YouTube で、次の 3 つの方式のうちどれが「追加のリクエストなし」または「1 回だけ」で cue を得られるかを確かめる。chrome-devtools MCP の `evaluate_script` を使う。
    - A: プレイヤー自身の timedtext の応答を、fetch や XHR をフックして読み取る（読み取りだけ。`response.clone()` を使う）
    - B: プレイヤーの API で字幕を有効にして、プレイヤーに取得させる（`setOption('captions', 'track', { languageCode })`）。YouTube 側の字幕表示は CSS で隠す。
    - C: `baseUrl + '&fmt=json3'` を直接 fetch する（PO トークンが必要で、空が返ることがある）
  - 結果を `docs/adoption.md` に記録し、採用した方式に合わせて Step 3 の実装方針を確定する。既定の想定は A と B の組み合わせ。3 秒以内に応答を得られなければ C を 1 回だけ試す。
- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  {
    name: 'manual 原語を優先',
    tracks: [asr('en'), manual('en'), manual('ja')],
    videoLang: 'en',
    expected: 'manual:en',
  },
  {
    name: '原語が asr のみ',
    tracks: [asr('id'), manual('ja')],
    videoLang: 'id',
    expected: 'asr:id',
  },
  { name: 'トラックなし', tracks: [], videoLang: 'en', expected: undefined },
])('pickSourceTrack: $name', ({ tracks, videoLang, expected }) => {
  /* `${kind}:${languageCode}` */
});
it('parses json3 events into trimmed cues and drops empty ones', () => {
  /* fixture → 件数・最初の cue */
});
it('rejects a malformed player response with input_invalid', () => {
  /* listTracks({}) */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - ブリッジは `yt-navigate-finish` を受けたら、`document.querySelector('#movie_player').getPlayerResponse()` を読み直す。
  - フックは、元の関数を保持して委譲するだけにし、ページの挙動は変えない。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): read caption tracks and cues from the player"`

### Task 2: 字幕の先読み翻訳

**Files:**

- Create: `packages/subtitle-translator/src/captions/sentences.ts`
- Create: `packages/subtitle-translator/src/translate.ts`
- Create: `packages/subtitle-translator/src/protocol.ts`
- Test: `packages/subtitle-translator/test/unit/sentences.test.ts`
- Test: `packages/subtitle-translator/test/unit/translate.test.ts`

**Interfaces:**

- Consumes: Task 1 の `Cue`。Phase 0.5 の `chatJson`、`subtitlePrompt`、`subtitleOutputSchema`、`GlossaryEntry`。comment-assistant 計画の `createLruCache`、`defineProtocol`。
- Produces:
  - `Sentence = Readonly<{ id: string; startMs: number; endMs: number; source: string }>`
  - `toSentences(cues: Cue[]): Sentence[]`
    - 文末の記号（`.?!。？！`）や、次の cue との間に 700ms 以上の間がある位置で区切る。
    - 1 文は最大 6 秒まで。
    - `id` は `startMs` と本文から決まる文字列（キャッシュのキーに使う）。
  - `TranslatedLine = Readonly<{ sentenceId: string; startMs: number; endMs: number; source: string; ja?: string; en?: string; state: 'pending' | 'done' | 'failed' }>`
  - `createPrefetcher(deps: { client: LlamaClient; glossary: () => GlossaryEntry[]; topLine: () => 'source' | 'en' | 'none'; sourceLang: string; emit: (lines: TranslatedLine[]) => void }): Prefetcher`
  - `Prefetcher` の要素:
    - `load(sentences: Sentence[]): void`
    - `seek(positionMs: number): void`
    - `dispose(): void`
  - 先読みの方針:
    - 現在位置から 60 秒先までを、時刻の順に 1 文ずつ翻訳する（`slot: 0`、直前の 3 文を文脈にする）。
    - `seek` したら、待ち行列を捨てて新しい位置から組み直す（実行中のものは AbortSignal で止める）。
    - キャッシュは LRU（max 2000）、キーは `sentenceId`。
    - `sourceLang` が `ja` なら LLM を呼ばず、`ja = source` にする。
  - `subtitleProtocol = defineProtocol({ ... })` は、次の 5 つに `llmProtocol` の定義を加えたもの:
    - `'subs/load'`: `{ videoId, track: CaptionTrack, cues: Cue[] }` → `{ sentences: number }`
    - `'subs/seek'`: `{ videoId, positionMs }` → `{}`
    - `'audio/start'`: `{ tabId }` → `{ sessionId }`（Task 7）
    - `'audio/stop'`: `{ tabId }` → `{}`
    - `'subs/state'`: `{ tabId }` → `SessionState`（Task 8）
  - 訳の結果は、`tabs.sendMessage(tabId, { type: 'subs/lines', payload: TranslatedLine[] })` で content script に送る。
- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  {
    name: '句点で区切る',
    cues: [c(0, 900, 'Okay chat,'), c(900, 2000, "we're going in.")],
    sentences: ["Okay chat, we're going in."],
  },
  {
    name: '700ms の間で区切る',
    cues: [c(0, 1000, 'hi'), c(1800, 2500, 'there')],
    sentences: ['hi', 'there'],
  },
  {
    name: '6 秒で強制分割',
    cues: Array.from({ length: 8 }, (_, i) => c(i * 1000, i * 1000 + 1000, 'word')),
    sentences: [/* 2 文 */],
  },
])('toSentences: $name', ({ cues, sentences }) => {
  /* source の配列 */
});
it('translates the next 60 s in order with the previous three sentences as context', async () => {
  /* subtitlePrompt の previous が直前3文 */
});
it('drops queued work and restarts from the new position on seek', async () => {
  /* seek(120_000) 後、0〜60s の未着手文は翻訳されない */
});
it('does not call the LLM for Japanese sources', async () => {
  /* sourceLang 'ja' */
});
it('asks for English in the same call when topLine is en and source is not English', async () => {
  /* withEnglish: true が1回 */
});
it('serves repeated sentences from the cache', async () => {
  /* 同じ id を2回 load → chatJson 1回 */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装し、`runtime.ts` の background に組み込む**
  - 動画（videoId）ごとに Prefetcher を 1 つ持つ。同時に保持するのは最大 2 つまで（LRU）とし、古いものは `dispose` する。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): prefetch translation of caption sentences with seek reset"`

### Task 3: 字幕の描画と再生位置の同期

**Files:**

- Create: `packages/subtitle-translator/src/overlay/overlay.ts`
- Create: `packages/subtitle-translator/src/overlay/timeline.ts`
- Create: `packages/subtitle-translator/src/entrypoints/youtube.content.ts`
- Test: `packages/subtitle-translator/test/unit/timeline.test.ts`
- Test: `packages/subtitle-translator/test/unit/overlay.test.ts`

**Interfaces:**

- Consumes: Task 2 の `TranslatedLine`、`subtitleProtocol`
- Produces:
  - `createTimeline(): { upsert(lines: TranslatedLine[]): void; at(positionMs: number): TranslatedLine | undefined; reset(): void; size(): number }`
    - 時刻の順に並べた配列を二分探索する。
    - 保持するのは、現在位置の前後 10 分の行だけ（それ以外は `upsert` のたびに削除する）。
  - `mountOverlay(player: HTMLElement): OverlayHandle`
  - `OverlayHandle` の要素:
    - `render(line: TranslatedLine | undefined, settings: DisplaySettings): void`
    - `status(pill: PillState): void`
    - `unmount(): void`
  - 描画の方針:
    - Shadow DOM（`mode: 'closed'`）に、2 段の字幕とピルを描く。
    - スタイルは Shadow DOM の内側で完結させる。
    - 同じ行が続くときは、DOM を更新しない。
  - `DisplaySettings = Readonly<{ display: 'ja' | 'both' | 'source'; topLine: 'source' | 'en' | 'none' }>`
  - `PillState = Readonly<{ source: 'captions' | 'audio' | 'none'; latencyMs?: number; message?: string }>`
  - 同期:
    - 再生中だけ `video.requestVideoFrameCallback` で `currentTime` を読む。`pause`、`ended`、`.ad-showing` のときは止める。
    - 位置が前回より 2 秒以上飛んだら、`subs/seek` を送る。
  - `youtube.content.ts`:
    - ブリッジから cue を受けて `subs/load` を送る。`subs/lines` を受けて timeline を更新する。
    - `yt-navigate-finish` で reset する。
    - すべての後片付けは `ctx.onInvalidated` に登録する。
- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { at: 500, expected: 's1' },
  { at: 2500, expected: undefined },
  { at: 3100, expected: 's2' },
])('timeline.at($at)', ({ at, expected }) => {
  /* s1: 0-2000, s2: 3000-5000 */
});
it('prunes lines farther than 10 minutes from the position', () => {
  /* size が減る */
});
it.each([
  { display: 'both', topLine: 'source', rows: ['Okay chat', 'よしチャット'] },
  { display: 'ja', topLine: 'source', rows: ['よしチャット'] },
  { display: 'both', topLine: 'en', rows: ['Okay chat (en)', 'よしチャット'] },
])('overlay renders $display/$topLine', ({ display, topLine, rows }) => {
  /* jsdom + open shadow をテスト用に注入 */
});
it('skips DOM writes when the same line is rendered twice', () => {
  /* MutationObserver で 0 件 */
});
it('hides subtitles while an ad is showing', () => {
  /* player に .ad-showing → render されない */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `mountOverlay` は、テストのときだけ `{ mode: 'open' }` を渡せるよう、引数で受け取る。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): shadow-DOM overlay synced to video frames"`

### Task 4: ポップアップと設定

**Files:**

- Create: `packages/subtitle-translator/src/settings.ts`
- Create: `packages/subtitle-translator/src/entrypoints/popup/{index.html,main.tsx,App.tsx}`
- Modify: `packages/subtitle-translator/wxt.config.ts`
  - `action.default_popup` を設定する。
  - サイドパネルは削除する（spec の画面はポップアップ）。
  - permissions に `tabCapture`、`offscreen` を追加する。
  - content scripts の matches は `https://www.youtube.com/*`。
- Delete: `packages/subtitle-translator/src/entrypoints/sidepanel/*`（`ConnectionPanel` はポップアップに移す）
- Test: `packages/subtitle-translator/test/unit/settings.test.ts`
- Test: `packages/subtitle-translator/test/unit/popup.test.tsx`

**Interfaces:**

- Produces:
  - `subtitleSettingsSchema = z.strictObject({ enabled: z.boolean(), display: z.enum(['ja','both','source']), topLine: z.enum(['source','en','none']), source: z.enum(['auto','captions','audio']), translateBaseUrl: z.string(), translateModel: z.optional(z.string()), asrEngine: z.enum(['whisper','llama']), asrBaseUrl: z.string(), asrModel: z.optional(z.string()) })`
  - 既定値:
    - `enabled: true`、`display: 'both'`、`topLine: 'source'`、`source: 'auto'`
    - `translateBaseUrl: 'http://127.0.0.1:8080'`
    - `asrEngine` と `asrBaseUrl` は、Phase 0.5 の Task 8 の決定に合わせる。
  - `glossaryStore(area)`:
    - `load(channelId): Promise<Result<GlossaryEntry[]>>`
    - `save(channelId, entries): Promise<Result<GlossaryEntry[]>>`
    - storage のキーは `glossary:<channelId>`。最大 200 件。
  - ポップアップの構成は、モックのポップアップと同じ:
    - 有効の切り替え
    - 表示の切り替え（日本語のみ／併記／原語）
    - 上の段（原語／英語訳／なし）
    - 取得元（自動／字幕トラック／音声）
    - 用語集の件数と編集
    - 接続先
    - モデル
    - 「音声で字幕を開始／停止」ボタン
    - 状態の表示（取得元、遅延、言語）
- [ ] **Step 1: 失敗するテストを書く**
  - 設定の往復と既定値、用語集の上限（201 件目は `input_invalid`）を確かめる。
  - Testing Library で次の 2 点を確かめる。
    - 「音声で字幕を開始」を押すと、`subtitleProtocol.send('audio/start', { tabId })` が呼ばれる。
    - 状態が `source: 'none'` のとき、案内文「この動画には字幕がありません。音声で字幕を開始してください」が表示される。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: PASS
  - 既存の接続 E2E は、`sidepanel.html` を `popup.html` に読み替えて通す。
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): popup controls, settings and glossary"`

### Task 5: ASR クライアント

**Files:**

- Create: `packages/extension-core/src/asr.ts`
- Modify: `packages/extension-core/src/index.ts`
- Test: `packages/extension-core/src/asr.test.ts`

**Interfaces:**

- Consumes: Phase 0.5 の Task 5（リクエストの形。ベンチの `transcribe` と同じ形にそろえる）
- Produces:
  - `AsrResult = Readonly<{ text: string; lang: string; confidence: number }>`
  - `createAsrClient(options: { engine: 'whisper' | 'llama'; baseUrl: string; fetch: Fetch; model?: string; queue: Queue; timeoutMs?: number }): { transcribe(this: void, pcm: Int16Array, options: { sampleRate: 16000; langHint?: string; signal?: AbortSignal }): Promise<Result<AsrResult>> }`
  - `encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array`（44 バイトのヘッダー付きの PCM16 mono）
  - `confidence` の出どころ:
    - whisper: `verbose_json` の言語の確率。
    - llama: 出力 JSON の `confidence`。取れなければ 0.5。
  - 既定のタイムアウトは 5,000ms。
- [ ] **Step 1: 失敗するテストを書く**
  - `encodeWav` のヘッダー（`RIFF`、`WAVE`、データ長）を確かめる。
  - 2 つのエンジンそれぞれで、リクエストの形と応答の読み取りをテーブル形式で確かめる。
  - タイムアウト時に `network_failed` か `operation_cancelled` になることを確かめる。
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): multilingual ASR client for whisper.cpp and llama.cpp audio"`

### Task 6: 音声の前処理（AudioWorklet と VAD）

**Files:**

- Create: `packages/subtitle-translator/src/audio/resample.ts`
- Create: `packages/subtitle-translator/src/audio/vad.ts`
- Create: `packages/subtitle-translator/public/pcm-worklet.js`
  - AudioWorklet はモジュールとして読み込む必要があるので、WXT の `public/` に置く。中身は `resample.ts` と同じ処理を、ビルド時に生成するか手で同期する。
  - 推奨: `wxt.config.ts` に、`src/audio/pcm-worklet.ts` を別エントリとしてビルドする設定を足す。
- Test: `packages/subtitle-translator/test/unit/resample.test.ts`
- Test: `packages/subtitle-translator/test/unit/vad.test.ts`

**Interfaces:**

- Produces:
  - `createResampler(inputRate: number, outputRate: 16000): (input: Float32Array) => Float32Array`（線形補間。呼び出しをまたいで端数の位置を保持する）
  - `downmix(channels: readonly Float32Array[]): Float32Array`
  - `createVad(options: { frameMs: 20; threshold: number; hangoverMs: 300; minSegmentMs: 300; maxSegmentMs: 1500 }): { push(frame: Float32Array): Int16Array | undefined; flush(): Int16Array | undefined; reset(): void }`
    - エネルギーで判定する。`threshold` は、直近 2 秒のノイズ下限 × 3 に自動で追従する。
    - 発話のあと無音が `hangoverMs` 続くか、発話が `maxSegmentMs` に達したら、区切りを返す。`minSegmentMs` 未満の区切りは捨てる。
    - 内部のバッファは `maxSegmentMs` 分の固定長で、無音の間は伸びない。
- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { name: '48k→16k の長さ', inputRate: 48000, samples: 4800, expected: 1600 },
  { name: '44.1k→16k の長さ', inputRate: 44100, samples: 4410, expected: 1600 },
])('resampler $name', ({ inputRate, samples, expected }) => {
  /* 連続呼び出しでも合計が一致 */
});
it.each([
  { name: '発話→無音で区切る', pattern: ['speech:600', 'silence:400'], segments: [600] },
  { name: '1.5 秒で強制分割', pattern: ['speech:3200'], segments: [1500, 1500] },
  { name: '短すぎる音は捨てる', pattern: ['speech:200', 'silence:400'], segments: [] },
  { name: '無音だけなら何も出さない', pattern: ['silence:60000'], segments: [] },
])('vad: $name', ({ pattern, segments }) => {
  /* 区切りの長さ（ms）の配列 */
});
it('keeps the VAD buffer bounded during long silence', () => {
  /* 内部長が maxSegmentMs 相当を超えない */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): 16 kHz resampler and bounded energy VAD"`

### Task 7: 音声の取得（offscreen）と言語セッション

**Files:**

- Create: `packages/subtitle-translator/src/entrypoints/offscreen/{index.html,main.ts}`
- Create: `packages/subtitle-translator/src/audio/capture.ts`
- Create: `packages/subtitle-translator/src/audio/language-session.ts`
- Create: `packages/subtitle-translator/src/audio/live-pipeline.ts`
- Test: `packages/subtitle-translator/test/unit/language-session.test.ts`
- Test: `packages/subtitle-translator/test/unit/live-pipeline.test.ts`

**Interfaces:**

- Consumes: Task 5（`createAsrClient`）、Task 6（`createResampler`、`createVad`）、Task 2（`TranslatedLine`、`subtitlePrompt`）。comment-assistant 計画の `createLanguageDetector`。
- Produces:
  - offscreen 側: `startCapture(streamId: string, onSegment: (pcm: Int16Array) => void): Promise<Result<{ stop(): void }>>`
    - `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } })` で音声を取得する。
    - `MediaStreamSource` を `destination` につなぐ（音声をタブに戻す）。並行して AudioWorklet にもつなぐ。
    - `stop()` は、track の stop、ノードの切断、`AudioContext.close` を行う。
    - 区切った音声は `runtime.connect({ name: 'audio' })` の port で background に送る。`pcm.buffer` は ArrayBuffer として送る。
  - `createLanguageSession(options: { lowConfidence: 0.6; consecutive: 2 }): { observe(r: AsrResult): { lang: string; redetect: boolean }; current(): string | undefined; reset(): void }`
    - 最初の結果で言語を確定する。
    - confidence が 0.6 未満の結果が 2 回続いたら `redetect: true` を返し、次の結果で言語を確定し直す。
    - `langHint` は、確定した言語を渡す（再判定中は渡さない）。
  - `createLivePipeline(deps: { asr; translate: LlamaClient; glossary; topLine; emit: (line: TranslatedLine & { latency: { sourceMs: number; jaMs?: number } }) => void; now: () => number }): { push(pcm: Int16Array, endedAt: number): void; dispose(): void }`
    - 流れ: ASR → 原語の行を即座に emit する（`state: 'pending'`）→ 言語が `ja` 以外なら `subtitlePrompt`（直前の 3 文、`slot: 0`）→ 訳を付けて emit する（`state: 'done'`）。
    - 遅延は `endedAt` からの経過時間として記録する。
    - 文の途中で区切れた場合:
      - ASR の結果が文末の記号で終わらないときは、その文を「開いた文」として保持する。
      - 次の区切りの結果は、開いた文に連結する。訳し直した結果は同じ `sentenceId` で emit し、表示を差し替える。
      - 開いた文が 6 秒を超えたら、閉じる。
    - ASR は同時に 1 件まで、待ちは 2 件まで。超えたら古い区切りを捨てる（遅れを溜めない）。
  - background 側の `audio/start`:
    1. `tabCapture.getMediaStreamId({ targetTabId })` を呼ぶ。
    2. offscreen を作る（`reasons: ['USER_MEDIA']`。すでにあれば再利用）。
    3. offscreen に streamId を送る。
- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { name: '初回で確定', results: [r('id', 0.9)], lang: 'id', redetect: [false] },
  {
    name: '低確度 2 回で再判定',
    results: [r('en', 0.9), r('en', 0.4), r('en', 0.5), r('ja', 0.9)],
    lang: 'ja',
    redetect: [false, false, true, false],
  },
])('language session: $name', ({ results, lang, redetect }) => {
  /* ... */
});
it('emits the source line before the translation and records latency from segment end', async () => {
  /* emit 順: pending → done、latency.sourceMs < latency.jaMs */
});
it('skips translation for Japanese speech', async () => {
  /* chatJson 呼ばれない */
});
it('replaces the line when a split sentence completes', async () => {
  /* 'Okay chat' → 'we are going in.' の 2 区切り → 同じ sentenceId で 2 回 emit、2 回目の source は連結文 */
});
it('drops the oldest waiting segment instead of building a backlog', async () => {
  /* ASR を止めた状態で push 5 → transcribe 呼び出しは 1 + 2 */
});
it('dispose aborts in-flight ASR and translation', async () => {
  /* signal.aborted */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `startCapture` は単体テストせず、Task 9 の E2E で確かめる。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): offscreen tab audio capture and live ASR translation pipeline"`

### Task 8: セッションのライフサイクル

**Files:**

- Create: `packages/subtitle-translator/src/sessions.ts`
- Modify: `packages/subtitle-translator/src/runtime.ts`
- Test: `packages/subtitle-translator/test/unit/sessions.test.ts`

**Interfaces:**

- Consumes: Task 7（`audio/start`、`startCapture`、`createLivePipeline`）
- Produces:
  - `SessionState = Readonly<{ tabId: number; source: 'captions' | 'audio' | 'none'; lang?: string; latencyP50Ms?: number; latencyP95Ms?: number; dropped: number }>`
  - `createSessionManager(deps: { offscreen: { ensure(): Promise<Result<void>>; close(): Promise<Result<void>>; send(message: unknown): Promise<Result<unknown>> }; tabs: { onRemoved; onUpdated }; timers: Timers; now: () => number }): SessionManager`
  - `SessionManager` の要素:
    - `start(tabId: number, streamId: string): Promise<Result<{ sessionId: string }>>`
    - `stop(tabId: number, reason: 'user' | 'tab-closed' | 'left-site' | 'idle'): Promise<Result<void>>`
    - `playback(tabId: number, playing: boolean): void`
    - `state(tabId: number): SessionState`
    - `dispose(): void`
  - 停止のルール:
    - `tabs.onRemoved` → `tab-closed`
    - `tabs.onUpdated` で URL のホストが `www.youtube.com` 以外になった → `left-site`
    - 同じホスト内の URL の変化（SPA の遷移）では止めず、言語セッションと文脈だけを reset する。
    - content script から `paused` を受けて 10 分経過 → `idle`
    - セッションが 0 件になったら `offscreen.close()`
  - 遅延の統計は、直近 200 件の固定長リングバッファから p50 と p95 を出す。
- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { name: 'タブを閉じる', event: 'removed', reason: 'tab-closed' },
  { name: 'サイト外へ移動', event: 'updated:https://example.com/', reason: 'left-site' },
  { name: '一時停止 10 分', event: 'paused:600000', reason: 'idle' },
])('stops the session when $name', ({ event, reason }) => {
  /* stop 理由・offscreen.close 1回 */
});
it('keeps capturing across YouTube SPA navigation and resets context', () => {
  /* updated:https://www.youtube.com/watch?v=other → stop されない、reset 1回 */
});
it('closes offscreen only when the last session ends', () => {
  /* 2 タブ → 1つ stop で close 0回、2つ目で 1回 */
});
it('keeps latency stats in a 200-entry ring', () => {
  /* 1000件記録 → 内部長 200 */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装し、`startBackground` に組み込む**
  - `dispose` で listener と timer をすべて解除する。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): per-tab capture sessions with explicit stop rules"`

### Task 9: E2E、負荷試験、実機での遅延測定

**Files:**

- Create: `packages/subtitle-translator/test/browser/fixtures/watch.html`
  - 偽の `#movie_player`（`getPlayerResponse` を持つ）、短い `<video>`、timedtext の json3 を返すブリッジ用のスクリプトを含む。
- Create: `packages/subtitle-translator/test/browser/fixtures/speech.wav`
  - Phase 0.5 の `make-audio` で生成した自作の文 1 本。数百 KB 以内。
- Create: `packages/subtitle-translator/test/browser/captions.spec.ts`
- Create: `packages/subtitle-translator/test/browser/audio.spec.ts`
- Create: `packages/subtitle-translator/test/browser/soak.spec.ts`
- Modify: `packages/subtitle-translator/src/entrypoints/offscreen/main.ts`
  - `import.meta.env.MODE === 'e2e'` のときだけ、streamId の代わりに fixture の音声 URL を `<audio>` から取得する経路を有効にする。
  - 本番ビルドには含まれないことを、ビルド結果の grep で確かめる。
- Modify: `packages/extension-core/testing/playwright.ts`
  - ASR のスタブ（`/inference` と、`input_audio` を含む chat）を追加する。
  - `STARTER_EXTENSION_MODE` で e2e ビルドを選べるようにする。

**Interfaces:**

- Consumes: Task 1〜8 のすべて

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('caption path shows source and Japanese lines in sync with playback', async ({
  context,
  platform,
  llama,
}) => {
  // watch.html を https://www.youtube.com/watch?v=fixture に route し、再生する
  // 期待値:
  //   - overlay の 2 行が cue の時刻 ±200ms で切り替わる
  //   - platform.requests はドキュメントと timedtext の 2 件以下
});
test('seeking resets prefetch to the new position', async () => {
  /* seek 後に表示される訳は新位置の文 */
});
test('audio path renders the source line then the translation', async () => {
  /* e2e ビルド、popup の開始ボタン → 原語→日本語の順に描画、latency が state に入る */
});
test('closing the tab releases capture and the offscreen document', async ({
  context,
  serviceWorker,
}) => {
  /* chrome.offscreen.hasDocument() が false */
});
// soak.spec.ts
test('SOAK_MINUTES of captions keeps heap and long tasks within budget', async () => {
  /* content heap < 30MB、終了/開始 ≤ 1.10、longtask 0 件 */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test:e2e`
  - Expected: FAIL
- [ ] **Step 3: 足りない配線を直す**
  - 本体のコードを直す場合は、該当するタスクの単体テストにも同じケースを追加する。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test:e2e`
  - Expected: PASS
  - 本番ビルドに e2e 用の経路が含まれていないことも確かめる。
    - Run: `pnpm --filter @chrome-toolbox/subtitle-translator build && ! grep -r "e2e-fixture-audio" packages/subtitle-translator/dist/chrome-mv3`
    - Expected: 終了コード 0
- [ ] **Step 5: 実機で遅延を測る（手動）**
  - 実際の YouTube の配信で、英語、インドネシア語、韓国語、スペイン語、中国語を 1 本ずつ、5 分間確認する。
  - 計測は基準機で行う。llama-server を同じ Mac で `--parallel 2` で起動し、②も同時に動かした状態にする。
  - ポップアップに表示される p50 と p95 を `docs/adoption.md` に記録する。
  - 未達の言語は、spec §6 の順（区切る長さを短くする → モデルを小さくする → 原語だけを先に出す）で調整し、もう一度測る。
- [ ] **Step 6: 品質ゲートを通す**
  - Run: `pnpm gate:pre-pr -- --base <分岐元 SHA>`
  - Expected: subtitle-translator と extension-core の項目がすべて pass する。
- [ ] **Step 7: Commit**
  - `git commit -m "test(subtitle-translator): caption and audio end-to-end, soak and latency record"`
