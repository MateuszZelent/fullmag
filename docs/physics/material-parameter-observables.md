# Material Parameter Observables

- Status: draft
- Owners: Fullmag maintainers
- Last updated: 2026-06-08
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/05-viewport-architecture.md`

## 1. Problem statement

Users need to inspect the resolved spatial distribution of authored material
parameters in the control room. This is required for debugging region-owned
overrides, gradients, granular materials, and future stochastic material
realizations before trusting a simulation result.

The observable is not the authored scalar alone. It is the material parameter
after the public model, object ownership, region overrides, material fields, and
mesh/domain realization have been resolved for the current numerical domain.

## 2. Physical model

### 2.1 Governing equations

The observables are coefficients used by the micromagnetic equations rather
than new physical interactions:

- `mat_ms(x)` is the saturation magnetization \(M_s(x)\).
- `mat_aex(x)` is the exchange stiffness \(A(x)\).
- `mat_alpha(x)` is the Gilbert damping \(\alpha(x)\).
- `mat_dind(x)` is the interfacial DMI coefficient \(D_\mathrm{ind}(x)\).
- `mat_dbulk(x)` is the bulk DMI coefficient \(D_\mathrm{bulk}(x)\).

They are displayed as scalar fields over the magnetic domain.

### 2.2 Symbols and SI units

| Quantity ID | Symbol | Unit | Shape |
|---|---:|---:|---|
| `mat_ms` | \(M_s\) | A/m | spatial scalar |
| `mat_aex` | \(A\) | J/m | spatial scalar |
| `mat_alpha` | \(\alpha\) | 1 | spatial scalar |
| `mat_dind` | \(D_\mathrm{ind}\) | J/m^2 | spatial scalar |
| `mat_dbulk` | \(D_\mathrm{bulk}\) | J/m^3 | spatial scalar |

### 2.3 Assumptions and approximations

The observable represents the coefficient value used by the backend on the
current domain. Uniform materials produce constant scalar fields. Authored
material parameter fields produce their sampled/resolved values. Region-owned
overrides are valid only when the mesh/materialization policy makes their
boundary semantics explicit.

## 3. Numerical interpretation

### 3.1 FDM

FDM material observables live on cells. For `mat_ms`, `mat_aex`, and
`mat_alpha`, the CPU reference backend reads the same per-cell coefficient
accessors used by the solver. If a field is absent, the uniform material value is
expanded to all active cells.

### 3.2 FEM

FEM material observables live on the resolved solver mesh. Node- or
element-location metadata must match the backend coefficient realization.
Sharp region overrides require conformal boundaries in strict mode; projection
is an explicit extended-mode approximation.

### 3.3 Hybrid

Hybrid execution must expose the resolved material quantity per active solver
domain and must not merge incompatible FDM/FEM locations into one unlabelled
buffer.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No new Python authoring API is required. Existing `Material`, object material
fields, and `ObjectRegion.material.*` overrides are the source of authored
intent.

### 4.2 ProblemIR representation

No new ProblemIR field is required for this observable family. The observables
derive from existing material fields and region-owned material override
semantics.

### 4.3 Planner and capability-matrix impact

The canonical quantity catalog owns `mat_*` metadata. Backends mark material
observables as derived when they can expose the resolved coefficient arrays.
Unsupported coefficient arrays must fail as unavailable data resources rather
than returning fabricated zeros.

## 5. Validation strategy

### 5.1 Analytical checks

Uniform material inputs produce constant scalar fields with the authored SI
value. Linear or sampled material fields produce the expected min/max and
per-cell/per-node samples.

### 5.2 Cross-backend checks

For equivalent discretized domains, FDM and FEM should agree on uniform
material values. Region and gradient checks compare against the resolved
backend domain and its documented location semantics.

### 5.3 Regression tests

- quantity catalog tests for `mat_*` IDs, units, shape, and preview support,
- backend tests that `mat_ms`, `mat_aex`, and `mat_alpha` expose real FDM CPU
  coefficient fields,
- API tests that `n_comp=1` material scalar resources use the existing field
  data-plane,
- viewport tests that scalar/component colorbars appear for numeric coloring
  and stay hidden for HSL orientation coloring.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

The first implementation exposes resolved FDM CPU `mat_ms`, `mat_aex`, and
`mat_alpha`. FEM material observables and DMI coefficient accessors require
backend-specific coefficient extraction and must preserve node/element location
metadata.

## 8. References

- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/specs/frontend-v2/05-viewport-architecture.md`
