# FEM CPU Performance Baselines

- Status: managed-runtime benchmark contract wired; accepted baseline dataset still open
- Last updated: 2026-06-14
- Implementation: `backends/fem/`
- Runtime gate: `just verify-fem-relaxation-production-benchmark`
- Demag performance gate: `just verify-fem-gpu-demag-performance-benchmark`

## Scope

This document defines the performance baselines required before native FEM CPU
performance claims can be treated as production-ready. It separates three
states:

- telemetry exists in solver/runtime output;
- a managed-runtime benchmark gate checks the telemetry;
- an accepted baseline CSV from a controlled machine exists for regression
  comparison, including a persistent generated-domain-mesh cache when generated
  airbox/shared-domain meshes are part of the case.

## Required Baseline Families

| Family | Required measurement | Status |
|---|---|---|
| Backend creation | mesh import, material projection, FE space setup | open |
| Exchange | assembly time, apply time, mass projection mode | open |
| Demag Poisson | RHS assembly, solve, recovery, energy, linear iterations, setup reuse, apply-time budget | managed benchmark gate wired; accepted baseline open |
| Demag FEM/BEM | boundary extraction, dense operator build/apply, recovery | reference-only contract; baseline open |
| Local fields | anisotropy, Zeeman, Oersted, thermal, magnetoelastic | local contracts only |
| DMI | weak residual element loop and projection | baseline open |
| Stepper | Heun/RK4/RK23/RK45 accepted-step wall time | baseline open |
| Snapshot/readback | field copy and scalar stats | baseline open |

## Minimum Report Format

Each benchmark entry should record:

- git commit or working-tree identifier;
- compiler and build flags;
- MFEM/hypre/libCEED versions;
- CPU model, thread count, and OpenMP policy;
- mesh node/element counts and magnetic/airbox split;
- enabled interactions;
- median and p95 wall times over repeated runs;
- peak memory when available;
- relevant solver iterations and residuals.

## Current Local Status

Managed-runtime benchmark wiring exists and uses the container-backed FEM
runtime. The current gates cover:

- demag residual and actual iteration count through
  `--require-demag-converged` plus
  `--demag-convergence-max-iterations`;
- absolute demag apply-time budget through
  `--max-demag-solver-apply-ms`;
- accepted-baseline CSV regression through
  `--accepted-baseline`, `--require-accepted-baseline`, and
  `--max-performance-regression-percent`;
- persistent generated-domain-mesh reuse through
  `--generated-domain-mesh-cache-dir` /
  `FULLMAG_BENCH_DOMAIN_MESH_CACHE_DIR`, so accepted-baseline rows and current
  rows can share `solver_mesh_signature` instead of comparing separate mesh
  realizations;
- demag policy sweep selection through `--emit-best-demag-policy` and
  `--require-best-demag-policy`;
- demag tolerance sweeps through `--demag-rtols` /
  `FULLMAG_BENCH_DEMAG_RTOLS`, with convergence checks defaulting to each
  row's requested relative tolerance when no explicit residual threshold is
  supplied.

No accepted CPU baseline CSV is committed yet. The accepted-baseline gate has
been proven in managed runtime with a persistent generated-domain-mesh cache,
but until a controlled-machine baseline is selected, archived, and reviewed,
local performance claims should cite the generated CSV/summary paths from the
managed benchmark run and treat them as machine-local measurements, not
portable production baselines.

Current default report outputs:

- `.fullmag/reports/fullmag_relaxation_production_benchmark.csv`
- `.fullmag/reports/fullmag_relaxation_production_benchmark_summary.json`
- `.fullmag/reports/fullmag_fem_gpu_demag_performance_benchmark.csv`
- `.fullmag/reports/fullmag_fem_gpu_demag_performance_benchmark_summary.json`
