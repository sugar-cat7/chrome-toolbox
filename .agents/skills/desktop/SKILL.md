---
name: desktop
description: Develop typed Tauri IPC, Rust commands, native capabilities and Desktop UI with actual target-OS tests and release isolation. Use for Desktop renderer, native or export changes.
---

# Desktop and Rust

Apply to Tauri SPA, native IPC, capabilities or export. Read [AGENTS.md](../../../AGENTS.md), [native guidance](../../../docs/native.md) and the owning Cargo/Tauri files. Research current Tauri/WebdriverIO SDK guidance before changing native APIs.

Use the package's renderer/unit, Rust, native and release test scripts. Keep IPC typed and narrow; native save uses a user-selected destination, never a caller-supplied arbitrary path. Test error/cancel behavior. Keep E2E plugins/capabilities/renderer mode behind the explicit test feature; release must start with the driver disabled. Validate on every required actual OS. Finish with reviewed capabilities and native evidence, not a renderer-only substitute. No signed/public distribution is authorized.
