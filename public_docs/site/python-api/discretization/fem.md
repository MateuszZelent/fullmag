---
title: FEM
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-fem)=
# FEM

(python-api-discretization-fem-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-discretization-fem-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-discretization-fem-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-discretization-fem-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-discretization-fem-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FEM.order` | `int` | `required` | $1$ | Positive finite-element order. | Positive finite-element order. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `positive float` | `required unless hmax is supplied` | $\mathrm{m}$ | Canonical maximum element size. Construction fails if neither spelling is provided. | Canonical maximum element size. Construction fails if neither spelling is provided. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fem.maximum_element_size` |
| `FEM.hmax` | `positive float \| None` | `None` | $\mathrm{m}$ | Alternate input spelling for the same required size; unequal simultaneous values are rejected. | Alternate input spelling for the same required size; unequal simultaneous values are rejected. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fem.maximum_element_size` |
| `FEM.mesh` | `str \| None` | `None` | $1$ | Optional imported mesh reference. | Optional imported mesh reference. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fem.mesh` |
| `FEM.demag_solver_policy` | `policy or None` | `None` | $1$ | Demagnetization linear-solver policy. | Demagnetization linear-solver policy. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fem.demag_solver_policy` |


### Complete FEM stage scenario

FEM authoring includes the shared domain, object mesh, demagnetization realization, linear-solver
policy, and the ordered stage graph.

```python
# %% FEM discretization in the public stage workflow
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(800 * nm, 400 * nm, 300 * nm))
study.universe.mesh(maximum_element_size=40 * nm, maximum_element_growth_rate=1.7)
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
film.mesh(maximum_element_size=5 * nm, order=1)
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1.0e-10, max_iterations=500)
study.build_domain_mesh()
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-discretization-fem-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-discretization-fem-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-discretization-fem-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-discretization-fem-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/discretization.py` and `class FEM`.

(python-api-discretization-fem-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-discretization-fem-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-discretization-fem-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-discretization-fem-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | Canonical Python API behavior | Ownership test and source-map validator |
