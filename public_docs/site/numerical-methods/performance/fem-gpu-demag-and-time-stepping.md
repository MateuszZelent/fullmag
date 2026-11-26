---
title: FEM GPU Demagnetization, Time Integration, and Thin-Film Discretization
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(numerical-methods-performance-fem-gpu-demag)=
# FEM GPU Demagnetization, Time Integration, and Thin-Film Discretization

(perf-fem-gpu-demag-problem-statement)=
## Scope and purpose

This page documents the core finite-element GPU (`FEM GPU`) accelerations for magnetostatic
demagnetization, explicit Runge--Kutta time integration, and thin-film shared-domain meshing. The
canonical physical definitions and baseline FEM demagnetization realizations live in
{doc}`../../physics/interactions/demagnetization/index`, {doc}`../demag-solvers/fem-poisson-airbox`,
and {doc}`../demag-solvers/fem-bem`.

Four tightly coupled production mechanisms are documented here:

1. **Three-state auto-cuDSS direct Cholesky demagnetization (`auto`, `cg_amg`, `cudss`)** covering
   open-airbox Poisson, 1D/2D periodic reduced Poisson, and the atomic Fredkin--Koehler `FEM/BEM`
   $(u_1, u_2)$ pair, protected by exact post-analysis VRAM preflight.
2. **Multi-block CUB residual certification, BoomerAMG coarse relax type 18, and
   `HypreStreamInterop`**, eliminating hidden coarse-level CPU transfers and redundant stream
   synchronizations on the iterative Krylov lane.
3. **Explicit Runge--Kutta (`Heun`, `RK4`) FSAL $k_0$ reuse and two-step linear potential
   prediction $\phi^{(0)}$**, cutting right-hand-side evaluations by 20%--33% and halving Krylov
   iterations when `cg_amg` is active.
4. **Pure-prism P2 shared-domain thin-film discretization (`pure_prism_p2`) and deterministic
   Chebyshev-center mixed-tetrahedra untangling**, delivering P2 wedge accuracy at $5.76\times$
   fewer degrees of freedom than `tet P2` so thin films fit comfortably inside GPU direct-solver
   VRAM budgets.

(perf-fem-gpu-demag-governing-equations)=
## Scientific and numerical model

### Factor-once cuDSS Cholesky demagnetization and VRAM admission

In open-airbox Poisson, periodic reduced Poisson, and interior Fredkin--Koehler `FEM/BEM`
subproblems, the stiffness matrix $K$ is sparse, symmetric positive definite (after Dirichlet,
Robin, or gauge-pin elimination), and invariant across time steps and relaxation iterations.
Iterative HYPRE PCG+BoomerAMG incurs hundreds of fine-grained host-launched kernel calls per solve
(previously 98.5% of step wall time with `< 1%` GPU compute occupancy on mid-sized meshes).

Under `cuDSS`, FullMag computes the permutation and Cholesky factor once during context creation
(`CUDSS_PHASE_ANALYSIS` followed by `CUDSS_PHASE_FACTORIZATION`) and performs only forward/backward
triangular solves on each field evaluation inside `HypreStreamInterop` event fences:

```{math}
:label: eq-perf-fem-cudss-cholesky
P K P^{\mathsf T} = L L^{\mathsf T},
\qquad
K \phi = \mathbf b(\mathbf m),
\qquad
\mathbf H_{\mathrm{d}} = -\nabla \phi.
```

Before allocating numerical factors, FullMag queries `CUDSS_DATA_MEMORY_ESTIMATES[1]`
($\widehat M_{\mathrm{peak}}$) and live `cudaMemGetInfo` free memory $M_{\mathrm{free}}$ on a
total device capacity $M_{\mathrm{total}}$, admitting direct factorization only when

