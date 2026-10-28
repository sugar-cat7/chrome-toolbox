# api Worker service

Generated from the API template. The Worker owns `cloudflare.config.ts` and uses the shared contracts and observability packages. Storage: Local D1 persistence. No resource provisioning runs during setup or build.

From the workspace root:

```console
pnpm dev -- api
pnpm --filter @starter/api test
pnpm --filter @starter/api test:runtime
pnpm --filter @starter/api build
pnpm deploy:preflight -- --target api --environment local
pnpm --filter @starter/api cf --help
```

`GET /health` reports readiness; `/api/notes` validates input and creates, lists and deletes notes. Local writes are allowed. Remote artifacts deny unauthenticated writes; a service without D1 uses volatile memory and resets on restart.

For approved dev delivery, configure an existing account/token and explicitly approved domain in the sole config, plus IDs for any selected resources. Run the dev preflight, then the workspace's checked `deploy` entry with its approved health URL. Local preflight/build do not establish remote deployment or connectivity. See [Cloudflare instructions](../../docs/cloudflare.md).
