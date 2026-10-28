# super-starter

[Security checks and automatic remediation](docs/security.md) cover Trivy, Semgrep and Renovate security PRs. Run `pnpm security:setup` then `pnpm security:check`; unresolved HIGH/CRITICAL or ERROR findings block security CI.

## Development

Create a branch for your changes and open a pull request against `main`.

A portable application workspace: React/TanStack Start on Workers, a TypeScript Worker API, and an independent React/Tauri Desktop SPA. Applications and shared packages all live in `packages/*`.

Start with [AGENTS.md](AGENTS.md) for the development workflow and task skills. [Technology stack and ownership](docs/stack.md) maps every application, shared tool, test layer and CI configuration to its source of truth and update policy.

## Cold start

Install [mise](https://mise.jdx.dev/getting-started.html), enable it in your shell and trust this repository after reviewing `mise.toml`. On Windows use the official PowerShell/native installation; no Bash bootstrap is required. Node and aqua-backed pnpm are prepared by mise; Vite+ is a project dependency. Select the configuration before installing application dependencies:

```console
mise trust
mise run setup -- --name my-notebook --scope @my-team --preset web
```

The default preset is `web`; `--name` and `--scope` are mandatory without interaction. Choose `api`, `desktop`, `fullstack`, or `fullstack-desktop` (alias `fullstack+desktop`). Select optional `--features d1,kv,r2` for cloud applications; fullstack includes a Service Binding. Desktop-only installs no Cloudflare tools; web/API-only installs no Rust/Tauri. Desktop needs the OS prerequisites in [native guidance](docs/native.md). Maintainers preparing all reference packages use `mise run setup -- --reference`.

For an empty directory, run the dependency-free initializer from a reviewed template checkout:

```console
node tools/generators/cli.ts init --target ../my-notebook --name my-notebook --scope @my-team --preset fullstack --features d1 --no-install
```

Then enter the generated directory, trust mise and run setup. It contains its own blueprints, tools, skills, CI and license; no original repository access is required. GitHub Template clones use the same initialization rules. [Template generation](docs/template.md) explains dry-run, collisions, repeat runs, addition and upgrades.

## Common commands

```console
pnpm env:setup
pnpm env:doctor
pnpm dev
pnpm check
pnpm test
pnpm test:lighthouse
pnpm build
pnpm gate:pre-pr -- --base <base-sha>
pnpm gate:full
pnpm app:new -- --kind api --name jobs --features kv
pnpm template:verify
```

Root startup reads selected manifests, starts dependencies first, waits for health/ready and uses worktree-local ports/state. Use `pnpm dev -- web` or a selected `dev:<directory>` script for one app. Package scripts remain directly available through `pnpm --filter <scope>/<directory> <script>`. Ctrl-C shuts down owned processes. `env:doctor` is read-only and returns nonzero for missing selected prerequisites; setup is repeatable and installs local hooks without replacing existing user hooks.

Expected failures use [Result and generated error contracts](docs/errors.md). [Local observability and AI investigation](docs/observability.md) describes the optional OTel/ClickHouse stack, bounded MCP and investigation skill; ordinary setup does not install/start it.

The sample provides validated note CRUD, loading/empty/error UI, keyboard-accessible forms and JSON export. Without D1 it explicitly uses volatile sample data. D1 selection adds repeatable migrations, initial seed and restart persistence; KV/R2 add local read/write examples. Web uses same-origin API calls and SSR/hydration/routes; fullstack uses a Service Binding to an internal API. Desktop stays offline, calls typed Rust IPC and saves through a user-selected native destination. Samples can be replaced without changing the shared development tools.

Commands run without prompts and return nonzero on failure, missing tests or timeout. Builds are local artifacts, not deployments. [Quality/evidence](docs/quality.md) explains affected checks, index-safe Git hooks, CI, fault rehearsals and reports. [Troubleshooting](docs/troubleshooting.md) maps failures to the next action. [Adoption decisions](docs/adoption.md) record versions and official sources.

For Cloudflare, run `pnpm deploy:preflight -- --target api --environment local` (use a selected Worker directory). Remote dev preflight requires named account/resource configuration; see [Cloudflare guidance](docs/cloudflare.md). No production deploy, token provisioning, paid service, public package publication or signed Desktop release runs implicitly. [Native guidance](docs/native.md) covers unsigned OS builds and required native tests. [Template updates](docs/template.md) describe versioned reviewed migrations and the single Renovate configuration; connecting the external app is separate.

Cloudflare's standard CLI is project-local: `pnpm --filter <scope>/<worker> cf <command>`, or `pnpm run cf <command>` inside the selected package. API `dev` and `build` delegate to `cf dev` and `cf build`; Vite+ owns the installed Vite core. Use `cf cli search` to discover resource operations and the [Cloudflare command table](docs/cloudflare.md) for types, local data, checked delivery and the tested TanStack/D1/built-preview compatibility exceptions.
