# subtitle-translator (配信字幕翻訳)

Chrome MV3 extension that will show two-line subtitles (original language above, Japanese below) over YouTube videos and live streams, translated by a local llama.cpp server. Design: spec §6 in the [design spec](../../docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md); tasks: [subtitle-translator plan](../../docs/superpowers/plans/2026-10-28-subtitle-translator.md).

## Status

Skeleton. What exists:

- A background service worker that answers `llm/status` through a bounded queue (one request at a time, at most 16 waiting).
- A side panel with the shared `ConnectionPanel`: it saves the llama.cpp URL, asks for the host permission when needed and checks the server (`GET /health`, `GET /v1/models`).

Planned (not built):

- Subtitle tracks: read the caption track the YouTube player already fetched, translate ahead of the playback position, and draw the subtitles in sync.
- Speech: capture the tab's audio after a user action (`tabCapture` and an offscreen document), cut it into utterances, transcribe with `gemma4-e4b` audio input and translate within 2 seconds.
- A popup for display mode, subtitle source, per-channel glossary, server URL and models.

## Use

Only the connection check works today.

1. Start `llama-server` as described in [docs/llama-server.md](../../docs/llama-server.md).
2. Build: `pnpm --filter @chrome-toolbox/subtitle-translator build` (from the repository root).
3. In `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and select `packages/subtitle-translator/dist/chrome-mv3`.
4. Click the toolbar icon to open the side panel, enter the server URL (default `http://127.0.0.1:18083`) and press "接続を確認".

Permissions: `storage` and `sidePanel`; `tabCapture`, `offscreen` and `activeTab` for speech subtitles from the tab's audio (Alt+Shift+S starts and stops them; `activeTab` shows the captured tab's URL, so leaving www.youtube.com stops the capture); host access to `localhost` and `127.0.0.1`. Any other server host is an optional permission that Chrome asks for when you check that URL.

## Layout

| Path                            | Role                                                           |
| ------------------------------- | -------------------------------------------------------------- |
| `src/entrypoints/background.ts` | Service worker entry; the toolbar action opens the side panel. |
| `src/entrypoints/sidepanel/`    | Side panel (React) with the shared `ConnectionPanel`.          |
| `src/runtime.ts`                | Message routing and the side panel's connection adapter.       |
| `wxt.config.ts`                 | WXT build and the manifest (name, permissions).                |

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

- `test` runs the Vitest unit tests in `test/unit/` with WXT's fake browser (message routing, settings storage, cleanup).
- `test:e2e` builds the production extension and loads it into Playwright's Chromium with a local llama.cpp stub (`test/browser/`): connecting, an unreachable server and a bounded side panel heap. Install the browser once with the second command. No real server is needed.
