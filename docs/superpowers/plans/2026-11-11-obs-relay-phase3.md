# OBS relay phase 3 implementation plan

**Goal:** Add portable relay orchestration and a compatible ResultFetch ingress.

**Spec:** `docs/superpowers/specs/2026-11-11-obs-comment-relay-design.md`, sections 5, 6.3, 7, 9 and 11.

**Architecture:** Normalize both fetch contracts at the shared network boundary. Run one bounded relay batch at a time with independent serial Clef and PLaMo queues, bounded TTL caches and generation cancellation. Contracts own the published comment schema; native IPC remains an application adapter.

**Execution:** Inline on the requested feature branch. Preserve pre-existing app/root changes. No commits or remote operations.

## Constraints and review focus

- Clef sees each entire comment individually; missing/invalid scores never publish.
- At most 64 waiting and 3 executing comments, 2,000 dedupe IDs and 500 entries per result cache; 10-minute TTL, 8-second waiting expiry, 30-second processing and recovery limits.
- A reset invalidates delayed results, aborts requests and releases timers/caches.
- HTTP statuses reach existing parsers; network exceptions become AppError and native diagnostic IDs survive.
- Translation failure publishes only Clef-approved original text; no hidden retry or idle polling.

## Task 1: Result transport

- [x] Add failing transport tests for Result responses, rejection normalization, HTTP refusal distinctions and bounded streamed bodies.
- [x] Implement shared transport helpers and adapt llm/toxicity ingress, preserving legacy signatures.
- [x] Run extension-core tests; confirm PLaMo remains client-based.

## Task 2: Relay pipeline

- [x] Add failing fake-clock tests covering filtering, translation request contracts, fallbacks, ordering, cancellation and bounds.
- [x] Define RelayComment and counters schemas in contracts.
- [x] Implement relay scheduler, independent model queues, caches/in-flight sharing, suppression and lifecycle; export `./relay`.
- [x] Extend boundary tests for TTL/LRU caps, deadlines, model/session changes and idle cleanup.

## Task 3: Verification and documentation

- [x] Document API, counters, lifecycle and transport compatibility with official API references.
- [x] Run extension-core and comment-assistant unit tests and pnpm check.
- [ ] Run the affected pre-PR gate from initial HEAD `7b4a8cf34aec5af07ab2b9fd14b978164c4b8a59`; report environment limitations without weakening checks.
- [x] Review final diff and preserve all pre-existing changes.

## Evidence and implementation decisions

- Head and initial input: `7b4a8cf34aec5af07ab2b9fd14b978164c4b8a59`; no commits.
- Legacy fetch stays on its original capture/Body settlement path. Native clients use the explicit `resultFetch` option, preserving all existing call sites and tests. Native Result bodies are limited to 64 KiB; legacy body limits are unchanged.
- A batch's total deadline starts at its oldest admission, including queue waiting. This conservatively expires newer batch peers together and never exceeds a member's 30-second limit.
- Invalid thresholds fail closed before inference. Reset clears the generation, both memo caches, ID cache, suppression and counters.
- Independent review found the deadline and invalid-threshold gaps; both were reproduced by failing tests and repaired.
- Node 24.21.0 / pnpm 12.11.2: related core tests 167/167, contracts 30/30 and comment-assistant 1286/1286 pass. Static checks and the extension-core root/relay build pass.
- Full core run reaches loopback `listen EPERM` in ASR, llama-stub and the new relay HTTP test; no assertions or tests were skipped/relaxed. Loopback and the complete pre-PR gate remain required in a socket-enabled environment.
- Environment setup recovered dependencies from a local cache; final setup cannot write the repo-local Git hook configuration under this sandbox. No Git/configuration approval or remote action was attempted.
