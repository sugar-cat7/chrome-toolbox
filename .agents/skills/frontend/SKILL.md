---
name: frontend
description: Develop React UI, TanStack routes, SSR and hydration with portable adapters, accessibility, browser regressions and all-100 Lighthouse checks. Use for Web pages, shared UI or Desktop renderer changes.
---

# Frontend and UI

Apply to React, routing, accessibility and portable UI. Read [AGENTS.md](../../../AGENTS.md), package manifests and [quality rules](../../../docs/quality.md). Keep platform I/O in application adapters; schemas/UI stay portable. Check current React/TanStack/Tailwind APIs before adoption.

Run the owning package, exercise loading/empty/error states, keyboard navigation, SSR/hydration and routes. Check the actual production Worker build as well as development. A route declared static must work without JavaScript; remove its marker when adding interactive page or shared root controls, and preserve development HMR and hydrated client navigation. For Web pages follow [Lighthouse](../../../docs/lighthouse.md): audit the production build on mobile/desktop and require every category to score 100 in every run. Repair the reported cause; never exclude audits, loosen profiles, average away failures or remove pages to pass. Add meaningful unit/browser tests and inspect any new visual baseline. Use `pnpm gate:pre-pr` after targeted checks. Preserve unrelated changes and rerun failed checks after a fix. Finish with tested behavior and measured evidence; a baseline update requires an intentional reviewed UI change.
