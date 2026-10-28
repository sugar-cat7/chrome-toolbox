---
name: template
description: Maintain canonical application blueprints, initialization and package addition while preserving downstream changes. Use for template, generator or shared development foundation changes.
---

# Template maintenance

Apply to blueprints, initialization, app addition or shared tools. Read [AGENTS.md](../../../AGENTS.md), [template procedure](../../../docs/template.md), generator tests and [quality rules](../../../docs/quality.md).

For `kind: reference` in `.template.json`, edit canonical blueprints under `tools/generators/templates` and regenerate with `pnpm template:sync`. For a generated `kind: project`, edit its application source normally; `template:sync` deliberately refuses to overwrite downstream code. Add applications with the command in [template procedure](../../../docs/template.md). Do not maintain a second handwritten sample copy. Consult current tool documentation, record adoption reasoning and verify the smallest combination first. Run safety regression tests, affected `pnpm gate:pre-pr` and relevant `pnpm template:verify -- --cases <case-list>`; request `pnpm gate:full` only for explicitly required complete validation. Follow the CI plan's preset, fault, Hook and lifecycle selection rather than running every mechanism on every edit. Preserve user edits and licenses; review migrations instead of overwriting downstream business code. Finish with all affected presets/native OS checks and evidence.
