# Native FEM CPU PBC demag reduced warm-start

- Status: draft
- Owners: Fullmag solver/runtime
- Last updated: 2026-05-15
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/physics/0800-fem-static-pbc-demag.md`

## 1. Problem statement

The native MFEM FEM CPU path already builds a reduced periodic Poisson system
for demag with the algebraic operator `A_p = P^T A_open P`, but the hot path
created a serial `CGSolver` and `GSSmoother` on every demag solve and reset the
reduced potential to zero before each solve.

That is not a physics change, but it is a CPU performance defect for
time-domain PBC demag: consecutive demag solves usually have nearby
magnetization states, so the previous reduced scalar potential is a valid and
useful Krylov initial guess.

This slice is CPU-only. It does not introduce a GPU/device PBC demag path.

## 2. Physical model

### 2.1 Governing equations

The physical model is unchanged from `0800-fem-static-pbc-demag.md`:

```text
div(H_demag + M) = 0
H_demag = -grad(phi)
A_p phi_p = b_p
A_p = P^T A_open P
b_p = P^T b
phi_full = P phi_p
```

The reduced operator, right-hand side, lifted potential, demag field, and
energy remain unchanged. Warm-start changes only the iterative solver initial
guess.

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `M` | magnetization | A/m |
| `H_demag` | demagnetizing field | A/m |
| `phi` | scalar magnetic potential | A |
| `A_p` | reduced periodic Poisson operator | m |
| `b_p` | reduced periodic Poisson RHS | A m |
| `E_demag` | demag energy | J |

### 2.3 Assumptions and approximations

- Periodic node pairs define algebraic equivalence classes.
- At least one open air/Robin boundary remains; fully periodic 3D demag is not
  part of this slice.
- The previous reduced potential is reused only as a numerical initial guess.
- Solver tolerance and maximum iterations remain controlled by the existing
  native demag solver policy.

## 3. Numerical interpretation

### 3.1 FDM

No FDM change.

### 3.2 FEM

The native MFEM CPU PBC demag path keeps context-owned reduced RHS and solution
vectors. The reduced solution vector is initialized to zero once when the
Poisson context is created, then retained across subsequent solves as the
warm-start vector. A context-owned serial reduced solver workspace owns the
`CGSolver`, `GSSmoother`, and lifted full solution buffer to avoid hot-path
solver/preconditioner and full-solution allocation churn.

This remains a serial reduced sparse solve. It is a CPU optimization step, not
the final hypre/AMG implementation for PBC demag.

### 3.3 Hybrid

No hybrid change.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public Python API change.

### 4.2 ProblemIR representation

No `ProblemIR` schema change.

### 4.3 Planner and capability-matrix impact

No new capability is unlocked. Native PBC demag should still be reported as a
limited CPU reduced-solve path until the hypre/AMG implementation exists.

## 5. Validation strategy

### 5.1 Analytical checks

No new analytical oracle is required; this does not alter the linear system.

### 5.2 Cross-backend checks

Existing PBC demag repeated-supercell checks remain the reference oracle.

### 5.3 Regression tests

- Source regression: the native periodic reduced solve must use
  `mfem_periodic_poisson_workspace`.
- Source regression: the native periodic reduced solve must not reset `x_p` to
  zero in the hot path.
- Build regression: `just rebuild-fem-runtime` must compile the native bridge.

## 6. Completeness checklist

- [x] Python API: unchanged
- [x] ProblemIR: unchanged
- [x] Planner: unchanged
- [x] Capability matrix: unchanged
- [ ] FDM backend: unchanged
- [x] FEM backend: context-owned native CPU reduced solver workspace
- [ ] Hybrid backend: unchanged
- [ ] Outputs / observables: unchanged
- [x] Tests / benchmarks: source regression, native rebuild, and CPU demag smoke
- [x] Documentation

## 7. Known limits and deferred work

- Native PBC demag still uses a serial reduced sparse solve in this slice.
- Hypre/AMG for the reduced PBC operator remains deferred.
- GPU/device-resident PBC demag remains deferred.

## 8. References

- `docs/physics/0800-fem-static-pbc-demag.md`
- `native/backends/fem/src/mfem_bridge.cpp`
