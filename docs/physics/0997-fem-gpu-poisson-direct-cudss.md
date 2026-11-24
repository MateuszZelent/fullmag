# FEM GPU. Factor-once direct solve of the Poisson demag system (cuDSS, proof of concept)

Status `proof of concept / experimental opt-in / unqualified`. Branch `codex/fem-gpu-cudss-direct-poisson-20261124`
(PR #550). The realization is off unless the runtime environment requests it; without the request every run follows
the existing CG/AMG path unchanged.

(problem-statement)=
## Scope

This note covers one numerical realization of the strict FEM GPU Poisson demag owner `device_hypre_poisson`: the
linear system is solved by a sparse Cholesky factorization computed once per operator, instead of preconditioned
conjugate gradients at every evaluation. The demag model, its boundary conditions and the P1 discretization belong
to the [canonical Poisson description](fem_demag_poisson.md); the public solver policy belongs to
[note 0532](0532-fem-demag-solver-policy-and-runtime-threading.md). The motivation is measured in
`docs/audits/2026-11-24-fem-gpu-cudss-direct-poc.md`: at 49 176 nodes, 98.5 % of a Heun step is the hypre PCG
call, which is paced by host-side launches and synchronizations while the GPU stays under 1 % busy.

| Realization | Scope of this note | Evidence |
|---|---|---|
| FEM CPU | Not changed; MFEM/hypre CG with the existing preconditioners | Source unchanged |
| FEM GPU | Opt-in cuDSS factor-once solve in `device_hypre_poisson` | Runtime A/B measurements in the validation section |
| FDM CPU | Not applicable | FDM computes demag by FFT convolution, not by this Poisson system |
| FDM GPU | Not applicable | FDM computes demag by FFT convolution, not by this Poisson system |

(governing-equations)=
## Equations

The Poisson demag owner solves one linear system per field evaluation:

```{math}
:label: eq-direct-system
K\phi = b
```

The matrix does not change during a run: it depends on the mesh and the boundary conditions only, while the right-hand
side follows the magnetization. The realization factors a symmetric permutation of the matrix once and then applies
two triangular solves per evaluation:

```{math}
:label: eq-direct-factorization
P K P^{\mathsf T} = L L^{\mathsf T},\qquad
L y = P b,\qquad
L^{\mathsf T}\left(P\tilde{\phi}\right) = y
```

Every computed solution is certified with the existing independent residual check, the same one that certifies CG
results today:

```{math}
:label: eq-direct-residual
r = b - K\tilde{\phi},\qquad
\rho = \frac{\lVert r\rVert_2}{\lVert b\rVert_2} \le \tau_{\mathrm{rel}}
```

The factorization starts only when the device-memory peak that cuDSS estimates in the analysis phase fits a device
budget derived from the free device memory at that moment:

```{math}
:label: eq-direct-memory-budget
M_{\mathrm{margin}} = \max\left(M_{0},\ \frac{M_{\mathrm{total}}}{20}\right),\qquad
B = \min\left(M_{\mathrm{free}} - M_{\mathrm{margin}},\ B_{\mathrm{cap}}\right),\qquad
\hat{M}_{\mathrm{peak}} \le B
```

The budget is a resource check, not physics: it does not change $\tilde{\phi}$. It only decides whether the
factorization is attempted.

(symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
|---|---|---|
| $K$ | Poisson system matrix: P1 stiffness plus Robin boundary mass, after essential-condition elimination | $\mathrm{m}$ |
| $\phi$ | Exact vector of nodal scalar-potential coefficients | $\mathrm{A}$ |
| $\tilde{\phi}$ | Computed vector of nodal scalar-potential coefficients | $\mathrm{A}$ |
| $b$ | Right-hand side vector built from the magnetization | $\mathrm{A\,m}$ |
| $P$ | Fill-reducing symmetric permutation chosen in the analysis phase | $1$ |
| $L$ | Lower-triangular Cholesky factor of the permuted matrix | $\mathrm{m^{1/2}}$ |
| $y$ | Intermediate vector of the forward substitution | $\mathrm{A\,m^{1/2}}$ |
| $r$ | Algebraic residual of the computed solution | $\mathrm{A\,m}$ |
| $\rho$ | Relative Euclidean residual | $1$ |
| $\tau_{\mathrm{rel}}$ | Relative residual tolerance from the solver policy | $1$ |
| $M_{\mathrm{free}}$ | Free device memory reported by `cudaMemGetInfo` after the analysis phase | $\mathrm{B}$ (byte) |
| $M_{\mathrm{total}}$ | Total device memory reported by `cudaMemGetInfo` | $\mathrm{B}$ (byte) |
| $M_{0}$ | Minimum safety margin, $536\,870\,912$ bytes (512 MiB) | $\mathrm{B}$ (byte) |
| $M_{\mathrm{margin}}$ | Safety margin kept free for the rest of the run, the display and allocator fragmentation | $\mathrm{B}$ (byte) |
| $B_{\mathrm{cap}}$ | Optional diagnostic cap on the budget; $+\infty$ when not set | $\mathrm{B}$ (byte) |
| $B$ | Device budget for the cuDSS factorization and solve phases | $\mathrm{B}$ (byte) |
| $\hat{M}_{\mathrm{peak}}$ | Device peak estimated by cuDSS after analysis (`CUDSS_DATA_MEMORY_ESTIMATES`, entry 1) | $\mathrm{B}$ (byte) |

(assumptions-and-validity)=
## Assumptions and validity

- The matrix $K$ must be symmetric positive definite. That holds for the Robin and Dirichlet realizations, where the
  boundary term or the eliminated rows remove the constant null space. A pure Neumann matrix is singular; its
  factorization reports a nonzero `CUDSS_DATA_INFO` and the run stops with an error instead of producing a field.
- Real double precision only, one GPU, one process. The periodic reduced operator and the FEM/BEM realization are
  outside this proof of concept and are rejected at setup.
- The factor memory grows faster than the mesh. The demag accuracy contract uses a P2 potential, about 7.9 unknowns
  per mesh node: at 14 911 nodes the system has 117 651 unknowns, 1 736 229 stored lower-triangle entries and a factor
  with 46 474 450 nonzeros that takes 524 MiB of device memory. Larger meshes are reported in the validation section.
  A factor whose estimated device peak does not fit the budget of {eq}`eq-direct-memory-budget` is rejected after
  the analysis phase, before the factorization starts. There is no automatic fallback to CG/AMG: the explicit request
  fails with an error that names the estimate and the budget.
- The budget relies on the cuDSS estimate. Allocations that cuDSS makes beyond its estimate, and later allocations of
  the run, are covered only by $M_{\mathrm{margin}}$. Under WSL2 the WDDM driver does not fail an allocation beyond
  dedicated memory; it pages it to host memory. Before the preflight, a P2 film with 4 082 076 rows and a factor of
  $7.43\times10^{9}$ nonzeros spent 1 596 s in the factorization on an 8 GB RTX 5050 this way.
- Cholesky with any symmetric permutation is backward stable for symmetric positive definite matrices, so the
  computed $\tilde{\phi}$ is the exact solution of a nearby system; the residual check of
  {eq}`eq-direct-residual` measures that directly for every solve.

(python-api)=
## Python API

The public API does not change. The study below is the executed measurement case
(`scripts/benchmarks/fem_memory_transfer_case.py` at `FEM_CASE_HMAX=2.5e-9`); it requests CG/AMG as before. The
experimental realization is selected only by the environment of the process that runs the study:
`FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER=cudss`. That variable is a runtime override for this proof of concept, not a
public parameter, and it is not part of `ProblemIR`.

```python
# %% Study, engine, device and mode
import fullmag as fm

study = fm.study("fem_gpu_poisson_direct_poc")
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

# %% Interactions and the public demag solver policy (requested intent)
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG")
study.b_ext(0.0, 0.0, 10e-3)
study.build_domain_mesh()

# %% Dynamics
study.solver(fix_dt=2e-14, integrator="heun")
study.run(20 * 2e-14)
```

The policy parameters below keep their meaning. With the override active they still form the requested intent, and
$\tau_{\mathrm{rel}}$ and `max_iterations` still bound the certified result.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| FemLinearSolverPolicy.solver | str | CG | 1 | CG or GMRES | Outer iterative method of the requested intent | FEM CPU/GPU | fem.demag_solver_policy.solver |
| FemLinearSolverPolicy.preconditioner | str | AMG | 1 | AMG, JACOBI or NONE | Preconditioner of the requested intent; unused under the cuDSS override | FEM CPU/GPU | fem.demag_solver_policy.preconditioner |
| FemLinearSolverPolicy.rtol | float | 1e-8 | 1 | positive finite value | Relative residual tolerance that certifies every solve | FEM CPU/GPU | fem.demag_solver_policy.rtol |
| FemLinearSolverPolicy.atol | float \| None | None | $\mathrm{A\,m}$ | None or positive finite value | Optional absolute residual tolerance | FEM CPU/GPU | fem.demag_solver_policy.atol |
| FemLinearSolverPolicy.max_iterations | int | 500 | 1 | at least 1 | Iteration limit; the direct solve reports one iteration | FEM CPU/GPU | fem.demag_solver_policy.max_iterations |
| FemLinearSolverPolicy.print_level | int | 0 | 1 | non-negative | Linear-solver diagnostics level | FEM CPU/GPU | fem.demag_solver_policy.print_level |

(problem-ir)=
## ProblemIR

The canonical fragment comes from `fm.FemLinearSolverPolicy(solver="CG", preconditioner="AMG").to_ir()` and lands in
`FemHintsIR.demag_solver_policy`, then in the resolved `FemPlanIR.demag_solver_policy`:

```json
{"solver": "CG", "preconditioner": "AMG", "rtol": 1e-08, "max_iterations": 500, "print_level": 0}
```

The override adds nothing to `ProblemIR` and nothing to the plan. Two runs of the same script with and without the
variable have identical `ProblemIR` and plan; they differ only in the native realization.

(round-trip-and-failure-semantics)=
## Round trip and failure semantics

- **Requested intent** is the public policy above, exported and re-imported unchanged by the script round trip.
- **Resolved execution** is the native realization, read back from the initialized device Poisson workspace, not
  from the environment:
  - **Provenance.** `execution_provenance.fem_poisson_demag.resolved_linear_solver` is `cudss_direct` for the
    factor-once solve and `hypre_krylov` for the HYPRE Krylov solve of the policy. The neighbouring fields
    `linear_solver`, `preconditioner`, `rtol` and `max_iterations` keep the requested policy. The field is written
    only on the native FEM GPU lane with the `device_hypre_poisson` owner; FEM CPU, FEM/BEM and the explicit hybrid
    CPU-Poisson mode leave it out. The demag runtime metadata of the artifacts repeats it as
    `resolved_linear_solver`; under `cudss_direct` it reports `runtime_solver = CudssDirect`, no
    `runtime_preconditioner` and no `amg_profile`, and the AMG fields of the step statistics are zero.
  - **Executed-operator receipt.** The required operator mask follows the resolved realization, not the requested
    policy. The Krylov solve requires `DEMAG_SOLVE | PRECONDITIONER`; the cuDSS solve requires
    `DEMAG_SOLVE | DIRECT_SOLVE`, where `DIRECT_SOLVE` is bit 12 (`FULLMAG_FEM_GPU_OPERATOR_DIRECT_SOLVE`) and means
    "the linear solve applied a sparse direct factorization; no Krylov iteration and no preconditioner ran". The two
    bits exclude each other, and `DIRECT_SOLVE` requires `DEMAG_SOLVE`; the native plan check and the Rust receipt
    parser reject any other combination. The time-integration and the PG-BB/NCG relaxation receipts derive their
    required mask from the same planner, so both carry the resolved bit.
  - **Diagnostics.** Setup prints one line to standard error (`fullmag: FEM GPU Poisson demag uses the cuDSS direct
    solve ...` with rows, factor nonzeros, the estimated device peak, the budget, device bytes and phase times),
    every solve reports one iteration, and the AMG coarse-relax getter reports no AMG.
- **Validation errors**: a factorization with `CUDSS_DATA_INFO` different from zero (matrix not positive definite), a
  cuDSS or CUDA status other than success, a non-square or empty matrix, a missing diagonal entry, or a residual that
  fails {eq}`eq-direct-residual` stop the run with a message naming the step. The memory preflight adds three setup
  errors: a failed or empty `CUDSS_DATA_MEMORY_ESTIMATES` query; a malformed
  `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES`; and an estimated peak above the budget of
  {eq}`eq-direct-memory-budget`. The last message names the estimated peak, the budget with its free memory and
  margin, the rows and the estimated factor nonzeros, and states that the factorization was not started.
- **Unsupported combinations**: the override with the periodic reduced operator is rejected at setup, and a build
  without cuDSS rejects the override at setup. FEM/BEM, the explicit hybrid CPU-Poisson mode and FEM CPU do not read
  the override and run their own solver; FDM has no Poisson system. The FEM LLG time-domain qualification tool
  accepts only the Krylov operator vocabulary, so a cuDSS run is not qualified there.

(discrete-realization)=
## Discrete realization and residency

1. Setup reads the boundary-conditioned host matrix (`poisson_bc_op`), keeps the lower triangle, sorts each row by
   column and uploads it once as 32-bit CSR.
2. cuDSS analysis chooses $P$ and the symbolic structure of $L$.
3. Memory preflight. After the analysis, setup reads `CUDSS_DATA_MEMORY_ESTIMATES`, an array of 16 `int64_t`
   values. In cuDSS 0.8.0.10 entries 0 and 1 are the stable and peak device bytes, entries 2 and 3 the stable and
   peak host bytes, and entries 4 and 5 the hybrid-mode peaks (the meaning is taken from the shipped example
   `examples/cudss_get_set.cpp`; the header gives no comment). The device peak is $\hat{M}_{\mathrm{peak}}$. Setup
   then reads $M_{\mathrm{free}}$ and $M_{\mathrm{total}}$ with `cudaMemGetInfo` and evaluates
   {eq}`eq-direct-memory-budget`:
   - $M_{\mathrm{free}}$ is measured after the CSR upload and the analysis, so a peak estimate that already counts
     those allocations is counted twice; the check errs on the safe side.
   - $M_{0}$ = 512 MiB, or 5 % of the device memory when that is larger, is kept free for later allocations of the
     run, the display on a WDDM device and allocator fragmentation.
   - $B_{\mathrm{cap}}$ comes from `FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER_DEVICE_BUDGET_BYTES`, a positive integer of
     bytes. It can only lower the budget. It is a diagnostic and test knob of this proof of concept, not a public
     parameter and not part of `ProblemIR`.
   - If $\hat{M}_{\mathrm{peak}} > B$, setup stops with the error described above; the factorization is not called.
4. The factorization computes $L$ in device memory. Analysis and factorization run once per operator. The factor
   device bytes are added to the Poisson workspace accounting.
5. Each evaluation runs only the solve phase on the hypre stream, inside the same event fences that order the CG
   solve today. The right-hand side and the solution are the existing device buffers; nothing is copied to the host.
6. The existing independent residual check (RHS norm, matvec, AXPY, residual norm) then certifies the result against
   $\tau_{\mathrm{rel}}$.
7. The device Poisson workspace reports its realization (`hypre_krylov` or `cudss_direct`) to the GPU planner, which
   builds the required operator mask from it, and to the C ABI query that fills the provenance field.

The hypre PCG and AMG objects are not created under the override, which also removes the AMG hierarchy from device
memory.

(implementation-mapping)=
## Implementation mapping

- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::demag_gpu_direct_solver_requested` reads the override.
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::create_demag_cudss_direct_solver` builds the sorted
  lower CSR, runs analysis, the memory preflight and the factorization, checks the factorization status and
  measures device bytes.
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::resolve_demag_cudss_device_budget` evaluates the
  budget $B$ of {eq}`eq-direct-memory-budget` from $M_{\mathrm{free}}$, $M_{\mathrm{total}}$ and the optional cap;
  `check_demag_cudss_factor_fits` compares $\hat{M}_{\mathrm{peak}}$ with $B$ and writes the error.
- `backends/fem/gpu/cuda/demag_poisson/poisson.cpp::gpu_demag_poisson_linear_solver` reports the realization of the
  initialized workspace; `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp::gpu_rk_required_operator_mask` builds the
  required mask from it, and `backends/fem/gpu/cuda/runtime/execution_receipt.cpp::plan_masks_are_valid` rejects
  conflicting linear-solve bits.
- `backends/fem/src/api.cpp::fullmag_fem_backend_get_gpu_demag_linear_solver_v1` exposes the realization through the
  C ABI (`native/include/fullmag_fem.h`, mirrored in `crates/fullmag-fem-sys/src/lib.rs`); the runner records it in
  `FemPoissonDemagProvenance` (`crates/fullmag-runner/src/types.rs`).
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::solve_demag_cudss_direct` runs the solve phase on a
  given stream with the device right-hand side and solution.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp::initialize_demag_poisson_hypre_device_solver` selects
  the realization at setup.
- `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp::compute_device_demag_for_device_stage_impl` applies it.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp::validate_demag_poisson_hypre_device_solve` certifies
  the residual.

(validation)=
## Validation

**Plan.** The same build runs both realizations, selected only by the environment variable.

1. Default path unchanged: the baseline `m_final` of the new build must be bit-identical to the baseline runs of the
   previous build at the same mesh.
2. For every solve, the certified relative residual of the direct solve must satisfy {eq}`eq-direct-residual`.
3. Trajectory agreement: the difference of `m_final` between the two realizations must stay at the scale of the CG
   tolerance (at most $10^{-8}$ in any component after the measured steps).
4. Timing: mean step time over steps 2 to N−1 at 14 911, 49 176 and 89 732 nodes, with interleaved runs.
5. Memory: device peak and host peak with both realizations.
6. Receipt and provenance (review of PR #550): contract tests for both required masks, for the rejection of
   conflicting bits and for the provenance field; two strict 50-step PG-BB relaxations of the prism film mesh
   (`scripts/benchmarks/relax_film_compare_case.py`, 36 576 nodes) with and without the override must pass the strict
   receipt with distinct masks and record `hypre_krylov` and `cudss_direct`.
7. Memory preflight: a contract test with a small SPD matrix that factors within the budget and is rejected after
   analysis under a 1-byte cap; and the tetrahedral film mesh (4 082 076 rows) with the override, which must stop
   right after the analysis with the budget error instead of factorizing.

**Results** (RTX 5050 8 GB, WSL2, measured on the same change applied to master `dbd7550dc`, 2026-11-23/24; details in
`docs/audits/2026-11-24-fem-gpu-cudss-direct-poc.md`):

1. The default path of the new build gave an `m_final` bit-identical to the previous build at 49 176 nodes.
2. Every direct solve was certified at $\rho \le 2.7\times10^{-15}$ (CG/AMG: up to $5.7\times10^{-9}$).
3. After 20 steps the largest component difference of `m_final` against CG/AMG was $2.8\times10^{-10}$,
   $4.7\times10^{-10}$ and $4.0\times10^{-10}$ at 14 911, 49 176 and 89 732 nodes; the total energy agreed to
   $1.4\times10^{-13}$ relative. After 500 steps at 14 911 nodes the total and demag energies differed by
   $3.4\times10^{-9}$ and $2.2\times10^{-8}$ relative, the scale of the CG tolerance.
4. Step time (mean over steps 2 to N−1):

   | Mesh | P2 unknowns | CG/AMG | cuDSS | Factor device memory | Analysis + factorization |
   |---|---:|---:|---:|---:|---:|
   | 14 911 nodes | 117 651 | 463–697 ms (three runs) | 17.5–20.2 ms | 524 MiB | 2.3–3.3 s |
   | 49 176 nodes | 394 216 | 909 ms (three runs) | 72.4 ms (three runs) | 2 300 MiB | 9.3 s |
   | 89 732 nodes | 723 473 | 1 758 ms | 150.0 ms | 5 310 MiB | 21.7 s |

5. At 199 457 nodes (1 620 071 unknowns) the factor has $1.66\times10^{9}$ nonzeros, more than the 8 GB card
   holds. The run did not fail: under WSL2 the device allocation spilled beyond dedicated memory, analysis and
   factorization took 325 s and a step 3.1 s. That measurement predates the memory preflight, which now rejects such
   a factor after the analysis (item 7); it does not resolve the case to CG/AMG.

**Results of the PR #550 review checks** (2026-11-24, RTX 5050 8 GB, WSL2, inside the DEV backend container):

6. Receipt and provenance. Contract tests pass: `fem_gpu_execution_receipt_contract` (the Krylov and direct
   relaxation receipts commit as `0x70f` and `0x150f`; a direct solve under a Krylov plan, both bits together, and
   `DIRECT_SOLVE` without `DEMAG_SOLVE` fail closed), `fem_gpu_strict_execution_contract` (the planner requires the
   bit of the realization the workspace reports, both plans pass strict validation, the ABI query returns the same
   value and `UNAVAILABLE` for hybrid CPU Poisson), and the `fullmag-runner` tests for the receipt parser, the header
   mirror, the provenance field and the demag runtime metadata. With the managed package built from `2af98abd3`, two strict 50-step relaxations of the prism film mesh
   (36 576 nodes) pass: CG/AMG commits required and executed masks `0x70f` with `resolved_linear_solver`
   `hypre_krylov` (`runtime_solver=HyprePCG`); cuDSS commits `0x150f` with `cudss_direct` (`runtime_solver=CudssDirect`).
   The CG/AMG table at step 50 is bit-identical to the run before this change; the cuDSS table differs from its
   earlier run by at most $2\times10^{-11}$ relative (factorization round-off).
7. Memory preflight. `fem_cudss_poisson_budget_contract` passes: a 200-row SPD matrix factors within the budget
   (estimated peak 437 884 bytes) and solves to $1.2\times10^{-11}$, and a 1-byte cap rejects it after the analysis,
   before the factorization. The tetrahedral film (4 082 076 rows, two steps, with the override) was run as a
   diagnostic with the package `fullmag-bin` of `83376a9b6` and the native library built from this change in the
   same container, not with a managed package. It stopped after an analysis of 90.1 s, 408 s after the start of the
   process including meshing, with:
   `cuDSS Poisson demag factorization needs an estimated device peak of 59.32 GiB (63693684940 bytes), above the
   device budget of 0.00 GiB (0 bytes) (free device memory after analysis 0.00 GiB (0 bytes) minus a margin of
   0.50 GiB (536870912 bytes)); rows=4082076, estimated factor nonzeros=7426605875. The factorization was not
   started.` The estimated factor nonzeros match the $7.43\times10^{9}$ measured before. After the analysis
   `cudaMemGetInfo` reported no free device memory; device memory use peaked 6 043 MiB above the baseline
   (`nvidia-smi`, 5 s samples) and the process tree peaked at 22.8 GB of host memory.
   The same case with the managed package (4 089 322 rows after remeshing) stopped with the same error after 600 s
   including meshing. The 89 732-node, 723 115-row case of the earlier measurements still runs with cuDSS: estimated
   device peak 5 079 730 404 bytes against a budget of 5 276 434 432 bytes, 20 strict LLG steps, receipt `0x11df`.

(limitations)=
## Limitations

- Proof of concept: no managed qualification, no standard-problem comparison, no Windows or multi-GPU evidence.
- The realization is still selected by an environment variable, outside `ProblemIR`; the provenance field records
  what ran, but the request itself is not part of the requested intent.
- No size-based selection: a request whose factor does not fit fails after the analysis; it does not resolve to
  CG/AMG. Very large meshes still need the default path.
- The memory budget trusts the cuDSS peak estimate; the margin is a fixed rule, not a measured bound for every device
  and driver.
- The analysis phase itself is not budgeted, because cuDSS gives no estimate before it. On the 4 082 076-row film no
  device memory was free after the analysis, so an analysis that oversubscribes the device can still be paged by
  WDDM before the preflight rejects the factor.
- The periodic reduced operator and FEM/BEM are excluded; the hybrid CPU-Poisson mode ignores the override.

(scientific-bibliography)=
## Bibliography

- A. George, "Nested dissection of a regular finite element mesh", SIAM J. Numer. Anal. 10 (1973) 345–363,
  [doi:10.1137/0710032](https://doi.org/10.1137/0710032).
- T. A. Davis, *Direct Methods for Sparse Linear Systems*, SIAM (2006),
  [doi:10.1137/1.9780898718881](https://doi.org/10.1137/1.9780898718881).
- N. J. Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed., SIAM (2002), chapter 10 (Cholesky
  factorization), [doi:10.1137/1.9780898718027](https://doi.org/10.1137/1.9780898718027).
- [NVIDIA cuDSS documentation](https://docs.nvidia.com/cuda/cudss/), version 0.8.0.10 as installed in the `fem-gpu`
  image (`docker/fem-gpu/Dockerfile`); the layout of `CUDSS_DATA_MEMORY_ESTIMATES` is taken from the shipped example
  `examples/cudss_get_set.cpp` of that version.
- Note 0532 and the canonical Poisson description own the public policy and the shared physics; note 0913 documents
  the CG/AMG coarse-level residency that this realization replaces under the override.

(source-code-index)=
## Source-code index

| Path | Symbol | Responsibility | Lane and evidence |
|---|---|---|---|
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `demag_gpu_direct_solver_requested` | Reads the opt-in override | FEM GPU; proof of concept |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `create_demag_cudss_direct_solver` | Lower CSR, analysis, factorization, status and memory | FEM GPU; proof of concept |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `solve_demag_cudss_direct` | Solve phase on the hypre stream | FEM GPU; proof of concept |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `resolve_demag_cudss_device_budget` | Device budget of {eq}`eq-direct-memory-budget` and the cap | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `check_demag_cudss_factor_fits` | Compares the estimated peak with the budget; rejection message | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/poisson.cpp` | `gpu_demag_poisson_linear_solver` | Reports the resolved realization of the device workspace | FEM GPU; contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` | `gpu_rk_required_operator_mask` | Required mask with the resolved linear-solve bit | FEM GPU; contract test |
| `backends/fem/gpu/cuda/runtime/execution_receipt.cpp` | `plan_masks_are_valid` | Rejects conflicting or orphan linear-solve bits | FEM GPU; contract test |
| `backends/fem/src/api.cpp` | `fullmag_fem_backend_get_gpu_demag_linear_solver_v1` | C ABI query of the resolved realization | FEM GPU; contract test |
| `native/include/fullmag_fem.h` | `fullmag_fem_backend_get_gpu_demag_linear_solver_v1` | Public declaration, `DIRECT_SOLVE` bit and realization values | FEM GPU; ABI |
| `crates/fullmag-fem-sys/src/lib.rs` | `FULLMAG_FEM_GPU_OPERATOR_DIRECT_SOLVE` | Rust mirror of the bit and the realization values | FEM GPU; mirror test |
| `crates/fullmag-runner/src/native_fem/runtime_info.rs` | `linear_solve_operator_bits_are_consistent` | Rust receipt parser rejects conflicting bits | FEM GPU; unit test |
| `crates/fullmag-runner/src/dispatch.rs` | `apply_native_fem_gpu_demag_linear_solver` | Writes `resolved_linear_solver` into run provenance | FEM GPU; runtime evidence |
| `crates/fullmag-runner/src/types.rs` | `FemPoissonDemagProvenance` | Requested policy and resolved realization in provenance | FEM; unit test |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `initialize_demag_poisson_hypre_device_solver` | Realization selection at setup | FEM GPU; existing owner |
| `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` | `compute_device_demag_for_device_stage_impl` | Applies the solve between the stream fences | FEM GPU; existing owner |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `validate_demag_poisson_hypre_device_solve` | Independent residual certification | FEM GPU; existing check |
| `backends/fem/gpu/cuda/demag_poisson/operators.cpp` | `build_p1_demag_operators` | Builds the Poisson operators | FEM GPU; existing owner |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Public policy, defaults and validation | FEM CPU/GPU; unchanged |
| `crates/fullmag-ir/src/mesh_hints.rs` | `FemHintsIR` | Optional FEM policy in canonical ProblemIR | FEM; unchanged |
| `crates/fullmag-ir/src/plan.rs` | `FemPlanIR` | Resolved policy passed to native execution | FEM; unchanged |
