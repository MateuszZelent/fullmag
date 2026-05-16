# FEM Cubic Anisotropy Axis Validation

## Physical Problem Statement

Cubic magnetocrystalline anisotropy in FEM requires a right-handed local cubic basis
`c1`, `c2`, `c3`, where `c1` and `c2` are user-authored material axes and
`c3 = c1 x c2`. The basis is physical only when `c1` and `c2` are finite,
non-zero, and mutually orthogonal after normalization.

## Governing Equation

For unit magnetization `m`, Fullmag uses the cubic anisotropy energy density

```text
E_cub = Kc1 (m1^2 m2^2 + m2^2 m3^2 + m3^2 m1^2)
      + Kc2 (m1^2 m2^2 m3^2)
```

where `mi = m dot ci`, `Kc1` and `Kc2` are in `J m^-3`, and the recovered
effective field is `H_cub = -(1 / (mu0 Ms)) dE_cub/dm`.

## Units And Validity

- `axis1`, `axis2`: dimensionless direction vectors.
- `Kc1`, `Kc2`, `Kc3`: `J m^-3`; the current Rust CPU reference uses `Kc1`
  and `Kc2`.
- `Ms`: `A m^-1`.
- `H_cub`: `A m^-1`.

The contract accepts non-unit axes, normalizes them once, and rejects axes that
cannot form a finite orthogonal basis. It does not Gram-Schmidt or silently
repair nonorthogonal user input.

## FEM Interpretation

The Rust FEM CPU reference and native CPU FEM must use the same validation
contract:

- reject non-finite axis components,
- reject zero-norm axes,
- reject `abs(dot(c1, c2)) > 1e-3` after normalization,
- reject `norm(c1 x c2) < 1e-6`.

This preserves the current P1/lumped-mass FEM interpretation and only closes a
semantic validation gap. It does not change the cubic energy equation.

## FDM Interpretation

This note does not change the FDM implementation. The validation rule is still
the correct physical contract for any future shared material validator.

## CPU/GPU Scope

This slice is CPU-only. Native C++ CPU already validates the axes with this
contract. The Rust FEM reference and FEM planner are aligned to that contract.
No GPU hot-loop, GPU state, CUDA, or MFEM GPU ownership changes are part of this
note.

## Public API And IR Impact

The public Python DSL and `ProblemIR` field names do not change. Invalid cubic
axis values become planner/reference errors instead of silently producing a
degenerate or nonphysical basis.

## Planner, Runtime, And Provenance Impact

The FEM planner rejects invalid cubic anisotropy axes before runtime with the
same message as native CPU:

```text
cubic anisotropy axes must be finite, normalized and mutually orthogonal
```

Runtime provenance is unchanged because this is input validation, not a new
execution mode.

## Validation Strategy

Regression tests must cover:

1. Rust FEM reference rejects parallel cubic axes.
2. Rust FEM reference accepts non-unit but orthogonal axes.
3. FEM planner rejects invalid cubic axes before runtime.

## Completeness Checklist

- [x] Rust FEM reference validates cubic axes.
- [x] FEM planner validates cubic axes.
- [x] Native CPU contract remains the source of tolerance parity.
- [x] Tests cover invalid and accepted axes.
- [x] No GPU files are modified.

## Deferred Work

This note does not implement weak-form anisotropy residuals, consistent-mass
projection, or a shared all-backend material validator.
