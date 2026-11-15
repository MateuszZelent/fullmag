---
title: Semantic Inspectors
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-inspectors-root)=
# Semantic Inspectors

Every selection in the Explorer, 3D Viewport, 2D Field Map, or Results Navigator routes through
`InspectorRegistry` and `inspectorRouteCatalog.tsx` (`apps/control-room/src/modules/inspector/`) to
a dedicated semantic panel. Rather than building one generic key-value property grid, each domain
owner exposes typed controls, unit-aware SI inputs, lane-filtered validation, and explicit save
transactions.

```{image} /_static/images/ui/inspector-panel-draft.png
:alt: Staged Geometry inspector showing STATE modified badge, SI Size X edit, active Revert and Apply buttons, and Draft ready to apply footer
:align: center
:width: 100%
```

## Edit Modes and Draft Isolation

Panels register with `InspectorEditSession` (`InspectorEditSession.tsx`) under one of three modes:

- **`staged`**: Edits remain local inside panel/draft stores until explicitly committed with **Apply** (`Ctrl+Shift+Enter`) or discarded with **Revert** (`session.reset`). Applying runs through `runAuthoringMutationWithHistory` with optimistic `scene_revision` concurrency guards (`reconcileObjectEditAck`, rebase-on-unchanged-object) so out-of-date drafts never silently overwrite background changes from live Python scripts.
- **`liveViewport`**: Display and camera settings patch `visualization/state` immediately while preserving **Revert** recovery.
- **`immediate`**: Read-only inspection and discrete button actions (such as stage commands or mesh builds) run immediately without staged Apply/Revert state.

## Semantic Inspector Families

```{toctree}
:maxdepth: 1

objects-and-materials
physics-antennas-and-transport
studies-and-stages
analysis-and-frequency-domain
```

Screenshots illustrate the interface; they are not runtime or physics qualification evidence.

## Control Room crosswalk

- **Route dispatcher**: `inspectorRouteCatalog.tsx` maps every `SelectionKind` (`object`, `material`, `region`, `physics`, `coupling`, `frozen-spins`, `antenna`, `current-transport`, `spin-transport`, `spin-interface`, `study`, `study-stage`, `planar-monitor`, `frequency-domain-*`, `mode-visualization`, `runtime-*`, `job`, `diagnostic`) to its React owner panel.
- **Global action bar**: `InspectorShell` queries `inspectorActionState` from the active `InspectorEditSession` to drive **Apply** / **Reset** and disable reasons.

## Python/API crosswalk

- Staged inspector commits issue OpenAPI v2 authoring transactions equivalent to `Problem` / `Study` mutations in `packages/fullmag-py`.
- Fields absent from an inspector panel remain documented as `TODO: frontend support` in {doc}`/frontend/capability-register` and remain authoritative in Python.

## Physics and bibliography scope

Semantic inspectors surface authored parameters, unit conversions, and runtime validation without altering physical model equations or solver numerics.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Selection-to-panel route catalog | `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx` | `resolveInspectorRoute` |
| Panel registry shell | `apps/control-room/src/modules/inspector/inspectorRegistry.tsx` | `InspectorRegistry` |
| Staged / liveViewport / immediate session contract | `apps/control-room/src/modules/inspector/InspectorEditSession.tsx` | `useRegisterInspectorEditSession`, `inspectorActionState` |
| Unit-aware scalar draft inputs | `apps/control-room/src/modules/inspector/primitives/QuantityField.tsx` | `QuantityField` |
| Optimistic revision reconciliation | `apps/control-room/src/modules/inspector/panels/objectEditAckReconciliation.ts` | `reconcileObjectEditAck` |
