# bench

Node command-line benchmarks that measure models on a real llama.cpp server with the same client, prompts and parsers as the extensions (`@chrome-toolbox/extension-core`). Their results chose the models and settings recorded in [adoption](../../docs/adoption.md).

## Commands

Run a bench from anywhere in the repository with `pnpm --filter @chrome-toolbox/bench bench:<name> -- <options>`:

| Script             | What it does                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `bench:make-audio` | Synthesizes the test audio with macOS `say` into `bench-data/audio` (WAV files only)                           |
| `bench:translate`  | Measures subtitle and chat translation latency, and quality with `--judge-server`                              |
| `bench:asr`        | Measures speech recognition error rate, language accuracy and latency (`--repeat`, `--chunk-ms`)               |
| `bench:clef`       | Measures Clef's abuse judgment accuracy; its last line is `CLEF_MODE=<mode>`                                   |
| `bench:slots`      | Measures subtitle latency under comment load, with and without slot pinning; `--audio` adds speech recognition |
| `bench:genre`      | Measures the comment assistant's genre categories against the self-written sets (R62)                          |
| `bench:page`       | Compares Gemma batches with PLaMo per unit on page text: latency, failures, markers kept, first screen         |

The options, data formats and report columns are in [adoption](../../docs/adoption.md), and the server setup in [llama-server](../../docs/llama-server.md).

Relative paths (`--set`, `--manifest`, `--out` and their defaults) start at the repository root, wherever the bench runs from. Real stream data stays in the root's gitignored `bench-data/`, and results go to `bench-data/results/` unless `--out` names a file. The committed `fixtures/` hold only self-written samples, the default input. The genre bench reads `packages/extension-core/test/fixtures/genre-eval/` by default.

## Layout and checks

The package runs on Node, not in a browser: its modules live at the package root, outside `src/`, so the portable-library boundary check does not apply to them. The benches are `translate.ts`, `asr.ts`, `make-audio.ts`, `clef.ts`, `slots.ts`, `genre.ts` and `page.ts`; `datasets.ts`, `metrics.ts`, `results.ts`, `http.ts`, `generation.ts` and `paths.ts` are shared. Tests sit next to the modules (`*.test.ts`).

`test` runs the table-driven Vitest tests against fake servers; no model is needed. Node runs the TypeScript directly, so there is nothing to bundle: `build` type-checks the package (`tsc -p .`).
