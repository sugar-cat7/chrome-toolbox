# ① subtitle-translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**改訂（2026-11-05）:** 2026-10-28 版は着手しないまま、その後の判断（R8・R10・R11・R21・R39・R44・R47・R61、MTP の採用）と、ユーザーの要件（2026-11-05「言語とわず日本語で字幕を表示できるようにする（切り替え可能）」）に合わせて書き直した。whisper.cpp と ASR エンジンの選択、ポップアップ、上の段の英語訳はなくなった。旧版との違いは SDD のワークスペースの改訂報告にまとめてある。

**改訂（2026-11-06）:** 着手前の確認（pre-flight）で、Task 8（PLaMo 3 Translate 2B を字幕の翻訳に選べるようにする。任意）を足し、旧 Task 8〜15 を Task 9〜16 に繰り下げた。あわせて、今のコード（comment-assistant の G1・G2 の後）と食い違う型や手順を直した。判断の記録（Ruling S1〜）は SDD のワークスペースの ledger にある。

**改訂（2026-11-06、③ page-translator との調整）:** ③ page-translator の計画（ブランチ `feat/page-translator`）も、extension-core に同じもの（止める文字列、モデルがないときのエラー、PLaMo の要求の組み立て、スタブ）を別の名前で足そうとしていた。共有する部分を 1 つの形にそろえ、Task 8 から新しい **Task 0** に分けた。Task 0 は Task 1 より前に行い、Task 1〜7 には依らない。③ のブランチは Task 0 が入った後にこのブランチの上に積み、③ の PR はこの計画の PR の上に積む。Task 1〜16 の番号は変えていない。Task 8 には字幕の側の使い方（1 行の翻訳、Gemma への切り替え、キャッシュのキー、文書）だけが残る。判断は Ruling S24〜。

**改訂（2026-11-06、Task 4 の計測の後）:** Task 4 の計測で、投影器は BF16 に決まった。MTP を有効にした枠 0 は、コメント 2 本の負荷の下で字幕の目標を外れ、1 本なら収まった。ユーザーの決定（「字幕中はコメントが譲る」）に合わせて **Task 17**（comment-assistant が、字幕が枠 0 を使っている間はバッチを 1 本ずつにする）を足した。Task 4 の後なら、いつ行ってもよい。あわせて、決まった値を Global Constraints に書き、1,500 ms で機械的に切った音声で ASR が失敗した結果を Task 11（VAD の強制の区切り）と Task 12 に反映した。判断は Ruling S37〜。

**Goal:** YouTube の動画と配信で、話されている言語にかかわらず、日本語の字幕を映像の上に出す。表示は「日本語のみ／原語と日本語／原語のみ／オフ」の 4 つで、プレイヤーの上のボタン、ショートカット、サイドパネルからすぐ切り替えられる。字幕トラックのあるアーカイブは、そのトラックを先読みして訳す。ないとき（ライブを含む）は、タブの音声を llama.cpp の音声入力で文字起こしし、音声の終わりから p50 2 秒以内に日本語を出す。訳すモデルは Gemma（既定）で、サイドパネルで PLaMo 3 Translate 2B も選べる。

**Architecture:**

- **content script**（`www.youtube.com` のトップフレーム）:
  - 映像の上の字幕（Shadow DOM）と、表示を切り替えるボタンを描く。
  - 再生位置に合わせて字幕を出す。
  - 前面にあるかを判定する（R44）。
  - 字幕トラックの文を持ち、先読みを進める。
  - 推論はしない。
- **MAIN world のスクリプト**: プレイヤーの player response と、プレイヤー自身が取得した timedtext の応答を読むだけ。
- **background**（service worker）:
  - 設定と用語集、送り手の確認、ショートカット。
  - 字幕トラックの文の翻訳。状態は持たず、訳のキャッシュだけを持つ。
  - 音声の取得の開始と停止。offscreen と content script の中継。
- **offscreen document**:
  - タブ音声の取得。AudioWorklet での 16 kHz 化と VAD。
  - ライブの処理（ASR → 言語 → 文 → 翻訳）と遅延の統計。
  - 音声を取得している間だけ存在する。
  - ライブの処理を background ではなく offscreen に置く（判断）。MV3 の service worker は、イベントのない状態が 30 秒続くと止まり、文の途中の状態と統計を失う。offscreen は取得の間ずっと動いている。offscreen から使える拡張 API は `chrome.runtime` だけなので、設定と用語集は background が渡す。
- **llama.cpp**:
  - ルーターモードの 1 台（`http://127.0.0.1:18083`、R21）。
  - 字幕は ASR も翻訳も枠 0（`id_slot: 0`）を使う。
  - リクエストには必ず `model` を付ける（R11）。
  - PLaMo 3 Translate 2B（任意）は Gemma とは別のモデルで、ルーターの別の子プロセスとして自分の枠を持つ。選んだときの訳は、PLaMo の枠 0 に送る。

**Tech Stack:** WXT 0.21.5, React 19, Tailwind 4, Web Audio（AudioWorklet）, `chrome.tabCapture` + `chrome.offscreen` + `chrome.commands`, Zod mini, Vitest 5 + WXT fake browser, Testing Library, Playwright 1.64（Chrome for Testing）

**Spec:** `docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md`（§4, §5, §6, §9, §11, §15。§6 は 2026-11-06 にこの計画に合わせて改訂した）、`docs/llama-server.md`、`docs/adoption.md`。前提:

- Phase 0.5 は完了。ASR は gemma4-e4b の `input_audio`（R8・R10）。2026-10-28 のベンチで、合成音声の en/id/ko/es/zh の言語をすべて正しく判別した。
- comment-assistant 計画は Task 9 まで完了。次のものを使う。
  - extension-core: `createLlamaClient`、`createQueue`、`createLruCache`、`Timers`、`defineProtocol`、`settingsStore`（`models.asr`）、`connectionPort`
  - packages/ui: `ConnectionPanel`
  - extension-core の testing: llama のスタブ、`realVisibility`、`heapSnapshotParts`、`usedHeap`、`longTasks`、`platform`
- comment-assistant の Task G1・G2 は完了した（2026-11-05）。この計画はその後のコードに合わせてある。
  - ジャンルとカテゴリの定義は `packages/extension-core/src/stream-categories.ts` に分かれた。`prompts.ts` には `commentBatchPrompt`（`genre`、`categories` を受け取る）、`genrePrompt`、`parseGenre` が足された。
  - llama のスタブは、コメントのバッチ、要約、ジャンルの推定（`STUB_GENRE`）に、システム文で見分けて答える。字幕の分岐はこの並びに足す。
- ベンチは `packages/bench`（`@chrome-toolbox/bench`）にある。`pnpm --filter @chrome-toolbox/bench bench:*` で動かす。
- 写して使う、comment-assistant の作り方（アプリどうしは import しない）:
  - `stream-context.ts` の配信の文脈と `contextHash`
  - `runtime.ts` の送り手の確認（`fromExtensionPage`、`sender_forbidden`）
  - `sites/observe.ts` の前面の判定（`visibilityState`、`IntersectionObserver`、`pagehide`）
  - サイドパネルの port と、遅れて読み込んだ設定で入力を上書きしない作り（`edited`）

## Global Constraints

- 画面:
  - 映像の上に 2 段で出す（モック A）。上の段は原語で小さく、下の段は日本語で大きく。
  - 表示のモードは 4 つ:
    - `ja`: 日本語のみ
    - `both`: 原語と日本語（既定）
    - `source`: 原語のみ
    - `off`: オフ
  - 切り替えられる場所は 3 つ。どこで切り替えても、すべてのタブにすぐ反映する。
    - プレイヤーの右上の小さなボタン。押すたびに 日本語 → 併記 → 原語 → オフ → 日本語 と進む。
    - ショートカット `Alt+Shift+J`
    - サイドパネル
  - 日本語の音声と日本語の字幕トラックは訳さず、そのまま日本語の段に出す。`both` でも 1 段にする。
  - `source` のときは翻訳を呼ばない。`off` のときは何も処理しない。
- 字幕の取得元は `auto`（既定）、`captions`、`audio` の 3 つ。
  - `auto`: アーカイブに字幕トラックがあれば、それを使う。なければ（ライブを含む）、プレイヤーのボタンに「字幕なし・Alt+Shift+S で音声字幕」と出す。このとき推論は何もしない。
  - ライブ配信では、字幕トラックの経路を使わない。
- 音声認識:
  - llama.cpp の `/v1/chat/completions` に `input_audio` で送る。モデルは設定の `models.asr`（既定は `gemma4-e4b`）。
  - whisper.cpp と、ASR エンジンの選択はない（R10）。
  - すべてのリクエストに `model` を付ける（ルーター、R11）。
  - 出力は GBNF で 1 行の `<lang>\t<text>\n` に縛る。
    - `<lang>` は ISO 639-1 の 2 文字。話されている言語を固定したときは、その 2 文字だけを許す。
    - `<text>` は、音声 1 秒あたり 40 文字に 16 文字を足した長さまで（上限 400 文字）。
    - `max_tokens` は 8 + 3 × その文字数。
  - 言語の判別は、この出力の `<lang>` から得る。確からしさの値は使わない。
- 投影器（mmproj。音声と画像の入力に使う）:
  - 音声認識には Gemma の投影器が要る。R61 で既定のプリセットから外してある。
  - 字幕を使う人は、`models.ini` の `[gemma4-e4b]` で `mmproj = …` の行を有効にし、サーバーを再起動する（`docs/llama-server.md` §3）。勧めるのは BF16（Task 4 で決めた）。
  - メモリ:
    - BF16（Google の QAT リポジトリの `gemma-4-E4B-it-mmproj.gguf`）は、945 MiB がプロセスのメモリに読み込まれる。音声認識を使った後の Gemma のプロセスの footprint は 1.65〜1.78 GB で、投影器なし（0.43 GB）より約 1.2〜1.4 GB 多い（2026-11-02 と 2026-11-06 の実測）。
    - Q8_0（ggml-org の `mmproj-gemma-4-E4B-it-Q8_0.gguf`、559,874,816 バイト）は、どの言語でも精度が BF16 と同じで、footprint は 0.4〜0.5 GB 少なかった。ただし p50 が BF16 の 1.04〜1.17 倍で、Task 4 の決め方（1.05 倍以内）を満たさなかったので勧めない。
  - 投影器のないサーバーの応答（llama.cpp `620d222` のソースで確認）:
    - `GET /props?model=<name>` の `modalities.audio` が `false` になる。
    - 音声つきのリクエストには HTTP 400 を返す。本文は `"audio input is not supported - hint: if this is unexpected, you may need to provide the mmproj"`。
    - 拡張はこれを `audio_unsupported` とし、取得を始めずにサイドパネルで案内する。
- 推論の枠と遅延:
  - 字幕は ASR も翻訳も枠 0 を使う。コメントは枠 1 と 2 を使う（R39、`--parallel 3`）。
  - ASR と翻訳は、同じシステム文と、同じ配信ごとの前置き（配信の文脈と用語集）を使う（判断）。枠 0 に交互に流れても、プロンプトキャッシュの先頭を共有できるようにするため。
    - これは Gemma で訳すときの話。PLaMo で訳すときは別の形式（Task 0 で組み立て、Task 8 で使う）で、PLaMo の枠 0 に送るので、Gemma の枠 0 は ASR だけになる。
    - PLaMo の枠 1 と 2 は、③ page-translator が使う。字幕は PLaMo の枠 0 だけを使う。
  - 遅延の目標（基準機、§9。①と②を同時に動かした状態）:
    - 音声の終わりから原語の表示まで p50 ≤ 1.0 s
    - 音声の終わりから日本語の表示まで p50 ≤ 2.0 s、p95 ≤ 3.0 s
    - 字幕トラックの経路の表示のずれ ≤ 200 ms
  - MTP（`spec-type = draft-mtp`）について:
    - サーバー全体の設定で、リクエストごとには切れない。`620d222` の `server-schema.cpp` では、speculative のリクエスト引数が `#if 0` で無効になっている。
    - 字幕の翻訳だけを測った p95 は、コメントの負荷の下で 1.25 s から 1.8 s に上がった。
    - ASR を含めた値（Task 4、2026-11-06、合成音声）: コメント 2 本の負荷の下では、日本語の p95 が MTP ありで 3.78〜4.70 s、なしで 3.38〜3.46 s で、どちらも目標を外れた。1 本なら、MTP ありで 1.86〜2.30 s に収まった。
    - ユーザーの決定（2026-11-06「字幕中はコメントが譲る」）: MTP は残す。字幕が枠 0 を使っている間、comment-assistant はバッチを 2 本ではなく 1 本ずつにする（Task 17）。
      - 拡張どうしはメッセージを送り合わない。comment-assistant が llama-server の `GET /slots?model=<name>` で枠 0 の `is_processing` を見る。
  - ASR に送る区切りは、無音で閉じる。長い発話を切るときも、決まった長さではなく、いちばん静かなところで切る（Task 11）。
    - Task 4 で 1,500 ms ごとに機械的に切った音声では、ko-3、zh-1、zh-3 が毎回 `response_invalid` になった。音節の途中で切れた音声で、モデルが同じ語を繰り返し、文字起こしが `asrTextLimit` に達したため。丸ごとの音声では一度も失敗しなかった。
  - 追いつかない分は捨て、待ちを溜めない。
    - ASR の待ちは 2 件まで。超えたら古いものを捨てる。
    - 翻訳の待ちは 2 文まで。同じ文の待ちは、新しい版に置き換える。
    - 区切りの終わりから 1.5 s 以内に始められない ASR は捨てる。2.5 s 以内に始められない翻訳も捨て、その文は原語のままにする。
    - 次に流す仕事は、区切りの終わりがいちばん古いもの。同じなら翻訳を先にする。
- 前面にあるときだけ処理する（R44）:
  - 処理するのは、次をすべて満たすときだけ。
    - タブが見えている（`visibilityState`）。
    - プレイヤーが画面に出ている。
    - 動画が再生中。
    - 広告中でない。
    - ミュートでない。
    - 表示がオフでない。
  - 一時停止とミュート（pause）:
    - 新しい音声は読まない。
    - 区切りかけの発話は区切って処理する。
    - 待ちの仕事は、そのまま終える。
  - 裏のタブ、プレイヤーが画面外、広告、表示オフ（away）:
    - 新しい音声は読まない。
    - 区切りかけの発話と待ちの仕事は捨てる。
    - 実行中のリクエストは中断する。
  - 字幕トラックの先読みも、前面で再生しているときだけ進める。
  - タブ音声の取得そのもの（MediaStream）は、away と pause の間も保ち、active に戻れば自動で処理を再開する（ユーザーの決定、2026-11-05）。
    - 理由: `tabCapture` を始めるには、ユーザーの操作が要る。
    - その間、AudioWorklet は切り離すので、処理はしない。
    - 処理しない状態が 10 分続いたら、取得をやめる。
    - Task 13 の確認で、操作なしに取り直せると分かっても、この方式は変えない（結果は記録だけする）。
- 音声の取得:
  - 開始にはユーザーの操作が要る。ショートカット `Alt+Shift+S` と、サイドパネルの「音声で字幕を開始」から始める。どの操作で `tabCapture.getMediaStreamId` が通るかは、Task 13 で確かめる。
  - 同時に取得するのは 1 タブだけ。別のタブで開始したら、前のタブを止める。
  - 取得した音声は `AudioContext.destination` に戻し、タブの音を消さない。
  - AudioContext は端末の標本化周波数のままにする。16 kHz にすると、視聴者が聞く音が劣化するため。16 kHz mono への変換は AudioWorklet で行う。
  - 取得を止める条件は次のとおり。YouTube 内の SPA の遷移では止めず、言語、文脈、用語集を新しい動画に切り替える。
    - タブを閉じた
    - ユーザーが止めた
    - `www.youtube.com` から離れた
    - 処理しない状態が 10 分続いた
    - 別のタブで開始した
- リソース:
  - JS ヒープは、content script も offscreen も 30 MB 以内。
  - 負荷試験（soak、R47）では、content script（視聴ページ）と offscreen のそれぞれについて次を満たす。
    - ヒープのスナップショットのデータ部分（コンパイル済みのコードとネイティブを除く）が、開始時の 1.10 倍以内。
    - ヒープ全体が、開始時の 2 倍未満。
  - 50 ms を超える長いタスクを、視聴ページでも offscreen でも出さない。ポーリングはしない。
  - すべて上限付きにする。
    - VAD のバッファは固定長（最長の区切り 1,500 ms と、前置き 100 ms の分）。
    - ASR の待ちは 2 件、翻訳の待ちは 2 文。
    - 文脈は直前の 3 文。遅延の記録は直近 200 件。
    - 字幕トラックの cue は 1 本につき 20,000 個まで。訳は、再生位置の前後 10 分の分だけ持つ。
    - background の訳のキャッシュは LRU 2,000 件。タブの情報は 16 タブ分。
    - 用語集は、配信者ごとに 50 件、配信者は 100 人まで。
  - 音声は、ディスクにもストレージにも書かない。
    - PCM は、上限付きのバッファにだけ置く。
    - 文字起こしの履歴も残さない。持つのは、表示中の行と直前の 3 文だけ。
- プラットフォームへの追加のリクエストは 0 件。字幕トラックは、プレイヤー自身が取得する 1 回だけを読む（方式は Task 6 で確かめる）。
- `src/` の規約:
  - throw、catch、`console` は使わない。
  - async 関数は `Promise<Result<…>>` を返すか、名前付きの listener を `launch` に渡す。
  - 新しいエラーコードは `tools/errors/catalog.json` に定義してから `pnpm errors:generate` を実行する。
- 拡張のコンテキストどうしのメッセージには、宛先（`target: 'background' | 'offscreen' | 'panel' | 'content'`）を付ける。受け手は、検証の前に宛先だけを見て、自分宛てでないものを捨てる（comment-assistant の Task P で、サイドパネルがすべてのメッセージを検証していた問題の対策）。`content` は、background が視聴ページのトップフレームに送る `subs/lines` と `subs/status` の宛先。
- 字幕の翻訳モデル（ユーザーの決定、2026-11-06）:
  - 既定は Gemma（`models.translate`、既定 `gemma4-e4b`）。サイドパネルで PLaMo 3 Translate 2B（`plamo-3-translate-2b`）を選べる（任意）。設定は `subtitles` の `translator: 'gemma' | 'plamo'`（既定 `gemma`）。
  - PLaMo へのリクエスト（`/v1/chat/completions`）は、extension-core の `plamoTranslateRequest`（Task 0）で組み立て、Task 8 で使う。③ page-translator も同じ関数を使う。
    - user メッセージは 1 つだけで、空でない原文 1 行を入れる。
    - `chat_template_kwargs` に `target_lang: "ja"`、`source_lang`（小文字。分からないときは付けない）、`context`（直前の原文。上限付き）、`glossary`（`[{ source, target }]`。視聴者の用語集から）を入れる。
    - `temperature: 0`、`max_tokens` は上限付き（字幕は 256 まで）、`stop: ["<|plamo:tag|>", "<|plamo:bos|>"]`、`cache_prompt: true`。
    - 枠（`id_slot`）は呼ぶ側が渡す。字幕は `0`。
    - `response_format`、`json_schema`、`grammar`、system メッセージは決して送らない。
    - 送る前に、空の行と `<|plamo:` を含む行を断る。言語コードは PLaMo の小文字の形（`zh-hans`、`zh-hant` を含む）にする。`zh-CN` は HTTP 400 になる。
    - HTTP 4xx/5xx は `model_refused`（公開コード `unavailable`）で返る。PLaMo の要求だけが `tellRefusal` でこれを求める。ほかの要求は今までどおり `network_failed`。
  - ルーターが PLaMo を載せていない（`/v1/models` にない）とき、または PLaMo へのリクエストが HTTP 4xx/5xx（`model_refused`）になったときは、その行を Gemma で訳す。サイドパネルに Gemma に切り替えたことを出す。
  - PLaMo を選んでいる間、サイドパネルに「Built with PLaMo」と PLaMo Community License へのリンクを出す。
- UI の文言は日本語。例外は「Built with PLaMo」で、ライセンスが求める英語の表記をそのまま出す。
- 公開リポジトリ:
  - 実配信の音声、文字起こし、配信者名はコミットしない（gitignore 済みの `bench-data/` に置く）。
  - fixture は、自作の文と合成音だけにする。テストの配信者名や用語も自作にする（`Fixturo`、`Fixture Ch` など）。
  - PLaMo の出力（実サーバーの訳）は、テスト、fixture、文書の例に入れない（PLaMo Community License）。スタブとテストの訳は自作の文字列にする。

## Review Focus

- 字幕トラックのない動画で、まだ音声を始めていない → ボタンに「字幕なし・Alt+Shift+S で音声字幕」と出す。推論は 0 件（Task 9・Task 15 でテスト）。
- 投影器のないサーバー → 開始を断り、サイドパネルに「音声入力が使えません」と mmproj の案内を出す。stream id は取らず、offscreen は作らない（Task 1・Task 13・Task 14・Task 15 でテスト）。
- PLaMo を選んだのに、ルーターに PLaMo がない、または PLaMo が HTTP のエラーを返した → その行は Gemma の訳で出る。サイドパネルに Gemma に切り替えたことが出る。接続できないときは Gemma にも送らず、原語のまま（Task 0・Task 8・Task 14・Task 15 でテスト）。
- 裏のタブ、広告、プレイヤーが画面外 → サーバーへのリクエストは 0 件で、待ちは捨てる。前面に戻れば再開する（Task 10・Task 12・Task 13・Task 15 でテスト）。
- 一時停止 → 止める直前の発話も字幕になる（Task 12・Task 13 でテスト）。
- 早口が続いて枠 0 が追いつかない → 待ちは増えない。捨てた数と期限切れの数を数え、p95 が伸び続けない（Task 12 でテスト）。
- 日本語の音声 → 翻訳を呼ばない（Task 12 でテスト）。
- アーカイブでシークや早送りをした → 先読みを新しい位置から組み直す（Task 7 でテスト）。
- 無音や BGM だけの長い区間 → 区切りを出さず、ASR を呼ばず、バッファも伸びない（Task 11 でテスト）。
- 1.5 秒を超えて話し続ける → 強制の区切りは、最後の 500 ms のうちいちばん静かなフレームで切り、切った後ろの音は次の区切りに入る。音声は失われない（Task 11 でテスト）。
- 字幕が枠 0 を使っている → comment-assistant は、コメントの枠に同時に 1 本しか送らない。枠 0 を処理中と最後に見てから 15 秒たてば、2 本に戻る。`/slots` が答えないサーバーでは、今までどおり 2 本（Task 17 でテスト）。
- 取得中にタブを閉じた、サイトを離れた、別のタブで始めた → MediaStream の track、AudioContext、offscreen をすべて解放する（Task 13・Task 15 でテスト）。
- 取得中に service worker が止まって再び起動した → 取得とライブの処理は続き、止める条件も効く（Task 13 でテスト）。
- 長時間の視聴 → ヒープのデータ部分が 1.10 倍以内（Task 15 でテスト）。

---

### Task 0: PLaMo の要求、止める文字列、拒否のエラー（extension-core。③ と共有）

最初に行う（Task 1 より前）。Task 1〜16 のどれにも依らない。使うのは今のコードの `createLlamaClient`、`cutByMaxTokens`、`ChatReply`、`ChatRequest`、`GlossaryEntry` と、`prompts.ts` の `translationLimit` だけ。③ page-translator の計画も、この Task の型と関数をそのまま使う。③ のブランチは、この Task が入った `feat/subtitle-translator` の上に積む（判断 S24）。字幕の側の使い方は Task 8 で足す。

背景（2026-11-06 の評価。`docs/llama-server.md` の「PLaMo 3 Translate」。llama.cpp `620d222` のルーターで確かめた）:

- PLaMo 3 Translate 2B は、ルーターで Gemma とは別の子プロセスとして動き、自分の枠を持つ。プリセットの節は `[plamo-3-translate-2b]`（`no-prefill-assistant = true`）。字幕は PLaMo の枠 0 を、③ のページ翻訳は枠 1 と 2 を使う。そこで、枠は呼ぶ側が渡す（判断 S26）。
- 固定したリビジョンの GGUF に埋め込まれたチャットテンプレートが、`chat_template_kwargs` を PLaMo の形式に組み立てる。テンプレートは次を HTTP 400 にする。
  - 空の原文（ASCII の空白だけも）
  - `<|plamo:` を含む原文、文脈、用語集
  - 小文字でない言語コードや、地域の付いた言語コード（`zh-CN`）
