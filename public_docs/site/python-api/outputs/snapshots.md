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
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `Snapshot.field` | `str` | `required` | Known field id | Base field | `snapshot.field` |
| `Snapshot.component` | `str` | `required` | `x`, `y`, `z`, or `3D` | Component selector | `snapshot.component` |
| `Snapshot.every` | `float` | `required` | Positive | Save interval | `snapshot.every_seconds` |
| `Snapshot.layer` | `str \| None` | `None` | Non-empty when set | Layer/region scope | `snapshot.layer` |

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
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Snapshot output | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class Snapshot` | Field-component output | Ownership test |
