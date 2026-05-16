# FEM CPU PBC Demag Warm-Start Design

Date: 2026-05-15

## Scope

This slice is CPU-only Rust FEM reference work. It does not modify native MFEM,
CUDA, GPU state, provenance device ownership, or any GPU hot-loop code.

## Problem

The Rust FEM reference path already has the algebraic PBC demag reduction:

`A_red = P^T A_open P`, `b_red = P^T b`, `phi_full = P q`.

However, the reduced CG solve still reinitializes the reduced potential to zero
for every solve. In time-domain stepping, consecutive magnetization states are
close, so the previous scalar potential is a physically valid initial guess for
the next Poisson solve. Starting from zero discards useful state and makes the
PBC demag CPU reference slower than necessary.

There is also stale validation text that rejects PBC demag even though the
reduced operator path exists. That guard blocks the reference semantics from
matching the implementation.

## Design

Add an internal warm-start option to the shared sparse-CG core:

- cold solves keep the existing behavior: `x = 0`, `r = b`;
- warm solves keep the current `ws.x` as the initial guess and compute
  `r = b - A x`;
- the Jacobi preconditioned CG recurrence is otherwise unchanged.

Only `periodic_robin_demag_observables_from_vectors` uses the warm-start mode.
The non-PBC Robin/Dirichlet path remains cold-started in this slice so the diff
stays scoped to the approved PBC demag item.

## Physics Semantics

Warm-start changes only the iterative solver initial guess. It does not change:

- the demag Poisson equation,
- the reduced periodic operator,
- RHS assembly,
- field recovery `H_demag = -grad(phi)`,
- class projection,
- the energy identity `E = 0.5 mu0 q^T b_red`.

With a converged solve the physical result is unchanged. With an intentionally
low iteration cap, the warm-start result is the previous potential approximation
instead of the zero field, which is the intended performance-oriented behavior.

## Validation

1. RED test: after one converged PBC demag solve, cap the next reduced solve at
   zero iterations and verify that the direct PBC demag call reuses the previous
   reduced potential instead of returning a zero-start field.
2. Update the stale reference-semantics test so PBC + demag is accepted in the
   Rust CPU reference path.
3. Run targeted FEM engine tests and formatting checks.
