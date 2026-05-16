# FEM demag solver policy and runtime CPU threading contract

- Status: implemented
- Owners: Fullmag FEM/runtime
- Last updated: 2026-05-15
- Related ADRs: `docs/adr/` (execution-selection + canonical IR contract)
- Related specs: `docs/specs/capability-matrix-v0.md`

## 1. Problem statement

Fullmag needs two explicit contracts around native FEM Poisson demagnetization:

1. an authorable FEM-native linear solver policy for the Poisson demag solve,
2. an explicit requested-vs-resolved CPU threading story for live sessions.

Without those contracts, the UI can only show opaque defaults and users cannot
reproduce numerically relevant solver choices from Python or session metadata.

## 2. Physical model

### 2.1 Governing equations

The physical demagnetization model remains unchanged:

- `H_demag = -grad(u)`
- `div(grad(u)) = div(M)` in the shared FEM domain

The added contract in this note changes only the numerical realization policy,
not the governing micromagnetic equations.

### 2.2 Symbols and SI units

- `M` magnetization `[A/m]`
- `H_demag` demagnetizing field `[A/m]`
- `u` scalar potential `[A]`
- `rtol` relative linear-solver tolerance `[dimensionless]`
- `atol` absolute linear-solver tolerance `[dimensionless]`
- `N_iter` linear-solver iteration cap `[dimensionless count]`

All user-visible physical quantities remain SI-clean.

### 2.3 Assumptions and approximations

- The solver policy applies only to native FEM Poisson demag realizations.
- It is a backend hint, not a new physical model term.
- CPU thread selection is resolved per run start and may differ between:
  - requested study/runtime threads,
  - resolved Rayon/control-plane threads,
  - effective native FEM OpenMP threads.

## 3. Numerical interpretation

### 3.1 FDM

No change. FDM demag remains governed by FDM-specific solver policy surfaces.

### 3.2 FEM

Native FEM Poisson demag may now carry an explicit linear-solver policy:

- solver: `CG | GMRES`
- preconditioner: `AMG | JACOBI | NONE`
- `rtol`
- optional `atol`
- `max_iterations`
- `print_level`

When omitted, the canonical default remains:

- solver: `CG`
- preconditioner: `AMG`
- `rtol = 1e-8`
- `atol = None`
- `max_iterations = 500`
- `print_level = 0`

### 3.3 Hybrid

No hybrid-specific semantics are introduced. Hybrid work must not reinterpret
this as a common physics setting.

## 4. API, IR, and planner impact

### 4.1 Python API surface

This contract lives in explicit FEM backend hints, not in the common `Demag`
physics term.

Canonical Python authoring surfaces:

- class-based:
  - `fm.FemLinearSolverPolicy(...)`
  - `fm.FEM(..., demag_solver_policy=...)`
- flat/study DSL:
  - `fm.fem_demag_solver(...)`
  - `study.fem_demag_solver(...)`

CPU thread selection remains a runtime selection concern:

- `fm.threads(...)`
- `study.threads(...)`

### 4.2 ProblemIR representation

- `FemHintsIR` carries optional `demag_solver_policy`
- `FemPlanIR.demag_solver_policy` is populated from canonical FEM hints
- session/runtime metadata expose:
  - requested CPU threads
  - resolved Rayon/control-plane threads
  - effective native FEM OpenMP threads when available

### 4.3 Planner and capability-matrix impact

- Planner propagates `FemHintsIR.demag_solver_policy` into executable FEM plans
- Unsupported native FEM solver/preconditioner combinations remain explicit
  planning/runtime errors
- Capability reporting remains public-executable for Poisson FEM demag

## 5. Runtime/session/artifact/provenance impact

- Session/runtime views must preserve:
  - requested CPU threads,
  - resolved Rayon thread count,
  - requested/effective native FEM OpenMP threads when the native path reports them
- Native FEM Poisson demag provenance must not use FFT labels. In particular,
  `fft_backend` is reserved for FDM/tensor-FFT demag paths and must remain
  absent for FEM Poisson realizations.
- FEM Poisson demag runtime metadata must preserve the numerical solve policy
  and observed solve result:
  - solver and preconditioner,
  - relative tolerance,
  - maximum iterations,
  - number of Poisson solves performed for the reported step/snapshot,
  - actual iterations,
  - final residual,
  - boundary variant,
  - Robin beta policy when applicable.
- Native FEM runtime metadata must also report the resolved FEM operator
  assembly mode. Until exchange/mass/DMI move to partial assembly or
  matrix-free libCEED operators, the current native time-domain path must be
  labeled as `legacy_sparse` rather than presented as a production
  partial-assembly implementation.
- Script export and SceneDocument round-trip must preserve:
  - requested CPU threads,
  - FEM demag solver policy
- Logs and UI must not pretend that live thread-pool changes apply to an already
  running solve

## 6. Validation strategy

### 6.1 Analytical checks

- No new physical observable is introduced; solver policy changes must preserve
  validated demag behavior for canonical benchmarks.

### 6.2 Cross-backend checks