- `response_format`、JSON Schema、`grammar` を付けると出力が壊れる。system メッセージは文脈として読まれる。止める文字列はサーバー側で設定できないので、クライアントが送る。
- 対応する言語は 53（モデルカードの「Supported Languages」）。ポルトガル語（`pt`）は含まれない。
- PLaMo Community License: リポジトリには PLaMo の出力を入れない（Global Constraints）。テスト、スタブ、README の例は自作の文字列にする。
- 今の `createLlamaClient` は、HTTP 4xx/5xx の応答も、接続できないときも、時間切れも `network_failed` にする。comment-assistant はこの値で「llama.cpp に接続できません」を出しているので、既定の扱いは変えず、求めたリクエストだけ HTTP のエラーを見分ける（判断 S12）。
  - ルーターは、プリセットにないモデルに 400 `model '<name>' not found` を返す。これも、ほかの 4xx/5xx と同じエラーにする。モデルが「ない」ことは、呼ぶ側が `/v1/models` の一覧で確かめる（字幕は Task 8、③ は ③ の Task 7。判断 S25）。

**Files:**

- Create: `packages/extension-core/src/plamo.ts`、`src/plamo.test.ts`
- Modify: `packages/extension-core/src/llm.ts`、`src/llm.test.ts`（`stop`、`tellRefusal`）
- Modify: `packages/extension-core/src/prompts.ts`（`translationLimit` に `export` を付けるだけ。式は変えない。`index.ts` からは export しない）
- Modify: `packages/extension-core/src/index.ts`（`plamo.ts` の export を 1 つのまとまりにして、`./prompts.ts` のまとまりのすぐ後に置く）
- Modify: `packages/extension-core/README.md`（`src/plamo.ts` の行を足す。`src/llm.ts` の行に `stop` と `tellRefusal`、`testing/llama-stub.ts` の行に `withPlamo` を書く）
- Modify: `tools/errors/catalog.json`（`internal` の末尾に `model_refused` → 公開コード `unavailable`）。続けて `pnpm errors:generate` を実行する。`packages/contracts/src/errors.generated.ts`、`docs/errors.generated.md`、`.template.json` が変わる。
- Modify: `packages/extension-core/testing/llama-stub.ts`、`testing/llama-stub.test.ts`、`testing/playwright.ts`（export）

**Interfaces:**

- Produces（`llm.ts`）。`ChatRequest` に 2 つ足す。
  - `stop?: readonly string[]`: 本文の `stop`。ないときは、本文に `stop` のキーを入れない。
  - `tellRefusal?: boolean`: `true` のとき、HTTP 4xx/5xx の応答を `network_failed` ではなく `model_refused` にする。
    - 2xx 以外の判定は、今の `request` の 1 か所（`if (!response.value.ok) return Err(failure('network_failed'))`）に置いたままにする。`chat` だけが `tellRefusal` を渡す。`health`、`models`、`props` は今までどおり。
    - 応答の本文は読まない。ルーターの 400 `model '<name>' not found`、ほかの 400、404、503 は、どれも `model_refused`。
    - 接続できない、時間切れは今までどおり `network_failed`。中断は今までどおり、HTTP の状態より先に見て `operation_cancelled`。
    - 省いたときの扱いは変えない。
    - Task 1 は、この分岐に `audio_unsupported`（音声入力のない 400）の判定を、`tellRefusal` より先に足す。
- Produces（`plamo.ts`。`index.ts` から export する）:
  - `PLAMO_TRANSLATE_MODEL = 'plamo-3-translate-2b'`（プリセットの節の名前。設定では変えない。判断 S13）
  - `PLAMO_STOP = ['<|plamo:tag|>', '<|plamo:bos|>'] as const`
  - `PLAMO_LICENSE_URL = 'https://plamo.preferredai.jp/info/plamo-community-license-ja'`
  - `PLAMO_LIMITS = { contextLines: 3, contextLineChars: 200, maxTokens: 256 } as const`
  - `PLAMO_LANGUAGES`: モデルカードの 53 の言語コード。`ja`、`en`、`zh-hans`、`zh-hant`、`ko`、`ar`、`az`、`be`、`bg`、`bn`、`ca`、`ceb`、`de`、`es`、`et`、`eu`、`fa`、`fr`、`gu`、`he`、`hi`、`hr`、`hu`、`hy`、`id`、`it`、`jv`、`ka`、`kk`、`km`、`lt`、`lv`、`ml`、`mr`、`ms`、`my`、`ne`、`nl`、`pa`、`pl`、`ru`、`si`、`sk`、`sl`、`sr`、`sw`、`ta`、`te`、`th`、`tl`、`ur`、`uz`、`vi`
  - `PlamoLanguage = Readonly<{ kind: 'send'; code: string } | { kind: 'omit' } | { kind: 'unsupported' }>`
  - `plamoLanguage(code: string): PlamoLanguage`
    - 小文字にし、`_` を `-` に置き換えてから判定する。
    - `auto`、空、`/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/u` に合わないもの → `omit`
    - `zh` だけ → `omit`（簡体字か繁体字か分からないので、モデルに判別させる。判断 S15）
    - `zh-cn`、`zh-sg` と、`zh-hans` で始まるもの → `zh-hans`。`zh-tw`、`zh-hk`、`zh-mo` と、`zh-hant` で始まるもの → `zh-hant`
    - ほかは、最初の部分（`en-us` → `en`、`es-419` → `es`）が `PLAMO_LANGUAGES` にあれば `send`、なければ `unsupported`（`pt`、`pt-br`）
  - `PlamoInput = Readonly<{ line: string; sourceLang: string; previous: readonly string[]; glossary: readonly GlossaryEntry[]; slot: number | undefined; maxTokensCap?: number }>`
    - `sourceLang`: 分からないときは `'auto'`（`source_lang` を送らない）。③ は常に `'auto'`。
    - `previous`: 直前の原文。古い順。字幕は直前の文。③ は `Page: <ページのタイトル>` の行と、同じ要求の中の前の 2 単位の原文。
    - `glossary`: 空の `target` を `source` に置き換えたもの（字幕は Task 5 の `toPromptGlossary` を通す）。用語集を持たない ③ は `[]`。
    - `slot`: PLaMo の枠。字幕は `0`。③ は、枠の数が分かるまで `undefined`（`id_slot` を送らない）、分かったら 1 か 2。
    - `maxTokensCap`: `max_tokens` の上限。省くと `PLAMO_LIMITS.maxTokens`（256）。③ は、400 文字までの単位のために 816（③ の `PAGE_PLAMO_MAX_TOKENS`）を渡す（判断 S27）。
  - `plamoTranslateRequest(input: PlamoInput): Result<ChatRequest & Readonly<{ model: string; maxTokens: number }>>`
    - `input_invalid`: `line` が空か ASCII の空白（空白、タブ、CR、LF）だけ、`line` が `<|plamo:` を含む、`plamoLanguage(sourceLang)` が `unsupported`。
    - 返す request:
      - `model: PLAMO_TRANSLATE_MODEL`
      - `messages: [{ role: 'user', content: line }]`（system はない）
      - `templateKwargs`: `target_lang: 'ja'`。`source_lang` は `send` のときだけ。`context` と `glossary` は、下の規則で残るものがあるときだけ。
      - `temperature: 0`、`maxTokens: plamoMaxTokens(line, maxTokensCap)`、`stop: PLAMO_STOP`、`cachePrompt: true`、`tellRefusal: true`
      - `slot`: `input.slot` が数のときだけ入れる。`undefined` のときはキーを入れない（`exactOptionalPropertyTypes`）。
      - `grammar` と `jsonSchema` は付けない。`signal` も付けない（呼ぶ側が `{ ...request, signal }` で足す）。
    - 文脈（`context`）: `previous` から、空の行（ASCII の空白だけを含む）と `<|plamo:` を含む行を除き、後ろの 3 行を古い順に、各行の先頭から 200 コードポイントまで切って、`\n` でつなぐ。
    - 用語集（`glossary`）: `source` が `line` に含まれる語だけを、保存された順に送る（NFKC にして小文字で比べる。判断 S14）。`source` か `target` が空か `<|plamo:` を含む語は除く。
  - `plamoMaxTokens(line: string, cap: number = PLAMO_LIMITS.maxTokens): number` = min(cap, `translationLimit(line)`)。`translationLimit(line)` は min(2000, 2 × コードポイント数 + 16)（判断 S18、S27）。
  - `parsePlamoLine(reply: ChatReply, maxTokens: number, line: string): Result<string>`
    - 前後の空白を除き、内側の改行（前後の空白ごと）を 1 つの空白にする。
    - 次のどれかなら `response_invalid`: `cutByMaxTokens` に当たる、空、`<|plamo:` を含む、`translationLimit(line)` コードポイントを超える。
      - この上限は、Task 2 の `subtitleLimit`（Task 9 の `LiveLine.ja` の上限）と同じ関数（判断 S28）。
    - `<` と `>` は残す。③ は、印（`<1>…</1>`、`<k1/>`）のある単位の訳を、この後に ③ の `readPagePieces` で読む。
- llama のスタブ:
  - `StubChat` に `temperature?: number`、`stop?: readonly string[]`、`chat_template_kwargs?: Record<string, unknown>`、`response_format?: unknown` を足す。
  - `STUB_PLAMO_PREFIX = '訳P:'`
  - `withPlamo(responder: Responder): Responder`: PLaMo を載せたルーターとして振る舞う。
    - `GET /v1/models`: `responder` の答えの `data` の後ろに `{ id: PLAMO_TRANSLATE_MODEL }` を足す。
    - `model` が `PLAMO_TRANSLATE_MODEL` のチャット: 形式が正しければ `` `${STUB_PLAMO_PREFIX}${content}` `` を返す（自作の文字列。PLaMo の出力ではない）。正しくなければ HTTP 400（`{ error: { code: 400, type: 'invalid_request_error' } }`）。
    - 正しい形式: メッセージは user 1 つだけ（空でなく `<|plamo:` を含まない）、`chat_template_kwargs.target_lang === 'ja'`、`stop` が `PLAMO_STOP` と同じ、`grammar` と `response_format` がない。
    - それ以外のリクエスト（Gemma へのチャット、`/props` など）は `responder` に渡す。
  - `withPlamo` を通さない既定のスタブは、今までどおり `/v1/models` に PLaMo を載せず、PLaMo へのチャットに 404 を返す。
  - `testing/playwright.ts` からも `withPlamo`、`STUB_PLAMO_PREFIX` を export する。

- [ ] **Step 1: 失敗するテストを書く**

すべて自作の文字列にする。PLaMo の実際の出力は使わない。

```ts
// plamo.test.ts
it('builds one user message with the template kwargs and nothing that breaks PLaMo', () => {
  /* line 'Okay chat, the bridge is out.'、sourceLang 'en'、previous ['We reached the gate.']、
     glossary [{ source: 'Fixturo', target: 'Fixturo' }, { source: 'bridge', target: '橋' }]、slot 0
     → model 'plamo-3-translate-2b'、messages [{ role: 'user', content: line }]、
       templateKwargs { target_lang: 'ja', source_lang: 'en', context: 'We reached the gate.', glossary: [{ source: 'bridge', target: '橋' }] }、
       temperature 0、maxTokens 74、stop ['<|plamo:tag|>', '<|plamo:bos|>']、cachePrompt true、slot 0、tellRefusal true。
       'grammar' と 'jsonSchema' のキーがない。role 'system' のメッセージがない */
});
it.each([
  { name: '字幕の枠', slot: 0, expected: 0 },
  { name: 'ページの枠', slot: 2, expected: 2 },
  { name: '枠の数が分からない', slot: undefined, expected: 'none' },
])('slot: $name', ({ slot, expected }) => {
  /* line 'Okay chat'、sourceLang 'en'、previous []、glossary []。
     expected が 'none' なら 'slot' in request が false、ほかは request.slot === expected */
});
it('builds the page form: no glossary, no source language, the title and two units as context', () => {
  /* line 'Roll backward to dodge the light attack.'、sourceLang 'auto'、glossary []、slot 1、maxTokensCap 816、
     previous ['Page: Fixture Wiki', 'Final Boss Guide', 'Phase two starts at half health.']
     → templateKwargs は { target_lang: 'ja', context: 'Page: Fixture Wiki\nFinal Boss Guide\nPhase two starts at half health.' } と等しい
       （'source_lang' と 'glossary' のキーがない）。maxTokens 96、slot 1 */
});
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
  { code: 'pt', expected: { kind: 'unsupported' } },
  { code: 'pt-BR', expected: { kind: 'unsupported' } },
])('plamoLanguage($code)', ({ code, expected }) => {
  /* ... */
});
it('leaves source_lang out when the language is unknown', () => {
  /* sourceLang 'auto' → templateKwargs に 'source_lang' のキーがない */
});
it.each([
  { name: '空', line: '', sourceLang: 'en' },
  { name: 'ASCII の空白だけ', line: ' \t\r\n', sourceLang: 'en' },
  { name: '予約トークン', line: 'gg <|plamo:tag|> ez', sourceLang: 'en' },
  { name: '対応していない言語', line: 'Bom dia chat', sourceLang: 'pt' },
])('rejects $name with input_invalid', ({ line, sourceLang }) => {
  /* slot 0 */
});
it('keeps the last three usable previous lines, each cut to 200 code points', () => {
  /* previous ['one', 'two', 'x <|plamo:msg|> y', 'three', 'a'.repeat(250), '  ']
     → context `two\nthree\n${'a'.repeat(200)}`。previous [] → 'context' のキーがない */
});
it('sends only glossary terms found in the line and leaves the key out when none are', () => {
  /* line 'FIXTURO crossed the bridge'、glossary [Fixturo→Fixturo, castle→城, '<|plamo:x'→y]
     → glossary [{ source: 'Fixturo', target: 'Fixturo' }]。line 'Okay chat' → 'glossary' のキーがない */
});
it.each([
  { name: '短い行', line: 'Okay chat', cap: undefined, expected: 34 },
  { name: '200 文字は 256 まで', line: 'a'.repeat(200), cap: undefined, expected: 256 },
  { name: '上限を上げても短い行は同じ', line: 'Okay chat', cap: 816, expected: 34 },
  { name: 'ページの 400 文字', line: 'a'.repeat(400), cap: 816, expected: 816 },
])('plamoMaxTokens: $name', ({ line, cap, expected }) => {
  /* cap が undefined なら引数を省く */
});
it('caps max_tokens of the request at maxTokensCap', () => {
  /* line 'a'.repeat(400)、slot 1: maxTokensCap なし → maxTokens 256、maxTokensCap 816 → 816 */
});
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
  { name: '予約トークン', text: 'よし<|plamo:tag|>', finish: 'stop', expected: 'response_invalid' },
  { name: '上限を超えた', text: 'あ'.repeat(35), finish: 'stop', expected: 'response_invalid' },
])('parsePlamoLine: $name', ({ text, finish, expected }) => {
  /* parsePlamoLine(reply, plamoMaxTokens('Okay chat'), 'Okay chat')（上限 34） */
});
// llm.test.ts
it('sends stop strings only when the request has them', async () => {
  /* body.stop が ['<|plamo:tag|>', '<|plamo:bos|>']。stop のない要求の body に 'stop' のキーがない */
});
it.each([
  {
    status: 400,
    message: "model 'plamo-3-translate-2b' not found",
    tellRefusal: true,
    expected: 'model_refused',
  },
  { status: 400, message: 'Invalid slot ID', tellRefusal: true, expected: 'model_refused' },
  { status: 404, message: 'File Not Found', tellRefusal: true, expected: 'model_refused' },
  { status: 503, message: 'Loading model', tellRefusal: true, expected: 'model_refused' },
  { status: 503, message: 'Loading model', tellRefusal: false, expected: 'network_failed' },
  { status: 404, message: 'File Not Found', tellRefusal: false, expected: 'network_failed' },
])('HTTP $status "$message" with tellRefusal $tellRefusal is $expected', async (row) => {
  /* 本文は { error: { code: status, message } } */
});
it('keeps an unreachable server as network_failed even with tellRefusal', async () => {
  /* fetch が reject */
});
it('returns operation_cancelled before reading the status of a refused reply', async () => {
  /* tellRefusal true。signal を abort してから 503 を返す fetch → operation_cancelled */
});
// llama-stub.test.ts（createLlamaClient で送る）
it('withPlamo lists the model and answers the request plamoTranslateRequest builds', async () => {
  /* /v1/models は ['stub-model', 'plamo-3-translate-2b']。
     plamoTranslateRequest({ line: 'Okay chat', sourceLang: 'en', previous: [], glossary: [], slot: 0 }) → '訳P:Okay chat' */
});
it.each([
  { name: 'system メッセージ', change: 'system' },
  { name: 'grammar', change: 'grammar' },
  { name: 'stop がない', change: 'no-stop' },
  { name: 'response_format', change: 'response-format' },
])('withPlamo refuses a PLaMo chat with $name with 400', async ({ change }) => {
  /* tellRefusal の client で model_refused */
});
it('withPlamo leaves Gemma chats to the wrapped responder', async () => {
  /* withPlamo(defaultResponder) にコメントのバッチ → commentBatchReply と同じ答え */
});
it('the default stub lists no PLaMo and answers a PLaMo chat with 404', async () => {
  /* tellRefusal の client で model_refused */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `plamo.ts` は `prompts.ts` に入れない（`prompts.ts` は 700 行を超えている。G1 のレビューの M8）。
  - README の例も自作の文字列にする。PLaMo の出力を貼らない。
- [ ] **Step 4: 通ることを確認する**
  - Run:
    - `pnpm errors:generate`
    - `pnpm --filter @chrome-toolbox/extension-core test`
    - `pnpm --filter @chrome-toolbox/comment-assistant test`
    - `pnpm check`
  - Expected: PASS。comment-assistant は `tellRefusal` も `stop` も付けないので、変化はない。
- [ ] **Step 5: 実サーバーで 1 回だけ形を確かめる（コントローラー。PLaMo を載せたサーバーがあるときだけ）**
  - `plamoTranslateRequest` が作る本文（自作の 1 行、`slot: 0`）を `curl` で `http://127.0.0.1:18083/v1/chat/completions` に送り、HTTP 200 で 1 行の訳が返ることを確かめる。`slot: 1` でも 1 回送る。
  - `source_lang: "zh-CN"` にした本文が HTTP 400 になり、`createLlamaClient` が `tellRefusal` で `model_refused` を返すことを確かめる。
  - 応答の本文は記録しない。リポジトリにも、ledger にも書かない（PLaMo Community License）。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(extension-core): PLaMo translation request, stop strings and opt-in model_refused"`

### Task 1: LLM クライアントの音声入力（extension-core）

背景（llama.cpp `620d222` のソースで確認）:

- 今の `ChatMessage.content` は文字列だけで、llama のスタブも文字列でない本文を受け付けない。
- `ChatMessage.content` を文字列と部品の配列の union に広げると、本文を文字列として読んでいるコードが型で壊れる。`src/prompts.test.ts` の補助関数、スタブ自身（`commentBatchReply(user)` など）、comment-assistant の E2E（`test/browser/comments.spec.ts`、`test/browser/front.spec.ts` が `request.chat.messages` の本文に `startsWith` と `split` を使う）。そこで `ChatMessage` は変えず、部品の本文を持つメッセージを別の型にする（判断 S2）。
- `GET /props?model=<name>` は `modalities: { vision, video, audio }` を返す（`tools/server/server-context.cpp` の `get_res_props`）。
- 投影器のないモデルに `input_audio` を送ると、`oaicompat` の解析が例外を出し、HTTP 400（`invalid_request_error`）になる（`server-common.cpp`）。
- `id_slot` で指定した枠が使用中のときは、サーバーがその枠の解放まで待たせる（`server-context.cpp` の deferred task）。
- Task 0 が先に入っている。`ChatRequest` には `stop` と `tellRefusal` があり、2xx 以外の応答は `request` の 1 か所で、`chat` が渡す `tellRefusal` に従って `model_refused` か `network_failed` になる。この Task は、その分岐に `audio_unsupported` の判定を足す（判断 S30）。

**Files:**

- Modify: `packages/extension-core/src/llm.ts`、`src/index.ts`
- Modify: `tools/errors/catalog.json`（`audio_unsupported` → 公開コード `unavailable`）。続けて `pnpm errors:generate` を実行する。
- Modify: `packages/extension-core/testing/llama-stub.ts`、`testing/playwright.ts`（export）
- Test: `packages/extension-core/src/llm.test.ts`、`testing/llama-stub.test.ts`

**Interfaces:**

- Produces:
  - `ChatContentPart`:

    ```ts
    type ChatContentPart =
      | Readonly<{ type: 'text'; text: string }>
      | Readonly<{ type: 'input_audio'; input_audio: Readonly<{ data: string; format: 'wav' }> }>;
    ```

  - `ChatMessage` は変えない（`content: string`）。
  - `ChatPartsMessage = Readonly<{ role: 'user'; content: readonly ChatContentPart[] }>`
    - `data` は WAV の base64（`data:` URL ではない）。`packages/bench/asr.ts` が実サーバーで通した形と同じ。
  - `ChatRequest.messages: readonly (ChatMessage | ChatPartsMessage)[]`
  - `index.ts` から `ChatContentPart`、`ChatPartsMessage` を export する。
  - `ServerProps = Readonly<{ totalSlots: number; audio: boolean | undefined }>`
    - `audio` は `modalities.audio`。サーバーが返さないときは `undefined`。
  - `chat`:
    - HTTP 400 で、JSON の `error.message` に `audio input is not supported` を含む → `Err(failure('audio_unsupported'))`。`tellRefusal` の有無にかかわらず、この判定を先にする。
    - それ以外の 2xx 以外の応答は、Task 0 のとおり（`tellRefusal` なら `model_refused`、なければ `network_failed`）
- llama のスタブ:
  - Task 0 の `StubChat` の項目（`temperature`、`stop`、`chat_template_kwargs`、`response_format`）と `withPlamo` は、そのまま残す。
  - 部品の本文を持つメッセージも受け付ける。`StubChat.messages` の型は `readonly ChatMessage[]` のままにし、部品の本文は、テキストの部品を `\n` でつないだ文字列として入れる。
  - `StubChat.audio: number` を足す。`input_audio` の部品の数で、テキストだけのチャットは 0。
  - `GET /props` は `{ total_slots: 2, modalities: { vision: false, video: false, audio: true } }` を返す。
    - comment-assistant の E2E が使う枠の数は変えない。
  - `input_audio` を含むチャットには、`asrReply(n)` = `` `en\t${STUB_TRANSCRIPT} ${n}.\n` `` を返す。
    - `n` はスタブごとの通し番号（1 から）。
    - `STUB_TRANSCRIPT = 'Stub speech'`
  - `withoutAudio(responder: Responder): Responder` を export する。投影器のないサーバーとして振る舞う。
    - `/props` の `modalities.audio` を `false` にする。
    - `input_audio` を含むチャットに、上記の HTTP 400 を返す。
  - `testing/playwright.ts` からも `withoutAudio`、`STUB_TRANSCRIPT` を export する。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('sends audio parts as OpenAI input_audio content', async () => {
  /* body.messages[1].content[1] は { type: 'input_audio', input_audio: { data, format: 'wav' } } */
});
it.each([
  {
    name: '音声入力あり',
    body: { total_slots: 3, modalities: { vision: false, video: false, audio: true } },
    expected: { totalSlots: 3, audio: true },
  },
  {
    name: '投影器なし',
    body: { total_slots: 3, modalities: { vision: false, video: false, audio: false } },
    expected: { totalSlots: 3, audio: false },
  },
  {
    name: 'modalities を返さない',
    body: { total_slots: 3 },
    expected: { totalSlots: 3, audio: undefined },
  },
])('props: $name', async ({ body, expected }) => {
  /* Ok(expected) */
});
it.each([
  { name: 'tellRefusal なし', tellRefusal: false },
  { name: 'tellRefusal あり', tellRefusal: true },
])("maps the server's no-projector 400 to audio_unsupported: $name", async ({ tellRefusal }) => {
  /* status 400, { error: { code: 400, message: 'audio input is not supported - hint: …', type: 'invalid_request_error' } } */
});
it('keeps other 400 replies as Task 0 maps them', async () => {
  /* 'Invalid slot ID': tellRefusal なし → network_failed、tellRefusal あり → model_refused */
});
// llama-stub.test.ts
it('answers input_audio chats with numbered transcript lines', async () => {
  /* 'en\tStub speech 1.\n'、2 回目は 2。request.chat.audio は 1、本文はテキストの部品 */
});
it('withoutAudio reports no audio in props and rejects input_audio with 400', async () => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - 400 の本文は、`audio_unsupported` を判定するときだけ読む。それ以外の応答の扱い（Task 0 の `tellRefusal`）は変えない。
- [ ] **Step 4: 通ることを確認する**
  - Run:
    - `pnpm errors:generate`
    - `pnpm --filter @chrome-toolbox/extension-core test`
    - `pnpm --filter @chrome-toolbox/comment-assistant test`
    - `pnpm check`
  - Expected: PASS。comment-assistant は文字列の本文しか送らないので、変化はない。`ChatMessage` を変えないので、comment-assistant のテストもそのまま型が通る。
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): audio input parts and audio capability for the llama client"`

