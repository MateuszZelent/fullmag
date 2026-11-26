---
title: Snapshots
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-snapshots)=
# Snapshots

(python-api-outputs-snapshots-problem-statement)=
## Contract
This page records the periodic field-component snapshot output (`fm.Snapshot` and `study.snapshot(...)`) together with planar 2D slice and projection monitors (`fm.PlanarMonitor` and `study.monitors`).

(python-api-outputs-snapshots-governing-equations)=
## Governing equations
No physical equation is introduced; snapshots persist field components at a cadence, and planar monitors define deterministic 2D cuts, slab averages, or boundary projections on the discretized domain.

(python-api-outputs-snapshots-symbols-and-si-units)=
## Symbols and SI units
`every` is in seconds ($\mathrm{s}$); planar monitor coordinates, extents, and slab thicknesses are in meters ($\mathrm{m}$); the stored component carries the field's SI unit.

(python-api-outputs-snapshots-assumptions-and-validity)=
## Assumptions and validity
Field, component, and positive cadence are validated immediately.

(python-api-outputs-snapshots-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Snapshot.field` | `str` | `required` | $1$ | Known field id | Base field | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `snapshot.field` |
| `Snapshot.component` | `str` | `required` | $1$ | `x`, `y`, `z`, or `3D` | Component selector | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `snapshot.component` |
| `Snapshot.every` | `float` | `required` | $\mathrm{s}$ | Positive finite | Save interval | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `snapshot.every_seconds` |
| `Snapshot.layer` | `str \| None` | `None` | $1$ | Non-empty when set | Layer/region scope | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `snapshot.layer` |

### Planar monitors (`fm.PlanarMonitor` and `study.monitors`)

In addition to periodic 3D field snapshots, Fullmag provides typed 2D slice and projection monitor descriptors:

| Class | Key parameters | Role |
| --- | --- | --- |
| `PlanarMonitor` | `name`, `target: MonitorTarget`, `frame: PlanarFrame`, `operator`, `monitor_id=None` | Top-level named 2D field monitor registered via `study.monitors` |
| `MonitorTarget` | `kind` (`"magnetic_domain"` \| `"domain"` \| `"object"` \| `"region"`), `object_id=None`, `region_id=None` | Spatial scope evaluated by the monitor |
| `PlanarFrame` | `origin`, `normal`, `u_axis`, `extent: PlanarExtent`, `preset` (`"xy"` \| `"xz"` \| `"yz"` \| `None`) | Orthonormal 2D sampling plane frame |
| `PlanarExtent` | `kind` (`"explicit"` \| `"target_bounds"` \| `"magnetic_domain"` \| `"universe"`), `u=None`, `v=None`, `padding_m=0.0` | In-plane $(u, v)$ bounds |
| `PlaneSample` / `SlabAverage` / `DepthProjection` / `SurfaceProjection` | `PlaneSample()`; `SlabAverage(thickness)`; `DepthProjection(reduction="mean_occupied", empty_policy="exclude_empty")`; `SurfaceProjection(boundary=SurfaceBoundary(...), visibility_policy="frontmost")` | Sampling or projection operator across the target volume or surface |

### Complete stage-first example

```python
# %% Periodic full-vector magnetization snapshot
import fullmag as fm

nm = 1.0e-9

study = fm.study("snapshots_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.snapshot("m", every=1.0e-13)  # full 3D magnetization snapshot
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-outputs-snapshots-problem-ir)=
## ProblemIR
`Snapshot.to_ir()` emits `{"kind": "snapshot", "field": ..., "component": ..., "every_seconds": ...}` plus optional `layer`.

(python-api-outputs-snapshots-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Unknown fields, invalid components, and non-positive cadences fail immediately.

(python-api-outputs-snapshots-discrete-realization)=
## Discrete realization
Snapshots are materialized by the runtime field-store writer at the requested cadence.

(python-api-outputs-snapshots-implementation-mapping)=
## Implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Materializes nodal snapshots and planar slices over tetrahedral/prismatic meshes. |
| FEM | GPU | `documented` | Streams accepted device snapshots and planar slice evaluations. |
| FDM | CPU | `documented` | Materializes Cartesian 3D and per-layer snapshots and planar cuts. |
| FDM | GPU | `documented` | Streams GPU snapshots and bounded binary planar slice payloads. |

(python-api-outputs-snapshots-validation)=
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-outputs-snapshots-limitations)=
## Limitations
A snapshot request is an output contract; availability of a given field still depends on the selected interaction and lane.

(python-api-outputs-snapshots-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Field snapshot scheduling (`Autosave`) and 2D/offline snapshot inspection are `partial`; unlisted serialization options remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
| --- | --- | --- | --- |
| Snapshot field & component scheduling | `Model Explorer -> Stages -> <stage> -> Autosave` (`FieldAutosaveStageSpec`) | `partial` | Submit autosave draft; output resources are revised after execution |
| Interactive 2D slice, multi-layer overlays, & tiled multislice view | `Field Map (2D)` (`FieldMapModule`, `PlanarFieldLayerList`, `PlanarMultisliceGrid`) | `implemented` (`inspection-only`) | Orthogonal `XY`/`XZ`/`YZ` cuts, streamlines, contours, line-profile CSV export |
| Hysteresis & saved SolutionSet frame playback | `Field Map (2D)` (`PlanarSnapshotNavigator`) & `Results Navigator` (`SavedResultsBrowser`) | `inspection-only` | Deterministic frame stepping and side-by-side comparison across materialized snapshots |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Autosave` | `Python-only` | Authored in Python |

```{image} /_static/images/ui/planar-2d-field-map-overview.png
:alt: 2D Planar Field Map showing slice plane selector, vector glyphs, color scale, and live probe readout
:align: center
:width: 100%
```

```{image} /_static/images/ui/planar-2d-multislice-and-layers.png
:alt: 2D Planar Field Map displaying tiled multislice grid panels and ordered multi-layer overlay list
:align: center
:width: 100%
```

```{image} /_static/images/ui/results-saved-navigator-comparison.png
:alt: Saved Results Navigator inspecting materialized snapshots and comparing SolutionSet runs
:align: center
:width: 100%
```

Output parameters outside `FieldAutosaveStageSpec` remain Python-only.
See {doc}`/frontend/capability-register`, {doc}`/frontend/visualization/planar-2d-and-monitors`, and {doc}`/frontend/visualization/charts-and-playback`.
Frontend source owners: `apps/control-room/src/modules/inspector/inspectors/study/stages/FieldAutosaveStageSpec.tsx`, `apps/control-room/src/modules/inspector/inspectors/definitions/PlanarMonitorSpec.tsx`, `FieldMapModule`, `PlanarMultisliceGrid`, and `SavedResultsBrowser`.

(python-api-outputs-snapshots-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| Snapshot field/component selection and lowering | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L175) | [`class Snapshot`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L175) | Field-component snapshot output and lowering | Ownership and API contract tests |
| Planar monitor geometry and projection operators | [`packages/fullmag-py/src/fullmag/model/planar_monitor.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/planar_monitor.py#L393) | [`class PlanarMonitor`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/planar_monitor.py#L393) | 2D slice, slab-average, depth-projection, and surface-projection monitor contracts | Monitor contract tests |