- FEM default policy must match prior default native execution behavior
- Explicit non-default policies must serialize and lower reproducibly

### 6.3 Regression tests

- Python:
  - `FemLinearSolverPolicy.to_ir()`
  - `FEM(..., demag_solver_policy=...)` serialization
  - flat/study script export and re-import preserve the policy
- Planner:
  - `FemHintsIR.demag_solver_policy -> FemPlanIR.demag_solver_policy`
- Frontend:
  - requested vs resolved CPU-thread display stays typed and round-trippable

## 7. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [x] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 8. Known limits and deferred work

- Live mid-run thread-pool retuning is still unsupported.
- Native FEM currently reports OpenMP thread resolution through runtime/log
  diagnostics and FFI step stats; richer direct UI telemetry can replace
  artifact-derived display in a later pass.
- This contract does not yet expose separate linear-solver policies for future
  FEM mechanics or eigen operators.

Update 2026-05-15: native FEM CPU now carries `atol` and `print_level` across
the C ABI and uses them when configuring the non-PBC Hypre AMG/CG/GMRES Poisson
demag solve. Benchmark entrypoints can now set demag solver, preconditioner,
`rtol`, optional `atol`, `max_iterations`, and Hypre `print_level` without
editing scripts, and `metadata.json` / CSV rows preserve the requested policy.

Update 2026-05-15 non-PBC hot path: the native FEM Poisson path now keeps a
context-owned true-DOF solution vector for non-PBC demag and skips repeated
`GridFunction::GetTrueDofs` warm-start extraction once the persistent Hypre
solution vector is valid. This preserves the same Poisson equation, BCs,
solver policy, and recovered `H_demag`; it only removes allocation/copy churn
from adaptive RK demag solves.

Update 2026-05-15 benchmark validation: the FEM benchmark harness can now
require demag convergence telemetry and fail rows whose final residual norm or
actual iteration count exceed explicit thresholds. This is a validation gate
for solver-policy tuning; it does not change the public physics contract.

Update 2026-05-15 policy sweeps: the FEM benchmark harness can now sweep
multiple demag solvers and preconditioners in one run. The sweep expands only
for demag scenarios, so non-demag baselines are not duplicated by irrelevant
Poisson policy settings.

Update 2026-05-15 policy selection: the benchmark harness can emit a
best-policy summary for each logical demag case, selecting the fastest row that
satisfies the configured convergence residual and iteration gates. This remains
benchmark analysis only; it does not silently change runtime solver policy.

Update 2026-05-15 readiness preset: the benchmark harness exposes
`--fem-cpu-no-pbc-adaptive-ready-preset` as a shorthand for the existing FEM CPU
no-PBC adaptive exchange+demag+anisotropy readiness sweep and gates. The preset
runs both `exchange_demag_anis_uniaxial` and `exchange_demag_anis_cubic` under
RK23 and RK45 with thread-count tokens `1`, `physical_cores/2`,
`physical_cores`, and `auto` under the same adaptive CPU gate. It does not
change solver physics or runtime defaults.
The readiness gate now also checks requested mesh/scenario/integrator/thread
coverage, so a partial CSV cannot pass the preset when one of the requested
meshes, phase-10 anisotropy cases, adaptive integrators, or thread-count cases
is missing.
Every benchmark run emits a `FEM_PASS_FAIL_SUMMARY` JSON line grouped by
`solver_mesh_signature`, including row counts, pass/fail status, demag residual
and iteration maxima, thread-count coverage, and gate failure counts. This makes
the phase-10 CSV inspectable without inferring pass/fail from process exit alone.
When supplied with `--accepted-baseline`, the harness compares matching
`solver_mesh_signature` benchmark cases against the last accepted CSV and fails
rows whose wall-clock or demag timing metrics regress beyond the configured
percentage threshold, defaulting to 10%.

Update 2026-05-15 phase-10 scenario matrix: benchmark naming now distinguishes
uniaxial and cubic anisotropy cases explicitly:
`exchange_anis_uniaxial`, `exchange_anis_cubic`,
`exchange_demag_anis_uniaxial`, and `exchange_demag_anis_cubic`. These names
select existing material anisotropy parameters for qualification runs and keep
`exchange_demag_anisotropy` as a compatibility alias.

Update 2026-05-15 qualification artifacts: `metadata.json` now carries a
`fem_cpu_relaxation_qualification` block for native FEM CPU runs. It records the
qualified physics terms, solver mesh signature, demag policy, assembly mode,
relaxation algorithm, stop reason, final energy terms, final torque, norm
defect, executed steps, and benchmark gate version so downstream tooling does
not need to infer these values from logs.
`--require-best-demag-policy` turns missing converged policy summaries into a
benchmark failure, so Hypre/AMG tuning sweeps cannot silently produce no
actionable policy. If all candidate rows fail before convergence telemetry is
available, the missing-policy error includes their `error_kind` values.

Update 2026-05-15 recovery scratch: non-PBC Poisson demag recovery now keeps
serial and per-thread element scratch buffers in the context-owned recovery
workspace. This removes repeated MFEM element scratch construction during
adaptive RK demag recovery while preserving the same gradient recovery,
magnetic-node zeroing, and energy evaluation.

