# ③ page-translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一般の Web ページを、レイアウト、リンク、フォームを壊さずに、ローカルの llama.cpp で日本語に置き換えて読めるようにする。見えている段落から順に訳し、原文にはいつでも翻訳前とまったく同じ DOM に戻せる。選択した範囲は、その近くの吹き出しで訳す。

**Architecture:**

- **content script**（`content-scripts/page.js`。manifest には書かず、`scripting` で必要なときだけ入れる。トップフレームだけ）:
  - ページを段落に切り出す（Task 5）。
  - IntersectionObserver で画面の近くに来た段落だけを、1 つずつのバッチで background に頼む（Task 7）。
  - 訳をテキストノードの `data` に書き、原文をメモリに持つ。原文に戻す（Task 6）。
  - ツールチップと吹き出しを Shadow DOM に描く（Task 10）。
  - 推論はしない。ページごとのキャッシュはここに持つ。
- **background**（service worker）:
  - 翻訳の窓口。Gemma の行形式のバッチと、任意の PLaMo を振り分け、llama-server の枠を決める（Task 8）。状態はほぼ持たない。
  - content script を入れる、右クリックメニューとショートカット、「常に翻訳」のサイトへの登録（Task 9）。
- **ポップアップ**: 翻訳する／原文に戻す、表示方法、サイトごとの設定、進み具合（モック A）。
- **設定ページ**: llama.cpp の接続先、モデル、サイトの一覧。
- **llama.cpp**: ルーターモードの 1 台（`http://127.0.0.1:18083`、R21）。すべての要求に `model` を付ける（R11）。

**Tech Stack:** WXT 0.21.5（`registration: 'runtime'` の content script、popup と options の entrypoint）, React 19, Tailwind 4, `chrome.scripting` + `activeTab` + `contextMenus` + `commands`, Zod mini, Vitest 5 + WXT fake browser + jsdom, Testing Library, Playwright 1.64（Chrome for Testing、CDP `Extensions.triggerAction`）

**Spec:** `docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md`（§3, §4, §5, §8, §9, §11, §15。§8 はこの計画で追記した）、`docs/llama-server.md`（PLaMo 3 Translate の節）、`docs/adoption.md`。前提:

- comment-assistant 計画は Task H まで完了している。次のものを使う。
  - extension-core: `createLlamaClient`、`cutByMaxTokens`、`createQueue`、`createLruCache`、`Timers`、`systemTimers`、`defineProtocol`、`llmProtocolSpec`、`llmHandlers`、`settingsStore`（`models.translate`）、`connectionPort`。`scriptLanguageGuess` は使わない（理由は Task 5）。
  - packages/ui: `ConnectionPanel`
  - extension-core の testing: llama のスタブ、`realVisibility`、`usedHeap`、`heapSnapshotParts`、`longTasks`
- 写して使う、comment-assistant の作り方（アプリどうしは import しない）:
  - `runtime.ts` の送り手の確認（`fromExtensionPage`、`sender_forbidden`）
  - `sites/observe.ts` の前面の判定（`visibilityState`、`pagehide`、IntersectionObserver を見直す「look」）
  - `test/unit/intersection.ts`（jsdom 用の偽の IntersectionObserver と visibility）
  - 遅れて読み込んだ設定で入力を上書きしない作り（`SettingsTab.tsx` の `edited`）
- subtitle-translator の計画と同時に進む場合の調整: 次のものは両方の計画が触る。先に入った方を使い、後の方は足さずに合わせる。
  - `ChatRequest.stop` と PLaMo の要求の組み立て（Task 2）
  - `llm.ts` の 2xx 以外の応答の読み方（subtitle の `audio_unsupported`、この計画の `model_unavailable`）
  - llama のスタブの `defaultResponder` と `tools/errors/catalog.json`
  - comment-assistant の `soak-marker.test.ts`（`starter.soak` を持つパッケージの一覧）

## Global Constraints

- 画面:
  - ツールバーのボタンはポップアップを開く（モック A）。接続先、モデル、サイトの一覧は設定ページ（`options_ui`、`open_in_tab: true`）。
  - サイドパネルは使わない。`sidePanel` 権限と `src/entrypoints/sidepanel/` を消す。
  - 表示方法は `replace`（置き換え。既定）と `pair`（併記）。設定は全タブ共通で、変えるとすぐ全タブに反映する。
- 権限（manifest）:
  - `permissions: ['storage', 'activeTab', 'scripting', 'contextMenus']`
  - `host_permissions: ['http://localhost/*', 'http://127.0.0.1/*']`（これだけ）
  - `optional_host_permissions: ['http://*/*', 'https://*/*']`（LAN の llama.cpp と「常に翻訳」のサイト）
  - `commands['translate-selection']`: 既定のキー `Alt+Shift+L`、説明「選択範囲を翻訳」
  - `content_scripts` は書かない。`<all_urls>` は求めない。
- content script を入れるのは、次のときだけ。どれもトップフレーム（`frameIds: [0]`）。
  - ポップアップの「このページを翻訳」（ツールバーのボタンで得た `activeTab`）
  - 右クリックメニュー「選択範囲を翻訳」とショートカット（どちらも `activeTab` を与える）
  - 「常に翻訳」のサイト（`scripting.registerContentScripts`、そのサイトのホスト権限があるときだけ）
- ページの変え方:
  - 変えるのはテキストノードの `data` だけ。属性は変えない。要素を足す、消す、動かすこともしない。
  - 例外は 2 つ。どちらも open な Shadow DOM を持ち、原文に戻すと消える。
    - 併記の訳を入れる `<pt-ja>`（段落に含まれる、ブロック直下の最後の子の直後。リンクの中には入れない）
    - ツールチップと吹き出しを入れる `<pt-overlay>`（`document.documentElement` の最後の子）
  - テキストノードの前後の空白は、元のまま残す。
- 原文に戻したページは、翻訳前と同じ DOM になる。比べるのは、ノードの種類、名前、属性、テキスト、開いた Shadow DOM の中、ノードの同一性。ページが翻訳のあとで書き換えたテキストノードは、ページの値を残す。
- 翻訳しないもの（Task 5 の表で決める）:
  - 要素: `input`、`textarea`、`select`、`option`、`optgroup`、`datalist`、`code`、`pre`、`kbd`、`samp`、`var`、`tt`、`script`、`style`、`noscript`、`template`、`svg`、`math`、`iframe`、`object`、`embed`、`canvas`、`video`、`audio`、`pt-ja`、`pt-overlay`
  - 編集できる要素（`isContentEditable`）
  - いちばん近い `translate` 属性が `no` の要素（その中の `translate="yes"` は訳す）
  - クラス `notranslate`
  - アイコンフォントのクラス: `material-icons`、`material-icons-*`、`material-symbols-*`、`google-symbols`
  - 属性（`alt`、`title`、`placeholder`、`aria-label`、`value`）と `<head>`
  - `needsPageTranslation` が false のテキスト（すでに日本語、文字が 2 つ未満、URL かメールアドレスだけ）
- 範囲: トップフレームと、その中の開いた Shadow DOM（走査のときにあったもの）。iframe の中と閉じた Shadow DOM は訳さない。後から付いた Shadow DOM は、その要素の子が変わったときか、もう一度「このページを翻訳」を押したときに拾う。
- 見えている範囲から:
  - IntersectionObserver は 1 つで、`rootMargin: '50% 0px'`（画面の上下に、画面の高さの半分ずつ）。近くに来た段落だけを頼む。
  - 走査は、1 回 8 ms までに区切る。
  - バッチは 1 つに最大 6 単位、原文の合計 800 文字まで。content script が同時に出すバッチは 1 つだけ。
  - 監視の単位はブロック要素。1 つのブロックに `<br>` で区切った段落が多いと、画面外の分も順に（1 バッチずつ）訳す。
- MutationObserver は 1 つ（`childList`、`subtree`、`characterData`）。本文と、開いた Shadow DOM（200 個まで）を見る。記録は 300 ms ごとにまとめて処理する。
- 前面にあるときだけ処理する（R44）:
  - `document.visibilityState === 'visible'` のときだけ、走査、段落の登録、要求をする。
  - 見えなくなったら、新しいバッチを出さず、出したバッチは `page/cancel` で止める。見えるようになったら、近くの段落を見直して続ける。
  - 「常に翻訳」で裏のタブに開いたページは、見えるまで何もしない。
- 後片付け:
  - `pagehide` で、監視、タイマー、listener、キャッシュ、overlay をすべて解放する。`persisted` のとき（bfcache）は、先に同期で原文に戻す。
  - 例外として `pageshow` の listener 1 つだけは残す。bfcache から戻ったとき、翻訳していたなら最初からやり直す。
  - 拡張の更新（`ctx.onInvalidated`）でも、原文に戻してから解放する。
- 推論:
  - Gemma: 設定の `models.translate`（既定 `gemma4-e4b`）。ページ用の行形式（`<n>\t<訳>\n`）を GBNF で縛る。`temperature: 0`、`chat_template_kwargs: { enable_thinking: false }`。
  - PLaMo（任意）: ページの設定の `plamoModel`（既定 `plamo-3-translate-2b`）。1 単位ずつ送る。
    - 送るもの: user の 1 通だけ（訳す文）、`chat_template_kwargs: { target_lang: 'ja', context? }`、`stop: ['<|plamo:tag|>', '<|plamo:bos|>']`、`temperature: 0`
    - 送らないもの: `response_format`、JSON Schema、`grammar`、system、`source_lang`
    - 空の文と `<|plamo:` を含む文は、PLaMo に送らず Gemma で訳す。
    - 失敗した単位は、同じ要求の中で Gemma で訳し直す。モデルがない（`model_unavailable`）なら、設定が変わるまで Gemma だけを使い、ポップアップで知らせる。
  - 既定の翻訳モデルは Gemma。Task 4 の計測で決めた規則を満たせば PLaMo にする。
  - 枠（`id_slot`）:
    - Gemma は `totalSlots - 1`（2 以上のとき）。1 枠のサーバーなら 0。同時に 1 件。
    - PLaMo は 1 から `totalSlots - 1` まで（2 以上のとき）。同時に `totalSlots - 1` 件まで。
    - `/props?model=<name>` が答えるまでは `id_slot` を付けない。
    - 字幕の枠 0 は使わない。`--parallel 3` の Gemma の枠 2 は、コメントの 2 つ目のバッチと分け合う（拡張どうしの調整はしない。§4）。
  - 要求の時間切れは 30 秒（ルーターの読み込みに最大 13 秒かかった）。
- 上限（`PAGE_LIMITS`）:
  - 単位の原文は 400 文字まで（長いテキストノードは文の区切りで分ける）。印は 1 段落に 12 個まで（超えたらテキストノードごとの段落に分ける）。
  - 待ち 400 単位、監視するブロック 5,000 個、変化の記録 500 件（超えたら本文を走査し直す）。
  - 原文を持つ段落は 10,000 個まで。超えたら、新しい段落は訳さない（原文を捨てると戻せなくなるため）。ポップアップに「段落が多いため、ここから先は翻訳しません」と出す。
  - ページごとのキャッシュは LRU 2,000 件。失敗は保存しない。
  - 送れなかったバッチ（接続できない、時間切れ、待ちがいっぱい）は 5 秒後、30 秒後に送り直す。3 回目も失敗したら、その段落は「失敗」として原文のままにする。もう一度「このページを翻訳」を押すと、失敗を消してやり直す。
  - 選択範囲は 2,000 文字まで。
- リソース（§9、R47）:
  - 翻訳しているページの JS ヒープは、どの時点でも 30 MB 未満。
  - 負荷試験では、ヒープのスナップショットのデータ部分が開始時の 1.10 倍以内、ヒープ全体が開始時の 2 倍未満。
  - 拡張が原因の 50 ms を超える長いタスクを出さない。原文に戻す作業も 500 ノードずつに区切る（`pagehide` だけは同期）。
  - ポーリングはしない。ポップアップの進み具合は、開いている間だけ `tabs.connect` の port で受け取る。
- `src/` の規約:
  - throw、catch、`console` は使わない。
  - async 関数は `Promise<Result<…>>` を返すか、名前付きの listener を `launch` に渡す。
  - 新しいエラーコードは `tools/errors/catalog.json` に定義してから `pnpm errors:generate` を実行する。
