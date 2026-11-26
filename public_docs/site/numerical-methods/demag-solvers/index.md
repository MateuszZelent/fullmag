---
title: Demag Solvers
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: fdm-convolution, fem-poisson-airbox, fem-bem, periodic-demag
---

(public-docs-numerical-methods-demag-solvers-root)=
# Demagnetization solver realizations

:::{admonition} One interaction, several boundary-value problems
:class: important

The physical demagnetizing field is defined once under
{doc}`../../physics/interactions/demagnetization/index`. The methods below are distinct numerical
realizations of that interaction. Changing from an open FDM convolution to an FEM airbox, FEM/BEM,
or a periodic operator changes the discrete boundary-value problem and must be recorded in
`ProblemIR` and execution provenance.
:::

## Magnetostatic problem

In the absence of free currents, the demagnetizing field satisfies

```{math}
:label: eq-demag-root-maxwell
\nabla\times\mathbf H_{\mathrm d}=\mathbf 0,
\qquad
\nabla\cdot\left(\mathbf H_{\mathrm d}+\mathbf M\right)=0
\quad\text{in }\mathbb R^3,
\qquad
\mathbf H_{\mathrm d}(\mathbf x)\to\mathbf0
\quad\text{as }|\mathbf x|\to\infty.
```

Writing $\mathbf H_{\mathrm d}=-\nabla u$ gives

```{math}
:label: eq-demag-root-potential
\nabla^2u=\nabla\cdot\mathbf M
```

in the distributional sense, including the magnetization jump at the magnetic boundary. The
magnetostatic energy is

```{math}
:label: eq-demag-root-energy
E_{\mathrm d}
=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

All implementations must preserve this sign and SI convention. They differ in how the infinite
exterior, periodicity, scalar-potential gauge, source integration, and field recovery are
approximated.

## Realization matrix

| Realization | Discrete unknown/operator | Exterior treatment | Current lane boundary | Terminal page |
|---|---|---|---|---|
| FDM Newell convolution | cell-averaged $3\times3$ tensor kernel and Hermitian half-spectrum cuFFT / CPU FFT | open zero-padded embedding | FDM CPU reference; FDM GPU `D2Z`/`Z2D` (FP64) & `R2C`/`C2R` (FP32) + exact cuFFT workspace preflight verified on RTX 4080 SUPER | {doc}`fdm-convolution` |
| FEM Poisson airbox | scalar potential on a conforming magnetic-plus-air mesh (automatic P2 on `tet4` and `pure_prism_p2`) | finite Dirichlet or Robin outer closure | FEM CPU implemented (transfer-cached); FEM GPU `device_hypre_poisson` (`cuDSS` guarded Cholesky default via `gpu_strategy="auto"`, `CG/AMG` fallback with `coarse_relax_type=18` and two-step $\phi^{(0)}$ predictor) verified on RTX 4080 SUPER | {doc}`fem-poisson-airbox` |
| FEM/BEM Fredkin--Koehler | interior sparse FEM solves (`u1` Neumann + `u2` Dirichlet) plus hierarchical H2 / flattened GPU near-CSR + ACA far-field boundary map | boundary integral represents open space (body-only `tet4` P1) | FEM CPU hierarchical H2 implemented; FEM GPU `device_hypre_fem_bem` (`CG/AMG` / `JACOBI` and atomic `(u1, u2)` `cuDSS` pair) verified on RTX 4080 SUPER | {doc}`fem-bem` |
| Periodic demag | FDM periodic-image kernel (including single-layer mixed dipolar images and XY-periodic multilayer CUDA PG-BB) or FEM reduced periodic potential | explicit periodic lattice, pure-Neumann 2D film ($\beta = 0$) + singleton gauge pin | FDM/FEM CPU implemented; FEM GPU PBC-reduced 1D Robin & 2D film-pin `cuDSS` verified on RTX 4080 SUPER; FDM GPU XY-periodic FP64 CUDA verified | {doc}`periodic-demag` |

The public `Demag.model` normalization vocabulary may contain values beyond the four qualified pages,
including `fmm`. At the reviewed revision, this documentation makes no executable FMM claim because
no terminal method page qualifies such a lane. The planner must reject an unavailable
realization rather than replace it silently.

## FDM cell-averaged convolution

### Discrete field

For destination cell $p$, source cell $q$, and Cartesian components $i,j$,

```{math}
:label: eq-demag-root-fdm-field
H_{\mathrm d,p,i}
=-\sum_q\sum_jN^{\mathrm{cell}}_{pq,ij}M_{q,j}.
```

$\mathbf N^{\mathrm{cell}}$ is the demagnetization tensor averaged over the source and destination
rectangular cells. Fullmag constructs it with the Newell formulas in
[`crates/fullmag-fdm-demag/src/newell.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell.rs#L596) — [`compute_newell_kernels`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell.rs#L596). The discrete tensor symmetry
reduces storage and enables convolution, but the self term, cell dimensions, padding, and ordering
remain part of the implementation contract.

