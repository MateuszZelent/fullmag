# FEM Explicit-RK Performance Design

- Status: approved
- Date: 2026-05-15
- Scope: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

## Goal

Make native FEM time integration performance measurable and physically honest across the whole explicit Runge-Kutta family, not only Heun.

## Architecture

The first production slice is a shared explicit-RK performance gate around the existing `context_step_explicit_rk_mfem` path. It covers Heun, RK4, RK23/Bogacki-Shampine, and RK45/Dormand-Prince through one contract: reported `rhs_evals`, `demag_solve_count`, `fsal_reused`, final `H_eff`, torque, energy, and benchmark metadata must describe the real work performed by the step.

This slice does not implement partial assembly/libCEED or DMI weak residuals yet. It makes those optimizations measurable by removing the misleading single-integrator benchmark and by making final-refresh work visible.

## Physical Contract

`H_eff` is the source for torque, RHS, live fields, and energy telemetry. The default production mode must keep final post-step `H_eff` physically fresh. For non-FSAL methods, that requires an extra final effective-field refresh after the accepted state is formed. For FSAL methods, the final stage can be reused only when it is evaluated at the accepted final state.

Any future mode that skips final `H_eff` refresh must be an explicit performance mode and must not be presented as exact final torque or energy telemetry.

## Integrator Cost Contract

For a fixed accepted step without rejection:

- Heun: 2 stages plus final refresh, so 3 RHS/effective-field evaluations in exact telemetry mode.
- RK4: 4 stages plus final refresh, so 5 RHS/effective-field evaluations in exact telemetry mode.
- RK23/BS23: first accepted step uses 4 stage evaluations; later accepted steps may use FSAL and report 3 new RHS evaluations.
- RK45/DP54: first accepted step uses 7 stage evaluations; later accepted steps may use FSAL and report 6 new RHS evaluations.

`demag_solve_count` must count actual Poisson demag solves, including any final refresh. `rhs_evals` must not hide final refresh work.

## Benchmark Contract

`examples/bench_fem_gpu_long.py` and `scripts/analysis/fem_gpu_benchmark.py` must sweep an explicit integrator axis. The default benchmark matrix covers:

- integrators: `heun`, `rk4`, `rk23`, `rk45`,
- scenarios: `exchange_only`, `exchange_demag`, `exchange_dmi`, `stt_oersted`,
- reported columns: integrator, `rhs_evals`, `demag_solves`, `fsal_reused`, timing phases, assembly mode, MFEM device, and demag solver metadata.

## Validation

The first validation layer is contract-level:

- benchmark config tests prove the integrator axis exists,
- native FEM tests verify reported RHS and demag counts when the MFEM stack is available,
- Python compile checks cover benchmark scripts.

MFEM/CUDA runtime benchmarks remain host-dependent. If this host lacks MFEM/CUDA, the final report must state that runtime speedups were not measured locally.