Update 2026-05-15 Robin energy scratch: the Robin boundary-energy correction
now reuses a context-owned boundary temporary vector from the demag recovery
workspace instead of constructing it for every recovery call. The boundary
energy formula and cached frozen-field correction are unchanged.

Update 2026-05-15 essential-DOF zeroing: non-PBC Poisson demag now zeros
essential true DOFs by iterating the context-owned `poisson_ess_tdof_list`
directly instead of constructing an `mfem::Array` wrapper in the solve hot
path. The eliminated operator and boundary condition semantics are unchanged.

Update 2026-05-15 RHS coefficient scratch: the Poisson RHS magnetization
coefficient now reuses thread-local DOF and shape scratch during coefficient
evaluation. This removes repeated element scratch construction during RHS
assembly while preserving the same `M_s m` interpolation on magnetic elements
and zero contribution on air elements.

Update 2026-05-15 FSAL field publish: accepted RK23/RK45 FSAL steps now publish
the cached final `H_ex`, `H_demag`, and `H_eff` buffers by swapping the stepper
workspace buffers into the context instead of copying full field arrays. This
preserves the same accepted state and final field values; it only removes an
O(N) copy from the adaptive RK accept path.

Update 2026-05-15 non-FSAL final refresh: Heun/RK4 final effective-field refresh
now reuses the same stepper field workspace and swaps the final buffers into the
context. The post-step `max_dm_dt` RHS also reuses a stage derivative buffer
instead of constructing a local full-size RHS vector. This preserves the final
field refresh and reported RHS count while removing per-step buffer churn from
the non-FSAL explicit-RK path.

Update 2026-05-15 disabled local terms: interfacial DMI, cubic anisotropy, and
bulk DMI observable buffers are now zero-initialized once during context setup
when those terms are absent. The effective-field hot path no longer clears those
full-size buffers on every `exchange + demag + uniaxial anisotropy` evaluation.
Readback still sees zero fields for disabled terms; active terms still overwrite
their buffers during evaluation.

Update 2026-05-15 active buffer pre-zeroing: active exchange/demag output
buffers now use size-only `resize` before evaluator calls, and `H_eff` uses
`resize` because it is overwritten component-wise after all terms are assembled.
The disabled exchange/demag fallbacks still produce explicit zero fields. This
removes another full-buffer clear from each adaptive RHS evaluation without
changing published fields or energies.

Update 2026-05-15 demag frozen-cache copy: fresh Poisson demag solves now copy
`H_demag` into the frozen-field cache only when `field_refresh.demag_interval_s`
is active. Default time-domain relaxation refreshes demag every RHS evaluation,
so the frozen cache is unused there and no longer pays a full-field copy per
solve. Runs that explicitly enable frozen-field refresh keep the same cached
field and Robin-boundary energy semantics.

Update 2026-05-15 FEM CPU no-PBC adaptive gate: the benchmark harness now has a
`--require-fem-cpu-no-pbc-adaptive-ready` gate for the targeted release slice:
`fem_cpu`, `exchange_demag_anis_uniaxial` and `exchange_demag_anis_cubic`
(with `exchange_demag_anisotropy` as a compatibility alias), RK23/RK45
adaptive stepping, double
precision, zero periodic mesh pairs, at least 100 executed steps unless the
stage stopped by torque tolerance, positive adaptive-step/demag-solve counts,
Poisson-airbox demag with Robin boundary conditions, shared-domain mesh with
air, completion of the requested benchmark step count, final exchange/demag/
anisotropy energies for the active terms, demag convergence telemetry, and
assemble/solve/setup/apply/recover/energy timings. The gate
requires the reported benchmark payload to confirm the same scenario,
integrator family, and adaptive timestep policy; it also requires runtime
provenance to confirm `execution_engine=fem_cpu_native`, `cpu_native`,
`mfem_device=cpu`, host-source-of-truth data residency, and no CUDA kernels or
GPU Poisson.
For multi-step readiness runs, the final row must also confirm demag solver
setup reuse, because a warmed Hypre/AMG setup is part of the optimized CPU
no-PBC path rather than optional telemetry.
The readiness gate rejects positive `demag_refresh_interval_s`, because this
targeted benchmark must measure the normal Poisson demag evaluation path rather
than a frozen demag cache policy.
Benchmark payloads that expose the final anisotropy energy as `e_ani` are
normalized into the gate's `final_e_ani_j` row field. This is a validation gate
for small and medium no-PBC CPU runs, not a claim that the bootstrap
`llg_overdamped` relaxation is a final FE-metric tangent-plane minimizer.
Benchmark failures whose stderr/stdout contains MPI initialization or PMIx
startup errors are classified as `error_kind=mpi_init_or_pmix_startup` in the
CSV so sandbox/runtime-launcher failures are distinguishable from demag
convergence failures. Gate failure messages include the same `error_kind` when
the row failed before convergence/readiness checks could inspect solver
telemetry.

## 9. References

- `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
- `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`