```{math}
:label: eq-perf-fem-cudss-vram-budget
B = \min\!\left(
      M_{\mathrm{free}} - \max\!\left(512\,\mathrm{MiB},\;\frac{M_{\mathrm{total}}}{20}\right),\;
      B_{\mathrm{cap}}
    \right),
\qquad
\widehat M_{\mathrm{peak}} \le B.
```

For hybrid Fredkin--Koehler `FEM/BEM` ($u = u_1 + u_2$), both SPD factors $(K_1, K_2)$ are
admitted atomically under the joint peak envelope

```{math}
:label: eq-perf-fem-bem-atomic-budget
\max\!\left(
  \widehat M_{\mathrm{peak},1},\;
  \widehat M_{\mathrm{stable},1} + \widehat M_{\mathrm{peak},2}
\right) \le B,
```

preventing half-initialized solver pairs. Under `gpu_strategy="auto"` (default), an over-budget
estimate cleanly falls back before factorization to `hypre_krylov` with an explicit provenance
reason; under `gpu_strategy="cudss"`, an over-budget estimate fails closed. A non-zero pivot error
(`CUDSS_DATA_INFO != 0`) always fails closed in every mode.

### Multi-block CUB residual certification and BoomerAMG coarse residency

When `hypre_krylov` executes, residual certification replaces a legacy single-block kernel and two
blocking host synchronizations with a multi-block CUB pair-norm reduction
(`certify_gpu_hypre_demag_residual`) that transfers a single 16-byte `(r_norm, b_norm)` payload
with one synchronization per solve. Setting `HYPRE_BoomerAMGSetCycleRelaxType(..., 18, 3)` (l1-Jacobi
on coarse level 3) across both Poisson and `FEM/BEM` eliminates hidden 24-byte coarse-level CPU
Gauss-elimination host transfers (`1712/1712 -> 0/0`).

### Explicit RK FSAL $k_0$ reuse and two-step linear potential predictor

For explicit `Heun` and `RK4` stepping, caching the accepted endpoint derivative $k_0 = f(t_n,
\mathbf m_n)$ reuses the first stage of step $n+1$, reducing full right-hand-side and demag
evaluations from $3 \to 2$ (`-33.3%`) for `Heun` and $5 \to 4$ (`-20.0%`) for `RK4`, gated by a
10-condition operator-signature invalidation matrix (`gpu_rk_rhs_allows_fsal_k0_reuse`) that
separates `k0` reuse from `endpoint_rhs_shortcut` (preserving `k0` reuse even with frozen spins or
PBC).

On the Krylov lane (`hypre_krylov`), each subsequent stage or step extrapolates a warm-start
initial guess $\phi^{(0)}$ from the last two accepted potentials:

```{math}
:label: eq-perf-fem-potential-predictor
\phi^{(0)}(t_{\mathrm{eval}})
= \phi_n + \alpha_{\mathrm{pred}}\bigl(\phi_n - \phi_{n-1}\bigr),
\qquad
\alpha_{\mathrm{pred}}
= \min\!\left(\frac{t_{\mathrm{eval}} - t_n}{t_n - t_{n-1}},\; r_{\max}\right),
\qquad
r_{\max} = 2.0,
```

guarded by strict time progression ($t_{\mathrm{eval}} > t_{\mathrm{last}}$) so equal-stage-time
evaluations never over-extrapolate. Under `cuDSS`, the predictor is an exact zero-byte no-op.

### Pure-prism P2 wedge discretization for thin films

Conventional isotropic tetrahedral P2 meshing of high-aspect-ratio thin films produces millions of
airbox and film degrees of freedom, while mixed prism/pyramid/tet P1 meshes suffer large
demagnetizing-factor defects (`-30.11%` Aharoni error on `300x300x5 nm` Permalloy). Using
`transition_policy="pure_prism"` extrudes a 100% conforming `prism6` shared domain (zero pyramids,
zero tetrahedra), unlocking conforming second-order wedge elements `H1_WedgeElement(2)` for the
scalar potential at $5.76\times$ fewer degrees of freedom than `tet P2`. For mixed meshes with
`layers >= 2`, a deterministic Chebyshev-center linear-program untangler
(`_untangle_same_side_mixed_tetrahedra`) removes inverted same-side two-owner tetrahedra
(`6 -> 0`).

