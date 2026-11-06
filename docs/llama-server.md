# llama-server for the extensions

The extensions send every inference request to one llama.cpp `llama-server` that you run yourself, on the same machine or on a trusted machine in your LAN. Nothing is sent to a cloud service. This page reproduces the server used for the measurements in [adoption](adoption.md): llama.cpp in router mode with three models, listening on `http://127.0.0.1:18083`.

Tests never need this server: unit tests use fakes and the E2E tests start a local stub. You need it only to use the extensions or to run the `bench:*` tools.

## Tested setup

| Item      | Value                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| llama.cpp | [b11669](https://github.com/ggml-org/llama.cpp/releases/tag/b11669) (commit [`620d222`](https://github.com/ggml-org/llama.cpp/commit/620d2225cc436ab0b001e3200e590e3b286ef9ab), 2026-10-15), built from source with Metal |
| Machine   | Apple M4 Max, 36 GB memory, macOS 15.8.2                                                                                                                                                                                  |
| Budget    | Model memory up to 20 GB; Chrome runs on the same Mac (spec §9)                                                                                                                                                           |

Clef on Apple Metal needs llama.cpp b11475 or newer; older builds collapse Clef probabilities toward uniform (see the Clef sources in [adoption](adoption.md)).

## 1. Build llama.cpp

```console
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
git checkout b11669
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j --target llama-server
```

The binary is `build/bin/llama-server`. Metal is enabled by default on macOS ([build guide](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/docs/build.md#metal-build)). Router mode needs `LLAMA_SUBPROCESS`, which is on by default except for iOS, Android and WebAssembly ([`CMakeLists.txt`](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/CMakeLists.txt)).

The release page of the same tag also has prebuilt archives (`llama-b11669-bin-macos-arm64.tar.gz`). The measurements did not use them. A binary built on a newer macOS can fail to start on an older one: a binary built on macOS 26 stopped with a missing libSystem symbol on macOS 15.8.2. Build from source in that case.

## 2. Download the models

All three repositories are public on Hugging Face. The revisions below are the ones measured. `gemma4-e4b` and `clef-flash` are the extension defaults; `gemma4-e2b` is an optional, smaller translation candidate.

| Preset name                       | Repository and revision                                                                                                                      | File                               | Size    | SHA-256                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------- | ------------------------------------------------------------------ |
| `gemma4-e4b`                      | [google/gemma-4-E4B-it-qat-q4_0-gguf](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf) `4b4a2c1d584be7264f87aac328a1bc739ce81b6c` | `gemma-4-E4B_q4_0-it.gguf`         | 5.15 GB | `676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee` |
| `gemma4-e4b`                      | same                                                                                                                                         | `gemma-4-E4B-it-mmproj.gguf`       | 0.99 GB | `7498a37cb619e55f2fcf87eb931f56e99389ed6d432e4c5c66110694c0d65578` |
| `gemma4-e4b` draft                | [ggml-org/gemma-4-E4B-it-GGUF](https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF) `a69f018d7678a2b9f5e705f8903d6fb29b9b25dc`               | `mtp-gemma-4-E4B-it-Q4_0.gguf`     | 0.06 GB | `d19a11e4fd5019967d9296f77f4d3e139c8903909f70c3a9cf009c9af4b9b88d` |
| `gemma4-e2b`                      | [google/gemma-4-E2B-it-qat-q4_0-gguf](https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf) `675cff42a74c774d6cb76f76d8eacb49b48c9b93` | `gemma-4-E2B_q4_0-it.gguf`         | 3.35 GB | `fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634` |
| `clef-flash`                      | [ggml-org/Clef-Flash-GGUF](https://huggingface.co/ggml-org/Clef-Flash-GGUF) `6e2a164d70aae2af7fce86005da3f91805565b1d`                       | `Clef-Flash-Q4_K_M.gguf`           | 6.73 GB | `eef2968c238a80d49d340430f22410ea3db9934ad1c6fdb233a503cbf9a9b54e` |
| `plamo-3-translate-2b` (optional) | [pfnet/plamo-3-translate-2b-GGUF](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF) `232fbd7916519edecddfdae0beae7e76fe70453f`         | `plamo-3-translate-2b-Q4_K_M.gguf` | 1.81 GB | `f36d0813dd95573a852ab5d76e374c543632d9e292929e922bcdbf7e53b494e0` |

The Gemma projector (`mmproj`) is needed only for audio and image input, which the subtitle extension will use for speech recognition. Text-only use, including Clef's text judgments, needs no projector. The draft file is Google's multi-token-prediction drafter for the QAT E4B model (`google/gemma-4-E4B-it-qat-q4_0-unquantized-assistant`), converted to GGUF by ggml-org; a QAT target needs the drafter of the same precision. Check each model card for its license.

PLaMo 3 Translate 2B (Preferred Networks, released 2026-11-05) is an optional translation-only model, measured as a faster subtitle translator; Gemma stays the default for everything (see [PLaMo 3 Translate](#plamo-3-translate) below). It is under the [PLaMo Community License](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/blob/232fbd7916519edecddfdae0beae7e76fe70453f/LICENSE/en): personal and non-commercial use is free without registration; commercial use needs prior registration and annual revenue of at most 1 billion yen; anyone who gives its translations to others must state "Built with PLaMo" and mark them as PLaMo output. Download it only if those terms suit you. This repository contains no PLaMo outputs. Use the pinned revision: the first upload of 2026-11-04 embeds an older chat template.

```console
mkdir -p models && cd models
curl -fLO https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/gemma-4-E4B_q4_0-it.gguf
curl -fLO https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/gemma-4-E4B-it-mmproj.gguf
curl -fLO https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/a69f018d7678a2b9f5e705f8903d6fb29b9b25dc/mtp-gemma-4-E4B-it-Q4_0.gguf
curl -fLO https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/675cff42a74c774d6cb76f76d8eacb49b48c9b93/gemma-4-E2B_q4_0-it.gguf
curl -fLO https://huggingface.co/ggml-org/Clef-Flash-GGUF/resolve/6e2a164d70aae2af7fce86005da3f91805565b1d/Clef-Flash-Q4_K_M.gguf
# Optional: PLaMo 3 Translate 2B
curl -fLO https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/232fbd7916519edecddfdae0beae7e76fe70453f/plamo-3-translate-2b-Q4_K_M.gguf
shasum -a 256 *.gguf
```

## 3. Write the router preset

Router mode loads models on demand from a preset file ([server README, "Model presets"](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/tools/server/README.md#model-presets)). Each section name is the model name that requests use, and each key is a `llama-server` option without its leading dashes. Save this as `models.ini` and replace `/path/to/models` with your directory; absolute paths are recommended.

```ini
version = 1

[*]
ctx-size = 12288

[gemma4-e4b]
model = /path/to/models/gemma-4-E4B_q4_0-it.gguf
; Audio input for subtitle speech recognition: add it when you use subtitles.
; mmproj = /path/to/models/gemma-4-E4B-it-mmproj.gguf
; Multi-token-prediction drafter: speculative decoding with identical replies.
spec-type = draft-mtp
model-draft = /path/to/models/mtp-gemma-4-E4B-it-Q4_0.gguf
spec-draft-n-max = 3
threads = 2
poll = 0
lazy-mode = on

[gemma4-e2b]
model = /path/to/models/gemma-4-E2B_q4_0-it.gguf
threads = 2
poll = 0
lazy-mode = on

[clef-flash]
model = /path/to/models/Clef-Flash-Q4_K_M.gguf
ctx-size = 4096
batch-size = 2048
ubatch-size = 2048
threads = 1
poll = 0

; Optional: PLaMo 3 Translate 2B (translation only)
[plamo-3-translate-2b]
model = /path/to/models/plamo-3-translate-2b-Q4_K_M.gguf
no-prefill-assistant = true
threads = 2
poll = 0
```

Why these values:

- `ctx-size = 12288` goes with `--parallel 3` below. llama-server divides a model's context evenly among its slots, so each of Gemma's three slots keeps 4,096 tokens: slot 0 for subtitles, and slots 1 and 2 for two comment batches at once. Clef keeps its own 4096, which leaves about 1,365 tokens per slot; a Clef prompt is about 160 tokens.
- Per-model values belong in the preset, not on the command line. The router applies its own command-line options on top of every preset ([`server-models.cpp`](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/tools/server/server-models.cpp), "overlay router's own CLI args"), so `--ctx-size` on the command line would also replace Clef's 4096.
- `mmproj` appears only where audio or image input is needed. The server loads a projector whenever the preset names one. Without it, Clef's memory footprint fell from 1.15 GB to 0.25 GB and its text answers stayed identical; Clef image judgments are then unavailable.
- Gemma's projector is left out until subtitles use speech recognition. It is a 945 MiB BF16 file loaded into process memory rather than mapped; without it Gemma's resident memory fell from 4.35 GB to 3.29 GB (footprint 1.37 GB to 0.43 GB, GPU memory in use about 1.1 GB less), and 60 of 60 comment-batch replies stayed byte-identical (2026-11-02, A-B-B-A against the preset above with the projector).
- `spec-type = draft-mtp` with `model-draft` is speculative decoding with a multi-token-prediction drafter ([Leviathan et al. 2023](https://arxiv.org/abs/2211.17192); [Gloeckle et al. 2024](https://arxiv.org/abs/2404.19737)): the 59.7 MB drafter reads the target's hidden state and proposes up to `spec-draft-n-max` tokens, which the target verifies in one pass, so replies stay the target's own. `spec-type` must be given: auto-detection looks for `nextn.eh_proj` tensors this file does not have ([`common/arg.cpp`](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/common/arg.cpp), [`common/speculative.cpp`](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/common/speculative.cpp)). It works with grammar-constrained sampling, pinned slots and audio input. Measured on 2026-11-02 (A-B-B-A): decoding 85 → 119 tokens per second for one stream and 128 → 196 for two, comment-batch p95 800 → 715 ms, replay first-annotation p95 about −12%, GPU time per comment −9%, 60 of 60 replies byte-identical, draft acceptance 25%, about 130 MB more memory; subtitle latency under comment load rose from about 1.25 to 1.8 s at p95, still within the 3 s target. Keep these keys in the Gemma section only: on the router's command line they would reach Clef too, which cannot draft.
- `threads` and `poll`: llama.cpp keeps the input layer on the CPU even when every other layer runs on the GPU ([`src/llama-model.cpp`](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/src/llama-model.cpp)), and by default its CPU threads busy-wait for work (`--poll`, default 50, in [`common/arg.cpp`](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/common/arg.cpp)). With `threads = 2` and `poll = 0` the generating Gemma process used about 12% CPU instead of 237-406%, and generation became faster and steadier (see [Measurements](#measurements)). Clef ran equally fast with 1 or 2 threads.
- `lazy-mode = on` reads the rows of large tensors, such as Gemma 4's per-layer embeddings, from disk on demand instead of keeping them resident (`--lazy-mode` in `common/arg.cpp`). Gemma's resident memory fell from 6.5 GB to 4.5 GB. Its private footprint did not change.
- Clef's `batch-size` and `ubatch-size` of 2048: a Clef prompt must fit in one micro-batch (default 512, [#30073](https://github.com/ggml-org/llama.cpp/issues/30073)).

## 4. Start the server

```console
/path/to/llama.cpp/build/bin/llama-server \
  --host 127.0.0.1 --port 18083 \
  --models-preset /path/to/models.ini --models-max 3 \
  --parallel 3 \
  --gpu-layers all \
  --reasoning off \
  --cache-ram 0 \
  --sleep-idle-seconds 600 \
  --cors-origins localhost
```

| Option                     | Purpose                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host 127.0.0.1`         | Reachable only from this machine. The extensions can reach `localhost` and `127.0.0.1` without a permission prompt.                                                                                                                                                                                                                                                             |
| `--port 18083`             | The extensions' default URL is `http://127.0.0.1:18083`.                                                                                                                                                                                                                                                                                                                        |
| `--models-max 3`           | At most three models in memory (Gemma, Clef and PLaMo); loading another unloads the least recently used one. Only the router's command line sets it: presets drop `models-*` keys. Use 2 without PLaMo.                                                                                                                                                                         |
| `--parallel 3`             | Three slots per model. Subtitles use slot 0. The comment extension runs one batch per spare slot, so slots 1 and 2 carry two comment batches at once; with `--parallel 2` it runs one at a time. On a busy English chat one batch at a time could not keep up (see [adoption](adoption.md)). Two batches decoding together reach about 1.55 times the tokens per second of one. |
| `--gpu-layers all`         | Puts every layer that can be offloaded on the GPU (Metal).                                                                                                                                                                                                                                                                                                                      |
| `--reasoning off`          | No thinking tokens. The extensions also send `chat_template_kwargs: {"enable_thinking": false}`.                                                                                                                                                                                                                                                                                |
| `--cache-ram 0`            | Turns off the host-memory prompt cache (default 8192 MiB) to stay within the memory budget. Each slot still reuses its own prompt prefix (`cache_prompt`).                                                                                                                                                                                                                      |
| `--sleep-idle-seconds 600` | Unloads a model and its KV cache after 10 idle minutes ([server README, "Sleeping on Idle"](https://github.com/ggml-org/llama.cpp/blob/620d2225cc436ab0b001e3200e590e3b286ef9ab/tools/server/README.md#sleeping-on-idle)); the next request loads it again. A cold load took up to 13 s live, within the comment extension's 30 s request timeout.                              |
| `--cors-origins localhost` | With the default `*`, any web page may read the server's replies cross-origin; `localhost` limits that to local pages. The extensions' service workers reach the server through host permissions, not CORS.                                                                                                                                                                     |

The measured server also passed `--flash-attn auto` and `--load-mode auto`, which are the defaults. Check that the router answers:

```console
curl -s http://127.0.0.1:18083/v1/models
curl -s 'http://127.0.0.1:18083/props?model=gemma4-e4b'
```

The first lists the three preset names; the second loads `gemma4-e4b` and reports `total_slots: 3`. In router mode every request needs a `model`, and `/props` without one returns the router's own information without `total_slots`. With the server running, `pnpm --filter @chrome-toolbox/bench bench:slots -- --server http://127.0.0.1:18083 --model gemma4-e4b --comment-streams 2` measures subtitle latency while two comment streams use slots 1 and 2.

## 5. Keep it running on macOS

To start the server at login and restart it after a crash, use a launchd agent. Set `ProcessType` to `Standard`. With `Background`, launchd applies resource limits meant for work the user did not request (`man launchd.plist`, "ProcessType"): the server's threads ran at priority 4 instead of 20 (`ps -o pri`), and Gemma generated about 20-30% fewer tokens per second than with `Standard` under the same CPU settings (see [Measurements](#measurements)).

Save as `~/Library/LaunchAgents/local.llama-server.plist`, with the same arguments as above:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.llama-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/llama.cpp/build/bin/llama-server</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>18083</string>
    <string>--models-preset</string><string>/path/to/models.ini</string>
    <string>--models-max</string><string>3</string>
    <string>--parallel</string><string>3</string>
    <string>--gpu-layers</string><string>all</string>
    <string>--reasoning</string><string>off</string>
    <string>--cache-ram</string><string>0</string>
    <string>--sleep-idle-seconds</string><string>600</string>
    <string>--cors-origins</string><string>localhost</string>
  </array>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/path/to/llama-server.log</string>
</dict>
</plist>
```

```console
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.llama-server.plist
launchctl bootout gui/$(id -u)/local.llama-server
```

The first command starts the agent; the second stops and unloads it. `Interactive` measured within 1% of `Standard`, but launchd reserves it for jobs that an app's responsiveness depends on.

## 6. Extension settings

Each extension keeps its own settings in `chrome.storage.local` (key `settings`, schema `settingsSchema` in `packages/extension-core/src/settings.ts`).

| Setting            | Default                  | Server side                                                                                    |
| ------------------ | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `llamaBaseUrl`     | `http://127.0.0.1:18083` | `--host` and `--port`. Set it in the side panel field "llama.cpp の接続先", then "接続を確認". |
| `models.translate` | `gemma4-e4b`             | Preset section `[gemma4-e4b]`: comment translation and classification.                         |
| `models.asr`       | `gemma4-e4b`             | The same section once `mmproj` is added back: speech recognition for subtitles (planned).      |
| `models.clef`      | `clef-flash`             | Preset section `[clef-flash]`: abuse judgments through `POST /v1/systemone`.                   |

The side panel edits the URL. The comment extension's "設定" tab also edits the model names sent to the router ("翻訳モデル" for `models.translate`, "Clef モデル" for `models.clef`); the other extensions use the defaults, so keep the preset section names as above. "接続を確認" calls `GET /health` and `GET /v1/models` and shows the model names.

A failed Clef request never fails a comment batch: when Clef is unreachable, times out or answers an HTTP error for that request (such as a 503 while the router loads the model), those comments keep the translation model's category and "設定" shows the error. When Clef is not there (HTTP 501 for a model that is not a decision model, 404, or the router's 400 "model '<name>' not found"), the comment extension classifies abuse with the translation model from then on, until its settings change.

A server on another machine: start it with `--host` set to an address in your LAN, enter `http://<address>:18083` in the side panel, and allow the host permission that Chrome then asks for. The extensions send no API key, so expose such a server only on a network you trust.

## PLaMo 3 Translate

The extensions do not send requests to PLaMo yet. The subtitle extension's plan adds it as an optional translator. Measured on 2026-11-06 on this server (llama.cpp 620d222 runs it; the minimum is [b11455](https://github.com/ggml-org/llama.cpp/releases/tag/b11455), [#30045](https://github.com/ggml-org/llama.cpp/pull/30045)), with 40 made-up spoken sentences in English, Korean, Spanish, Indonesian and Chinese, and 40 English chat lines:

| Model                    | Subtitle sentence p50 / p95 | Under two comment streams (p50 / p95) | Peak RSS    | Subtitles against Gemma (better / same / worse) |
| ------------------------ | --------------------------- | ------------------------------------- | ----------- | ----------------------------------------------- |
| `gemma4-e4b` (MTP)       | 329 / 443 ms                | 854 / 1,118 ms                        | 4.92 GB     | –                                               |
| PLaMo 3 Translate 0.8B   | 46 / 66 ms                  | 109 / 167 ms                          | 0.88 GB     | 3 / 19 / 18                                     |
| **PLaMo 3 Translate 2B** | **121 / 163 ms**            | **179 / 249 ms**                      | **2.47 GB** | **5 / 25 / 10**                                 |
| PLaMo 3 Translate 8B     | 352 / 450 ms                | –                                     | 5.89 GB     | 4 / 29 / 7                                      |

- The quality grading was blind A/B by Claude, without a human check.
- The 2B returned the translation alone every time and kept glossary names (9 of 9).
- It was about as good as Gemma on English, Chinese and Indonesian, and worse on Korean and Spanish gaming slang (`궁`, an ultimate, became 宮).
- The 0.8B produced nonsense lines. The 8B is no faster than Gemma.
- On chat, every size translated slang literally (`she's cooking` → 料理してる). PLaMo cannot classify comments, so the comment extension stays on Gemma.
- With Gemma, Clef and the 2B resident, the router's processes used 12.4 GB in total.

A client must:

- send the line as the only user message
- send `chat_template_kwargs` with `target_lang: "ja"`, an optional lowercase `source_lang` (`zh-hans`, not `zh-CN`, which is a 400), optional `context` (earlier lines) and optional `glossary` (`[{"source", "target"}]`)
- send `stop: ["<|plamo:tag|>", "<|plamo:bos|>"]`

A client must not send `response_format` or a JSON schema (the reply breaks), a `grammar`, or an instruction system turn (it is read as context). An empty line, or one containing `<|plamo:`, is a 400.

The model embeds its chat template at the pinned revision; `no-prefill-assistant` is required by its card.

Retest when [#30337](https://github.com/ggml-org/llama.cpp/pull/30337) merges: the GGUF asks for YaRN `truncate=false`, which no build applies to PLaMo yet, and Metal treats that rope as unsupported since [#30206](https://github.com/ggml-org/llama.cpp/pull/30206).

## Measurements

Measured on 2026-10-28 on the tested setup above, then with `--parallel 2` and `ctx-size = 8192`, with the server started by launchd on a separate port that no other client used. Each configuration sent the same comment-batch request (an earlier JSON-schema version of the comment prompt: 3 comments, 119 output tokens, temperature 0, `cache_prompt`) once to warm up and three times measured, in two rounds of reversed order; ranges cover both rounds. Other applications were running (load average 4-6). CPU is CPU time over wall time while generating, RSS the largest resident size of the model process, and footprint the private memory reported by macOS `footprint`.

| `ProcessType` | CPU and projector settings               | Gemma tok/s   | s per request | Gemma CPU      | Gemma RSS        | Clef footprint   | Cold load + first request |
| ------------- | ---------------------------------------- | ------------- | ------------- | -------------- | ---------------- | ---------------- | ------------------------- |
| Background    | llama.cpp defaults, projector everywhere | 35.8-36.0     | 3.44-3.48     | 237-254%       | 6.5 GB           | 1.14-1.15 GB     | 5.0-5.5 s                 |
| Standard      | llama.cpp defaults, projector everywhere | 52.1-52.5     | 2.35-2.37     | 383-406%       | 6.6-6.7 GB       | 1.16-1.17 GB     | 1.9-2.0 s                 |
| Background    | preset above                             | 66.8-67.5     | 1.86-1.88     | 28.1-28.7%     | 4.35 GB          | 0.25 GB          | 4.1-4.3 s                 |
| **Standard**  | **preset above**                         | **84.1-84.2** | **1.47**      | **11.8-12.3%** | **4.46-4.51 GB** | **0.24-0.25 GB** | **1.45-1.47 s**           |
| Interactive   | preset above                             | 84.5-84.9     | 1.45-1.46     | 10.0-11.3%     | 4.45 GB          | 0.25 GB          | 1.2 s                     |

Gemma is `gemma4-e4b`. Reading:

- From the first row to the adopted one, generation went from 35.9 to 84.2 tokens per second and a comment batch from 3.46 s to 1.47 s. `ProcessType` and the CPU settings each contribute; neither alone reaches the adopted row.
- With llama.cpp's default threads and polling, `Standard` once reached 82.5 tokens per second but gave 52 in both clean rounds: the busy-waiting threads compete with other busy processes. `threads = 2` and `poll = 0` gave 84 every time.
- Clef's warm `/v1/systemone` answer took 528-557 ms in the first row and 480-484 ms in the adopted one.
- Trade-off: an uncached 1,200-token prompt is evaluated 4% slower (1,112 against 1,159 tokens per second without the CPU settings). Comment prompts mostly reuse the cached prefix.
- `lazy-mode = auto` (the default) kept 6.64 GB resident at 79.9 tokens per second, so `on` stays.
- `gemma4-e2b`, started directly with the same options and no projector, generated 136-140 tokens per second with 1.7 GB resident.

Translation, speech recognition, Clef and slot benchmarks with this server are recorded in [adoption](adoption.md).