- メッセージの送り手を確かめる:
  - `page/translate`、`page/cancel` は、タブのトップフレームの content script からだけ受ける。
  - `page/start`、`page/restore` は、この拡張のページ（ポップアップと設定ページ）からだけ受ける。
  - それ以外の送り手には `sender_forbidden` を返す。
- UI の文言は日本語。
- 公開リポジトリ:
  - fixture とベンチの文は、自作のものだけにする。実在のページの文、訳、URL はコミットしない。
  - PLaMo の出力はコミットしない（計測の出力も、gitignore 済みの `bench-data/` にだけ置く）。

## Review Focus

- アイコンフォントの文字（`<span class="material-icons">search</span>`）→ 訳さない。訳すとアイコンが文字に化ける（Task 5・Task 12 でテスト）。
- ページが訳したテキストノードを後から書き換える（React のカウンター、「3 分前」の時刻など）→ ページの値を正とし、その段落を訳し直す。原文に戻すときも、古い原文で上書きしない（Task 6・Task 7・Task 12 でテスト）。
- `value` のない `<option>`、`<textarea>` の初期値、フォームのボタン → 送信される値が翻訳前と同じ（Task 5・Task 12 でテスト）。
- SPA が本文を丸ごと入れ替える → 外れたブロックの監視をやめ（IntersectionObserver が切り離された要素を持ち続けない）、新しい本文は近くの段落だけを訳す（Task 7 でテスト）。
- llama.cpp が途中で落ちる、PLaMo がサーバーにない → 原文のまま残し、送り直しは 3 回まで。ポップアップに理由を出す。PLaMo がなければ Gemma で訳す（Task 7・Task 8・Task 11 でテスト）。

## 要確認

人が確かめたい判断。各項目の推奨（この計画の既定）で進め、止めずに実装する。

1. **UI**: スキャフォールドのサイドパネルをやめ、ポップアップと設定ページにする。推奨: ポップアップ（spec とモック A のとおり。ページの横幅を狭めない。`activeTab` が確実に得られる）。
2. **権限**: `activeTab` + `scripting` + `contextMenus`、「常に翻訳」のサイトだけ任意のホスト権限。`<all_urls>` は求めない。その代わり、選択しただけで出る小さなボタンは作らない。推奨: このとおり。
3. **選択範囲の翻訳の始め方**: 右クリックメニューとショートカット `Alt+Shift+L`（`chrome://extensions/shortcuts` で変えられる）。推奨: このとおり（Windows の Chrome は Alt+Shift+T、A、B、I を使う）。
4. **除外の範囲**: 「翻訳しない」サイトでは、ページの翻訳（手動と常に翻訳）を始めない。選択範囲の翻訳は動かす。既定の除外リストは空。推奨: このとおり（何もしなくても、押さない限り拡張はページに入らない）。
5. **既定の翻訳モデル**: 計測（Task 4）までは Gemma。Task 4 の規則を満たせば PLaMo を既定にし、サーバーになければ自動で Gemma にする。推奨: このとおり。
6. **枠**: Gemma は最後の枠（`--parallel 3` なら 2）だけで同時に 1 件。PLaMo は枠 1 と 2。推奨: このとおり（字幕の枠 0 を守る。コメントの 1 つ目のバッチの枠 1 のプロンプトキャッシュを崩さない）。
7. **範囲**: トップフレームだけ。開いた Shadow DOM は訳し、iframe と閉じた Shadow DOM は訳さない。属性は訳さない。推奨: このとおり。
8. **併記の作り**: 段落の終わり（ブロック直下の最後の子の直後）に `<pt-ja>`（Shadow DOM に訳）を足す。ページは縦に長くなる。推奨: このとおり。
9. **用語集**: ページ翻訳には用語集を持たない（PLaMo の要求の組み立ては `glossary` を受け付ける）。推奨: 持たない。必要になれば設定ページにサイトごとの用語集を足す。
10. **吹き出しの「原文を読み上げ」**: 置かない（音声合成の声によっては外部に送られる）。推奨: 置かない。
11. **段落の上限**: 原文を持つ段落が 10,000 個に達したら、それ以上は訳さない（原文を捨てない）。推奨: このとおり。
12. **bfcache**: `pagehide` でキャッシュを捨てる（spec）ので、戻ったときは訳し直す。推奨: このとおり。
13. **subtitle 計画との重なり**: `stop`、PLaMo の要求、スタブ、エラーコード、`soak-marker.test.ts` は、先に入った方を使う。推奨: このとおり。

---

### Task 1: 入口と権限（ポップアップ、設定ページ、実行時に入れる content script）と E2E の起点

**Files:**

- Modify: `packages/page-translator/wxt.config.ts`（Global Constraints の manifest）
- Delete: `packages/page-translator/src/entrypoints/sidepanel/`
- Create: `src/entrypoints/popup/index.html`、`popup/main.tsx`、`popup/style.css`（この Task では「このページを翻訳」のボタンだけ）
- Create: `src/entrypoints/options/index.html`（`<meta name="manifest.open_in_tab" content="true" />`）、`options/main.tsx`、`options/style.css`（この Task では `ConnectionPanel` だけ）
- Create: `src/entrypoints/page.content.ts`（`registration: 'runtime'`、`matches` なし。この Task では `ping` に答えるだけ）、`src/content/claim.ts`
- Create: `src/protocol.ts`、`src/control.ts`（この Task では `injectPage` と `start` だけ）
- Modify: `packages/page-translator/README.md`（サイドパネルの記述を、ポップアップと設定ページに直す。詳しい使い方は Task 13）
- Modify: `src/runtime.ts`（`sidePanelPort` を `optionsPort` に。`page/start` の経路と送り手の確認）、`src/entrypoints/background.ts`（`setPanelBehavior` を消す）
- Modify: `tools/errors/catalog.json`（`page_restricted` → 公開コード `permission_denied`）。続けて `pnpm errors:generate`
- Modify: `packages/page-translator/package.json`（`zod`、`jsdom`、`@testing-library/react`、`@testing-library/user-event` を catalog から）
- Modify: `packages/extension-core/testing/playwright.ts`（Step 0 で A か B になったとき `triggerAction`）
- Create: `packages/page-translator/test/browser/page.ts`（E2E の補助）、`test/browser/manifest.spec.ts`
- Modify: `test/browser/connection.spec.ts`（サイドパネルの代わりに設定ページを開く）、`test/unit/runtime.test.ts`
- Modify: `docs/adoption.md`（Step 0 の結果）

**Interfaces:**

- Produces:
  - `src/protocol.ts`:
    - `pageCommandSchema`: `{ action: 'ping' | 'translate' | 'restore' }` または `{ action: 'selection'; text?: string }`（`text` は 2,000 文字まで）。background から content script へ、`{ type: 'page/command', payload }` で送る。
    - `pageProtocolSpec`: `llmProtocolSpec` に、`'page/start': { request: z.strictObject({ tabId: z.int(), url: z.optional(z.string()) }), response: z.strictObject({}) }` を足したもの。`url` はポップアップが読んだタブの URL（Task 9 が除外の確認に使う）。後の Task が経路を足す。
  - `src/content/claim.ts`: `claimPage(scope: object): boolean`。`scope` の `Symbol.for('chrome-toolbox.page-translator')` が空なら印を付けて true、あれば false。`page.content.ts` は false のとき何もしない（二重に入れられても 1 つだけ動く）。
    - `pageProtocol = defineProtocol(pageProtocolSpec)`
  - `src/control.ts`:
    - `PAGE_SCRIPT = 'content-scripts/page.js'`
    - `ScriptingApi = { executeScript(injection: { target: { tabId: number; frameIds: number[] }; files: string[] }): Promise<unknown> }`
    - `injectPage(api: ScriptingApi, tabId: number): Promise<Result<void>>`: 拒まれたら（`chrome://`、ウェブストア、権限なし）`Err(failure('page_restricted'))`。
  - `src/runtime.ts`:
    - `senderKind(sender: Sender): 'page' | 'content' | 'other'`
      - `page`: comment-assistant の `fromExtensionPage` と同じ判定
      - `content`: `sender.tab?.id` があり、`frameId === 0` で、`page` でないもの
    - `optionsPort(api?: PanelApi): ConnectionPort`（今の `sidePanelPort` の名前を変えたもの）
  - `test/browser/page.ts`:
    - `servePage(context: BrowserContext, url: string, html: string): Promise<void>`（`context.route` で答える。comment-assistant の `perf.spec.ts` の `ELSEWHERE` と同じ作り。ホストは `*.fixture.test`）
    - `startTranslation(context: BrowserContext, page: Page): Promise<void>`（Step 0 で決めた方法）
    - `tabIdOf(serviceWorker: Worker, page: Page): Promise<number>`（`page.bringToFront()` のあと `tabs.query({ active: true, lastFocusedWindow: true })`）
    - `fingerprint(page: Page): Promise<string>`: 本文と開いた Shadow DOM の中を順にたどり、ノードごとに種類、名前、並べ替えた属性、テキストを 1 行にした文字列。

- [ ] **Step 0: 確かめる（結果は `docs/adoption.md` の新しい節「Page translator foundation」に書く）**
  - (a) WXT 0.21.5 の `registration: 'runtime'`:
    - 出力のパスが `content-scripts/page.js` になるか。
    - `matches` を書かなければ `host_permissions` に何も足されないか（WXT の `internal/manifest.mjs` は、runtime の content script の `matches` を `host_permissions` に足す）。
  - (b) E2E で `activeTab` を得る方法。headless の Chrome for Testing 156 で、次の順に試す。
    - A: `realVisibility: true` の起動で `context.browser()?.newBrowserCDPSession()` を作る。`Extensions.triggerAction({ id: extensionId, targetId })`（`targetId` はページの CDP セッションの `Target.getTargetInfo`）でポップアップが開き、Playwright のページとして見えるか。
    - B: A でポップアップは見えないが `activeTab` は付く場合。テストは service worker の `evaluate` で、background と同じ `scripting.executeScript` と `tabs.sendMessage` を呼ぶ。ポップアップは単体テストと、タブで開いた描画だけの E2E で確かめる。
    - C: `Extensions.triggerAction` が使えない場合（パイプ接続と `--enable-unsafe-extension-debugging` が要るなど）。e2e 用のビルドにする。
      - `package.json` に `starter.e2eBuild: true`。`tools/quality/extension-browser.ts` は、これがあれば `wxt build --mode e2e` を使う（subtitle 計画の Task 14 の代わりの方式と同じ仕組み。先にあれば使う）。
      - `wxt.config.ts` は、`mode === 'e2e'` のときだけ `host_permissions` に `https://*.fixture.test/*` を足す。
      - 本番のビルドの manifest に `fixture.test` がないことを、`manifest.spec.ts` で確かめる。
  - (c) ポップアップから `permissions.request` を呼んだとき、許可の確認でポップアップが閉じるか（headed の Chromium で手で確かめる）。どちらでも動くように、Task 9 は background の `permissions.onAdded` で登録を合わせる。
  - (d) 実行時に許可したホストに `scripting.registerContentScripts` で登録した script が、次の読み込みで動くか（手で確かめる）。
- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/unit/runtime.test.ts
it.each([
  {
    name: '設定ページ',
    sender: { url: 'chrome-extension://<id>/options.html', origin: 'chrome-extension://<id>' },
    kind: 'page',
  },
  {
    name: 'トップフレーム',
    sender: { tab: { id: 3 }, frameId: 0, url: 'https://wiki.fixture.test/a' },
    kind: 'content',
  },
  { name: 'iframe', sender: { tab: { id: 3 }, frameId: 7 }, kind: 'other' },
  {
    name: 'サンドボックス',
    sender: { url: 'chrome-extension://<id>/x.html', origin: 'null' },
    kind: 'other',
  },
])('senderKind: $name', ({ sender, kind }) => {
  /* ... */
});
it('answers page/start only from extension pages', async () => {
  /* content の送り手には sender_forbidden。page の送り手には executeScript（frameIds [0]、files [PAGE_SCRIPT]）のあと tabs.sendMessage({ type: 'page/command', payload: { action: 'translate' } }, { frameId: 0 }) */
});
it('maps a refused injection to page_restricted', async () => {
  /* executeScript が 'Cannot access a chrome:// URL' で拒む */
});
it('claims a page once per isolated world', () => {
  /* 同じ scope で claimPage が true、次は false。別の scope では true */
});
// test/browser/manifest.spec.ts
test('the manifest asks for no site access at install', async () => {
  // dist/chrome-mv3/manifest.json を読む
  // permissions は ['storage', 'activeTab', 'scripting', 'contextMenus']（順不同）
  // host_permissions は localhost と 127.0.0.1 だけ。content_scripts と side_panel はない
  // action.default_popup は popup.html、options_ui.page は options.html
  // commands['translate-selection'].suggested_key.default は 'Alt+Shift+L'
});
test('the toolbar action injects the page script, which answers ping', async () => {
  // servePage で https://wiki.fixture.test/plain を開き、startTranslation を 2 回
  // service worker から tabs.sendMessage(tabId, ping, { frameId: 0 }) → { ready: true }
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test && pnpm --filter @chrome-toolbox/page-translator test:e2e`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - content script の二重起動は、isolated world の `globalThis[Symbol.for('chrome-toolbox.page-translator')]` で防ぐ。2 回目は何もしない。
  - 接続確認の E2E は、`chrome-extension://<id>/options.html` を開いて同じ手順で通す。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm errors:generate && pnpm --filter @chrome-toolbox/page-translator test && pnpm --filter @chrome-toolbox/page-translator test:e2e && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(page-translator): popup, options page and on-demand page script without site access at install"`

### Task 2: LLM クライアントの `stop` と、モデルがないときのエラー、PLaMo の要求（extension-core）

背景（`docs/llama-server.md` の PLaMo 3 Translate の節、2026-11-06）:

- PLaMo には、訳す文を user の 1 通だけで送る。system を送ると文脈として読まれ、`response_format`、JSON Schema、`grammar` を送ると応答が壊れる。
- `stop: ["<|plamo:tag|>", "<|plamo:bos|>"]` が要る。空の文と `<|plamo:` を含む文は HTTP 400 になる。
- ルーターは、プリセットにないモデルに 400 `model '<name>' not found` を返す（`server-models.cpp` の `router_validate_model`。adoption.md の Clef errors の節）。今の `chat` は、これを `network_failed` にしてしまい、「サーバーに届かない」と区別できない。

**Files:**

- Modify: `packages/extension-core/src/llm.ts`、`src/llm.test.ts`
- Create: `packages/extension-core/src/plamo.ts`、`src/plamo.test.ts`
- Modify: `packages/extension-core/src/index.ts`
- Modify: `tools/errors/catalog.json`（`model_unavailable` → 公開コード `unavailable`）。続けて `pnpm errors:generate`
- Modify: `packages/extension-core/testing/llama-stub.ts`、`testing/llama-stub.test.ts`、`testing/playwright.ts`（export）

**Interfaces:**

- Produces:
  - `ChatRequest.stop?: readonly string[]`（本文の `stop`。ないときは送らない）
  - `chat`:
    - HTTP 404、または HTTP 400 で JSON の `error.message` が `/^model '.+' not found$/u` に合う → `Err(failure('model_unavailable'))`
    - それ以外の 2xx 以外は、今までどおり `network_failed`
  - `src/plamo.ts`:
    - `PLAMO_STOP = ['<|plamo:tag|>', '<|plamo:bos|>'] as const`
    - `PLAMO_CONTEXT_MAX = 600`
    - `plamoAccepts(text: string): boolean`: 前後の空白を除いて空でなく、`<|plamo:` を含まない。
    - `plamoRequest(input: Readonly<{ text: string; context?: string; glossary?: readonly GlossaryEntry[] }>): Pick<ChatRequest, 'messages' | 'templateKwargs' | 'stop' | 'temperature'>`
      - `messages`: `[{ role: 'user', content: text }]` だけ
      - `templateKwargs`: `{ target_lang: 'ja' }` に、あれば `context`（末尾の `PLAMO_CONTEXT_MAX` 文字）と `glossary`（`[{ source, target }]`）
      - `stop`: `PLAMO_STOP`、`temperature`: 0
    - `plamoMaxTokens(limit: number): number` = 8 + 3 × `limit`
    - `parsePlamoText(reply: ChatReply, limit: number, maxTokens: number): Result<string>`
      - 末尾の改行と前後の空白を除いた文を返す。
      - `cutByMaxTokens`、空、途中に改行がある、コードポイント数が `limit` 以上、のどれかなら `response_invalid`。
- スタブ:
  - `StubChat` に `chat_template_kwargs?: Record<string, unknown>`、`stop?: readonly string[]`、`response_format?: unknown` を足す。
  - `chat_template_kwargs.target_lang === 'ja'` のチャット（PLaMo の要求）:
    - system がある、`grammar` か `response_format` がある、`stop` が `PLAMO_STOP` でない、のどれかなら HTTP 400（契約をテストで守る）
    - それ以外は `` `${STUB_PLAMO_PREFIX}${user}` ``。`STUB_PLAMO_PREFIX = '訳P:'`
  - `withoutModel(model: string, responder: Responder): Responder`: その `model` のチャットに、ルーターと同じ 400 `{ error: { code: 400, message: "model '<model>' not found", type: 'invalid_request_error' } }` を返す。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('sends stop strings only when given', async () => {
  /* body.stop は ['<|plamo:tag|>', '<|plamo:bos|>']。stop がない要求の body に stop キーはない */
});
it.each([
  {
    name: 'ルーターの model not found',
    status: 400,
    message: "model 'plamo-3-translate-2b' not found",
    expected: 'model_unavailable',
  },
  { name: '404', status: 404, message: 'File Not Found', expected: 'model_unavailable' },
  { name: 'ほかの 400', status: 400, message: 'Invalid slot ID', expected: 'network_failed' },
  { name: '503', status: 503, message: 'Loading model', expected: 'network_failed' },
])('chat errors: $name', async ({ status, message, expected }) => {
  /* ... */
});
it('builds a PLaMo request with the line as the only message', () => {
  /* messages の長さ 1、role user。templateKwargs は { target_lang: 'ja', context }。grammar と jsonSchema のキーがない */
});
it('keeps the end of a long context', () => {
  /* 1,000 文字の context → 末尾 600 文字 */
});
it.each([
  { name: '訳', text: '最終ボスの攻略\n', finish: 'stop', expected: '最終ボスの攻略' },
  { name: '空', text: '\n', finish: 'stop', expected: 'response_invalid' },
  { name: '2 行', text: 'a\nb\n', finish: 'stop', expected: 'response_invalid' },
  {
    name: '上限',
    text: `${'あ'.repeat(30)}\n`,
    finish: 'stop',
    limit: 30,
    expected: 'response_invalid',
  },
  { name: 'max_tokens で切れた', text: '最終', finish: 'length', expected: 'response_invalid' },
])('parsePlamoText: $name', (row) => {
  /* ... */
});
it.each([
  { text: '', accepts: false },
  { text: '  ', accepts: false },
  { text: 'see <|plamo:tag|>', accepts: false },
  { text: 'Boss guide', accepts: true },
])('plamoAccepts($text)', ({ text, accepts }) => {
  /* ... */
});
// llama-stub.test.ts
it('answers a PLaMo chat and rejects one that breaks the contract with 400', async () => {
  /* 正しい要求 → '訳P:Boss guide'。system 付き、grammar 付き、stop なし → 400 */
});
it('withoutModel answers the router 400 for that model only', async () => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - 400 と 404 の本文は、`model_unavailable` を判定するときだけ読む。読めなければ `network_failed`。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm errors:generate && pnpm --filter @chrome-toolbox/extension-core test && pnpm --filter @chrome-toolbox/comment-assistant test && pnpm check`
  - Expected: PASS。comment-assistant の Clef は自分の fetch を使うので、変化はない。
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): stop strings, model_unavailable and the PLaMo translation request"`

### Task 3: ページ用の行形式のバッチ（extension-core）

背景:

- コメントのバッチ（`commentBatchPrompt`）は、1 行に番号、カテゴリ、訳を並べる。ページにはカテゴリがなく、代わりにインライン要素の印が要る。そこで、同じ行形式のページ用を作る（R20 の出力トークンの節約と、R46 の長さの上限はそのまま）。
- 印は、テキストノードに順に書き戻すためにある。`<p>Click <a>here</a> to <code>run()</code>.</p>` は `Click <1>here</1> to <k1/>.` として渡し、文法で `"<1>"`、`"</1>"`、`"<k1/>"` を決まった順に出させる。語順の違う日本語でも、印の間の文をそれぞれのテキストノードに入れれば、要素は動かない。
- 印の中の文は、元に文字があれば空にできない。リンクの文字が消えることはない。

**Files:**

- Create: `packages/extension-core/src/page-prompt.ts`、`src/page-prompt.test.ts`
- Modify: `packages/extension-core/src/index.ts`
- Modify: `packages/extension-core/testing/llama-stub.ts`、`testing/llama-stub.test.ts`、`testing/playwright.ts`（export）

**Interfaces:**

- Produces:
  - `pageTokenSchema`（Zod mini の union）と `PageToken`:
    - `{ t: 'text'; text: string }`: 訳すテキストノード 1 つ（空白をまとめて前後を除いたもの。1〜400 文字）
    - `{ t: 'space' }`: 空白だけのテキストノード（書き換えない。原文では ' '、訳では何も出さない）
    - `{ t: 'open'; n: number }`、`{ t: 'close'; n: number }`: インライン要素の始まりと終わり（`n` は 1 から）
    - `{ t: 'keep'; n: number; text: string }`: 訳さないインライン要素（code など。`text` は 200 文字まで）
  - `PAGE_MARKERS_MAX = 12`（`open` と `keep` の数の合計）、`PAGE_UNIT_CHARS = 400`
  - `pageTokensValid(tokens: readonly PageToken[]): boolean`: `text` が 1 つ以上、`open` と `close` が正しく入れ子、番号が 1 から順、印が 12 個まで、`text` の合計が 400 文字まで。
  - `pageUnitSource(tokens): { text: string; keep?: Record<string, string> }`: `open` → `<n>`、`close` → `</n>`、`keep` → `<kN/>`（本文は `keep` の `kN` に）、`space` → ' '
  - `pagePieceLimit(text: string): number` = min(2 × コードポイント数 + 16, 2000)
  - `PAGE_REPLY_BUDGET = { line: 8, perMarker: 4, perCharacter: 3 } as const`
  - `pageBatchMaxTokens(units: readonly (readonly PageToken[])[]): number`: 単位ごとに `line` + `perMarker` × 印の数 + `perCharacter` × 各 `text` の `pagePieceLimit` の合計
  - `pageBatchPrompt(input: Readonly<{ page: Readonly<{ title: string; site: string }>; units: readonly (readonly PageToken[])[] }>): { messages: ChatMessage[]; grammar: string }`
    - system（`PAGE_SYSTEM`、export しない固定の文）に書くこと:
      - Web ページの一部を、読み手のために自然で簡潔な日本語に訳す。各単位は、段落、見出し、リスト、表のセル、ラベル、ボタンのどれか。
      - `<n>…</n>` はリンクや強調の語、`<kN/>` はそのまま残すコードや名前（`keep` に本文）。印はすべて同じ順に写し、印の語の訳を `<n>` と `</n>` の間に入れる。
      - URL、数、製品名、コード、ファイル名はそのまま。注、読み、別案、原文は書かない。
      - user の `Page` は文脈だけ。`DATA_NOT_INSTRUCTIONS`（prompts.ts と同じ文。export して共有する）。
      - 1 単位 1 行で、番号、タブ、訳。例は次の 2 行（そのまま入れる）:
        - `{"id":1,"text":"Final Boss Guide"}` → `1\tラスボス攻略`
        - `{"id":2,"text":"Roll <1>backward</1> to dodge the light attack."}` → `2\t光の攻撃は<1>後ろに</1>転がると避けられる。`
    - user: `Page (JSON): {"title":…,"site":…}`（title は 200 文字まで）→ `Segments (one JSON object per line):` → 1 単位 1 行の `{"id":n,"text":…}`（`keep` があれば `"keep":{…}`）
    - 文法: `root ::= line1 line2 …`、`lineN ::= "N\t" <印と訳の並び> "\n"`
      - 訳の部分は `text` ごとに 1 つ。元に文字（`\p{L}`）があれば `[^ \t\n<>] [^\t\n<>]{0,L-1}`、なければ `[^\t\n<>]{0,L}`。`L = pagePieceLimit(text)`
      - 印は文字列そのもの。`space` は何も出さない。
  - `readPagePieces(line: string, tokens: readonly PageToken[]): string[] | undefined`
    - 番号とタブを除いた 1 行を、印の並びどおりに読み、`text` ごとの訳を返す（前後の空白を除く）。
    - 印が足りない、多い、順が違う、文字のあるはずの訳が空、訳が上限に達した、のどれかなら `undefined`。PLaMo の応答（文法なし）にも使う。
  - `parsePageBatch(text: string, units: readonly (readonly PageToken[])[], options: Readonly<{ cut: boolean }>): (string[] | undefined)[]`
    - 入力の順に返す。行がない、番号が違う、読めない単位は `undefined`。`cut` のとき、改行のない最後の行は途中とみなす。
- スタブ: system が `PAGE_SYSTEM` のチャットに `pageBatchReply(user)` を返す。
  - 各単位の `text` を `/(<\/?\d+>|<k\d+\/>)/u` で分け、印はそのまま、空白だけの部分は捨て、ほかの部分は `` `${STUB_PAGE_PREFIX}${部分}` ``。`STUB_PAGE_PREFIX = '訳:'`

- [ ] **Step 1: 失敗するテストを書く**

```ts
const t = (text: string): PageToken => ({ t: 'text', text });
const rich: PageToken[] = [
  t('Click'),
  { t: 'open', n: 1 },
  t('here'),
  { t: 'close', n: 1 },
  t('to'),
  { t: 'keep', n: 1, text: 'run()' },
  t('.'),
];
it('renders markers and keeps code text aside', () => {
  /* pageUnitSource(rich) は { text: 'Click<1>here</1>to<k1/>.', keep: { k1: 'run()' } }。space トークンは ' ' */
});
it('keeps the system turn identical for every page and batch', () => {
  /* page と units が違う 2 つの呼び出しで messages[0] が同じ */
});
it('fixes markers in order and forbids an empty link text in the grammar', () => {
  /* grammar に "<1>" "</1>" "<k1/>" がこの順で現れ、here の訳の規則は 1 文字以上、'.' の規則は 0 文字から */
});
it.each([
  { name: '語順の違う訳', line: '1\tここ<1>を</1>クリックして<k1/>を実行する。', ok: true },
  { name: '印が足りない', line: '1\tここをクリック<k1/>', ok: false },
  { name: '印の順が違う', line: '1\t<k1/>を<1>ここ</1>で', ok: false },
  { name: 'リンクの訳が空', line: '1\tクリック<1></1>して<k1/>。', ok: false },
])('readPagePieces: $name', ({ line, ok }) => {
  /* ok のとき、返り値の長さは text トークンの数（4） */
});
it('reads a batch in input order and fails only the broken unit', () => {
  /* 3 単位、2 行目の番号が 3 → [pieces, undefined, undefined]。cut のとき改行のない最後の行は undefined */
});
it('budgets markers and characters per unit', () => {
  /* pageBatchMaxTokens([[t('Okay')]]) = 8 + 3 × 24 = 80。rich は印 2 つで +8 */
});
it.each([
  { name: '入れ子が壊れている', tokens: [{ t: 'open', n: 1 }, t('a')], valid: false },
  { name: '番号が飛ぶ', tokens: [{ t: 'open', n: 2 }, t('a'), { t: 'close', n: 2 }], valid: false },
  { name: '印が 13 個', tokens: thirteenKeeps, valid: false },
  { name: 'text がない', tokens: [{ t: 'space' }], valid: false },
])('pageTokensValid: $name', ({ tokens, valid }) => {
  /* ... */
});
// llama-stub.test.ts
it('answers a page batch keeping every marker', async () => {
  /* 'Click<1>here</1> to<k1/>.' → '1\t訳:Click<1>訳:here</1>訳: to<k1/>訳:.\n' */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - 文法の文字列のエスケープは `commentBatchGrammar` と同じ書き方にする。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test && pnpm --filter @chrome-toolbox/comment-assistant test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): page batch line format with grammar-fixed inline markers"`

### Task 4: 計測: ページの文での Gemma と PLaMo（bench:page）

ページの文での PLaMo の質は、まだ測っていない（llama-server.md の比較は、話し言葉の字幕と、チャットだけ）。ここで、既定の翻訳モデルと、印のある段落を PLaMo に送るかを決める。計測はコントローラーが、静かなホスト（5 分平均の負荷が 4 未満）で、`docs/llama-server.md` のサーバー（`--parallel 3`、PLaMo 2B を含む）に対して行う。Task 5 から Task 8 と並べて進めてよい。

**Files:**

- Create: `packages/bench/page.ts`、`packages/bench/page.test.ts`
- Create: `packages/bench/fixtures/page/units.jsonl`（自作の 40 単位）
  - 英語 24: 見出しとナビとボタンの短いラベル 8、攻略 Wiki 風の段落（150〜400 文字）10、印のある段落（リンク、強調、`keep` のコード）6
  - 韓国語、スペイン語、中国語、インドネシア語を 4 つずつ（うち各 1 つは印のある段落）
  - 1 行は `{"id":"p-1","lang":"en","kind":"label"|"paragraph"|"rich","tokens":[…]}`
- Modify: `packages/bench/package.json`（`bench:page`）、`packages/bench/README.md`
- Modify: `docs/adoption.md`（新しい節「Page translation (Task 4)」）

**Interfaces:**

- Produces:
  - `pnpm --filter @chrome-toolbox/bench bench:page -- --server <url> --gemma <model> [--plamo <model>] [--set <file>] [--rounds 3] [--out <file>]`
  - 測るもの:
    - Gemma: 拡張と同じ形のバッチ（最大 6 単位、800 文字）を、`totalSlots - 1` の枠で順に送る。単位ごとの時間（そのバッチの時間）、失敗、出力トークン。
    - PLaMo: 1 単位ずつ、枠 1 と 2 で同時に 2 件まで。`text` だけの単位はそのまま、印のある単位は `pageUnitSource` の文で送る。時間、失敗、印を正しく写した数（`readPagePieces` が読めた数）。
    - 最初の画面: fixture の最初の 12 単位を、文書の順に、拡張と同じ送り方で訳し終えるまでの時間。`--rounds` 回の p50。
  - 結果: `bench-data/results/page-<時刻>.jsonl`（先頭は `{"type":"meta"}`。ほかのベンチと同じ）。訳を含むので gitignore の下にだけ置く。表を標準出力に出す。
  - `page.test.ts`: 偽のサーバーで、バッチの形、PLaMo の要求の契約（system、grammar、response_format がない。`stop` がある）、最初の画面の時間の計算、印を写した数の数え方を確かめる。

- [ ] **Step 1: 失敗するテストを書く**（上の `page.test.ts`）
- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**（`translate.ts` と `results.ts` の作りに合わせる）
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: 実機で測る（コントローラー）**
  - Run: `pnpm --filter @chrome-toolbox/bench bench:page -- --server http://127.0.0.1:18083 --gemma gemma4-e4b --plamo plamo-3-translate-2b --rounds 3`
  - 訳の質: コントローラーが、結果のファイルから単位ごとに PLaMo と Gemma の訳を、どちらか分からない順（種を記録した乱数）に並べて比べ、良い／同じ／悪いを付ける。言語と種類ごとに数える。ユーザーの抜き取り確認はしていない、と書く。
- [ ] **Step 6: 決める（規則は測る前に決めておく）**
  - PLaMo を既定にする条件（すべて満たすとき）:
    - 全 40 単位で、Gemma より悪いものが 25% 以下
    - 最初の画面の時間の p50 が、Gemma の半分以下
    - 失敗（読めない、切れた、HTTP エラー）が 2% 以下
  - 印のある単位を PLaMo に送る条件（すべて満たすとき）:
    - 印を正しく写した単位が 95% 以上
    - 印のある単位で、Gemma より悪いものが 25% 以下
  - 満たさなければ、既定は Gemma のままで、PLaMo は設定で選べる任意のモデルにする。印のある単位は Gemma に送る。
  - 決めた値は、Task 8 の `PLAMO_TAKES_RICH` と `defaultPageSettings.translator` に入れる（Task 8 がまだなら、その実装者に渡す）。
- [ ] **Step 7: 記録する**
  - `docs/adoption.md` に、サーバー（llama.cpp のコミット、プリセット、`--parallel`）、モデルとリビジョン、日付、上の数字、規則と決定を書く。訳の本文は書かない。
- [ ] **Step 8: Commit**
  - `git commit -m "feat(bench): page translation bench comparing Gemma batches with PLaMo per segment"`
  - 決定を Task 8・Task 9 の後に入れる場合は、別に `git commit -m "docs(adoption): page translation model decision"`

### Task 5: 段落の切り出し（content script）

背景:

- extension-core の `scriptLanguageGuess` は、仮名が 1 文字でもあれば日本語とする。英語の段落に日本語の語が 1 つ入っていると、訳さなくなる。ページ用には、文字の割合で決める。
- 漢字だけの文は、日本語か中国語か分からない。ページの `<html lang>` で決める。

**Files:**

- Create: `packages/page-translator/src/language.ts`、`test/unit/language.test.ts`
- Create: `packages/page-translator/src/content/segment.ts`、`test/unit/segment.test.ts`
- Create: `packages/page-translator/test/unit/fixtures/article.html`（自作の攻略 Wiki 風のページ。Task 12 の E2E も使う）

**Interfaces:**

- Produces（`src/language.ts`）:
  - `pageLangHint(doc: Document): string | undefined`: `<html lang>` を小文字にしたもの。
  - `needsPageTranslation(text: string, hint: string | undefined): boolean`（上から順に決める）:
    1. 文字（`\p{L}`）が 2 つ未満 → false
    2. URL（`https?://` か `www.` で始まる 1 語）かメールアドレスだけ → false
    3. 仮名が 1 つ以上あり、仮名と漢字の合計が文字の半分以上 → false（日本語）
    4. 文字がすべて漢字 → `hint` が `ja` で始まれば false、そうでなければ true
    5. それ以外 → true
- Produces（`src/content/segment.ts`）:
  - `RequestUnit = Readonly<{ key: string; tokens: readonly PageToken[] }>`（`key` は `JSON.stringify(tokens)`。キャッシュと重複除きに使う）
  - `Segment = Readonly<{ id: number; block: Element; nodes: readonly Text[]; originals: readonly string[]; tokens: readonly PageToken[]; units: readonly RequestUnit[] }>`
    - `nodes[i]` と `originals[i]`（走査したときの `data`）は、`tokens` の i 番目の `text` に対応する。
    - `units` は普通 1 つ（`tokens` そのもの）。400 文字を超える 1 つのテキストノードは、文の区切りで 400 文字までの `text` だけの単位に分け、訳はつないで 1 つにする。
  - `isSkipped(element: Element): boolean`: Global Constraints の「翻訳しないもの」の要素。`translate` 属性は、いちばん近い祖先のものを見る。
  - `INLINE_TAGS`: `a abbr b bdi bdo big cite data del dfn em font i ins label mark q s small span strong sub sup time u`。`code kbd samp var tt` は、段落の中では `keep` になる。`img` と `wbr` は無視し、`br` は段落を区切る。
  - `segmentsOf(block: Element, hint: string | undefined, nextId: () => number): Segment[]`
    - `block` の子を前から見て、テキストノードとインライン要素（中にブロック要素を含まないもの）が続く部分を 1 つの段落にする。ブロック要素を含むインライン要素は、段落に入れず、走査がその中に入る。
    - `text` は、空白をまとめて前後を除いたもの。段落の最初と最後の空白だけのノードは入れない。
    - 印が 12 個を超える、または `text` の合計が 400 文字を超える段落は、テキストノードごとの段落に分ける。
    - `needsPageTranslation` が、段落の `text` をつないだ文に false なら、段落にしない。
  - `createScanner(options: { root: Element | ShadowRoot; hint: string | undefined; nextId: () => number; timers: Timers; now: () => number; sliceMs?: number; onSegments: (segments: Segment[]) => void; onShadowRoot: (root: ShadowRoot) => void; onDone: () => void }): { cancel(): void }`
    - `TreeWalker`（要素だけ。`isSkipped` の部分木は飛ばす）で、インラインでない要素ごとに `segmentsOf` を呼ぶ。
    - 1 回の処理は `sliceMs`（既定 8）まで。超えたら `timers.set(…, 0)` で続ける。区切りごとに `onSegments`。
    - 開いた Shadow DOM は `onShadowRoot` で知らせ、その中も同じように走査する。

- [ ] **Step 1: 失敗するテストを書く**（`// @vitest-environment jsdom`、`environmentOptions.jsdom.url` は `https://wiki.fixture.test/`）

```ts
it.each([
  { text: 'Phase 2 begins at 50% HP.', hint: undefined, needs: true },
  { text: '第2形態は体力が半分で始まる。', hint: undefined, needs: false },
  { text: 'The word かわいい means cute.', hint: undefined, needs: true },
  { text: '東京', hint: 'ja', needs: false },
  { text: '东京天气', hint: 'zh-cn', needs: true },
  { text: '東京', hint: undefined, needs: true },
  { text: 'Q', hint: undefined, needs: false },
  { text: '42 / 100', hint: undefined, needs: false },
  { text: 'https://wiki.example.gg/bosses', hint: undefined, needs: false },
  { text: '안녕하세요 여러분', hint: 'ja', needs: true },
])('needsPageTranslation($text, $hint)', ({ text, hint, needs }) => {
  /* ... */
});
it.each([
  { name: 'input', html: '<p><input value="Search"></p>' },
  { name: 'textarea の初期値', html: '<textarea>Default text here</textarea>' },
  { name: 'value のない option', html: '<select><option>Easy mode</option></select>' },
  { name: 'pre と code', html: '<pre>let x = 1;</pre><p><code>run()</code></p>' },
  { name: 'kbd と samp', html: '<kbd>Ctrl</kbd><samp>Error found</samp>' },
  { name: 'svg の text', html: '<svg><text>Boss HP</text></svg>' },
  { name: 'translate=no', html: '<div translate="no"><p>Brand Name Here</p></div>' },
  { name: 'notranslate', html: '<p class="notranslate">Keep this phrase</p>' },
  { name: 'contenteditable', html: '<div contenteditable="true">Type your notes</div>' },
  { name: 'アイコンフォント', html: '<p><span class="material-icons">search</span></p>' },
  { name: 'script と style', html: '<script>var hello = 1</script><style>.a{}</style>' },
  { name: '日本語', html: '<p>推奨レベルは150以上です。</p>' },
])('makes no segment for $name', ({ html }) => {
  /* segmentsOf と scanner のどちらでも 0 件 */
});
it('translates translate="yes" inside translate="no"', () => {
  /* <div translate="no"><p translate="yes">Read this part</p></div> → 1 件 */
});
it('makes one rich segment of a paragraph with a link and inline code', () => {
  /* <p>Click <a href="/dl">here</a> to <code>run()</code>.</p>
     tokens: text 'Click', open 1, text 'here', close 1, text 'to', keep 1 'run()', text '.'
     nodes の長さ 4、originals は 'Click '、'here'、' to '、'.' */
});
it('splits a paragraph at br and keeps a nested inline element', () => {
  /* <p>Line one<br><a>Read <b>more</b></a></p> → 2 件。2 件目は open 1、text、open 2、text、close 2、close 1 */
});
it('falls back to one segment per text node beyond 12 markers', () => {
  /* 13 個のリンクの段落 → リンクの文字ごとの段落 */
});
it('splits a long text node into units at sentence ends', () => {
  /* 900 文字（10 文）→ units 3 つ、どれも 400 文字以下、nodes は 1 つ */
});
it('treats an inline element holding a block as a container', () => {
  /* <a><div>Card title</div><div>Card body text</div></a> → 2 件、block はそれぞれの div */
});
it('reports and scans open shadow roots, not closed ones', () => {
  /* open の中の <p> は 1 件、onShadowRoot が 1 回。closed の中は 0 件 */
});
it('scans 2,000 paragraphs in slices of at most sliceMs', async () => {
  /* 偽の時計で 1 段落 0.01 ms。onSegments が 2 回以上呼ばれ、各回の処理時間 ≤ 8 ms */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - CSS の `display` は読まない（`getComputedStyle` はレイアウトを強いるため）。タグで決める。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(page-translator): split pages into paragraphs with inline markers, skipping code, forms and Japanese"`

### Task 6: 書き込みと原文への復元、表示方法

**Files:**

- Create: `packages/page-translator/src/content/writer.ts`、`test/unit/writer.test.ts`
- Modify: `packages/page-translator/src/protocol.ts`（`DISPLAY_MODES`、`DisplayMode`）
- Create: `packages/page-translator/test/unit/fingerprint.ts`（`fingerprint(root: Node): string`。Task 1 の E2E の `fingerprint` と同じ規則の jsdom 版）

**Interfaces:**

- Consumes: `Segment`（Task 5）
- Produces:
  - `DISPLAY_MODES = ['replace', 'pair'] as const`、`DisplayMode`（`src/protocol.ts` に置く）
  - `PAIR_TAG = 'pt-ja'`
  - `mapOffset(offset: number, oldLength: number, newLength: number): number`: 0 → 0、`oldLength` 以上 → `newLength`、ほかは `Math.round(offset × newLength / oldLength)`
  - `createWriter(doc: Document, options?: { timers?: Timers; sliceNodes?: number }): Writer`（`sliceNodes` の既定は 500）
  - `Writer`:
    - `write(segment: Segment, pieces: readonly string[], mode: DisplayMode): boolean`
      - どれかのノードの `data` が `originals[i]` と違えば、何も書かずに false（ページが書き換えた。呼び手が段落を作り直す）。
      - `replace`: `node.data = 前の空白 + pieces[i] + 後ろの空白`（空白は `originals[i]` のもの）。
      - `pair`: テキストは変えない。段落の最後のノードを含む、`block` 直下の子の直後に `<pt-ja>` を 1 つ足す（段落がリンクで終わっても、リンクの中には入れない。`display: block`、open な Shadow DOM に `pieces.join('')`、左に線のある小さめの文字。モック B の `.tr`）。
      - 書く前に、選択範囲の端が書き換えるノードにあれば覚え、書いた後に `mapOffset` で戻す（`setBaseAndExtent`）。
    - `setMode(mode: DisplayMode): void`: 書いた段落を、もう一方の方法で書き直す（区切って行う）。
    - `restore(options: { sliced: boolean; done?: () => void }): void`
      - 記録した各ノードについて、今の `data` が書いた訳と同じときだけ原文に戻す。違えば戻さない（ページの値）。
      - `<pt-ja>` をすべて取り除き、記録を空にする。
      - `sliced` のときは `sliceNodes` ずつ、`timers.set(…, 0)` で区切る。`pagehide` では `sliced: false`。
      - 選択範囲の扱いは `write` と同じ。
    - `changed(node: Text): 'ours' | 'page' | 'unknown'`: 記録があり `data` が書いた訳なら `ours`、違えば `page`（その記録を捨てる）、記録がなければ `unknown`。
    - `originalText(element: Element): string | undefined`: その要素が `block` の、訳した段落の原文（ツールチップ用、300 文字まで）。
    - `segmentOf(node: Node): Segment | undefined`: そのノードを含む、訳した段落。
    - `size(): number`: 原文を持つ段落の数。
  - 記録の持ち方: `WeakMap<Text, { original: string; written: string }>` と、たどるための `Set<WeakRef<Text>>`。ページから外れて回収されたノードは、たどるときに捨てる。

- [ ] **Step 1: 失敗するテストを書く**（jsdom）

```ts
it.each(['replace', 'pair'] as const)('restores the exact DOM after %s', (mode) => {
  /* article.html を読み、fingerprint(before) === fingerprint(after restore)。テキストノードとリンクの要素は同じオブジェクト */
});
it('writes pieces into the text nodes in order and keeps their outer spaces', () => {
  /* 'Click '、'here'、' to '、'.' に 'ここ'、'を'、'クリックして'、'。' → 'ここ '、'を'、' クリックして '、'。' */
});
it('never empties a link and never moves an element', () => {
  /* write の後も <a> の親と位置が同じで、textContent が空でない */
});
it('refuses to write when the page changed a node since the scan', () => {
  /* node.data を書き換えてから write → false、data はページの値 */
});
it('keeps the page value on restore when the page rewrote a translated node', () => {
  /* write → ページが data = '4 comments' → restore 後も '4 comments'。changed() は 'page' */
});
it('reports its own writes as ours', () => {
  /* write 直後の changed(node) は 'ours' */
});
it('shows the translation below the original in pair mode without changing the text', () => {
  /* block.textContent は翻訳前と同じ。<pt-ja> の shadowRoot に訳 */
});
it('switches replace → pair → replace and still restores the exact DOM', () => {
  /* ... */
});
it.each([
  { name: '先頭', offset: 0, oldLength: 10, newLength: 4, expected: 0 },
  { name: '末尾', offset: 10, oldLength: 10, newLength: 4, expected: 4 },
  { name: '途中', offset: 5, oldLength: 10, newLength: 4, expected: 2 },
])('mapOffset: $name', ({ offset, oldLength, newLength, expected }) => {
  /* ... */
});
it('keeps a selection inside the same nodes across write and restore', () => {
  /* 'here' の中の選択 → write の後も anchorNode は同じノード */
});
it('restores detached nodes too, in slices of sliceNodes', () => {
  /* 1,200 ノード、sliceNodes 500 → 3 回に分かれる。外したノードも原文に戻る */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `<pt-ja>` は未定義のカスタム要素名で、`attachShadow` はそのまま使える（content script の isolated world では `customElements` を使えない）。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(page-translator): write translations into text nodes and restore the exact page"`

### Task 7: 見えている段落から順に訳す（スケジューラー）

**Files:**

- Create: `packages/page-translator/src/content/scheduler.ts`、`test/unit/scheduler.test.ts`
- Modify: `packages/page-translator/src/protocol.ts`（`TranslateRequest`、`TranslateReply`、`progressSchema`、`PROGRESS_PORT`。Task 8 が `page/translate` の経路にこの型を使う）
- Create: `packages/page-translator/test/unit/intersection.ts`（comment-assistant の `test/unit/intersection.ts` を写す）

**Interfaces:**

- Consumes: `createScanner`、`Segment`（Task 5）、`Writer`（Task 6）
- Produces:
  - `PROGRESS_PORT = 'page-progress'`（`src/protocol.ts`。Task 10 と Task 11 が使う）
  - `PAGE_TIMING = { nearMargin: '50% 0px', mutationFlushMs: 300, retryMs: [5_000, 30_000], attempts: 3 } as const`
  - `PAGE_LIMITS = { batchUnits: 6, batchChars: 800, waiting: 400, observedBlocks: 5_000, tracked: 10_000, mutationRoots: 500, shadowRoots: 200, cache: 2_000 } as const`
  - `TranslateRequest = { purpose: 'page' | 'selection'; units: { id: number; tokens: PageToken[] }[]; page: { title: string; site: string } }`（スケジューラーは常に `'page'`。`'selection'` は Task 10 の吹き出し）
  - `TranslateReply = { results: { id: number; pieces?: string[] }[]; translator: 'gemma' | 'plamo'; notice?: 'plamo_missing' }`
  - `Progress`（`src/protocol.ts` の `progressSchema`）: `{ state: 'idle' | 'on' | 'restoring' | 'restored'; mode: DisplayMode; found: number; done: number; waiting: number; failed: number; tracked: number; cached: number; limit: boolean; notice?: 'unreachable' | 'plamo_missing'; translator?: 'gemma' | 'plamo' }`
  - `createScheduler(options: { doc: Document; writer: Writer; translate: (request: TranslateRequest, signal: AbortSignal) => Promise<Result<TranslateReply>>; mode: () => DisplayMode; timers?: Timers; now?: () => number; onProgress: (progress: Progress) => void }): Scheduler`
  - `Scheduler`:
    - `start(): void`: 見えていれば、走査と監視を始める。見えていなければ、`visibilitychange` を待つ。2 回目は、失敗を消して近くの段落を見直す。
    - `stop(): void`: 監視、タイマー、listener、キャッシュを解放し、進行中の要求を中断する。
    - `progress(): Progress`
  - 振る舞い:
    - 段落のブロックを IntersectionObserver（`nearMargin`）で見る。近くに来たブロックの、まだ訳していない単位を、文書の順に待ちに入れる。キャッシュにあればすぐ書く。同じ `key` の単位は 1 回だけ頼む。
    - 要求中のバッチがなく、見えているときだけ、次のバッチを作る。入れるのは、ブロックが今も近くにある単位だけ（`batchUnits`、`batchChars` まで）。
    - 応答の訳を書く。段落の単位がすべてそろったら `writer.write`。false なら、そのブロックの段落を作り直す。ブロックの段落がすべて終わったら、監視をやめる。
    - 見えなくなったら、要求を中断し（その単位は待ちに戻る。回数には数えない）、新しいバッチを出さない。見えるようになったら、近くのブロックを見直す（`unobserve` してから `observe`）。
    - MutationObserver（1 つ）の記録を、`mutationFlushMs` ごとにまとめて処理する。
      - 足されたノード → その部分を走査する（`<pt-ja>` と `<pt-overlay>` は無視）。
      - `characterData` → `writer.changed` が `page` なら、そのブロックの段落を作り直して訳し直す。`ours` は無視する。
      - 外されたノードがあれば、つながっていないブロックの監視をやめ、その単位を待ちから除く。
      - 記録の対象が `mutationRoots` を超えたら、本文を走査し直す。
    - 失敗:
      - `network_failed`、`queue_full`、`ipc_failed`、時間切れ → `retryMs` の後に送り直す。`attempts` 回で、その段落は失敗。`notice: 'unreachable'`。
      - 単位の `pieces` がない（モデルの行が読めない）→ その段落は失敗。送り直さない。
      - `notice: 'plamo_missing'` → そのまま `Progress` に出す。
    - 上限: `tracked` に達したら新しい段落を登録しない（`limit: true`）。`observedBlocks` に達したら、走査を止め、監視が空いたら続ける。

- [ ] **Step 1: 失敗するテストを書く**（jsdom、偽の IntersectionObserver と時計、偽の `translate`）

```ts
it('asks only for paragraphs near the viewport, one batch at a time', async () => {
  /* 300 段落、近くは 1〜12。要求は 2 回（6 + 6）、同時に 1 つ。13 番目以降は含まない */
});
it('caps a batch at 6 units and 800 characters', async () => {
  /* 300 文字の段落 4 つ → 2 + 2 */
});
it('never asks for paragraphs that a jump scrolled past', async () => {
  /* 近くを 1〜12 から 150〜162 に変える → 13〜149 は要求に出ない */
});
it('drops a waiting paragraph that left the viewport before its batch', async () => {
  /* 1 つ目のバッチの応答前に 7〜12 を画面外にする → 2 つ目のバッチに入らない */
});
it('asks once for repeated text and fills every copy from the cache', async () => {
  /* 'Edit' が 20 個 → 単位 1 つ。応答の後、20 個とも書かれる */
});
it('asks nothing for a Japanese page', async () => {
  /* 日本語だけの article → translate は 0 回 */
});
it('stops while hidden and resumes when visible', async () => {
  /* hidden で signal が abort、その後 translate は 0 回。visible で続きを頼む */
});
it('waits until visible before scanning a page opened in a background tab', () => {
  /* hidden で start → 走査も observe もしない */
});
it('batches 50 added paragraphs into one flush', async () => {
  /* 300 ms の間に 50 段落を足す → 走査は 1 回、要求は近くのものだけ */
});
it('re-translates a paragraph the page rewrote and keeps the page value on restore', async () => {
  /* Review Focus。書いた後にページが data を変える → 新しい原文で 1 回頼む */
});
it('releases blocks an SPA removed', async () => {
  /* Review Focus。本文を丸ごと入れ替える → 偽の observer の targets に外れた要素がない。新しい本文の近くだけを頼む */
});
it('retries a failed batch twice, then marks it failed', async () => {
  /* Review Focus。network_failed が続く → 0、5、35 秒に 3 回、その後 0 回。progress.failed と notice 'unreachable' */
});
it('stops registering at 10,000 tracked paragraphs', async () => {
  /* limit が true、それ以上 observe しない */
});
it('ignores its own writes and pair hosts in the mutation records', async () => {
  /* write と <pt-ja> の追加で、新しい走査も要求も起きない */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - タイマーは 1 種類につき常に 1 つ以下（変化の記録、送り直し、走査の続き）。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(page-translator): translate paragraphs as they come near the viewport, in the foreground only"`

### Task 8: background の翻訳（Gemma のバッチ、PLaMo、枠、中断）

**Files:**

- Create: `packages/page-translator/src/translator.ts`、`test/unit/translator.test.ts`
- Create: `packages/page-translator/src/settings.ts`（この Task では `pageSettingsSchema` と `pageSettingsStore` だけ。サイトの関数は Task 9）、`test/unit/settings.test.ts`
- Modify: `src/protocol.ts`（`page/translate`、`page/cancel` の経路。型は Task 7 のものに合わせる）、`src/runtime.ts`（経路と送り手の確認、`tabs.onRemoved`、設定の変更）

**Interfaces:**

- Consumes: `pageBatchPrompt`、`pageBatchMaxTokens`、`parsePageBatch`、`pageTokensValid`、`pageUnitSource`、`readPagePieces`、`pagePieceLimit`（Task 3）、`plamoRequest`、`plamoAccepts`、`plamoMaxTokens`、`parsePlamoText`（Task 2）
- Produces:
  - `src/settings.ts`:
    - `pageSettingsSchema = z.strictObject({ v: z.literal(1), mode: z.enum(DISPLAY_MODES), translator: z.enum(['gemma', 'plamo']), plamoModel: z.string().check(z.minLength(1), z.maxLength(128)), always: z.array(…).check(z.maxLength(200)), never: z.array(…).check(z.maxLength(500)) })`
    - `defaultPageSettings = { v: 1, mode: 'replace', translator: 'gemma', plamoModel: 'plamo-3-translate-2b', always: [], never: [] }`（`translator` は Task 4 の決定に従う）
    - `pageSettingsStore(area: StorageArea, key = 'page'): { load(): Promise<Result<PageSettings>>; save(settings: PageSettings): Promise<Result<PageSettings>> }`
    - 接続先と `models.translate` は、今までどおり extension-core の `settingsStore`（キー `settings`）に置く。共有のスキーマは変えない。
  - `src/protocol.ts`:
    - `'page/translate'`: request `{ purpose: z.enum(['page', 'selection']), units: { id: z.int(), tokens: pageTokenSchema[] }[]（1〜6）, page: { title（200 文字まで）, site（253 文字まで） } }`、response `TranslateReply`
    - `'page/cancel'`: request `{}`、response `{}`（そのタブの `'page'` の要求だけを止める）
  - `slotPlan(totalSlots: number | undefined): { gemma: number | undefined; plamo: readonly number[] }`
    - `undefined` → `{ gemma: undefined, plamo: [] }`（`id_slot` を付けない）
    - 1 → `{ gemma: 0, plamo: [0] }`、3 → `{ gemma: 2, plamo: [1, 2] }`、2 → `{ gemma: 1, plamo: [1] }`
  - `PLAMO_TAKES_RICH: boolean`（Task 4 の決定。決まるまでは false）
  - `createPageTranslator(options: { fetch: Fetch; settings: SettingsStore; pageSettings: PageSettingsStore; timeoutMs?: number }): PageTranslator`
  - `PageTranslator`:
    - `translate(tabId: number, request: TranslateRequest): Promise<Result<TranslateReply>>`
      - `pageTokensValid` でない単位があれば `input_invalid`。
      - 同じタブ、同じ `purpose` の前の要求が進行中なら、それを中断する（タブと `purpose` ごとに `AbortController` は 1 つ。吹き出しの要求が、ページのバッチを止めることはない）。
      - 翻訳モデルが `plamo` で、PLaMo が使えるとき: `plamoAccepts` で、`text` だけの単位（`PLAMO_TAKES_RICH` なら印のある単位も）を PLaMo に送る。`context` は `Page: <title>` と、同じ要求の中の前の 2 単位の原文。枠は `plan.plamo` の空いているもの、同時に `plan.plamo.length` 件まで。
      - 残りと、PLaMo で失敗した単位を、1 つの Gemma のバッチにする（`plan.gemma`、`models.translate`）。
      - PLaMo が `model_unavailable` → 設定が変わるまで PLaMo を使わず、`notice: 'plamo_missing'`。
      - Gemma のバッチ自体の失敗（接続できない、時間切れ、待ちがいっぱい）は、要求全体の `Err` にする（content script が送り直す）。
    - `cancel(tabId: number, purpose?: 'page' | 'selection'): void`（`purpose` がなければ両方。`page/cancel` は `'page'`、タブを閉じたときは両方）
    - `reload(): void`（設定が変わった。次の要求で読み直し、`/props` も聞き直す）
    - `dispose(): void`
  - 枠の数は、モデルごとに `props({ model })` で 1 回聞く。失敗したら、次にそのモデルのチャットが成功した後に、もう 1 回聞く（comment-assistant の `askSlots` と同じ）。
  - キューは Gemma（同時に 1、待ち 16）と PLaMo（同時に 2、待ち 16）の 2 つ。どちらもタイムアウトは 30 秒。
  - 経路: `page/translate` と `page/cancel` は `senderKind === 'content'` だけ。`tabs.onRemoved` で `cancel`。`storage.onChanged` の `settings` か `page` で `reload`。

- [ ] **Step 1: 失敗するテストを書く**（偽の fetch。comment-assistant の pipeline のテストと同じ作り）

```ts
it.each([
  { total: undefined, plan: { gemma: undefined, plamo: [] } },
  { total: 1, plan: { gemma: 0, plamo: [0] } },
  { total: 2, plan: { gemma: 1, plamo: [1] } },
  { total: 3, plan: { gemma: 2, plamo: [1, 2] } },
])('slotPlan($total)', ({ total, plan }) => {
  /* ... */
});
it('sends one Gemma batch with grammar, model and the last slot', async () => {
  /* /props?model=gemma4-e4b が total_slots 3 → id_slot 2、grammar あり、temperature 0、enable_thinking false */
});
it('sends no id_slot until the server tells its slots', async () => {
  /* /props が 503 → id_slot なし。チャットの成功後にもう 1 回 /props */
});
it('sends plain units to PLaMo one by one on slots 1 and 2', async () => {
  /* translator 'plamo'、3 単位 → PLaMo の要求 3 件、id_slot は 1 か 2、同時に 2 件まで、stop あり、system と grammar なし */
});
it('sends rich units to Gemma while PLAMO_TAKES_RICH is false', async () => {
  /* ... */
});
it('falls back to one Gemma batch for the units PLaMo failed', async () => {
  /* PLaMo が 2 行の応答 → その単位だけが Gemma のバッチに入る。結果の translator は 'plamo' */
});
it('uses Gemma alone and reports plamo_missing when the router has no PLaMo', async () => {
  /* Review Focus。withoutModel 相当の 400 → notice 'plamo_missing'、2 回目の要求は PLaMo に行かない */
});
it('aborts the running page request of a tab on cancel and both on tab removal', async () => {
  /* page/cancel は selection の要求を止めない */
  /* Err(operation_cancelled)。fetch の signal が aborted */
});
it('rejects invalid tokens with input_invalid', async () => {
  /* ... */
});
it.each([
  { route: 'page/translate', sender: 'page', expected: 'sender_forbidden' },
  { route: 'page/translate', sender: 'iframe', expected: 'sender_forbidden' },
  { route: 'page/start', sender: 'content', expected: 'sender_forbidden' },
])('$route from $sender', async ({ route, sender, expected }) => {
  /* ... */
});
it('loads page settings with defaults and rejects an unknown translator', async () => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(page-translator): background translator with Gemma batches, optional PLaMo and fixed slots"`

### Task 9: 制御（注入、右クリックメニュー、ショートカット、常に翻訳、翻訳しない）

**Files:**

- Modify: `packages/page-translator/src/control.ts`、`src/settings.ts`、`src/protocol.ts`、`src/runtime.ts`、`src/entrypoints/background.ts`
- Modify: `tools/errors/catalog.json`（`page_excluded` → 公開コード `permission_denied`）。続けて `pnpm errors:generate`
- Test: `test/unit/control.test.ts`、`test/unit/settings.test.ts`

**Interfaces:**

- Produces:
  - `src/settings.ts`:
    - `Site = Readonly<{ host: string; pattern: string }>`
    - `siteOf(url: string): Result<Site>`: `http:` と `https:` だけ。`host` は小文字の hostname、`pattern` は `<protocol>//<host>/*`。ほかは `page_restricted`。
    - `normalizeHost(input: string): Result<string>`: 設定ページで入れた値を hostname にする（`https://` や末尾の `/` は除く）。だめなら `input_invalid`。
    - `isNever(host: string, never: readonly string[]): boolean`: 同じか、`.<entry>` で終わる。
    - `isAlways(url: string, always: readonly string[]): boolean`
  - `src/control.ts`:
    - `ALWAYS_SCRIPT_ID = 'page-always'`、`MENU_ID = 'translate-selection'`、`COMMAND_ID = 'translate-selection'`
    - `ControlApi`（テストは偽物を渡す）: `scripting`（`executeScript`、`registerContentScripts`、`updateContentScripts`、`unregisterContentScripts`、`getRegisteredContentScripts`）、`tabs.sendMessage`、`permissions.contains`、`storage.local`
    - `createControl(api: ControlApi): Control`
    - `Control`:
      - `start(tabId: number, url: string | undefined): Promise<Result<void>>`: `isNever` なら `page_excluded`。`injectPage` の後に `{ action: 'translate' }`。
      - `restore(tabId: number): Promise<Result<void>>`: `{ action: 'restore' }`。content script がなければ Ok（戻すものがない）。
      - `selection(tabId: number, text: string | undefined): Promise<Result<void>>`: 除外のサイトでも動く。`injectPage` の後に `{ action: 'selection', text }`（右クリックメニューの `selectionText`）。
      - `syncAlways(): Promise<Result<void>>`: `always` のうち、`never` に当たらず、`permissions.contains` が true の `pattern` を、`ALWAYS_SCRIPT_ID` の登録（`js: [PAGE_SCRIPT]`、`runAt: 'document_idle'`、`allFrames: false`、`persistAcrossSessions: true`）にそろえる。0 件なら登録を消す。
      - `forget(origins: readonly string[]): Promise<Result<void>>`: `permissions.onRemoved` で外された `pattern` を `always` から消す。
  - background の配線:
    - `runtime.onInstalled` で `contextMenus.create({ id: MENU_ID, title: '選択範囲を翻訳', contexts: ['selection'] })`
    - `contextMenus.onClicked` → `selection(tab.id, info.selectionText)`
    - `commands.onCommand(COMMAND_ID, tab)` → `selection(tab.id, undefined)`
    - service worker の起動、`storage.onChanged` の `page`、`permissions.onAdded`、`permissions.onRemoved`（先に `forget`）→ `syncAlways`
    - `page/start { tabId, url }`、`page/restore { tabId }` は `senderKind === 'page'` だけ。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  {
    url: 'https://wiki.example.gg/a?b#c',
    site: { host: 'wiki.example.gg', pattern: 'https://wiki.example.gg/*' },
  },
  {
    url: 'http://192.168.1.10:8080/',
    site: { host: '192.168.1.10', pattern: 'http://192.168.1.10/*' },
  },
  { url: 'chrome://settings', site: 'page_restricted' },
  { url: 'file:///tmp/a.html', site: 'page_restricted' },
])('siteOf($url)', ({ url, site }) => {
  /* ... */
});
it.each([
  { host: 'bank.example.com', never: ['example.com'], excluded: true },
  { host: 'www.bank.example.com', never: ['bank.example.com'], excluded: true },
  { host: 'notbank.example.com', never: ['bank.example.com'], excluded: false },
])('isNever($host)', ({ host, never, excluded }) => {
  /* ... */
});
it('refuses to start on an excluded site and injects nothing', async () => {
  /* page_excluded、executeScript は呼ばれない */
});
it('translates a selection on an excluded site', async () => {
  /* executeScript のあと { action: 'selection', text: 'rolling backward' } */
});
it('registers the always script for granted, non-excluded sites only', async () => {
  /* always 3 件（1 件は権限なし、1 件は never）→ matches は 1 件 */
});
it('removes the registration when no always site is left', async () => {
  /* ... */
});
it('forgets an always site whose permission the user removed', async () => {
  /* permissions.onRemoved → always から消え、登録も消える */
});
it('creates the context menu once on install', async () => {
  /* fakeBrowser の runtime.onInstalled を発火 → create 1 回、contexts ['selection'] */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm errors:generate && pnpm --filter @chrome-toolbox/page-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(page-translator): injection on demand, selection menu and shortcut, always and never sites"`

### Task 10: content script の組み立て（セッション、ツールチップ、吹き出し、進み具合）

**Files:**

- Create: `packages/page-translator/src/content/session.ts`、`src/content/overlay.ts`
- Modify: `src/entrypoints/page.content.ts`
- Test: `test/unit/session.test.ts`、`test/unit/overlay.test.ts`

**Interfaces:**

- Consumes: `createScheduler`（Task 7）、`createWriter`（Task 6）、`pageCommandSchema`、`claimPage`（Task 1）、`progressSchema`、`PROGRESS_PORT`（Task 7）、`pageSettingsStore`、`isAlways`、`isNever`（Task 8・Task 9）
- Produces:
  - `OVERLAY_TAG = 'pt-overlay'`
  - `OVERLAY_TIMING = { hoverDelayMs: 300, tooltipChars: 300 } as const`
  - `createOverlay(doc: Document, timers: Timers): Overlay`
    - `<pt-overlay>`（open な Shadow DOM、`position: fixed`、`z-index: 2147483647`、`pointer-events: none`。中の吹き出しだけ `pointer-events: auto`）を、要るときに `document.documentElement` の最後に足し、何も出していないときは外す。
    - `tooltip(rect: DOMRect, text: string): void`、`hideTooltip(): void`（`原文：` + 原文。段落を 2px の枠で囲む）
    - `bubble(rect: DOMRect, state: { kind: 'loading' } | { kind: 'done'; text: string } | { kind: 'message'; text: string }): void`
      - 選択範囲の下に出す。画面の下に入らなければ上に出す。左右は画面の中に収める。
      - ボタン「コピー」（`navigator.clipboard` がなければ出さない。押すと「コピーしました」）と「閉じる」。
      - Esc、吹き出しの外のクリック、「閉じる」で消す。
    - `dispose(): void`
  - `startSession(doc: Document, api: SessionApi, options?: { timers?: Timers }): () => void`
    - `SessionApi`（テストは偽物を渡す）: `runtime.sendMessage`、`runtime.onMessage`、`runtime.onConnect`、`storage.local`（`get`、`onChanged`）
    - `page/command`:
      - `ping` → `{ ready: true }`
      - `translate` → スケジューラーを始める（2 回目は失敗を消して見直す）
      - `restore` → 区切って原文に戻し、スケジューラーを止める（`state: 'restoring'` → `'restored'`）
      - `selection` → 選択範囲（`getSelection()` の文。なければ `text`）を 2,000 文字まで、`text` だけの単位（400 文字まで）にして `page/translate`（`purpose: 'selection'`）で頼み、吹き出しに出す。ページのバッチとは別に、すぐ送る。
        - 選択がない → 「翻訳する文を選択してください」
        - 日本語（`needsPageTranslation` が false）→ 「選択した文は日本語です」
        - 失敗 → 「翻訳できませんでした」
        - 2,000 文字を超えた → 訳の後に「（先頭の 2,000 文字だけを訳しました）」
    - 起動時に、このページが `isAlways` で `isNever` でなければ、自分で `translate` と同じことをする。
    - `storage.onChanged` の `page`:
      - `mode` が変わった → `writer.setMode`
      - このサイトが `never` に入った → 原文に戻して止める
    - マウスを重ねる（`replace` のときだけ）:
      - `document` に `mouseover` と `mouseout`（`passive`）を 1 つずつ、`scroll`（`capture`、`passive`）を 1 つ。
      - `writer.segmentOf` で訳した段落なら、`hoverDelayMs` の後にツールチップ。外れる、スクロール、Esc で消す。
    - 進み具合: `runtime.onConnect` の `PROGRESS_PORT` に、つながっている間だけ `Progress` を送る（変わったときに、250 ms に 1 回まで）。
    - `pagehide`: `persisted` なら `writer.restore({ sliced: false })`。その後、すべて解放する。翻訳していたかどうかだけを覚える。
    - `pageshow`（`persisted`）: 翻訳していたなら、最初からやり直す。
  - `page.content.ts`: `main(ctx)` で `claimPage(globalThis)` が true のときだけ `startSession`。`ctx.onInvalidated` で原文に戻して解放する。

- [ ] **Step 1: 失敗するテストを書く**（jsdom、偽の `SessionApi`）

```ts
it('starts on an always site and not on an excluded one', async () => {
  /* always に https://wiki.fixture.test/* → スケジューラーが始まる。never にも入っていれば始まらない */
});
it('restores and stops on the restore command', async () => {
  /* fingerprint が翻訳前と同じ。progress の state は 'restored' */
});
it('switches the display when the stored mode changes', async () => {
  /* storage の page.mode を 'pair' に → <pt-ja> が出る */
});
it('restores the page synchronously on pagehide into the bfcache and frees everything', () => {
  /* pagehide(persisted) の同じタスクの中で fingerprint が元どおり。observer とタイマーが 0 */
});
it('starts again after the bfcache when it was translating', async () => {
  /* pageshow(persisted) → translate が呼ばれる */
});
it('shows the original on hover after 300 ms in replace mode only', async () => {
  /* 299 ms では出ない、300 ms で '原文：Click here to run().'。pair では出ない */
});
it.each([
  { name: '選択なし', selection: '', bubble: '翻訳する文を選択してください' },
  { name: '日本語', selection: '後ろに転がる', bubble: '選択した文は日本語です' },
  { name: '英語', selection: 'rolling backward', bubble: '訳:rolling backward' },
])('selection bubble: $name', async ({ selection, bubble }) => {
  /* ... */
});
it('closes the bubble on Escape and leaves no element behind', async () => {
  /* fingerprint が吹き出しを出す前と同じ */
});
it('sends progress only while the popup port is connected', async () => {
  /* connect → 送る。disconnect の後は 0 回 */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `translate` は、`pageProtocol.send` で `page/translate` を送る。abort されたら `page/cancel` を送る。
  - `page` は `document.title`（200 文字まで）と `location.hostname`。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(page-translator): page session with hover originals, selection bubble and progress"`

### Task 11: ポップアップと設定ページ

**Files:**

- Create: `packages/page-translator/src/popup.ts`、`src/entrypoints/popup/App.tsx`
- Create: `packages/page-translator/src/options.ts`、`src/entrypoints/options/App.tsx`
- Modify: `src/entrypoints/popup/main.tsx`、`src/entrypoints/options/main.tsx`
- Test: `test/unit/popup.test.tsx`、`test/unit/options.test.tsx`

**Interfaces:**

- Produces:
  - `popupPort(api?: PopupApi): PopupPort`
    - `activeTab(): Promise<Result<{ id: number; url: string | undefined }>>`（ツールバーのボタンで開いたので、`activeTab` でそのタブの URL が読める）
    - `start(tab)`、`restore(tab)`（background の `page/start`、`page/restore`）
    - `watch(tabId: number, onProgress: (progress: Progress | undefined) => void): () => void`（`tabs.connect(tabId, { name: PROGRESS_PORT, frameId: 0 })`。つながらなければ `undefined`）
    - `settings`: `pageSettingsStore`
    - `setAlways(site: Site, on: boolean): Promise<Result<void>>`
      - on: クリックの処理の中で、ほかの `await` より先に `permissions.request({ origins: [site.pattern] })` を呼ぶ。許されたら `always` に足し、`never` から消す。
      - off: `always` から消し、`permissions.remove`。ただし、その `pattern` が llama.cpp の接続先のホストのものなら外さない。
    - `setNever(site: Site, on: boolean): Promise<Result<void>>`: on なら `never` に足し、`always` から消す（権限も外す）。
    - `openOptions(): void`
  - ポップアップ（モック A）:
    - 見出し「ページ翻訳」
    - 「このページを翻訳」「原文に戻す」
    - 表示「置き換え／併記」
    - 「このサイトは常に翻訳」「このサイトでは翻訳しない」（スイッチ）
    - 状態の行（下の表）と「設定」へのリンク

    | 状態                                    | 文言                                                             |
    | --------------------------------------- | ---------------------------------------------------------------- |
    | 訳していない                            | （状態の行なし）                                                 |
    | 訳している（`found` > `done + failed`） | 「翻訳済み {done}/{found} 段落 · 画面外は後回し」                |
    | 訳し終えた                              | 「翻訳済み {done}/{found} 段落」                                 |
    | 失敗がある                              | 上の文の後に「 · {failed} 段落は原文のまま」                     |
    | `limit`                                 | 「段落が多いため、ここから先は翻訳しません」                     |
    | `notice: 'unreachable'`                 | 「llama.cpp に接続できません。設定を確認してください。」         |
    | `notice: 'plamo_missing'`               | 「PLaMo が見つからないため、Gemma で翻訳しています」             |
    | `page_restricted`                       | 「このページは翻訳できません」（ボタンはすべて無効）             |
    | `never` のサイト                        | 「このサイトは翻訳しない設定です」（「このページを翻訳」は無効） |

  - 設定ページ:
    - `ConnectionPanel`（今までと同じ）
    - 「翻訳モデル」: `Gemma`／`PLaMo 3 Translate 2B（任意。Built with PLaMo）`
    - 「Gemma のモデル名」（`settings.models.translate`）、「PLaMo のモデル名」（`plamoModel`）
    - 「翻訳しないサイト」: 1 行に 1 つのホスト名。保存で `normalizeHost`、だめな行は「ホスト名の形式が正しくありません: <行>」
    - 「常に翻訳するサイト」: 一覧と「外す」ボタン（`setAlways(site, false)`）
    - 遅れて読み込んだ設定は、触った欄を上書きしない（`edited`）。

- [ ] **Step 1: 失敗するテストを書く**（Testing Library、jsdom、偽の `PopupApi`）

```ts
it.each([
  {
    name: '訳している',
    progress: { found: 42, done: 12, failed: 0 },
    text: '翻訳済み 12/42 段落 · 画面外は後回し',
  },
  { name: '訳し終えた', progress: { found: 42, done: 42, failed: 0 }, text: '翻訳済み 42/42 段落' },
  {
    name: '接続できない',
    progress: { notice: 'unreachable' },
    text: 'llama.cpp に接続できません。設定を確認してください。',
  },
  {
    name: 'PLaMo がない',
    progress: { notice: 'plamo_missing' },
    text: 'PLaMo が見つからないため、Gemma で翻訳しています',
  },
])('popup shows $name', async ({ progress, text }) => {
  /* ... */
});
it('disables everything on a restricted page', async () => {
  /* chrome://settings のタブ */
});
it('asks for the site permission before anything else when always is turned on', async () => {
  /* permissions.request が最初の呼び出し。拒まれたら always に足さず、スイッチは OFF のまま */
});
it('turning never on removes always and disables translating', async () => {
  /* ... */
});
it('saves the display mode from the segmented control', async () => {
  /* 併記 → storage の page.mode は 'pair' */
});
it('keeps the never list the user is typing when settings load late', async () => {
  /* 入力の後に load が返る → 入力が残る */
});
it('rejects a malformed host with its line', async () => {
  /* 'https://bad host/' → 'ホスト名の形式が正しくありません: https://bad host/' */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(page-translator): popup controls and options page for models and site lists"`

### Task 12: E2E と負荷試験（soak）

**Files:**

- Create: `packages/page-translator/test/browser/fixtures/article.ts`（Task 5 の `article.html` に、ページ自身のスクリプトを足して配る）
  - ページのスクリプトは、テキストノードとリンクの参照を `window.fixtureRefs` に持つ。ボタンのクリックで `window.fixtureClicks` を増やす。
  - フォーム（`input`、`value` のない `option`、`textarea`、送信ボタン）は `https://wiki.fixture.test/submit` に POST する。
- Create: `test/browser/fixtures/long.ts`（高さ 100px 固定の段落を 300 個。番号付きの自作の文）
- Create: `test/browser/fixtures/feed.ts`（1 秒に 5 段落を下に足し、上の 200 個を超えた分を消す）
- Create: `test/browser/layout.spec.ts`、`restore.spec.ts`、`scroll.spec.ts`、`front.spec.ts`、`overlay.spec.ts`、`popup.spec.ts`、`perf.spec.ts`、`soak.spec.ts`
- Modify: `packages/page-translator/package.json`（`starter.soak: true`）
- Modify: `packages/comment-assistant/test/unit/soak-marker.test.ts`（印のあるパッケージの一覧に page-translator を足す）

**Interfaces:**

- Consumes: `servePage`、`startTranslation`、`tabIdOf`、`fingerprint`（Task 1）
- テストの中で進み具合を読むには、service worker の `evaluate` で `tabs.connect(tabId, { name: 'page-progress' })` を開く（本番のコードにテスト用の入口を作らない）。
- すべて `test.use({ realVisibility: true })`。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// layout.spec.ts
test('translation keeps layout, links and forms working', async () => {
  // article を訳し、進み具合が近くの段落をすべて終えるまで待つ
  // - 訳したブロックの幅が翻訳前と同じ。document.scrollingElement の scrollWidth ≤ clientWidth
  // - リンクの href は同じ。訳したリンクをクリックすると、その href に移る
  // - フォームの送信の本文が翻訳前と同じ（input の値、option の文、textarea の文）
  // - ページのボタンのクリックで fixtureClicks が 1 増える。fixtureRefs のノードは isConnected
  // - 訳さないもの（code、pre、kbd、samp、svg、translate=no、notranslate、material-icons、contenteditable、日本語の段落）の textContent が同じ
  // - llama の要求は、すべて model 'gemma4-e4b'、id_slot はスタブの total_slots 2 なら 1
});
// restore.spec.ts
test.each(['replace', 'pair'])('restoring gives back the identical DOM after %s', async (mode) => {
  /* fingerprint(翻訳前) === fingerprint(原文に戻した後)。fixtureRefs は同じノードで、data は原文 */
});
test('switching modes back and forth still restores the identical DOM', async () => {
  /* ... */
});
test('a text the page rewrote after translation keeps the page value on restore', async () => {
  /* Review Focus。ページのスクリプトが訳したノードを '4 comments' に → 戻した後も '4 comments' */
});
// scroll.spec.ts
test('a long page sends no off-screen burst', async () => {
  // long を開き、スタブは 300 ms 遅らせて答え、同時の要求数を記録する
  // - 先頭で訳した直後: 頼んだ段落はすべて 1〜16 番。1 つのバッチは 6 段落まで。同時の要求は常に 1
  // - 150 番へ飛ぶ: 新しく頼んだのは 135〜166 番だけ。17〜134 番は一度も頼まない
  // - 最後まで少しずつスクロールした後: 300 段落それぞれ、ちょうど 1 回だけ頼んだ
});
// front.spec.ts
test('a background tab asks nothing and resumes in front', async () => {
  /* 翻訳を始めてすぐ別のタブを前に → 5 秒間 llama.requests のチャットが増えない。戻すと続きを頼む */
});
// 「常に翻訳」のサイトを裏のタブで開いたときは、E2E でホスト権限を与えられない（Step 0 の C を除く）ので、
// Task 7 の 'waits until visible before scanning a page opened in a background tab' で確かめる。
// overlay.spec.ts
test('hovering a translated paragraph shows its original', async () => {
  /* page.hover → pt-overlay の Shadow DOM に '原文：…'。外すと消える */
});
test('the selection bubble shows a translation near the selection and leaves nothing behind', async () => {
  /* 選択 → service worker から { action: 'selection' } → 吹き出しが選択範囲の rect の下にあり '訳:…'。Esc → fingerprint が元どおり */
});
// popup.spec.ts（Step 0 の A なら triggerAction で開いたポップアップ、B と C なら popup.html をタブで開いて描画だけ）
test('the popup translates, restores and shows progress', async () => {
  /* 「このページを翻訳」→ '翻訳済み n/m 段落 · 画面外は後回し'、「原文に戻す」→ fingerprint が元どおり */
});
// perf.spec.ts
test('a 5,000-paragraph page translates, scrolls and restores without a long task', async () => {
  /* longTasks の 50 ms 超が 0、usedHeap < 30 MB */
});
// soak.spec.ts
test('SOAK_MINUTES on a growing feed keeps heap and long tasks within budget', async () => {
  // feed を開いて訳し、1 秒ごとに一番下までスクロールする（既定 2 分、手動で 120 分）
  // 期待値:
  //   - 開始 60 秒の後と終了時の heapSnapshotParts の data が 1.10 倍以下、usedHeap が 2 倍未満、どの時点も 30 MB 未満
  //   - 50 ms を超える長いタスクが 0
  //   - 進み具合の tracked ≤ 10,000、cached ≤ 2,000
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test:e2e`
  - Expected: FAIL
- [ ] **Step 3: 足りない配線を直す**
  - テストを通すために本体のコードを直す場合は、該当する Task の単体テストにも同じケースを足す。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/page-translator test:e2e && pnpm --filter @chrome-toolbox/comment-assistant test && pnpm check`
  - Expected: PASS（soak は 2 分版。soak を除いた E2E は、`tools/quality/soak.ts` の 3 分の枠に収まる）
- [ ] **Step 5: Commit**
  - `git commit -m "test(page-translator): layout, exact restore, viewport-only requests, front-only and soak budgets"`

### Task 13: 文書、実機での確認、品質ゲート

ここでの計測は、静かなホスト（5 分平均の負荷が 4 未満）で、コントローラーが行う。

**Files:**

- Modify: `packages/page-translator/README.md`（状態、使い方、権限の説明、範囲外のもの、テスト）
- Modify: `README.md`（拡張の一覧の状態）
- Modify: `docs/llama-server.md`（§6 の表に、ページ翻訳の `models.translate` と `plamoModel`、設定ページの場所。PLaMo の節の「The extensions do not send requests to PLaMo yet」を直す）
- Modify: `.agents/skills/extension/SKILL.md`（`bench:page` と、ページ翻訳の枠）
- Modify: `docs/adoption.md`（Step 2 の数字）

- [ ] **Step 1: 準備**
  - 拡張をビルドし、headed の Chromium にログインせずに読み込む。サーバーは `docs/llama-server.md` のとおり（`--parallel 3`）。
- [ ] **Step 2: 測る**
  - 最初の画面: `long.ts` と同じ形の自作の長いページを、ローカルで配る（実在のページの文は使わない）。「このページを翻訳」から、最初の段落が訳されるまでと、最初の画面がすべて訳されるまでの時間を、翻訳モデルごとに 5 回ずつ。p50 と最大。
  - 負荷: llama-server の CPU と RSS、Chromium の CPU、ページのヒープ（開始時と終了時）。
  - 字幕との同時: `bench:slots -- --model gemma4-e4b --comment-streams 1` を流しながら、長いページを訳して最後までスクロールする。字幕の p50 と p95 を、ページ翻訳なしのときと比べる。
  - レイアウト: 公開の英語のページを 5 種類（Wiki、ブログ、技術文書、ニュース、掲示板）訳し、崩れ、リンク、フォーム、原文に戻した後を目で確かめる。記録は種類ごとの可否と気づいた点だけ。URL、本文、訳は書かない。
- [ ] **Step 3: 文書を直す**
  - `docs/adoption.md`: Step 2 の数字と、Task 4 の決定が実際の使い方で保てたか。
  - README: 状態を「使える」にする。権限（インストール時はサイトへのアクセスなし、常に翻訳のサイトだけ）、範囲外（iframe、閉じた Shadow DOM、属性）、PLaMo のライセンスの注意（`docs/llama-server.md` へのリンク）を書く。
- [ ] **Step 4: 長時間版の負荷試験（コントローラー）**
  - Run: `SOAK_MINUTES=120 pnpm --filter @chrome-toolbox/page-translator test:e2e -- soak`
  - Expected: PASS。結果を `docs/adoption.md` に記録する。
- [ ] **Step 5: 品質ゲートを通す**
  - Run: `pnpm gate:pre-pr -- --base <分岐元 SHA>`
  - Expected: page-translator、extension-core、comment-assistant、bench、tools の項目がすべて pass する。
- [ ] **Step 6: Commit**
  - `git commit -m "docs(page-translator): usage, permissions and live measurements"`
