---
title: FDM
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-fdm)=
# FDM

(python-api-discretization-fdm-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-discretization-fdm-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-discretization-fdm-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-discretization-fdm-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-discretization-fdm-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | Exactly three finite positive components; mutually exclusive with `default_cell`. | Legacy alias copied to `default_cell`. | FDM CPU/GPU; planner checks the requested lane | `backend_policy.discretization_hints.fdm.cell` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | Exactly three finite positive components; either this or non-empty `per_magnet` is required. | Default cell size for magnets without an override. | FDM CPU/GPU; planner checks the requested lane | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.per_magnet` | `dict[str, FDMGrid] \| None` | `None` | $1$ | Non-empty string keys and `FDMGrid` values; may be the sole cell specification when non-empty. | Explicit native grids keyed by magnet name. | FDM CPU/GPU; multilayer capability-gated | `backend_policy.discretization_hints.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | $1$ | No explicit constructor type check; lowering requires an object with `to_ir()`. | Demagnetization grid/topology hint. | FDM demagnetization lanes | `backend_policy.discretization_hints.fdm.demag` |
| `FDM.boundary_correction` | `str \| None` | `None` | $1$ | `none`, `volume`, or `full`. | Binary, T0 volume-fraction, or T1 full sub-cell policy. | FDM interaction/device capability-gated | `backend_policy.discretization_hints.fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `float \| None` | `None` | $1$ | Strictly $0<\varphi_{\mathrm{floor}}<1$. | Lower volume-fraction stability bound. | FDM boundary-correction lanes | `backend_policy.discretization_hints.fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `float \| None` | `None` | $\mathrm{m}$ | Values below zero are rejected; zero is accepted, but the constructor does not reject `NaN`. | T1 distance floor. | FDM boundary-correction lanes | `backend_policy.discretization_hints.fdm.boundary_delta_min` |


### Complete FDM stage scenario

The FDM grid is selected on the study before the physical stages are declared.

```python
# %% FDM discretization in the public stage workflow
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
study.exchange()
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-discretization-fdm-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-discretization-fdm-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-discretization-fdm-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-discretization-fdm-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/discretization.py` and `class FDM`.

(python-api-discretization-fdm-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-discretization-fdm-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-discretization-fdm-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-discretization-fdm-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | Canonical Python API behavior | Ownership test and source-map validator |
