---
title: Demagnetization
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-demagnetization)=
# Demagnetization Python API

This page documents the Python authoring contract. The physical equations and backend realization
details live in {doc}`../../physics/interactions/demagnetization/index`; this page owns constructor
signatures, validation, lowering, and copyable examples.

For the complete multilayer workflow, including per-magnet native grids, common convolution cells,
`ProblemIR`, Explorer, Airbox and viewport configuration, see
{doc}`../discretization/fdm-multilayer-convolution`.

(demag-api-problem-statement)=
## Physical problem

`fullmag.Demag` enables the non-local magnetostatic interaction. It has no floating-point physical
coefficient of its own: magnetization and material values come from the magnetic object and the
selected backend discretization.

(demag-api-governing-equations)=
## Governing equations

```{math}
:label: eq-python-demag-field
\mathbf H_{\mathrm d}=-\nabla u,
\qquad
\Delta u=\nabla\cdot\mathbf M.
```

```{math}
:label: eq-python-demag-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

(demag-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $u$ | scalar potential | $\mathrm{A}$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |

(demag-api-assumptions-and-validity)=
## Assumptions and validity

The constructor describes requested semantics, not a guarantee that every backend/device can run
them. Physical validity additionally depends on mesh resolution, boundary policy, solver residual,
and the documented qualification state.

(demag-api-python-api)=
## Constructors and complete parameters


The physical interaction is selected by `Demag`; the remaining objects are numerical policies.
`FDMGrid` and `FDM` control cell geometry and convolution realization. `FEM` controls the finite
element space and attaches `FemLinearSolverPolicy` to the Poisson/BEM sparse solves. These values
do not change the magnetostatic equation or its SI units, but they change the discretization,
algebraic stopping criterion, memory plan, and provenance.

### Object constructors

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `optional str` | `None` | $1$ | `airbox`, `bem`, `fredkin_koehler`, or `fmm`. | Canonical realization family; it does not itself choose CPU or GPU. | Planner-dependent. | `energy[].realization` |
| `Demag.variant` | `optional str` | `None` | $1$ | Only `airbox` accepts `auto`, `robin`, or `dirichlet`; other models reject it. | Selects the FEM airbox outer closure. | FEM airbox lanes. | `energy[].realization` |
| `Demag.realization` | `optional str` | `None` | $1$ | Legacy input; cannot be combined with `model`; aliases are normalized. | Backward-compatible explicit realization. | Normalized before planning. | `energy[].realization` |
| `FDMGrid.cell` | `tuple[float,float,float]` | required | $\mathrm{m}$ | Exactly three finite positive values. | Native Cartesian cell size for one named magnet. | FDM multilayer paths. | `discretization.fdm.per_magnet[name].cell` |
| `FDMDemag.strategy` | `str` | `auto` | $1$ | `auto`, `single_grid`, or `multilayer_convolution`. | Selects one common grid or explicit native-grid convolution. | FDM lanes. | `discretization.demag.strategy` |
| `FDMDemag.mode` | `str` | `auto` | $1$ | `auto`, `two_d_stack`, or `three_d`. | Selects thin-film stack or full-3-D convolution mode. | FDM lanes. | `discretization.demag.mode` |
| `FDMDemag.common_cells` | `optional tuple[int,int,int]` | `None` | $1$ | Exactly three positive integers. | Explicit 3-D common convolution grid. | FDM lanes. | `discretization.demag.common_cells` |
| `FDMDemag.common_cells_xy` | `optional tuple[int,int]` | `None` | $1$ | Exactly two positive integers. | Explicit in-plane common grid for `two_d_stack`. | FDM lanes. | `discretization.demag.common_cells_xy` |
| `FDMDemag.allow_single_grid_fallback` | `optional bool` | `None` | $1$ | Any non-`None` value raises `ValueError`; no silent lowering. | Removed compatibility switch. | No backend support. | Not serialized |
| `FDMDemag.explain` | `bool` | `True` | $1$ | Boolean. | Requests a human-readable plan summary; it is not physics or IR. | FDM authoring helper. | Not serialized |
| `FDM.default_cell` | `optional tuple[float,float,float]` | `None` | $\mathrm{m}$ | Exactly three finite positive values; legacy `cell` is an alias. Required unless `per_magnet` is non-empty. | Default Cartesian cell size used when a magnet has no native override. | FDM CPU/GPU. | `discretization.fdm.default_cell` |
| `FDM.per_magnet` | `optional dict[str,FDMGrid]` | `None` | $1$ | Each entry maps a magnet name to a valid `FDMGrid`. | Native grids for selected magnets in a multilayer problem. | FDM multilayer paths. | `discretization.fdm.per_magnet` |
| `FDM.demag` | `optional FDMDemag` | `None` | $1$ | Nested `FDMDemag` fields are validated individually. | Attaches the FDM demagnetization topology policy. | FDM CPU/GPU. | `discretization.fdm.demag` |
| `FDM.boundary_correction` | `optional str` | `None` | $1$ | `none`, `volume`, or `full`. | Selects no correction, T0 volume-fraction weighting, or T1 full boundary stencil. | Lane/precision dependent. | `discretization.fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `optional float` | `None` | $1$ | Strictly between $0$ and $1$ when supplied. | Minimum partial-cell volume fraction used by correction stability logic. | Boundary-correction lanes. | `discretization.fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `optional float` | `None` | $\mathrm{m}$ | Greater than or equal to $0$ when supplied. | Minimum boundary distance used by the T1 stencil. | Boundary-correction lanes. | `discretization.fdm.boundary_delta_min` |
| `FEM.order` | `int` | required | $1$ | Integer greater than or equal to $1$. | Polynomial order of the FEM potential space. | FEM CPU/GPU subject to planner support. | `backend_policy.discretization_hints.fem.order` |
| `FEM.maximum_element_size` | `float` | required | $\mathrm{m}$ | Finite positive value; `hmax` is an alias. | Target maximum element size. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.hmax` | `optional float` | alias | $\mathrm{m}$ | Must equal `maximum_element_size` when both are supplied. | Short alias for the FEM target element size. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.hmax` |
| `FEM.mesh` | `optional str` | `None` | $1$ | Non-empty when present. | Explicit mesh source; airbox models require the appropriate shared-domain mesh. | FEM planner. | `backend_policy.discretization_hints.fem.mesh` |
| `FEM.demag_solver_policy` | `optional FemLinearSolverPolicy` | `None` | $1$ | Policy fields are validated individually below. | Linear-solver policy attached to FEM demagnetization solves. | FEM CPU/GPU implementation paths. | `backend_policy.discretization_hints.fem.demag_solver_policy` |
| `FemLinearSolverPolicy.solver` | `Literal["CG", "GMRES"]` | `CG` | $1$ | Must be `CG` or `GMRES`. | Krylov method for the sparse FEM system. | FEM CPU/GPU Hypre paths. | `demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG", "JACOBI", "NONE"]` | `AMG` | $1$ | Must be `AMG`, `JACOBI`, or `NONE`. | BoomerAMG, diagonal scaling, or identity preconditioning. | FEM CPU/GPU; device AMG requires device Hypre. | `demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | Finite and strictly positive. | Relative algebraic stopping tolerance; it does not control mesh or airbox truncation error. | FEM CPU/GPU. | `demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.atol` | `optional float` | `None` | $1$ | When supplied, finite and strictly positive. | Optional absolute algebraic stopping tolerance. | FEM CPU/GPU. | `demag_solver_policy.atol` |
| `FemLinearSolverPolicy.max_iterations` | `int` | `500` | $1$ | Integer greater than or equal to $1$. | Hard Krylov iteration limit; non-convergence is a failed solve. | FEM CPU/GPU. | `demag_solver_policy.max_iterations` |
| `FemLinearSolverPolicy.print_level` | `int` | `0` | $1$ | Integer greater than or equal to $0$. | Hypre/MFEM diagnostic verbosity only. | FEM CPU/GPU. | `demag_solver_policy.print_level` |
| `FdmPbc.axes` | `tuple[bool,bool,bool]` | required | $1$ | Exactly three values, normalized to booleans. | Periodic status of x, y, z. | FDM planner and FEM periodic reduction. | `pbc.axes` |
| `FdmPbc.demag` | `str` | `open` | $1$ | `open`, `truncated_images`, or `periodic_airbox_k0`. | Selects the periodic demag Green-function policy. | Solver-specific; planner validates legality. | `pbc.demag` |
| `FdmPbc.image_counts` | `optional tuple[int,int,int]` | `None` | $1$ | Non-negative and only with `truncated_images`. | Number of finite translated images per axis. | FDM. | `pbc.image_counts` |

