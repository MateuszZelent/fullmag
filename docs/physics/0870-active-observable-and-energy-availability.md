# Active Observable and Energy Availability

- Status: draft
- Owners: Fullmag maintainers
- Last updated: 2026-04-30
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`

## 1. Problem statement

Field and energy observables are physical consequences of active interaction terms. A control-room command such as `compute_fields` must not try to materialize every catalog quantity just because the backend knows the name. If anisotropy, DMI, Zeeman, thermal, Oersted, or magnetoelastic terms are absent from the current plan, their separate fields and energies are unavailable for that problem.

## 2. Physical model

### 2.1 Governing equations

The effective field remains the sum of active contributions:

```text
H_eff = H_ex + H_demag + H_ext + H_ani + H_dmi + H_mel + H_Oe + H_therm + ...
```

Each addend exists only when its corresponding term is present in the canonical problem and executable in the resolved backend. A disabled term contributes neither a separate observable field nor an energy component.

### 2.2 Symbols and SI units

- `H_*`: effective-field contribution, A/m
- `E_*`: integrated energy contribution, J
- `m`: reduced magnetization, dimensionless
- `K_u`, `K_c`: anisotropy constants, J/m^3
- `D`: DMI constant, J/m^2 for interfacial DMI or J/m^3 for bulk DMI

### 2.3 Assumptions and approximations

Zero-valued explicit terms may still be considered active when they are present in the lowered plan. Missing terms are inactive. Backend capability means "can compute this class of observable"; plan availability means "this observable is meaningful for this concrete problem".

## 3. Numerical interpretation

### 3.1 FDM

FDM `m` and `H_eff` are always displayable. `H_ex`, `H_demag`, `H_ext`, `H_Oe`, anisotropy, DMI, magnetoelastic, and thermal observables require their respective lowered plan flags or parameters. A backend may support fewer separate fields than the physical plan contains; in that case the field can be folded into `H_eff` but must not be advertised as a separate observable.

### 3.2 FEM

FEM follows the same rule on node fields. The shared-domain mesh does not make all interactions active. Air/domain presence affects the spatial domain of supported quantities, not whether anisotropy or DMI exists.

### 3.3 Hybrid

Hybrid execution must intersect physical plan activity with each participating backend's observable support before publishing a quantity as available.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public Python syntax changes. Availability is derived from existing energy terms and lowered plan parameters.

### 4.2 ProblemIR representation

No new IR fields are required. The lowered FDM/FEM plans already carry `enable_exchange`, `enable_demag`, optional external field, material anisotropy constants, DMI constants, thermal configuration, Oersted/current modules, and magnetoelastic configuration.

### 4.3 Planner and capability-matrix impact

Runtime capability remains backend-level potential support. Session quantity availability must additionally apply the current execution plan. Scalar energy descriptors must not become available solely because a scalar row exists.

## 5. Validation strategy

### 5.1 Analytical checks

For an exchange-only problem, only `m`, `H_ex`, `H_eff`, `E_ex`, and `E_total` are active among standard micromagnetic observables.

### 5.2 Cross-backend checks

Compare FDM and FEM filtering against equivalent active terms. Backend-specific unsupported separate observables must be absent even when the physical term is folded into `H_eff`.

### 5.3 Regression tests

Add unit tests that filter cached preview quantities by active FDM/FEM terms and tests that mark disabled scalar energy components unavailable.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

The static browser catalog remains a name catalog. The session-scoped quantity resource should become the only UI source for `available` and `interactive_preview` once the resource-first quantity endpoint fully replaces transitional static catalogs.

## 8. References

- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/adr/0011-resource-first-api.md`
