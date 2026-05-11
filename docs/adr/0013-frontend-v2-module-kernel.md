# ADR 0013 - Frontend v2 Module Kernel and Legacy Web Sunset

**Status:** proposed
**Date:** 2026-05-11
**Decision makers:** core team

## Context

The current `apps/web` frontend has accumulated enough architectural coupling that local repairs repeatedly pull new work back into old patterns: god contexts, bootstrap-era normalization, preview vocabulary, direct or semi-direct transport coupling, monolithic viewport lifecycle, and mixed ownership across `components`, `features`, `src/features`, `src/hooks`, and `lib`.

Measured locally on 2026-05-11, excluding build artifacts and dependencies, `apps/web` contains 992 files and about 212,214 lines. Several load-bearing files exceed safe review size:

- `ControlRoomContext.tsx`: 1,930 lines;
- `RunControlRoom.tsx`: 912 lines;
- `normalize.ts`: 2,350 lines;
- `useViewportDataBridge.ts`: 2,034 lines;
- `UnifiedVectorFieldRenderer.tsx`: 2,302 lines.

The product direction remains one Fullmag browser control room, one resource-first API, one canonical Python/ProblemIR semantics, and one unified FDM/FEM viewport path. The issue is not the product model; the issue is the current frontend implementation.

## Decision

Create a new frontend app root at `apps/control-room` using a module-kernel architecture documented in `docs/specs/frontend-v2/`.

The kernel owns routing, immutable providers, module registry, layout slots, typed event bus, command registry, API facade, resource invalidation, diagnostics, and module lifecycle. Product areas such as explorer, inspector, 3D viewport, 2D viewport, charts, ribbon, console, results, and diagnostics are modules mounted into slots.

Keep `apps/web` as a legacy reference during migration. Do not import it from `apps/control-room`. After v2 passes cutover acceptance, freeze `apps/web`, remove it from default dev/deploy paths, and later remove or archive it outside the active product tree.

## Consequences

Positive:

- v2 can reject legacy debt at the boundary instead of refactoring around it.
- Modules can be disabled by manifest registration without forking the product tree.
- Menu, ribbon, shortcuts, context menus, and command palette share one command registry.
- API data flow stays resource-first and OpenAPI v2 driven.
- 3D/2D rendering lifecycle can be designed around explicit resource ownership and dirty rendering from day one.

Trade-offs:

- Temporary parallel app root increases short-term repository size.
- Feature parity requires deliberate porting rather than broad copy/paste.
- CI and agent skills must enforce the new boundaries or the rewrite will reproduce old debt.

## Implementation Obligations

- Add and maintain `docs/specs/frontend-v2/`.
- Add frontend-v2 skills under `.agents/skills/`.
- Update `AGENTS.md` so agents treat `apps/control-room` as the v2 target and `apps/web` as legacy reference during migration.
- Keep OpenAPI v2 and generated frontend transport as the only browser JSON contract.
- Keep WebSocket as invalidation/lifecycle transport, not full state.
- Keep FDM/FEM differences behind capability gates, domain adapters, render models, and resource hooks.
- Define cutover acceptance before changing default deployment.

## Migration Plan

The phased plan lives in `docs/specs/frontend-v2/22-implementation-plan.md`. Cutover acceptance lives in `docs/specs/frontend-v2/21-cutover-acceptance.md`.

## Rollback

Before cutover, rollback is to continue using `apps/web` as the active frontend while v2 remains undeployed. After cutover, rollback requires an explicit release decision and must not reintroduce legacy code into `apps/control-room`.

## Validation

Validation requires:

- module boundary checks;
- no direct component/module fetch;
- no v1/live or bootstrap/poll canonical path in v2;
- OpenAPI v2 generated type freshness;
- resource hook invalidation tests;
- command registry tests;
- viewport memory stress and idle performance audits;
- side-by-side workflow comparison against legacy before freeze.
