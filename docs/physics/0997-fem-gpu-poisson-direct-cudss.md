# FEM GPU. Guarded factor-once direct solve of the demag linear systems (cuDSS)

Status `production auto-policy / VRAM-guarded / pending Phase 2 RTX 4080 SUPER qualification`. Branch
`codex/fem-core-gpu-p0-20261126` (extending PR #550). The realization is governed by the public three-state policy
`FemLinearSolverPolicy.gpu_strategy` (`"auto"`, `"cg_amg"`, `"cudss"`, default `"auto"`), delivered at backend
creation time through `fullmag_fem_plan_desc_v5` and `fullmag_fem_backend_create_v6`.

(problem-statement)=
## Scope

This note covers the guarded sparse Cholesky direct-solve realization (NVIDIA cuDSS) for the strict FEM GPU demag
owners `device_hypre_poisson` (open airbox and PBC-reduced periodic operators) and `device_hypre_fem_bem`
(Fredkin–Koehler coupled $u_1$/$u_2$ potentials): each SPD matrix is factored once at setup instead of solved by
preconditioned Krylov iteration at every evaluation. The demag model, boundary conditions, and discretizations belong
to the [canonical Poisson description](fem_demag_poisson.md) and [FEM/BEM description](fem_demag_fem_bem.md); the
public solver policy belongs to [note 0532](0532-fem-demag-solver-policy-and-runtime-threading.md). The motivation is
measured in `docs/audits/2026-11-24-fem-gpu-cudss-direct-poc.md`: at 49 176 nodes, 98.5 % of a Heun step is the hypre
PCG call, paced by host-side launches and synchronizations while the GPU stays under 1 % busy.

| Realization | Scope of this note | Evidence |
|---|---|---|
| FEM CPU | Not changed; MFEM/hypre CG or GMRES with the existing preconditioners | Source unchanged |
| FEM GPU | Three-state `auto`/`cg_amg`/`cudss` cuDSS direct solve for open Poisson, PBC-reduced Poisson, and FEM/BEM `(u1, u2)` with VRAM preflight and explicit fallback provenance | PR #550 RTX 5050 measurements for open Poisson; Track B contract tests for `auto`/VRAM/PBC/FEM-BEM (Phase 2 RTX 4080 SUPER A/B pending) |
| FDM CPU | Not applicable | FDM computes demag by FFT convolution, not by FEM sparse linear systems |
| FDM GPU | Not applicable | FDM computes demag by FFT convolution, not by FEM sparse linear systems |

(governing-equations)=
## Equations

Each FEM GPU demag owner solves one SPD linear system per field evaluation (Poisson open or PBC-reduced) or two SPD
systems in sequence (Fredkin–Koehler FEM/BEM $u_1$ Neumann and $u_2$ Dirichlet):

```{math}
:label: eq-direct-system
K\phi = b
```

For periodic Poisson demag, the reduced operator is formed by full-column-rank equivalence-class prolongation
$P_{\mathrm{pbc}}$:

```{math}
:label: eq-direct-pbc-congruence
A_{\mathrm{red}} = P_{\mathrm{pbc}}^{\mathsf T} A_{\mathrm{full}} P_{\mathrm{pbc}}
```

Because $\operatorname{rank}(P_{\mathrm{pbc}}) = N_{\mathrm{red}}$, strict symmetric positive definiteness of
$A_{\mathrm{full}}$ implies $y^{\mathsf T} A_{\mathrm{red}} y = (P_{\mathrm{pbc}} y)^{\mathsf T} A_{\mathrm{full}}
(P_{\mathrm{pbc}} y) > 0$ for all $y \ne 0$, so $A_{\mathrm{red}}$ is strictly SPD whenever the constant null space is
removed (1D-periodic Robin with $\beta > 0$, 2D-periodic film with pure Neumann $\beta = 0$ and a singleton
open-boundary gauge pin, or 1D/2D Dirichlet).

The matrix does not change during a run: it depends on the mesh and boundary conditions only, while the right-hand
side follows the magnetization. The direct realization factors a fill-reducing symmetric permutation of each SPD
matrix once and then applies two triangular solves per evaluation:

```{math}
:label: eq-direct-factorization
P K P^{\mathsf T} = L L^{\mathsf T},\qquad
L y = P b,\qquad
L^{\mathsf T}\left(P\tilde{\phi}\right) = y
```

Every computed solution is certified with the shared multi-block independent Euclidean residual check (one fused
pair-norm D2H readback of 16 bytes and one stream synchronization per solve):

```{math}
:label: eq-direct-residual
r = b - K\tilde{\phi},\qquad
\rho = \frac{\lVert r\rVert_2}{\lVert b\rVert_2} \le \tau_{\mathrm{rel}}
```

Factorization starts only when the device-memory peak estimated by cuDSS in the analysis phase fits the device budget
derived from free device memory and the combined optional caps:

```{math}
:label: eq-direct-memory-budget
M_{\mathrm{margin}} = \max\left(M_{0},\ \frac{M_{\mathrm{total}}}{20}\right),\qquad
B_{\mathrm{cap}} = \min\left(B_{\mathrm{bytes}},\ 2^{20} B_{\mathrm{MiB}}\right),\qquad
B = \min\left(M_{\mathrm{free}} - M_{\mathrm{margin}},\ B_{\mathrm{cap}}\right),\qquad
\hat{M}_{\mathrm{peak}} \le B
```

For GPU FEM/BEM, $u_1$ (Neumann with one `EliminateRowCol` gauge pin per connected component) and $u_2$ (Dirichlet
with `EliminateRowCol` on all $\partial \Omega_m$ nodes) are analyzed together and admitted atomically against the
combined sequential peak so both systems always stay in the same linear-solver family:

```{math}
:label: eq-direct-fem-bem-pair-budget
\hat{M}_{\mathrm{peak,FK}} = \max\!\left(\hat{M}_{\mathrm{peak},1},\ \hat{M}_{\mathrm{stable},1} + \hat{M}_{\mathrm{peak},2}\right) \le B
```

The budget is a resource guard, not physics: it does not change $\tilde{\phi}$. It decides whether cuDSS
factorization starts or (under `"auto"`) whether analysis buffers are released cleanly and execution falls back to
HYPRE Krylov with explicit provenance.

(symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
|---|---|---|
| $K$ | SPD demag system matrix: open or reduced Poisson stiffness plus Robin boundary mass, or FEM/BEM $K_{\mathrm{neumann}}$ / $K_{\mathrm{dirichlet}}$, after essential-condition elimination | $\mathrm{m}$ |
| $A_{\mathrm{full}}$ | Unreduced periodic-domain boundary-conditioned Poisson stiffness/Robin operator | $\mathrm{m}$ |
| $A_{\mathrm{red}}$ | Periodic equivalence-class reduced Poisson operator $P_{\mathrm{pbc}}^{\mathsf T} A_{\mathrm{full}} P_{\mathrm{pbc}}$ | $\mathrm{m}$ |
| $P_{\mathrm{pbc}}$ | Full-column-rank binary prolongation matrix mapping reduced periodic classes to full nodal DOFs | $1$ |
| $\phi$ | Exact vector of nodal scalar-potential coefficients | $\mathrm{A}$ |
| $\tilde{\phi}$ | Computed vector of nodal scalar-potential coefficients | $\mathrm{A}$ |
| $b$ | Right-hand side vector built from the magnetization | $\mathrm{A\,m}$ |
| $P$ | Fill-reducing symmetric permutation chosen in the cuDSS analysis phase | $1$ |
| $L$ | Lower-triangular Cholesky factor of the permuted matrix | $\mathrm{m^{1/2}}$ |
| $y$ | Intermediate vector of the forward substitution | $\mathrm{A\,m^{1/2}}$ |
| $r$ | Algebraic residual of the computed solution | $\mathrm{A\,m}$ |
| $\rho$ | Relative Euclidean residual | $1$ |
| $\tau_{\mathrm{rel}}$ | Relative residual tolerance from the solver policy | $1$ |
| $M_{\mathrm{free}}$ | Free device memory reported by `cudaMemGetInfo` after the analysis phase | $\mathrm{B}$ (byte) |
| $M_{\mathrm{total}}$ | Total device memory reported by `cudaMemGetInfo` | $\mathrm{B}$ (byte) |
| $M_{0}$ | Minimum safety margin, $536\,870\,912$ bytes (512 MiB) | $\mathrm{B}$ (byte) |
| $M_{\mathrm{margin}}$ | Safety margin kept free for the rest of the run, display, and allocator fragmentation | $\mathrm{B}$ (byte) |
| $B_{\mathrm{bytes}}$ | Optional byte cap from `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES`; $+\infty$ when unset | $\mathrm{B}$ (byte) |
| $B_{\mathrm{MiB}}$ | Optional MiB cap from `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB`; $+\infty$ when unset | $1$ |
| $B_{\mathrm{cap}}$ | Combined optional cap $\min(B_{\mathrm{bytes}},\, 2^{20} B_{\mathrm{MiB}})$; $+\infty$ when neither cap is set | $\mathrm{B}$ (byte) |
| $B$ | Device budget for the cuDSS factorization and solve phases | $\mathrm{B}$ (byte) |
| $\hat{M}_{\mathrm{peak}}$ | Single-system device peak estimated by cuDSS after analysis (`CUDSS_DATA_MEMORY_ESTIMATES`, entry 1) | $\mathrm{B}$ (byte) |
| $\hat{M}_{\mathrm{peak},1}$ | Estimated device peak for the FEM/BEM $u_1$ Neumann analysis | $\mathrm{B}$ (byte) |
| $\hat{M}_{\mathrm{stable},1}$ | Estimated steady device residency of the factored FEM/BEM $u_1$ handle (`CUDSS_DATA_MEMORY_ESTIMATES`, entry 0) | $\mathrm{B}$ (byte) |
| $\hat{M}_{\mathrm{peak},2}$ | Estimated device peak for the FEM/BEM $u_2$ Dirichlet analysis | $\mathrm{B}$ (byte) |
| $\hat{M}_{\mathrm{peak,FK}}$ | Combined sequential device peak bound for atomic FEM/BEM `(u1, u2)` admission | $\mathrm{B}$ (byte) |

(assumptions-and-validity)=
## Assumptions and validity

- **Strict SPD requirement (fail-closed even under `"auto"`):** Each factored matrix must be symmetric positive
  definite. This holds for open Robin/Dirichlet Poisson, 1D-periodic Robin, 2D-periodic film with singleton gauge pin,
  1D/2D-periodic Dirichlet, and both FEM/BEM operators ($K_{\mathrm{neumann}}$ with one gauge node per connected
  component and $K_{\mathrm{dirichlet}}$ with all $\partial \Omega_m$ nodes eliminated). A singular matrix such as
  3D-periodic pure Neumann without a gauge pin triggers `CUDSS_DATA_INFO != 0` and **always** fails closed with an
  error — never falling back to HYPRE Krylov, even under `gpu_strategy="auto"`.
- **Precision and scope:** Real double precision (`FP64`) only, one GPU, one process.
- **Memory scaling and WDDM safety:** Factor fill-in grows faster than the mesh. Under `"auto"`, an estimated peak
  exceeding {eq}`eq-direct-memory-budget` or {eq}`eq-direct-fem-bem-pair-budget` releases all analysis handles before
  factorization starts (`factorization_started = false`) and falls back cleanly to HYPRE Krylov with explicit
  provenance. Under explicit `gpu_strategy="cudss"`, an over-budget estimate fails hard with zero fallback.
- **Backward stability:** Cholesky with any symmetric permutation is backward stable for SPD matrices, and every solve
  is certified independently by {eq}`eq-direct-residual`.
- **CUDA Graph capture explicitly deferred (Non-Goal P1):** Capturing an RK+`cuDSS` step into a raw CUDA Graph is
  deliberately excluded from this production scope based on the four blockers established in
  `backends/fem/gpu/frequency_domain/modal_cudss_device_graph.cpp`:
  1. `cuDSS 0.8.0.10` enqueues private small host-to-device copies ($\le 64\,\mathrm{B}$) from host stack addresses
     during `cudssExecute(CUDSS_PHASE_SOLVE)`, causing dangling pointers under naive stream capture without graph
     cloning, control-buffer probing, and D2D node rewriting.
  2. Independent residual certification (`A_par->Mult`, `HYPRE_ParVectorAxpy`, host HYPRE error checks, fused sync,
     and finite/tolerance branching) cannot run inside `cudaStreamBeginCapture`.
  3. Per-stage scalar parameters (`evaluation_time_s`, `active_dt`, drive envelopes, `HOST_EXPRESSION`) vary per
     stage and attempt.
  4. Two-stream `HypreStreamInterop` event fences and adaptive RK accept/reject loops require host control flow.

(python-api)=
## Python API

The public parameter `FemLinearSolverPolicy.gpu_strategy` (also exposed on `study.fem_demag_solver(..., gpu_strategy=...)`
and `fm.fem_demag_solver(..., gpu_strategy=...)`) selects the GPU demag linear-solver strategy orthogonally to the
Krylov parameters (`solver`, `preconditioner`) used on FEM CPU and on HYPRE fallback:

```python
# %% Study, engine, device and mode
import fullmag as fm

study = fm.study("fem_gpu_poisson_auto_cudss")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="auto", size=(600e-9, 600e-9, 120e-9), center=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=40e-9)
study.interactive(False)

# %% Geometry, material and mesh
body = study.geometry(fm.Box(size=(200e-9, 200e-9, 20e-9)), name="magnet")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.texture.random(seed=7)
body.mesh(maximum_element_size=2.5e-9, order=1)

# %% Interactions and public demag solver policy (requested intent)
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-8,
    max_iterations=500,
    gpu_strategy="auto",
)
study.b_ext(0.0, 0.0, 10e-3)
study.build_domain_mesh()

# %% Dynamics stage
study.stages.add_run(20 * 2e-14, fix_dt=2e-14, integrator="heun")
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| FemLinearSolverPolicy.solver | str | CG | 1 | CG or GMRES | Outer iterative Krylov method (FEM CPU and GPU HYPRE fallback) | FEM CPU/GPU | fem.demag_solver_policy.solver |
| FemLinearSolverPolicy.preconditioner | str | AMG | 1 | AMG, JACOBI or NONE | Krylov preconditioner (FEM CPU and GPU HYPRE fallback; unused under cudss_direct) | FEM CPU/GPU | fem.demag_solver_policy.preconditioner |
| FemLinearSolverPolicy.rtol | float | 1e-8 | 1 | positive finite value | Relative Euclidean residual tolerance certifying every solve | FEM CPU/GPU | fem.demag_solver_policy.rtol |
| FemLinearSolverPolicy.atol | float \| None | None | $\mathrm{A\,m}$ | None or positive finite value | Optional absolute residual tolerance | FEM CPU/GPU | fem.demag_solver_policy.atol |
| FemLinearSolverPolicy.max_iterations | int | 500 | 1 | at least 1 | Krylov iteration limit; cuDSS direct solves report one iteration | FEM CPU/GPU | fem.demag_solver_policy.max_iterations |
| FemLinearSolverPolicy.print_level | int | 0 | 1 | non-negative | Linear-solver diagnostics verbosity level | FEM CPU/GPU | fem.demag_solver_policy.print_level |
| FemLinearSolverPolicy.gpu_strategy | str | auto | 1 | auto, cg_amg, or cudss | GPU demag direct-vs-Krylov selection policy delivered at backend creation time | FEM GPU (ignored on FEM CPU) | fem.demag_solver_policy.gpu_strategy |

(problem-ir)=
## ProblemIR

The canonical fragment from `fm.FemLinearSolverPolicy(solver="CG", preconditioner="AMG").to_ir()` lands in
`FemHintsIR.demag_solver_policy` and lowers into `FemPlanIR.demag_solver_policy`:

```json
{"solver": "CG", "preconditioner": "AMG", "rtol": 1e-08, "max_iterations": 500, "print_level": 0, "gpu_strategy": "auto"}
```

Legacy `ProblemIR` JSON payloads that omit `"gpu_strategy"` deserialize cleanly with `"auto"` via
`#[serde(default = "default_fem_gpu_strategy")]` in `crates/fullmag-ir/src/study.rs`. The planner
(`crates/fullmag-plan/src/fem.rs`) rejects any value outside `"auto"`, `"cg_amg"`, or `"cudss"`.

(round-trip-and-failure-semantics)=
## Round trip and failure semantics

- **Requested intent vs. resolved execution:**
  - `requested_linear_solver_strategy` records the plan's strategy (`"auto"`, `"cg_amg"`, or `"cudss"`), while
    `linear_solver`, `preconditioner`, `rtol`, and `max_iterations` preserve the Krylov policy.
  - `resolved_linear_solver` records the realization actually initialized by the device GPU demag workspace
    (`"cudss_direct"` or `"hypre_krylov"`), read back through
    `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1`.
  - `linear_solver_fallback_reason` is populated exclusively when `"auto"` falls back to HYPRE Krylov:
    `"cudss_unavailable"`, `"cudss_factor_exceeds_vram_budget"`, or `"cudss_memory_estimate_unavailable"`.
  - All three fields are published on both `ExecutionProvenance.fem_poisson_demag` (`FemPoissonDemagProvenance`) and
    `ExecutionProvenance.fem_bem_demag` (`FemBemDemagProvenance`), and echoed in artifact `gpu_demag_runtime_metadata`
    (reading from `fem_poisson_demag` or `fem_bem_demag`). Non-GPU lanes (FEM CPU and hybrid CPU Poisson) leave all
    three fields absent.
- **Creation-time ABI contract (`create_v6`):** Because `gpu_demag_poisson_initialize` executes inside backend
  creation before the handle returns to Rust, `gpu_demag_solver_strategy` is passed via `fullmag_fem_plan_desc_v5` and
  `fullmag_fem_backend_create_v6`, writing `ctx.poisson_demag.gpu_solver_strategy` before `initialize_backend_runtime`.
  Legacy `fullmag_fem_backend_create_v5` remains ABI-compatible and defaults to `AUTO`.
- **Environment override precedence:**
  - `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER`: unset/empty uses the plan's `gpu_strategy`; `"auto"` selects `AUTO`;
    `"cudss"` selects `CUDSS`; `"cg_amg"`, `"hypre"`, or `"off"` selects `CG_AMG`; any other value fails closed.
  - `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` (bytes) and `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` (MiB,
    checked for `uint64_t` overflow when multiplied by $2^{20}$) are both validated and combined via $\min$. Malformed
    values (`"0"`, `"-5"`, `"abc"`, overflow) **always** fail hard, even under `gpu_strategy="auto"` or `"cg_amg"`.
- **Three-state resolution matrix:**
  - `cg_amg`: skips cuDSS completely (zero analysis/factorization, zero cuDSS device memory) and runs HYPRE Krylov.
  - `cudss`: fails hard if cuDSS is unavailable at build time, memory estimates are missing, or estimated peak exceeds
    {eq}`eq-direct-memory-budget` / {eq}`eq-direct-fem-bem-pair-budget` (without starting factorization).
  - `auto`: admits cuDSS when available and within budget; otherwise releases all analysis handles cleanly without
    factorizing and falls back to HYPRE Krylov with explicit `linear_solver_fallback_reason`.
  - `CUDSS_DATA_INFO != 0` (singular/non-SPD operator such as 3D-periodic pure Neumann without a gauge pin): **always**
    fails closed even under `auto`.
- **Validation errors**: a factorization with `CUDSS_DATA_INFO != 0` (singular or non-SPD operator such as
  3D-periodic pure Neumann without a gauge pin), a cuDSS or CUDA status other than success, a non-square or empty
  matrix, a missing positive diagonal entry, a residual failing {eq}`eq-direct-residual`, an invalid `gpu_strategy`
  value, a malformed `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER`, or a malformed/overflowing
  `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` / `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` cap **always**
  fails closed — even under `gpu_strategy="auto"`. Under explicit `gpu_strategy="cudss"`, cuDSS build unavailability,
  missing `CUDSS_DATA_MEMORY_ESTIMATES`, or an estimated peak above {eq}`eq-direct-memory-budget` /
  {eq}`eq-direct-fem-bem-pair-budget` also fails hard without starting factorization.
- **Unsupported combinations**: FEM CPU and the explicit hybrid CPU-Poisson mode do not run cuDSS (leaving GPU
  linear-solver provenance fields absent); FDM has no FEM sparse linear system; 3D-periodic pure Neumann without a
  gauge pin is singular and fails closed; CUDA Graph capture for RK+`cuDSS` is unsupported and deferred to P1.
- **Executed-operator receipt:** `DEMAG_SOLVE | PRECONDITIONER` (Krylov) and `DEMAG_SOLVE | DIRECT_SOLVE` (cuDSS)
  mutually exclude each other for both Poisson and FEM/BEM; `llg_time_domain_qualification.cpp` recognizes
  `"direct_solve"` alongside `"preconditioner"`.

(discrete-realization)=
## Discrete realization and residency

1. Setup reads the boundary-conditioned host matrix (`poisson_bc_op` for open Poisson, `periodic_matrix` for
   PBC-reduced Poisson, or `(neumann_op, dirichlet_op)` for FEM/BEM), extracts the sorted lower triangle, and uploads
   it once as 32-bit CSR.
2. cuDSS `CUDSS_PHASE_ANALYSIS` computes $P$ and the symbolic structure of $L$ (for both $u_1$ and $u_2$ in FEM/BEM
   before either factorization starts).
3. Memory preflight reads `CUDSS_DATA_MEMORY_ESTIMATES` (entry 0 stable bytes, entry 1 peak bytes in cuDSS 0.8.0.10),
   queries `cudaMemGetInfo`, evaluates {eq}`eq-direct-memory-budget` (single matrix) or
   {eq}`eq-direct-fem-bem-pair-budget` (atomic FEM/BEM pair), and either proceeds to `CUDSS_PHASE_FACTORIZATION` or
   destroys the analysis handle(s) cleanly.
4. For FEM/BEM, if $u_2$ factorization fails after $u_1$ succeeds, `u1_solver` is immediately destroyed so no partial
   solver pair can ever exist.
5. Each evaluation binds `cudssSetStream` to `workspace.stream_interop.hypre_stream` and executes `CUDSS_PHASE_SOLVE`
   strictly on device-resident RHS/solution buffers inside the `HypreStreamInterop` event fences.
6. Shared multi-block certification (`certify_gpu_hypre_demag_residual` + `fullmag_cuda_demag_validation_norm_pair`)
   computes $r = A\tilde{\phi} - b$ and certifies $\lVert r \rVert_2 / \lVert b \rVert_2 \le \tau_{\mathrm{rel}}$ with
   a single 16-byte scalar readback and one stream synchronization.
7. Under `cudss_direct`, HYPRE Krylov/AMG objects are not constructed, and the 2-step Krylov potential predictor
   (`demag_predictor.hpp`) remains an unallocated zero-overhead no-op.

(implementation-mapping)=
## Implementation mapping

- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::resolve_demag_gpu_solver_strategy` resolves plan
  strategy plus `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER` override fail-closed.
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::resolve_demag_cudss_device_budget` evaluates
  {eq}`eq-direct-memory-budget` combining `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES` and
  `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` via $\min$.
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::check_demag_cudss_factor_fits` checks
  $\hat{M}_{\mathrm{peak}} \le B$ and formats rejection diagnostics.
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::try_initialize_demag_cudss_direct` implements the
  three-state single-matrix strategy resolver (open and PBC-reduced Poisson) with fail-closed `CUDSS_DATA_INFO != 0`.
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::try_initialize_fem_bem_cudss_pair` implements the
  Context-free atomic two-factor preflight {eq}`eq-direct-fem-bem-pair-budget` and factorization for GPU FEM/BEM.
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::create_demag_cudss_direct_solver` and
  `solve_demag_cudss_direct` own direct factor construction and per-stage stream solve execution.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp::initialize_demag_poisson_hypre_device_solver` enables
  PBC-reduced and open Poisson `auto`/`cg_amg`/`cudss` dispatch; `validate_demag_poisson_hypre_device_solve` delegates
  to `certify_gpu_hypre_demag_residual`.
- `backends/fem/gpu/cuda/demag_poisson/poisson.cpp::gpu_demag_poisson_linear_solver` and
  `gpu_demag_linear_solver_provenance` report resolved solver and fallback provenance for both `device_hypre_poisson`
  and `device_hypre_fem_bem`.
- `backends/fem/src/api.cpp::fullmag_fem_backend_create_v6` and
  `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1` (`native/include/fullmag_fem.h`, mirrored in
  `crates/fullmag-fem-sys/src/lib.rs`) pass `gpu_demag_solver_strategy` at creation time and expose full provenance.
- `packages/fullmag-py/src/fullmag/model/discretization.py::class FemLinearSolverPolicy`,
  `crates/fullmag-ir/src/study.rs::FemLinearSolverPolicy`, `crates/fullmag-plan/src/fem.rs::plan_fem`,
  `crates/fullmag-runner/src/native_fem/plan.rs::resolved_native_fem_demag_solver_policy`,
  `crates/fullmag-runner/src/dispatch.rs::apply_native_fem_gpu_demag_linear_solver_provenance`,
  `crates/fullmag-runner/src/types.rs::FemPoissonDemagProvenance`,
  `crates/fullmag-runner/src/types.rs::FemBemDemagProvenance`, and
  `crates/fullmag-runner/src/artifacts.rs::demag_runtime_metadata` propagate `gpu_strategy` and provenance end-to-end.

(validation)=
## Validation

**Plan.**

1. Budget & strategy contract (`backends/fem/tests/cudss_poisson_budget_contract.cpp`): verifies
   `FULLMAG_FEM_DEMAG_CUDSS_MAX_VRAM_MIB` MiB conversion, $\min$ combination with `BUDGET_BYTES`, overflow/malformed
   rejection even under `auto`/`cg_amg`, `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER` precedence, `auto` VRAM fallback vs.
   hard `cudss` refusal, atomic FEM/BEM pair boundary rejection (`peak_1 <= B < stable_1 + peak_2`), atomic cleanup on
   `u2` failure, and fail-closed rejection of singular 3D-PBC pure-Neumann matrices (`CUDSS_DATA_INFO != 0`) under `auto`.
2. Creation-time ABI & PBC contract (`backends/fem/tests/gpu_strict_execution_contract.cpp`): verifies `create_v6`
   ABI validation, `CG_AMG` skipping cuDSS during creation, tight-cap `AUTO` fallback vs. `CUDSS` hard error, malformed
   `MAX_VRAM_MIB` hard failure, and `AUTO` -> `CUDSS_DIRECT` with strict receipts on open Robin, 1D-periodic Robin,
   and 2D-periodic film (pure Neumann + singleton gauge pin).
3. Rust/Python IR, Plan, FFI mirror, and artifact provenance contracts (`crates/fullmag-ir`, `crates/fullmag-plan`,
   `crates/fullmag-fem-sys`, `crates/fullmag-runner`, `packages/fullmag-py/tests/test_api.py`).
4. Phase 2 RTX 4080 SUPER Docker DEV A/B suite (open Poisson 8k/49k, `MAX_VRAM_MIB=32` fallback vs. hard `cudss`,
   GPU FEM/BEM, and PBC-reduced 1D Robin / 2D film).

**Existing baseline runtime results (PR #550, RTX 5050 8 GB, WSL2, 2026-11-23/24; details in
`docs/audits/2026-11-24-fem-gpu-cudss-direct-poc.md`):**

1. Certified relative residual on every direct solve: $\rho \le 2.7\times10^{-15}$ (CG/AMG: up to $5.7\times10^{-9}$).
2. Trajectory agreement after 20 steps: max component difference $\le 4.7\times10^{-10}$ at 14 911, 49 176, and
   89 732 nodes; total energy agreed to $1.4\times10^{-13}$ relative.
3. Step time (mean over steps 2 to $N-1$):

   | Mesh | P2 unknowns | CG/AMG | cuDSS | Factor device memory | Analysis + factorization |
   |---|---:|---:|---:|---:|---:|
   | 14 911 nodes | 117 651 | 463–697 ms | 17.5–20.2 ms | 524 MiB | 2.3–3.3 s |
   | 49 176 nodes | 394 216 | 909 ms | 72.4 ms | 2 300 MiB | 9.3 s |
   | 89 732 nodes | 723 473 | 1 758 ms | 150.0 ms | 5 310 MiB | 21.7 s |

4. Preflight refusal at 4 082 076 rows (7.43 billion estimated factor nonzeros, 59.32 GiB estimated peak vs. 0 B
   remaining budget) stopped cleanly after analysis without starting factorization.
5. Track B P0 extensions (`create_v6`, `auto` VRAM fallback, `MAX_VRAM_MIB`, PBC-reduced `cuDSS`, and FEM/BEM pair)
   are covered by the updated contract tests above; RTX 4080 SUPER Docker DEV execution evidence is collected in Phase 2.

(limitations)=
## Limitations

- Single-GPU, single-process, `FP64` only; multi-GPU and Windows native measurements remain outside current evidence.
- The memory preflight trusts cuDSS's post-analysis `CUDSS_DATA_MEMORY_ESTIMATES` peak estimate; the analysis phase
  itself runs before cuDSS reports an estimate, so an extreme mesh can still exhaust VRAM during symbolic analysis
  before preflight rejects factorization.
- 3D-periodic pure-Neumann Poisson operators without a gauge pin are mathematically singular (`CUDSS_DATA_INFO != 0`)
  and fail closed even under `gpu_strategy="auto"`.
- CUDA Graph capture for RK+`cuDSS` stages is intentionally deferred to P1 due to cuDSS 0.8.0.10 stack-backed H2D
  transfers and host-branched residual certification (`modal_cudss_device_graph.cpp`).

(scientific-bibliography)=
## Bibliography

- A. George, "Nested dissection of a regular finite element mesh", SIAM J. Numer. Anal. 10 (1973) 345–363,
  [doi:10.1137/0710032](https://doi.org/10.1137/0710032).
- T. A. Davis, *Direct Methods for Sparse Linear Systems*, SIAM (2006),
  [doi:10.1137/1.9780898718881](https://doi.org/10.1137/1.9780898718881).
- N. J. Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed., SIAM (2002), chapter 10 (Cholesky
  factorization), [doi:10.1137/1.9780898718027](https://doi.org/10.1137/1.9780898718027).
- [NVIDIA cuDSS documentation](https://docs.nvidia.com/cuda/cudss/), version 0.8.0.10 as installed in the `fem-gpu`
  image (`docker/fem-gpu/Dockerfile`); `CUDSS_DATA_MEMORY_ESTIMATES` layout verified against `examples/cudss_get_set.cpp`.
- Note 0532, [note 0913](0913-fem-gpu-amg-coarse-residency.md), the [canonical Poisson note](fem_demag_poisson.md),
  and the [FEM/BEM note](fem_demag_fem_bem.md) own the public solver policy, AMG coarse residency, and shared physics.

(source-code-index)=
## Source-code index

| Path | Symbol | Responsibility | Lane and evidence |
|---|---|---|---|
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `resolve_demag_gpu_solver_strategy` | Resolves plan `gpu_strategy` and `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER` override | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `parse_positive_uint64_env` | Validates byte and MiB VRAM budget cap environment variables for {eq}`eq-direct-memory-budget` | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `check_demag_cudss_factor_fits` | Checks $\hat{M}_{\mathrm{peak}} \le B$ and writes over-budget diagnostics | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `try_initialize_demag_cudss_direct` | Three-state single-matrix cuDSS resolver (open & PBC-reduced Poisson, fail-closed non-SPD) | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `try_initialize_fem_bem_cudss_pair` | Context-free atomic two-factor preflight {eq}`eq-direct-fem-bem-pair-budget` for FEM/BEM `(u1, u2)` | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `create_demag_cudss_direct_solver` | Lower CSR, analysis, memory preflight, factorization, status and device bytes | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `solve_demag_cudss_direct` | Triangular solve phase on `hypre_stream` with device-resident RHS and solution | FEM GPU; runtime evidence |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `initialize_demag_poisson_hypre_device_solver` | Open and PBC-reduced Poisson three-state solver setup | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `validate_demag_poisson_hypre_device_solve` | Independent residual certification via shared multi-block `certify_gpu_hypre_demag_residual` | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/poisson.cpp` | `gpu_demag_poisson_linear_solver` | Reports resolved linear solver for Poisson and FEM/BEM workspaces | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/poisson.cpp` | `gpu_demag_linear_solver_provenance` | Reads strategy, resolved solver, fallback reason, and VRAM metrics | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` | `compute_device_demag_for_device_stage_impl` | Applies demag solve between `HypreStreamInterop` event fences | FEM GPU; existing owner |
| `backends/fem/gpu/cuda/demag_poisson/operators.cpp` | `build_p1_demag_operators` | Builds open and periodic-reduced Poisson operators | FEM GPU; existing owner |
| `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` | `gpu_rk_required_operator_mask` | Derives required `DIRECT_SOLVE` vs `PRECONDITIONER` bit from resolved solver | FEM GPU; contract test |
| `backends/fem/gpu/cuda/runtime/execution_receipt.cpp` | `plan_masks_are_valid` | Rejects conflicting or orphan linear-solve bits | FEM GPU; contract test |
| `backends/fem/gpu/frequency_domain/modal_cudss_device_graph.cpp` | `CudssDeviceGraph` | Evidence for P1 non-goal deferral of RK+cuDSS CUDA Graph capture | FEM GPU; design audit |
| `backends/fem/src/api.cpp` | `fullmag_fem_backend_create_v6` | Creation-time C ABI delivering `gpu_demag_solver_strategy` before demag init | FEM GPU; contract test |
| `backends/fem/src/api.cpp` | `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1` | C ABI query returning strategy, resolved solver, fallback reason, and VRAM stats | FEM GPU; contract test |
| `native/include/fullmag_fem.h` | `fullmag_fem_backend_create_v6` | Public C ABI declaration of `create_v6`, `plan_desc_v5`, strategy/fallback enums, and provenance query | FEM GPU; ABI |
| `crates/fullmag-fem-sys/src/lib.rs` | `fullmag_fem_plan_desc_v5` | Rust FFI mirror of `plan_desc_v5`, `create_v6`, strategy/fallback enums, and provenance | FEM GPU; layout & mirror tests |
| `crates/fullmag-runner/src/native_fem/runtime_info.rs` | `NativeFemGpuDemagLinearSolverProvenance` | Rust provenance parser and C-header constant mirror verification | FEM GPU; unit test |
| `crates/fullmag-runner/src/native_fem/plan.rs` | `resolved_native_fem_demag_solver_policy` | Resolves FEM demag policy with unified `"AMG"` default for GPU Poisson and FEM/BEM | FEM GPU; unit test |
| `crates/fullmag-runner/src/dispatch.rs` | `apply_native_fem_gpu_demag_linear_solver_provenance` | Writes strategy, resolved solver, and fallback reason into Poisson and FEM/BEM provenance | FEM GPU; unit test |
| `crates/fullmag-runner/src/types.rs` | `FemPoissonDemagProvenance` | Poisson demag requested policy, GPU strategy, resolved solver, and fallback reason | FEM; unit test |
| `crates/fullmag-runner/src/types.rs` | `FemBemDemagProvenance` | FEM/BEM demag operator telemetry plus GPU strategy, resolved solver, and fallback reason | FEM; unit test |
| `crates/fullmag-runner/src/artifacts.rs` | `demag_runtime_metadata` | Publishes `requested_linear_solver_strategy`, `resolved_linear_solver`, and `linear_solver_fallback_reason` | FEM; unit test |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Public Python policy with `gpu_strategy` validation and `to_ir()` serialization | FEM CPU/GPU; unit test |
| `crates/fullmag-ir/src/study.rs` | `FemLinearSolverPolicy` | Canonical `ProblemIR` policy struct with backward-compatible `gpu_strategy` default | FEM; unit test |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | Validates `gpu_strategy` and lowers policy to `FemPlanIR` | FEM; unit test |
