---
name: frontend-v2-cutover-governance
description: Use when modifying frontend v2 migration plans, legacy apps/web references, cutover criteria, AGENTS.md, specs, ADRs, scripts, deployment defaults, or legacy deletion.
---

# Frontend v2 Cutover Governance

Use this to prevent permanent dual frontend drift.

## Required Checks

1. Read `docs/specs/frontend-v2/07-migration-strategy.md`, `19-feature-flags-module-lifecycle.md`, and `21-cutover-acceptance.md`.
2. State the current phase: architecture, kernel, API spine, modules, parity, cutover, freeze, removal.
3. Identify whether `apps/web` is being read as reference, modified, frozen, or removed.
4. Ensure every compatibility bridge, feature flag, or legacy reference has an owner and removal condition.
5. Update AGENTS/specs/ADR/scripts when active frontend defaults change.
6. Preserve the frontend v2 visual defaults: Catppuccin Mocha/Latte tokens and shadcn/ui-style shared primitives for menu/ribbon/tabs/dialog chrome.
7. Do not remove legacy until the acceptance checklist passes.

## Banned Patterns

- permanent dual frontend deployment;
- importing legacy code into v2;
- leaving copied legacy helpers without tests and ownership;
- feature flags without removal criteria;
- declaring parity without workflow evidence;
- deleting legacy while scripts/tests/docs still reference it.

## Verification

```bash
rg "apps/web|web:dev|web:build|web:typecheck" package.json docs AGENTS.md
rg "apps/web" apps/control-room
rg "/v1/live/current|bootstrap|poll|preview" apps/control-room/src
```

Report any remaining legacy path with its status: reference, transitional, frozen, or removal-ready.
