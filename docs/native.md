# Native prerequisites and verification

The selected Desktop package owns `src-tauri/rust-toolchain.toml`, Cargo.lock, Tauri config/capabilities and its SPA. Web/API-only projects install no Rust or Tauri package. Install rustup using its [official installation](https://rustup.rs/) for your existing development environment; setup activates the package's pinned toolchain. No root Rust pin is duplicated in mise.

Follow [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): macOS Xcode command-line tools; Windows MSVC C++ tools and WebView2; Linux GTK3, WebKitGTK 4.1, libayatana-appindicator, librsvg, patchelf and build tools. On an environment you cannot provision, doctor reports the missing libraries. CI's standard hosted Linux image installs those packages, Xvfb, `dbus-x11` and `at-spi2-core`; headless native checks run inside `dbus-run-session -- xvfb-run -a` so WebKit has an owned session bus and its accessibility service. See the [SDK adoption evidence](adoption.md) for this prerequisite. A Linux result does not certify Windows/macOS.

The package scripts `test:rust`, `test:native`, `test:release`, `build` and optional `build:bundle` operate independently. `pnpm build` builds each selected package; Desktop's ordinary build is unsigned and has no bundle/publication step. Signed installers, certificates, notarization and distribution require separate authorized work.

Native E2E follows the [current Tauri recommendation](https://v2.tauri.app/develop/tests/webdriver/) and [embedded WebdriverIO setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup). Cargo feature `e2e`, test config/capabilities, renderer mode and target directory are separate. It starts the real app on Linux/macOS/Windows and invokes real Rust CRUD, cancel/error/export and denied unknown commands. A test-only process environment chooses an export fixture; production IPC accepts no path. Normal release rebuilds without the feature/import/global API, checks dependency/capability/frontend isolation, starts the native window and verifies that setting the test driver port cannot enable a listener.

User-selected native dialog interaction is distinct from the controlled E2E fixture. Remote connections, public distribution and signing have not been performed by setup or CI.

If an existing Linux environment provides Docker but cannot install system libraries, the optional `tools/dev-environment/native.Dockerfile` provisions the same official prerequisites. This is still Linux validation. It uses standard package commands and no privileged container or host networking. Build an image, mount this project and the tools selected by mise, then work inside it:

```sh
mise install
docker build --build-arg DEVELOPMENT_UID="$(id -u)" -f tools/dev-environment/native.Dockerfile -t starter-native-dev tools/dev-environment
STARTER_NODE_DIR="$(mise where node)"
STARTER_PNPM_DIR="$(mise where aqua:pnpm/pnpm)"
mkdir -p .state/container-home .state/container-tmp
docker run --rm --init -it \
  --mount "type=bind,src=$PWD,dst=/project" \
  --mount "type=bind,src=$PWD/.state/container-home,dst=/home/developer" \
  --mount "type=bind,src=$PWD/.state/container-tmp,dst=/tmp" \
  --mount "type=bind,src=$STARTER_NODE_DIR,dst=/opt/node,readonly" \
  --mount "type=bind,src=$STARTER_PNPM_DIR/pnpm,dst=/usr/local/bin/pnpm,readonly" \
  --env PATH=/opt/node/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
  --env CARGO_HOME=/home/developer/.cargo \
  starter-native-dev bash
pnpm env:setup
pnpm env:doctor
dbus-run-session -- xvfb-run -a pnpm dev -- desktop
dbus-run-session -- xvfb-run -a pnpm gate:full
```

For non-interactive execution omit `-it` and append `bash -c '<command>'`. A managed network may require its approved CA during image build (`--secret id=system_ca,src=<public-ca-bundle>`) and runtime; use the environment's documented trust/proxy configuration without disabling certificate verification. Cache only this project's `.state`/dependencies and an owned Cargo registry volume. Git operations use the mounted repository's local hooks; Docker and Rust are unnecessary for presets without Desktop.

The pinned embedded driver returns from refresh before WebKit has replaced the document. Native regression tests mark the old document, yield 100 ms to its queued unload, then require a new complete document and the installed plugin initialization before subsequent Rust/DOM operations. This handoff is not a success condition; the existing 30-second test timeout and all assertions remain active. The behavior and typed plugin globals were checked against the installed 1.5.0 service SDK and real Linux windows.

Expected native failures use the catalog-generated `AppError`/`PublicError`, never `Result<_, String>`. Command wrappers record internal failure before IPC projection and accept only trace context from the renderer. Optional native telemetry writes standard OTLP JSONL to an existing private diagnostics directory; see [observability](observability.md). Real OS E2E evidence includes SHA/content identity, scenario/run and all three signals. The portable module compatibility spike is separate from actual Tauri/native validation.

Windows process ownership is implemented by the repository's existing PowerShell launcher and a short-lived per-launch Job guardian. They use standard Win32 APIs with no extra installed service. The guardian confirms zero active owned processes before cleanup succeeds; launcher exit alone is insufficient. It never terminates a sibling Job. Guard, acknowledgement or cleanup-deadline failures remain failures. See [the compatibility record](adoption.md) and real Windows regressions.
