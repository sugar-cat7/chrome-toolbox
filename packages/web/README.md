# web

React and TanStack Start app on Cloudflare Workers, generated from the project template. It is kept as the place for a future project and privacy page for the extensions; it has no such page yet and is not deployed.

## Status

Template sample, unchanged in purpose: server rendering with hydration, the routes `/` (a notes list using `NotesPanel` from [`ui`](../ui/README.md) and a same-origin notes API) and `/about`. Notes are volatile sample data that reset when the Worker restarts. Telemetry goes through [`observability`](../observability/README.md) and is exported only when a local Collector endpoint is configured. The extensions do not depend on this package.

## Use

From the repository root:

```console
pnpm dev -- web
```

`pnpm dev` starts the app on a worktree-local port and prints its URL. `packages/web/cloudflare.config.ts` is the only Worker configuration; writes are allowed only in the `local` environment.

Deployment is never implicit. [docs/cloudflare.md](../../docs/cloudflare.md) describes the project-local `cf` CLI and `pnpm deploy:preflight -- --target web --environment local`; a remote deployment needs explicit authorization, approved resources and credentials.

## Development and tests

```console
pnpm --filter @chrome-toolbox/web test
pnpm --filter @chrome-toolbox/web test:runtime
pnpm --filter @chrome-toolbox/web exec playwright install chromium
pnpm --filter @chrome-toolbox/web test:e2e
pnpm --filter @chrome-toolbox/web test:lighthouse
pnpm --filter @chrome-toolbox/web build
```

- `test`: Vitest unit tests (`test/unit.test.ts`, `test/assets.test.ts`).
- `test:runtime`: the Worker in the actual local Workers runtime (`test/runtime.test.ts`).
- `test:e2e`: Playwright against the development server: rendering, hydration, routes, notes, export, accessibility and the reviewed screenshots in `test/browser/snapshots/`. `test:e2e:production` runs the same against the production build.
- `test:lighthouse`: Lighthouse on the production build; every category must score 100 ([docs/lighthouse.md](../../docs/lighthouse.md)).
- `build`: the Worker build through `cf`.
