# FEM DMI Weak-Residual CPU Projection

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related physics notes:
  - `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md`
  - `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md`
- Related audit:
  - `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

## 1. Problem statement

The Rust FEM CPU reference path previously computed interfacial and bulk DMI as a strong-form P1 field with lumped nodal averaging. That path was useful as a bootstrap, but it was not the production FEM contract described by the DMI notes.

This CPU-only slice replaces that bootstrap with weak-residual assembly and lumped mass projection inside the Rust FEM reference path. Native MFEM/libCEED/CUDA ownership remains out of scope for this note.

## 2. Physical model

### 2.1 Governing equations

Interfacial DMI with interface normal `z` uses

```text
w_iDMI = D [m_z (d_x m_x + d_y m_y) - m_x d_x m_z - m_y d_y m_z].
```

The target FEM object is

```text
R_iDMI(m; v) = integral [
  dw/dm · v + dw/d(grad m) : grad v
] dV.
```

Bulk DMI uses

```text
E_bDMI = D integral m · curl(m) dV
R_bDMI(m; v) = D integral [v · curl(m) + m · curl(v)] dV.
```

For an LLG field output, the projected DMI field must satisfy

```text
mu0 integral M_s H_DMI,h · v_h dV = -R_DMI(m_h; v_h).
```

The Rust CPU reference realizes this relation with the existing lumped nodal volumes:

```text
H_i = -g_i / (mu0 M_s V_i),
```

where `g_i` is the assembled DMI residual vector for node `i`.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `v` | admissible FE perturbation | 1 |
| `D` | interfacial or bulk DMI constant used by the existing terms | J/m^2 in the current notes |
| `M_s` | saturation magnetization | A/m |
| `H_DMI` | projected DMI effective field | A/m |
| `R_DMI` | first-variation residual | J |

### 2.3 Assumptions and approximations

- The implementation is CPU-only and belongs to the Rust FEM reference path.
- The implementation uses affine P1 tetrahedral fields, where centroid quadrature is exact for the bilinear residual terms used here.
- It implements the CPU reference weak-residual DMI projection, not the native MFEM/libCEED production QFunction.
- It must not touch native MFEM, CUDA, GPU state, or GPU hot-loop artifacts.

## 3. Numerical interpretation

### 3.1 FDM

No FDM behavior changes.

### 3.2 FEM

The CPU reference implementation verifies one scalar identity for the same `m` and perturbation `v`:

```text
-mu0 Ms sum_i V_i H_i · v_i = R_DMI(m; v).
```

This identity is the lumped-mass version of the weak residual projection required by the FEM DMI notes.

### 3.3 Hybrid

No hybrid behavior changes.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public Python API change.

### 4.2 ProblemIR representation

No ProblemIR change.

### 4.3 Planner and capability-matrix impact

No planner or capability change. The Rust CPU reference now owns a weak-residual lumped projection baseline. Native MFEM/libCEED/CUDA DMI residual/QFunction work remains open.

## 5. Validation strategy

### 5.1 Analytical checks

Use one unit tetra with non-uniform nodal `m` and a non-uniform perturbation `v`. Compute the interfacial and bulk weak residual actions from the documented formulas and compare them with the field action recovered by lumped mass projection.

### 5.2 Cross-backend checks

None in this slice. Native MFEM/GPU work is out of scope.

### 5.3 Regression tests

- `interfacial_dmi_lumped_projection_matches_weak_residual_on_free_tet`
- `bulk_dmi_lumped_projection_matches_weak_residual_on_free_tet`

Both tests protect the CPU reference path from regressing back to strong-form nodal averaging.

## 6. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend
- [x] FEM CPU reference weak-residual projection
- [ ] Hybrid backend
- [ ] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

- Native MFEM/libCEED QFunctions still need their own residual implementation.
- Consistent mass projection remains a future high-fidelity diagnostic path.

## 8. References

- `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md`
- `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md`
- `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
