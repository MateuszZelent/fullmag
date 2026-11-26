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
`resolveInspectorPanel` (`inspectorRegistry.tsx`) and `inspectorRouteCatalog.tsx`
(`apps/control-room/src/modules/inspector/`) to one of **162 canonical routes** composed across
four domain registries (`MAGNETIC_TEXTURE_ROUTES`, `MODEL_PHYSICS_ROUTES`, `MESH_ANTENNA_ROUTES`,
and `STUDY_RESULTS_START_ROUTES`, plus `FALLBACK_INSPECTOR_ROUTE`). Rather than building one
generic key-value property grid, each declarative spec (`inspectors/*Spec.tsx` rendered via
`InspectorTemplate` and `PropertyRow`) exposes typed controls, unit-aware SI inputs, lane-filtered
validation, and explicit save transactions.

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

Across all three modes, `inspectorRouteCatalog.tsx` maps every `SelectionKind` (`object`, `material`,
`region`, `physics`, `coupling`, `frozen-spins`, `antenna`, `current-transport`, `spin-transport`,
`spin-interface`, `study`, `study-stage`, `planar-monitor`, `frequency-domain-*`, `mode-visualization`,
`runtime-*`, `job`, `diagnostic`) to its owner panel, and `InspectorShell` queries
`inspectorActionState` from `InspectorEditSession` to drive **Apply** and **Reset**. Parameters not
exposed in a dedicated inspector remain `Python-only` (see {doc}`/frontend/capability-register`).

## Semantic Inspector Families

```{toctree}
:maxdepth: 1

objects-and-materials
absorbing-boundaries
physics-antennas-and-transport
studies-and-stages
analysis-and-frequency-domain
```

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Selection-to-panel route catalog | `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx` | `resolveInspectorRoute`, `INSPECTOR_ROUTES` |
| Panel registry resolver | `apps/control-room/src/modules/inspector/inspectorRegistry.tsx` | `resolveInspectorPanel` |
| Declarative inspector shell & template | `apps/control-room/src/modules/inspector/template/InspectorTemplate.tsx` | `InspectorTemplate` |
| Unit-aware scalar & vector draft rows | `apps/control-room/src/modules/inspector/template/PropertyRow.tsx` | `PropertyRow` |
| Staged / liveViewport / immediate session contract | `apps/control-room/src/modules/inspector/InspectorEditSession.tsx` | `useRegisterInspectorEditSession`, `inspectorActionState` |
| Optimistic revision reconciliation | `apps/control-room/src/modules/inspector/panels/objectEditAckReconciliation.ts` | `reconcileObjectEditAck` |
