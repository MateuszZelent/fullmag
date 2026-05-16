# FEM CPU DMI Loop Design

- Status: approved
- Date: 2026-05-15
- Scope: CPU-only Rust FEM reference path, `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md` Etap 8.4

## Goal

Unify the duplicated Rust FEM reference DMI element loop used by:

- `dmi_fields_from_vectors`
- `dmi_fields_add_into`

The CPU reference path should keep one implementation of the current DMI
bootstrap field formula so future physics fixes cannot land in only one branch.

## Physics Boundary

No DMI equation changes in this slice.

The current Rust reference model remains the documented bootstrap:

- interfacial DMI strong-form P1 field:
  `H = (2D / mu0 Ms) [grad(m dot n) - n div(m)]`
- bulk DMI strong-form P1 field:
  `H = -(2D / mu0 Ms) curl(m)`
- lumped-mass nodal recovery from element accumulations
- static periodic class projection when periodic pairs are present

This slice is hygiene and allocation control for the CPU path only. It does not
implement the future weak-residual / mass-projection DMI formulation.

## Architecture

Add one shared helper in `crates/fullmag-engine/src/fem.rs`:

- it computes interfacial and bulk DMI fields into caller-provided buffers,
- it zeroes and reuses those buffers,
- it owns the single element loop,
- both allocating and in-place callers use it.

Extend `FemFieldScratch` with reusable DMI buffers so
`effective_field_into_scratch` does not allocate separate DMI field vectors in
the integration hot path.

## Non-Goals

This slice does not touch:

- native MFEM/C++,
- CUDA/GPU paths,
- `FemGpuState`,
- ProblemIR or Python DSL,
- DMI weak residuals,
- boundary-condition physics.

## Validation

- A source-level test asserts there is one DMI element loop in `fem.rs`.
- A behavior test compares `dmi_fields_from_vectors` with the in-place path by
  adding DMI into an initially-zero field and requiring identical results.
- Existing DMI tests still cover interface-normal sensitivity, bulk nonzero
  behavior, periodic pair equality, and uniform bulk-DMI zero field.
