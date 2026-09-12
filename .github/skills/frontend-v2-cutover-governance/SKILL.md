---
name: frontend-v2-cutover-governance
description: "Use when modifying frontend v2 migration plans, legacy apps/web references, cutover criteria, AGENTS.md, specs, ADRs, scripts, deployment defaults, or legacy deletion."
---

# Frontend v2 Cutover Governance

Use this skill for migration policy, legacy references, feature flags, cutover, freeze, removal, or deployment-default changes. The user instruction and root `AGENTS.md` take precedence.

In the current checkout, `apps/control-room` is the v2 target and `apps/web` is the legacy/reference tree. Keep that naming synchronized with the root instructions and migration specs; do not invent `apps/legacy_web` unless the repository actually creates it.

## Required checks

1. Read the migration, feature-flag, and cutover sections relevant to the requested change:
   - `docs/specs/frontend-v2/07-migration-strategy.md`;
   - `docs/specs/frontend-v2/19-feature-flags-module-lifecycle.md`;
   - `docs/specs/frontend-v2/21-cutover-acceptance.md`.
2. State the current phase: architecture, kernel, API spine, modules, parity, cutover, freeze, or removal.
3. Identify whether `apps/web` is reference, modified, frozen, or removal-ready.
4. Give every compatibility bridge and feature flag an owner and removal condition.
5. Update AGENTS/specs/ADR/scripts only when active defaults, migration policy, or removal criteria actually change.
6. Preserve Catppuccin Mocha/Latte tokens and shared shadcn/ui-style primitives.
7. Do not remove legacy until the acceptance checklist passes.

## Banned patterns

- permanent dual frontend deployment;
- importing legacy code into v2;
- copied legacy helpers without tests and ownership;
- feature flags without removal criteria;
- parity claims without workflow evidence;
- deleting legacy while scripts, tests, or docs still reference it.

## Verification

```powershell
rg "apps/web|web:dev|web:build|web:typecheck" package.json docs AGENTS.md
rg "apps/web" apps/control-room
rg "/v1/live/current|bootstrap|poll|preview" apps/control-room/src
```

Report each remaining legacy path with status: reference, transitional, frozen, or removal-ready.
