# subtitle-translator (配信字幕翻訳)

Chrome MV3 extension that shows two-line subtitles over YouTube videos and live streams: the original language above, Japanese below. A local llama.cpp server does the speech recognition and the translation; nothing goes to a cloud service. Design: spec §6 in the [design spec](../../docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md); tasks: [subtitle-translator plan](../../docs/superpowers/plans/2026-10-28-subtitle-translator.md).

## Use

1. Start `llama-server` as described in [docs/llama-server.md](../../docs/llama-server.md). Speech subtitles also need Gemma's audio projector (below).
2. Build: `pnpm --filter @chrome-toolbox/subtitle-translator build` (from the repository root).
3. In `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and select `packages/subtitle-translator/dist/chrome-mv3`.
4. Click the toolbar icon to open the side panel. Under "llama.cpp の接続", enter the server URL (default `http://127.0.0.1:18083`) and press "接続を確認".

Where the subtitles come from ("取得元" in the side panel):

- "自動" (the default): a video with a caption track (including auto-generated ones) uses it; the extension reads the track the player already fetched and translates ahead of the playback position. A live stream, or a video without a track, shows "字幕なし・Alt+Shift+S で音声字幕" on the player button and runs no inference until you start speech subtitles.
- "字幕トラック": the caption track only. "音声": speech subtitles only, after you start them.

Display: "日本語のみ", "原語と日本語" (the default), "原語のみ" or "オフ". Switch it with the small button at the top right of the player (Japanese → both → original → off), with Alt+Shift+J, or in the side panel ("表示"). Every tab follows at once. Japanese speech and Japanese tracks are shown as they are, on one line. "原語のみ" translates nothing; "オフ" processes nothing.

Speech subtitles:

- Start them with Alt+Shift+S on a watch page, or with the toolbar icon on a watch page whose caption path shows nothing (a live stream, a video without a track, or "音声" chosen as the source). The icon also opens the side panel. Chrome lets the extension capture a tab only after one of these actions, so the side panel cannot start the capture; it shows "ツールバーのアイコンか Alt+Shift+S で開始" and, on the captured tab, a "停止" button.
- One tab at a time: starting another tab stops the first. The tab's sound keeps playing.
- Processing runs only while the video is in front of you: the tab is visible, the player is on screen, the video plays unmuted and no ad shows, with the display not off. Otherwise the capture stays open but idle, and resumes by itself.
- The capture stops when you close the tab, press Alt+Shift+S or the icon again on the captured tab, press "停止", leave www.youtube.com, start another tab, or after 10 minutes without processing. Moving to another video within YouTube keeps it and switches the context and glossary.
- "話されている言語" in the side panel fixes the spoken language ("自動" detects it from the speech).

The side panel also shows the shown tab's state ("状態": source, spoken language, latency, segments it could not process in time and silent ones, and why it is not processing), asked when the panel opens, when the shown tab changes or finishes loading, when a capture starts or stops, and on "更新", never by polling; and a glossary per streamer ("用語集": up to 50 pairs; an empty translation keeps the source as it is).

## Audio projector

Speech recognition sends the audio to `models.asr` (default `gemma4-e4b`), which needs Gemma's audio projector (`mmproj`). The router preset leaves it commented out:

