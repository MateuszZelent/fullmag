---
title: Demagnetization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-demagnetization-root)=
# Demagnetization

Demagnetization is the non-local magnetostatic self-interaction. The continuum physical problem is
common to all backends, while FDM convolution, multilayer FDM convolution, FEM Poisson airbox,
FEM–BEM Fredkin–Koehler, periodic kernels, and future FMM realizations are distinct numerical
operators with separate qualification.

```{toctree}
:maxdepth: 1

mathematical-formulation
boundary-conditions
fdm-convolution
multilayer-convolution
fem-poisson-airbox
fem-bem
periodic-demag
validation
```

(physics-demagnetization-problem-statement)=
## Physical problem

Magnetostatic (demagnetizing) interactions couple magnetization divergence in the bulk and on
boundaries through long-range dipolar fields that oppose net magnetic flux closure gaps. This
overview connects the continuum Poisson and dipolar formulation to Fullmag's `FDM` convolution,
`FEM` Poisson airbox, and `FEM`–`BEM` solver families across Python authoring, `ProblemIR`,
planning, and the four backend execution lanes (`FDM CPU`, `FDM GPU`, `FEM CPU`, `FEM GPU`).
For measured GPU throughput, VRAM budgets, and kernel-level performance tuning, see
{ref}`numerical-methods-performance`, {ref}`numerical-methods-performance-fdm-core`, and
{ref}`numerical-methods-performance-fem-gpu-demag`.

(physics-demagnetization-governing-equations)=
## Governing equations

In the quasistatic, source-free magnetostatic approximation,

```{math}
:label: eq-public-demagnetization-demag-maxwell
\nabla\times\mathbf H_{\mathrm d}=\mathbf 0,
\qquad
\nabla\cdot(\mathbf H_{\mathrm d}+\mathbf M)=0 .
```

Introducing a magnetic scalar potential $u$,

```{math}
:label: eq-public-demagnetization-demag-potential
\mathbf H_{\mathrm d}=-\nabla u,
\qquad
\Delta u=\nabla\cdot\mathbf M
```

in the distributional sense, including volume charge $\rho_m = -\nabla\cdot\mathbf M$ and surface
charge $\sigma_m = \mathbf M\cdot\mathbf n$. The open-boundary solution satisfies
$u(\mathbf x)\to 0$ as $\lvert\mathbf x\rvert\to\infty$. With $\mathbf M = M_s\mathbf m$, the
demagnetization energy is

```{math}
:label: eq-public-demagnetization-demag-energy
E_{\mathrm d}
=
-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV
=
\frac{\mu_0}{2}\int_{\mathbb R^3}\lvert\mathbf H_{\mathrm d}\rvert^2\,\mathrm dV .
```

The two forms are an important implementation cross-check when evaluated with consistent spatial
support, integration weights, and boundary closures.

