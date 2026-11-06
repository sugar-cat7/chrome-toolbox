# page-translator (ページ翻訳)

Chrome MV3 extension that will translate ordinary web pages into Japanese with a local llama.cpp server while keeping their layout, and translate a selected passage in a small bubble. Design: spec §8 in the [design spec](../../docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md). It comes after the subtitle and comment extensions, and has no implementation plan yet.

## Status

Foundation. What exists:

- A background service worker that answers `llm/status` through a bounded queue (one request at a time, at most 16 waiting), and `page/start` from the extension's own pages only: it injects the page script into the tab's top frame and sends it the translate command.
- A popup (the toolbar button) with "このページを翻訳". It says so when Chrome does not let the extension into the page (`chrome://`, the Web Store).
- An options page (opens in a tab) with the shared `ConnectionPanel`: it saves the llama.cpp URL, asks for the host permission when needed and checks the server (`GET /health`, `GET /v1/models`).
- The page script (`content-scripts/page.js`), which is not in the manifest: it goes into a tab only when the viewer presses the toolbar button, and today only answers that it runs. Injected twice, the second copy leaves the page to the first.

Planned (not built): replace only text nodes and restore the original exactly; translate the visible part first and the rest as it scrolls into view; batch dynamically added content; per-site "always translate" and "never translate" lists; selection translation.

## Use

Only the connection check works today; pressing "このページを翻訳" does not change the page yet. The full guide comes with the translation itself.

1. Start `llama-server` as described in [docs/llama-server.md](../../docs/llama-server.md).
2. Build: `pnpm --filter @chrome-toolbox/page-translator build` (from the repository root).
3. In `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and select `packages/page-translator/dist/chrome-mv3`.
4. Open the options page (right-click the toolbar icon → "オプション"), enter the server URL (default `http://127.0.0.1:18083`) and press "接続を確認".

Permissions: `storage`, `activeTab`, `scripting` and `contextMenus`; host access to `localhost` and `127.0.0.1` only, so the extension reads no site until you press its button there. Any other server host is an optional permission that Chrome asks for when you check that URL. The shortcut `Alt+Shift+L` ("選択範囲を翻訳") is declared for selection translation, which comes later.

## Layout

| Path                              | Role                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/entrypoints/background.ts`   | Service worker entry.                                                                                     |
| `src/entrypoints/popup/`          | Popup (React): "このページを翻訳".                                                                        |
| `src/entrypoints/options/`        | Options page (React) with the shared `ConnectionPanel`.                                                   |
| `src/entrypoints/page.content.ts` | Page script, injected at run time into a tab's top frame (`registration: 'runtime'`).                     |
| `src/runtime.ts`                  | Message routing, the sender check (`senderKind`) and the options page's connection adapter.               |
| `src/protocol.ts`                 | Messages: `page/start` (extension pages → service worker), `page/command` (service worker → page script). |
| `src/control.ts`                  | Injecting the page script (`injectPage`; a refused page is `page_restricted`).                            |
| `src/content/claim.ts`            | One page script per isolated world (`claimPage`).                                                         |
| `wxt.config.ts`                   | WXT build and the manifest (name, permissions, shortcut).                                                 |

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

- `test` runs the Vitest unit tests in `test/unit/` with WXT's fake browser (message routing, who may send what, injection, the popup in jsdom, settings storage, cleanup).
- `test:e2e` builds the production extension and loads it into Playwright's Chromium with a local llama.cpp stub (`test/browser/`): the manifest asks for no site, the toolbar button lets the page script into a made-up page (`*.fixture.test`, pressed with CDP `Extensions.triggerAction`) and only that page, `page/start` from an extension page, the page hears no message from the extension, a reload leaves no stale claim, connecting from the options page, an unreachable server and a bounded options page heap. Install the browser once with the second command. No real server is needed.
