# FEM CPU Performance Baselines

- Status: release-gate baseline placeholder for native FEM CPU
- Last updated: 2026-05-16
- Implementation: `native/backends/fem/`
- Test: `native/backends/fem/tests/interaction_docs_contract.cpp`

## Scope

This document defines the performance baselines required before the native FEM
CPU backend can be considered production-ready. It intentionally separates
available local contract timings from the still-missing active MFEM-stack
benchmarks.

## Required Baseline Families

| Family | Required measurement | Status |
|---|---|---|
| Backend creation | mesh import, material projection, FE space setup | open |
| Exchange | assembly time, apply time, mass projection mode | open |
| Demag Poisson | RHS assembly, solve, recovery, energy, linear iterations | telemetry exists; baseline open |
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

The current local environment cannot produce active MFEM-stack baselines because
configure fails before compilation:

```text
.fullmag/runtimes/fem-gpu-host/include
```

The no-MFEM contract suite is still useful as a fast regression gate, but it
must not be treated as a performance baseline for the production FEM CPU path.
