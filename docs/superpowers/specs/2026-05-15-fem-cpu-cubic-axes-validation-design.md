# FEM CPU Cubic Axes Validation Design

## Context

`docs/reports/15.05.2026/fem-solver-physics-performance-audit.md` keeps Etap 8
open for cubic anisotropy axis validation drift. Native CPU FEM already rejects
invalid cubic axes, while the Rust FEM reference normalizes `axis1` and `axis2`
with `max(ZERO_THRESHOLD)` and can silently build a degenerate basis.

## Decision

Implement the CPU-only variant A:

1. Treat native C++ CPU tolerances as the parity source.
2. Add Rust FEM reference validation for finite, non-zero, mutually orthogonal
   cubic axes.
3. Add FEM planner validation with the same error message before runtime.
4. Keep non-unit but orthogonal axes valid because native CPU normalizes them.
5. Do not touch GPU runtime, CUDA, `FemGpuState`, or MFEM GPU files.

## Physics Contract

The cubic basis is `c1 = normalize(axis1)`, `c2 = normalize(axis2)`, and
`c3 = c1 x c2`. A valid cubic anisotropy basis requires:

- finite axis components,
- `norm(axis1) > 1e-30`,
- `norm(axis2) > 1e-30`,
- `abs(dot(c1, c2)) <= 1e-3`,
- `norm(c1 x c2) >= 1e-6`.

Invalid axes return:

```text
cubic anisotropy axes must be finite, normalized and mutually orthogonal
```

## Implementation Boundaries

- `crates/fullmag-engine/src/fem.rs`: add a small helper for cubic basis
  validation and call it from `validate_reference_semantics`.
- `crates/fullmag-plan/src/fem.rs`: add an equivalent planner-side validation
  helper and call it for the base material and region materials before building
  the final `FemPlanIR`.
- `crates/fullmag-plan/src/tests.rs`: add planner regression coverage.
- `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`: mark Etap
  8.5 closed for CPU planner/reference if tests pass.

## Testing

Use TDD:

1. Add a Rust FEM reference test that invalid parallel cubic axes fail.
2. Add a Rust FEM reference test that non-unit orthogonal axes pass.
3. Add a planner test that invalid cubic axes are rejected.
4. Run targeted tests, formatting, and `git diff --check`.

## Non-Goals

- No DMI weak residual work.
- No partial assembly/libCEED work.
- No GPU implementation changes.
- No public Python DSL shape changes.
