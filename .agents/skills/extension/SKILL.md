---
name: extension
description: Build, load and inspect the Chrome MV3 extensions (WXT) in packages/*, their shared extension-core library and their Playwright E2E. Use for extension entrypoints, side panels, background messaging, llama.cpp access, permissions or performance/leak work.
---

# Chrome extension development

Apply to packages whose manifest declares `starter.runtime: "extension"` (`subtitle-translator`, `comment-assistant`, `page-translator`) and to `packages/extension-core`. Read [AGENTS.md](../../../AGENTS.md), the owning `wxt.config.ts`, [quality rules](../../../docs/quality.md) and the [stack](../../../docs/stack.md). Check current WXT and Chrome extension API docs before adopting an API; record the decision in [adoption](../../../docs/adoption.md).

Boundaries: extensions never import each other or Node/server/native modules; shared behaviour goes in `extension-core` (portable, adapter-injected, no `wxt` import) or `packages/ui`. Imports are explicit; WXT auto-imports stay off. Every async port returns `Promise<Result<…>>`; named listeners hand async work to `launch`. Inference goes through the background service worker and the bounded `createQueue`; never call llama.cpp from a content script.

Performance is a requirement, not a polish step. Every listener, observer, port, timer and media stream registered by an entrypoint has a matching cleanup (`ctx.onInvalidated`, `pagehide`, returned disposers). Buffers and caches have explicit caps. Prefer event-driven work over polling. Extend the heap-bound E2E (`usedHeap` from `@chrome-toolbox/extension-core/testing`) whenever a feature keeps state across events.

## Loop

1. `pnpm env:setup` once (installs, runs `wxt prepare`), then `pnpm env:doctor`.
2. `pnpm dev -- subtitle-translator` starts WXT on a worktree-local port and prints `READY … load unpacked <dir>` when `dist/chrome-mv3-dev/manifest.json` is written. The browser is not auto-launched.
3. Load that directory: in an agent session with the optional `chrome-devtools` MCP server (`.mcp.json`), call `install_extension` with the absolute `dist/chrome-mv3-dev` path, then `list_extensions`, `list_pages` (includes the service worker), `navigate_page` to `chrome-extension://<id>/sidepanel.html`, `list_console_messages` / `evaluate_script`, and `reload_extension` after rebuilds. Without MCP, load it from `chrome://extensions` (Developer mode → Load unpacked).
4. Run targeted checks: `pnpm --filter @chrome-toolbox/<name> test` (Vitest with WXT's fake browser) and `pnpm --filter @chrome-toolbox/<name> test:e2e` (fresh production build loaded into Playwright's Chromium with a local llama.cpp stub; branded Chrome no longer accepts `--load-extension`).
5. Finish with `pnpm gate:pre-pr -- --base <base-sha>`.

A real llama.cpp server is optional for development (default `http://127.0.0.1:18083`, set up as in [llama-server](../../../docs/llama-server.md); LAN hosts are requested as optional host permissions at runtime). Tests must not depend on one. No Chrome Web Store upload or signing is implied by this skill.

## Benchmark

Model and ASR choices are measured with the local bench tools in `tools/bench/`, never guessed. The loop:

1. Start the servers (see prerequisites) and put real data in `bench-data/` (gitignored: utterances, chat and audio from real streams are never committed; `tools/bench/fixtures/` holds only self-written samples).
2. `pnpm bench:make-audio` builds the synthesized test audio into `bench-data/audio` (WAV files only).
3. Run `pnpm bench:translate -- --server <url> --model <name> --set bench-data/<dir> [--chat-batch 20]`, `pnpm bench:asr -- --engine whisper|llama --server <url> --set bench-data/audio/real --manifest bench-data/audio/real/manifest.jsonl`, `pnpm bench:clef -- --server <url> [--set bench-data/<file>.jsonl]`, `pnpm bench:slots -- --server <url> [--comment-streams 2]` and `pnpm bench:genre -- --server <url> --model <name> [--set <dir>]` (the comment genre categories, R62; default set `packages/extension-core/test/fixtures/genre-eval/`). Without `--set`/`--manifest` they read the self-written fixtures. Translate, ASR, Clef and genre write JSONL to `bench-data/results/`, and the first line is a `{"type":"meta"}` record with the git SHA, server build, model and settings. `bench:slots` prints a table only. The data formats, report columns and the llama.cpp/whisper.cpp interfaces relied on are in [adoption](../../../docs/adoption.md).
4. Record the decision, with model URLs, hashes, dates and measurements, in [adoption](../../../docs/adoption.md). Unmeasured values stay `PENDING`; never estimate.

Start the router server as described in [llama-server](../../../docs/llama-server.md) (`http://127.0.0.1:18083`, models gemma4-e4b, gemma4-e2b, clef-flash, parallel 3). In router mode every request needs `model`, so pass `--model <name>` to `bench:slots` (and the other benches); `/props` without a model has no `total_slots`.

Server prerequisites: llama.cpp b11475 or newer on Apple Silicon (Metal); the Clef server needs `-ub 2048` because a Clef prompt must fit in the micro-batch; the translation server needs `--parallel 3` (subtitles on slot 0, two comment batches on slots 1 and 2; `--parallel 2` keeps comments to one batch at a time) and non-thinking models (or `--reasoning-budget 0`). The default server is `http://127.0.0.1:18083`, where that router server listens; whisper.cpp (`http://127.0.0.1:8081`) is not used, and choosing it needs the user's confirmation (spec §10).
