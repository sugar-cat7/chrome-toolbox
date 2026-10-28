---
name: dependencies
description: Review current official SDKs and update catalog, locks or native toolchains after minimal compatibility checks. Use for dependency adoption, upgrades or supply-chain findings.
---

# Dependency updates

Apply to catalog, lockfile or native toolchain updates. Read [AGENTS.md](../../../AGENTS.md), [adoption decisions](../../../docs/adoption.md), manifests and [update procedure](../../../docs/template.md). Consult current official docs/changelogs and installed SDK types; test compatibility before adopting.

Update the single catalog and derived pnpm lock; native lock/toolchain remain inside the Desktop package. Run affected tests and `pnpm template:verify` for tooling/template changes. Preserve supply-chain rules, user changes and required checks. Finish with version/date/URL rationale and successful relevant runtimes. Renovate connection is external; CI does not depend on it.
