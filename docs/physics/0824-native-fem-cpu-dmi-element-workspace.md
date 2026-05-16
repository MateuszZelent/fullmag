# Native FEM CPU DMI element workspace

- Status: draft
- Owners: Fullmag solver/runtime
- Last updated: 2026-05-15
- Related ADRs: `docs/adr/0001-physics-first-python-api.md`
- Related specs: `docs/physics/0813-native-fem-dmi-weak-residual.md`

## 1. Problem statement

Native FEM CPU interfacial and bulk DMI already use the weak-residual plus
lumped projection contract. The remaining CPU performance defect in this slice
is allocation churn inside the DMI element loops: local MFEM vectors and
matrices are created repeatedly while traversing elements/quadrature points.

This slice keeps the DMI physics unchanged and moves only the scratch storage
to a context-owned workspace.

## 2. Physical model

### 2.1 Governing equations

The governing equations remain those from
`0813-native-fem-dmi-weak-residual.md`:

```text
R_iDMI(m; v) = int [dw/dm . v + dw/dG : grad(v)] dV
R_bDMI(m; v) = D int [v . curl(m) + m . curl(v)] dV
H_i = -g_i / (mu0 Ms_i M_lumped_i)
```

The workspace does not change `m_q`, `grad(m)`, shape functions, quadrature
weights, residual accumulation, energy density, periodic projection, or field
projection.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `D` | interfacial or bulk DMI constant | J/m^2 in current Fullmag terms |
| `m` | reduced magnetization | 1 |
| `v` | FE perturbation/test function | 1 |
| `R_DMI` | DMI first-variation residual | J |
| `M_lumped` | lumped mass / dual volume | m^3 |
| `H_DMI` | projected DMI effective field | A/m |

### 2.3 Assumptions and approximations

- The native CPU path remains host-side MFEM element traversal.
- Lumped projection remains the accepted explicit-RK baseline.
- Element-averaged `D` for nodal coefficient fields is unchanged.
- libCEED/CUDA residual QFunctions remain deferred.

## 3. Numerical interpretation

### 3.1 FDM

No FDM change.

### 3.2 FEM

The native context owns a `DmiElementWorkspace` containing reusable local DOF,
local magnetization component, shape, physical derivative, residual, and
periodic-projection scratch buffers. Interfacial and bulk DMI prepare that
workspace for the current element size and node count instead of allocating
new MFEM scratch objects in the hot element loop.

### 3.3 Hybrid

No hybrid change.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public Python API change.

### 4.2 ProblemIR representation

No `ProblemIR` schema change.

### 4.3 Planner and capability-matrix impact

No capability vocabulary change.

## 5. Validation strategy

### 5.1 Analytical checks

Existing weak-residual identities remain the physics oracle.

### 5.2 Cross-backend checks

Existing Rust CPU reference DMI tests remain the reference baseline.

### 5.3 Regression tests

- Source regression: native interfacial and bulk DMI must use
  `mfem_dmi_workspace`.
- Source regression: native DMI hot loops must not allocate local
  `mfem::Vector` or `mfem::DenseMatrix` scratch objects per element/quadrature.
- Build/runtime regression: native FEM runtime must rebuild and a CPU
  `exchange_dmi` smoke must complete.

## 6. Completeness checklist

- [x] Python API: unchanged
- [x] ProblemIR: unchanged
- [x] Planner: unchanged
- [x] Capability matrix: unchanged
- [x] FDM backend: unchanged
- [x] FEM backend: context-owned native CPU DMI workspace
- [x] Hybrid backend: unchanged
- [x] Outputs / observables: unchanged
- [x] Tests / benchmarks: source regression, native rebuild, CPU DMI smoke
- [x] Documentation

## 7. Known limits and deferred work

- The algorithm remains a host-side element loop.
- libCEED/CUDA QFunctions remain the production performance target.
- Directional derivative tests for full native MFEM host runtime remain open.

## 8. References

- `docs/physics/0813-native-fem-dmi-weak-residual.md`
- `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md`
- `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md`
