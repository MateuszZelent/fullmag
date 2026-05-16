# Native FEM CPU Demag Hypre Vector Workspace

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related ADRs: none
- Related specs:
  - `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
  - `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0819-native-fem-cpu-demag-hypre-solve-telemetry.md`

## 1. Problem statement

The native FEM CPU Poisson demag path already caches the Hypre matrix,
preconditioner, and Krylov solver. `solve_poisson_hypre` still creates fresh
transfer vectors for every demag solve:

- BC-applied MFEM RHS vector,
- `HypreParVector` RHS,
- `HypreParVector` warm-start/solution.

For explicit RK stages this happens multiple times per accepted step. This note
scopes a CPU-only hot-path cleanup: keep those transfer vectors in the native
FEM context and resize/reuse them across solves.

## 2. Physical model

### 2.1 Governing equations

No physics change. The scalar potential `u` is still solved by the existing
Poisson demag system on the shared-domain airbox mesh:

```text
integral_Omega grad(u) . grad(v) dV = integral_Omega_m M . grad(v) dV
H_demag = -grad(u)
```

The selected linear solver, preconditioner, tolerances, boundary conditions,
Robin correction, warm-start semantics, and demag energy formula are unchanged.

### 2.2 Symbols and SI units

- `u`: scalar magnetic potential, A.
- `H_demag`: demagnetizing field, A/m.
- `M`: magnetization, A/m.
- `m`: reduced magnetization, dimensionless.
- `Ms`: saturation magnetization, A/m.
- `E_demag`: demag energy, J.

### 2.3 Assumptions and approximations

The path remains a serial-MPI Hypre solve for the non-periodic native FEM CPU
airbox Poisson system. The transfer still uses host copies in this slice; only
workspace allocation is improved.

## 3. Numerical interpretation

### 3.1 FDM

No impact.

### 3.2 FEM

The FEM linear algebra is unchanged:

1. assemble the existing reusable Poisson RHS,
2. apply essential BC values to a reusable `rhs_bc`,
3. copy `rhs_bc` and warm-start solution into reusable Hypre vectors,
4. call the cached Hypre Krylov solver,
5. copy the solved potential back to the MFEM solution vector.

The optimization affects only the ownership and lifetime of step-local vectors.

### 3.3 Hybrid

No impact.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public API change.

### 4.2 ProblemIR representation

No `ProblemIR` change.

### 4.3 Planner and capability-matrix impact

No planner or capability change. Runtime provenance remains `cpu_native`,
`legacy_sparse`, and `host_source_of_truth` for this path.

## 5. Validation strategy

### 5.1 Analytical checks

No new analytical check is required because the system and solution semantics
are unchanged.

### 5.2 Cross-backend checks

No cross-backend behavior changes in this slice.

### 5.3 Regression tests

1. Add a source-level guard proving `solve_poisson_hypre` no longer declares
   local `mfem::HypreParVector b_par` / `x_par` transfer vectors.
2. Compile the native FEM FFI path with `cargo check -p fullmag-cli --features
   "cuda fem-gpu"`.
3. Rebuild the managed FEM runtime bundle.
4. Run unsandboxed CPU `exchange_demag` benchmark smoke and confirm
   `status=ok` with solve/setup/apply telemetry still populated.

## 6. Completeness checklist

- [x] Python API unaffected.
- [x] ProblemIR unaffected.
- [x] Planner unaffected.
- [x] Capability matrix unaffected.
- [x] FDM backend unaffected.
- [x] FEM backend uses context-owned Hypre transfer vectors.
- [x] Hybrid backend unaffected.
- [x] Outputs / observables unchanged.
- [x] Tests / benchmarks pass.
- [x] Documentation updated.

## 7. Known limits and deferred work

- Hypre transfer still uses host copies.
- Periodic reduced demag solve remains serial sparse CG/GSSmoother.
- A future device-side path needs stable MFEM/Hypre ownership or a libCEED /
  custom-device Poisson solve.

## 8. Validation evidence

- `cargo test -p fullmag-runner native_fem_hypre_solve_reuses_transfer_vectors --features fem-gpu -- --nocapture`: passed after the RED run failed on the missing context-owned Hypre workspace.
- `cargo check -p fullmag-cli --features "cuda fem-gpu"`: passed.
- `just rebuild-fem-runtime`: rebuilt the managed FEM runtime bundle with `PoissonHypreWorkspace`.
- `python3 scripts/analysis/fem_gpu_benchmark.py --backends cpu --meshes coarse --scenarios exchange_demag --integrators heun --steps 1 --output /tmp/fullmag_fem_cpu_hypre_vector_workspace_smoke.csv --require-mfem-stack`: passed with `status=ok`, `demag_solver_setup_wall_time_ms=27.027571`, `demag_solver_apply_wall_time_ms=806.414114`, and `demag_solver_setup_reused=True`.

## 9. References

- `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
- `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
