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

All cell and distance values use SI metres ($\mathrm{m}$). Counts, masks, fractions, strategy names, and mode names
are dimensionless ($1$).

(python-api-meshing-fdm-assumptions-and-validity)=
## Assumptions and validity

At least one default or per-magnet cell specification is required. Cell vectors have exactly three
finite positive components. Conflicting aliases and common-grid specifications fail immediately.
Boundary-correction support remains interaction/device capability-gated.

(python-api-meshing-fdm-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---:|---:|---|---|---|---|
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | Three finite positive values; cannot be combined with `default_cell`. | Legacy alias for the default native cell size. | FDM CPU/GPU | `backend_policy.discretization_hints.fdm.cell` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | Three finite positive values. | Default native cell size inherited by magnets without an override. | FDM CPU/GPU | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.per_magnet` | `dict[str, FDMGrid] \| None` | `None` | $1$ | Nonempty names and `FDMGrid` values. | Object-owned native grid overrides. | FDM CPU/GPU; multilayer capability-gated | `backend_policy.discretization_hints.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | $1$ | Typed, internally consistent demag policy. | Single-grid or multilayer common-grid request. | FDM demagnetization lanes | `backend_policy.discretization_hints.fdm.demag` |
| `FDM.projection_policy` | `str \| None` | `None` | $1$ | `None` or the supported `unit_sphere` policy. | Projected-RK state constraint policy; `None` selects the qualified default. | FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.projection_policy` |
| `FDM.boundary_correction` | `str \| None` | `None` | $1$ | `none`, `volume`, or `full`. | Requested embedded-boundary correction. | Interaction/device capability-gated | `backend_policy.discretization_hints.fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `float \| None` | `None` | $1$ | Strictly between zero and one. | Minimum stable partial-cell volume fraction. | Boundary-correction lanes | `backend_policy.discretization_hints.fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `float \| None` | `None` | $\mathrm{m}$ | Finite and nonnegative. | Minimum geometric distance used by full correction. | Boundary-correction lanes | `backend_policy.discretization_hints.fdm.boundary_delta_min` |

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
parameters. Unsupported combinations fail capability checks without silent fallback.

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
documented in the backend FDM meshing branch and {ref}`numerical-methods-performance-fdm-core`.

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
   nonuniform magnetization,” *Journal of Geophysical Research: Solid Earth* **98**(B6), 9551–9555 (1993),
   [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
2. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *The European Physical Journal B*
   **92**(6), 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6) |
   [arXiv:1810.12365](https://arxiv.org/abs/1810.12365).

## Control Room

Control Room provides interactive default FDM structured-grid sizing and grid building in `apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx` (`MeshRootInspectorSpecPanel`, supporting cell size/count, single 3-D vs multilayer Z-slices, live $l_{\mathrm{ex}}$ checks, 7-smooth FFT snapping, and Save & Build Grid), plus read-only per-grid diagnostics in `apps/control-room/src/modules/inspector/inspectors/mesh/fdm/FdmGridSpec.tsx` (`FdmGridInspectorSpecPanel`). Per-magnet `FDMGrid` mappings, `FDMDemag` policies, `projection_policy`, and boundary-correction parameters remain `Python-only`.

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Default FDM grid sizing and build | `Model Explorer -> Mesh` (`MeshRootSpec.tsx`) | `supported` | Interactive cell size/count, Z-stack mode, $l_{\mathrm{ex}}$ guard, 7-smooth snap, Save & Build Grid ({doc}`/frontend/meshing/fdm-grid-view`) |
| Structured grid dimensions and inspection | `Model Explorer -> Mesh -> <grid>` (`FdmGridSpec.tsx`) | `inspection-only` | Read-only grid dimensions, cell spacing, origins, and domain extents |
| Per-magnet `FDMGrid`, `FDMDemag`, `projection_policy`, boundary correction | — | `Python-only` | Configured directly in Python |

See {doc}`/frontend/meshing/fdm-grid-view` and [Control Room capability register](/frontend/capability-register) for browser support details (`apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx`).

(python-api-meshing-fdm-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| constructor and lowering | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L220) | [`class FDM`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L220) | default/per-magnet grid, projection, and boundary policy | signature and IR tests |
| per-magnet grid | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L19) | [`class FDMGrid`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L19) | positive cell triple | validation tests |
| demag grid policy | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L51) | [`class FDMDemag`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L51) | strategy, mode, common-grid, and `fft_backend` validation | validation tests |

```{toctree}
:maxdepth: 2

../../discretization/fdm
grid
per-magnet-grids
boundary-correction
../../discretization/fdm-multilayer-convolution
```