(perf-fem-gpu-demag-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $K$ | assembled sparse SPD magnetostatic stiffness matrix | $\mathrm{m}$ |
| $L$ | lower-triangular Cholesky factor of permuted stiffness matrix | $\mathrm{m^{1/2}}$ |
| $P$ | fill-reducing symmetric permutation matrix | $1$ |
| $\phi$ | magnetic scalar potential vector | $\mathrm{A}$ |
| $\mathbf b(\mathbf m)$ | magnetic divergence right-hand side vector | $\mathrm{A\,m}$ |
| $\mathbf H_{\mathrm{d}}$ | recovered demagnetizing magnetic field | $\mathrm{A\,m^{-1}}$ |
| $B, B_{\mathrm{cap}}$ | effective and configured VRAM admission budget | $\mathrm{B}$ |
| $M_{\mathrm{free}}, M_{\mathrm{total}}$ | free and total CUDA device VRAM at admission | $\mathrm{B}$ |
| $\widehat M_{\mathrm{peak}}, \widehat M_{\mathrm{stable}}$ | cuDSS post-analysis peak and steady factor memory estimates | $\mathrm{B}$ |
| $\phi^{(0)}$ | two-step linearly extrapolated Krylov initial potential | $\mathrm{A}$ |
| $\alpha_{\mathrm{pred}}, r_{\max}$ | clamped linear extrapolation ratio and upper bound | $1$ |
| $t_{\mathrm{eval}}, t_n$ | stage evaluation time and accepted step time | $\mathrm{s}$ |

(perf-fem-gpu-demag-assumptions-and-validity)=
## Assumptions and validity

- **Memory scaling of direct Cholesky:** Direct sparse Cholesky factor fill-in grows super-linearly
  in 3D ($O(N^{4/3})$ memory, $O(N^2)$ flops for regular 3D blocks). `gpu_strategy="auto"`
  intentionally switches to `hypre_krylov` once $\widehat M_{\mathrm{peak}} > B$ so large 3D meshes
  never crash unexpectedly.
- **Exactness of `pure_prism_p2`:** `generate_pure_prism_box_airbox_mesh` requires a uniform
  layered box geometry strictly enclosed in a bounding-box airbox and emits a verifiable
  `pure_prism_topology_certificate.v1` validated in `crates/fullmag-ir/src/mixed_certificate.rs`.
- **FSAL invalidation:** Time-dependent drive discontinuities, thermal noise, topology changes, or
  explicit state mutations automatically invalidate cached $k_0$ via the 10-condition operator
  signature.

(perf-fem-gpu-demag-python-api)=
## Python API

```python
# %% Configure FEM GPU auto-cuDSS Poisson demag with pure_prism_p2 swept controls
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_gpu_cudss_pure_prism_demo")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(600 * nm, 600 * nm, 120 * nm))

film = study.geometry(
    fm.Box(size=(300 * nm, 300 * nm, 5 * nm), name="permalloy_film"),
    name="permalloy_film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))

swept = fm.SweptMeshControls(
    sweep_direction="z",
    element_family="prism",
    transition_policy="pure_prism",
    exact_layer_count=True,
)
assert swept.transition_policy == "pure_prism"

study.demag(model="airbox", variant="robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-8,
    max_iterations=500,
    gpu_strategy="auto",
)
study.solver(integrator="rk4", fix_dt=2.0e-13)
study.stages.add_run(until=1.0e-11, stage_id="rk4_cudss")
```

## Parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FemLinearSolverPolicy.gpu_strategy` | `Literal["auto","cg_amg","cudss"]` | `"auto"` | $1$ | `"auto"`, `"cg_amg"`, or `"cudss"`; unknown values raise `ValueError` | GPU demag direct vs Krylov selection policy | FEM GPU (ignored on CPU) | `demag_solver_policy.gpu_strategy` |
| `SweptMeshControls.transition_policy` | `Literal["pyramid_to_tetrahedra","pure_prism","reject"]` | `"reject"` | $1$ | `"pure_prism"` requires uniform layered box in bbox airbox | shared-domain swept prism-to-airbox transition | FEM CPU/GPU meshing | `mesh_controls.swept.transition_policy` |
| `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER` | `env str` | unset | $1$ | `"auto"`, `"cg_amg"`, `"hypre"`, `"off"`, or `"cudss"` runtime override | process-level override for FEM GPU demag strategy | FEM GPU runtime env | `provenance.resolved_linear_solver` |
| `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` | `env int` | device auto | $\mathrm{MiB}$ | positive MiB ceiling for cuDSS peak factor budget | explicit VRAM cap triggering `auto` fallback or `cudss` refusal | FEM GPU runtime env | `provenance.linear_solver_fallback_reason` |

(perf-fem-gpu-demag-problem-ir)=
## ProblemIR and provenance

The `gpu_strategy` policy lowers into `demag_solver_policy` and is transmitted to the native C ABI
through `fullmag_fem_backend_create_v6` (`fullmag_fem_plan_desc_v5`). Runtime provenance queried
via `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1` separates requested intent from
resolved execution:

```json
{
  "backend_policy": {
    "discretization_hints": {
      "fem": {
        "demag_solver_policy": {
          "solver": "CG",
          "preconditioner": "AMG",
          "rtol": 1e-8,
          "max_iterations": 500,
          "gpu_strategy": "auto"
        }
      }
    }
  },
  "provenance": {
    "requested_linear_solver_strategy": "auto",
    "resolved_linear_solver": "cudss_direct",
    "linear_solver_fallback_reason": null,
    "pure_prism_topology_certificate": "pure_prism_topology_certificate.v1"
  }
}
```

In the GPU operator execution receipt bitmask, bit 12 (`FULLMAG_FEM_GPU_OPERATOR_DIRECT_SOLVE`) is
mutually exclusive with the iterative `PRECONDITIONER` bit so downstream audits verify
unambiguously whether cuDSS or HYPRE executed.

## Control Room workflow

In Control Room, FEM demagnetization solver settings expose `gpu_strategy` alongside Krylov
`rtol` and `max_iterations`. Post-run diagnostics inspect `resolved_linear_solver`, peak factor
VRAM estimate, `linear_solver_fallback_reason` (for example `cudss_factor_exceeds_vram_budget`),
and the pure-prism mesh topology certificate without re-running the solver.

(perf-fem-gpu-demag-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Requested intent versus resolved execution:** Requested intent (`gpu_strategy="auto"`) is
  preserved verbatim while resolved execution records `resolved_linear_solver` (`"cudss_direct"`
  or `"hypre_krylov"`), along with factor VRAM estimates and whether factorization started.
- **Validation errors:** Unknown `gpu_strategy` strings, invalid `transition_policy` values,
  non-box or uncertified `pure_prism` geometries, and invalid VRAM caps fail validation before
  mesh/solver setup.
- **Unsupported combinations:** When `gpu_strategy="cudss"` exceeds the VRAM budget, initialization
  fails closed (`rc = 2`, `factorization_started = false`) with zero fallback. Singular stiffness
  matrices (`CUDSS_DATA_INFO != 0`) fail closed under both `"auto"` and `"cudss"`. Strict GPU runs
  never fall back to CPU Poisson or CPU `FEM/BEM`.

(perf-fem-gpu-demag-discrete-realization)=
## Discrete realization and 4-lane support matrix

| Solver | Device | Status | Realization |
|---|---|---|---|
| `FEM` | `GPU` | implemented | Three-state `auto`/`cg_amg`/`cudss` direct Cholesky (open Poisson, 1D/2D PBC Poisson, atomic FEM/BEM pair), CUB pair-norm residual certification, BoomerAMG relax 18, RK FSAL `k0` + 2-step linear potential predictor, and `pure_prism_p2`. |
| `FEM` | `CPU` | implemented | MFEM/HYPRE CPU reference Poisson and Fredkin--Koehler `FEM/BEM` plus shared `pure_prism_p2` mesh ingestion. |
| `FDM` | `CPU` | not-applicable | Cartesian FDM uses Newell FFT convolution rather than FEM scalar-potential stiffness matrices. |
| `FDM` | `GPU` | not-applicable | Cartesian FDM CUDA uses batched real-to-complex cuFFT documented on the FDM core page. |

(perf-fem-gpu-demag-implementation-mapping)=
## Implementation mapping

Three-state cuDSS admission, atomic `FEM/BEM` pair initialization, and solve live in
`backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` and
`backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`; CUB residual certification and BoomerAMG relax
18 live in `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`; explicit RK FSAL policy
and two-step linear predictor live in `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp` and
`backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu`; and `pure_prism_p2` meshing/certification
live in `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` and
`crates/fullmag-ir/src/mixed_certificate.rs`. See {ref}`perf-fem-gpu-demag-source-code-index`.

(perf-fem-gpu-demag-validation)=
## Validation and verified benchmarks

### Auto-cuDSS open Poisson, PBC Poisson, and atomic `FEM/BEM` (RTX 4080 SUPER SM 8.9, cuDSS 0.8.0.10, `rtol = 1e-8`, 50 steps)

- **SP4 open airbox (`8,208` nodes / `60,791` P2 DOFs):** Heun `813.13 -> 3.72 ms/step`
  (**218.4x**); RK4 `1215.01 -> 8.06 ms/step` (**150.8x**); factor VRAM `325.6 MiB`; parity
  `max|dm| <= 5.97e-12`, `rel dE_demag <= 4.48e-11`.
- **Medium open airbox (`49,600` nodes / `380,701` P2 DOFs):** Heun `477.30 -> 23.45 ms/step`
  (**20.36x**); RK4 `874.73 -> 45.87 ms/step` (**19.07x**); factor VRAM `3.13 GiB`; parity
  `max|dm| <= 2.51e-11`.
- **Tight VRAM cap (`FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB=32`):** `auto` falls back cleanly with
  `factorization_started = false` (`255.93 ms/step`, bitwise `0.0` parity vs explicit `cg_amg`);
  explicit `cudss` fails closed (`rc = 2`, 0 fallbacks).
- **Atomic GPU `FEM/BEM` open (`1,183` nodes, no airbox):** Heun `2.20 ms/step` — **34.6x** vs GPU
  AMG (`76.10 ms`), **19.5x** vs GPU JACOBI (`42.90 ms`), and **5.4x** vs CPU `FEM/BEM`
  (`11.97 ms`), with `max|dm| = 4.88e-14` versus CPU.
- **PBC-reduced Poisson (`8,379` nodes, P1):** 1D Robin Heun **28.6x** (`56.81 -> 1.99 ms`), RK4
  **26.8x** (`92.19 -> 3.44 ms`); 2D film Neumann+pin Heun **35.5x** (`72.75 -> 2.05 ms`), RK4
  **33.0x** (`118.12 -> 3.58 ms`); `max|dm| <= 3.51e-11`.
- **RTX 5050 8 GB validation:** `15k`/`49k`/`90k`-node open airbox speedups **26x--36x / 12.6x /
  11.7x**; `36,576`-node prism P1 film relaxation **29x/step**, **22x/stage** (`929.9 -> 43.0 s`),
  **16x** whole run.

### Explicit RK FSAL $k_0$ reuse, linear predictor, and CUB certification (`cg_amg` lane, RTX 4080 SUPER)

- **Medium `49,600` nodes (`cg_amg`):** PCG iterations/step reduced **-48.0%** on Heun
  (`150 -> 78.02`, **1.87x** wall `477.30 -> 254.83 ms`) and **-53.9%** on RK4 (`254.9 -> 117.58`,
  **2.19x** wall `874.73 -> 400.22 ms`).
- **SP4 `8,208` nodes (`cg_amg`):** **1.24x** Heun / **1.32x** RK4; **PBC 1D/2D:** **1.51x /
  1.27x**; control fences/step reduced `7 -> 3` (Heun) and `11 -> 5` (RK4) with 0 compute syncs.

### `pure_prism_p2` thin-film P2 discretization (RTX 4080 SUPER, `300x300x5 nm` Permalloy)

- **`L = 1` (`h = 5 nm`, `594,239` P2 DOFs):** meshing `0.50 s` (**246x** faster than `tet P2`
  `123 s`), Aharoni demag error `-0.80%` (vs `-30.11%` mixed P1), relaxed $E_{\mathrm{total}}$
  `-0.50%` vs FDM / `+0.22%` vs MuMax3, cuDSS factor `5.14 GiB`, **`38.53 ms/step`** (**144.8x**
  faster than `cg_amg` `5,579.74 ms/step`, **~197x** vs `tet P2`).
- **`L = 2` (`h = 5 nm`, `709,253` P2 DOFs):** meshing `0.51 s`, Aharoni error **`-0.60%`** (beats
  `tet P2` `-0.63%` at **5.76x fewer DOFs**), relaxed $E_{\mathrm{total}}$ `-0.43%` vs FDM, cuDSS
  factor `6.73 GiB`, **`51.88 ms/step`**.

(perf-fem-gpu-demag-limitations)=
## Limitations and rejected approaches

- **CUDA Graph capture around RK + cuDSS (deferred):** Explicitly deferred because cuDSS `0.8.0.10`
  performs stack-backed small H2D copies inside `CUDSS_PHASE_SOLVE` and residual certification
  branches on host telemetry.
- **Rejected NO-GO demag candidates:** Deterministic delta-potential demagnetization, HYPRE
  async/Umpire memory allocators, and BoomerAMG relax type 6 failed p95 wall-time, attribution, and
  parity remediation gates and were removed from production.
- **Unqualified CPU/GPU auto-crossover:** Automated crossover dispatch (`rtx4080-sm89.json`)
  remains explicitly `qualified: false`; users select CPU or GPU explicitly.

(perf-fem-gpu-demag-scientific-bibliography)=
## Scientific bibliography

1. D. R. Fredkin and T. R. Koehler, "Hybrid method for computing demagnetizing fields," *IEEE
   Transactions on Magnetics* **26**, 415--417 (1990),
   [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
2. A. Aharoni, "Demagnetizing factors for rectangular ferromagnetic prisms," *Journal of Applied
   Physics* **83**, 3432--3434 (1998), [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
3. R. Anderson et al., "MFEM: A modular finite element methods library," *Computers & Mathematics
   with Applications* **81**, 42--74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).
4. R. D. Falgout and U. M. Yang, "hypre: A library of high performance preconditioners," *LNCS*
   **2331**, 632--641 (2002), [doi:10.1007/3-540-47789-6_66](https://doi.org/10.1007/3-540-47789-6_66).
5. NVIDIA Corporation, *cuDSS 0.8.0 Library Documentation*, `CUDSS_DATA_MEMORY_ESTIMATES` and
   Cholesky direct sparse solver phases.

(perf-fem-gpu-demag-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public `gpu_strategy` policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Declare `auto`/`cg_amg`/`cudss` strategy and Krylov tolerances | Public API | Python contract suite |
| Strategy resolution | `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `resolve_demag_gpu_solver_strategy` | Resolve plan policy and env overrides | `FEM GPU` | RTX 4080 SUPER A/B |
| Post-analysis VRAM budget guard | `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `check_demag_cudss_factor_fits` | Compare `CUDSS_DATA_MEMORY_ESTIMATES[1]` against reserved VRAM | `FEM GPU` | 32 MiB cap fallback/refusal A/B |
| Single-operator cuDSS admission | `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `try_initialize_demag_cudss_direct` | Open and PBC-reduced Poisson cuDSS factor-once initialization | `FEM GPU` | RTX 4080 SUPER A/B (up to 218.4x) |
| Atomic FEM/BEM `(u1, u2)` admission | `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `try_initialize_fem_bem_cudss_pair` | Joint VRAM budget and atomic dual-factor creation | `FEM GPU` | RTX 4080 SUPER A/B (34.6x vs AMG) |
| cuDSS triangular solve | `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `solve_demag_cudss_direct` | Per-step triangular solve inside `HypreStreamInterop` | `FEM GPU` | RTX 4080 SUPER & RTX 5050 A/B |
| GPU FEM/BEM initialization | `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp` | `gpu_demag_fem_bem_initialize` | Wire cuDSS pair or relax-18 HYPRE into GPU Fredkin--Koehler | `FEM GPU` | Parity `4.88e-14` vs CPU |
| Multi-block CUB residual certification | `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `certify_gpu_hypre_demag_residual` | Single-sync 16 B pair-norm residual check | `FEM GPU` | Control fences `7->3`, `11->5` |
| BoomerAMG coarse relax-18 setup | `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `initialize_demag_poisson_hypre_device_solver` | Eliminate hidden coarse-level CPU transfers | `FEM GPU` | `1712/1712 -> 0/0` transfer audit |
| Versioned backend create ABI | `backends/fem/src/api.cpp` | `fullmag_fem_backend_create_v6` | Deliver `gpu_strategy` to native FEM context | `FEM GPU` | C ABI contract |
| Demag solver provenance query | `backends/fem/src/api.cpp` | `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1` | Export realized solver, VRAM estimate, and fallback reason | `FEM GPU` | Rust/C++ provenance suite |
| Explicit RK FSAL `k0` gate | `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp` | `gpu_rk_rhs_allows_fsal_k0_reuse` | 10-condition operator signature gate for Heun/RK4 `k0` reuse | `FEM GPU` | RTX 4080 SUPER `cg_amg` A/B |
| Decoupled endpoint shortcut gate | `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp` | `gpu_rk_allows_endpoint_rhs_shortcut` | Preserve `k0` reuse when frozen spins or PBC active | `FEM GPU` | FSAL unit/runtime contracts |
| Two-step linear potential kernel | `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu` | `demag_linear_predict_potential_kernel` | Compute clamped $\phi^{(0)}$ warm start on GPU | `FEM GPU` | `-48.0%` / `-53.9%` PCG iters |
| Predictor warm-start driver | `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu` | `gpu_demag_predictor_apply_warm_start` | Apply predictor on Krylov lane; 0 B no-op under cuDSS | `FEM GPU` | RTX 4080 SUPER A/B |
| Pure-prism shared-domain mesher | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_pure_prism_box_airbox_mesh` | Extrude 100% `prism6` film+airbox for conforming P2 wedges | `FEM CPU/GPU` | `0.50 s` mesh (246x vs `tet P2`) |
| Chebyshev mixed-tet untangler | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_untangle_same_side_mixed_tetrahedra` | Eliminate inverted `layers >= 2` mixed-mesh overlaps | `FEM CPU/GPU` | `6 -> 0` overlap contract |
| Pure-prism topology certificate validator | `crates/fullmag-ir/src/mixed_certificate.rs` | `validate_pure_prism_topology_certificate_against_mesh` | Enforce fail-closed `pure_prism_topology_certificate.v1` | `FEM CPU/GPU` | Rust IR contract suite |