The corresponding energy reduction is

```{math}
:label: eq-demag-root-fdm-energy
E_{\mathrm d,h}
=-\frac{\mu_0}{2}\sum_pV_p
\mathbf M_p\cdot\mathbf H_{\mathrm d,p}.
```

### FFT acceleration

For a translationally invariant embedding,

```{math}
:label: eq-demag-root-fdm-fft
\widehat{\mathbf H}_{\mathrm d}(\mathbf k)
=-\widehat{\mathbf N}^{\mathrm{cell}}(\mathbf k)
\widehat{\mathbf M}(\mathbf k).
```

An open-boundary convolution requires zero padding large enough to prevent circular wrap-around.
Kernel spectra are geometry- and grid-dependent and are cached across field evaluations. For
$N$ padded cells, the transform cost is $O(N\log N)$ with $O(N)$ spectra and work arrays. On CUDA,
single-layer demagnetization runs batched in-place Hermitian half-spectrum cuFFT plans
(`D2Z`/`Z2D` in FP64 and `R2C`/`C2R` in FP32, `sx = fft_nx / 2 + 1`) sharing a single Context-owned
cuFFT work area (`max(work_fwd, work_inv)`), gated at setup by exact cuFFT workspace preflight in
[`context_preflight_single_grid_workspace`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/context.cu#L140).
For RTX 4080 SUPER A/B measurements and memory reductions, see {ref}`numerical-methods-performance-fdm-core`.

The CPU route builds spectra in
[`crates/fullmag-engine/src/fdm/cpu/fft.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L681) — [`compute_newell_kernel_spectra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L681); tensor multiplication
and sign convention are owned by [`crates/fullmag-fdm-demag/src/multiply.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/multiply.rs#L25) —
[`accumulate_tensor_convolution`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/multiply.rs#L25). The CUDA FP64 dispatch is
[`backends/fdm/gpu/cuda/interactions/demag_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L671) — [`launch_demag_field_fp64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L671).

### Open and periodic policies are not interchangeable

Open zero padding approximates an isolated finite body. `truncated_images` explicitly sums a finite
set of translated copies. A periodic reciprocal or reduced-potential method represents an infinite
periodic problem with a zero-mode convention. These three policies can produce different fields
for the same unit-cell magnetization and must never share an unlabeled cache key.

## FEM Poisson airbox

Let $\Omega_a=\Omega_m\cup\Omega_{\mathrm{air}}$ be a conforming magnetic-plus-air domain and
$\Gamma_a$ its selected outer boundary. The strong equations are

```{math}
:label: eq-demag-root-airbox-strong
\nabla^2u=\nabla\cdot\mathbf M
\quad\text{in }\Omega_m,
\qquad
\nabla^2u=0
\quad\text{in }\Omega_a\setminus\Omega_m.
```

For Robin closure, Fullmag documents the weak problem

```{math}
:label: eq-demag-root-airbox-weak
\int_{\Omega_a}\nabla u\cdot\nabla v\,\mathrm dV
+\int_{\Gamma_a}\beta uv\,\mathrm dS
=
\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV,
```

with

```{math}
:label: eq-demag-root-airbox-robin
\partial_nu+\beta u=0,
\qquad
\beta=\frac{c}{R_\star}.
```

Dirichlet closure instead fixes the selected outer degrees of freedom to $u=0$ and omits the Robin
boundary mass term. Neither closure is the exact infinite-domain condition at finite airbox size.
A production result therefore requires **two** independent limits:

1. mesh/order and algebraic-solver convergence at fixed airbox;
2. airbox-extent and outer-closure convergence at a sufficiently resolved mesh.

On non-periodic all-tetrahedral (`tet4`) and pure-prism (`pure_prism_p2`, `H1_WedgeElement(2)`)
shared domains without pyramids, the scalar potential resolves automatically to conforming P2 while
magnetization remains nodal P1, achieving sub-percent thin-film demagnetization accuracy at a
fraction of the tetrahedral P2 DOF count. On FEM GPU (`device_hypre_poisson`), the three-state
policy `FemLinearSolverPolicy.gpu_strategy` (`"auto"|"cg_amg"|"cudss"`, delivered at backend
creation time through [`fullmag_fem_backend_create_v6`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/api.cpp#L5921)) selects
VRAM-budget-guarded factor-once `cuDSS` Cholesky when the estimated peak fits device memory, falling
back cleanly under `"auto"` to device HYPRE `CG/AMG` (`coarse_relax_type = 18`) accelerated by the
two-step linear potential predictor $\phi^{(0)}$ and multi-block CUB residual certification. See
{ref}`numerical-methods-performance-fem-gpu-demag` for RTX 4080 SUPER A/B benchmarks.

The CPU implementation separates RHS assembly, boundary construction, Hypre/MFEM solution, field
recovery, and energy reduction (with fixed-mesh sparse transfer caching):

| Responsibility | Source symbol |
|---|---|
| magnetic source | [`backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp#L359) — [`assemble_demag_poisson_rhs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp#L359) |
| Dirichlet/Robin operator | [`backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L124) — [`initialize_demag_poisson_boundary_operator`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L124) |
| Krylov/Hypre solve | [`backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp#L211) — [`solve_demag_poisson_hypre`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp#L211) |
| $-\nabla u$ recovery and magnetic masking | [`backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) — [`recover_demag_poisson_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) |
| field-based energy | [`backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp#L25) — [`demag_poisson_energy_from_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp#L25) |
| GPU RHS & `cuDSS` direct solve | [`backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L350) — [`demag_rhs_csr_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu#L350), [`try_initialize_demag_cudss_direct`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) |

## FEM/BEM Fredkin--Koehler realization

The hybrid method avoids volumetric air by decomposing

```{math}
:label: eq-demag-root-bem-decomposition
u=u_1+u_2,
```

where $u_1$ solves the interior Neumann Poisson problem (with one gauge-pinned DOF per connected
component) and $u_2$ is harmonic in the magnetic body. On production meshes (`tet4`, P1 potential),
Fullmag avoids storing a global $N_\Gamma \times N_\Gamma$ dense matrix by compressing admissible
far-field boundary blocks with deterministic ACA factors $UV^{\mathsf T}$ alongside exact near-field
Lindholm blocks in [`HierarchicalDemagBemOperator::build`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L1475), while retaining [`DenseDemagBemOperator::build`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L364) as a small reference oracle.

The CPU orchestration is
[`backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp#L30) —
[`context_compute_demag_fem_bem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp#L30). On FEM GPU, the strict device-resident owner `device_hypre_fem_bem`
([`backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L697) — [`gpu_demag_fem_bem_initialize`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L697))
uploads the flattened near-field CSR and ACA far-field blocks once and solves the SPD pair $(u_1, u_2)$
either via atomic factor-once `cuDSS` ([`try_initialize_fem_bem_cudss_pair`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L761))
under `gpu_strategy="auto"|"cudss"` or via device HYPRE `CG/AMG` (`coarse_relax_type = 18`) / `JACOBI`
under `cg_amg` or an `auto` VRAM fallback, with zero host fallback.

## Periodic demagnetization

### FDM truncated images

For lattice translations $\mathbf t_{\boldsymbol\ell}$ and a finite image set $\mathcal I$,

```{math}
:label: eq-demag-root-periodic-fdm
\mathbf H_{\mathrm d}(\mathbf r_i)
=-\sum_{\boldsymbol\ell\in\mathcal I}
\sum_j
\mathbf N\!\left(\mathbf r_i-\mathbf r_j-
\mathbf t_{\boldsymbol\ell}\right)\mathbf M_j.
```

`image_counts=(n_x,n_y,n_z)` defines this finite approximation. Increasing the counts is a
convergence study, not a change in physical sample size. The spectra owner is
[`compute_periodic_newell_kernel_spectra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L713) in [`crates/fullmag-engine/src/fdm/cpu/fft.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L713);
single-layer mixed-boundary periodic films use [`compute_single_layer_mixed_newell_kernels`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5) to avoid distant binary64 cancellation, and XY-periodic multilayers support FP64 CUDA PG-BB relaxation.

### FEM periodic reduction

Let $P$ prolong reduced representative degrees of freedom to the full mesh. The periodic scalar
potential system is

```{math}
:label: eq-demag-root-periodic-fem
A_p=P^{\mathsf T}A_{\mathrm{open}}P,
\qquad
b_p=P^{\mathsf T}b,
\qquad
A_pu_p=b_p.
```

The CPU implementation owner is
[`backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp#L199) —
[`solve_demag_periodic_poisson_reduced`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp#L199).
For 2D-periodic thin films, static Robin outer closure automatically resolves to pure Neumann
($\beta = 0$) with a singleton open-boundary gauge pin ([`film_neumann_gauge_pin_tdof`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L88)), eliminating the algebraic stray-field leak while preserving strict SPD structure. On FEM GPU, both 1D-periodic Robin and 2D-periodic film-pin reduced systems execute directly in `cuDSS` (and `CG/AMG` fallback).

## Public API and canonical intent

```python
# %% Select one demagnetization realization explicitly
import fullmag as fm

nm = 1.0e-9
study = fm.study("poisson_demag")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))

film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.1, 0.0)

study.demag(model="airbox", variant="robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-10,
    max_iterations=500,
    gpu_strategy="auto",
)
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, tolT=1.0e-6)
```

| Public value | Meaning | Validation consequence |
|---|---|---|
| `Demag.model="airbox"` | shared-domain FEM scalar potential | requires an FEM magnetic-plus-air mesh and supported closure |
| `Demag.variant="robin"` | Robin outer operator | records the closure; resolves to pure Neumann ($\beta = 0$) + singleton gauge pin on 2D-periodic films |
| `Demag.model="fredkin_koehler"` | body-only FEM/BEM | supported on FEM CPU (H2) and FEM GPU (`device_hypre_fem_bem` + atomic `cuDSS`) for body-only `tet4` P1 meshes |
| FDM cell-size policy | Newell cell geometry and FFT grid | object extents and grid compatibility are validated |
| `FemLinearSolverPolicy.solver` | `CG` or `GMRES` | Krylov method on FEM CPU and GPU HYPRE fallback |
| `FemLinearSolverPolicy.preconditioner` | `AMG`, `JACOBI`, or `NONE` | Krylov preconditioner (default `AMG` on CPU and GPU fallback; unused under `cudss_direct`) |
| `FemLinearSolverPolicy.gpu_strategy` | `"auto"`, `"cg_amg"`, or `"cudss"` (default `"auto"`) | creation-time GPU direct-vs-Krylov policy (`fullmag_fem_backend_create_v6`) with VRAM budget guard |
| `FemLinearSolverPolicy.rtol` | relative algebraic tolerance, default $10^{-8}$ | positive; every solve is independently certified against `rtol` |
| `FemLinearSolverPolicy.max_iterations` | iteration ceiling, default 500 | budget exhaustion is a failed/unconverged solve |
| `FdmPbc.demag` | `open`, `truncated_images`, or `periodic_airbox_k0` | selects a different boundary operator; unsupported solver combinations fail |

The terminal pages own the exact aliases and `ProblemIR` paths. Requested realization and resolved
execution remain separate: serializing `poisson_robin` and `gpu_strategy="auto"` records requested
intent, while `resolved_linear_solver`, `linear_solver_fallback_reason`, and device receipts belong
to execution provenance.

## Choosing a realization

| Situation | Appropriate starting point | Required convergence evidence |
|---|---|---|
| Regular Cartesian finite body | open FDM Newell/FFT (`D2Z`/`R2C` on GPU) | cell refinement, padding/self-term checks, energy--field consistency |
| Periodic FDM unit cell with finite image approximation | truncated-image or single-layer mixed spectra | image-count convergence and lattice-axis verification |
| Thin-film FEM body requiring P2 demag accuracy on single GPU | `pure_prism_p2` Poisson airbox + `cuDSS` | in-plane $h < \ell_{\mathrm{ex}}$, layer count $L$, airbox extent, and residual certification |
| Curved FEM body with scalable sparse solve | Poisson airbox (`cuDSS` or `CG/AMG`) | mesh, airbox extent, closure, and algebraic residual studies |
| FEM body where avoiding air volume is decisive | Fredkin--Koehler FEM/BEM (CPU H2 or GPU `device_hypre_fem_bem` / `cuDSS`) | boundary refinement, ACA probe accuracy, and `rtol` / `cuDSS` parity |
| 1D/2D periodic FEM potential | reduced periodic Poisson (1D Robin or 2D pure-Neumann pin) | node-pair consistency, gauge/nullspace, zero-mode and mesh convergence |

## Validation requirements

### Analytical and manufactured cases

- uniformly magnetized rectangular prisms: compare volume-averaged field and energy with an
  independently evaluated demagnetizing tensor (Aharoni 1998);
- ellipsoids: verify approximately uniform internal field on converged geometry/mesh sequences;
- zero magnetization: field and energy must be zero within roundoff and solver tolerance;
- potential manufactured solution in an airbox: verify weak-form order, boundary closure, and field
  recovery independently.

### Variational consistency

For an admissible perturbation $\boldsymbol\eta$,

```{math}
:label: eq-demag-root-directional-derivative
\frac{E_{\mathrm d}(\mathbf m+\varepsilon\boldsymbol\eta)
-E_{\mathrm d}(\mathbf m-\varepsilon\boldsymbol\eta)}{2\varepsilon}
\to
-\mu_0\int_{\Omega_m}M_s
\mathbf H_{\mathrm d}\cdot\boldsymbol\eta\,\mathrm dV.
```

This test detects sign, factor-of-two, masking, volume-weight, and field-recovery errors that a
field-only comparison can miss.

### Algebraic and boundary evidence

Record the scalar-potential residual, iteration count, convergence reason, gauge/nullspace policy,
outer boundary, periodic equivalence digest, airbox size, `requested_linear_solver_strategy`,
`resolved_linear_solver`, `linear_solver_fallback_reason`, and boundary-operator dimensions. A small
Krylov residual does not establish small truncation or mesh error.

### CPU/GPU parity

Use identical kernel spectra or assembled operators, mesh/grid, precision policy, magnetization,
and energy reduction. Compare both field norms and total energy. Strict GPU execution additionally
requires zero hot-loop host compute and verified device receipts.

## Implementation source index

| Realization | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| FDM tensor construction | [`crates/fullmag-fdm-demag/src/newell.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell.rs#L596) | [`compute_newell_kernels`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell.rs#L596) | cell-averaged Newell kernel |
| FDM mixed single-layer tensor | [`crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5) | [`compute_single_layer_mixed_newell_kernels`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/newell/mixed_single_layer.rs#L5) | stable single-layer mixed dipolar images |
| FDM tensor multiply | [`crates/fullmag-fdm-demag/src/multiply.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/multiply.rs#L25) | [`accumulate_tensor_convolution`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-fdm-demag/src/multiply.rs#L25) | tensor-vector convolution and sign |
| FDM open spectra | [`crates/fullmag-engine/src/fdm/cpu/fft.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L681) | [`compute_newell_kernel_spectra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L681) | padded CPU kernel spectra |
| FDM periodic spectra | [`crates/fullmag-engine/src/fdm/cpu/fft.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L713) | [`compute_periodic_newell_kernel_spectra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fft.rs#L713) | periodic/image kernel spectra |
| FDM CPU field and energy | [`crates/fullmag-engine/src/fdm/cpu/fields/demag.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/demag.rs#L8) | [`demag_field_from_vectors`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/demag.rs#L8) | reference field and reduction |
| FDM CUDA field & preflight | [`backends/fdm/gpu/cuda/interactions/demag_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L671) | [`launch_demag_field_fp64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L671) | FP64 D2Z/Z2D device dispatch (paired with [`context_preflight_single_grid_workspace`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/context.cu#L140)) |
| FEM Poisson RHS | [`backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp#L359) | [`assemble_demag_poisson_rhs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp#L359) | magnetic source assembly |
| FEM Poisson boundary | [`backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L124) | [`initialize_demag_poisson_boundary_operator`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp#L124) | Dirichlet, Robin, and 2D-film pure-Neumann closure |
| FEM Poisson solve | [`backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp#L211) | [`solve_demag_poisson_hypre`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp#L211) | CPU linear solve and telemetry |
| FEM GPU `cuDSS` & creation ABI | [`backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) | [`try_initialize_demag_cudss_direct`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L653) | VRAM-guarded GPU Cholesky (open, PBC, and atomic FEM/BEM pair via [`try_initialize_fem_bem_cudss_pair`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp#L761)) |
| FEM field recovery | [`backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) | [`recover_demag_poisson_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp#L745) | $-\nabla u$ and magnetic mask |
| FEM/BEM operators (CPU & GPU) | [`backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L1475) | [`HierarchicalDemagBemOperator::build`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L1475) | CPU H2 boundary operator (oracle [`DenseDemagBemOperator::build`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp#L364); GPU [`gpu_demag_fem_bem_initialize`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp#L697)) |
| FEM/BEM CPU orchestration | [`backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp#L30) | [`context_compute_demag_fem_bem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp#L30) | hybrid CPU solve pipeline |
| FEM periodic reduction | [`backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp#L199) | [`solve_demag_periodic_poisson_reduced`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp#L199) | representative reduction and gauge |
| Pure-prism P2 mesher | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6669) | [`generate_pure_prism_box_airbox_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6669) | 100% `prism6` P2-capable shared-domain mesher |

## Limitations

- Open FDM convolution is tied to Cartesian cell geometry and a specific padding convention.
- Finite airboxes introduce truncation error even when the linear system is solved to machine precision.
- Body-only FEM/BEM is scoped to `tet4` meshes with scalar P1 potentials (`prism6`/`pyramid5`/P2 are outside the Fredkin--Koehler contract).
- Periodic image truncation is not the same as an exact infinite lattice sum.
- 3D-periodic pure-Neumann FEM scalar potentials without a gauge pin are singular and fail closed even under `gpu_strategy="auto"`.
- The existence of the public `fmm` vocabulary is not an executable production claim at this revision.
- Algebraic residual, mesh error, airbox error, and physical model error are independent quantities.

## Cross-links

- {ref}`numerical-methods-performance-fdm-core`
- {ref}`numerical-methods-performance-fem-gpu-demag`
- {doc}`../../physics/interactions/demagnetization/index`

## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
2. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *Journal of Geophysical Research* **98**, 9551--9555 (1993),
   [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
3. D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE
   Transactions on Magnetics* **26**, 415--417 (1990),
   [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
4. A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied
   Physics* **83**, 3432--3434 (1998), [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
5. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
6. R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics
   with Applications* **81**, 42--74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

```{toctree}
:maxdepth: 1

fdm-convolution
fem-poisson-airbox
fem-bem
periodic-demag
```
