# chrome-toolbox

Chrome extensions (Manifest V3) that help Japanese-speaking viewers follow foreign-language live streams, live chat and web pages with a local LLM. Every inference runs on a [llama.cpp](https://github.com/ggml-org/llama.cpp) server that you run yourself, on the same computer or in your LAN. The extensions' UI is in Japanese.

Work in progress: the shared library and the comment extension (reading, showing and summarizing YouTube and Twitch chat) are implemented; the other two extensions are skeletons. The table below shows what each package does today.

## Packages

| Package                                                                            | Kind                  | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`comment-assistant`](packages/comment-assistant/README.md) (コメントアシスタント) | Chrome extension      | Reads YouTube live chat, YouTube video comments and Twitch chat from the page, translates and classifies them in batches with the stream title as context, judges abuse with Clef, answers repeats and stock reactions without the model, and translates, highlights, conceals (a labelled bar of the category's colour, revealed by a click) or hides them in the chat. The side panel summarizes the chat over the last 5, 15 or 30 minutes, sets filters per streamer, lists hidden comments for review and holds the settings with the stream's processing counters. |
| [`subtitle-translator`](packages/subtitle-translator/README.md) (配信字幕翻訳)     | Chrome extension      | Skeleton: service worker and a side panel that checks the server connection. Subtitles are planned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [`page-translator`](packages/page-translator/README.md) (ページ翻訳)               | Chrome extension      | Skeleton: service worker and a side panel that checks the server connection. Page translation is planned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [`extension-core`](packages/extension-core/README.md)                              | Library               | Implemented: llama.cpp client, message protocols, settings, prompts, bounded caches and queues, language guess, Clef judge, Playwright test fixtures.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [`ui`](packages/ui/README.md)                                                      | Library               | Shared React components, including the side panels' `ConnectionPanel`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [`contracts`](packages/contracts/README.md)                                        | Library               | `Result` type, generated error catalog and validation helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [`observability`](packages/observability/README.md)                                | Library               | Telemetry library from the project template. No extension uses it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [`web`](packages/web/README.md)                                                    | Cloudflare Worker app | Template sample app, kept for a future project and privacy page. Not deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tools/bench`                                                                      | CLI                   | Model benchmarks (`bench:*` scripts) used to choose the models; results are in [adoption](docs/adoption.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Extensions never import one another; shared code lives in `extension-core`, `ui` and `contracts`. The [design spec](docs/superpowers/specs/2026-10-28-chrome-ai-extensions-design.md) (Japanese) describes all three extensions, and the [plans](docs/superpowers/plans/) break them into tasks.

## Privacy

- Inference runs only on your llama.cpp server. The default is `http://127.0.0.1:18083`. Another host is contacted only after you enter its URL and allow the host permission that Chrome asks for.
- No cloud translation or LLM service is used, not even as an option. Stream audio and chat are never sent to an outside service.
- The comment extension is designed to read comments from the page itself: no YouTube or Twitch API, no chat WebSocket, no extra requests to the platforms. Comments are kept in memory, for at most 30 minutes or 5,000 comments per channel. The one exception is the hidden comments you review: their text, translation, category, Clef score, your verdict and its time are saved in `chrome.storage.local` (the newest 1,000) until you clear them in the side panel. Nothing is moderated or deleted.
- The extensions send no telemetry.
- Benchmark data taken from real streams stays in the gitignored `bench-data/`. The committed fixtures are self-written.

## Requirements

- Desktop Chrome with Developer mode, to load the unpacked extensions.
- [mise](https://mise.jdx.dev/getting-started.html), activated in your shell. It installs the pinned Node (24.21.0) and pnpm (12.11.2) from [`mise.toml`](mise.toml); review that file before `mise trust`.
- llama.cpp `llama-server` with the models, set up as in [docs/llama-server.md](docs/llama-server.md). The reference machine is an Apple M4 Max with 36 GB; the models may use up to 20 GB.
- For E2E tests only: Playwright's Chromium. Branded Chrome no longer accepts `--load-extension`, and the tests use a local stub instead of a real server.

## Getting started

1. Start `llama-server` as described in [docs/llama-server.md](docs/llama-server.md).
2. Install the tools and dependencies, then check the environment:

   ```console
   mise trust
   mise run setup
   pnpm env:doctor
   ```

   `mise run setup` installs pnpm and the locked dependencies, then runs `pnpm env:setup` (WXT type generation, local Git hooks). Run `pnpm env:setup` again after pulling dependency changes.

3. Build an extension and load it:

   ```console
   pnpm --filter @chrome-toolbox/comment-assistant build
   ```

   Open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and select `packages/comment-assistant/dist/chrome-mv3`. Click the extension's toolbar icon to open its side panel (for the comment assistant, open its "設定" tab), enter `http://127.0.0.1:18083` in "llama.cpp の接続先" and press "接続を確認". The panel lists the server's models when it is connected. Each extension keeps its own settings.

For development, `pnpm dev -- comment-assistant` builds into `dist/chrome-mv3-dev` on every change and prints `READY … load unpacked <dir>` once the manifest is written. The [extension skill](.agents/skills/extension/SKILL.md) describes the build, load and inspect loop, including the optional Chrome DevTools MCP server in `.mcp.json`.

## Development

```console
pnpm dev -- <package-directory>
pnpm check
pnpm test
pnpm build
pnpm gate:pre-pr -- --base <base-sha>
```

- `pnpm check` runs formatting, lint, type, documentation and dependency-boundary checks. `pnpm test` runs the tooling and package unit tests; `pnpm build` builds the packages.
- Run one package's tests while editing: `pnpm --filter @chrome-toolbox/<name> test`. Extension E2E builds the production extension and loads it into Playwright's Chromium: install the browser once with `pnpm --filter @chrome-toolbox/<name> exec playwright install chromium`, then run `pnpm --filter @chrome-toolbox/<name> test:e2e`.
- `pnpm gate:pre-pr -- --base <base-sha>` runs the checks for the changed packages and the packages that depend on them, before a pull request. Repository-local Git hooks check commits and pushes ([quality](docs/quality.md)).
- Benchmarks: `pnpm bench:make-audio` synthesizes test audio with macOS `say`; `pnpm bench:translate`, `pnpm bench:asr`, `pnpm bench:clef`, `pnpm bench:slots` and `pnpm bench:genre` (the comment assistant's genre categories against self-written sets, R62) need a running server. Their options, data formats and results are in [adoption](docs/adoption.md).
- Security scans: `pnpm security:setup`, then `pnpm security:check` ([security](docs/security.md)).

Expected failures use [Result and generated error contracts](docs/errors.md) instead of exceptions. [AGENTS.md](AGENTS.md) is the workflow for contributors and coding agents.

## Documentation

- [docs/llama-server.md](docs/llama-server.md): reproducible llama.cpp server setup and its measurements.
- [Adoption decisions](docs/adoption.md): versions, official sources, benchmark results and decisions.
- [Technology stack](docs/stack.md): what each package and tool uses and owns.
- [Quality](docs/quality.md), [security](docs/security.md) and [troubleshooting](docs/troubleshooting.md).
- [Template](docs/template.md): the repository tooling comes from a project template; this explains generation, `pnpm template:sync` and `pnpm app:new`. [Cloudflare](docs/cloudflare.md) covers `packages/web`, and [observability](docs/observability.md) the optional local telemetry stack.

## License

[Apache License 2.0](LICENSE). Model weights are not part of this repository; each model has its own license.
