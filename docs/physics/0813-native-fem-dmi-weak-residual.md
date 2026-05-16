# Native FEM DMI Weak-Residual Projection

- Status: implementation note
- Owners: Fullmag core
- Last updated: 2026-05-15
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md`
  - `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md`
  - `docs/physics/0812-fem-dmi-weak-residual-proof-fixture.md`
- Related audit:
  - `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

## 1. Problem statement

The native MFEM FEM backend still computes interfacial and bulk DMI through a
strong-form nodal averaging bootstrap. That is not the production FEM contract
defined in the DMI physics notes. The production baseline must assemble the
first-variation residual and recover the observable field by lumped mass
projection:

```text
mu0 int Ms H_DMI,h . v_h dV = -R_DMI(m_h; v_h).
```

This slice moves the native CPU/MFEM DMI path to that baseline. It does not add
the future libCEED/CUDA QFunction path.

## 2. Physical model

### 2.1 Governing equations

Interfacial DMI with interface normal `n` uses the energy density

```text
w_iDMI = D [(m . n) div(m) - m . grad(m . n)].
```

At a quadrature point with `G[component][direction] = d m_component / d x_direction`,

```text
dw/dm = D [n div(m) - grad(m . n)]
dw/dG[c][d] = D [(m . n) delta_cd - n_c m_d].
```

The residual contribution for test function `v` is

```text
R_iDMI(m; v) = int [dw/dm . v + dw/dG : grad(v)] dV.
```

Bulk DMI uses

```text
E_bDMI = D int m . curl(m) dV
R_bDMI(m; v) = D int [v . curl(m) + m . curl(v)] dV.
```

The native projected field is recovered node-wise as

```text
H_i = -g_i / (mu0 Ms_i M_lumped_i),
```

where `g_i` is the assembled residual vector for node `i`.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `v` | FE perturbation/test function | 1 |
| `D` | DMI constant used by existing Fullmag terms | J/m^2 |
| `Ms` | saturation magnetization | A/m |
| `mu0` | vacuum permeability | N/A^2 |
| `g_i` | DMI residual at node `i` | J |
| `M_lumped_i` | lumped mass / dual volume at node `i` | m^3 |
| `H_DMI` | DMI effective field | A/m |

### 2.3 Assumptions and approximations

- The implementation targets the native CPU/MFEM path.
- The first supported projection is lumped mass, matching explicit RK and the
  Rust reference proof fixture.
- `Ms_i` and `D_i` may remain nodal coefficient fields; this slice uses the
  existing element-average `D` bootstrap for native parity with the current
  data model.
- Periodic class projection remains after field recovery, as in the current
  native path.
- Consistent mass projection and libCEED/CUDA QFunctions are deferred.

## 3. Numerical interpretation

### 3.1 FDM

No FDM behavior changes.

### 3.2 FEM

For each magnetic element:

1. interpolate `m_q` and `grad(m)_q` at quadrature,
2. compute the DMI residual contribution for every local node and vector
   component,
3. accumulate into a node residual buffer,
4. after all elements, project with
   `H_i = -g_i / (mu0 Ms_i M_lumped_i)`.

For affine P1 tetrahedra this matches the Rust reference identity protected by
`interfacial_dmi_lumped_projection_matches_weak_residual_on_free_tet` and
`bulk_dmi_lumped_projection_matches_weak_residual_on_free_tet`.

### 3.3 Hybrid

No hybrid behavior changes. Hybrid/runtime selection observes the same field
names and provenance.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public Python API change.

### 4.2 ProblemIR representation

No `ProblemIR` schema change.

### 4.3 Planner and capability-matrix impact

No planner capability vocabulary change. This is a native backend numerical
realization repair for existing DMI terms.

## 5. Validation strategy

### 5.1 Analytical checks

Use the same single-tetra field-action identity as the Rust reference:

```text
-mu0 Ms sum_i M_lumped_i H_i . v_i = R_DMI(m; v).
```

The native formula helper must reproduce this identity for both interfacial and
bulk DMI on a non-uniform P1 tetra. It must also check the equivalent energy
directional derivative:

```text
dE_DMI(m + eps v) / d eps | eps=0 = -mu0 Ms sum_i M_lumped_i H_i . v_i.
```

### 5.2 Cross-backend checks

The native helper and Rust reference use the same equations. A future MFEM host
test should compare native observable `H_DMI` / `H_DMI_BULK` against the Rust
reference on the same fixture.

### 5.3 Regression tests

- `native/backends/fem/tests/dmi_weak_residual.cpp`
- Existing Rust reference DMI tests in `crates/fullmag-engine/src/fem.rs`

## 6. Completeness checklist

- [x] Python API: no change required
- [x] ProblemIR: no change required
- [x] Planner: no change required
- [x] Capability matrix: no change required
- [x] FDM backend: no change required
- [x] FEM backend: native CPU/MFEM DMI source path uses weak residual plus lumped projection
- [x] Hybrid backend: no change required
- [x] Outputs / observables: existing `H_DMI` and `H_DMI_BULK`
- [x] Tests / benchmarks: native formula regression, directional-derivative oracle, plus targeted engine test
- [x] Documentation

## 7. Known limits and deferred work

- The native implementation still uses host-side element loops, but the CPU
  path now reuses context-owned DMI element scratch instead of allocating MFEM
  local vectors/matrices inside the hot loop.
- libCEED/CUDA QFunctions remain the production performance target.
- Full MFEM runtime parity must still be rerun on an MFEM-equipped host; this
  slice was locally verified with the MFEM-free formula smoke and Rust oracle
  tests.
- Consistent mass projection remains deferred for diagnostics.
- Region-interface DMI and lower-symmetry bulk DMI tensors remain out of scope.

## 8. References

- `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md`
- `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md`
- `docs/physics/0812-fem-dmi-weak-residual-proof-fixture.md`
- `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
