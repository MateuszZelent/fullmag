# FEM Poisson RHS Workspace Design

- Status: approved
- Date: 2026-05-15
- Scope: `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md` B3

## Goal

Remove per-solve allocation of the native FEM Poisson demag RHS `LinearForm`
and its integrator without changing the demagnetization equation, boundary
condition semantics, telemetry, or solver provenance.

## Architecture

The slice is a narrow hot-path workspace reuse change.  The existing native
MFEM Poisson demag realization keeps the same weak form,

```text
int_D grad(u) . grad(v) dV = int_Omega_m M . grad(v) dV,
H_demag = -grad(u).
```

`context_initialize_poisson` owns a reusable RHS workspace for the scalar
potential finite element space.  `assemble_poisson_rhs` updates the workspace
with the current magnetization, zeros the reusable linear form, reassembles
into the existing storage, and copies/restricts into a reusable true-DOF RHS
vector.

## Lifetime Contract

The current `MagnetizationCoefficient` stores a reference to the input
`m_xyz`.  That is safe only for the current stack-allocated linear form.  A
reusable `LinearForm` must not keep an integrator whose coefficient points to a
dead per-call vector.

The implementation therefore needs a persistent RHS workspace object whose
coefficient stores a pointer to the current magnetization and is updated before
each assemble.  The linear form owns its integrator; the workspace owns the
coefficient and linear form lifetime together.

## Non-Goals

This slice does not implement:

- hypre/MFEM zero-copy vector transfers,
- device-side demag field recovery,
- partial assembly or libCEED RHS kernels,
- PBC reduced-system solver changes,
- DMI weak residuals.

Those remain separate B4/B5/B1/DMI slices.

## Validation

The validation layer is intentionally narrow:

- a source-level regression test must fail while `assemble_poisson_rhs` creates
  a local `mfem::LinearForm b(fes)` or calls `AddDomainIntegrator` in the hot
  path;
- native FEM demag tests must still pass on MFEM-enabled hosts and preserve
  `demag_solve_count`, Poisson iteration/residual reporting, and `H_demag`
  publication;
- documentation must record that this is an allocation/lifetime optimization,
  not a physical model change.
