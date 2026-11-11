# OBS relay phase 4 implementation

Input: `376aab939b3dff3886e42eb55b752742f73b701c`, branch `feat/obs-comment-relay`.
The supplied phase-4 task and design are the approved scope. Work stays on this branch; no commits or remote operations.

1. Add regression tests for strict wire decoding, UTF-16/safe integer limits, source URL normalization and sender/session checks.
2. Implement wire/source/settings with generated public errors. Settings recovery is an explicit `save_settings` action; preserve corrupt bytes until requested recovery. Renderer cannot supply model paths or tokens.
3. Implement bounded ingress/Channel ACK and session/settings generations. Reattach invalidates the old engine and resets source delivery/publication.
4. Implement loopback axum HTTP/SSE, bounded subscribers, exact Host/Origin/token checks and ordered shutdown. Test on real loopback sockets including overflow, reconnect and bind conflicts.
5. Implement the fixed-operation reqwest proxy and cancellation. Test fixed paths/models, redirects, response caps, HTTP status preservation and cancellation using loopback stubs.
6. Replace sample commands/capabilities/renderer tests; wire main/tray/close-hide. Keep e2e feature isolation and remove all sample CRUD.
7. Run cargo check/test/clippy/fmt, package test/build, generated errors check and affected repository gate. Record content identity and limitations in package evidence.

Review focus: stale sessions/generations; one unacknowledged batch; byte limits before typed decoding; unauthorized URL/Host/Origin; subscriber and request cleanup; corrupt settings preservation; no startup llama traffic.

Deferred by task: engine/reader integration, managed process/model acquisition, native model dialog implementation, real sites/models/OBS. Native remote IPC and hidden WebKit endurance remain acceptance checks.
