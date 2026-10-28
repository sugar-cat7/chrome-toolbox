---
name: application
description: Implement features across application boundaries using repository setup, targeted tests, quality gates, Git hooks, builds and deployment preflight. Use for application feature development spanning Web, API or Desktop.
---

# Application development

Apply to a feature spanning application boundaries. Read [AGENTS.md](../../../AGENTS.md), [README](../../../README.md), owning manifests and [quality rules](../../../docs/quality.md). Read current official API documentation before adopting APIs; record the decision and compatibility check.

Use `pnpm env:setup`, `pnpm env:doctor`, `pnpm dev`, targeted package tests, then `pnpm gate:pre-pr`. Preserve user changes; fix failures and rerun affected checks. Complete with a working feature, regression tests, reviewed diff and honest evidence. Builds and deployment preflight follow [Cloudflare guidance](../../../docs/cloudflare.md); this skill authorizes no remote operation.

Choose [worker](../worker/SKILL.md), [frontend](../frontend/SKILL.md), [desktop](../desktop/SKILL.md), [debug](../debug/SKILL.md), [observability](../observability/SKILL.md), [dependency updates](../dependencies/SKILL.md), [security response](../security/SKILL.md), or [template maintenance](../template/SKILL.md) for narrower work. No provider-specific Agent hook is claimed; every Agent uses the same CLI/Git/CI entry points.

Async application ports use the shared Result contract; project public errors only at HTTP/native boundaries. Read the generated error policy before choosing retry/handling behavior. Keep SDK/loggers in the observability owner.
