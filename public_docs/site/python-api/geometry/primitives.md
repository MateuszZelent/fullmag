---
title: Primitives
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-primitives)=
# Primitives

(python-api-geometry-primitives-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-geometry-primitives-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-geometry-primitives-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-geometry-primitives-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-geometry-primitives-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Box.size_or_x` | `three floats, scalar, or `None`` | `None` | $\mathrm{m}$ | Positional size input; when size= is supplied, the implementation uses size and ignores positional size values. | Positional size input; when size= is supplied, the implementation uses size and ignores positional size values. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].shape.size` |
| `Box.y` | `float \| None` | `None` | $\mathrm{m}$ | Positional $L_y$ when scalar `size_or_x` is used. | Positional $L_y$ when scalar `size_or_x` is used. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].shape.size` |
| `Box.z` | `float \| None` | `None` | $\mathrm{m}$ | Positional $L_z$ when scalar `size_or_x` is used. | Positional $L_z$ when scalar `size_or_x` is used. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].shape.size` |
| `Box.size` | `three positive floats` | `required in keyword form` | $\mathrm{m}$ | Keyword size; when supplied, it takes precedence and positional size values are ignored. | Keyword size; when supplied, it takes precedence and positional size values are ignored. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].shape.size` |
| `Box.name` | `str` | `"box"` | $1$ | Non-empty geometry identity. | Non-empty geometry identity. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].name` |


### Complete geometry stage scenario

Geometry is introduced through `study.geometry(...)` and then used by a fully configured magnetic
study; constructing a `Box` alone is not an executable example.

```python
# %% Box geometry in a complete stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("box_geometry_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
study.exchange()
film = study.geometry(fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-geometry-primitives-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-geometry-primitives-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-geometry-primitives-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-geometry-primitives-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/geometry.py` and `class Box`.

(python-api-geometry-primitives-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-geometry-primitives-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-geometry-primitives-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-geometry-primitives-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Box` | Canonical Python API behavior | Ownership test and source-map validator |
