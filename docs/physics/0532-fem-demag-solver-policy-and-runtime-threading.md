# FEM demag solver policy and runtime CPU threading contract

- Status: implemented
- Owners: Fullmag FEM/runtime
- Last updated: 2026-04-16
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
  diagnostics; richer direct native telemetry can replace log-derived display in
  a later pass.
- This contract does not yet expose separate linear-solver policies for future
  FEM mechanics or eigen operators.

## 9. References

- `docs/physics/0531-fem-demag-transfer-grid-removal.md`
- `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`
