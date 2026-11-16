---
title: Snapshots
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-snapshots)=
# Snapshots

(python-api-outputs-snapshots-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the periodic field-component snapshot output.

(python-api-outputs-snapshots-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; snapshots persist field components at a cadence.

(python-api-outputs-snapshots-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
`every` is in seconds; the stored component carries the field's unit.

(python-api-outputs-snapshots-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Field, component, and positive cadence are validated immediately.

(python-api-outputs-snapshots-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| --- | --- | --- | $1$ | --- | --- | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | --- |
| `Snapshot.field` | `str` | `required` | $1$ | Known field id | Base field | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `snapshot.field` |
| `Snapshot.component` | `str` | `required` | $1$ | `x`, `y`, `z`, or `3D` | Component selector | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `snapshot.component` |
| `Snapshot.every` | `float` | `required` | $\mathrm{s}$ | Positive | Save interval | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `snapshot.every_seconds` |
| `Snapshot.layer` | `str \| None` | `None` | $1$ | Non-empty when set | Layer/region scope | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `snapshot.layer` |

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
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.snapshot("m", every=1.0e-13)  # full 3D magnetization snapshot
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-outputs-snapshots-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`Snapshot.to_ir()` emits `{"kind": "snapshot", "field": ..., "component": ...,
"every_seconds": ...}` plus optional `layer`.

(python-api-outputs-snapshots-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in ProblemIR; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Unknown fields, invalid components, and non-positive cadences fail immediately.

(python-api-outputs-snapshots-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Snapshots are materialized by the runtime field-store writer at the requested cadence.

(python-api-outputs-snapshots-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/outputs.py` (`class Snapshot`,
`parse_snapshot_quantity`).

(python-api-outputs-snapshots-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-outputs-snapshots-limitations)=
<!-- (limitations)= -->
## Limitations
A snapshot request is an output contract; availability of a given field still depends on the
selected interaction and lane.

(python-api-outputs-snapshots-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-outputs-snapshots-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Field snapshot scheduling (`Autosave`) and 2D/offline snapshot inspection are `partial`; unsupported raw serialization options remain not implemented.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Snapshot field & component scheduling | `Model Explorer -> Stages -> <stage> -> Autosave` (`AutosaveStageInspector`) | `partial` | Submit autosave draft; output resources are revised after execution |
| Interactive 2D slice, multi-layer overlays, & tiled multislice view | `Field Map (2D)` (`FieldMapModule`, `PlanarFieldLayerList`, `PlanarMultisliceGrid`) | `implemented` (`inspection-only`) | Orthogonal `XY`/`XZ`/`YZ` cuts, streamlines, contours, line-profile CSV export |
| Hysteresis & saved SolutionSet frame playback | `Field Map (2D)` (`PlanarSnapshotNavigator`) & `Results Navigator` (`SavedResultsBrowser`) | `inspection-only` | Deterministic frame stepping and side-by-side comparison across materialized snapshots |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Autosave` | `not implemented` | Python-only until implemented |

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

not implemented: frontend support for output parameters not rendered by the autosave/result inspectors.
See [Control Room capability register](/frontend/capability-register), [2D Planar Field Map](/frontend/visualization/planar-2d-and-monitors), and [Charts & Playback](/frontend/visualization/charts-and-playback).
Frontend source owners: `apps/control-room/src/modules/inspector/panels/stages/AutosaveStageInspector.tsx (AutosaveStageInspector)`, `FieldMapModule`, `PlanarMultisliceGrid`, and `SavedResultsBrowser`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Snapshot output | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L175) | [`class Snapshot`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L175) | Field-component output | Ownership test |

### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Snapshot field/component selection and lowering. | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L175) | [`class Snapshot`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L175) | Snapshot field/component selection and lowering. | Source-map validator and focused API tests |
