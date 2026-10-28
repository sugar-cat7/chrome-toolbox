---
name: security
description: Investigate Trivy HIGH/CRITICAL or Semgrep ERROR findings, validate deterministic repairs and prepare reviewed remediation PRs without weakening gates or exposing raw secrets.
---

# Security response

Read [AGENTS.md](../../../AGENTS.md), [security policy](../../../docs/security.md), owning manifests/locks and the [dependency skill](../dependencies/SKILL.md). Preserve user changes. Check current official advisories, SDK compatibility and the exact source SHA before changing code or dependencies.

Run `pnpm security:setup` then `pnpm security:check`. Treat execution/coverage/parsing failures as failures. Keep raw reports private; report identifiers, locations, source identity and actual validation. Repair the cause; never ignore unfixed findings, suppress rules, remove assertions or loosen CI. For a secret, authorized revocation/rotation is required.

Use local deterministic fixes only within their allowed source paths, inspect the entire diff, re-scan and run affected tests/quality gates. Automation creates reviewed PRs or unresolved Issues using an existing approved credential; it grants no permission to provision credentials, expand access, deploy or merge. Missing credentials/fixes/required approvals remain explicit blockers.
