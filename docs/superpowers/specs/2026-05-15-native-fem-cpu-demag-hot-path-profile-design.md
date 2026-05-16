# Native FEM CPU Demag Hot-Path Profile Design

- Status: approved for implementation
- Date: 2026-05-15
- Scope: CPU Poisson-demag runtime telemetry
- Out of scope: GPU profiling, CUDA/libCEED kernels, physical demag equation
  changes, MFEM-host benchmark execution

## Goal

Expose CPU Poisson-demag hot-path timing as structured runtime diagnostics so
CPU benchmarks can separate RHS assembly, linear solve, field recovery, and
energy computation.

## Architecture

The native backend already measures local demag phase timers. This slice makes
those timers part of the C ABI and Rust diagnostics:

```text
fullmag_fem_step_stats
StepStats
StepDiagnostics
metadata.json demag_runtime
```

The aggregate `demag_wall_time_ns` remains unchanged. Detailed timings are
diagnostics only.

## Validation

Use compile-time/logic tests that do not require MFEM:

- `fullmag-fem-sys` ABI test for new fields.
- `fullmag-runner` `StepStats` diagnostic propagation test.
- `fullmag-runner` native wrapper mapping test, if an existing fixture can
  construct `fullmag_fem_step_stats` without a backend.

Full runtime value validation remains blocked until an MFEM/hypre host is
available.

## Completeness Checklist

- [x] C ABI struct includes detailed demag phase fields.
- [x] Native `PhaseTimings` carries detailed demag phase fields.
- [x] `context_compute_demag_poisson` records assemble/solve/recover/energy.
- [x] Rust `StepStats` and `StepDiagnostics` expose the fields.
- [x] Artifact metadata reports latest demag profile.
- [x] Local tests and source checks pass.
