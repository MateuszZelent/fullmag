# Native FEM CPU local energy cache

- Status: implemented
- Owners: Fullmag solver/runtime
- Last updated: 2026-05-15
- Related ADRs: `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/physics/0813-native-fem-dmi-weak-residual.md`
  - `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`

## 1. Problem statement

The native FEM CPU effective-field path already evaluates local fields for the
current magnetization: uniaxial/cubic anisotropy, interfacial DMI, bulk DMI,
and magnetoelastic field. Before this slice, step-stat collection recomputed
several of those fields only to recover energies for `StepStats`.

This slice removes that duplicated work by storing local energies computed by
the effective-field evaluation and reusing them when filling step metrics.

## 2. Physical model

### 2.1 Governing equations

No governing equation changes. The cached values are the same energies that
are already computed alongside the fields:

```text
E_total = E_ex + E_demag + E_ext + E_ani + E_DMI + E_mel
```

The individual energy definitions remain unchanged:

- anisotropy: current uniaxial and cubic anisotropy energy density contracts,
- DMI: weak-residual DMI energy contracts,
- magnetoelastic: current prescribed-strain magnetoelastic contract.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `E_ani` | uniaxial plus cubic anisotropy energy | J |
| `E_DMI` | interfacial plus bulk DMI energy | J |
| `E_mel` | magnetoelastic energy | J |
| `H_eff` | effective field used by LLG RHS | A/m |

### 2.3 Assumptions and approximations

- `compute_effective_fields_for_magnetization_impl` is the authoritative local
  field/energy evaluation for the magnetization state it receives.
- `fill_common_step_metrics` is called after the final/snapshot effective-field
  evaluation for the state being reported.
- External field energy stays cheap and is computed directly from `m` and
  `H_ext` in `fill_common_step_metrics`.

## 3. Numerical interpretation

### 3.1 FDM

No FDM change.

### 3.2 FEM

The native FEM context stores the last local energy values produced during the
effective-field evaluation. Step metrics copy those values into
`fullmag_fem_step_stats` instead of recomputing local fields. This removes
duplicate element loops for DMI and duplicate local-field writes for
anisotropy and magnetoelastic terms.

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

Energy formulas are unchanged; existing DMI and anisotropy tests remain the
physics oracle.

### 5.2 Cross-backend checks

Existing Rust CPU DMI and anisotropy tests remain the reference baseline.

### 5.3 Regression tests

- Source regression: `fill_common_step_metrics` must not call local field
  evaluators for anisotropy, DMI, or magnetoelastic terms.
- Runtime smoke: CPU `exchange_dmi` must still complete and export `e_dmi`.

## 6. Completeness checklist

- [x] Python API: unchanged
- [x] ProblemIR: unchanged
- [x] Planner: unchanged
- [x] Capability matrix: unchanged
- [x] FDM backend: unchanged
- [x] FEM backend: local energies cached during effective-field evaluation
- [x] Hybrid backend: unchanged
- [x] Outputs / observables: same `StepStats` fields
- [x] Tests / benchmarks: source regression, native rebuild, CPU DMI smoke
- [x] Documentation

## 7. Known limits and deferred work

- This is not a libCEED/QFunction implementation.
- This does not remove the accepted final effective-field evaluation itself.
- External energy remains computed in `fill_common_step_metrics`.

## 8. References

- `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md`
- `native/backends/fem/src/mfem_bridge.cpp`
