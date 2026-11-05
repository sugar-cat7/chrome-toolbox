# page-translator (ページ翻訳)

Chrome MV3 extension that will translate ordinary web pages into Japanese with a local llama.cpp server while keeping their layout, and translate a selected passage in a small bubble. Design: spec §8 in the [design spec](../../docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md). It comes after the subtitle and comment extensions, and has no implementation plan yet.

## Status

Skeleton. What exists:

- A background service worker that answers `llm/status` through a bounded queue (one request at a time, at most 16 waiting).
- A side panel with the shared `ConnectionPanel`: it saves the llama.cpp URL, asks for the host permission when needed and checks the server (`GET /health`, `GET /v1/models`).

Planned (not built): replace only text nodes and restore the original exactly; translate the visible part first and the rest as it scrolls into view; batch dynamically added content; per-site "always translate" and "never translate" lists; selection translation.

## Use

Only the connection check works today.

1. Start `llama-server` as described in [docs/llama-server.md](../../docs/llama-server.md).
2. Build: `pnpm --filter @chrome-toolbox/page-translator build` (from the repository root).
3. In `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and select `packages/page-translator/dist/chrome-mv3`.
4. Click the toolbar icon to open the side panel, enter the server URL (default `http://127.0.0.1:18083`) and press "接続を確認".

Permissions: `storage` and `sidePanel`; host access to `localhost` and `127.0.0.1`. Any other server host is an optional permission that Chrome asks for when you check that URL.

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
pnpm dev -- page-translator
pnpm --filter @chrome-toolbox/page-translator build
pnpm --filter @chrome-toolbox/page-translator check
```

`pnpm dev` writes a development build to `dist/chrome-mv3-dev` and prints `READY … load unpacked <dir>`. The [extension skill](../../.agents/skills/extension/SKILL.md) has the full build, load and inspect loop.

## Tests

```console
pnpm --filter @chrome-toolbox/page-translator test
pnpm --filter @chrome-toolbox/page-translator exec playwright install chromium
pnpm --filter @chrome-toolbox/page-translator test:e2e
```

- `test` runs the Vitest unit tests in `test/unit/` with WXT's fake browser (message routing, settings storage, cleanup).
- `test:e2e` builds the production extension and loads it into Playwright's Chromium with a local llama.cpp stub (`test/browser/`): connecting, an unreachable server and a bounded side panel heap. Install the browser once with the second command. No real server is needed.
