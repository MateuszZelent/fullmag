# FEM CPU PBC Demag Benchmark Fixture Design

Date: 2026-05-15

## Scope

This is a CPU-only Rust FEM reference fixture. It does not modify native MFEM,
CUDA, GPU state, GPU hot loops, or device source-of-truth ownership.

## Problem

The audit still marks the PBC demag benchmark as open because the benchmark
harness has no repository fixture with periodic node/boundary pairs. The Rust
reference path now has `P^T A P` reduction and reduced-CG warm-start, but there
is no stable, small, reproducible fixture that exercises that path and reports
basic reduced-solve timing context.

## Design

Add a `fullmag-engine` CPU fixture module that:

- builds a small structured FEM box mesh;
- keeps periodic metadata only for the x faces, leaving y and z open;
- constructs a Rust FEM reference problem with demag enabled and exchange
  disabled so the measured work is demag-dominated;
- runs repeated `observe()` calls on a deterministic non-uniform magnetization;
- returns structured metrics: nodes, elements, periodic pairs, warm-up count,
  measured repeat count, elapsed nanoseconds, demag energy, and max demag field.

Tests validate that the fixture has non-empty periodic metadata, open axes, a
nonzero demag field, non-negative demag energy, and positive elapsed time.
They do not assert speedup thresholds, because CI timing is not a benchmark
oracle.

## Physics Semantics

The fixture uses the existing PBC demag equations documented in
`docs/physics/0800-fem-static-pbc-demag.md`:

`A_p = P^T A_open P`, `b_p = P^T b(M)`, `H_demag = -grad(phi)`.

The benchmark wrapper changes no equations, no units, no boundary condition
semantics, and no solver tolerances. It is only a reproducible measurement
entry point for the CPU reference path.

## Validation

1. RED: integration test references the new fixture API and fails before the
   module exists.
2. GREEN: implement the fixture module and export it from `fullmag-engine`.
3. Verify with:
   - `cargo test -p fullmag-engine fem_pbc_demag_benchmark`
   - `cargo test -p fullmag-engine periodic_demag`
   - `cargo fmt --check -p fullmag-engine`
   - `git diff --check`