### Task 2: 字幕のプロンプト（共通のシステム文と、翻訳の 1 行形式）

背景:

- 今の `subtitlePrompt` は JSON Schema（`{"ja": …, "en"?: …}`）で、上の段の英語訳（`withEnglish`）のための形になっている。英語訳はなくなった。
- コメントのバッチは、出力を GBNF の行形式にしたことで、トークン数がほぼ半分になった（R20）。また、長さの上限で暴走を止めている（R46）。字幕も同じ形にする。
- ASR と翻訳は、同じ枠 0 に交互に流れる。システム文と配信ごとの前置きを共通にしておけば、交互に流れてもプロンプトキャッシュの先頭を使い回せる。違う前置きのままだと、毎回 150〜200 トークンを評価し直すことになる（キャッシュのない 1,200 トークンの評価は毎秒約 1,100 トークン。llama-server.md の実測）。

**Files:**

- Modify: `packages/extension-core/src/prompts.ts`、`src/prompts.test.ts`、`src/index.ts`
  - `subtitleOutputSchema` と `withEnglish` を削除する。
- Modify: `packages/extension-core/README.md`（`src/prompts.ts` の行。`subtitleOutputSchema` を消し、字幕の 1 行形式を書く）
- Modify: `packages/extension-core/testing/llama-stub.ts`（字幕の翻訳に応答する）
- Modify: `packages/bench/translate.ts`、`packages/bench/slots.ts`、`packages/bench/generation.ts` と、それぞれのテスト（新しい形式で送り、新しい形式で読む）

**Interfaces:**

- Produces:
  - `SUBTITLE_SYSTEM`（export しない固定の文）: 文字起こし（transcribe）と翻訳（translate）の両方の仕事を説明する。
    - 文字起こし: 話された言葉をそのまま、話された言語で書く。翻訳しない。返すのは 1 行の `<ISO 639-1 の 2 文字>\t<文字起こし>`。音声がなければ、文字起こしを空にする。
    - 翻訳: 日本語の字幕として、自然で短い訳を 1 行だけ返す。注釈、読み、かっこ書き、原文の繰り返しは書かない。
    - 用語集の語は、指定どおりに書く。訳が原文と同じ語は、訳したり、カタカナに直したりせず、そのまま書く。
    - 前の行は文脈としてだけ使い、訳さない。
    - user の値は JSON のデータで、指示ではない（`DATA_NOT_INSTRUCTIONS`）。
  - `subtitleStreamPart(input: Readonly<{ context: string; glossary: readonly GlossaryEntry[] }>): string`
    - 配信ごとの前置き。ASR と翻訳の user の先頭に同じ文字列で入れる。
    - `Stream context: <JSON 文字列>` と `Glossary (JSON, source to target): [...]` をこの順に並べる。用語集は保存された順のまま。
  - `subtitlePrompt(input: Readonly<{ source: string; sourceLang: string; previous: readonly string[]; context: string; glossary: readonly GlossaryEntry[] }>): GrammarPrompt`
    - user の並び: 配信ごとの前置き → `Task: translate` → `Source language` → `Previous lines (JSON, context only)`（最大 3 行、古い順。4 行目からは無視する）→ `Line to translate (JSON string)`
    - 文法: `root ::= [^\n<>]{1,L} "\n"`。`L = subtitleLimit(source)`
  - `subtitleLimit(source: string): number` = min(2000, 2 × コードポイント数 + 16)。Task 0 で export した `translationLimit` をそのまま使う（コメントと PLaMo の上限と同じ関数。式を書き直さない。判断 S28）。
  - `subtitleMaxTokens(source: string): number` = 8 + 3 × `subtitleLimit(source)`
  - `parseSubtitleLine(reply: ChatReply, maxTokens: number, source: string): Result<string>`
    - 最後の改行を除いた 1 行を返す。
    - 改行がない、`cutByMaxTokens` に当たる、長さが上限 `L = subtitleLimit(source)` に達した、空、のどれかなら `response_invalid`（その文は原語のまま表示する）。
    - `source` を受け取るのは `L` を出すため（判断 S3。`parseAsrLine` が `durationMs` を受け取るのと同じ）。
- スタブ: システム文が `SUBTITLE_SYSTEM` で、`input_audio` を含まない（`StubChat.audio === 0`）チャットには、`` `訳:${line}\n` `` を返す。`line` は `Line to translate` の JSON 文字列。ASR のチャット（Task 1 の `asrReply`）はシステム文が同じなので、`audio` を先に見る。
- ベンチ:
  - `bench:translate` と `bench:slots` は `grammar` と `maxTokens: subtitleMaxTokens(source)` で送り、`parseSubtitleLine(reply, maxTokens, source)` で読む。
  - `GENERATION.maxTokens.subtitle` は「8 + 3 × 訳の上限の文字数」と記録する。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('keeps the system turn identical for every input', () => {
  /* source・context・glossary が違う 2 つの呼び出しで messages[0] が同じ */
});
it('starts the user turn with the stream part, then task, language, previous lines and the line', () => {
  /* user.startsWith(subtitleStreamPart({ context, glossary })) と、各見出しの出現順 */
});
it.each([
  { name: '短い英語', source: 'Okay chat', limit: 34 },
  { name: '絵文字はコードポイントで数える', source: '😀😀', limit: 20 },
  { name: '上限', source: 'a'.repeat(1500), limit: 2000 },
])('subtitleLimit: $name', ({ source, limit }) => {
  /* ... */
});
it.each([
  { name: '1 行', text: 'よしチャット\n', finish: 'stop', expected: 'よしチャット' },
  {
    name: '改行がないまま切れた',
    text: 'よしチャ',
    finish: 'length',
    expected: 'response_invalid',
  },
  {
    name: '上限に達した',
    text: `${'あ'.repeat(34)}\n`,
    finish: 'stop',
    expected: 'response_invalid',
  },
  { name: '空', text: '\n', finish: 'stop', expected: 'response_invalid' },
])('parseSubtitleLine: $name', ({ text, finish, expected }) => {
  /* parseSubtitleLine(reply, subtitleMaxTokens('Okay chat'), 'Okay chat')（上限 34） */
});
it('tells the model to keep glossary terms whose target equals the source', () => {
  /* system に keep … exactly as written、user の Glossary に { source: 'Fixturo', target: 'Fixturo' } */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test && pnpm --filter @chrome-toolbox/bench test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - ベンチの meta に残る生成設定が変わるので、`docs/adoption.md` の「What the reports mean」の字幕の `max_tokens` の行を直す。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test && pnpm --filter @chrome-toolbox/comment-assistant test && pnpm --filter @chrome-toolbox/bench test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(extension-core): one-line subtitle translation sharing its prefix with speech recognition"`

### Task 3: 音声認識のプロンプトとクライアント（extension-core、bench:asr）

**Files:**

- Modify: `packages/extension-core/src/prompts.ts`（`asrPrompt`、`parseAsrLine`、`asrTextLimit`、`asrMaxTokens`）、`src/index.ts`
- Create: `packages/extension-core/src/asr.ts`、`src/asr.test.ts`
- Modify: `packages/bench/asr.ts`、`packages/bench/asr.test.ts`
  - whisper.cpp のエンジンを削除する（R10）。
  - 拡張と同じリクエストを送る。
- Modify: `packages/bench/datasets.ts`（音声の言語に `ja` を足す）、`packages/bench/fixtures/audio.jsonl`（自作の日本語の文 `ja-1`〜`ja-3`、声は `Kyoko`）
- Modify: `docs/adoption.md`（「Commands the user runs」の `bench:asr` の行）

**Interfaces:**

- Produces（prompts.ts）:
  - `asrTextLimit(durationMs: number): number` = min(400, ceil(durationMs / 1000 × 40) + 16)
  - `asrMaxTokens(durationMs: number): number` = 8 + 3 × `asrTextLimit(durationMs)`
  - `AsrPrompt = Readonly<{ messages: readonly [ChatMessage, ChatPartsMessage]; grammar: string }>`（`ChatPartsMessage` は Task 1）
  - `asrPrompt(input: Readonly<{ wavBase64: string; durationMs: number; sourceLang: 'auto' | string; context: string; glossary: readonly GlossaryEntry[] }>): AsrPrompt`
    - system は Task 2 の `SUBTITLE_SYSTEM`。
    - user（`ChatPartsMessage`）の本文は 2 つの部分からなる。
      1. テキストの部分。配信ごとの前置き（`subtitleStreamPart`）→ `Task: transcribe` → 言語を固定したときだけ `Spoken language: "<code>"`。
      2. 音声の部分（`input_audio`、`format: 'wav'`）。
    - 用語集の原文は、話されうる名前として文字起こしの綴りにも効く。
    - 文法:
      - `root ::= lang "\t" text "\n"`
      - `lang ::= [a-z] [a-z]`（言語を固定したときは `lang ::= "ko"` のような固定の文字列）
      - `text ::= [^\t\n<>]{0,N}`。`N = asrTextLimit(durationMs)`
  - `AsrLine = Readonly<{ lang: string; text: string }>`。`text` が空なら無音。
  - `parseAsrLine(reply: ChatReply, maxTokens: number, durationMs: number): Result<AsrLine>`
    - 次のどれかなら `response_invalid`。上限まで続いた文字起こしは、無音を言葉にしたときの繰り返しのことが多いので、表示しない。
      - 改行がない
      - `cutByMaxTokens` に当たる
      - `text` が上限 `N` に達した
- Produces（asr.ts）:
  - `encodeWav(pcm: Int16Array, sampleRate: 16000): Uint8Array`: 44 バイトのヘッダーを付けた PCM16 mono。
  - `wavBase64(wav: Uint8Array): string`: 8 KiB ずつ `btoa` する。大きな文字列を一度に作らない。
  - `createAsrClient(options: { client: LlamaClient; model: () => string }): AsrClient`
    - `client` は `timeoutMs: 8_000` で作ったもの。
  - `AsrClient = { transcribe(this: void, pcm: Int16Array, options: { sourceLang: string; context: string; glossary: readonly GlossaryEntry[]; signal?: AbortSignal }): Promise<Result<AsrLine & { ms: number }>> }`
    - 送り方: `model: model()`、`slot: 0`、`temperature: 0`、`cachePrompt: true`、`grammar`、`maxTokens: asrMaxTokens`、`templateKwargs: { enable_thinking: false }`
    - `ms` は、送ってから応答を読み終えるまで。
- `bench:asr`:
  - Usage: `pnpm --filter @chrome-toolbox/bench bench:asr -- --server <url> --model <name> [--repeat <n>] [--chunk-ms <ms>] [--set <dir> --manifest <jsonl>] [--out <jsonl>]`
  - `--engine` はなくす。リクエストは `createAsrClient` と同じ（枠 0、`model`、行形式）。
  - `--repeat <n>`（既定 1）: 標本の集まりを、順番どおりに n 回流す。
  - `--chunk-ms <ms>`（既定なし）: 1 つの音声を、先頭から長さ `ms` 以下に切って順に送り、文字起こしを空白でつないで採点する。拡張の強制の区切り（1,500 ms）で精度がどれだけ落ちるかを測るためのもの。遅延は切った 1 つずつの値を記録する。
  - 行ごとに `silent`（空の文字起こし）を記録し、言語ごとの表に `silent` の列を足す。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { durationMs: 1500, limit: 76, maxTokens: 236 },
  { durationMs: 300, limit: 28, maxTokens: 92 },
  { durationMs: 60_000, limit: 400, maxTokens: 1208 },
])('asr limits for $durationMs ms', ({ durationMs, limit, maxTokens }) => {
  /* ... */
});
it('puts the stream part, the task and the fixed language before the audio part', () => {
  /* messages[1].content[0].text が subtitleStreamPart(...) で始まり 'Spoken language: "ko"' を含む。messages[1].content[1].type === 'input_audio' */
});
it('shares the system turn and the stream part with subtitlePrompt', () => {
  /* 同じ context・glossary で、system が等しく、user の先頭の前置きが等しい */
});
it.each([
  { name: '自動', sourceLang: 'auto', grammarHas: '[a-z] [a-z]' },
  { name: '韓国語に固定', sourceLang: 'ko', grammarHas: '"ko"' },
])('asr grammar: $name', ({ sourceLang, grammarHas }) => {
  /* ... */
});
it.each([
  {
    name: '英語',
    text: 'en\tOkay chat, we are going in.\n',
    finish: 'stop',
    expected: { lang: 'en', text: 'Okay chat, we are going in.' },
  },
  { name: '無音', text: 'en\t\n', finish: 'stop', expected: { lang: 'en', text: '' } },
  { name: '途中で切れた', text: 'ko\t안녕', finish: 'length', expected: 'response_invalid' },
  {
    name: '上限まで続いた',
    text: `en\t${'ha'.repeat(38)}\n`,
    finish: 'stop',
    expected: 'response_invalid',
  },
])('parseAsrLine: $name', ({ text, finish, expected }) => {
  /* durationMs 1500（上限 76） */
});
// asr.test.ts
it('encodes a RIFF/WAVE header with the PCM byte length', () => {
  /* 'RIFF'、'WAVE'、'fmt '、16000、data 長 = 2 × サンプル数 */
});
it('sends model, id_slot 0, the grammar and the wav as input_audio', async () => {
  /* fake fetch で body を確かめる */
});
it('returns audio_unsupported when the server has no projector', async () => {
  /* withoutAudio のスタブ */
});
// packages/bench/asr.test.ts
it('scores chunked clips by joining the chunk transcripts', async () => {
  /* --chunk-ms 1500、偽のサーバー */
});
it('counts silent rows and language accuracy with the line format', async () => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test && pnpm --filter @chrome-toolbox/bench test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test && pnpm --filter @chrome-toolbox/bench test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: 実サーバーで 1 回だけ形を確かめる（コントローラー）**
  - サーバーに投影器があるときだけ行う。
  - `pnpm --filter @chrome-toolbox/bench bench:make-audio` → `pnpm --filter @chrome-toolbox/bench bench:asr -- --server <url> --model gemma4-e4b`
  - 18 本すべてが行形式で読めることと、`ja` が `ja` と判別されることを確かめる。
  - 計測は Task 4 で行う。ここでは数字を記録しない。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(extension-core): speech recognition through llama.cpp audio input with a bounded line format"`

### Task 4: 計測と投影器の決定（bench:slots の音声、mmproj、MTP）

背景:

- R61 で Gemma の投影器を既定のプリセットから外した。字幕を出すときは戻す。
- BF16 のファイル（0.99 GB）は、945 MiB がプロセスのメモリに読み込まれる。
- ggml-org の Q8_0 は、QAT でない元のモデルから変換したもの。QAT のモデルと組み合わせて精度が保てるかは、測るまで分からない。
- MTP を使うと、字幕の翻訳だけの p95 がコメントの負荷の下で 1.25 s から 1.8 s に上がった。ASR が加わると、3 s を超えるおそれがある。

結果（2026-11-06、`docs/adoption.md` の「Speech recognition and slot 0」）: 投影器は BF16。枠 0 は、コメント 2 本の負荷の下で MTP の有無にかかわらず目標を外れ、1 本なら MTP ありで収まった。ユーザーの決定で MTP を残し、コメントが譲る（Task 17）。1,500 ms で機械的に切った音声の失敗は、Task 11 と Task 12 に反映した。

**Files:**

- Modify: `packages/bench/slots.ts`、`packages/bench/slots.test.ts`（`--audio`）
- Modify: `docs/llama-server.md`、`docs/adoption.md`

**Interfaces:**

- `bench:slots --audio [--set <dir> --manifest <jsonl>]`:
  - 字幕の 1 刻み（1.5 s ごと）で、次の音声（manifest の順に繰り返す）を `asrPrompt` で枠 0 に送る。
  - 文字起こしがあり、言語が `ja` でなければ、続けて `subtitlePrompt` の翻訳を枠 0 に送る。
  - 2 つの遅延を記録する。どちらも刻みの予定時刻から数える（今の `bench:slots` と同じ）。
    - `sourceMs`: ASR の応答まで
    - `jaMs`: 翻訳の応答まで
  - 合格の条件:
    - source p50 ≤ 1,000 ms
    - ja p50 ≤ 2,000 ms、ja p95 ≤ 3,000 ms
    - 予定した刻みをすべて送り、失敗が 0
  - 表に source の p50 と p95 の列を足す。
  - ASR と翻訳それぞれの `promptMs`（llama-server の `timings.prompt_ms`）の p50 も出す。前置きの共有が効いているかを見るため。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('sends ASR then the translation on slot 0 and measures both from the tick schedule', async () => {
  /* 偽の client。呼び出し順と id_slot、sourceMs < jaMs */
});
it('skips the translation for Japanese speech', async () => {
  /* 'ja\tこんにちは\n' → 翻訳 0 回 */
});
it('fails the target when ja p95 exceeds 3000 ms', async () => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/bench test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(bench): measure speech recognition and translation together on the subtitle slot"`
- [ ] **Step 6: 計測の準備（コントローラーが行う）**
  - 静かなホストで行う。5 分平均の負荷が 4 未満で、ほかのモデルのクライアントが動いていないこと。
  - 動いているサーバー（18083）には触らない。計測用のルーターは 18090 で起動し、オプションは `docs/llama-server.md` §4 と同じにする。実装者はコマンドを用意するだけで、サーバーは起動しない。
  - Q8_0 の投影器を取得し、ハッシュを確かめる。

    ```console
    curl -fLO https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/a69f018d7678a2b9f5e705f8903d6fb29b9b25dc/mmproj-gemma-4-E4B-it-Q8_0.gguf
    shasum -a 256 mmproj-gemma-4-E4B-it-Q8_0.gguf
    # 197f49a93027f9843772bd24a6a9e0be2a32a788de5a3def330e9c585d86edd1
    ```

  - プリセットを 2 つ用意する。違うのは `[gemma4-e4b]` の `mmproj` の行だけにする。
    - A: `gemma-4-E4B-it-mmproj.gguf`（BF16）
    - B: `mmproj-gemma-4-E4B-it-Q8_0.gguf`
  - `pnpm --filter @chrome-toolbox/bench bench:make-audio` で 18 本の合成音声を作る。`bench-data/audio/real/` に実音声があれば、それも使う。
- [ ] **Step 7: 投影器を比べる（A-B-B-A。コントローラーが行う）**
  - 各回で次を行う。
    1. そのプリセットでサーバーを起動し直す。
    2. 1 本で温める。
    3. `pnpm --filter @chrome-toolbox/bench bench:asr -- --server http://127.0.0.1:18090 --model gemma4-e4b --repeat 3 --out bench-data/results/asr-<A|B>-<回>.jsonl` を実行する。
    4. 同じことを `--chunk-ms 1500` でも行う。
    5. gemma4-e4b の子プロセスのメモリを記録する。待機時と計測の後の `ps -o rss=`、`footprint`、サーバーのログにある投影器のバッファの大きさ。
  - 決め方: 次をすべての言語で満たせば Q8_0 を勧める。満たさなければ BF16 を勧める。
    - 言語の正解率が BF16 と同じ
    - 誤り率（WER、中国語と日本語は CER）の平均が BF16 + 0.02 以内
    - p50 が BF16 の 1.05 倍以内（A と B それぞれ 2 回の中央値で比べる）
- [ ] **Step 8: 枠 0 をコメントの負荷の下で測る（MTP あり・なし、A-B-B-A。コントローラーが行う）**
  - 投影器は Step 7 で決めたものにする。
    - A: 採用中のプリセット（MTP n3）
    - B: A から `spec-type`、`model-draft`、`spec-draft-n-max` を除いたもの
  - 各回: `pnpm --filter @chrome-toolbox/bench bench:slots -- --server http://127.0.0.1:18090 --model gemma4-e4b --audio --comment-streams 2 --seconds 60`
  - 決め方:
    - A の「loaded, pinned」の行が合格すれば、MTP をそのまま使う。
    - A が不合格で B が合格なら、`spec-draft-n-max = 2` の A' を 1 組（A'-B）測る。
    - それでも不合格なら、作業を止めてユーザーに選んでもらう。MTP をやめると、コメントの生成が遅くなる（MTP で 1 本 +40%、2 本 +52% だった）。MTP を残すと、字幕の目標を外れる。両方の数字を示す。
- [ ] **Step 9: 文書を直す**
  - `docs/llama-server.md`:
    - §2 の表に Q8_0 の行を足す（リポジトリ `ggml-org/gemma-4-E4B-it-GGUF`、リビジョン `a69f018d7678a2b9f5e705f8903d6fb29b9b25dc`、ファイル名、0.56 GB、SHA-256）。ダウンロードのコマンドも足す。
    - §3 のプリセットの `mmproj` の行を、勧めるファイルにし、「字幕（音声認識）を使うときは有効にする」と書く。メモリの増え方は実測の値で書く。
    - 「Why these values」の投影器の項を直す。字幕には要ること、BF16 は 945 MiB、Q8_0 は実測の値。
    - §4 の確認に `curl -s 'http://127.0.0.1:18083/props?model=gemma4-e4b'` の `"modalities":{…"audio":true…}` を足す。
    - §6 の `models.asr` の行を直す。
  - `docs/adoption.md`:
    - 投影器の比較、言語ごとの ASR（丸ごとと 1,500 ms 区切り）、枠 0 のコメントの負荷の下での値（MTP あり・なし）の表を足す。
    - 「Results (PENDING)」の ASR の行を埋める。
  - 実配信のデータは使わない。使った場合も、数字だけを書く。
- [ ] **Step 10: Commit**
  - `git commit -m "docs(llama-server): speech projector for subtitles and slot 0 latency with MTP"`

### Task 5: 設定、用語集、配信の情報、送り手の確認（subtitle-translator）

**Files:**

- Create: `packages/subtitle-translator/src/settings.ts`、`src/glossary.ts`、`src/page-context.ts`、`src/protocol.ts`
- Modify: `packages/subtitle-translator/src/runtime.ts`（送り手の種類ごとの経路）
- Modify: `packages/subtitle-translator/package.json`（catalog から。comment-assistant と同じく、`zod` は `dependencies`、`jsdom`、`@testing-library/react`、`@testing-library/user-event` は `devDependencies`）
- Test: `test/unit/settings.test.ts`、`test/unit/glossary.test.ts`、`test/unit/page-context.test.ts`、`test/unit/runtime.test.ts`

**Interfaces:**

- `src/settings.ts`:
  - `DISPLAY_MODES = ['ja', 'both', 'source', 'off'] as const`
  - `DISPLAY_LABELS = { ja: '日本語', both: '併記', source: '原語', off: 'オフ' }`
  - `nextDisplay(mode: DisplayMode): DisplayMode`: ja → both → source → off → ja
  - `SOURCE_LANGUAGES`: 12 言語と日本語のラベル。`en` 英語、`es` スペイン語、`ko` 韓国語、`id` インドネシア語、`zh` 中国語、`ja` 日本語、`pt` ポルトガル語、`fr` フランス語、`de` ドイツ語、`ru` ロシア語、`th` タイ語、`vi` ベトナム語。
  - `SOURCE_LANGUAGE_CODES = ['en', 'es', 'ko', 'id', 'zh', 'ja', 'pt', 'fr', 'de', 'ru', 'th', 'vi'] as const`（`SOURCE_LANGUAGES` のキーと同じ順。`satisfies` で両方が揃っていることを型で確かめる）
  - `SUBTITLE_TRANSLATORS = ['gemma', 'plamo'] as const`、`SubtitleTranslator = (typeof SUBTITLE_TRANSLATORS)[number]`
    - `gemma`: extension-core の設定の `models.translate`（既定 `gemma4-e4b`）で、Task 2 の形式で訳す。
    - `plamo`: `plamo-3-translate-2b` に、Task 0 の形式（`plamoTranslateRequest`）で訳す。使うのは Task 8 の line translator。
  - `TRANSLATOR_LABELS = { gemma: 'Gemma（既定）', plamo: 'PLaMo 3 Translate 2B（速い・任意）' }`
  - `subtitleSettingsSchema = z.strictObject({ display: z.enum(DISPLAY_MODES), source: z.enum(['auto', 'captions', 'audio']), sourceLang: z.union([z.literal('auto'), z.enum(SOURCE_LANGUAGE_CODES)]), translator: z.enum(SUBTITLE_TRANSLATORS) })`
  - `defaultSubtitleSettings = { display: 'both', source: 'auto', sourceLang: 'auto', translator: 'gemma' }`
    - `translator` をここで足すのは、Task 8 より前に保存した記録が strict の検証で読めなくならないようにするため（判断 S13）。使うのは Task 8 から。
  - `subtitleSettingsStore(area: StorageArea, key = 'subtitles'): { load(): Promise<Result<SubtitleSettings>>; save(settings): Promise<Result<SubtitleSettings>> }`
  - 接続先と `models.translate`、`models.asr` は、今までどおり extension-core の `settingsStore`（キー `settings`）に置く。
- `src/glossary.ts`:
  - `GLOSSARY_LIMITS = { entries: 50, chars: 32, streamers: 100 }`
  - `glossaryEntrySchema = z.strictObject({ source: z.string().check(z.minLength(1), z.maxLength(32)), target: z.string().check(z.maxLength(32)) })`
    - `target` が空なら、原文のまま（固有名詞を訳さない）。
  - `glossaryStore(area: StorageArea & { remove(keys: string[]): Promise<void> })`:
    - `load(streamer: string): Promise<Result<GlossaryEntry[]>>`
    - `save(streamer: string, entries: GlossaryEntry[]): Promise<Result<GlossaryEntry[]>>`
      - 前後の空白を除き、同じ原文は後のものを残す。
      - 51 件目や 33 文字目があれば `input_invalid`。
      - キーは `glossary:<streamer>`。
      - 索引のキー `glossary:index` に、保存した順で配信者を記録する（100 人まで）。101 人目を保存したら、いちばん古い配信者のキーを消す。
  - `toPromptGlossary(entries: readonly GlossaryEntry[]): GlossaryEntry[]`: 空の `target` を `source` に置き換える。
- `src/page-context.ts`:
  - `PAGE_LIMITS = { title: 200, author: 100, streamer: 128 }`
  - `pageInfoSchema = z.strictObject({ videoId: z.string().check(z.regex(/^[\w-]{11}$/u)), streamer: z.optional(…), title: z.optional(…), author: z.optional(…), live: z.boolean(), tracks: z.int().check(z.minimum(0), z.maximum(200)) })`
    - `streamer` は配信者のキー。player response の `videoDetails.channelId` を使う（Task 6 で確かめる）。
    - 長すぎる値は切り詰める。
  - `contextText(info: PageInfo): string`: `Title: …` と `Channel: …` の行。ないものは省く。
  - `contextHash(text: string): string`: comment-assistant の `stream-context.ts` と同じ 32 ビット FNV-1a を、8 桁の 16 進で返す。
  - `createTabPages(max = 16): { report(tabId: number, info: PageInfo): { changed: boolean }; get(tabId: number): PageInfo | undefined; forget(tabId: number): void }`
- `src/protocol.ts`:
  - `subtitleProtocolSpec`: `llmProtocolSpec` を含む。メッセージは、使うタスクがそれぞれ足す。
  - `addressed(target: Target, message: unknown)` と `isFor(target: Target, message: unknown): boolean`。宛先は `'background' | 'offscreen' | 'panel' | 'content'`。
- `src/runtime.ts`:
  - `senderKind(sender): 'page' | 'content' | 'offscreen' | 'other'`
    - `page`: この拡張のページ（comment-assistant の `fromExtensionPage` と同じ判定）。ただし offscreen は除く。
    - `offscreen`: URL が `runtime.getURL('/offscreen.html')`
    - `content`: `https://www.youtube.com/` のタブのトップフレーム（`frameId === 0`）
  - 送り手の種類ごとに経路の表を分ける。表にないメッセージには `sender_forbidden` を返す。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { from: 'ja', to: 'both' },
  { from: 'both', to: 'source' },
  { from: 'source', to: 'off' },
  { from: 'off', to: 'ja' },
])('nextDisplay($from)', ({ from, to }) => {
  /* ... */
});
it('loads the defaults and round-trips saved subtitle settings', async () => {
  /* fakeBrowser.storage.local。既定は { display: 'both', source: 'auto', sourceLang: 'auto', translator: 'gemma' }、translator: 'plamo' も往復する */
});
it('rejects an unknown source language with input_invalid', async () => {
  /* sourceLang 'xx' */
});
it.each([
  { name: '51 件', entries: 51, expected: 'input_invalid' },
  { name: '33 文字', sourceChars: 33, expected: 'input_invalid' },
  {
    name: '同じ原文は後を残す',
    entries: [e('Fixturo', ''), e('Fixturo', 'フィクスチューロ')],
    expected: [e('Fixturo', 'フィクスチューロ')],
  },
])('glossary save: $name', async (row) => {
  /* ... */
});
it('removes the oldest streamer key when the 101st streamer is saved', async () => {
  /* glossary:index の長さ 100、最古のキーが消える */
});
it.each([
  {
    info: { title: 'Fixture Quest day 3', author: 'Fixture Ch' },
    text: 'Title: Fixture Quest day 3\nChannel: Fixture Ch',
  },
  { info: {}, text: '' },
])('contextText', ({ info, text }) => {
  /* ... */
});
it('keeps page info for the 16 most recent tabs', () => {
  /* ... */
});
it.each([
  { sender: 'side panel', kind: 'page' },
  { sender: 'offscreen', kind: 'offscreen' },
  { sender: 'youtube top frame', kind: 'content' },
  { sender: 'youtube iframe', kind: 'other' },
  { sender: 'example.com tab', kind: 'other' },
])('senderKind: $sender', ({ sender, kind }) => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): settings, per-streamer glossary, page context and sender routing"`

