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
## Contract
This page records the current public Python authoring contract and canonical lowering for `FDM` and `FDMDemag`; it does not redefine solver physics. For CUDA and CPU FDM acceleration details (batched cuFFT, device-resident PG-BB, and fused kernels), see {ref}`numerical-methods-performance-fdm-core`.

(python-api-discretization-fdm-governing-equations)=
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-discretization-fdm-symbols-and-si-units)=
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-discretization-fdm-assumptions-and-validity)=
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-discretization-fdm-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDM.cell` | `tuple[float, float, float] \| None` | `None` | $\mathrm{m}$ | Three finite positive values; cannot coexist with `default_cell`. | Canonical uniform cell size; also populates `default_cell` when supplied. | FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.cell` |
| `FDM.default_cell` | `tuple[float, float, float] \| None` | `None` | $\mathrm{m}$ | Three finite positive values; required unless `per_magnet` is nonempty. | Default cell size when per-magnet grids are present. | FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.per_magnet` | `dict[str, FDMGrid] \| None` | `None` | $1$ | Nonempty string keys and `FDMGrid` values. | Optional explicit per-magnet FDM grids. | FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | $1$ | Typed `FDMDemag` policy. | Demagnetization strategy, common-grid, and FFT backend hint. | FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.demag` |
| `FDM.projection_policy` | `str \| None` | `None` | $1$ | `None` or `"unit_sphere"`. | Projected-RK state constraint policy; `None` selects the qualified default. | FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.projection_policy` |
| `FDM.boundary_correction` | `str \| None` | `None` | $1$ | `"none"`, `"volume"`, or `"full"`. | Optional `T0`/`T1`-family sub-cell policy; support differs by precision and device. | FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `float \| None` | `None` | $1$ | Strict domain $0<\varphi_{\mathrm{floor}}<1$. | Optional lower volume-fraction bound $\varphi_{\mathrm{floor}}$. | FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `float \| None` | `None` | $\mathrm{m}$ | Nonnegative $\delta_{\min}\geq0$; zero is accepted. | Optional T1 distance floor $\delta_{\min}$. | FDM CPU/GPU; planner checks combinations | `backend_policy.discretization_hints.fdm.boundary_delta_min` |
| `FDMDemag.common_cell_size` | `tuple[float, float, float] \| None` | `None` | $\mathrm{m}$ | Three finite positive values; mutually exclusive with `common_cells` and `common_cells_xy`. | Explicit 3-D common convolution-grid cell size. | FDM CPU/GPU multilayer lanes | `backend_policy.discretization_hints.fdm.demag.common_cell_size` |
| `FDMDemag.fft_backend` | `Literal["auto", "rustfft", "fftw", "mkl", "cufft"]` | `"auto"` | $1$ | One of `"auto"`, `"rustfft"`, `"fftw"`, `"mkl"`, or `"cufft"`. | Requested FFT realization; unsupported realizations are preserved in IR and rejected fail-closed by capability planning. | FDM CPU/GPU; capability-gated per device | `backend_policy.discretization_hints.fdm.demag.fft_backend` |

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
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-discretization-fdm-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-discretization-fdm-discrete-realization)=
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation and {ref}`numerical-methods-performance-fdm-core`.

(python-api-discretization-fdm-implementation-mapping)=
## Implementation mapping
`FDM` and `FDMDemag` are implemented in `packages/fullmag-py/src/fullmag/model/discretization.py` (`class FDM`, `class FDMDemag`).

(python-api-discretization-fdm-validation)=
## Validation
Contract tests compare this inventory with live `FDM` and `FDMDemag` signatures and `ProblemIR` lowering.

(python-api-discretization-fdm-limitations)=
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-discretization-fdm-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

## Control Room support

Interactive FDM structured-grid sizing is live in `apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx` (`MeshRootInspectorSpecPanel`), providing cell-size and cell-count editing, single 3-D vs multilayer Z-slice mode, live $l_{\mathrm{ex}}$ resolution checks, 7-smooth FFT snapping, and Save & Build Grid. Per-grid diagnostics are inspected through `apps/control-room/src/modules/inspector/inspectors/mesh/fdm/FdmGridSpec.tsx` (`FdmGridInspectorSpecPanel`). Low-level fields without a dedicated UI widget (such as `projection_policy`, `fft_backend`, and embedded-boundary floors) remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Default FDM grid sizing and build | `Model Explorer -> Mesh` (`MeshRootSpec.tsx`) | `supported` | Edit cell size or cell count and run Save & Build Grid |
| Realized grid, layer, and cell inspection | `Model Explorer -> Mesh -> <grid>` (`FdmGridSpec.tsx`) | `inspection-only` | Read-only grid dimensions, spacing, origins, and masks |
| `projection_policy`, `fft_backend`, boundary-correction floors | — | `Python-only` | Authored in Python scripts |

See {doc}`/frontend/meshing/fdm-grid-view` and the [Control Room capability register](/frontend/capability-register) for UI coverage details.

(python-api-discretization-fdm-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L220) | [`class FDM`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L220) | Canonical FDM Python API behavior and lowering | Signature and IR lowering contract tests |
| FDM demag policy and FFT backend | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L51) | [`class FDMDemag`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L51) | Strategy, mode, common-grid sizing, and `fft_backend` validation/lowering | Signature and IR lowering contract tests |
| Control Room interactive FDM grid sizing | [`apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx#L52) | [`MeshRootInspectorSpecPanel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx#L52) | Interactive FDM cell-size/count sizing and grid build workflow | Control Room mesh inspector tests |
