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