### Flat scripting functions

The flat API writes to the current script-local study state. It is equivalent in semantics to the
object API, but its return values differ: `fem_demag_solver(...)` returns the policy object;
`demag(...)`, `fdm(...)`, `boundary_correction(...)`, and `demag_quality(...)` update state. Do not
mix the flat and object forms for the same setting without checking the final exported IR.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `demag(enabled=..., model=..., variant=..., realization=...)` | keyword parameters | `enabled=True`, others `None` | mixed | Same `Demag` validation; `model` and `realization` cannot be combined. | Enables/disables the term and selects its requested realization. | Flat scripting API. | `energy[].realization` plus enabled state |
| `fem_demag_solver(solver=..., preconditioner=..., rtol=..., atol=..., max_iterations=..., print_level=...)` | keyword parameters | `CG`, `AMG`, `1e-8`, `None`, `500`, `0` | mixed control units | Same `FemLinearSolverPolicy` validation. | Sets the native FEM linear-solver policy. | FEM CPU/GPU paths. | `discretization.fem.demag_solver_policy` |
| `fdm(default_cell=..., per_magnet=..., demag=..., boundary_correction=..., boundary_phi_floor=..., boundary_delta_min=...)` | keyword parameters | all `None` | mixed | Same `FDM` validation; a default cell or non-empty `per_magnet` is required. | Sets complete FDM discretization hints. | FDM CPU/GPU. | `discretization.fdm` |
| `boundary_correction(mode)` | `str` | not set | $1$ | `none`, `volume`, or `full`. | Sets the flat FDM partial-cell correction mode. | FDM boundary-correction lanes. | `discretization.fdm.boundary_correction` |
| `demag_quality(profile)` | `str` | not set | $1$ | `exact`, `balanced`, or `fast`. | Sets demag refresh cadence: exact every RHS, balanced $5\times10^{-13}\,\mathrm{s}$, fast $2\times10^{-12}\,\mathrm{s}$. | Time-integration refresh policy. | `study.field_refresh.demag_interval_s` |

