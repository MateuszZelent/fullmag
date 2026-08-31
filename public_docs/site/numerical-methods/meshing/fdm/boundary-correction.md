---
title: "FDM boundary correction"
description: "Cut-cell FDM boundary-correction request."
summary: "Boundary correction is lowered as an FDM hint and fails closed when unsupported."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "FDM schema and planner tests"
---

(public-docs-numerical-methods-meshing-fdm-boundary-correction)=
# FDM boundary correction

(fdm-boundary-correction-problem-statement)=
## Physical problem

`FDM` records a requested Cartesian cut-cell tier: `none`, `volume`, or `full`. It is an FDM discretization hint, not FEM surface meshing, and does not permit an implicit fallback to `none`.

(fdm-boundary-correction-governing-equations)=
## Governing equations

The following occupancy-weighted energy is a conceptual quadrature model used to explain the
meaning of a volume fraction. It is **not** an implementation-backed formula from the cited
`FDM` schema or planner tests; those sources only validate, lower, and plan boundary hints.

```{math}
:label: eq-fdm-boundary-energy
E_h = \sum_i \phi_i V_\mathrm{cell} w_i .
```

(fdm-boundary-correction-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $E_h$ | discrete energy | J |
| $\phi_i$ | magnetic cell occupancy | 1 |
| $V_\mathrm{cell}$ | Cartesian cell volume | m^3 |
| $w_i$ | discrete energy density | J m^-3 |

(fdm-boundary-correction-assumptions-and-validity)=
## Assumptions and validity

`volume` and `full` require planner-supported boundary geometry. Planner tests reject geometry without a supported SDF and periodic corrected FDM until seam-aware parity is established. `boundary_delta_min` currently has no finiteness check: Python rejects values for which `value < 0.0` is true, but `NaN` makes that comparison false and therefore passes into IR. Perform a cell-size convergence study.

(fdm-boundary-correction-python-api)=
## Python API

```python
# %%
import fullmag as fm
nm = 1e-9
study = fm.study("boundary-grid")
study.engine("fdm")
study.fdm(
    default_cell=(2 * nm, 2 * nm, 2 * nm),
    boundary_correction="full",
    boundary_phi_floor=0.1,
    boundary_delta_min=0.2 * nm,
)
study.demag()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `boundary_correction` | `str \| None` | `None` | 1 | `none`, `volume`, or `full` | requested correction tier | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `backend_policy.discretization_hints.fdm.boundary_correction` |
| `boundary_phi_floor` | `float \| None` | `None` | 1 | strictly in `(0, 1)` | requested occupancy floor | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `backend_policy.discretization_hints.fdm.boundary_phi_floor` |
| `boundary_delta_min` | `float \| None` | `None` | m | rejects values `< 0.0`; zero, positive values, and `NaN` pass | requested length regularizer | FDM CPU source-backed; GPU capability-gated; FEM not applicable | `backend_policy.discretization_hints.fdm.boundary_delta_min` |

(fdm-boundary-correction-problem-ir)=
## ProblemIR

`StudyBuilder.fdm(...)` applies the settings to the current study. Its resulting `FDM.to_ir()`
payload emits each non-`None` field under `backend_policy.discretization_hints.fdm`.

(fdm-boundary-correction-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is preserved in `FDM.to_ir()`. Resolved execution is the accepted FDM plan. Validation errors cover invalid tiers, invalid floors, and finite negative `boundary_delta_min`; `NaN` is not rejected and lowers unchanged. Unsupported combinations, including unsupported SDF geometry and unqualified periodic/correction paths, are rejected rather than changed silently.

(fdm-boundary-correction-discrete-realization)=
## Discrete realization

The planner carries the requested fields and builds boundary geometry only when supported; corrected and uncorrected grids are different discrete models.

(fdm-boundary-correction-implementation-mapping)=
## Implementation mapping

Python validation/lowering is `FDM`; planner tests cover passthrough and unsupported-SDF rejection.

(fdm-boundary-correction-validation)=
## Validation

Sweep cell size and correction tier, record IR/backend/precision and energy or target observable, then require explicit rejection for unsupported geometry.

(fdm-boundary-correction-limitations)=
## Limitations

No universal CPU/GPU parity or accuracy order is established. The displayed energy equation is conceptual, not a transcription of a backend kernel. The missing finiteness guard for `boundary_delta_min` means callers must reject `NaN` themselves. The example applies all four FDM settings directly through `StudyBuilder.fdm(...)`.

(fdm-boundary-correction-scientific-bibliography)=
## Scientific bibliography

- C. Abert, *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- A. J. Newell, W. Williams and D. J. Dunlop, *J. Geophys. Res.* **98** (1993), 9551-9555, [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).

(fdm-boundary-correction-source-code-index)=
## Source-code index

| Source | Stable symbol | Evidence |
| --- | --- | --- |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | public `fdm(...)` route used by the example |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | validates and lowers fields; it does not implement the conceptual energy equation |
| `crates/fullmag-plan/src/tests.rs` | `fdm_boundary_params_passthrough_phi_floor_and_delta_min` | planner passthrough |
| `crates/fullmag-plan/src/tests.rs` | `fdm_boundary_correction_rejects_geometry_without_supported_sdf` | fail-closed geometry |

## Scope and purpose

This page defines the public contract for FDM boundary correction. It is an authoring and implementation reference: the Python example, the serialized ProblemIR description, the implementation mapping, and the adjacent source map are the source-backed contract. A capability marked partial or not evaluated is not presented as a production guarantee.

## Scientific and numerical model

The mesh or grid is a discrete approximation of the continuous domain. For a Cartesian partition, each spacing satisfies `Delta_i = L_i / N_i`; for a geometry-dependent FEM mesh, the requested local target is bounded by the active bulk, interface, boundary, and topology constraints. In compact form, `h_target(x) = min(h_bulk(x), h_interface(x), h_boundary(x))`. Length quantities use SI metres (`m`); counts, orders, and topology labels are dimensionless.

The equations and assumptions in the earlier physical-problem and governing-equations sections state the model-specific specialization. This section does not introduce a conversion from FEM to FDM, a hidden topology conversion, or a silent CPU fallback.

## Parameters

The exact callable and argument names are the ones shown in the `## Python API` section above. For this page the parameter family is cell_size and the boundary-correction controls shown in the Python API example. Use the documented defaults, validation rules, and ProblemIR lowering exactly as shown; do not replace a canonical argument with an unlisted alias. Numerical lengths must be supplied in metres, and invalid positive-length, count, order, periodicity, or topology constraints must fail closed rather than being silently repaired.

## Control Room workflow

In Control Room, select the engine and mesh workflow, enter the same values as the Python authoring example, inspect the planned mesh or grid report, and only then submit the run. The UI is a projection of the public contract: a missing control is not evidence that the backend accepts the option, and a visible control is not evidence that a production lane is enabled. When the page or capability register marks a field partial or not evaluated, keep the workflow explicitly bounded to the implemented path.

## Diagnostics and failure semantics

A valid request must preserve the declared geometry, units, element or cell topology, and backend lane. Reject non-finite or non-positive lengths, invalid counts and orders, incompatible periodic or shared-boundary data, and unsupported topology combinations at the owning validation layer. Reports should retain requested and resolved values, source identity, and any capability gate. No diagnostic may hide a failed mesh realization by substituting another discretization.

## Where this is implemented

The existing implementation-mapping and source-code-index sections identify the exact public authoring, ProblemIR, planner, realization, and runtime owners for this topic. The adjacent `.source-map.json` file is the machine-readable source of truth for those paths, symbols, responsibilities, backend matrix, and reviewed revision. Claims in this page must be updated together with that map when an owner moves.