---
title: FDM Meshing API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fdm-root)=
# FDM Meshing API

(python-api-meshing-fdm-problem-statement)=
## Problem statement

`FDM(...)` defines requested Cartesian-grid intent. The planner resolves integer dimensions,
origins, masks, optional per-magnet grids, common convolution-grid policy, boundary correction,
device, and precision.

(python-api-meshing-fdm-governing-equations)=
## Governing equations

This API introduces no independent physical equation. It selects the structured discrete space used
by FDM interaction and time-integration operators.

(python-api-meshing-fdm-symbols-and-si-units)=
## Symbols and SI units

All cell and distance values are SI metres. Counts, masks, fractions, strategy names, and mode names
are dimensionless.

(python-api-meshing-fdm-assumptions-and-validity)=
## Assumptions and validity

At least one default or per-magnet cell specification is required. Cell vectors have exactly three
finite positive components. Conflicting aliases and common-grid specifications fail immediately.
Boundary-correction support remains interaction/device capability-gated.

(python-api-meshing-fdm-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---:|---:|---|---|---|---|
| `FDM.cell` | `Sequence[float] \| None` | `None` | m | Three finite positive values; cannot be combined with default_cell. | Legacy alias for the default native cell size. | FDM CPU/GPU | `backend_policy.discretization_hints.fdm.cell` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | m | Three finite positive values. | Default native cell size inherited by magnets without an override. | FDM CPU/GPU | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.per_magnet` | `dict[str, FDMGrid] \| None` | `None` | 1 | Nonempty names and FDMGrid values. | Object-owned native grid overrides. | FDM CPU/GPU; multilayer capability-gated | `backend_policy.discretization_hints.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | 1 | No explicit `FDM` constructor type check; lowering requires `FDMDemag.to_ir()`. | Single-grid or multilayer common-grid request. | FDM demagnetization lanes | `backend_policy.discretization_hints.fdm.demag` |
| `FDM.boundary_correction` | `str \| None` | `None` | 1 | `none`, `volume`, or `full`. | Requested embedded-boundary correction. | Interaction/device capability-gated | `backend_policy.discretization_hints.fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `float \| None` | `None` | 1 | Strictly between zero and one. | Minimum stable partial-cell volume fraction. | Boundary-correction lanes | `backend_policy.discretization_hints.fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `float \| None` | `None` | m | Values below zero are rejected; zero and `NaN` currently pass the Python constructor. | Minimum geometric distance used by full correction. | Boundary-correction lanes | `backend_policy.discretization_hints.fdm.boundary_delta_min` |

```python
# %% Complete stage-first FDM mesh scenario
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_meshing_api")
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
study.demag()
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-meshing-fdm-problem-ir)=
## ProblemIR

The table gives canonical request destinations. Resolved execution adds integer shape, origin,
spacing, masks/fractions, FFT padding, common-grid transfer, kernel digest, device, and precision.

(python-api-meshing-fdm-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is preserved independently from resolved execution. Validation errors reject
nonpositive cells, alias conflicts, invalid strategy/mode combinations, and invalid boundary
parameters. `boundary_delta_min=NaN` is a known constructor-validation gap and must not be treated
as a valid realized value. Unsupported combinations fail capability checks without silent fallback.

(python-api-meshing-fdm-discrete-realization)=
## Discrete realization

| Solver | Device | Contract |
|---|---|---|
| FDM | CPU | host Cartesian state, masks, stencils, and FFT resources |
| FDM | GPU | identical semantic grid with device arrays and qualified CUDA kernels |
| FEM | CPU/GPU | not applicable; FEM uses conforming elements |

(python-api-meshing-fdm-implementation-mapping)=
## Implementation mapping

The constructor and typed subpolicies lower in `fullmag.model.discretization`; runtime realization is
documented in the backend FDM meshing branch.

(python-api-meshing-fdm-validation)=
## Validation

Verify coordinate reconstruction, magnetic volume, constant/affine stencil behavior, mask/fraction
convergence, common-grid transfer, kernel cache identity, and CPU/GPU parity on one serialized grid.

(python-api-meshing-fdm-limitations)=
## Limitations

Cartesian grids staircase arbitrary curved boundaries, one thickness cell is a thickness-averaged
model, and public boundary-correction fields do not establish universal kernel support.

(python-api-meshing-fdm-scientific-bibliography)=
## Scientific bibliography

1. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *J. Geophys. Res.* **98**, 9551–9555 (1993).
2. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *Eur. Phys. J. B*
   **92**, 120 (2019).

(python-api-meshing-fdm-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| constructor and lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | default/per-magnet grid and boundary policy | signature and IR tests |
| per-magnet grid | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | positive cell triple | validation tests |
| demag grid policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | strategy, mode, and common-grid consistency | validation tests |

```{toctree}
:maxdepth: 2

../../discretization/fdm
grid
per-magnet-grids
boundary-correction
../../discretization/fdm-multilayer-convolution
```
