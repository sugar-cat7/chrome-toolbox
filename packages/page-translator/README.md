# page-translator (ページ翻訳)

Chrome MV3 extension that translates ordinary web pages into Japanese with a local llama.cpp server while keeping their layout, and translates a selected passage in a small bubble. Design: spec §8 in the [design spec](../../docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md).

## Status

Working. What exists:

- Pressing the toolbar button "このページを翻訳" (or the "ページを翻訳" context-menu item) injects the page script into the tab's top frame only — the extension reads no site until then. `chrome://` pages and the Web Store are refused.
- The page script translates the visible part first, then the rest as it scrolls into view, in bounded batches through the service worker's bounded queue. Two display modes: `replace` (the text becomes Japanese in place) and `pair` (original above, Japanese below). "元に戻す" restores the page exactly — links, emphasis and forms are never rewritten, only their text nodes.
- Marked units (links, emphasis, kept code) go to Gemma in batches; plain paragraphs go to PLaMo 3 Translate 2B one at a time on slots 1 and 2 — the bench's decision in [adoption](../../docs/adoption.md). A PLaMo failure or an unreadable reply falls back to Gemma for that unit only.
- "選択範囲を翻訳" (context menu or `Alt+Shift+L`) translates the selected text in a small bubble without touching the page.
- The options page holds the server connection (shared `ConnectionPanel`), the display mode, the translator (`plamo`/`gemma`), and per-site "always translate" / "never translate" host lists. Bank sites are never translated.
- Iframes are not translated; closed Shadow DOM and translatable attributes are out of scope (see spec §8).

## Use

1. Start `llama-server` as described in [docs/llama-server.md](../../docs/llama-server.md); the router needs `plamo-3-translate-2b` listed for the default translator.
2. Build: `pnpm --filter @chrome-toolbox/page-translator build` (from the repository root).
3. In `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and select `packages/page-translator/dist/chrome-mv3`.
4. Open the options page (right-click the toolbar icon → "オプション"), enter the server URL (default `http://127.0.0.1:18083`) and press "接続を確認".
5. On an English page, press the toolbar button. Scroll to translate more; press the button again (or the menu item) to restore.

Permissions: `storage`, `activeTab`, `scripting` and `contextMenus`; host access to `localhost` and `127.0.0.1` only, so the extension reads no site until you press its button there. Any other server host is an optional permission that Chrome asks for when you check that URL.

## Layout

| Path                              | Role                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/entrypoints/background.ts`   | Service worker entry; context menu, `page/start` routing.                                         |
| `src/entrypoints/popup/`          | Popup (React): "このページを翻訳".                                                                |
| `src/entrypoints/options/`        | Options page (React): connection, display mode, translator, site lists.                           |
| `src/entrypoints/page.content.ts` | Page script, injected at run time into a tab's top frame (`registration: 'runtime'`).             |
| `src/runtime.ts`                  | Message routing, the sender check (`senderKind`) and the options page's connection adapter.       |
| `src/protocol.ts`                 | Messages and settings enums (`DISPLAY_MODES`, `PAGE_TRANSLATORS`).                                |
| `src/settings.ts`                 | Page settings schema, migration (v1 `gemma` → `plamo`), host-pattern matching for the site lists. |
| `src/translator.ts`               | Unit→request routing: PLaMo for plain units, Gemma batches for marked units and fallbacks.        |
| `src/content/session.ts`          | One translation session per tab: state machine, restore.                                          |
| `src/content/segment.ts`          | Page segmentation: text nodes → units with link/emphasis/code markers.                            |
| `src/content/scheduler.ts`        | Viewport-first scheduling; batches on scroll.                                                     |
| `src/content/writer.ts`           | `replace`/`pair` writers and exact restore of text nodes.                                         |
| `src/content/overlay.ts`          | Selection-translation bubble.                                                                     |
| `src/language.ts`                 | Source-language detection for the page.                                                           |
| `src/control.ts`                  | Injecting the page script (`injectPage`; a refused page is `page_restricted`).                    |
| `src/content/claim.ts`            | One page script per isolated world (`claimPage`).                                                 |
| `wxt.config.ts`                   | WXT build and the manifest (name, permissions, shortcut).                                         |

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

- `test` runs the Vitest unit tests in `test/unit/` with WXT's fake browser (message routing, who may send what, injection, segmentation, translation routing and PLaMo readback, settings migration, the popup in jsdom, cleanup).
- `test:e2e` builds the production extension and loads it into Playwright's Chromium with a local llama.cpp stub (`test/browser/`): the manifest asks for no site, the toolbar button lets the page script into a made-up page (`*.fixture.test`, pressed with CDP `Extensions.triggerAction`) and only that page, `page/start` from an extension page, the page hears no message from the extension, a reload leaves no stale claim, connecting from the options page, an unreachable server, layout/scroll/restore/perf/soak checks, and a bounded options page heap. Install the browser once with the second command. No real server is needed.
- `load.spec.ts`, `measure.spec.ts`, `public.spec.ts` and `restorecheck.spec.ts` self-skip unless `MEASURE_REAL=1` is set; they drive the production build against a real llama.cpp router (and public English sites for `public.spec.ts`) for the measurements recorded in [adoption](../../docs/adoption.md). `MEASURE_SERVER` overrides the server URL.
