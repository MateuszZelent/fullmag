# Frontend v2 - Module Catalog

**Status:** Active migration contract
**Date:** 2026-08-03

Each module below maps to `apps/control-room/src/modules/<module-id>/`. Modules are optional at registration time, but the shell must remain stable when any non-core module is disabled.

## 0. Current Implementation Snapshot

As of 2026-05-22, `apps/control-room` registers these manifests through `src/modules/index.ts`:

| Manifest id | Directory | Slot | Status |
|---|---|---|---|
| `app-menu` | `src/modules/app-menu` | `app-menu` | implemented |
| `ribbon` | `src/modules/ribbon` | `ribbon` | implemented |
| `explorer` | `src/modules/explorer` | `panel-left` | implemented |
| `viewport-3d` | `src/modules/viewport-3d` | `viewport-main` | implemented |
| `cross-section-image` | `src/modules/cross-section-image` | `viewport-main` | implemented compatibility export/fallback; removed as a competing top-level workflow after field-map parity |
| `field-map` | `src/modules/field-map` | `viewport-main` | production target for interactive planar spatial quantities; implementation tracked by ADR 0020 |
| `live-charts` | `src/modules/live-charts` | `viewport-main` | implemented active-run scalar time-series surface |
| `analysis-plots` | `src/modules/analysis-plots` | `viewport-main` | implemented explicit-dataset postprocessing surface |
| `viewport-aux` slot | `src/kernel/layout` | `viewport-aux` | implemented as an empty auxiliary dock slot, rendered only when a registered module targets it |
| `inspector` | `src/modules/inspector` | `panel-right` | implemented |
| `transport-footer` | `src/modules/footer` | `panel-bottom` | implemented footer owner; mounts Quick Chart content only in its active tab |
| `command-palette` | `src/modules/overlay` | `overlay` | implemented as the current overlay module |
| `status-bar` | `src/modules/status-bar` | `status-bar` | implemented |

The modules listed in later sections remain the target catalog. A target module that is not in this snapshot is deferred, not silently dropped. Cutover acceptance still depends on the required workflows in `21-cutover-acceptance.md`, not on this snapshot alone.

## 1. Core Shell Modules

| Module | Slot | Responsibility | Required |
|---|---|---|---|
| `app-menu` | `app-menu` | Main menu renderer backed by command registry. | yes |
| `ribbon` | `ribbon` | Context command groups and toolbars. | yes |
| `status-bar` | `status-bar` | Connection, backend, precision, active session, revision summaries. | yes |
| `command-palette` | `overlay` | Keyboard-driven command search and execution. | yes |
| `notifications` | `overlay` | Toasts and command/error summaries. | yes |

The workspace shell (grid, split panes, slot hosts, resize persistence) is kernel-owned infrastructure in `src/kernel/layout/`, not a module.

Core shell modules must not contain physics-specific UI. They render commands, status, and slots.

## 2. Navigation Modules

| Module | Slot | Responsibility | Legacy reference |
|---|---|---|---|
| `explorer` | `panel-left` | Unified tree for model, resources, results, jobs, diagnostics entry points. | `ModelTree.tsx`, `features/model-builder`, `features/workspace-graph` |
| `results-navigator` | `panel-left` | Artifact and result dataset browsing. | `features/analyze`, `features/workspace-graph` |
| `project-start` | `viewport-main` or `overlay` | Open/recent/example/session start flow. | `components/start-hub` |

The explorer is the default left-panel module. Results navigator is a tab in the same panel, not a separate application shell.

## 3. Authoring Modules

| Module | Slot | Responsibility | Notes |
|---|---|---|---|
| `definitions` | `panel-left`, `panel-right` | Materials, quantities, named functions, parameter definitions. | Must round-trip to Python DSL. |
| `geometry-authoring` | `viewport-main`, `ribbon`, `panel-right` | Geometry object creation, primitive editing, transforms, validation, and backend scene transactions in the unified 3D viewport. | Geometry mode is a viewport preset, not a separate builder app. New objects start in primitive display until a mesh build materializes solver topology. |
| `materials` | `panel-right` | Material assignment, tensor/scalar editing, validation. | Uses inspector transaction model. |
| `physics` | `panel-right` | Interactions, boundary conditions, external fields. | Must use canonical Python/IR vocabulary. |
| `mesh-authoring` | `panel-right`, `panel-bottom` | Universe/object/shared-domain mesh controls and reports. | Must preserve FEM three-layer mesh semantics. |
| `study-authoring` | `panel-right`, `ribbon` | Stage pipeline, execution intent, backend/device/precision request. | Must preserve requested vs resolved execution. |
| `python-export` | `panel-bottom`, `overlay` | Canonical Python DSL preview/export and sync diagnostics. | Read-only preview unless transaction support exists. |

Authoring modules never mutate local-only physics state. They submit semantic transactions to the API/resource layer.

`geometry-authoring` follows the lifecycle in `24-geometry-object-authoring-lifecycle.md`: inspector drafts create or patch canonical `SceneDocument` objects through v2 model transactions; primitive/fallback wireframe display is authoring visualization only; solver mesh topology appears only after a successful backend mesh build.

