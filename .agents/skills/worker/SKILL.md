---
name: worker
description: Develop and validate Cloudflare Worker HTTP APIs, configuration, selected D1/KV/R2 or Service Bindings and local runtime behavior. Use for API, Worker or deployment configuration changes.
---

# Worker and service development

Apply to Worker/API/Binding work. Read [AGENTS.md](../../../AGENTS.md), the owning `cloudflare.config.ts` and [Cloudflare guidance](../../../docs/cloudflare.md). Configuration is the sole binding/environment source; SDK output and generated types are derived. Verify current SDK signatures before changing it.

Add with `pnpm app:new -- --kind api --name <name>`. Run `pnpm env:setup`, package unit/runtime tests, then `pnpm gate:pre-pr`. Test real workerd, selected resources, malformed input, safe error/log output and remote deny-write defaults. Finish with consistent migration/typegen/build output and deployment preflight; credentials or remote approval are never implied.

Use the owning package's `pnpm run cf <command>` (or root `pnpm --filter <scope>/<worker> cf <command>`) for Cloudflare operations. Discover unfamiliar operations with `cf cli search "<action and resource type>"`, then the returned command's help/schema; keep searches free of project names, domains, IDs and secrets. API development/build, typegen and checked deployment use cf. The [command table](../../../docs/cloudflare.md) records the tested TanStack/D1/built-preview exceptions; do not replace them with failing commands or provision missing resources implicitly.
