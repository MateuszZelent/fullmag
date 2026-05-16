# Native FEM CPU Hypre Warm-Start Cache

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related reports:
  - `docs/reports/15.05.2026/fem-cpu-module-implementation-report.md`
  - `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
- Related notes:
  - `docs/physics/0819-native-fem-cpu-demag-hypre-solve-telemetry.md`
  - `docs/physics/0822-native-fem-cpu-demag-hypre-vector-workspace.md`

## 1. Problem statement

The native FEM CPU Poisson demag path already keeps the Hypre matrix,
preconditioner, Krylov solver, RHS vector, and solution vector in the native
context. Each solve still copies the previous MFEM scalar potential from the
`GridFunction` into the persistent `HypreParVector` before calling Hypre.

After the first solve, the persistent Hypre solution vector already contains the
same previous potential used as the warm start. Copying it from the
`GridFunction` again is redundant host traffic in every demag solve.

The second required condition is that the MFEM Hypre solver must actually treat
the solution vector passed to `Mult(b, x)` as an initial guess. MFEM exposes
this through `Solver::iterative_mode`; without it, the persistent vector can be
kept in memory but still be ignored or zeroed by the solver wrapper before the
linear solve.

## 2. Physical model

No physics change. The scalar Poisson demag problem remains:

```text
integral_Omega grad(u) . grad(v) dV = integral_Omega_m M . grad(v) dV
H_demag = -grad(u)
E_demag = -0.5 * mu0 * integral_Omega_m M . H_demag dV
```

The warm-start vector is only an initial guess for the same linear system.
Keeping it in Hypre memory does not alter the operator, RHS, tolerance, boundary
conditions, recovered field, or energy.

## 3. Symbols and SI units

- `u`: scalar magnetic potential, A.
- `H_demag`: demagnetizing field, A/m.
- `M`: magnetization, A/m.
- `mu0`: vacuum permeability, N/A^2.
- `E_demag`: demag energy, J.

## 4. Backend interpretation

- FDM: no impact.
- FEM CPU: `PoissonHypreWorkspace` records whether the persistent Hypre solution
  vector already contains a valid previous potential. The first solve seeds the
  vector from the MFEM `GridFunction`; later solves reuse the Hypre vector
  directly as the initial guess. `HyprePCG` and `HypreGMRES` run with
  `iterative_mode = true` so the persistent vector is a numerical warm start,
  not just a cached output buffer.
- FEM GPU: not optimized in this slice. The change is still safe for
  GPU-enabled MFEM builds because it reduces host-copy warm-start traffic rather
  than introducing new device ownership.

## 5. API, IR, and planner impact

- Python DSL: no public API change.
- `ProblemIR`: no change.
- Planner/capability matrix: no change.
- Runtime/provenance: existing demag solver, preconditioner, tolerance,
  iteration, residual, setup/apply timing, and reuse fields remain valid.
- Browser/API: no OpenAPI or workspace impact.

## 6. Validation strategy

1. Add a source-level regression proving `solve_poisson_hypre` guards the
   solution-to-Hypre warm-start copy behind a workspace validity flag.
2. Add a source-level regression proving `HyprePCG` and `HypreGMRES` enable
   iterative mode before `Mult(b, x)`.
3. Compile the affected Rust crate test target with `--features fem-gpu`.
4. Run a CPU `exchange_demag` benchmark smoke and confirm the row still reaches
   `status=ok`, reports `demag_solver_setup_reused=True`, and carries demag
   solve telemetry.

## 7. Completeness checklist

- [x] Physics equations unchanged.
- [x] Python API unaffected.
- [x] `ProblemIR` unaffected.
- [x] Planner unaffected.
- [x] Native FEM CPU Hypre warm-start vector is cached across solves.
- [x] Native FEM CPU Hypre solvers use nonzero initial guesses.
- [x] Regression test passes.
- [x] CPU demag smoke passes.

## 8. Deferred work

- Host-copy RHS transfer remains open.
- `H_demag = -grad(u)` recovery remains host-side.
- Larger-mesh Hypre/AMG policy tuning remains open.

## 9. Validation evidence

- `cargo test -p fullmag-runner native_fem_hypre_solve_reuses_persistent_warm_start_vector --features fem-gpu -- --nocapture`: passed.
- `cargo test -p fullmag-runner native_fem_hypre_solve_enables_iterative_mode_for_warm_start --features fem-gpu -- --nocapture`: added as a RED/GREEN regression for the missing MFEM iterative-mode guard.
- `python3 scripts/analysis/fem_gpu_benchmark.py --backends cpu --meshes coarse --scenarios exchange_demag --integrators heun --steps 1 --output /tmp/fullmag_fem_cpu_hypre_warm_start_cache_smoke_unsandboxed.csv --require-mfem-stack`: passed outside the sandbox with `status=ok`, `demag_solver_setup_reused=True`, `demag_solver_setup_wall_time_ms=15.451264`, `demag_solver_apply_wall_time_ms=846.668565`, `demag_actual_iterations=5`, and `demag_final_residual_norm=7.424155033467843e-09`.
