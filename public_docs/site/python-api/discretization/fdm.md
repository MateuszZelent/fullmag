---
title: FDM
status: partial
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
| `FDM.cell` | `three positive floats or `None`` | `None` | $\mathrm{m}$ | Canonical uniform cell size; it also becomes `default_cell` when supplied. | Canonical uniform cell size; it also becomes `default_cell` when supplied. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.cell` |
| `FDM.default_cell` | `three positive floats or `None`` | `None` | $\mathrm{m}$ | Default cell size when per-magnet grids are present. | Default cell size when per-magnet grids are present. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.per_magnet` | `mapping or `None`` | `None` | $1$ | Optional explicit per-magnet FDM grids. | Optional explicit per-magnet FDM grids. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag | None` | `None` | $1$ | Demagnetization hint. | Demagnetization hint. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.demag` |
| `FDM.boundary_correction` | `str | None` | `None` | $1$ | Optional `T0`/`T1`-family sub-cell policy. Support differs by precision and device. | Optional `T0`/`T1`-family sub-cell policy. Support differs by precision and device. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `float | None` | `None` | $1$ | Optional lower bound $\varphi_{\mathrm{floor}}$ with strict domain $0<\varphi_{\mathrm{floor}}<1$. | Optional lower bound $\varphi_{\mathrm{floor}}$ with strict domain $0<\varphi_{\mathrm{floor}}<1$. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `float | None` | `None` | $\mathrm{m}$ | Optional T1 distance floor $\delta_{\min}\geq0$; zero is accepted. | Optional T1 distance floor $\delta_{\min}\geq0$; zero is accepted. | FEM/FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.boundary_delta_min` |

```python
# %%
import inspect
import fullmag as fm
# %%
print(inspect.signature(fm.FDM))
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