1. In `models.ini`, under `[gemma4-e4b]`, enable the line `mmproj = /path/to/models/gemma-4-E4B-it-mmproj.gguf` (Google's BF16 projector, [llama-server.md §3](../../docs/llama-server.md#3-write-the-router-preset)).
2. Restart the server.

Memory: the BF16 file (0.99 GB) is read into Gemma's process; with speech recognition in use it added about 1.2-1.4 GB of private memory (footprint 1.65-1.78 GB against 0.43 GB without a projector, measured 2026-11-06). ggml-org's Q8_0 projector used 0.4-0.5 GB less but was 4-17% slower, so BF16 is the recommended one ([adoption](../../docs/adoption.md#speech-recognition-and-slot-0-2026-11-06)).

Without the projector the side panel says "音声入力が使えません。llama.cpp のプリセットで mmproj を有効にして、サーバーを再起動してください（docs/llama-server.md）" and no capture starts; with it, "音声入力: 使えます". The answer comes from `GET /props?model=<models.asr>` (`modalities.audio`), asked when the panel opens and on "更新".

## Translation model

"字幕の翻訳" in the side panel chooses who translates the subtitles:

- "Gemma（既定）": `models.translate` (default `gemma4-e4b`), the same model as the comment extension.
- "PLaMo 3 Translate 2B（速い・任意）": `plamo-3-translate-2b` by Preferred Networks, optional and faster (121 ms against Gemma's 329 ms subtitle p50 on the tested server). You install it on the server yourself ([llama-server.md](../../docs/llama-server.md#plamo-3-translate)).

PLaMo is under the [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja). In short: personal and non-commercial use is free without registration; commercial use needs registration in advance and annual revenue of at most 1 billion yen; anyone who gives its translations to others must state "Built with PLaMo" and mark them as PLaMo output. While PLaMo is chosen, the side panel shows "Built with PLaMo" and a link to the license. Read the license itself before you use it.

A line goes to Gemma instead when the router does not list `plamo-3-translate-2b`, when a PLaMo request fails with an HTTP error, or when PLaMo does not know the line's language. While PLaMo is chosen, the side panel says so with one line per reason, the latest first (for example "PLaMo がエラーを返した 3 行を Gemma で訳しました"). An unreachable server is not retried with Gemma: the line stays in the original.

This repository contains no PLaMo outputs: the tests and fixtures use made-up translations.

## Permissions

- `storage`: the settings and the glossaries.
- `sidePanel`: the side panel.
- `tabCapture` and `offscreen`: speech subtitles capture the tab's audio and process it in an offscreen document.
- `activeTab`: shows the URL of the tab you started speech subtitles on, so leaving www.youtube.com stops the capture. It adds no install warning.
- Host access to `localhost` and `127.0.0.1` for the server. Any other server host is an optional permission that Chrome asks for when you check that URL.

## Privacy

The audio is never written to disk or to extension storage: it stays in bounded memory buffers until it is sent to your llama.cpp server, and no transcript history is kept (only the line on screen and the three sentences before it). The extension saves only its settings (server URL, model names, display, source, spoken language, translator) and the glossaries, in `chrome.storage.local`. It reads the caption track the player fetched. The one extra request to YouTube is at most one per video, made by the player when the extension puts back the caption language you had turned on.

## Layout

| Path                            | Role                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/entrypoints/background.ts` | Service worker entry: message routing, caption translation, the capture sessions, the shortcuts and the icon. |
| `src/entrypoints/sidepanel/`    | Side panel (React): state, display, speech, source, language, translator, glossary and connection.            |
| `src/entrypoints/offscreen/`    | Offscreen document: the tab's audio and the live speech pipeline.                                             |
| `src/panel.ts`                  | The side panel's port to storage and the service worker.                                                      |
| `src/runtime.ts`                | Message routing in the service worker.                                                                        |
| `wxt.config.ts`                 | WXT build and the manifest (name, permissions, commands).                                                     |

## Development

From the repository root:

```console
pnpm dev -- subtitle-translator
pnpm --filter @chrome-toolbox/subtitle-translator build
pnpm --filter @chrome-toolbox/subtitle-translator check
```

`pnpm dev` writes a development build to `dist/chrome-mv3-dev` and prints `READY … load unpacked <dir>`. The [extension skill](../../.agents/skills/extension/SKILL.md) has the full build, load and inspect loop.

## Tests

```console
pnpm --filter @chrome-toolbox/subtitle-translator test
pnpm --filter @chrome-toolbox/subtitle-translator exec playwright install chromium
pnpm --filter @chrome-toolbox/subtitle-translator test:e2e
```

- `test` runs the Vitest unit tests in `test/unit/` with WXT's fake browser: message routing and senders, settings and glossary storage, caption reading and translation, the overlay, the front state, the audio pipeline, the capture sessions and the side panel (Testing Library).
- `test:e2e` builds the production extension and loads it into Playwright's Chromium with a local llama.cpp stub (`test/browser/`): connecting, an unreachable server and a bounded side panel heap. Install the browser once with the second command. No real server is needed.
