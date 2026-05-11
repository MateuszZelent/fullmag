# Frontend v2 Specification Index

**Status:** Proposed architecture
**Date:** 2026-05-11
**Decision record:** `docs/adr/0013-frontend-v2-module-kernel.md`

Frontend v2 is a clean control-room frontend line for Fullmag. It retires the old `apps/web` architecture as a reference source and builds a new modular app root under `apps/control-room`.

This is not a second Fullmag product and not an FDM/FEM fork. It is one browser control room, one v2 resource-first API contract, one command vocabulary, one module kernel, and replaceable modules mounted into stable slots.

## Reading Order

1. `00-executive-summary.md` - why v2 exists and what is excluded.
2. `01-module-kernel-architecture.md` - kernel, manifests, slots, module lifecycle, events.
3. `02-module-catalog.md` - canonical module list and responsibilities.
4. `03-api-integration-layer.md` - OpenAPI v2, typed client, resource hooks, realtime invalidation.
5. `04-state-management.md` - store ownership and server-state boundaries.
6. `05-viewport-architecture.md` - viewport family overview.
7. `10-shell-menu-and-navigation.md` - app chrome, main menu, workspace modules.
8. `11-explorer-view.md` - explorer tree model and selection behavior.
9. `12-ribbon-toolbar-command-system.md` - ribbon, toolbar, command palette, shortcuts.
10. `13-inspector-and-property-editing.md` - inspector registry, transactions, validation.
11. `14-viewport-3d-module.md` - 3D viewport internals and WebGL lifecycle.
12. `15-viewport-2d-module.md` - 2D slice and profile viewport.
13. `16-charts-analysis-module.md` - charts, analysis, scalar histories.
14. `17-performance-memory-profiler.md` - rendering, memory, profiling, budgets.
15. `18-testing-quality-gates.md` - required verification gates.
16. `19-feature-flags-module-lifecycle.md` - enable/disable, rollout, sunset rules.
17. `20-agent-governance.md` - rules for agents working on frontend v2.
18. `21-cutover-acceptance.md` - acceptance criteria before disabling legacy.
19. `22-implementation-plan.md` - phased build plan.
20. `23-per-object-visualization-control.md` - per-object and airbox visualization registry shared by ribbon, explorer, inspector, 3D viewport, and future 2D views.
21. `24-geometry-object-authoring-lifecycle.md` - end-to-end plan for adding scene objects, primitive display fallback, mesh rebuild synchronization, and explorer/ribbon/inspector/viewport integration.

## Authority

These docs are subordinate to the physics notes, `ProblemIR`, `docs/specs/resource-first-control-room-api-v2.md`, and `docs/adr/0011-resource-first-api.md`. If frontend v2 needs an API shape that is not in OpenAPI v2, the frontend does not invent it locally; the API contract is updated first.

## Non-Goals

- No rewrite of physics semantics in the UI.
- No direct component networking.
- No screen-shaped API endpoints.
- No permanent dual frontend deployment.
- No microfrontend package system unless a future ADR proves the need.
- No copying legacy god contexts, normalization pipelines, mutable singleton diagnostics, or always-on render loops.