### Complete FDM demagnetization scenario

The user-facing request is declared on `study`; the backend-specific FDM demagnetization policy is
resolved together with the grid and ordered physical stages.

```python
# %% FDM demagnetization in a complete stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("demagnetization_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
study.demag()
study.exchange()
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(demag-api-problem-ir)=
## ProblemIR lowering

`Demag()` lowers to `{"kind": "demag", "realization": "auto"}`. `model="airbox"` with the
default or Robin variant lowers to `poisson_robin`; Dirichlet lowers to `poisson_dirichlet`.
`FDMDemag` and `FdmPbc` lower to their own discretization and periodicity objects.

(demag-api-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Canonical export preserves requested intent and does not replace it with resolved execution metadata. The
following are validation errors: mixing `model` and `realization`, using an airbox `variant` with
another model, invalid names, supplying `image_counts` for `open`, and requesting
`periodic_airbox_k0` for FDM. Unsupported combinations are planner results, not silent fallbacks.

(demag-api-discrete-realization)=
## Discrete realization

The Python object is backend-neutral. FDM consumes `FDMDemag`; FEM consumes the demag realization
and mesh/solver policy. CPU and GPU paths remain separate execution realizations in provenance.

(demag-api-implementation-mapping)=
## Implementation mapping

`Demag.__post_init__` validates arguments, `_resolved_realization` normalizes aliases, and `to_ir`
creates the canonical term. `FDMDemag.__post_init__` validates FDM policies. `FdmPbc.__post_init__`
validates periodic semantics.

(demag-api-validation)=
## Validation

Test constructor acceptance/rejection, exact IR normalization, Python export round-trip, planner
fail-closed behavior, and materializable output quantities (`H_demag`, `E_demag`, `demag_phi`).

(demag-api-limitations)=
## Limitations

`bem` and `fmm` are accepted vocabulary values but must not be represented as production-qualified
without planner and runtime evidence. Python constructor acceptance is not backend qualification.

(demag-api-scientific-bibliography)=
## Scientific bibliography

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag API implementation: `packages/fullmag-py/src/fullmag/model/energy.py`.

(demag-api-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Public constructor and interaction lowering. |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | Per-magnet native FDM cell specification. |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | FDM demag policy. |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | Top-level FDM cell, multilayer and boundary policy. |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | FEM order, mesh and demag solver-policy destination. |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | FEM solver and stopping policy. |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | Periodic demag policy. |
| `packages/fullmag-py/src/fullmag/world.py` | `demag` | Flat-API demag enable and realization selection. |
| `packages/fullmag-py/src/fullmag/world.py` | `fem_demag_solver` | Flat-API FEM solver policy. |
| `packages/fullmag-py/src/fullmag/world.py` | `demag_quality` | Flat-API demag refresh cadence. |
| `crates/fullmag-ir/src/plan.rs` | `requires_airbox` | IR realization mesh requirement. |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM planner resolution. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM planner resolution. |
| `crates/fullmag-plan/src/validate.rs` | `validate_executable_outputs` | Fail-closed output validation. |