### Task 6: 字幕トラックの読み取り（MAIN world）

背景（2026-11-05 時点。実サイトで確かめるまでは仮定として扱う）:

- YouTube の timedtext は、多くのクライアントで PO トークン（`pot`）を求める。プレイヤーの外から `baseUrl` を直接 fetch すると、空か拒否が返ると見込まれる。
- 字幕を読む拡張では、プレイヤー自身の timedtext の応答を読む方式が一般的。

結果（2026-11-06、`docs/adoption.md` の「YouTube caption tracks」）: 既定の方針のとおり。プレイヤーは CC がオンのときだけ、XHR で json3 を取得する（`pot` 付き）。`pot` のない直接の fetch は空の本文が返る。ライブには字幕トラックがない。インターフェースに、`cues` の `kind`、isolated 側の `ready`、ブリッジが持つ最後の `cues` を足した（下の「Step 0 の結果による追加」）。自動操作のブラウザでは、プレイヤー自身の応答も本文が空だったので、json3 の本文の形は Task 16 で確かめる。

**Files:**

- Create: `packages/subtitle-translator/src/captions/tracks.ts`
- Create: `packages/subtitle-translator/src/captions/messages.ts`（ブリッジのメッセージ、isolated 側の受け口）、`src/captions/bridge.ts`（MAIN world の本体）
- Create: `packages/subtitle-translator/src/entrypoints/player-bridge.content.ts`
  - `world: 'MAIN'`、`runAt: 'document_start'`、`matches: ['https://www.youtube.com/*']`
- Create: `packages/subtitle-translator/test/fixtures/player-response.json`、`timedtext.json3.json`（どちらも自作の値）
- Test: `test/unit/tracks.test.ts`、`test/unit/bridge.test.ts`
- Modify: `docs/adoption.md`（Step 0 の結果）

**Interfaces:**

- `CaptionTrack = Readonly<{ languageCode: string; kind: 'asr' | 'manual'; baseUrl: string; name: string; vssId: string }>`
- `listTracks(playerResponse: unknown): Result<CaptionTrack[]>`
  - `captions.playerCaptionsTracklistRenderer.captionTracks` を Zod で decode する。最大 200 本。
- `readVideo(playerResponse: unknown): Result<{ videoId: string; channelId?: string; author?: string; title?: string; live: boolean }>`
  - `videoDetails` から読む。`live` は `videoDetails.isLive === true`。
- `pickSourceTrack(tracks: readonly CaptionTrack[]): CaptionTrack | undefined`
  - 原語は、自動生成（`asr`）のトラックの言語とする。自動生成の字幕は、話されている言語で作られるため。
  - 優先順:
    1. 原語の manual
    2. 原語の asr
    3. 日本語の manual（原語が分からないとき）
    4. 先頭の manual
    5. 先頭の asr
  - 翻訳トラック（`tlang`）は使わない。
- `Cue = Readonly<{ startMs: number; endMs: number; text: string }>`
- `parseJson3(body: unknown): Result<Cue[]>`
  - `events[].segs[].utf8` を連結する。空の event と、`\n` だけの event は捨てる。
  - cue は 20,000 個まで。1 つの本文は 500 文字まで。
- MAIN world のブリッジ:
  - `fetch` と `XMLHttpRequest` を包む。読むのは、パスが `/api/timedtext` の応答だけ。
    - fetch は `response.clone()` を読む。XHR は `load` の後の `responseText` を読む。
    - 元の関数を保持して委譲するだけにし、ページの挙動は変えない。
  - 送るメッセージ（`window.postMessage(message, location.origin)`）:
    - `{ source: 'st-bridge', type: 'video', video, tracks }`: 読み込みのときと `yt-navigate-finish` のとき。`#movie_player.getPlayerResponse()` を読み直す。
    - `{ source: 'st-bridge', type: 'cues', videoId, languageCode, cues }`: プレイヤーが選んだトラックを取得したとき。1 本の動画につき 1 回。
  - isolated world からの `{ source: 'st-content', type: 'load-track', languageCode }` を受けたら、プレイヤーにそのトラックを取得させる（方式は Step 0 で決める）。
  - isolated world の側は、`event.source === window` と `source` を確かめ、すべてを Zod と上限で検証する。ページのスクリプトも同じメッセージを送れるので、中身はページのデータとして扱う（最悪でも字幕が間違うだけで、拡張の権限には届かない）。
- Step 0 の結果による追加:
  - `cues` に `kind: 'asr' | 'manual'` を足す。同じ言語に manual と asr があり、プレイヤーはどちらも取得しうるため。
  - 送るのは、1 回の訪問（`yt-navigate-start` から次の `yt-navigate-start` まで）の 1 つのトラックにつき 1 回。同じ動画に戻れば、また送る。訳（`tlang`）と、`fmt` が `json3` でない応答は読まない。fetch の本文は流れのまま読み、8,000,000 文字を超えたら読むのをやめる。CC がオンの視聴者では、プレイヤーが話されている言語でないトラックや訳を取得することがあり、SPA の遷移では同じ URL を 2 回取得することもあった。
  - isolated 側からの `{ source: 'st-content', type: 'ready' }` を足す。content script（`document_idle`）は、プレイヤーの最初の取得（読み込みから 1.3〜2.2 s）や最初の `yt-navigate-finish`（1.1〜2.8 s）より後に動き出しうるため。受けたブリッジは `video` と、持っている `cues` を送り直す。
  - ブリッジは最後に送った `cues` を 1 組だけ持つ。`load-track` がそのトラックなら、プレイヤーに取得させずに送り直す。
  - `load-track` の方式:
    - 今のトラック（`getOption('captions', 'track')`）と、localStorage の `yt-player-caption-sticky-language`・`yt-player-caption-persistence` を控える。
    - `#movie_player[data-st-loading]` で YouTube の字幕を隠し、`setOption('captions', 'track', { languageCode })` を呼ぶ（asr は `kind: 'asr'` を付ける）。プレイヤーは数 ms で取得する。
    - そのトラックの応答の後（来なければ `LOAD_TIMEOUT_MS` = 10,000 ms 後、または `yt-navigate-start`）に、CC がオンだったら元のトラックに、オフだったら `{}` に戻し、2 つのキーを元の値（なければ削除）に書き戻す。
    - `unloadModule('captions')` は戻す方法にならない（persistence が true のまま残り、次の動画で CC がオンになる）。
    - 視聴者が別のトラックで CC をオンにしていたときは、元のトラックに戻すとプレイヤーがそれをもう一度取得する（その動画で 1 回。判断 S41 で許容）。原語のトラックがすでにオンなら、追加の取得なしに使う。
    - プレイヤーに取得させるのは、1 回の訪問の 1 つのトラックにつき 1 回だけ（結果を問わない）。繰り返しの `load-track` には、持っている `cues` を送り直すか、何もしない。
    - 控えた persistence が true なのに、まだトラックがオンでないとき（読み込みの直後）は、プレイヤーを動かさずに、プレイヤー自身の取得を最長 `LOAD_TIMEOUT_MS` 待つ。その間に来た応答は普通に送る。待っても来なければ、いつもどおりプレイヤーに取得させる。
  - isolated 側の受け口は `readBridgeMessage(event, window)`、送り口は `postToPage(window, message)`（`src/captions/messages.ts`）。Task 9 の content script は、受け始めたら `ready` を送る。

- [ ] **Step 0: スパイク（使い捨て。実サイトで確かめる）**
  - headed の Chromium で、ログインせずに確かめる。chrome-devtools MCP の `evaluate_script` を使ってよい。
  - 対象は 3 本: 英語の manual 字幕があるアーカイブ、自動生成の字幕だけのアーカイブ（ES、KO、ID のどれか）、ライブ配信。
  - 確かめること:
    - (a) player response の形。`ytInitialPlayerResponse` と `#movie_player.getPlayerResponse()` の両方で、SPA の遷移の後も見る。
      - `captionTracks[]` の `baseUrl`、`languageCode`、`kind`、`vssId`、`name`
      - `videoDetails` の `videoId`、`channelId`、`author`、`title`、`isLive`
    - (b) プレイヤー自身の timedtext の取得。
      - 字幕（CC）をオンにしたときに取得するか。オフのままでも取得するか。
      - fetch か XHR か。
      - URL の引数（`fmt`、`pot`、`lang`、`kind`）。
      - 応答が json3（`events`、`segs`）か。
    - (c) プレイヤーの API で CC をオンにしたとき（`setOption('captions', 'track', { languageCode })`）:
      - プレイヤーがトラックを取得するか。
      - 視聴者の CC の設定（次の動画でも CC がオンになるか）が変わるか。
      - 元に戻す方法（`unloadModule('captions')` など）。
    - (d) `baseUrl + '&fmt=json3'` を直接 fetch したときの状態と本文の長さ。PO トークンなしで取れるか。
    - (e) ライブ配信に、使える字幕トラックがあるか。
  - 結果を `docs/adoption.md` に記録する。動画の ID や配信者の名前は書かない。
  - 既定の方針:
    - (b) のプレイヤー自身の応答を読む方式と、(c) のプレイヤーに取得させる方式を組み合わせる。
    - (c) で CC を付けた場合は、YouTube の字幕を CSS で隠し、視聴者の CC の設定を元に戻す。
    - (d) の直接の fetch は使わない。PO トークンがなければ取れず、プラットフォームへの余計なリクエストになるため。
    - ライブは音声の経路だけにする。
  - 結果が既定の方針と違えば、Step 3 の前に、この計画の Task 6・Task 7 を直してコントローラーに知らせる。
- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  {
    name: '原語の manual を優先',
    tracks: [asr('en'), manual('en'), manual('ja')],
    expected: 'manual:en',
  },
  { name: '原語は asr だけ', tracks: [asr('id'), manual('ja')], expected: 'asr:id' },
  {
    name: '原語が分からなければ日本語の manual',
    tracks: [manual('ko'), manual('ja')],
    expected: 'manual:ja',
  },
  { name: '先頭の manual', tracks: [manual('ko'), manual('es')], expected: 'manual:ko' },
  { name: 'トラックなし', tracks: [], expected: undefined },
])('pickSourceTrack: $name', ({ tracks, expected }) => {
  /* `${kind}:${languageCode}` */
});
it('parses json3 events into trimmed cues and drops empty ones', () => {
  /* fixture → 件数と最初の cue */
});
it('caps cues at 20,000 and a cue text at 500 characters', () => {
  /* ... */
});
it('reads videoId, channelId, title and live from videoDetails', () => {
  /* ... */
});
it('rejects a malformed player response with input_invalid', () => {
  /* listTracks({}) */
});
// bridge.test.ts（jsdom）
it('passes timedtext responses through unchanged and posts their cues once', async () => {
  /* ページが受け取る本文は元のまま。postMessage は 1 回 */
});
it('ignores responses that are not /api/timedtext', async () => {
  /* ... */
});
it('drops bridge messages that fail validation on the isolated side', () => {
  /* cues が 20,001 個 → 捨てる */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): read caption tracks and cues from the player"`

### Task 7: 文への区切りと、字幕トラックの先読み翻訳

背景: service worker は、イベントのない状態が 30 秒続くと止まる。先読みの状態（動画の文、どこまで訳したか）を background に置くと、60 秒先まで訳し終えて待っている間に消えてしまう。そこで、文と訳は content script が持ち、先読みも content script が進める。background は状態を持たない翻訳係にする（判断）。

**Files:**

- Create: `packages/subtitle-translator/src/captions/sentences.ts`、`src/captions/feeder.ts`（content script の側）
- Create: `packages/subtitle-translator/src/translate.ts`（background の側）
- Modify: `src/protocol.ts`（`subs/translate`、`subs/page`）、`src/runtime.ts`
- Test: `test/unit/sentences.test.ts`、`test/unit/feeder.test.ts`、`test/unit/translate.test.ts`、`test/unit/runtime.test.ts`

**Interfaces:**

- Consumes: Task 2 の `subtitlePrompt`・`subtitleMaxTokens`・`parseSubtitleLine`、Task 5 の設定・用語集・`createTabPages`・`contextText`、Task 6 の `Cue`
- Produces:
  - `Sentence = Readonly<{ id: string; startMs: number; endMs: number; source: string }>`
  - `toSentences(cues: readonly Cue[], languageCode?: string): Sentence[]`
    - 区切る位置: 文末の記号（`.?!。？！`）、次の cue との間が 700 ms 以上、1 文が 6,000 ms または 200 文字に達した。
    - `id` は `` `${startMs}:${contextHash(source)}` ``。
    - cue は前後の空白を除いてつなぐ。間は空白 1 つ。ただし、つなぎ目の前か後ろが漢字、かな、CJK の約物、全角の記号なら空けない（中国語と日本語）。つなぎ目のどちらかがハングルのとき、または `languageCode` が `ko` のときは空ける（判断。実装の後の修正）。
  - `TranslatedLine = Readonly<{ id: string; startMs: number; endMs: number; source: string; ja?: string; state: 'pending' | 'done' | 'failed' }>`
  - `'subs/translate'`（content から）:
    - request: `{ videoId: string; sourceLang: string; previous: string[] /* ≤ 3 */; sentences: { id: string; source: string }[] /* 1〜4 件、各 ≤ 200 文字 */ }`
    - response: `{ lines: { id: string; ja?: string; state: 'done' | 'failed' }[] }`
    - 配信の文脈と用語集は、送り手のタブの `subs/page` から background が引く。content script は送らない。
  - `'subs/page'`（content から）: `{ info: PageInfo }` → `{}`。読み込みのときと SPA の遷移のたびに送る。
    - background は、メモリと `storage.session`（`tabPagesStore`、16 タブの LRU）に覚える。service worker が止まって起動し直しても、次の batch は同じ文脈と用語集で訳す。タブを閉じたら（`tabs.onRemoved`）忘れる。`tabs.onUpdated` は聞かない（ホストの権限がなければ URL が来ず、すべてのサイトのタブの更新で service worker を起こすだけになる。判断 S43）。
  - `createSubtitleTranslator(deps: { client: LlamaClient; settings: () => Promise<Result<Settings>>; glossary: (streamer: string) => Promise<Result<GlossaryEntry[]>>; cache?: LruCache<string, string> }): { translate(this: void, request: TranslateRequest, page: PageInfo | undefined): Promise<Result<TranslateResponse>> }`
    - 文ごとに 1 回、順番に呼ぶ（1 文の呼び出しは、Task 8 で `src/line-translator.ts` に移し、PLaMo も選べるようにする）。設定は次のとおり。
      - 枠 0、`model: settings.models.translate`、`subtitlePrompt`
      - 直前の 3 文を文脈にする（request の `previous` と、同じ batch の前の文）
      - `maxTokens: subtitleMaxTokens(source)`、`temperature: 0`、`enable_thinking: false`
    - キャッシュは LRU 2,000 件。キーは `` `${sourceLang}\u0000${contextHash(context)}\u0000${contextHash(JSON.stringify(glossary))}\u0000${source}` ``。
    - `sourceLang` が `ja` なら呼ばずに `ja = source` を返す（content script はそもそも送らない）。
    - 1 文が `network_failed` か `operation_cancelled` になったら、同じ batch の残りはサーバーに送らずに `failed` にする（キャッシュにある文は答える）。止まったサーバーに 1 文ずつ 15 s 待たないため。
    - background の `LlamaClient` は、`timeoutMs: 15_000`、キューは `concurrency: 1, maxPending: 4`。先読みは急がないので、ルーターがモデルを読み込み直す時間（実測で最大 13 s）を待てる長さにする。
  - `createCaptionFeeder(deps: { videoId: string; sentences: readonly Sentence[]; sourceLang: string; display: () => DisplayMode; request: (batch: TranslateRequest) => Promise<Result<TranslateResponse>>; onLines: (lines: TranslatedLine[]) => void; timers: Timers }): { position(this: void, ms: number): void; front(this: void, on: boolean): void; dispose(this: void): void }`
    - `videoId` は `subs/translate` の request に入れる動画。
    - 先読みの範囲は、再生位置の 2,000 ms 前から 60,000 ms 先まで。
    - 範囲の中で、まだ訳していない文を、時刻の順に 4 文ずつ送る。送るのは同時に 1 つだけで、応答が来たら次を送る。1 つの batch は続いた文だけにする（間に訳した文があれば、そこで切る）。background が文ごとの直前の 3 文を正しく組めるようにするため。
    - `front` の既定は `true`。`front(false)` の間は送らない。実行中の batch の応答は使う。`front(true)` で続きを送る。呼ぶのは content script（Task 9、Task 10）。
    - `onLines` は、表示のための行を出す。範囲に入った文を 1 度ずつ `pending`（原語だけ）で出し、訳が来たら `done`、2 回失敗したら `failed` で出す。日本語のトラックの文は `ja = source` の `done` で出す。表示が `off` の間は何も出さず、戻ったら範囲を丸ごと出し直す。シークの後も範囲を丸ごと出し直す。
    - 位置が予想から 2,000 ms 以上飛んだらシークとみなし、次の batch を新しい位置から始める。実行中の batch の応答は、前後 10 分の範囲にあれば使う。
    - 次のときは送らない: 前面でない（`front(false)`）、表示が `off` か `source`、字幕トラックが日本語。
    - 失敗した文は、5,000 ms 後に 1 回だけやり直す。それでも失敗したら `failed` にする（原語のまま表示する）。
    - 訳は、再生位置の前後 10 分の分だけ持つ（batch のたびに捨てる）。文の配列は動画ごとに丸ごと持つ（cue の上限で 20,000 個まで）。

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
    name: '6 秒で区切る',
    cues: Array.from({ length: 8 }, (_, i) => c(i * 1000, i * 1000 + 1000, 'word')),
    sentences: ['word word word word word word', 'word word'],
  },
])('toSentences: $name', ({ cues, sentences }) => {
  /* source の配列 */
});
it('asks for the next untranslated sentences in time order, four at a time, one request at a time', async () => {
  /* fake timers と、遅れて答える request */
});
it('starts again from the new position after a seek', async () => {
  /* position(120_000) の後、0〜60s の未着手の文は送られない */
});
it.each([
  { name: '前面でない', front: false, display: 'both', lang: 'en' },
  { name: '表示オフ', front: true, display: 'off', lang: 'en' },
  { name: '原語のみ', front: true, display: 'source', lang: 'en' },
  { name: '日本語の字幕', front: true, display: 'both', lang: 'ja' },
])('sends nothing: $name', async (row) => {
  /* request 0 回 */
});
it('retries a failed sentence once after 5 s, then marks it failed', async () => {
  /* ... */
});
it('prunes translations farther than 10 minutes from the position', async () => {
  /* ... */
});
// translate.test.ts
it('translates each sentence on slot 0 with the translate model and the three sentences before it', async () => {
  /* id_slot 0、model 'gemma4-e4b'、Previous lines */
});
it('serves repeated sentences from the cache, keyed by language, context and glossary', async () => {
  /* 同じ文を 2 回 → chat 1 回。用語集を変えると 2 回目も呼ぶ */
});
// runtime.test.ts
it('answers subs/translate only for a YouTube top frame and uses that tab page context', async () => {
  /* 別のサイトのタブからは sender_forbidden */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): prefetch caption translations driven by the page"`

### Task 8: PLaMo 3 Translate 2B を字幕の翻訳に選べるようにする（任意）

背景（2026-11-06 の評価。`docs/llama-server.md` の「PLaMo 3 Translate」）:

- PLaMo 3 Translate 2B（Preferred Networks）は翻訳専用のモデル。字幕の 1 文の p50 は 121 ms（gemma4-e4b は 329 ms）、コメント 2 本の負荷の下で 179 ms（854 ms）。常駐メモリは 2.47 GB。品質は英語、中国語、インドネシア語で Gemma とほぼ同じで、韓国語とスペイン語のゲームのスラングで劣る。コメントは Gemma のまま（PLaMo は分類ができない）。
- 要求の形（user 1 通、`chat_template_kwargs`、止める文字列、言語コード、上限）、`model_refused`、スタブの `withPlamo` は、Task 0 で extension-core に入っている。この Task は、字幕の側の使い方だけを足す（判断 S24）。
- PLaMo Community License: 出力を他人に渡すときは「Built with PLaMo」の表示が要る。リポジトリには PLaMo の出力を入れない（Global Constraints）。

**Files:**

- Create: `packages/subtitle-translator/src/line-translator.ts`、`test/unit/line-translator.test.ts`
- Modify: `packages/subtitle-translator/src/translate.ts`、`src/runtime.ts`、`test/unit/translate.test.ts`
- Modify: `docs/llama-server.md`（「PLaMo 3 Translate」の節の最初の段落と、§6 の表の下）

**Interfaces:**

- Consumes:
  - Task 0 の `plamoTranslateRequest`、`parsePlamoLine`、`plamoLanguage`、`PLAMO_TRANSLATE_MODEL`、`ChatRequest.tellRefusal`（`model_refused`）
  - Task 2 の `subtitlePrompt`、`subtitleMaxTokens`、`parseSubtitleLine`、`subtitleLimit`
  - Task 5 の `SubtitleSettings`（`translator`）、`SubtitleTranslator`、`subtitleSettingsStore`、`toPromptGlossary`
  - Task 7 の `createSubtitleTranslator`（1 文の呼び出しをここに移す）
- Produces（subtitle-translator の `src/line-translator.ts`）:
  - `LineInput = Readonly<{ source: string; sourceLang: string; previous: readonly string[]; context: string; glossary: readonly GlossaryEntry[]; signal?: AbortSignal }>`
    - Task 12 のライブの処理の `translate` が受け取る形と同じ。`glossary` は `toPromptGlossary` を通したもの。
  - `FallbackReason = 'not_listed' | 'refused' | 'language'`
  - `TranslatorStatus = Readonly<{ chosen: SubtitleTranslator; fallback?: Readonly<{ latest: FallbackReason; lines: Readonly<Record<FallbackReason, number>> }> }>`
    - `fallback` は、PLaMo を選んでいる間に Gemma で訳した行があるときだけ付く。`latest` は直近の理由、`lines` は理由ごとの、Gemma で訳せた行の数（判断 S44。理由の違う行を 1 つの数にまとめない）。どちらも、インスタンスを作ったときと `chosen` が変わったときに消す。
  - `createLineTranslator(deps: { client: LlamaClient; config: () => Readonly<{ translator: SubtitleTranslator; model: string }> }): LineTranslator`
    - `config().model` は extension-core の設定の `models.translate`。
  - `LineTranslator = { translate(this: void, input: LineInput): Promise<Result<Readonly<{ ja: string; by: SubtitleTranslator }>>>; status(this: void): TranslatorStatus }`
  - Gemma の 1 行（Task 7 が `translate.ts` に書いた呼び出しを、そのまま移す）:
    - `subtitlePrompt({ source, sourceLang, previous, context, glossary })`、`model: config().model`、`slot: 0`、`temperature: 0`、`cachePrompt: true`、`maxTokens: subtitleMaxTokens(source)`、`templateKwargs: { enable_thinking: false }`、`signal`
    - `parseSubtitleLine(reply, maxTokens, source)` で読む。
  - PLaMo を選んでいるときの 1 行（判断 S16）:
    1. `plamoLanguage(sourceLang)` が `unsupported` → Gemma で訳す（理由 `language`。判断 S15）。
    2. PLaMo が載っているかを `client.models()` で確かめる。
       - 聞くのは、インスタンスを作ってから、または `translator` が `plamo` に変わってから、最初の PLaMo の行の前に 1 回だけ。答えは持ち続ける。タイマーで聞き直さない。
       - `models()` が失敗したら答えを持たず、PLaMo に送る。次の行の前にまた聞く。
       - 一覧に `PLAMO_TRANSLATE_MODEL` がない → Gemma（`not_listed`）。
    3. `plamoTranslateRequest({ line: source, sourceLang, previous, glossary, slot: 0 })`（`maxTokensCap` は渡さない。256 まで）が `input_invalid` → Gemma（`refused`）。
    4. `client.chat({ ...request, signal })` が `model_refused` → Gemma（`refused`）。次の行は、また PLaMo に送る。
    5. それ以外の失敗（`network_failed`、`operation_cancelled`、`response_invalid`、`queue_full`）は、そのまま返す。Gemma には送らない（サーバーに届かないなら Gemma にも届かず、時間切れの後に送り直すと遅れが倍になる）。
    6. 成功 → `parsePlamoLine(reply, request.maxTokens, source)`。読めなければ `response_invalid` を返す（Gemma には送らない）。
  - 日本語（`sourceLang` が `ja`）の行は、呼ぶ側が送らない（Task 7、Task 12）。
  - ライブの処理（Task 12）の待ちは、PLaMo で訳すときも 1 本の列のままにする（判断 S17）。
- `createSubtitleTranslator`（Task 7）を直す:
  - deps に `subtitles: () => Promise<Result<SubtitleSettings>>` を足す。1 文ずつ `createLineTranslator` で訳す（`config` は直近に読んだ `subtitles.translator` と `models.translate`）。
  - キャッシュのキーの先頭に、訳したモデル（`by`）と `\u0000` を足す。引くときは、選んでいる `translator` のキーで引く。Gemma に切り替えた行は `gemma` のキーで入る（判断 S20）。
    - キャッシュの値は `CaptionCacheEntry = Readonly<{ ja: string; chosen: SubtitleTranslator }>`（`chosen` は訳したときに選んでいた翻訳）。
    - `plamo` のキーで見つからないときは `gemma` のキーも引き、`chosen` が `plamo` の値（PLaMo を選んでいる間に Gemma に切り替えた行）なら、それを使う。同じ行を繰り返すたびに PLaMo と Gemma に送り直さないため。Gemma を選んでいる間に訳した行は、PLaMo には出さない。
  - `status(this: void): TranslatorStatus` を足す。Task 14 のサイドパネルが `subs/tab-state` で読む。
  - `src/runtime.ts` は、background の `createSubtitleTranslator` に `subtitleSettingsStore(storage.local).load` を渡す。
- `docs/llama-server.md`:
  - 「PLaMo 3 Translate」の節の最初の 2 文（"The extensions do not send requests to PLaMo yet. The subtitle extension's plan adds it as an optional translator."）だけを直す。字幕の拡張のサイドパネルで選べること（既定は Gemma）、ルーターに載っていないときと HTTP のエラーのときは、その行を Gemma で訳してパネルに出すこと、選んでいる間は「Built with PLaMo」とライセンスへのリンクを出すこと。③ page-translator は、この段落の後ろに自分の段落を足す（判断 S32）。
  - §6 の表のすぐ下に 1 行足す: 字幕の拡張は、自分の設定（キー `subtitles`）の `translator`（`gemma` か `plamo`、既定 `gemma`）で訳すモデルを選ぶ。`plamo` はプリセットの節の名前 `plamo-3-translate-2b` に送る。

- [ ] **Step 1: 失敗するテストを書く**

すべて自作の文字列にする。PLaMo の実際の出力は使わない。

```ts
// line-translator.test.ts（createLlamaClient と偽の fetch）
it('translates with Gemma on slot 0 when Gemma is chosen', async () => {
  /* model 'gemma4-e4b'、grammar あり、id_slot 0。by 'gemma'。/v1/models は聞かない */
});
it('translates with PLaMo when it is chosen and listed', async () => {
  /* model 'plamo-3-translate-2b'、messages は user 1 つ、id_slot 0、max_tokens は plamoMaxTokens(source)。by 'plamo'。status は { chosen: 'plamo' } */
});
it.each([
  { name: 'ルーターに載っていない', models: ['gemma4-e4b'], reason: 'not_listed' },
  { name: 'HTTP 404', plamoStatus: 404, reason: 'refused' },
  { name: 'HTTP 503', plamoStatus: 503, reason: 'refused' },
  { name: '予約トークンを含む行', source: 'gg <|plamo:tag|> ez', reason: 'refused' },
  { name: '対応していない言語', sourceLang: 'pt', reason: 'language' },
])('falls back to Gemma for the line: $name', async (row) => {
  /* by 'gemma'、Gemma へのチャット 1 回、status.fallback は { latest: reason, lines: { [reason]: 1、ほかは 0 } } */
});
it('tries PLaMo again on the next line after a refusal', async () => {
  /* 1 行目 503 → Gemma、2 行目 200 → by 'plamo' */
});
it('asks the model list once, and again after the translator changes back to PLaMo', async () => {
  /* 2 行で GET /v1/models 1 回。plamo → gemma → plamo で 2 回目。chosen が変わると fallback が消える */
});
it.each([
  { name: '接続できない', failure: 'unreachable', code: 'network_failed' },
  { name: 'max_tokens で切れた', failure: 'cut', code: 'response_invalid' },
])('does not fall back to Gemma on $name', async ({ failure, code }) => {
  /* Err(code)、Gemma へのチャット 0 回 */
});
// translate.test.ts
it('keys the cache by the translator that produced the line', async () => {
  /* gemma で訳した文を、plamo に切り替えてもう一度 → チャット 2 回。gemma に戻す → キャッシュから */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - 文書の例も自作の文字列にする。PLaMo の出力を貼らない。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): optional PLaMo 3 Translate 2B translator with a Gemma fallback"`

### Task 9: 字幕の描画と再生位置の同期

**Files:**

- Create: `packages/subtitle-translator/src/overlay/overlay.ts`、`src/overlay/timeline.ts`、`src/overlay/live-view.ts`、`src/overlay/source.ts`
- Create: `packages/subtitle-translator/src/entrypoints/youtube.content.ts`
  - `matches: ['https://www.youtube.com/*']`、トップフレームだけ、`runAt: 'document_idle'`
- Modify: `src/protocol.ts`（`liveLineSchema`。`subs/lines` は Task 13 で足す）
- Test: `test/unit/timeline.test.ts`、`test/unit/live-view.test.ts`、`test/unit/overlay.test.ts`、`test/unit/source.test.ts`

**Interfaces:**

- Consumes: Task 6（ブリッジのメッセージ）、Task 7（`toSentences`、`createCaptionFeeder`、`TranslatedLine`）
- Produces:
  - `createTimeline(options: { keepMs: 600_000 }): { upsert(lines: readonly TranslatedLine[]): void; at(positionMs: number): TranslatedLine | undefined; prune(positionMs: number): void; reset(): void; size(): number }`
    - 時刻の順に並べた配列を二分探索する。
  - `LiveLine = Readonly<{ sentenceId: string; lang: string; source: string; ja?: string; state: 'pending' | 'done' | 'skipped' | 'failed'; endedAt: number; final: boolean }>`（`liveLineSchema`。Task 12 と Task 13 が使う）
    - `endedAt` は、その文の最後の区切りの発話の終わり（`performance.timeOrigin + performance.now()` の ms）。
    - `source` は 200 文字まで、`ja` は `subtitleLimit(source)` 文字まで。
  - `createLiveView(options: { holdMs: 6_000; timers: Timers; onChange: () => void }): { upsert(line: LiveLine): void; current(): LiveLine | undefined; reset(): void }`
    - 新しい文を出す。同じ `sentenceId` は置き換える。
    - 更新が 6,000 ms ないと消す。タイマーは 1 つだけで、更新のたびにかけ直す。
  - `mountOverlay(player: HTMLElement, options?: { mode?: ShadowRootMode }): OverlayHandle`
    - 既定は `mode: 'closed'`。テストのときだけ `'open'` を渡す。
  - `OverlayHandle`:
    - `render(view: OverlayView): void`
    - `status(pill: PillState): void`
    - `unmount(): void`
  - `OverlayView = Readonly<{ display: DisplayMode; source?: string; ja?: string; lang?: string; jaDim?: boolean }>`
    - `ja`: 日本語の段だけ。音声や字幕トラックが日本語なら、`source` を日本語の段に出す。
    - `both`: 上に原語（小）、下に日本語（大）。日本語の音声や字幕は 1 段。
    - `source`: 原語の段だけ。
    - `off`: 何も出さない（ルートを隠す）。
    - 音声の経路で、まだ訳の来ていない文は、日本語の段に前の文の訳を薄く（`jaDim`）出す。3,000 ms までで、それを過ぎたら空にする。
  - `PillState = Readonly<{ source: 'captions' | 'audio' | 'none'; state: 'active' | 'pause' | 'away' | 'stopped' | 'error'; display: DisplayMode; message?: string; latencyMs?: number }>`
    - ピルは、オーバーレイの右上の小さな表示。この Task では押せない表示として描き、Task 10 で表示を切り替える `<button>` にする（判断 S6）。Global Constraints の「プレイヤーのボタン」は、このピルのこと。
  - `src/overlay/source.ts`:
    - `pickSource(input: Readonly<{ setting: 'auto' | 'captions' | 'audio'; tracks: number; live: boolean; capturing: boolean }>): 'captions' | 'audio' | 'none'`
      - `capturing` なら `audio`。
      - `setting` が `audio` なら `none`（字幕トラックがあっても使わない）。
      - それ以外は、`tracks > 0` でライブでなければ `captions`、そうでなければ `none`。
    - `NO_SOURCE_MESSAGE = '字幕なし・Alt+Shift+S で音声字幕'`（`none` で、`setting` が `audio` でないとき）
    - `AUDIO_HINT_MESSAGE = 'Alt+Shift+S で音声字幕'`（`none` で、`setting` が `audio` のとき）
  - 描画の方針:
    - Shadow DOM の中にスタイルを閉じ込める。文字の大きさはプレイヤーの高さに合わせる。原語は `max(14px, 3.2cqh)`、日本語は `max(18px, 4.6cqh)`。
    - 同じ表示が続くときは DOM を書き換えない。
    - 文字は `textContent` だけで書く（`innerHTML` を使わない）。
    - 音声の経路では、表示した時点の「区切りの終わりからの経過」をルートの `data-st-latency` に書く（ms。時計は `performance.timeOrigin + performance.now()`）。E2E と実機の確認で読む。
    - 字幕を出している間は、YouTube 自身の字幕を隠す。ページにスタイルを 1 つだけ入れる: `#movie_player[data-st-on] .ytp-caption-window-container { display: none }`
  - 同期（字幕トラックの経路）:
    - 再生中で前面にある間だけ、`video.requestVideoFrameCallback` で `mediaTime` を読む。`timeline.at` で引いて描き、`feeder.position` に渡す。
    - 一時停止、終了、広告の間は止める。
  - `youtube.content.ts`:
    - `/watch` と `/live/` で、`#movie_player video` があるときだけ動く。`yt-navigate-finish` のたびに判定し直す。
    - ブリッジのメッセージは `readBridgeMessage` で読む。受け始めたら `ready` を送り、`video` の `tracks` から `pickSourceTrack` で選んだトラックの `cues` がなければ `load-track` を送る（Task 6）。
    - ブリッジの `cues` メッセージ（選んだトラックのもの）を受けたら、その `videoId`、`languageCode`、`cues` から feeder を作る:
      - `sentences: toSentences(message.cues, message.languageCode)`
      - `videoId: message.videoId`、`sourceLang: message.languageCode`
      - `request` は `subtitleProtocol.send(…, 'subs/translate', batch)`、`onLines` は `timeline.upsert`
    - timeline に入れるのは feeder の `onLines` だけ。feeder は、まだ訳していない文（`pending`）も日本語のトラックの文も自分で出すので、content script は文を timeline に入れない。
    - feeder を作ったときと、同期を止めたり再開したりするたび（一時停止、終了、広告、再生）に `feeder.front(同期しているか)` を呼ぶ。呼ばないと、一時停止の後も 60 s 先まで batch が続く（R44）。
      - Task 10 で `watchFront` の状態（`state === 'active'`）に置き換えた。`syncFrames` は `onRunning` を持たず、描くだけになった（ミュートの間も描くが、訳は送らない）。
    - 遷移したら、timeline、live view、feeder を作り直し、`subs/page` を送る。
    - `pickSource` が `none` のときは、ピルに `NO_SOURCE_MESSAGE`（または `AUDIO_HINT_MESSAGE`）を出し、feeder を作らない。翻訳の依頼は何も送らない（`subs/page` は送る）。
    - 後片付けは、すべて `ctx.onInvalidated` に登録する。

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
  { display: 'both', lang: 'en', rows: ['Okay chat', 'よしチャット'] },
  { display: 'ja', lang: 'en', rows: ['よしチャット'] },
  { display: 'source', lang: 'en', rows: ['Okay chat'] },
  { display: 'off', lang: 'en', rows: [] },
  { display: 'both', lang: 'ja', rows: ['よし行くぞ'] },
  { display: 'ja', lang: 'ja', rows: ['よし行くぞ'] },
])('overlay renders $display for $lang', ({ display, lang, rows }) => {
  /* jsdom + open shadow */
});
it('skips DOM writes when the same view is rendered twice', () => {
  /* MutationObserver の記録が 0 件 */
});
it('writes text, not markup', () => {
  /* '<img src=x>' がそのまま文字として出る */
});
it('replaces a live line with the same sentence id and clears it after 6 s', () => {
  /* fake timers */
});
it('dims the previous translation for at most 3 s while the new one is pending', () => {
  /* ... */
});
// source.test.ts
it.each([
  {
    name: '字幕トラックのあるアーカイブ',
    setting: 'auto',
    tracks: 2,
    live: false,
    capturing: false,
    expected: 'captions',
  },
  {
    name: '字幕トラックなし',
    setting: 'auto',
    tracks: 0,
    live: false,
    capturing: false,
    expected: 'none',
  },
  { name: 'ライブ', setting: 'auto', tracks: 1, live: true, capturing: false, expected: 'none' },
  {
    name: '取得元が音声',
    setting: 'audio',
    tracks: 2,
    live: false,
    capturing: false,
    expected: 'none',
  },
  {
    name: '音声を取得中',
    setting: 'auto',
    tracks: 2,
    live: false,
    capturing: true,
    expected: 'audio',
  },
])('pickSource: $name', ({ expected, ...input }) => {
  /* ... */
});
// overlay.test.ts
it('writes the pill message as text', () => {
  /* status({ source: 'none', state: 'stopped', display: 'both', message: NO_SOURCE_MESSAGE }) → ピルの textContent に '字幕なし・Alt+Shift+S で音声字幕' */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `wxt.config.ts` には何も足さない。content scripts は WXT がエントリから manifest に書く。
  - feeder は `cues` メッセージから作り（`toSentences(cues, languageCode)`、`videoId`）、作ったときと同期を止めたり再開したりするたびに `feeder.front(…)` を呼ぶ（Task 10 で `watchFront` の状態に置き換えた）。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): shadow-DOM subtitles synced to video frames"`

### Task 10: 前面の判定と表示の切り替え（R44、プレイヤーのボタン、ショートカット）

**Files:**

- Create: `packages/subtitle-translator/src/front.ts`、`src/tab-fronts.ts`、`src/tab-session.ts`
- Modify: `src/overlay/overlay.ts`（切り替えボタン）、`src/overlay/frames.ts`（`onRunning` を外す）、`src/watch-page.ts`（`youtube.content.ts` はこれを呼ぶだけ）
- Modify: `src/protocol.ts`（`subs/front`、`subs/display`）、`src/runtime.ts`（コマンドもここで登録する。`background.ts` は変えない）、`src/settings.ts`（`watchSubtitleSettings`）、`src/page-context.ts`（`tabSessionStore` を使う）
- Modify: `wxt.config.ts`（`commands`）、`docs/adoption.md`（`commands`、`:host-context()`）
- Test: `test/unit/front.test.ts`、`test/unit/tab-fronts.test.ts`、`test/unit/overlay.test.ts`、`test/unit/runtime.test.ts`、`test/unit/watch-page.test.ts`、`test/unit/settings.test.ts`、`test/unit/frames.test.ts`

**Interfaces:**

- `FrontState = Readonly<{ state: 'active' | 'pause' | 'away'; reason?: 'paused' | 'muted' | 'hidden' | 'offscreen' | 'ad' | 'display-off' }>`
- `watchFront(deps: { doc: Document; player: HTMLElement; video: HTMLVideoElement; display: () => DisplayMode; onChange: (state: FrontState) => void }): { displayChanged(this: void): void; stop(this: void): void }`
  - away になる条件（どれか 1 つ）:
    - `visibilityState === 'hidden'`
    - `pagehide`
    - プレイヤーが画面に出ていない（`IntersectionObserver`。面積が 0 の交差は出ていない扱い）
    - `#movie_player.ad-showing`（プレイヤーの `class` だけを見る MutationObserver）
    - 表示が `off`
  - pause になる条件: 動画が一時停止か終了、またはミュート（`muted` か `volume === 0`。`volumechange` で見る）。
  - どちらでもなければ active。`waiting`（バッファ中）は見ない。
  - 優先順位は away > pause > active。away の理由は hidden > offscreen > ad > display-off、pause は paused > muted の順に見る。`pagehide` の理由は `hidden`（`pageshow` で戻る）。プレイヤーは、`IntersectionObserver` が最初に知らせるまで画面に出ている扱い。
  - `onChange` は、始めたときの状態で 1 度呼び、あとは状態か理由が変わったときだけ呼ぶ。タイマーは使わない。
- content script は、`subs/front` `{ state, reason? }` を始めたとき（設定を読んで `ready` を送るとき）と変わるたびに送る。視聴ページを離れたとき（SPA の遷移）は、最後に送った状態が away でなければ `{ state: 'away', reason: 'offscreen' }` を送る。
- background は、タブごとの `FrontState` を `src/tab-fronts.ts` の `tabFronts(area)` に覚える。
  - `TabFronts = { report(tabId, front): Promise<Result<void>>; get(tabId): Promise<Result<FrontState>>; forget(tabId): Promise<Result<void>>; onFront(listener: (tabId, front) => void): () => void }`
  - メモリと `storage.session`（`subs:fronts`）に、16 タブ分。service worker が起動し直しても読める。タブを閉じたら忘れる。
  - 報告のないタブ（忘れたタブを含む）は `UNKNOWN_FRONT`（`{ state: 'away' }`）。
  - `onFront` は、メモリにある値と違う報告のたびに、報告の順に呼ぶ。起動し直した後の最初の報告は変化として扱う。Task 13 の取得はこれを購読する。
  - 保存の作りは `src/tab-session.ts` の `tabSessionStore({ area, key, schema, max })`（`{ tabId, value }` の一覧を 1 つ。1 度に 1 操作。読めない一覧は空の扱い）。Task 7 の `tabPagesStore`（`subs:pages`）も同じものを使う。
- content script は、feeder を作ったときと `FrontState` が変わるたびに `feeder.front(state === 'active')` を呼ぶ（Task 9 の、同期しているかで呼ぶ形を置き換える）。pause と away では送らず、実行中の batch の応答だけを使う。
- 切り替えボタン:
  - Task 9 のピル（オーバーレイの右上）を `<button>` にする。
  - 表示は `字幕: 併記` など。ピルに `message` があるときは、その後ろに続けて出す。`aria-label` は「字幕の表示を切り替え（今は併記）」。
  - 押すと `subs/display` `{ mode: nextDisplay(今のモード) }` を送る。`mountOverlay(player, { mode?, now?, onDisplay? })` の `onDisplay(次のモード)` が呼ばれ、content script が送る。表示は、background が保存して `storage.onChanged` が届いたときに変わる（押したタブも、ほかのタブと同じ経路）。
  - プレイヤーの操作バーが出ている間（`:host-context(#movie_player:not(.ytp-autohide))`）と、フォーカスがある間だけ見せる。マウスを動かすと YouTube が操作バーを出すので、マウスの判定は持たない（`:hover` は `pointer-events: none` の間は効かない）。見えている間だけ `pointer-events: auto`。オーバーレイのほかの部分はクリックを通す。
  - `click`、`dblclick`、Space と Enter の `keydown` はプレイヤーに届かせない（再生、一時停止、全画面にしない）。`mousedown` ではフォーカスを取らない（YouTube のキーが効き続ける）。
  - `:host-context()` は Chrome だけが対応し、仕様からは外された（docs/adoption.md）。
- 表示のモードは、その場で読む。`settings.ts` の `watchSubtitleSettings(area, onChange)`（`storage.local.onChanged`。消えた値と読めない値は既定）で追い、`WatchPageOptions.storage` は `StorageArea & StorageEvents`。変わったら `watchFront.displayChanged()`、feeder に今の位置をもう 1 度渡す（一時停止中に表示を戻しても、その行が出る）、描き直し、ピルの順。
- 広告が始まったら（理由が `ad` になったら）行を消す。広告の間に来た訳は timeline に入れるが描かない。一時停止では行を残す。一時停止中に広告が終わったら、フレームが来ないので `video.currentTime * 1000` から 1 度描く。
- `'subs/display'`（content から）: `{ mode: DisplayMode }` → `{}`。background が `subtitles` の設定の `display` だけを保存する。各タブは `storage.onChanged` で追う。
- `commands`:
  - `cycle-display`: `suggested_key: { default: 'Alt+Shift+J' }`、`description: '字幕の表示を切り替え（日本語／併記／原語／オフ）'`
  - background が `nextDisplay` を保存する。`commands.onCommand` の listener は `startBackground` が登録する。
  - `subs/display` とショートカットは、background の 1 つのキュー（1 度に 1 つ。読んでから `display` だけを書き換えて保存）を通る。2 回すばやく押せば 2 つ進む。
- 表示がもたらす処理の違い:
  - `off` → away（何も処理しない）
  - `source` → 翻訳を送らない（Task 7 の feeder と Task 12 のライブの処理）

- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { name: '再生中', events: ['play'], expected: 'active' },
  { name: '一時停止', events: ['play', 'pause'], expected: 'pause:paused' },
  { name: 'ミュート', events: ['play', 'mute'], expected: 'pause:muted' },
  { name: '音量 0', events: ['play', 'volume0'], expected: 'pause:muted' },
  { name: '裏のタブ', events: ['play', 'hidden'], expected: 'away:hidden' },
  { name: '広告', events: ['play', 'ad'], expected: 'away:ad' },
  { name: 'プレイヤーが画面外', events: ['play', 'offscreen'], expected: 'away:offscreen' },
  { name: '表示オフ', events: ['play', 'display-off'], expected: 'away:display-off' },
  { name: '広告中に一時停止', events: ['play', 'ad', 'pause'], expected: 'away:ad' },
  { name: 'バッファ中', events: ['play', 'waiting'], expected: 'active' },
])('front: $name', ({ events, expected }) => {
  /* `${state}:${reason}` */
});
it('reports only changes and removes every listener and observer on stop', () => {
  /* ... */
});
it('tells the caption feeder whether the page is active, at start and on each change', () => {
  /* play → front(true)、pause → front(false)、hidden → front(false)、visible で再生 → front(true) */
});
it('cycles the display from the player button', async () => {
  /* click → subs/display { mode: 'source' }（今が both） */
});
it('saves the display sent by a YouTube top frame and cycles it from the command', async () => {
  /* runtime: subs/display と commands.onCommand('cycle-display') */
});
it('refuses subs/display from another site with sender_forbidden', async () => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - content script で、`watchFront` の `onChange` から `feeder.front(state === 'active')` を呼ぶ。feeder を作り直したとき（遷移、トラックの読み直し）も、今の状態で 1 度呼ぶ。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: 実機で確かめる（手動）**
  - `Alt+Shift+J` が、全画面の再生中でも効くこと。YouTube のキー操作とぶつからないこと（macOS では Option+Shift+J）。
  - `:host-context` でボタンが操作バーと一緒に出たり消えたりすること。
  - 結果を Task 14 の README に反映するため、メモしておく。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(subtitle-translator): process only in front of the viewer and switch the display from the player"`

### Task 11: 音声の前処理（AudioWorklet、16 kHz、VAD）

**Files:**

- Create: `packages/subtitle-translator/src/audio/resample.ts`、`src/audio/vad.ts`
- Create: `packages/subtitle-translator/src/entrypoints/pcm-worklet.ts`
  - WXT の unlisted script として、1 つの JS（`/pcm-worklet.js`）にまとめる。
  - AudioWorkletGlobalScope で動くので、`window`、`chrome`、`browser` を参照しない。`wxt/browser` も import しない。
- Test: `test/unit/resample.test.ts`、`test/unit/vad.test.ts`

**Interfaces:**

- `createResampler(inputRate: number, outputRate: 16000): (input: Float32Array) => Float32Array`
  - 7,000 Hz の 1 次のローパスをかけてから、線形補間する。
  - 呼び出しをまたいで、端数の位置とフィルターの状態を保つ。
  - 出力は使い回すバッファの `subarray`。128 フレームごとの呼び出しで新しい配列を作らない。
- `downmix(channels: readonly Float32Array[], out: Float32Array): Float32Array`
- `createVad(options: VadOptions): Vad`
  - `VadOptions = { frameMs: 20; hangoverMs: 300; minSegmentMs: 300; maxSegmentMs: 1500; cutSearchMs: 500; preRollMs: 100; floorWindowMs: 2000; floorRatio: 3; minRms: 0.003 }`
  - `Vad = { push(frame: Float32Array /* 320 サンプル */): Segment | undefined; flush(): Segment | undefined; reset(): void }`
  - `Segment = Readonly<{ pcm: Int16Array; durationMs: number; trailingSilenceMs: number; gapBeforeMs: number }>`
    - `trailingSilenceMs`: 無音で閉じた区切りは 300、長さで切った区切りは 0。offscreen は「受け取った時刻 − `trailingSilenceMs`」を発話の終わりとする。
    - `gapBeforeMs`: 区切りの前の無音の長さ。長さで切った続きは 0。文を閉じる判断（700 ms）に使う。
  - 発話の判定: フレームの RMS が max(`minRms`, 下限 × `floorRatio`) を超えたら発話。下限は、直近 2,000 ms のフレームの RMS の最小値（100 個の固定長リング）。
  - 区切り:
    - 発話の後に `hangoverMs` の無音が続いたら閉じる。後ろの無音は含めない。
    - 区切りが `maxSegmentMs` に達したら、強制で閉じる。切るのは、区切りの最後の `cutSearchMs`（25 フレーム）のうち、RMS がいちばん小さいフレームの後ろ。同じ値なら、後ろのフレームにする。
      - そのフレームより後ろの音（最大 480 ms）は捨てず、次の区切りの先頭にする。固定長のバッファの中で前に詰め、新しい配列は作らない。
      - 強制の区切りの長さは 1,020〜1,500 ms になる。
      - 理由（Task 4、2026-11-06、Global Constraints）: 1,500 ms ごとに機械的に切った音声では、音節の途中で切れた音でモデルが同じ語を繰り返し、ko-3、zh-1、zh-3 が毎回 `response_invalid`（文字起こしが `asrTextLimit` に達した）になった。丸ごとの音声では一度も失敗しなかった。
    - 発話の始まりの前の `preRollMs` 分を先頭に含める。強制の区切りの続きには付けない。
    - `minSegmentMs` 未満の区切りは捨てる。
  - バッファはすべて最初に確保した固定長で、無音の間も伸びない。
    - 区切りのバッファ: (1,500 + 100) ms × 16 サンプル
    - 前置きのリング: 5 フレーム
    - 下限のリング: 100 個
- worklet `'st-pcm'`:
  - 128 フレームのブロックごとに、`downmix` → `resample` → 20 ms のフレーム → VAD の順に処理する。
  - 区切りが閉じたら、そのコピーを `{ type: 'segment', pcm, durationMs, trailingSilenceMs, gapBeforeMs }` で送る。`pcm.buffer` は transfer する。
  - `port.onmessage` で `{ type: 'flush' }`（閉じかけの区切りを閉じて送る）と `{ type: 'reset' }`（捨てる）を受ける。
  - ブロックごとの割り当ては、区切りのコピーを除いてしない。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { name: '48k→16k の長さ', inputRate: 48000, samples: 4800, expected: 1600 },
  { name: '44.1k→16k の長さ', inputRate: 44100, samples: 4410, expected: 1600 },
])('resampler: $name', ({ inputRate, samples, expected }) => {
  /* 128 ずつ続けて呼んでも合計が expected ± 1 */
});
it('keeps a 1 kHz tone and weakens a 12 kHz tone', () => {
  /* 48k 入力。12 kHz の出力の RMS ≤ 1 kHz の出力の RMS × 0.6 */
});
it.each([
  {
    name: '発話→無音で区切る',
    pattern: ['silence:200', 'speech:600', 'silence:400'],
    segments: [700],
  },
  {
    // 前置き 100 + 発話 1,300 + 静かな 20 で 1,420。続きも同じ。最後は 460
    name: '1.5 秒を超える発話は、最後の 500 ms でいちばん静かなフレームの後ろで切る',
    pattern: [
      'silence:200',
      'speech:1300',
      'silence:20',
      'speech:1400',
      'silence:20',
      'speech:460',
      'silence:400',
    ],
    segments: [1420, 1420, 460],
  },
  {
    name: '短すぎる音は捨てる',
    pattern: ['silence:200', 'speech:160', 'silence:400'],
    segments: [],
  },
  { name: '無音だけ', pattern: ['silence:60000'], segments: [] },
  { name: '一定の大きさの BGM だけ', pattern: ['tone:60000'], segments: [] },
])('vad: $name', ({ pattern, segments }) => {
  /* 区切りの長さ（ms）の配列。speech はノイズ、silence は RMS 0.0005 のノイズ */
});
it('cuts a forced segment after 1,000 ms at the latest and loses no audio', () => {
  /* ['silence:200', 'speech:1800', 'silence:400'] → 区切り 2 つ。1 つ目は 1,020〜1,500 ms、合計は 1,900 ms（前置き 100 + 発話 1,800） */
});
it('reports trailing silence and the gap before each segment', () => {
  /* 無音で閉じた区切り 300 / 0、長さで切った続き 0 */
});
it('keeps every VAD buffer at a fixed size through an hour of silence', () => {
  /* 内部の長さが変わらない */
});
it('flush closes the open segment when it is long enough', () => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run:
    - `pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm check`
    - `pnpm --filter @chrome-toolbox/subtitle-translator build && ! grep -E "window\.|chrome\.|browser\." packages/subtitle-translator/dist/chrome-mv3/pcm-worklet.js`
  - Expected: PASS。2 つ目は終了コード 0。
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): 16 kHz resampler and bounded energy VAD in an AudioWorklet"`