(physics-demagnetization-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf M$ | magnetization field | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $u$ | magnetic scalar potential | $\mathrm{A}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |
| $\mathbb R^3$ | unbounded three-dimensional space | $\mathrm{m^3}$ |
| $\mathbf x$ | spatial position vector | $\mathrm{m}$ |
| $\mathrm dV$ | volume measure | $\mathrm{m^3}$ |

(physics-demagnetization-discrete-realization)=
## Numerical families and four-lane capability matrix

```{figure} /_static/diagrams/demag-solver-families-comparison.svg
:alt: Four-panel comparison of Fullmag demagnetization solver families and continuum magnetic charge sources rho_m = -div M and sigma_m = M . n: (a) FDM open-boundary 2N zero-padded FFT convolution, (b) FEM Poisson with shared finite airbox Omega_m subset Omega_a and Dirichlet or Robin outer closure on Gamma_a, (c) FEM-BEM Fredkin-Koehler two-solve boundary-integral method on closed body-only mesh Omega_m without an airbox, and (d) periodic replicated images in FDM truncated_images versus FEM reduced periodic_airbox_k0.
:width: 100%
:name: fig-demag-solver-families-comparison
:figclass: fm-physics-figure

Continuum magnetostatic charge sources ($\rho_m = -\nabla\cdot\mathbf{M}$, $\sigma_m = \mathbf{M}\cdot\mathbf{n}$) and Fullmag's four discrete demagnetization operator families across **FDM CPU**, **FDM GPU**, **FEM CPU**, and **FEM GPU** (Brown 1963; Newell *et al.* 1993; Fredkin & Koehler 1990; Lepadatu 2019).
```

- **FDM open convolution** ({doc}`fdm-convolution`) uses a 27-point cell-averaged Newell tensor
  and padded FFT acceleration (Hermitian real-to-complex `D2Z/Z2D` and `R2C/C2R` cuFFT on CUDA).
- **FDM multilayer convolution** ({doc}`multilayer-convolution`) preserves per-magnet native grids
  and evaluates directed $L^2$ pair kernels across vacuum gaps.
- **FDM periodic / truncated images** ({doc}`periodic-demag`) sums translated replicas with a
  distant point-dipole limit ($r \ge 40 h_{\max}$) on single-layer mixed-boundary meshes to avoid
  binary64 Newell cancellation.
- **FEM Poisson airbox** ({doc}`fem-poisson-airbox`) solves the scalar potential on a conforming
  shared magnetic-plus-air domain with Dirichlet or Robin outer closure, P2 scalar potential on
  `tet4` and `pure_prism_p2` meshes, and GPU `cuDSS` direct Cholesky or `hypre_krylov` solves.
- **FEM–BEM / Fredkin–Koehler** ({doc}`fem-bem`) eliminates the exterior airbox via body-only
  `tet4` P1 boundary-integral coupling (hierarchical $H^2$ on CPU; flattened near/far ACA blocks
  plus atomic `(u1, u2)` `cuDSS` or `hypre_krylov` solves on GPU).
- **FMM** (`model="fmm"`) is accepted vocabulary in Python and `ProblemIR` only; planning and
  runtime fail closed until an executable FMM realization is implemented and qualified.

No model name may be promoted from “accepted by Python” to “executable” without planner and
executed-runtime evidence.

| Solver | Device | Status | Authoring / IR | Executable realization and exact boundary |
|---|---|---|---|---|
| FDM | CPU | `reference` | `Demag()`, `FDM`, `FDMDemag`, `FdmPbc` | Reference Newell 27-point FFT (open, single-layer mixed-boundary periodic with $r \ge 40 h_{\max}$ dipole limit, and CPU FP64 multilayer convolution). |
| FDM | GPU | `implemented` | same canonical IR | Single-layer FP64 (`D2Z/Z2D`) and FP32 (`R2C/C2R`) Hermitian cuFFT with exact workspace preflight verified on RTX 4080 SUPER ($\lvert\Delta E_{\mathrm d}\rvert/\lvert E_{\mathrm d}\rvert \le 1.76\times 10^{-16}$ in FP64); FP32+PBC intentionally rejected; multilayer CUDA remains partial. |
| FEM | CPU | `implemented` | `airbox`, `fredkin_koehler`, `FemLinearSolverPolicy` | MFEM/Hypre open Poisson Robin/Dirichlet (`tet4` P2, `mixed_p1`, `pure_prism_p2`), periodic reduced P1 Poisson, and hierarchical $H^2$/dense body-only `tet4` P1 Fredkin–Koehler; `fmm` and generic `bem` fail closed. |
| FEM | GPU | `implemented` | same IR plus `gpu_strategy` (`auto`, `cg_amg`, `cudss`) | Strict device-resident open Poisson (`tet4` P2, `mixed_p1`, `pure_prism_p2` P2), PBC-reduced 1D Robin / 2D film (Neumann + gauge pin), and strict device Fredkin–Koehler `(u1, u2)` with VRAM-guarded `cuDSS` and `hypre_krylov` (`CG/AMG`, `coarse_relax_type=18`) fallback verified on RTX 4080 SUPER; periodic `pure_prism_p2`, unpinned 3D Neumann, and `fmm` fail closed. |

(physics-demagnetization-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("demag_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Explicit stage-first execution request
study.demag(enabled=True)
study.stages.add_run(stage_id="sample", until=1.0e-12)
```

Exchange and demagnetization are active by default. Call `study.demag(model=...)` or
`study.demag(realization=...)` to select a non-default realization, and call
`study.disable_demag()` only when the authored physics intentionally excludes demagnetization. A
FEM study should state its realization and solver policy explicitly, for example
`study.demag(model="airbox", variant="robin")` and
`study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-8, gpu_strategy="auto")`.

### Complete public parameter summary

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `str \| None` | `None` | $1$ | One of `airbox`, `bem`, `fredkin_koehler`, `fmm`; mutually exclusive with `realization`. | Selects the backend-neutral demagnetization realization family. | FEM planner (`airbox`, `fredkin_koehler` executable; `bem`, `fmm` fail closed). | `energy[].realization` |
| `Demag.variant` | `str \| None` | `None` | $1$ | Only valid with `model="airbox"`; allowed values are `auto`, `robin`, `dirichlet`. | Selects finite-airbox outer boundary closure (`auto` normalizes to `poisson_robin`). | FEM Poisson CPU/GPU. | `energy[].realization` |
| `Demag.realization` | `str \| None` | `None` | $1$ | Canonical or legacy realization alias; mutually exclusive with `model`. | Legacy compatibility realization selector normalized before planning. | FDM/FEM according to normalized realization. | `energy[].realization` |
| `FDMDemag.strategy` | `str` | `auto` | $1$ | One of `auto`, `single_grid`, `multilayer_convolution`. | Selects single shared FDM grid or per-layer multilayer convolution. | FDM CPU/GPU (`multilayer_convolution` CUDA partial). | `backend_policy.discretization_hints.fdm.demag.strategy` |
| `FDMDemag.mode` | `str` | `auto` | $1$ | One of `auto`, `two_d_stack`, `three_d`. | Selects thin-film stack or full 3-D multilayer transform mode. | FDM CPU/GPU. | `backend_policy.discretization_hints.fdm.demag.mode` |
| `FemLinearSolverPolicy.solver` | `Literal["CG", "GMRES"]` | `"CG"` | $1$ | Must be `CG` or `GMRES`. | Iterative Krylov solver for FEM CPU and GPU HYPRE fallback solves. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.demag_solver_policy.solver` |
| `FemLinearSolverPolicy.preconditioner` | `Literal["AMG", "JACOBI", "NONE"]` | `"AMG"` | $1$ | Must be `AMG`, `JACOBI`, or `NONE`. | Preconditioner for FEM CPU and GPU HYPRE fallback solves. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.demag_solver_policy.preconditioner` |
| `FemLinearSolverPolicy.rtol` | `float` | `1e-8` | $1$ | Finite and strictly positive. | Relative Euclidean residual tolerance certifying every FEM demag solve. | FEM CPU/GPU. | `backend_policy.discretization_hints.fem.demag_solver_policy.rtol` |
| `FemLinearSolverPolicy.gpu_strategy` | `Literal["auto", "cg_amg", "cudss"]` | `"auto"` | $1$ | Must be `auto`, `cg_amg`, or `cudss`. | Selects VRAM-guarded `cuDSS` direct Cholesky vs `hypre_krylov` on FEM GPU. | FEM GPU (ignored on FEM CPU). | `backend_policy.discretization_hints.fem.demag_solver_policy.gpu_strategy` |
| `FdmPbc.demag` | `str` | `open` | $1$ | One of `open`, `truncated_images`, `periodic_airbox_k0`. | Selects open, finite-image periodic FDM, or periodic FEM airbox demag policy. | Solver-specific (FDM rejects `periodic_airbox_k0`). | `pbc.demag` |

(physics-demagnetization-problem-ir)=
## ProblemIR

The default interaction lowers to

```json
{"kind": "demag", "realization": "auto"}
```

Discretization and linear-solver hints lower separately under
`backend_policy.discretization_hints.fdm` (`FdmDemagHintsIR`) and
`backend_policy.discretization_hints.fem.demag_solver_policy` (`FemLinearSolverPolicy`), while the
planner resolves concrete realizations (`ResolvedFemDemagIR`, FDM grid/FFT/image descriptors, and
capability decisions). Runtime provenance records requested strategy, resolved linear solver
(`cudss_direct` or `hypre_krylov`), fallback reason, precision, tolerances, and executed device
identity separately from authored intent.

(physics-demagnetization-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** preserves the authored model, variant, discretization hints, periodic policy,
`gpu_strategy`, and execution target verbatim across Python export and scene round trips.
**Resolved execution** records the selected solver family, device, precision, mesh/grid identity,
FFT or Cholesky factor telemetry, and capability decision independently. **Validation errors**
reject malformed or contradictory data before native execution (for example combining `model` with
`realization`, supplying `variant` to non-airbox models, invalid `gpu_strategy`, malformed VRAM
budget caps, or non-closed surfaces for FEM–BEM). **Unsupported combinations** fail closed and are
never silently omitted, converted to another interaction, or downgraded from GPU to CPU (for
example `fmm`, generic `bem`, FDM FP32+PBC, multilayer PBC, periodic `pure_prism_p2`, or unpinned
3-D periodic Neumann).

(physics-demagnetization-assumptions-and-validity)=
## Assumptions and validity

Magnetostatic evaluation assumes quasistatic, source-free magnetostatics with piecewise-constant
(`FDM`) or continuous piecewise-linear (`FEM`) reduced magnetization $\mathbf m$ and finite
non-negative saturation $M_s$ over $\Omega_m$. Accuracy and planner legality depend on the selected
operator family: uniform Cartesian grids for single-grid and multilayer `FDM` convolution,
conforming shared-domain airbox extent and P1 vs P2 scalar potential order for `FEM` Poisson, or a
watertight body-only `tet4` surface for `FEM`–`BEM`. Algebraic residual tolerance does not bound
airbox truncation, mesh discretization, or finite periodic image truncation error.

(physics-demagnetization-implementation-mapping)=
## Implementation mapping

Python classes (`Demag`, `FDM`, `FDMDemag`, `FEM`, `FemLinearSolverPolicy`, and `FdmPbc`) own
authoring validation and `ProblemIR` serialization, while `crates/fullmag-ir` and
`crates/fullmag-plan` (`plan_fdm`, `plan_fem`) validate hints and resolve topology, periodicity,
and solver capabilities. Native `FDM` (`crates/fullmag-fdm-demag`, `crates/fullmag-engine`,
`backends/fdm/gpu/cuda`) and `FEM` (`backends/fem/cpu/mfem`, `backends/fem/gpu/cuda`) kernels
perform numerical evaluation with strict executed-operator receipts and zero silent GPU-to-CPU
fallback. See {ref}`numerical-methods-performance-fdm-core` and
{ref}`numerical-methods-performance-fem-gpu-demag` for GPU architecture and A/B throughput details.

### Control Room support

Demagnetization object controls are hosted by `ObjectPhysicsInspectorPanel`
(`apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx`) and
summarized by `PhysicsInspectorOverview`
(`apps/control-room/src/modules/inspector/panels/PhysicsInspectorOverview.tsx`) under
`Model Explorer -> Objects -> <object> -> Physics`. Browser exposure is partial: solver and
discretization parameters without a dedicated UI control must be authored in Python or `ProblemIR`
rather than inferred from backend capability. See {doc}`/frontend/capability-register` for current
Control Room coverage.

(physics-demagnetization-validation)=
## Validation and qualification

- Analytic uniformly magnetized rectangular prisms (Aharoni 1998) and ellipsoids (Osborn 1945);
- Newell 27-point tensor symmetry, self-term trace, and single-layer distant-image dipole parity;
- FDM GPU FP64 Hermitian `D2Z/Z2D` cuFFT machine-precision parity
  ($\lvert\Delta E_{\mathrm d}\rvert/\lvert E_{\mathrm d}\rvert \le 1.76\times 10^{-16}$ across 8
  geometries on RTX 4080 SUPER);
- FEM GPU `cuDSS` and `hypre_krylov` A/B parity across open Poisson (`tet4` P2 and
  `pure_prism_p2` thin films), PBC-reduced 1D Robin / 2D film, and strict device Fredkin–Koehler
  FEM–BEM;
- Equivalence of the field-dot-magnetization and variational energy functionals, plus independent
  mesh, airbox, and image-count convergence studies (see {doc}`validation`).

(physics-demagnetization-limitations)=
## Limitations

- `FEM` Poisson airbox accuracy depends on finite airbox distance and scalar-potential order
  (`mixed_p1` meshes with pyramids remain P1, whereas `tet4` and `pure_prism_p2` resolve P2).
- `FDM` multilayer convolution rejects periodic boundary conditions and its CUDA lane remains
  partially qualified compared to single-layer CUDA.
- `FDM` CUDA FP32+PBC and `FEM` periodic `pure_prism_p2` / unpinned 3-D periodic Neumann fail
  closed.
- `model="fmm"` and generic `model="bem"` remain accepted authoring vocabulary only until
  executable realizations are implemented and qualified.

(physics-demagnetization-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York, 1963 ([WorldCat record](https://search.worldcat.org/title/536451)).
2. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *Journal of Geophysical Research: Solid Earth* **98**(B6), 9551–9555 (1993), [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
3. D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE Transactions on Magnetics* **26**(2), 415–417 (1990), [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
4. S. Lepadatu, “Efficient computation of demagnetizing fields for magnetic multilayers using multilayered convolution,” *Journal of Applied Physics* **126**(10), 103903 (2019), [doi:10.1063/1.5116754](https://doi.org/10.1063/1.5116754).
5. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, National Institute of Standards and Technology, NISTIR 6376 (1999), [doi:10.6028/NIST.IR.6376](https://doi.org/10.6028/NIST.IR.6376).

(physics-demagnetization-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility | Lane | Immutable link |
|---|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Public demagnetization realization vocabulary, validation, and `ProblemIR` lowering. | Public API | [`energy.py#L51`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L51) |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | FDM demag strategy, mode, common-grid, and FFT backend policy. | Public API | [`discretization.py#L51`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L51) |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | FEM Krylov solver, preconditioner, tolerance, and `gpu_strategy` policy. | Public API | [`discretization.py#L161`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L161) |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | Periodic axis flags, demag boundary policy, and finite image counts. | Public API | [`problem.py#L220`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L220) |
| `crates/fullmag-ir/src/study.rs` | `FemLinearSolverPolicy` | Canonical `ProblemIR` FEM demag solver policy including backward-compatible `gpu_strategy`. | IR | [`study.rs#L1005`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/study.rs#L1005) |
| `crates/fullmag-ir/src/plan.rs` | `ResolvedFemDemagIR` | Resolved FEM demag realization enum in execution plans. | IR | [`plan.rs#L1424`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/plan.rs#L1424) |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM single-grid and multilayer topology, PBC, and capability resolution. | Planner | [`fdm.rs#L2513`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L2513) |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM demag realization, mesh-topology, solver-policy, and capability resolution. | Planner | [`fem.rs#L4288`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4288) |
| `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` | Cell-averaged 27-point Newell demagnetization tensor construction. | FDM CPU/reference | [`newell.rs#L596`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell.rs#L596) |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `launch_demag_field_fp64` | Single-layer CUDA FP64 Hermitian `D2Z/Z2D` cuFFT demagnetizing field evaluation. | FDM GPU | [`demag_fp64.cu#L671`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L671) |
| `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp` | `context_compute_demag_poisson` | FEM CPU Poisson airbox RHS, linear solve, field recovery, and energy orchestration. | FEM CPU | [`demag_poisson_solve.cpp#L50`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp#L50) |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `try_initialize_demag_cudss_direct` | Three-state VRAM-guarded `cuDSS` direct Cholesky admission for GPU Poisson demag. | FEM GPU | [`cudss_direct_solver.cpp#L653`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) |
| `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` | `compute_device_demag_fem_bem_for_device_stage` | Strict device-resident GPU Fredkin–Koehler `(u1, u2)` demag stage execution. | FEM GPU | [`fem_bem.cpp#L1161`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L1161) |
| `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` | `ObjectPhysicsInspectorPanel` | Object-level physics inspector panel exposing demagnetization controls. | Control Room | [`ObjectPhysicsSpec.tsx#L78`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx#L78) |
| `apps/control-room/src/modules/inspector/panels/PhysicsInspectorOverview.tsx` | `PhysicsInspectorOverview` | Physics inspector overview summarizing scope, lane, and diagnostics. | Control Room | [`PhysicsInspectorOverview.tsx#L136`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/PhysicsInspectorOverview.tsx#L136) |
