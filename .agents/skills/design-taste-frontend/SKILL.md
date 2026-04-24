---
name: design-taste-frontend
description: "Use when building or modifying Fullmag frontend UI. Enforces the OpenAPI client/resource-hook path, one ribbon, unified FDM/FEM viewport, docked workspace shell, scientific ergonomics, and performance-conscious React architecture."
---

# Fullmag Frontend Design Governance

## Purpose

Fullmag's frontend is a scientific control room and authoring companion. It must feel precise, inspectable, and operational. Do not apply generic landing-page, portfolio-showcase, decorative SaaS, or marketing-page instincts to the workspace.

## Non-Negotiable Architecture

1. OpenAPI is the browser contract. Type changes flow through the OpenAPI source/spec, generated types, API client modules, resource hooks, and tests.
2. React components do not call `fetch()` directly. Network access goes through `apps/web/src/api/client/LiveApiClient.ts`, API modules, and `apps/web/src/hooks/resources/`.
3. Use one workspace shell, one ribbon command surface, one docking model, and one unified viewport routing path.
4. FDM/FEM differences belong in capabilities, adapters, codecs, render models, and layer guards. Do not fork the product into separate FDM and FEM applications.
5. Heavy numerical data belongs on the data plane and binary codecs. Thin JSON carries state, command intent, metadata, diagnostics, revisions, and resource identities.
6. Status is revision-driven and thin. Fetch domain, scene, topology, fields, scalars, artifacts, stages, logs, and display data as named resources.

## Workspace UX Direction

- The primary screen is the workspace, not a landing page.
- One top ribbon owns creation, edit, run, inspect, display, and export commands.
- Center tabs/docks host viewport, charts, analysis, logs, problems, jobs, and live data without changing the physical model.
- Inspectors explain selected resources, stage state, capabilities, and diagnostics; they do not become hidden alternate workflows.
- Build/Analyze/Study as separate app identities is legacy. Preserve only as transitional names where current code requires it, and isolate the debt.
- Authoring and execution language must match Python DSL and `ProblemIR` terms.

## Visual Standard

- Prefer dense, calm, utilitarian UI over decorative cards and hero sections.
- Use restrained color. Reserve strong color for selection, warnings, capability status, and execution state.
- Use compact tables, segmented controls, icon buttons with tooltips, tree/list panels, tabs, sliders, checkboxes, and menus where those controls match the workflow.
- Cards are for repeated items, modals, and framed tools. Do not put page sections inside card shells.
- Keep radius tight unless the existing component system already defines otherwise.
- Avoid one-note purple/blue gradients, floating orbs, stock imagery, oversized headings, and marketing copy.
- Scientific numbers use tabular figures or monospace where alignment matters.

## Viewport Rules

1. Route all 2D/3D views through the unified viewport core/registry where possible.
2. Keep topology/geometry revisions separate from field/value revisions.
3. Switching an already available quantity should read field-store resources, not enqueue preview-control work.
4. Separate scene/model logic, transport/resource hooks, interaction routing, render layers, and overlays.
5. Viewport controls must expose physical coordinates, units, selected quantity, revision, backend/domain capability, and degraded states.
6. Do not rebuild topology when only field buffers, color maps, vector visibility, or slice state change.

## Implementation Workflow

1. Read the current component, resource hook, API module, and related tests before editing.
2. Identify whether the change needs OpenAPI/schema updates or only client/UI changes.
3. Keep edits local to the relevant shell, hook, adapter, renderer, or panel.
4. Add or update generated types only through the repo's established OpenAPI generation path.
5. Add focused tests for API module behavior, resource cache invalidation, command gating, viewport routing, or component state as applicable.
6. Run the narrow test/check command that covers the touched area.

## Frontend Anti-Patterns

- Direct component `fetch()`.
- A second FDM or FEM workspace tree.
- Preview mutation as quantity switching.
- Bootstrap/poll session blobs as the canonical data model.
- Hidden fallback from one backend/device/precision to another.
- UI-only mesh or physics semantics that cannot round-trip to Python DSL.
- Decorative motion or visual effects that obscure data, reduce frame rate, or add render churn.
- Large god components that mix networking, physics mapping, rendering, and overlays.

## Pre-Commit Check

- OpenAPI/types/resource hooks are aligned if contracts changed.
- One ribbon and unified viewport paths are preserved.
- Requested vs resolved execution stays visible where affected.
- Loading, empty, error, degraded, and stale-revision states are handled.
- No direct `fetch()` or duplicated FDM/FEM tree was introduced.
- Tests cover the behavior or the residual test gap is explicitly stated.