### Task 12: ライブの処理（ASR → 言語 → 文 → 翻訳）

**Files:**

- Create: `packages/subtitle-translator/src/audio/live-pipeline.ts`、`src/audio/language.ts`、`src/audio/latency.ts`
- Test: `test/unit/live-pipeline.test.ts`、`test/unit/language.test.ts`、`test/unit/latency.test.ts`

**Interfaces:**

- Consumes: Task 3 の `AsrClient`、Task 8 の `LineInput`（`translate` が受け取る形）、Task 9 の `LiveLine`、Task 11 の `Segment`
  - ライブの処理はプロンプトを組まない。訳は `translate` に任せ、Task 13 が offscreen で Task 8 の `createLineTranslator` をつなぐ（判断 S22）。
  - Task 11 の区切りは、無音か、最後の 500 ms でいちばん静かなフレームで閉じる。Task 4 で、1,500 ms ごとに機械的に切った音声は ASR が繰り返しに陥って `response_invalid` になった（Global Constraints）。静かなところで切っても失敗は起こりうるので、ASR の失敗（`response_invalid` を含む）は `failed` に数え、その区切りの行は出さずに次の区切りへ進む。
- Produces:
  - `LIVE_LIMITS`:

    ```ts
    const LIVE_LIMITS = {
      asrWaiting: 2,
      translationWaiting: 2,
      asrStartDeadlineMs: 1500,
      translationStartDeadlineMs: 2500,
      sentenceMaxMs: 6000,
      sentenceMaxChars: 200,
      sentenceGapMs: 700,
      contextSentences: 3,
      latencyRing: 200,
      languageWindow: 20,
    } as const;
    ```

  - `LiveConfig = Readonly<{ display: DisplayMode; sourceLang: 'auto' | string; context: string; glossary: readonly GlossaryEntry[]; translator: SubtitleTranslator }>`
    - `glossary` は `toPromptGlossary` を通したもの。
    - `translator` はライブの処理では読まない。`audio/config` で offscreen に届き、Task 13 の `createLineTranslator` の `config` が読む。
  - `createLivePipeline(deps: { asr: AsrClient; translate: (input: LineInput & { signal: AbortSignal }) => Promise<Result<string>>; config: () => LiveConfig; emit: (line: LiveLine) => void; now: () => number; timers: Timers }): LivePipeline`
  - `LivePipeline`:
    - `push(segment: Segment & { endedAt: number }): void`
      - `endedAt` は「受け取った時刻 − `trailingSilenceMs` − `carriedMs`」。長さで切った区切りは、切った後ろの音（最大 480 ms、Task 11 の `carriedMs`）を受け取り済みなので、それも引く（判断 S45）。
    - `mode(kind: 'active' | 'pause' | 'away'): void`
    - `reset(): void`: SPA の遷移のとき。言語、文脈、開いた文を捨てる。
    - `stats(): LiveStats`
    - `dispose(): void`
  - `LiveStats = Readonly<{ segments: number; silent: number; dropped: number; expired: number; skipped: number; failed: number; lang?: string; sourceP50Ms?: number; jaP50Ms?: number; jaP95Ms?: number }>`
  - 流れ:
    1. ASR に区切りを渡す。結果の `text` が空なら `silent` を数え、何も出さない。
    2. 原語の行を `pending` ですぐ出す。
    3. 行の言語が `ja` か、表示が `source` なら、翻訳しない。`ja` の行は、`source` をそのまま日本語の段に出す（`state: 'done'`、`ja = source`）。
    4. それ以外は翻訳を待ちに入れる。訳を付けて `done` で出す。
  - 文:
    - 文末の記号（`.?!。？！`）で終わらない結果は、開いた文として持つ。次の区切りの結果を、開いた文につなげる。同じ `sentenceId` で原語を出し直し、翻訳も新しい版に置き換える。
    - 開いた文を閉じる条件: 文末の記号、次の区切りの `gapBeforeMs` が 700 以上、言語が変わった、6,000 ms または 200 文字に達した。閉じた文は `final: true` で出す。
    - 文脈は、同じ言語の直前の閉じた 3 文（原語）。
  - 待ちと期限（枠 0 は 1 本の列。PLaMo で訳すときも同じ列にする。判断 S17）:
    - 次に流す仕事は、区切りの終わりがいちばん古いもの。同じなら翻訳が先。
    - ASR の待ちは 2 件まで。3 件目が来たら、いちばん古い待ちを捨てる（`dropped`）。
    - 翻訳の待ちは 2 文まで。同じ文の待ちは新しい版に置き換える。3 文目が来たら、いちばん古い文の待ちを捨てる（`skipped`。その文は原語のまま）。
    - 列の先頭に来たとき、区切りの終わりから `asrStartDeadlineMs` を過ぎた ASR と、`translationStartDeadlineMs` を過ぎた翻訳は、流さずに捨てる（`expired`、翻訳は `skipped`）。
  - モード:
    - `active`: ふつうに流す。
    - `pause`: 受け取った分は流し終える（入力は Task 13 の側で止まる）。
    - `away`: 待ちを捨てる（`dropped`）。実行中のリクエストは AbortSignal で止める。開いた文は閉じる。
  - 遅延: `sourceMs` は原語の行を出した時刻 − `endedAt`、`jaMs` は訳を出した時刻 − 訳した版の `endedAt`。直近 200 件のリングから p50 と p95 を出す。
  - `createLanguageTally(size: 20): { observe(lang: string): void; current(): string | undefined; reset(): void }`
    - 直近 20 行でいちばん多い言語。同数なら新しい方。状態の表示に使う。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('emits the source line before the translation and records latency from the speech end', async () => {
  /* 出す順は pending → done。sourceMs < jaMs。fake timers と偽の asr・translate */
});
it.each([
  {
    name: '日本語の音声',
    asr: 'ja\tよし行くぞ',
    display: 'both',
    translateCalls: 0,
    ja: 'よし行くぞ',
  },
  { name: '原語のみ', asr: 'en\tOkay chat.', display: 'source', translateCalls: 0, ja: undefined },
])('skips translation: $name', async (row) => {
  /* ... */
});
it('re-translates a split sentence under the same id and closes it at the end mark', async () => {
  /* 'Okay chat' → 'we are going in.' の 2 区切り → 同じ sentenceId で原語 2 回、2 回目は final */
});
it.each([
  { name: '700ms の間', gapBeforeMs: 700 },
  { name: '言語が変わった', lang: 'ko' },
  { name: '6 秒', totalMs: 6000 },
])('closes the open sentence: $name', async (row) => {
  /* ... */
});
it('keeps at most two segments waiting and drops the oldest', async () => {
  /* ASR を止めたまま push 5 → transcribe の呼び出しは 1 + 2、dropped 2 */
});
it('drops ASR that cannot start within 1.5 s and translations within 2.5 s of the speech end', async () => {
  /* expired、skipped。原語の行は残る */
});
it('runs the job with the oldest speech end first, translation before ASR on a tie', async () => {
  /* A1 実行中に A2 が来て、A1 が終わる → T1 が A2 より先 */
});
it('replaces a waiting translation of the same sentence with the newer text', async () => {
  /* translate は新しい版の 1 回だけ */
});
it('away drops waiting jobs and aborts the running one; pause lets them finish', async () => {
  /* signal.aborted、dropped */
});
it('counts a failed recognition and goes on with the next segment', async () => {
  /* 1 つ目の transcribe が response_invalid → failed 1、行は出ない。2 つ目の区切りの行は出る */
});
it('counts silent segments without emitting a line', async () => {
  /* 'en\t' */
});
it('passes the three previous closed sentences of the same language as context', async () => {
  /* ... */
});
it('reports p50 and p95 from the last 200 latencies only', () => {
  /* 1,000 件記録 → 内部の長さ 200 */
});
it('language tally follows the majority of the last 20 lines', () => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): live speech pipeline on slot 0 that drops what it cannot keep up with"`

### Task 13: 音声の取得とセッション（offscreen、ショートカット、止める条件）

**Files:**

- Create: `packages/subtitle-translator/src/entrypoints/offscreen/index.html`、`main.ts`
- Create: `packages/subtitle-translator/src/audio/capture.ts`、`src/sessions.ts`
- Modify: `src/protocol.ts`（`audio/*`、`subs/lines`、`subs/status`）、`src/runtime.ts`、`src/entrypoints/background.ts`、`src/entrypoints/youtube.content.ts`
- Modify: `wxt.config.ts`
  - `permissions` に `tabCapture` と `offscreen` を足す。
  - `commands` に `toggle-audio` を足す。`suggested_key: { default: 'Alt+Shift+S' }`、`description: '音声で字幕を開始／停止'`
- Modify: `tools/errors/catalog.json`
  - `capture_failed` → `unavailable`
  - `capture_not_invoked` → `permission_denied`
  - 続けて `pnpm errors:generate` を実行する。
- Modify: `docs/adoption.md`（Step 0 の結果）
- Test: `test/unit/sessions.test.ts`、`test/unit/offscreen.test.ts`、`test/unit/runtime.test.ts`

**Interfaces:**

- offscreen の `capture.ts`:
  - `startCapture(deps: { streamId: string; workletUrl: string; onSegment: (segment: Segment & { endedAt: number }) => void }): Promise<Result<Capture>>`
    - `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false })` で取得する。
    - `new AudioContext({ latencyHint: 'interactive' })`。標本化周波数は端末のまま。
    - source → `destination`（タブの音を消さない）。source → worklet は、入力を有効にしている間だけつなぐ。
    - 失敗は `capture_failed`。
  - `Capture`:
    - `input(on: boolean): void`
    - `flush(): void`: worklet に `flush` を送る。
    - `discard(): void`: worklet に `reset` を送る。
    - `stop(): void`: track を止め、ノードを切り離し、`context.close()` する。
- offscreen の `main.ts`。持つものは `{ tabId, capture, pipeline, config, idleTimer }`。
  - 受け取るメッセージ（宛先 `offscreen`。送り手がこの拡張の service worker であることを確かめる）:
    - `audio/start`: `{ tabId, streamId, settings: { baseUrl, models }, config: LiveConfig }`
      - すぐに `startCapture` で stream id を使う（stream id は使わないと数秒で切れるため）。投影器の確認は background が先に済ませている（下の `Sessions.start`。判断 S7）。
    - `audio/config`: `{ config: LiveConfig }`
    - `audio/front`: `{ front: FrontState }`
      - active → 入力をつなぐ。
      - pause → `flush()` してから入力を切る。
      - away → 入力を切って `discard()` し、`pipeline.mode('away')`。
    - `audio/reset`: SPA の遷移のとき。`pipeline.reset()` と `discard()`。
    - `audio/stop`: `{}`
    - `audio/state`: `{}` → `SessionState`
  - 送るメッセージ（宛先 `background`）:
    - `audio/lines`: `{ tabId, lines: LiveLine[] }`
    - `audio/status`: `{ tabId, status: PillState }`
    - `audio/idle`: `{ tabId }`。active でない状態が 600,000 ms 続いたとき。
    - `audio/failed`: `{ tabId, code }`。取得中に `audio_unsupported` などで続けられなくなったとき。
  - `SessionState = Readonly<{ tabId: number; startedAt: number; front: FrontState; stats: LiveStats; translator: TranslatorStatus }>`（`TranslatorStatus` は Task 8）
  - LLM の client は offscreen の中で作る。ASR と翻訳とも `timeoutMs: 8_000` で、キューは `concurrency: 1`。待ちの上限と期限は Task 12 のライブの処理が受け持つ。
  - 訳は Task 8 の `createLineTranslator({ client, config: () => ({ translator: config.translator, model: settings.models.translate }) })` でつくり、ライブの処理の `translate` には、その `ja` だけを返す関数を渡す。`audio/state` の `translator` は、その `status()`。
- background の `sessions.ts`:
  - `createSessions(deps: { tabCapture; offscreen: { has(): Promise<boolean>; create(): Promise<Result<void>>; close(): Promise<Result<void>> }; session: StorageArea /* chrome.storage.session */; send: (message: unknown) => Promise<Result<unknown>>; tabs; settings; glossary; pages; fronts: TabFronts /* Task 10 */; timers }): Sessions`
  - `Sessions`:
    - `start(tabId: number, streamId?: string): Promise<Result<void>>`
      1. 別のタブで取得中なら、それを `replaced` で止める。
      2. background の LLM client で `props({ model: models.asr })` を呼ぶ（ルーターがモデルを読み込む）。`audio: false` なら `audio_unsupported` を返す。stream id は取らず、offscreen も作らない（判断 S7）。`audio: undefined`（サーバーが返さない）は続ける。
      3. `streamId` がなければ（ショートカットのとき）、`tabCapture.getMediaStreamId({ targetTabId })` を呼ぶ。拡張が呼び出されていないエラーは `capture_not_invoked` にする。
      4. offscreen を作る（`reasons: ['USER_MEDIA']`）。
      5. `audio/start` を送る。
      6. `storage.session` の `capture` に `{ tabId, startedAt }` を書く。
    - `stop(tabId: number, reason: 'user' | 'tab-closed' | 'left-site' | 'idle' | 'replaced' | 'failed'): Promise<Result<void>>`
      - `audio/stop` を送り、offscreen を閉じ、`storage.session` を消す。タブには `subs/status`（stopped）を送る。
    - `dispose(): void`: listener をすべて外す。
  - 止める条件:
    - `tabs.onRemoved` → `tab-closed`
    - `tabs.onUpdated`（`status` が `loading` か `complete`）で、取得中のタブの `url` が見えない、または `https://www.youtube.com/` でない → `left-site`。content script の matches は youtube だけなので、ほかのサイトの URL は見えない。
    - `audio/idle` → `idle`
    - 別のタブの `start` → `replaced`
    - `audio/failed` → `failed`
  - YouTube 内の SPA の遷移: content script の `subs/page` で `videoId` が変わったら、`audio/reset` を送り、新しい `LiveConfig`（文脈と用語集）を `audio/config` で送る。
  - 設定と用語集が変わったら（`storage.onChanged`）、`audio/config` を送る。
  - 取得中のタブの前面の状態を、`audio/front` で回す。
    - `fronts.onFront`（Task 10 の `tabFronts`）を購読し、取得中のタブの変化だけを回す。`dispose` で購読を外す。
    - `start` では、`audio/start` の後に `fronts.get(tabId)` の今の状態を 1 度送る。報告のないタブは away（`UNKNOWN_FRONT`）として扱い、何も処理しない。
    - offscreen は `audio/front` に従う（下の active、pause、away）。届くまでは away の扱い。
    - service worker が起動し直した後も、`fronts` は `storage.session` から読める。
  - `audio/lines` はタブのトップフレームに `subs/lines` で、`audio/status` は `subs/status` で回す。
  - service worker が起動し直したときは、`storage.session` の `capture` と、`runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })` から状態を戻す。
