---
name: redesign-existing-projects
description: "Use when redesigning or refactoring existing Fullmag frontend surfaces. Focuses on migrating stale UI toward the OpenAPI/resource-hook workspace, one ribbon, unified viewport, docked panels, and scientific workflow clarity without breaking behavior."
---

# Fullmag Existing-UI Redesign

## Goal

Upgrade existing UI by removing architectural drift, not by repainting it. The target is a coherent Fullmag workspace: OpenAPI-backed resources, a single ribbon, unified viewport, docked operational panels, and Python/IR-aligned authoring semantics.

## Redesign Sequence

1. **Map** the current surface: route, shell, ribbon registration, resource hooks, API modules, viewport path, state stores, and tests.
2. **Classify** every dependency as canonical, transitional, or stale.
3. **Repair** the smallest useful slice while preserving existing workflows.
4. **Retire or isolate** stale concepts instead of spreading compatibility glue.
5. **Verify** with targeted tests and, for visual/viewport work, a browser check when practical.

## Canonical Targets

- OpenAPI source/spec and generated frontend types define browser payloads.
- `LiveApiClient` and module classes own HTTP/realtime access.
- `apps/web/src/hooks/resources/` owns resource acquisition, cache keys, revisions, and command completion hooks.
- `features/viewport-core` and `features/viewport-unified` own shared viewport routing, interaction, and render contracts.
- FDM/FEM-specific code lives in adapters, render models, codecs, and capability guards.
- The workspace shell, ribbon registry, docking panels, and center tabs are one product surface.

## Stale Patterns To Remove

- Separate Build/Analyze/Study app shells or tabs as product identity.
- Direct `fetch()` in components.
- Bootstrap/poll blobs as the state source of truth.
- Preview endpoints used for warm quantity switching.
- Mesh semantics that exist only in UI state.
- Separate FDM and FEM viewport trees with duplicated toolbar/state logic.
- Long-lived old/new API dual stacks without removal criteria.
- Component files that combine transport, physics mapping, renderer setup, toolbar logic, and diagnostics.

## UX Repair Priorities

1. Make the task path obvious in the ribbon and active dock/tab.
2. Show selected resource, revision, quantity, units, and degraded state near the viewport or inspector.
3. Keep commands explicit about intent and completion status.
4. Prefer compact, scan-friendly panels over decorative cards.
5. Use warnings and problems panels for missing capability, stale data, failed commands, and backend mismatch.
6. Preserve keyboard, pointer, and camera interactions while refactoring.

## Code Rules

- Work with the existing stack and component system. Do not migrate frameworks or styling libraries.
- Read the nearest tests before editing and keep changes reviewable.
- Split files that grow past roughly 1000 lines or mix unrelated responsibilities.
- Do not add a new state store when an existing resource hook, workspace store, or viewport store owns the concern.
- Do not introduce new mock data unless the surface is explicitly a fixture/test/demo; mark transitional data honestly.

## Validation

- API/resource changes: API module and resource-hook tests.
- Workspace/ribbon changes: command registry, tab selection, docking, and route tests.
- Viewport changes: adapter, routing, layer, codec, and store tests; browser/screenshot check for layout-sensitive work when feasible.
- Migration cleanup: `rg` for old endpoints, direct `fetch()`, duplicate viewport imports, and stale shell names.
