# FEM GPU. Explicit Runge-Kutta FSAL `k0` reuse and two-step linear potential predictor

Status `implemented / contract-tested / pending Phase 2 GPU qualification`. This note specifies two numerical
realization optimizations inside the strict device-resident FEM GPU explicit Runge-Kutta time stepper
(`device_hypre_poisson` and explicit RK integrators):

1. Extending First-Same-As-Last (FSAL) initial-stage derivative reuse (`k[0]`) from RK23/RK45 to fixed-step
   **Heun** (`3 -> 2` RHS and demag evaluations per accepted step, $-33.3\%$) and **RK4** (`5 -> 4`, $-20.0\%$),
   while strictly separating `fsal_k0_reuse` from the RK23/RK45 `endpoint_rhs_shortcut` optimization.
2. Adding a two-step linear temporal scalar-potential predictor $\phi^{(0)}(t_{\mathrm{eval}})$ for HYPRE Krylov
   (CG/GMRES + BoomerAMG/Jacobi) warm starts on strictly advancing RK stages, with an equal-stage-time guard and
   zero-overhead no-op semantics under cuDSS direct solves.

(problem-statement)=
## Scope

The governing Landau-Lifshitz-Gilbert equation, explicit Runge-Kutta tableaux, and Poisson magnetostatic
formulation belong to their canonical physics descriptions (`fem_demag_poisson.md`,
`0532-fem-demag-solver-policy-and-runtime-threading.md`, and `0997-fem-gpu-poisson-direct-cudss.md`). This note
documents only the device-resident FEM GPU time-stepping realization differences:

1. At the end of every accepted explicit RK step, `rk_final_refresh.cu` refreshes the authoritative effective field
   and LLG right-hand side $f(m_{n+1}, t_{n+1})$ after final normalization, periodic projection, and frozen-spin
   projection so observables, step metrics, and the final `max_rhs` reduction reflect the accepted endpoint. Reusing
   that already-computed endpoint derivative as the next step's initial slope $k_0 = f(m_{n+1}, t_{n+1})$ eliminates
   one redundant RHS and demag evaluation per step for Heun and RK4 with zero mathematical approximation.
2. When the GPU Poisson demag owner executes via HYPRE Krylov (`resolved_linear_solver = hypre_krylov`), each RK
   stage solves $K\phi = b(m)$ iteratively. Replacing the constant warm start $\phi_n$ with a two-step linear
   extrapolation $\phi^{(0)}(t_{\mathrm{eval}})$ reduces the initial Krylov residual from $O(\Delta t)$ to
   $O(\Delta t^2)$ on smooth trajectories without altering the converged certified solution.

| Realization | Scope of this note | Evidence |
|---|---|---|
| FEM CPU | Unchanged; keeps existing RK23/RK45 FSAL and CPU MFEM/HYPRE warm-start behavior | Source unchanged |
| FEM GPU | FSAL `k0` reuse for Heun/RK4/RK23/RK45, separated `endpoint_rhs_shortcut` for RK23/RK45, and Krylov-only two-step linear predictor $\phi^{(0)}$ in `device_hypre_poisson` | Unit and CUDA/MFEM contract tests (`cuda_rk_heun_rk4_fsal_predictor_contract.cpp`, `cuda_rk_guard_contract.cpp`, `source_facade_gpu_rk_contract.cpp`, `parity.rs`); RTX 4080 SUPER A/B runs scheduled in Phase 2 |
| FDM CPU | Not applicable | FDM uses FFT convolution demag and its own explicit time-stepping pipeline, not MFEM/HYPRE FEM Poisson |
| FDM GPU | Not applicable | FDM uses FFT convolution demag and its own explicit time-stepping pipeline, not MFEM/HYPRE FEM Poisson |

(governing-equations)=
## Equations

For an accepted explicit RK step advancing normalized magnetization from $(m_n, t_n)$ to
$(m_{n+1}, t_{n+1})$ with $t_{n+1} = t_n + \Delta t_n$, the post-projection final refresh evaluates the
authoritative endpoint LLG derivative:

```{math}
:label: eq-rk-fsal-k0-reuse
k_0^{(n+1)} = f\!\left(m_{n+1},\, t_{n+1}\right)
\quad \text{iff} \quad
t_{\mathrm{fsal}} = t_{n+1}
\;\land\;
\Sigma_{\mathrm{fsal}} = \Sigma(t_{n+1})
\;\land\;
\mathcal{A}_{\mathrm{k0}} = 1
```