- `commands` の `toggle-audio`: 今のウィンドウの前面のタブを見る。取得中なら `stop('user')`、YouTube の視聴ページなら `start(tabId)`。
- content script: `subs/lines` を live view に、`subs/status` をボタンの状態に渡す。音声の経路のときは feeder を止める（取得元はそのタブだけ音声になる）。

- [ ] **Step 0: スパイク（使い捨て。実機で確かめる）**
  - headed の Chrome for Testing で、`--load-extension` で読み込んで確かめる。いつも使う Chrome でも、「パッケージ化されていない拡張機能を読み込む」で確かめる。
  - 確かめること:
    - (a) どの操作のあとなら、`tabCapture.getMediaStreamId({ targetTabId })` が通るか。
      1. ツールバーのアイコン（サイドパネルが開く）を押したあとに、サイドパネルのボタンを押す。
      2. `toggle-audio` のショートカット。
      3. Chrome のサイドパネルのメニューからパネルを開き、パネルのボタンだけを押す。
    - (b) 取得をやめたあと、同じタブで、新しい操作なしに stream id を取り直せるか。
    - (c) offscreen で使える拡張 API が `chrome.runtime` だけであること。`fetch` で `http://127.0.0.1:18083` に届くこと（host permissions）。
    - (d) タブのミュート（Chrome のタブのメニュー）のときと、裏のタブのときに、取得した音声がどうなるか。
    - (e) AudioContext の標本化周波数と、`destination` に戻したときの音の遅れ。
    - (f) stream id を取ってから `getUserMedia` で使うまで、何秒あいても通るか（1 s、5 s、15 s）。ルーターがモデルを読み込み直すと、`props` に最大 13 s かかる。
  - 結果を `docs/adoption.md` に記録する。
  - (b) が通っても、取得の保ち方は変えない（ユーザーの決定、2026-11-05。判断 S8）。結果は記録だけする。
  - (f) の結果もコントローラーに知らせる。サイドパネルの経路では、パネルを開いたときの `subs/capability` でモデルが読み込まれ、その答えが出るまでボタンを押せない（Task 14）ので、`start` の `props` はふつう待たない。ショートカットの経路は、`props` の後に stream id を取るので切れない。
  - (a) で通らない操作は、サイドパネルの案内（Task 14）から外す。
- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  { name: 'タブを閉じた', event: 'removed', reason: 'tab-closed' },
  { name: 'サイトの外へ移動', event: 'updated:https://example.com/', reason: 'left-site' },
  { name: 'URL が見えない', event: 'updated:undefined', reason: 'left-site' },
  { name: '10 分処理していない', event: 'idle', reason: 'idle' },
  { name: '別のタブで開始', event: 'start:other', reason: 'replaced' },
])('stops the capture when $name', async ({ event, reason }) => {
  /* audio/stop 1 回、offscreen.close 1 回、storage.session の capture が消える */
});
it('keeps capturing across YouTube SPA navigation and resets the pipeline with the new context', async () => {
  /* subs/page の videoId が変わる → audio/reset と audio/config */
});
it('refuses to start without a projector before asking for a stream id or an offscreen document', async () => {
  /* props の audio:false → audio_unsupported。getMediaStreamId 0 回、offscreen.create 0 回、storage.session は空 */
});
it('asks the projector before the stream id on the shortcut path', async () => {
  /* 呼び出しの順: props → getMediaStreamId → offscreen.create → audio/start */
});
it('maps the not-invoked error of getMediaStreamId to capture_not_invoked', async () => {
  /* ... */
});
it('forwards front changes of the captured tab only', async () => {
  /* fronts.onFront を通す。別のタブの変化は回さない */
});
it('sends the current front on start, away for a tab that reported none', async () => {
  /* 報告のないタブ → audio/front { front: { state: 'away' } } */
});
it('recovers the captured tab from storage.session after a service worker restart', async () => {
  /* 起動し直した後の onRemoved で stop される */
});
// offscreen.test.ts（capture と pipeline は偽物）
it.each([
  { front: 'active', calls: ['input:on'] },
  { front: 'pause', calls: ['flush', 'input:off'] },
  { front: 'away', calls: ['input:off', 'discard', 'mode:away'] },
])('applies front $front', async ({ front, calls }) => {
  /* ... */
});
it('reports idle after 10 minutes without being active', async () => {
  /* fake timers。active に戻るとタイマーが外れる */
});
it('ignores messages that are not addressed to the offscreen document', async () => {
  /* target が panel や background のもの、ほかの送り手のもの */
});
it('translates live lines with the line translator chosen in the config and reports its status', async () => {
  /* config.translator 'plamo'、偽の fetch の /v1/models に PLaMo なし → 訳は Gemma へ。audio/state の translator.fallback.latest は 'not_listed'、lines.not_listed は 1 */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
  - `startCapture` は単体テストをせず、Task 15 の E2E と Step 5 で確かめる。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm errors:generate && pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm check`
  - Expected: PASS
- [ ] **Step 5: 実機で 1 回だけ通して確かめる（手動。投影器のあるサーバーで）**
  - 英語の動画で `Alt+Shift+S` を押し、原語と日本語の行が出ること、タブの音が鳴り続けることを確かめる。
  - 一時停止、裏のタブ、タブを閉じる、の 3 つで、サーバーへのリクエストが止まることを、サーバーのログで確かめる。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(subtitle-translator): offscreen tab audio capture with explicit start and stop rules"`

### Task 14: サイドパネル

**Files:**

- Create: `packages/subtitle-translator/src/panel.ts`
- Create: `packages/subtitle-translator/src/entrypoints/sidepanel/App.tsx`、`StatusSection.tsx`、`DisplaySection.tsx`、`AudioSection.tsx`、`TranslatorSection.tsx`、`GlossarySection.tsx`、`ServerSection.tsx`、`text.ts`
- Modify: `src/entrypoints/sidepanel/main.tsx`、`src/protocol.ts`（`subs/tab-state`、`subs/capability`、`subs/state-changed`）、`src/runtime.ts`
- Modify: `packages/subtitle-translator/README.md`
- Test: `test/unit/panel.test.ts`、`test/unit/sidepanel.test.tsx`

**Interfaces:**

- Consumes: Task 0 の `PLAMO_LICENSE_URL`、`PLAMO_TRANSLATE_MODEL`、Task 5 の設定と用語集、Task 8 の `TranslatorStatus`、Task 10 の `tabFronts` と `subs/display`（background のキュー）、Task 13 の `SessionState`
- `PanelPort`（comment-assistant の `panel.ts` と同じ作り。`watch` を呼ぶまで何も登録しない）:

  ```ts
  type PanelPort = {
    connection: ConnectionPort;
    settings: SettingsStore; // extension-core。models.translate と models.asr
    subtitles: Pick<SubtitleSettingsStore, 'load'>; // 読むだけ。保存は下の display と saveSubtitles
    display(this: void, mode: DisplayMode): Promise<Result<void>>; // subs/display
    saveSubtitles(
      this: void,
      patch: Partial<Omit<SubtitleSettings, 'display'>>,
    ): Promise<Result<void>>; // 変えた欄だけ
    glossary: GlossaryStore;
    tabState(this: void): Promise<Result<TabState | undefined>>;
    capability(
      this: void,
    ): Promise<Result<{ audio: boolean | undefined; plamo: boolean | undefined }>>;
    startAudio(this: void): Promise<Result<void>>;
    stopAudio(this: void): Promise<Result<void>>;
    watch(this: void, changed: () => void): () => void;
  };
  ```

  - `startAudio` は、Task 13 の Step 0 で通った方式で呼ぶ。パネルのボタンで通るなら、クリックの処理の中で `tabCapture.getMediaStreamId({ targetTabId })` を呼び、`audio/start` `{ tabId, streamId }` を送る。
  - `watch` は、別のタブが前面になったとき、表示中のタブが読み込みを終えたとき、`subs/state-changed`（宛先 `panel`）を受けたときに `changed` を呼ぶ。
  - パネルは `subtitles` の設定を丸ごと保存しない。丸ごと保存すると、その間にプレイヤーのボタンやショートカットで変わった表示を上書きするため。
    - 表示は `subs/display` で送る（`page` からの経路を足す）。Task 10 の background のキューを通る。
    - 取得元、話されている言語、翻訳モデルも、変えた欄だけを background に送り、同じキューで読み直した最新の値に重ねて保存する（例: `subs/settings` `{ patch }`）。パネルが持つ欄だけを書く。

- `TabState = Readonly<{ tabId: number; page?: PageInfo; source: 'captions' | 'audio' | 'none'; front: FrontState; session?: SessionState; translator: TranslatorStatus }>`
  - `front` は Task 10 の `tabFronts`（`storage.session` に覚えたもの）から読む。報告のないタブは away（`UNKNOWN_FRONT`）。
  - `translator` は background の字幕トラックの訳（Task 8 の `createSubtitleTranslator().status()`）。音声の経路のタブでは、パネルは `session.translator`（offscreen の訳）を出す。
- `'subs/capability'`（page から）→ `{ audio: boolean | undefined; plamo: boolean | undefined }`。
  - `audio`: `props({ model: models.asr })` の `audio`。
  - `plamo`: `models()` の一覧に `PLAMO_TRANSLATE_MODEL`（`plamo-3-translate-2b`）があるか。`models()` が失敗したら `undefined`。
- 画面（1 ページ。上から順に）:
  1. **状態**
     - 字幕の取得元（字幕トラック／音声認識／なし）と言語
     - 応答: 原語 p50、日本語 p50 / p95
     - 処理しきれず（捨てた数 + 期限切れの数）、無音の数
     - 止まっている理由（一時停止中／ミュート／裏のタブ／広告／プレイヤーが画面外／表示オフ）
     - 「更新」ボタン。開いたとき、タブが変わったとき、「更新」を押したときだけ取得する。ポーリングはしない。
  2. **表示**
     - 4 つのラジオボタン: 日本語のみ／原語と日本語／原語のみ／オフ
     - 案内: 「プレイヤーの右上のボタンか Alt+Shift+J でも切り替えられます」
  3. **音声**
     - 「音声で字幕を開始」／「停止」ボタン。案内: 「Alt+Shift+S でも開始・停止できます」
     - 「音声で字幕を開始」は、パネルを開いたときの `capability` の答えが出るまでと、`audio === false` のときは押せない（判断 S7）。
     - 音声入力の可否:
       - 「音声入力: 使えます」
       - 「音声入力が使えません。llama.cpp のプリセットで mmproj を有効にして、サーバーを再起動してください（docs/llama-server.md）」
  4. **取得元**: 自動／字幕トラック／音声
  5. **話されている言語**: 自動、または 12 言語から 1 つ
  6. **字幕の翻訳**（Task 8）
     - 2 つのラジオボタン: `TRANSLATOR_LABELS` の「Gemma（既定）」／「PLaMo 3 Translate 2B（速い・任意）」。`subtitles.translator` に保存する。
     - PLaMo を選んでいる間だけ、次を出す。
       - 「Built with PLaMo」（英語のまま）と、リンク「PLaMo Community License」（`PLAMO_LICENSE_URL`。`target="_blank"`、`rel="noreferrer"`）
       - 案内: 「PLaMo は llama.cpp のサーバーに別に入れます（docs/llama-server.md）」
     - Gemma に切り替えたことの表示（PLaMo を選んでいるときだけ）。数が 1 以上の理由ごとに 1 行ずつ出し、`fallback.latest` の行を先にする（判断 S44）:
       - `capability.plamo === false`、または `fallback.lines.not_listed > 0`: 「サーバーに plamo-3-translate-2b がないため、Gemma で訳しています」
       - `fallback.lines.refused > 0`: 「PLaMo がエラーを返した {lines.refused} 行を Gemma で訳しました」
       - `fallback.lines.language > 0`: 「PLaMo が対応していない言語の {lines.language} 行を Gemma で訳しました」
  7. **用語集**（配信者ごと）
     - 配信者の名前を見出しにする。
     - 原文と訳の組を、足したり消したりできる。訳が空なら「原文のまま」。
     - 50 件まで。51 件目は「用語集は 50 件までです」と出して受け付けない。
     - 配信者が分からないときは編集できなくし、「配信者が分からないため、用語集は使えません」と出す。
  8. **接続**
     - 共有の `ConnectionPanel`
     - 「翻訳モデル（Gemma）」（`models.translate`）と「音声認識モデル」（`models.asr`）の欄。保存した値が遅れて読み込まれても、入力中の値を上書きしない（comment-assistant の `edited` と同じ）。
- パネルは、宛先が `panel` でない runtime のメッセージを、検証の前に捨てる。
- README:
  - 使い方（表示の切り替え、ショートカット、音声の開始と止まる条件）
  - 投影器の有効にし方とメモリ（Task 4 の値）
  - 字幕の翻訳モデル: 既定は Gemma。PLaMo 3 Translate 2B は任意で、利用者が自分で入れる（docs/llama-server.md）。PLaMo Community License の要点（個人と非商用は登録なしで無料、商用は事前の登録と売上の条件、訳を他人に渡すときは「Built with PLaMo」と PLaMo の出力であることの表示）。ルーターにないときと HTTP のエラーのときは Gemma で訳すこと。このリポジトリには PLaMo の出力を入れていないこと。
  - 権限（`tabCapture`、`offscreen`、`storage`、`sidePanel`）
  - プライバシー（音声は保存しない。保存するのは設定と用語集だけ）
  - テストの手順

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('starts audio from the button and then shows the stop button', async () => {
  /* Testing Library。startAudio が 1 回、ボタンが「停止」に変わる */
});
it('explains a missing projector with the llama-server.md guidance', async () => {
  /* capability → { audio: false, plamo: undefined }。「音声で字幕を開始」は押せない */
});
it('shows Built with PLaMo and the license link only while PLaMo is chosen', async () => {
  /* translator 'gemma' → どちらもない。ラジオで PLaMo → subtitles.save に translator 'plamo'、
     'Built with PLaMo' と href が PLAMO_LICENSE_URL のリンク */
});
it.each([
  {
    name: 'サーバーにない',
    capability: { plamo: false },
    texts: ['サーバーに plamo-3-translate-2b がないため、Gemma で訳しています'],
  },
  {
    name: 'エラー',
    fallback: { latest: 'refused', lines: { not_listed: 0, refused: 3, language: 0 } },
    texts: ['PLaMo がエラーを返した 3 行を Gemma で訳しました'],
  },
  {
    name: '対応していない言語',
    fallback: { latest: 'language', lines: { not_listed: 0, refused: 0, language: 2 } },
    texts: ['PLaMo が対応していない言語の 2 行を Gemma で訳しました'],
  },
  {
    name: '理由が 2 つ（直近を先に）',
    fallback: { latest: 'refused', lines: { not_listed: 0, refused: 1, language: 1 } },
    texts: [
      'PLaMo がエラーを返した 1 行を Gemma で訳しました',
      'PLaMo が対応していない言語の 1 行を Gemma で訳しました',
    ],
  },
])('says that lines fell back to Gemma: $name', async (row) => {
  /* translator 'plamo'。音声の経路のタブでは session.translator を使う。texts だけが、この順に出る */
});
it.each(DISPLAY_MODES)('sends the display mode %s with subs/display', async (mode) => {
  /* subtitles の丸ごとの保存はしない */
});
it('saves only the field the viewer changed', async () => {
  /* 取得元を変える → patch は { source } だけ。その間に変わった display は残る */
});
it('adds and removes glossary entries and refuses the 51st', async () => {
  /* ... */
});
it('disables the glossary when the streamer is unknown', async () => {
  /* ... */
});
it('keeps typed model names when the saved settings load late', async () => {
  /* ... */
});
it('asks for the tab state on open, on tab change and on 更新 only', async () => {
  /* fake timers を進めても追加の呼び出しなし */
});
it('ignores runtime messages that are not addressed to the panel before decoding them', () => {
  /* ... */
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test`
  - Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test && pnpm --filter @chrome-toolbox/subtitle-translator test:e2e && pnpm check`
  - Expected: PASS（既存の接続の E2E も通る）
- [ ] **Step 5: Commit**
  - `git commit -m "feat(subtitle-translator): side panel for display, speech, glossary and connection"`

### Task 15: E2E と負荷試験（soak）

**Files:**

- Modify: `packages/extension-core/testing/playwright.ts`（offscreen のヒープと長いタスクを測る補助）
- Create: `packages/subtitle-translator/test/browser/fixtures/watch.ts`
  - 偽の視聴ページの HTML を作る。
  - 偽の `#movie_player`（`getPlayerResponse` を持つ）と `<video>` を置く。
  - プレイヤーが timedtext を取得する偽のスクリプトを含む（Task 6 で確かめた方式をまねる）。
- Create: `packages/subtitle-translator/test/browser/fixtures/tones.ts`
  - 合成音の WAV（48 kHz、16 ビット）をテストの中で作る。リポジトリにバイナリを置かない。
  - 220 Hz ののこぎり波を 600 ms、無音を 500 ms、の繰り返し。
- Create: `test/browser/captions.spec.ts`、`audio.spec.ts`、`front.spec.ts`、`translator.spec.ts`、`soak.spec.ts`
- Modify: `packages/subtitle-translator/package.json`（`starter.soak: true`）
- Modify: `packages/comment-assistant/test/unit/soak-marker.test.ts`（判断 S31）
  - テストの名前を `'lists the packages that mark a browser soak in their manifest'` にする。
  - 期待する一覧を、名前の順の `['@chrome-toolbox/comment-assistant', '@chrome-toolbox/subtitle-translator']` にする。
  - ③ page-translator の計画（Task 11）も同じ名前で `'@chrome-toolbox/page-translator'` を足す。③ のブランチを rebase して衝突したら、一覧は両方を名前の順に残す。
- Playwright Test には `test.each` がない。行ごとのテストは、行の配列を `for` で回して `test(...)` を呼ぶ（判断 S23）。

**Interfaces:**

- `offscreenTarget(context: BrowserContext, path: '/offscreen.html'): Promise<{ usedHeap(): Promise<number>; heapParts(): Promise<HeapParts>; longTasks(): Promise<number[]>; detach(): Promise<void> }>`
  - 方式は Step 0 で決める。
  - 候補 1: `context.pages()` に offscreen が見えれば、それを使う。
  - 候補 2: `realVisibility: true` の起動（CDP でつないでいる）で `browser.newBrowserCDPSession()` を作り、`Target.attachToTarget({ targetId, flatten: true })` で offscreen につなぐ。
  - 対象の見つけ方（URL が `chrome-extension://<id>/offscreen.html`）は単体テストにする。
- `platform` の fixture に、`<video>` の音声と timedtext の応答を足す。期待するプラットフォームへのリクエストは、ドキュメント、メディア、timedtext（1 回）だけ。

- [ ] **Step 0: 確かめる**
  - (a) E2E で本物の `tabCapture` を使えるか。headless の Chrome for Testing 156 で、次を順に試す。
    1. サイドパネルのページ（タブで開いたもの）のボタンを、Playwright でクリックする。
    2. CDP で拡張のアクションを起動してから、ショートカットの経路を使う。
       - アクションの起動を補助の関数にするときは、`packages/extension-core/testing/playwright.ts` の `triggerAction(context: BrowserContext, page: Page): Promise<void>`（CDP の `Extensions.triggerAction`）にする。③ page-translator の Task 1 も同じ名前と形で使う。先に入った方を使い、後の方は足さない（判断 S32）。
  - (b) どちらもだめなら、次の代わりの方式にする。
    - `tools/quality/extension-browser.ts` に、e2e 用のビルド（`wxt build --mode e2e`）を足す。対象は `starter.e2eBuild: true` のパッケージだけ。
    - offscreen は、`import.meta.env.MODE === 'e2e'` のときだけ、fixture の `<audio>` の `captureStream()` から MediaStream を作る。MediaStream から先は本番と同じコードを通る。
    - 本番のビルドにこの経路が入っていないことを、ビルド結果の grep で確かめる（目印の文字列 `e2e-fixture-audio`）。
    - ③ page-translator の Task 1 Step 0 の C も、同じ `starter.e2eBuild` と `wxt build --mode e2e` を使う。先に入った方を使い、後の方は足さない（判断 S32）。
  - (c) offscreen のヒープと長いタスクを、どちらの候補で測れるか。
  - 結果を `docs/adoption.md` に記録する。
- [ ] **Step 1: 失敗するテストを書く**

```ts
test('caption path shows source and Japanese lines in sync with playback', async ({
  context,
  platform,
  llama,
}) => {
  // watch.html を https://www.youtube.com/watch?v=fixtureCap01 で開き、再生する
  // 期待値:
  //   - overlay の 2 段が、cue の時刻 ± 200 ms で切り替わる
  //   - 翻訳のリクエストは id_slot 0、model 'gemma4-e4b'
  //   - platform.requests は、ドキュメント、メディア、timedtext 1 回だけ
});
test('seeking restarts the prefetch at the new position', async () => {
  /* シーク後に出る訳は新しい位置の文 */
});
test('a video without caption tracks shows the audio hint and sends no model request', async () => {
  /* tracks 0 の視聴ページ。ピルに '字幕なし・Alt+Shift+S で音声字幕'。5 秒再生しても llama.requests に chat なし */
});
test('a 30-minute caption track at 16x keeps the timeline bounded with no long task', async () => {
  /* playbackRate 16 で 2 分。timeline の size ≤ 前後 10 分の文の数、longTasks 0 */
});
test('audio path shows the source line, then the Japanese line', async () => {
  /* 'Stub speech 1.' → '訳:Stub speech 1.'。ASR と翻訳とも id_slot 0、model 付き。data-st-latency < 1000 */
});
test('the player button and the side panel switch the display everywhere', async () => {
  /* ボタンで both → source。2 つ目のタブにも反映。パネルのラジオで ja */
});
test('a missing projector is explained and no capture starts', async () => {
  /* llama.respond = withoutAudio(defaultResponder)。パネルに案内、Alt+Shift+S でも offscreen なし */
});
test('closing the tab releases the capture and the offscreen document', async ({
  serviceWorker,
}) => {
  /* chrome.offscreen.hasDocument() が false、storage.session が空 */
});
// front.spec.ts（realVisibility: true）
for (const { name, act } of [
  { name: '裏のタブ', act: 'background-tab' },
  { name: '一時停止', act: 'pause' },
  { name: '広告', act: 'ad-showing' },
  { name: 'プレイヤーが画面外', act: 'scroll-away' },
] as const) {
  test(`${name} stops every model request`, async () => {
    /* act の後 5 秒、llama.requests の chat が増えない。戻すと再開する */
  });
}
// translator.spec.ts（Task 0 の withPlamo、Task 8）
test('PLaMo translates caption lines and the panel shows Built with PLaMo', async ({
  llama,
  sidePanel,
}) => {
  /* llama.respond = withPlamo(defaultResponder)。パネルで PLaMo を選ぶ → 'Built with PLaMo' とライセンスのリンク。
     字幕トラックの訳のリクエストは model 'plamo-3-translate-2b'、messages は user 1 つ、grammar なし、id_slot 0。
     日本語の段は '訳P:' で始まる */
});
test('without PLaMo on the router the lines come from Gemma and the panel says so', async ({
  llama,
  sidePanel,
}) => {
  /* 既定のスタブ（PLaMo を載せていない）。パネルで PLaMo を選ぶ → 訳のリクエストは model 'gemma4-e4b'、日本語の段は '訳:' で始まる。
     パネルに 'サーバーに plamo-3-translate-2b がないため、Gemma で訳しています' */
});
// soak.spec.ts
test('SOAK_MINUTES of audio subtitles keeps heap and long tasks within budget', async () => {
  // 音声の経路で、合成音を SOAK_MINUTES のあいだ流す（既定 2、手動では 120）
  // 測るもの: 視聴ページと offscreen の usedHeap と heapParts、longTasks、offscreen の stats
  // 期待値:
  //   - 視聴ページと offscreen のヒープは、どの時点でも 30MB 未満
  //   - どちらも heapParts の data が、終了時に開始時の 1.10 倍以下
  //   - どちらもヒープ全体が、開始時の 2 倍未満
  //   - 50ms を超える長いタスクが、視聴ページでも offscreen でも 0 件
  //   - スタブはすぐ答えるので、dropped・expired・skipped・failed がすべて 0
});
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test:e2e`
  - Expected: FAIL
- [ ] **Step 3: 足りない配線を直す**
  - テストを通すために本体のコードを直す場合は、該当するタスクの単体テストにも同じケースを足す。
- [ ] **Step 4: 通ることを確認する**
  - Run: `pnpm --filter @chrome-toolbox/subtitle-translator test:e2e && pnpm --filter @chrome-toolbox/extension-core test && pnpm --filter @chrome-toolbox/comment-assistant test && pnpm check`
  - Expected: PASS（soak は 2 分版。comment-assistant の `soak-marker.test.ts` も通る）
  - Step 0 で代わりの方式にした場合は、本番のビルドに e2e の経路がないことも確かめる。
    - Run: `pnpm --filter @chrome-toolbox/subtitle-translator build && ! grep -r "e2e-fixture-audio" packages/subtitle-translator/dist/chrome-mv3`
    - Expected: 終了コード 0
- [ ] **Step 5: Commit**
  - `git commit -m "test(subtitle-translator): caption and audio end-to-end, front-only processing and soak budget"`

### Task 16: 実機での確認と計測

ここでの計測は、静かなホスト（5 分平均の負荷が 4 未満）で、コントローラーが行う。サーバーの設定（投影器のファイル、MTP）は Task 4 の決定に従う。

**Files:**

- Modify: `docs/adoption.md`、`docs/llama-server.md`、`packages/subtitle-translator/README.md`、`README.md`（拡張の一覧の状態）

- [ ] **Step 1: 準備**
  - 拡張をビルドし、headed の Chromium にログインせずに読み込む。comment-assistant も読み込む。
  - サーバーは `--parallel 3`。プリセットの `[gemma4-e4b]` で、Task 4 で決めた投影器を有効にする。
  - 用語集に、配信者の名前など固有名詞を 3 つ入れる（訳は空にする）。
- [ ] **Step 2: 配信ごとに 8 分ずつ確かめる**
  - (a) 英語のライブ配信（必須）。音声の経路。
  - (b) スペイン語、韓国語、インドネシア語のどれかのライブ配信。なければ、字幕トラックのないアーカイブを音声の経路で使う。
  - (c) 日本語のライブ配信。翻訳を呼ばないことも確かめる。
  - (d) 字幕トラックのあるアーカイブ（日本語以外）。字幕トラックの経路。シークも 1 回する。
  - (e) (a) と同じ配信で、comment-assistant に同じタブのチャットを処理させる（§9 の基準の条件）。
  - (f) PLaMo を載せたサーバーがあるときだけ: サイドパネルで PLaMo 3 Translate 2B を選び、(e) と同じ条件で 8 分。パネルに「Built with PLaMo」とライセンスのリンクが出ることと、Gemma に切り替えた行がないことを確かめる。
- [ ] **Step 3: 測る**
  - 遅延:
    - サイドパネルの統計から、原語 p50、日本語 p50 / p95、処理しきれず、無音
    - 表示までの遅れ（`data-st-latency`）を 20 行
    - 字幕トラックの経路の表示のずれ（`currentTime` と表示中の行の時刻）を 20 回
  - 負荷:
    - llama-server の CPU、RSS、GPU の使用率
    - Chromium の CPU
    - 視聴ページと offscreen のヒープ（開始時と終了時）
    - (e) では、comment-assistant の p50 を、字幕なしのときと比べる
    - (e) では、Task 17 が入っていれば、字幕を出している間の comment-assistant のリクエストが、コメントの枠に同時に 1 本だけであることも確かめる（llama-server のログの `id_slot` と時刻）
  - 精度（抜き取りで採点する。データはローカルの `bench-data/live/` だけに置く）:
    - 配信ごとに、続けて出た 20 行を記録する。
    - 文字起こし: 正しい／小さな誤り／誤り
    - 言語の判別: 正しいか
    - 訳: 良い／許容／誤り
    - 用語集の語がそのまま出たか
    - (f) の訳は、採点しても数字だけを残す。訳の本文は `bench-data/live/` の外に出さない（PLaMo Community License）。
- [ ] **Step 4: 目標に届かないとき**
  - 目標: 原語 p50 ≤ 1.0 s、日本語 p50 ≤ 2.0 s、日本語 p95 ≤ 3.0 s、字幕トラックのずれ ≤ 200 ms。
  - spec §6 の順で直して、測り直す。
    1. 区切りを短くする（`maxSegmentMs` 1,500 → 1,000）。強制の区切りが増える。Task 4 では 1,500 ms で機械的に切った音声が `response_invalid` になったので、誤り率と失敗の数も測る。
    2. 訳を PLaMo 3 Translate 2B にする（Task 8 の設定。ユーザーがライセンスを受け入れて、サーバーに入れている場合だけ）。`gemma4-e2b` は 2026-10-28 の実測で `gemma4-e4b` と生成の速さが変わらなかったので、小さい Gemma には替えない（判断 S9）。
    3. 原語だけを先に出す
  - 精度が強制の区切りで落ちる場合（Task 4 の 1,500 ms 区切りの誤り率と比べる）は、遅延とのかね合いになるので、数字を添えてユーザーに相談する。
- [ ] **Step 5: 文書を直す**
  - `docs/adoption.md`: Step 3 の数字を記録する。配信者の名前、動画の ID、文字起こしの本文、訳の本文（Gemma も PLaMo も）は書かない。
  - `docs/llama-server.md`: 記載のプリセットで、投影器の行を既定で有効にする（R61「字幕を出すまで外す」の解除）。「コメントだけを使うならこの行を外すと、メモリが ○○ 減る」（Task 4 の値: footprint で約 1.2〜1.4 GB）と添える。
  - README: 状態を「使える」に直し、計測の結果へのリンクを足す。
- [ ] **Step 6: 長時間版の負荷試験（コントローラー）**
  - Run: `SOAK_MINUTES=120 pnpm --filter @chrome-toolbox/subtitle-translator test:e2e -- soak`
  - Expected: PASS。結果を `docs/adoption.md` に記録する。
- [ ] **Step 7: 品質ゲートを通す**
  - Run: `pnpm gate:pre-pr -- --base <分岐元 SHA>`
  - Expected: subtitle-translator、extension-core、comment-assistant、tools の項目がすべて pass する。
- [ ] **Step 8: Commit**
  - `git commit -m "docs(subtitle-translator): live latency, accuracy and load measurements"`

### Task 17: コメントが字幕に譲る（comment-assistant と extension-core。Task 4 の後ならいつでもよい）

背景:

- Task 4（2026-11-06、`docs/adoption.md` の「Speech recognition and slot 0」）: 枠 0 で ASR と翻訳を流すと、コメント 2 本の負荷の下では、MTP の有無にかかわらず日本語の p95 が 3 s を超えた（MTP あり 3.78〜4.70 s、なし 3.38〜3.46 s）。1 本なら、MTP ありで 1.86〜2.30 s に収まった。コメントも、MTP なしの 2 本（60 s で 14 バッチ）より多く処理できた（18〜19 バッチ）。
- ユーザーの決定（2026-11-06「字幕中はコメントが譲る」）: MTP は残す。字幕が枠 0 を使っている間、comment-assistant はバッチを 2 本ではなく 1 本ずつ送る。
- 拡張どうしはメッセージを送り合わない（spec §4）。comment-assistant が llama-server に枠 0 の状態を尋ねる。ルーターは `GET /slots?model=<name>` に、枠ごとの `{ id, is_processing, … }` の配列を返す（2026-11-06 にコントローラーが確かめた）。`/slots` を出さないサーバー（`--no-slots` など）は、失敗として扱う。
- 依存するのは、Task 1 の後の `llm.ts` とスタブだけ（どちらも済み）。subtitle-translator のコードには触らないので、Task 5〜16 と並べて進めてよい。

**Files:**

- Modify: `packages/extension-core/src/llm.ts`（`slots`、`SlotState`）、`src/llm.test.ts`、`src/index.ts`（`SlotState` を export）
- Modify: `packages/extension-core/testing/llama-stub.ts`（`GET /slots`、`withSlots`）、`testing/llama-stub.test.ts`
- Modify: `packages/extension-core/testing/playwright.ts`（`withSlots` を export の並びに足す）
  - Task 15 も同じ並びに `offscreenTarget`、`triggerAction` を足す。名前は重ならない。後から入る方が並びに合わせる。
- Create: `packages/comment-assistant/src/subtitle-yield.ts`
- Modify: `packages/comment-assistant/src/pipeline.ts`、`src/runtime.ts`
- Test: `packages/comment-assistant/test/unit/subtitle-yield.test.ts`（新規）、`test/unit/pipeline.test.ts`、`test/browser/comments.spec.ts`
- Modify（文書）:
  - `packages/comment-assistant/README.md`: Status の「Slots:」の項に次の 1 文を足す。Layout の表に `src/subtitle-yield.ts` を足す。
    - "While llama-server reported slot 0 (the subtitles') processing within the last 15 s (`GET /slots?model=`, asked at most every 1.5 s and only when a second request would start), requests on the comment slots run one at a time; a server that does not answer `/slots` keeps the spare slots."
  - `packages/extension-core/README.md`: `src/llm.ts` の行に `slots` を、`testing/llama-stub.ts` の行に `/slots`（既定は 2 枠とも空き）と `withSlots` を足す。
  - `docs/llama-server.md`: 「Why these values」の MTP の項の "is to run one batch at a time instead of two" を "runs one batch at a time instead of two" にする。
  - `docs/adoption.md`: 「Speech recognition and slot 0」の最後の段落の "is to check" を "checks" にする。
  - spec の §4〜§7 と §12 は、計画の改訂（2026-11-06）で書いた。下の値を変えたときは、§7 の行も直す。

**Interfaces:**

- extension-core `src/llm.ts`:
  - `type SlotState = Readonly<{ id: number; processing: boolean }>`
  - `LlamaClient.slots(this: void, options?: { model?: string; signal?: AbortSignal }): Promise<Result<readonly SlotState[]>>`
    - `GET /slots`。`model` があれば `/slots?model=<encodeURIComponent(model)>`（`props` と同じ）。
    - 配列の各要素から、`id`（0 以上の整数）と `is_processing`（真偽値）だけを読む。ほかのキー（`params`、`next_token` など）は読まずに捨てる（`z.object`）。
    - チャットの queue を通さない（`props` と同じ）。順番を決めようとしているバッチの後ろで待たないため。
    - HTTP 4xx/5xx は `network_failed`（`tellRefusal` は付けない）。形の違う応答は `response_invalid`。
- extension-core `testing/llama-stub.ts`:
  - `defaultResponder` は、`GET /slots` に `[{ id: 0, is_processing: false }, { id: 1, is_processing: false }]` を返す（`/props` の 2 枠に合わせる）。
  - `withSlots(responder: Responder, total: number, processing: () => readonly number[] = () => []): Responder`
    - `GET /props`: `responder` の答えのうち、`total_slots` だけを `total` にする。`modalities` はそのままなので、`withSlots(withoutAudio(defaultResponder), 3)` のように重ねられる。
    - `GET /slots`: 枠 0〜`total − 1` を返す。`processing()` にある枠だけ `is_processing: true`。
    - ほかのリクエストは `responder` に渡す。
- comment-assistant `src/subtitle-yield.ts`:

  ```ts
  export const SUBTITLE_YIELD = {
    busyWindowMs: 15_000,
    probeTtlMs: 1_500,
    probeTimeoutMs: 1_000,
  } as const;
  export type SubtitleYield = {
    /** コメントの枠に同時に送ってよい数: `concurrency`、字幕が枠 0 を使っている間は 1。 */
    limit(this: void, concurrency: number): number;
    dispose(this: void): void;
  };
  export function createSubtitleYield(deps: {
    /** 枠 0 が処理中か。 */
    probe: (signal: AbortSignal) => Promise<Result<boolean>>;
    now: () => number;
    timers: Timers;
    /** 問い合わせの結果が出た（失敗と時間切れを含む）。待っていたものを始められるかもしれない。 */
    changed: () => void;
  }): SubtitleYield;
  /** `/slots` の答えから、枠 0 が処理中か。枠 0 がなければ `response_invalid`。 */
  export function slotZeroBusy(slots: readonly SlotState[]): Result<boolean>;
  ```

  - `limit(concurrency)` の決め方:
    1. `concurrency` が 1 以下なら、そのまま返す。問い合わせない。
    2. まだ結果がない、または最後の結果（失敗を含む）から `probeTtlMs` 以上たった: 問い合わせを 1 つ始め（実行中なら新たに始めない）、結果が出るまでは 1 を返す。
    3. 最後の結果が失敗（エラー、`probeTimeoutMs` の時間切れ、`response_invalid`）: `concurrency`（今までどおり）。
    4. 最後の結果が成功: 枠 0 を処理中と最後に見てから `busyWindowMs` 未満なら 1。そうでなければ `concurrency`。
  - 問い合わせ:
    - `probeTimeoutMs` で中断し、失敗とする。後から届いた答えは捨てる。
    - 結果を記録してから `changed()` を 1 回呼ぶ。`limit` の中からは呼ばない。
    - `dispose()` は実行中の問い合わせを中断する。以後は問い合わせず、`limit` は `concurrency` を返す。
  - 値の理由（判断 S37）:
    - `probeTtlMs` 1,500: 字幕の 1 刻み（1.5 s）。問い合わせは、2 本目を始めたいときだけ、1 刻みに 1 回まで（1 分に 40 回まで）。チャットが速くても、バッチの数だけ増えることはない。
    - `busyWindowMs` 15,000（10 刻み）:
      - 字幕は話している間、1 刻みごとに枠 0 へ ASR を送り、訳す言語なら続けて翻訳を送る。Task 4 の待機時の値で、刻みの予定から ASR の応答までは 0.41〜0.47 s、翻訳の応答までは 0.72〜0.80 s。1 刻みのうち枠 0 が処理中の割合は、日本語の音声で約 3 割、訳す音声で約 5 割。
      - 問い合わせは、その瞬間の `is_processing` しか見ない。話している間でも、空きと答えることがある。10 回続けて空きと答える確率は、0.7^10 ≈ 3%（日本語）、0.5^10 ≈ 0.1%（訳す音声）。4 刻み（6 s）にすると 24% と 6% で、話している間に 2 本へ戻りすぎる。
      - 字幕をやめてから 2 本に戻るまでは、最長で 15 s + 1.5 s。
    - `probeTimeoutMs` 1,000: `/slots` は推論をしないので、ふつうは数 ms で答える。答えないサーバーのために、2 本目を待たせ続けない。

- comment-assistant `src/pipeline.ts`:
  - `createCommentPipeline` の deps に `subtitleSlotBusy?: (signal: AbortSignal) => Promise<Result<boolean>>` を足す。ないときは譲らない（今までどおり。既存のテストはそのまま通る）。
  - `subtitleSlotBusy` があるときだけ、`createSubtitleYield({ probe: deps.subtitleSlotBusy, now: deps.now, timers: deps.timers ?? systemTimers, changed })` を作る。`changed` は `setServerSlots` と同じ手順にする: `busy() < allowed()` なら `batcher.flush()`、続けて `pump()`、`deliver()`。
  - `allowed(): number` を足す。`busy() === 0` なら `concurrency`（問い合わせず、1 本目はすぐ始める）、そうでなければ `subtitles.limit(concurrency)`。
  - いま `concurrency` と比べている次の 4 か所を、`allowed()` と比べるようにする。
    - `pump()` の `while (busy() < concurrency)`（バッチを始める）
    - `grant()` の `busy() < concurrency`（要約とジャンルの推定の `exclusive`）
    - `ingest` の `if (busy() < concurrency) batcher.flush();`
    - `setServerSlots` の `if (busy() < concurrency) batcher.flush();`
  - `freeSlot()` と `highestFreeSlot()` は変えない（`concurrency` のまま）。譲っている間も、バッチは空いているいちばん小さい枠に入る。
  - 譲るのは、コメントの枠を使うものすべて（バッチ、要約、ジャンルの推定）。どれも同じ Gemma で生成するため（判断 S38）。
  - `dispose()` で `subtitles.dispose()` を呼ぶ。
- comment-assistant `src/runtime.ts`（`commentPipelines` の `build`）:
  - `createCommentPipeline` に `subtitleSlotBusy` を渡す。`client.slots({ model: models.translate, signal })` が成功なら `slotZeroBusy(slots.value)`、失敗ならその失敗を返す。
  - 尋ねるモデルは、コメントのバッチを送るモデル（`models.translate`）。① が同じモデルの枠 0 を使っているときだけ、同じ GPU の生成を取り合うため。① の設定は読まない（判断 S39）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// packages/extension-core/src/llm.test.ts
it.each([
  { name: 'ルーター', model: 'gemma4-e4b', search: '?model=gemma4-e4b' },
  { name: 'モデルなし', model: undefined, search: '' },
])('slots reads id and is_processing from GET /slots: $name', async ({ model, search }) => {
  /* 応答 [{ id: 0, id_task: 12, n_ctx: 4096, is_processing: true, params: {} }, { id: 1, is_processing: false }]
     → Ok([{ id: 0, processing: true }, { id: 1, processing: false }])。呼び出しは GET /slots + search の 1 回 */
});
it.each([
  {
    name: 'HTTP 501',
    status: 501,
    body: { error: { code: 501, message: 'not supported' } },
    code: 'network_failed',
  },
  { name: '配列でない', status: 200, body: { slots: [] }, code: 'response_invalid' },
  { name: 'is_processing がない', status: 200, body: [{ id: 0 }], code: 'response_invalid' },
])('slots fails: $name', async ({ status, body, code }) => {
  /* ... */
});
it('slots does not wait behind the chat queue', async () => {
  /* queue の concurrency 1 で、答えない chat を 1 つ走らせたまま slots() → 答えが返る */
});

// packages/extension-core/testing/llama-stub.test.ts
it('answers GET /slots with two idle slots by default', async () => {
  /* 本物の client で slots({ model: 'stub-model' }) → [{ id: 0, processing: false }, { id: 1, processing: false }] */
});
it('withSlots sets the slot count and reports the processing slots', async () => {
  /* withSlots(withoutAudio(defaultResponder), 3, () => [0]):
     props → { totalSlots: 3, audio: false }、slots → [{ 0, true }, { 1, false }, { 2, false }] */
});

// packages/comment-assistant/test/unit/subtitle-yield.test.ts（pipeline.test.ts と同じ fake clock の timers と now）
it.each([
  { name: '枠 0 が処理中', answer: Ok(true), limit: 1 },
  { name: '枠 0 が空き', answer: Ok(false), limit: 2 },
  { name: '問い合わせの失敗', answer: Err(failure('network_failed')), limit: 2 },
  { name: '枠 0 のない答え', answer: Err(failure('response_invalid')), limit: 2 },
])('limit(2) once the probe answers: $name → $limit', async ({ answer, limit }) => {
  /* 答える前の limit(2) は 1 で、probe は 1 回。答えた後: changed 1 回、limit(2) === limit */
});
it('stays at 1 until 15 s after slot 0 was last seen processing', async () => {
  /* t=0 に処理中。以後 1,500 ms ごとに空き。t=13,500 の答えの後も 1、t=15,000 の答えの後は 2 */
});
it('asks at most once per 1.5 s however often it is called', async () => {
  /* 0〜1,499 ms に limit(2) を 100 回 → probe 1 回。1,500 ms で 2 回目 */
});
it('treats a probe without an answer after 1 s as failed and aborts it', async () => {
  /* probe が答えない。1,000 ms 進める → signal.aborted、changed 1 回、limit(2) === 2。後から Ok(true) が届いても 2 のまま */
});
it('never asks when one batch is all the server allows', () => {
  /* limit(1) === 1 を 10 回、probe 0 回 */
});
it('dispose aborts the running probe and asks no more', () => {
  /* signal.aborted。その後の limit(2) は 2 で、probe は増えない */
});
it.each([
  {
    name: '枠 0 が処理中',
    slots: [
      { id: 0, processing: true },
      { id: 1, processing: false },
    ],
    expected: Ok(true),
  },
  {
    name: '枠 0 が空き',
    slots: [
      { id: 1, processing: true },
      { id: 0, processing: false },
    ],
    expected: Ok(false),
  },
  {
    name: '枠 0 がない',
    slots: [{ id: 1, processing: true }],
    expected: Err(failure('response_invalid')),
  },
])('slotZeroBusy: $name', ({ slots, expected }) => {
  /* ... */
});

// packages/comment-assistant/test/unit/pipeline.test.ts（slotRecorder と gate の describe。setup に subtitleSlotBusy を渡せるようにする）
it.each([
  { name: '枠 0 が処理中', answer: Ok(true), slots: [1, 1] },
  { name: '枠 0 が空き', answer: Ok(false), slots: [1, 2] },
  { name: '問い合わせの失敗', answer: Err(failure('network_failed')), slots: [1, 2] },
])('gives way to subtitles on a 3-slot server: $name', async ({ answer, slots }) => {
  /* subtitleSlotBusy: vi.fn(async () => answer)。setServerSlots(3) の後、コメントを 1 件ずつ 3 回 ingest。
     probe は 1 回。処理中なら、門を開けるまでに送られたバッチは枠 1 の 1 つだけで、残りの 2 件は次のバッチで枠 1。
     空きか失敗なら、2 件目と 3 件目が 1 つのバッチで枠 2 に送られる。最後に recorder.slots が slots と一致 */
});
it('does not ask about slot 0 while one batch at a time is enough', async () => {
  /* 前のバッチが答えてから次のコメントを ingest、を 3 回 → probe 0 回 */
});
it('holds a summary back while a batch runs and subtitles use slot 0', async () => {
  /* setServerSlots(3)、probe は Ok(true)。バッチを門で止めたまま pipeline.exclusive(fn) → 門を開けてバッチが終わるまで fn は呼ばれない */
});

// packages/comment-assistant/test/browser/comments.spec.ts
for (const { name, processing, most } of [
  { name: 'slot 0 busy', processing: [0], most: 1 },
  { name: 'slot 0 idle', processing: [], most: 2 },
] as const) {
  test(`runs at most ${most} comment request(s) at once on a 3-slot server with ${name}`, async ({
    context,
    sidePanel,
    platform,
    llama,
  }) => {
    /* llama.respond = withSlots(responder, 3, () => processing)。responder はコメントの枠（id_slot ≥ 1）の chat を
       400 ms 遅らせ、同時に走っている数の最大を記録してから defaultResponder で答える。
       connect → openChat（fixtureLive04、rate 10）→ 8 s 待つ。
       期待値:
         - コメントの枠の chat が同時に走った数の最大が most
         - GET /slots?model= の回数が 1 以上、かつ ceil(テストの経過 ms / 1,500) + 1 以下 */
  });
}
```

- [ ] **Step 2: 失敗を確認する**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test && pnpm --filter @chrome-toolbox/comment-assistant test`
  - Expected: FAIL（`slots`、`withSlots`、`subtitle-yield.ts`、`subtitleSlotBusy` がない）
- [ ] **Step 3: 実装する**
  - extension-core（`slots`、`SlotState`、スタブ）を先に入れ、`pnpm --filter @chrome-toolbox/extension-core test` を通してから comment-assistant に進む。
  - comment-assistant: `subtitle-yield.ts`、pipeline の 4 か所、runtime。
  - Files の文書を直す。
- [ ] **Step 4: 通ることを確かめる**
  - Run: `pnpm --filter @chrome-toolbox/extension-core test && pnpm --filter @chrome-toolbox/comment-assistant test && pnpm --filter @chrome-toolbox/comment-assistant test:e2e && pnpm check`
  - Expected: PASS
- [ ] **Step 5: 実機での確認**
  - Task 16 Step 3 の (e) で確かめる（字幕を出している間、comment-assistant のリクエストがコメントの枠に同時に 1 本だけ）。Task 16 が先に終わっていたら、コントローラーが (e) だけを測り直し、結果を `docs/adoption.md` に足す。
- [ ] **Step 6: Commit**
  - `git commit -m "feat(comment-assistant): one comment batch at a time while subtitles use slot 0"`