## 4. Visualization Modules

| Module | Slot | Responsibility | Data source |
|---|---|---|---|
| `viewport-3d` | `viewport-main` | 3D scene, mesh, field, glyph, overlay, selection visualization. | Mesh/topology/field binary resources. |
| `cross-section-image` | `viewport-main` during migration; export/fallback after cutover | Server-rendered mesh cross-section preview and PNG export. | Meshing cross-section image resource plus FMCS/FMQS statistics resources. |
| `field-map` | `viewport-main` | Interactive heatmaps, contours, probes, vectors, mesh overlays, plane/slab/depth reductions, and surface projections for every compatible published spatial quantity. | Canonical planar-monitor metadata plus bounded scalar, vector, occupancy, mesh-overlay, probe, and PNG resources. |
| `live-charts` | `viewport-main` | **Live Charts** follows active-run scalar histories with local series visibility and explicit Follow/Pause controls. | Revisioned table resources through the shared chart data-plan; retained-data background refresh; no polling. |
| `analysis-plots` | `viewport-main` | **Analysis** postprocesses an **explicit selected dataset**, run, stage, or artifact in an active-only center surface. | Revisioned table and analysis resources; no active-tail adoption and no server payload in workspace stores. |
| `transport-footer` Quick Chart content | `panel-bottom` | **Quick Chart** displays one pinned table descriptor while its footer tab is active and coexists with 3D. | Shared chart contracts and table resources only; never imports either center-module store. |
| `viewport-2d` | disabled after replacement | Legacy live WebGL slices, projections, probes, line profiles, and mesh cross-sections. | Removed from default registration once `cross-section-image` is active. |
| `legend-scale` | `viewport-main` overlay | Quantity legend, units, range, stale/degraded status. | Visualization state and field stats. |
| `view-controls` | `ribbon`, `viewport-main` overlay | Camera, layer, quantity, clip, selection, display controls. | Command registry and visualization resource. |

Viewport modules consume domain-neutral render models. FDM/FEM interpretation belongs to adapters.

`field-map` is the canonical interactive 2D surface for microwave-antenna field
inspection. It does not resurrect the removed live R3F `viewport-2d`: it uses a
demand-driven chart/raster renderer, mounts only while its center tab is
active, and reads the standard field data plane through `ControlRoomApi` and
resource hooks. Source k-spectrum and spin-wave `S(k,omega)` remain analysis
products consumed by `analysis-plots`; a source heatmap must not be labeled as
the magnetization response.

The module renders a canonical `PlanarMonitor` but does not own that monitor.
Committed monitor target/frame/operator state round-trips through
`SceneDocument`, `ProblemIR`, and canonical Python. Quantity, component,
display unit, palette, range, raster resolution, quality, vector budget, and
runtime-only mesh-part/airbox scope belong to the planar visualization profile
or data request. The renderer is Canvas 2D/worker based and must not import
Three.js, R3F, or `viewport-3d` internals.

`viewport-main` is a tabbed center surface when more than one visualization module targets it. The active tab is the only mounted heavy surface. Inactive `viewport-3d` must not keep WebGL, field-vector hooks, topology hooks, render-model builders, or client acknowledgement effects active.

## 5. Runtime Modules

| Module | Slot | Responsibility |
|---|---|---|
| `run-control` | `ribbon`, `panel-right` | Start/pause/stop stages and show command completion. |
| `job-monitor` | `panel-bottom` | Active commands, runs, stages, progress, stop reasons. |
| `engine-console` | `panel-bottom` | Logs and solver telemetry. |
| `diagnostics` | `panel-bottom`, `overlay` | API request log, resource cache, render counters, memory checks. |
| `capability-viewer` | `panel-right`, `overlay` | Explains why commands/modules are available, degraded, or unsupported. |

Runtime modules must distinguish compute state from display-selection state.

## 6. Module Dependencies

Modules do not depend on each other directly. Allowed dependency flow:

```mermaid
flowchart TD
  Module["Any Module"] --> KernelHooks["Kernel hooks"]
  Module --> SharedUi["Shared UI primitives"]
  Module --> OwnStore["Own module store"]
  KernelHooks --> ApiFacade["ControlRoomApi facade"]
  KernelHooks --> ResourceHooks["Resource hooks"]
  ResourceHooks --> Generated["Generated v2 transport"]
  ResourceHooks --> Codecs["Binary codecs"]
```

If `viewport-3d` needs selection, it reads `selectionStore` through kernel hooks or listens to `workspace:selection-changed`. It does not import the explorer store.

## 7. Minimum Acceptance Per Module

Each module needs:

- manifest with slot, capability gate, and declared events;
- root component accepting `ModuleProps`;
- no cross-module imports;
- tests for manifest registration and at least one meaningful behavior;
- teardown coverage for subscriptions, workers, timers, and external resources;
- documented legacy sources copied or deliberately rejected;
- feature flag or registration owner if the module is not core.
