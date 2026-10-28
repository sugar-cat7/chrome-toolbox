---
name: debug
description: Diagnose and repair failing checks or runtime behavior using reproducible failures, owned logs and targeted regressions. Use when a test, quality gate, build or application fails.
---

# Debugging and performance

Apply to failures or performance work. Read [AGENTS.md](../../../AGENTS.md), [troubleshooting](../../../docs/troubleshooting.md) and the failing check's report. Reproduce the exact input and runtime; inspect current SDK guidance before proposing an API workaround.

Use `pnpm env:doctor` and the smallest owning package command. Record cold/warm time, OS/toolchain, source content and actual measurements; avoid speculative budgets. Make one justified fix, rerun the failing check and affected gate, preserve existing work, and report limitations. Do not skip tests, weaken assertions or turn a timeout into success.

For correlated runtime evidence use the [observability skill](../observability/SKILL.md), not raw exception/body logging. Record whether current collection and read-only query are independently ready.