The endpoint-RHS shortcut (skipping the post-accept refresh evaluation by consuming the last tableau stage
$k_3$ of BS23 or $k_6$ of DP54) obeys a strictly narrower eligibility predicate because frozen-spin and
periodic projections may alter the post-stage endpoint before final acceptance:

```{math}
:label: eq-rk-endpoint-shortcut-gate
\mathcal{A}_{\mathrm{ep}} =
\mathcal{A}_{\mathrm{k0}}
\;\land\;
\neg\mathcal{F}_{\mathrm{frozen}}
\;\land\;
\neg\mathcal{P}_{\mathrm{pbc}}
```

When two consecutive accepted Krylov Poisson potentials $\phi_{n-1} = \phi(m(t_{n-1}))$ and
$\phi_n = \phi(m(t_n))$ are available with $\Delta t_{n-1} = t_n - t_{n-1} > 0$, the two-step linear
temporal predictor constructs the initial Krylov iterate for an RK stage at $t_{\mathrm{eval}} = t_n + c_s \Delta t_n$:

```{math}
:label: eq-demag-linear-predictor
\phi^{(0)}\!\left(t_{\mathrm{eval}}\right) =
\phi_n + \alpha \left(\phi_n - \phi_{n-1}\right),
\qquad
\alpha = \frac{t_{\mathrm{eval}} - t_n}{t_n - t_{n-1}} = c_s \frac{\Delta t_n}{\Delta t_{n-1}}
```

The linear extrapolation is applied only when all monotonicity, step-ratio, and operator-identity guards pass;
otherwise the solver retains the latest device solution already resident in `poisson_solution`:

```{math}
:label: eq-demag-predictor-guards
t_{\mathrm{eval}} > t_{\mathrm{last}},
\qquad
0 < \frac{\Delta t_n}{\Delta t_{n-1}} \le r_{\max},
\qquad
0 < \alpha \le r_{\max},
\qquad
r_{\max} = 2
```

(symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
|---|---|---|
| $m_n$ | Normalized nodal magnetization vector at accepted step $n$ | $1$ |
| $m_{n+1}$ | Normalized nodal magnetization vector at accepted step $n+1$ | $1$ |
| $t_n$ | Simulation time at accepted step $n$ | $\mathrm{s}$ |
| $t_{n+1}$ | Simulation time at accepted step $n+1$ | $\mathrm{s}$ |
| $t_{n-1}$ | Simulation time at accepted step $n-1$ | $\mathrm{s}$ |
| $\Delta t_n$ | Active RK step size advancing from $t_n$ to $t_{n+1}$ | $\mathrm{s}$ |
| $\Delta t_{n-1}$ | Accepted previous step size $t_n - t_{n-1}$ | $\mathrm{s}$ |
| $c_s$ | Explicit Runge-Kutta tableau abscissa for stage $s$ | $1$ |
| $t_{\mathrm{eval}}$ | RK stage evaluation time $t_n + c_s \Delta t_n$ | $\mathrm{s}$ |
| $t_{\mathrm{last}}$ | Highest RK stage time already solved within the current attempt (`last_solved_stage_time_s`) | $\mathrm{s}$ |
| $f(m, t)$ | Device LLG right-hand side $\mathrm{d}m/\mathrm{d}t$ after frozen-spin zeroing | $\mathrm{s^{-1}}$ |
| $k_0^{(n+1)}$ | First-stage RK slope reused at the start of step $n+1$ | $\mathrm{s^{-1}}$ |
| $t_{\mathrm{fsal}}$ | Timestamp stored with the cached FSAL slope (`fsal_time_seconds`) | $\mathrm{s}$ |
| $\Sigma_{\mathrm{fsal}}$ | 64-bit operator fingerprint stored with the cached FSAL slope (`fsal_operator_signature`) | $1$ |
| $\Sigma(t)$ | Current 64-bit operator fingerprint computed by `gpu_rk_fsal_operator_signature` | $1$ |
| $\mathcal{A}_{\mathrm{k0}}$ | Boolean eligibility flag for FSAL `k0` reuse (`gpu_rk_rhs_allows_fsal_k0_reuse`) | $1$ |
| $\mathcal{A}_{\mathrm{ep}}$ | Boolean eligibility flag for RK23/RK45 endpoint RHS shortcut (`gpu_rk_allows_endpoint_rhs_shortcut`) | $1$ |
| $\mathcal{F}_{\mathrm{frozen}}$ | Boolean flag indicating active frozen-spin constraints (`ctx.frozen_spins.enabled()`) | $1$ |
| $\mathcal{P}_{\mathrm{pbc}}$ | Boolean flag indicating periodic-reduced mesh nodes (`has_periodic_reduced_nodes`) | $1$ |
| $\phi_n$ | Accepted scalar magnetostatic potential vector at $t_n$ | $\mathrm{A}$ |
| $\phi_{n-1}$ | Accepted scalar magnetostatic potential vector at $t_{n-1}$ | $\mathrm{A}$ |
| $\phi^{(0)}(t_{\mathrm{eval}})$ | Predicted initial scalar potential iterate for HYPRE Krylov warm start | $\mathrm{A}$ |
| $\alpha$ | Dimensionless linear extrapolation weight $(t_{\mathrm{eval}} - t_n) / \Delta t_{n-1}$ | $1$ |
| $r_{\max}$ | Maximum permitted step-size and extrapolation ratio ($2.0$) | $1$ |

(assumptions-and-validity)=
## Assumptions and validity

### Ten-condition FSAL `k0` invalidation matrix

| # | Condition or source | FSAL `k0` reuse | Guard mechanism |
|---|---|---|---|
| 1 | First step after initialization | Disabled (`fsal_valid = false`) | `rk_attempt_setup.cu` computes `k[0]` fresh |
| 2 | Stochastic Brown thermal noise ($T > 0$) | Disabled | `ctx.thermal_brown.temperature > 0.0` in `rk_fsal_policy.cpp` |
| 3 | External stage callbacks (Oersted / reciprocal transport) | Disabled | `ctx.oersted.has_stage_callback \|\| ctx.stage_transport.has_stage_callback` |
| 4 | Discontinuous or host-expression drives (`FULLMAG_FEM_TIME_PULSE`, Oersted `time_dep_kind == 2`, SOT pulse, `FULLMAG_FEM_TIME_HOST_EXPRESSION`, unknown waveform kind) | Disabled (fail-closed) | `gpu_rk_has_discontinuous_or_host_drive(ctx)` in `rk_fsal_policy.cpp` |
| 5 | Continuous time-dependent drives (`CONSTANT`, `SINUSOIDAL`, `SINC_PULSE`, strictly increasing `PIECEWISE_LINEAR`) | Enabled with time and signature check | Exact match on `fsal_time_seconds == ctx.state.current_time` and expanded `gpu_rk_fsal_operator_signature(ctx)` |
| 6 | Rejected adaptive attempt (retry) | Retained only if deterministic policy holds | `rk_attempt_loop.cu` restores checkpointed `m`/`k[0]` and calls `gpu_rk_retain_restored_fsal_on_retry(ctx)`; `max_reject` clears `fsal_valid` |
| 7 | Outer transaction rollback (`rk_step_transaction.cpp`) | Full snapshot and restore | Snapshots/restores `(fsal_valid, fsal_time_seconds, fsal_operator_signature, active_step_dt_s)` and predictor metadata; predictor buffer swap runs only after `DuringFinalFieldRefresh` |
| 8 | External `m`/field/coefficient upload, relaxation, `invalidate_fsal` | Invalidated everywhere | `gpu_state.cpp::invalidate_rk_endpoint` and `api.cpp::fullmag_fem_backend_invalidate_fsal` clear FSAL metadata and call `gpu_demag_predictor_invalidate` |
| 9 | Frozen spins (`ctx.frozen_spins.enabled()`) | Enabled for `k0` reuse; **disabled** for RK23/RK45 `endpoint_rhs_shortcut` | `rk_stage_schedule.cu` projects frozen spins before `rk_final_refresh.cu`, `rk_rhs_runtime.cu` zeroes frozen RHS entries in `gpu.rk.error`, and `rk_stage_schedule.cu` gates `endpoint_valid` with `gpu_rk_allows_endpoint_rhs_shortcut(ctx)` |
| 10 | Periodic boundary conditions (`has_periodic_reduced_nodes`) | Enabled for `k0` reuse; **disabled** for RK23/RK45 `endpoint_rhs_shortcut` | `rk_stage_schedule.cu` projects the periodic candidate prior to normalization and `rk_final_refresh.cu` evaluates idempotently projected RHS |

### Predictor validity domain and equal-stage regression protection

- **Exactness invariance:** The linear predictor only alters the initial guess $\phi^{(0)}$ passed to HYPRE PCG/GMRES.
  Every Krylov solve still iterates to `certification_solver_tolerance` ($0.1\,\tau_{\mathrm{rel}}$) and is
  independently certified against $\tau_{\mathrm{rel}}$, so the converged potential remains exact up to the linear
  solver tolerance.
- **Equal-stage protection ($t_{\mathrm{eval}} > t_{\mathrm{last}}$):** In RK4, stage 1 and stage 2 share
  $c_1 = c_2 = 0.5$, and stage 3 and the accepted final refresh share $c_3 = c_{\mathrm{final}} = 1.0$; in DP54
  (RK45), stage 5 and stage 6 share $c_5 = c_6 = 1.0$. Stage 3 already produces an $O(\Delta t^3)$-accurate
  potential at $t_{n+1}$. Overwriting `poisson_solution` on the equal-time stage with an $O(\Delta t^2)$ linear
  extrapolation would regress Krylov convergence. Resetting $t_{\mathrm{last}} = t_n$ at attempt start in
  `rk_attempt_setup.cu` and enforcing $t_{\mathrm{eval}} > t_{\mathrm{last}}$ in
  `gpu_demag_predictor_apply_warm_start` guarantees that equal-time stages retain the sharper already-computed
  potential.
- **Essential boundary conditions:** Both accepted potentials satisfy $\phi_i = 0$ on essential Dirichlet DOFs, so
  $\phi^{(0)}_i = 0 + \alpha(0 - 0) = 0$; `stage_compute.cpp` also reapplies `fullmag_cuda_zero_indexed_values`
  on `workspace->d_ess_tdofs` whenever `predictor_applied` is true.
- **Step-ratio cap ($r_{\max} = 2.0$):** When adaptive time stepping grows $\Delta t_n > 2\,\Delta t_{n-1}$ or
  $\alpha > 2.0$, linear extrapolation amplifies truncation error and is automatically bypassed in favor of $\phi_n$.
- **Zero-overhead no-op under cuDSS:** When `workspace->direct_solver != nullptr`, the predictor is completely
  bypassed in both `stage_compute.cpp` and `rk_final_refresh.cu`: zero VRAM is allocated (`d_phi_curr == nullptr`,
  `d_phi_prev == nullptr`), zero predictor kernels launch, and zero D2D copies occur.
- **Non-RK consumers:** Any call to `stage_compute.cpp` with `purpose` outside
  `{IntermediateRkStage, EndpointRkStage}` (`RelaxationTrial`, `RelaxationAcceptedState`, `ObservableRefresh`,
  `ValidationOracle`, `FrequencyTangent`) or with `reset_initial_solution == true` automatically calls
  `gpu_demag_predictor_invalidate`.

(python-api)=
## Python API

No new public Python knobs are introduced. Existing explicit RK and FEM linear-solver policy APIs automatically
activate FSAL `k0` reuse for Heun/RK4 on FEM GPU and activate the two-step linear predictor whenever the resolved
GPU Poisson linear solver is `hypre_krylov` (for example under `gpu_strategy="cg_amg"` or after an `auto` VRAM
budget fallback).

```python
# %% Study, engine, device, and strict FEM GPU mode
import fullmag as fm

study = fm.study("fem_gpu_rk_fsal_predictor_example")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="auto", size=(120e-9, 120e-9, 60e-9), center=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=20e-9)
study.interactive(False)

# %% Magnetic geometry, material, and initial magnetization
body = study.geometry(fm.Box(size=(40e-9, 40e-9, 40e-9)), name="magnet")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.05
body.m = fm.texture.uniform((0.6, 0.8, 0.0))
body.mesh(maximum_element_size=10e-9, order=1)

# %% Interactions and Krylov solver policy (exercises both FSAL k0 and phi^(0) predictor)
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-8)
study.b_ext(0.0, 0.25, 0.125)
study.build_domain_mesh()

# %% Fixed-step RK4 dynamics stage
study.solver(fix_dt=2e-13, integrator="rk4")
study.stages.add_run(duration=2e-12, name="rk4_fsal_predictor")
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| FemLinearSolverPolicy.solver | str | CG | $1$ | CG or GMRES | Outer Krylov method accelerated by the two-step linear potential predictor on FEM GPU | FEM CPU/GPU | fem.demag_solver_policy.solver |
| FemLinearSolverPolicy.preconditioner | str | AMG | $1$ | AMG, JACOBI or NONE | Preconditioner for HYPRE Krylov Poisson solves | FEM CPU/GPU | fem.demag_solver_policy.preconditioner |
| FemLinearSolverPolicy.rtol | float | 1e-8 | $1$ | positive finite value | Independent residual certification threshold preserved unchanged by the predictor | FEM CPU/GPU | fem.demag_solver_policy.rtol |
| FemLinearSolverPolicy.max_iterations | int | 500 | $1$ | at least 1 | Krylov iteration bound per Poisson solve | FEM CPU/GPU | fem.demag_solver_policy.max_iterations |

(problem-ir)=
## ProblemIR

Both optimizations are internal numerical realization improvements on the FEM GPU lane and introduce no new
`ProblemIR` fields. The canonical solver policy fragment serialized from `FemLinearSolverPolicy` remains:

```json
{"solver": "CG", "preconditioner": "AMG", "rtol": 1e-08, "max_iterations": 500, "print_level": 0}
```

(round-trip-and-failure-semantics)=
## Round trip and failure semantics

- **Requested intent** is unchanged across script export/import round trips: the user requests an explicit RK
  integrator (`heun`, `rk4`, `rk23`, `rk45`) and a FEM demag solver policy (`CG`/`GMRES` + `AMG`/`JACOBI`/`NONE`).
- **Resolved execution** reports actual per-step work in `fullmag_fem_step_stats`:
  - On deterministic FEM GPU runs, `fsal_reused = 1` starting on step 2 for Heun (`rhs_evaluations = 2`,
    `demag_solve_count = 2` with demag) and RK4 (`rhs_evaluations = 4`, `demag_solve_count = 4`), while step 1
    reports `fsal_reused = 0` (`3` / `5`).
  - Under `hypre_krylov`, `demag_linear_iterations` reflects the reduced Krylov iteration counts enabled by
    $\phi^{(0)}(t_{\mathrm{eval}})$ from step 3 onward; under `cudss_direct`, predictor buffers are never allocated.
- **Validation errors**: any CUDA kernel launch failure, `cudaMalloc` failure during lazy predictor allocation,
  `cudaMemcpyAsync` failure during accepted-potential commit, or residual certification failure fails closed, clears
  `fsal_valid`, invalidates predictor metadata, and rolls back the outer `RkStepTransaction` cleanly.
- **Unsupported combinations**:
  - Thermal noise ($T > 0$), stage callbacks, discontinuous pulse drives (`FULLMAG_FEM_TIME_PULSE`, Oersted
    `time_dep_kind == 2`, SOT pulse), and `FULLMAG_FEM_TIME_HOST_EXPRESSION` disable both FSAL `k0` reuse and the
    linear predictor (fail-closed, zero silent stale reuse).
  - Frozen spins and periodic-reduced meshes disable the RK23/RK45 `endpoint_rhs_shortcut` while keeping
    post-projection FSAL `k0` reuse active for all four RK integrators.
  - Non-RK demag consumers (`RelaxationTrial`, `RelaxationAcceptedState`, `ObservableRefresh`, `ValidationOracle`,
    `FrequencyTangent`) automatically invalidate predictor history and never extrapolate.
  - CUDA Graph capture for RK + `cuDSS` is explicitly excluded as a P1 non-goal due to cuDSS 0.8.0.10 stack-host
    H2D copies during `CUDSS_PHASE_SOLVE` (`modal_cudss_device_graph.cpp`), per-solve host residual certification
    fences, dynamic stage-time host parameters, and two-stream adaptive control flow.

(discrete-realization)=
## Discrete realization and residency

1. **Step preflight (`rk_step_preflight.cu`):** Resolves `result.fsal_method` as
   `(is_heun || is_rk4 || is_rk23 || is_rk45) && gpu_rk_rhs_allows_fsal_k0_reuse(ctx)`.
2. **Attempt setup (`rk_attempt_setup.cu`):** Records `gpu.rk.active_step_dt_s = active_dt`, resets
   `gpu.demag_poisson.predictor.last_solved_stage_time_s = ctx.state.current_time`, and checks all three reuse
   invariants: `fsal_method && gpu.rk.fsal_valid && gpu.rk.fsal_time_seconds == ctx.state.current_time && gpu.rk.fsal_operator_signature == gpu_rk_fsal_operator_signature(ctx)`.
3. **Stage schedule (`rk_stage_schedule.cu`):** Gates DP54 stage-6 and adaptive BS23 `k[3]` endpoint publication
   with `fsal_method && gpu_rk_allows_endpoint_rhs_shortcut(ctx)` so `RK23`/`RK45` with frozen spins or PBC never
   sets `gpu.rk.endpoint_valid = true`, preventing erroneous endpoint promotion in `rk_attempt_loop.cu` and spurious
   `endpoint_cache_invalidations` in `rk_final_refresh.cu`.
4. **Stage demag compute (`rk_rhs_runtime.cu`, `rk_demag_dispatch.cu`, `stage_compute.cpp`, `demag_predictor.cu`):**
   RK RHS evaluations pass `has_stage_time = true`, `stage_time_s = evaluation_time_s`, and
   `step_dt_s = gpu.rk.active_step_dt_s` into `GpuDemagApplyRequest`. Under HYPRE Krylov
   (`workspace->direct_solver == nullptr`), `stage_compute.cpp` invalidates the predictor on non-RK purposes,
   fresh-zero requests, or ineligible drives; otherwise it invokes `gpu_demag_predictor_apply_warm_start` on the
   Fullmag compute stream before `hypre_wait_for_fullmag`, zeroes essential DOFs if predicted, and updates
   `last_solved_stage_time_s = request.stage_time_s` after certified convergence.
5. **Accepted-step final refresh (`rk_final_refresh.cu`):** Checks `gpu_rk_allows_endpoint_rhs_shortcut(ctx)` for
   `endpoint_rhs_ready`. After `RkStepFailurePoint::DuringFinalFieldRefresh`, copies `gpu.rk.error -> gpu.rk.k[0]`
   when `!endpoint_rhs_ready`, stamps `fsal_time_seconds = endpoint_time` and
   `fsal_operator_signature = endpoint_signature`, and (for Krylov Poisson only) calls
   `gpu_demag_predictor_commit_accepted_potential` to lazily allocate `(d_phi_curr, d_phi_prev)`, swap pointers,
   and issue one async D2D copy of `poisson_solution`.
6. **Transaction journal and teardown (`rk_step_transaction.cpp`, `gpu_state.cpp`):** `RkStepTransaction` snapshots
   and restores FSAL time/signature/`active_step_dt_s` and predictor metadata; if a late rollback occurs after
   pointer swap (`DuringFinalStatistics`), it fails closed via `gpu_demag_predictor_invalidate`. `gpu_state.cpp`
   invalidates predictor and FSAL metadata on every external upload and calls `gpu_demag_predictor_destroy` on
   scalar-DOF resize and `gpu_state_destroy`.

(implementation-mapping)=
## Implementation mapping

- `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.hpp::gpu_rk_has_discontinuous_or_host_drive` rejects pulse,
  host-expression, and unknown waveforms fail-closed.
- `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp::gpu_rk_rhs_allows_fsal_k0_reuse` implements
  $\mathcal{A}_{\mathrm{k0}}$ of {eq}`eq-rk-fsal-k0-reuse`.
- `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp::gpu_rk_allows_endpoint_rhs_shortcut` implements
  $\mathcal{A}_{\mathrm{ep}}$ of {eq}`eq-rk-endpoint-shortcut-gate`.
- `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp::gpu_rk_fsal_operator_signature` computes the expanded
  64-bit operator signature $\Sigma(t)$.
- `backends/fem/gpu/cuda/integrators/rk/rk_step_preflight.cu::gpu_rk_prepare_step_preflight` enables `fsal_method`
  for Heun, RK4, RK23, and RK45.
- `backends/fem/gpu/cuda/integrators/rk/rk_attempt_setup.cu::gpu_rk_prepare_stage_attempt` resets
  $t_{\mathrm{last}} = t_n$, records `active_step_dt_s`, and verifies `fsal_time_seconds` and
  `fsal_operator_signature`.
- `backends/fem/gpu/cuda/integrators/rk/rk_stage_schedule.cu::gpu_rk_run_stage_attempt` gates `endpoint_valid`
  publication with `gpu_rk_allows_endpoint_rhs_shortcut`.
- `backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu::gpu_rk_finalize_accepted_step` stamps FSAL metadata
  and commits accepted Krylov potentials after `DuringFinalFieldRefresh`.
- `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu::demag_linear_predict_potential_kernel` evaluates
  {eq}`eq-demag-linear-predictor` in FP64 on device.
- `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu::gpu_demag_predictor_apply_warm_start` enforces
  {eq}`eq-demag-predictor-guards` and launches the extrapolation kernel.
- `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu::gpu_demag_predictor_commit_accepted_potential` lazily
  allocates history buffers and shifts $\phi_n \to \phi_{n-1}$, $\phi_{n+1} \to \phi_n$.
- `backends/fem/gpu/cuda/demag_poisson/demag_predictor.hpp::gpu_demag_predictor_destroy` and
  `backends/fem/gpu/cuda/demag_poisson/demag_predictor.hpp::gpu_demag_predictor_invalidate` own predictor teardown
  and metadata invalidation.
- `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp::compute_device_demag_for_device_stage_impl` wires
  Krylov-only predictor apply, non-RK auto-invalidation, and $t_{\mathrm{last}}$ advancement.
- `backends/fem/gpu/cuda/state/gpu_state.hpp::gpu_state_destroy` releases predictor buffers on teardown.
- `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp::rk_step_transaction_reset_workspace` owns the
  transactional journal capturing and restoring FSAL and predictor metadata.

(validation)=
## Validation

**Plan.** Verification combines unit/source/CUDA contract tests and Phase 2 Docker DEV A/B benchmarks on an
NVIDIA RTX 4080 SUPER:

1. **FSAL `k0` reuse and parity (`cuda_rk_heun_rk4_fsal_predictor_contract.cpp`, `parity.rs`):**
   5-step Heun and RK4 GPU runs must report `3 -> 2` and `5 -> 4` RHS/demag evaluations from step 2 onward with
   `fsal_reused == 1`, achieving $\max \|m_{\mathrm{on}} - m_{\mathrm{off}}\|_\infty \le 10^{-14}$ on
   exchange+Zeeman and agreement within solver tolerance on Poisson demag; 5-step CPU vs GPU parity in `parity.rs`.
2. **Invalidation matrix and endpoint separation (`cuda_rk_heun_rk4_fsal_predictor_contract.cpp`):**
   Pulse drives (`FULLMAG_FEM_TIME_PULSE`, Oersted `time_dep_kind == 2`, SOT pulse) and `HOST_EXPRESSION` force
   `fsal_reused == 0`; continuous `SINUSOIDAL` allows `fsal_reused == 1` until `current_time`, `external_field_am`,
   `stage_start_time_s`, or `relaxation.state_generation` changes; frozen spins and PBC allow Heun/RK4 `fsal_reused
   == 1` ($\le 10^{-14}$ parity), while adaptive RK23/RK45 + frozen spins never sets `endpoint_valid = true` and
   reports `accepted_endpoint_cache_invalidations == 0`.
3. **Rollback atomicity (`cuda_rk_guard_contract.cpp`, `cuda_rk_heun_rk4_fsal_predictor_contract.cpp`):**
   Fault injection at `DuringFinalFieldRefresh` restores `(fsal_valid, fsal_time_seconds, fsal_operator_signature)`
   and predictor metadata with unswapped, bit-identical `(d_phi_curr, d_phi_prev)` device buffers.
4. **Predictor math, guards, cuDSS zero-overhead, and Krylov iteration reduction
   (`cuda_rk_heun_rk4_fsal_predictor_contract.cpp`):**
   Exact kernel arithmetic ($\le 10^{-14}$) with essential-DOF zero preservation; RK4 equal-time stage 2 and final
   refresh skip extrapolation and leave higher-order solutions intact; `dt_ratio = 2.5 > 2.0`, `history_count < 2`,
   `reset_initial_solution = true`, `invalidate_fsal`, and non-RK `GpuDemagSolvePurpose` values bypass or invalidate;
   `cuDSS` keeps `d_phi_curr == nullptr && d_phi_prev == nullptr`; 10-step Poisson `CG_AMG` Heun/RK4 runs reduce
   total Krylov iterations strictly relative to constant warm start with magnetization parity $\le 10^{-10}$.

**Evidence status.** Contract tests and source-facade assertions are authored in this track; full CUDA/MFEM/Rust
execution and RTX 4080 SUPER A/B timing measurements are executed and recorded in Phase 2 integration.

(limitations)=
## Limitations

- The two-step linear predictor is scoped to GPU Poisson Krylov (`device_hypre_poisson` when
  `resolved_linear_solver = hypre_krylov`). GPU FEM/BEM operates on body-only P1 meshes ($10\times$–$30\times$
  fewer DOFs without an airbox) where `auto` selects `cuDSS` directly; connecting `GpuDemagLinearPredictorState` to
  FEM/BEM Krylov `u1`/`u2` remains an optional follow-up.
- Predictor history requires two consecutive accepted steps (`history_count == 2`), so steps 1 and 2 and the first
  two steps after any rejection, rollback, external upload, or non-RK solve fall back cleanly to the existing
  constant warm start.
- Higher-order polynomial predictors (quadratic 3-step extrapolation) are intentionally omitted to avoid overshoot
  under stiff switching dynamics and adaptive step changes.
- Full CUDA Graph capture for RK + `cuDSS` is deferred to P1 (`modal_cudss_device_graph.cpp`).

(scientific-bibliography)=
## Bibliography

- J. R. Dormand and P. J. Prince, "A family of embedded Runge-Kutta formulae", *Journal of Computational and
  Applied Mathematics* 6 (1980) 19–26, [doi:10.1016/0771-050X(80)90013-3](https://doi.org/10.1016/0771-050X(80)90013-3).
- P. Bogacki and L. F. Shampine, "A 3(2) pair of Runge-Kutta formulas", *Applied Mathematics Letters* 2 (1989)
  321–325, [doi:10.1016/0893-9659(89)90079-7](https://doi.org/10.1016/0893-9659(89)90079-7).
- E. Hairer, S. P. Nørsett, and G. Wanner, *Solving Ordinary Differential Equations I: Nonstiff Problems*, 2nd ed.,
  Springer (1993), [doi:10.1007/978-3-540-78862-1](https://doi.org/10.1007/978-3-540-78862-1).
- P. F. Fischer, "Projection techniques for iterative solution of $Ax = b$ with successive right-hand sides",
  *Computer Methods in Applied Mechanics and Engineering* 163 (1998) 193–204,
  [doi:10.1016/S0045-7825(98)00012-7](https://doi.org/10.1016/S0045-7825(98)00012-7).
- Canonical Poisson demag physics (`docs/physics/fem_demag_poisson.md`) and GPU Poisson direct solver policy
  (`docs/physics/0997-fem-gpu-poisson-direct-cudss.md`).

(source-code-index)=
## Source-code index

| Path | Symbol | Responsibility | Lane and evidence |
|---|---|---|---|
| `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.hpp` | `gpu_rk_has_discontinuous_or_host_drive` | Fail-closed detection of pulse, host-expression, and unknown drives | FEM GPU; unit and contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp` | `gpu_rk_rhs_allows_fsal_k0_reuse` | FSAL `k0` reuse eligibility predicate $\mathcal{A}_{\mathrm{k0}}$ | FEM GPU; unit and contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp` | `gpu_rk_allows_endpoint_rhs_shortcut` | Narrower RK23/RK45 endpoint shortcut predicate $\mathcal{A}_{\mathrm{ep}}$ | FEM GPU; unit and contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp` | `gpu_rk_fsal_operator_signature` | Expanded 64-bit operator fingerprint $\Sigma(t)$ | FEM GPU; unit and contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_step_preflight.cu` | `gpu_rk_prepare_step_preflight` | Enables `fsal_method` for Heun, RK4, RK23, and RK45 | FEM GPU; source and contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_attempt_setup.cu` | `gpu_rk_prepare_stage_attempt` | Verifies FSAL time/signature and resets $t_{\mathrm{last}} = t_n$ | FEM GPU; source and contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_stage_schedule.cu` | `gpu_rk_run_stage_attempt` | Gates RK23/RK45 `endpoint_valid` with `gpu_rk_allows_endpoint_rhs_shortcut` | FEM GPU; source and contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu` | `gpu_rk_finalize_accepted_step` | Stamps FSAL metadata and commits accepted Krylov potential after `DuringFinalFieldRefresh` | FEM GPU; source and contract test |
| `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu` | `demag_linear_predict_potential_kernel` | FP64 GPU kernel evaluating $\phi_n + \alpha(\phi_n - \phi_{n-1})$ | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu` | `gpu_demag_predictor_apply_warm_start` | Enforces monotonic stage time, `dt_ratio <= 2.0`, and signature guards | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/demag_predictor.cu` | `gpu_demag_predictor_commit_accepted_potential` | Lazily allocates Krylov history buffers and commits accepted $\phi_{n+1}$ | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/demag_predictor.hpp` | `gpu_demag_predictor_destroy` | Idempotent CUDA teardown of predictor buffers | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/demag_predictor.hpp` | `gpu_demag_predictor_invalidate` | Inline metadata invalidation without freeing buffers | FEM GPU; contract test |
| `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` | `compute_device_demag_for_device_stage_impl` | Wires Krylov-only predictor apply, non-RK auto-invalidation, and $t_{\mathrm{last}}$ update | FEM GPU; contract test |
| `backends/fem/gpu/cuda/state/gpu_state.hpp` | `gpu_state_destroy` | Frees predictor device history on GPU state destruction | FEM GPU; contract test |
| `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp` | `rk_step_transaction_reset_workspace` | Owns transactional journal snapshotting and restoring FSAL and predictor metadata | FEM CPU/GPU; rollback contract test |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Public FEM demag linear-solver policy consumed unchanged by the predictor path | FEM CPU/GPU; unchanged |
