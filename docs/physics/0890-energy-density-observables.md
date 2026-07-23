# Energy and energy-density observables

- Status: draft
- Owners: Fullmag
- Last updated: 2026-07-22
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/physics/0870-active-observable-and-energy-availability.md`, `docs/physics/0880-active-effective-field-terms.md`

## 1. Problem statement

Fullmag already exposes global energy scalars for active micromagnetic terms. The missing product capability is direct visualization and export of spatial energy density fields, analogous to mumax `Edens_*` and Boris per-module energy display, without turning energy display into a frontend-only derived overlay.

The canonical observable family is:

- global energies: `E_ex`, `E_demag`, `E_ext`, `E_ani`, `E_dmi`, `E_total` with SI unit `J`;
- spatial energy densities: `eden_ex`, `eden_demag`, `eden_ext`, `eden_ani`, `eden_dmi`, `eden_total` with SI unit `J/m^3`.

## 2. Physical model

### 2.1 Governing equations

For a normalized magnetization field `m` and saturation magnetization `M_s`, field-derived density terms use the same convention as the corresponding scalar energies:

```text
epsilon_ex    = -0.5 * mu0 * M_s * dot(m, H_ex)
epsilon_demag = -0.5 * mu0 * M_s * dot(m, H_demag)
epsilon_ext   = -1.0 * mu0 * M_s * dot(m, H_ext)
```

Anisotropy and coupled terms must use the same local energy model used by the backend scalar energy. They must not be redefined in the browser. `eden_total` is the pointwise sum of the active, available density terms.

For native FEM, `eden_ani` is the sum of every resolved anisotropy operator, including both uniaxial (`H_ani`) and cubic (`H_ani_cubic`) contributions. The term set for `eden_total` is resolved once from the same plan flags and material fields passed to the native backend; the preview path must not maintain a narrower, independently guessed term list.

The scalar consistency invariant is:

```text
E_i = integral_Omega epsilon_i dV
```

For uniform FDM cells this is `sum(epsilon_i[cell] * cell_volume)`. For FEM this is the backend quadrature or lumped-mass rule documented by the backend.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `m` | normalized magnetization direction | `1` |
| `M_s` | saturation magnetization | `A/m` |
| `H_i` | effective-field contribution | `A/m` |
| `mu0` | vacuum permeability | `N/A^2` |
| `epsilon_i` | energy density contribution | `J/m^3` |
| `E_i` | integrated energy contribution | `J` |

### 2.3 Assumptions and approximations

- Energy densities are active only when their corresponding physical term is active.
- The browser does not synthesize energy densities from unrelated fields.
- `eden_total` includes only terms available in the resolved backend snapshot.
- FDM density is cell-centered.
- FEM density is element/quadrature-owned; nodal or surface coloring is a visualization projection, not the canonical physical location.
- A sharp regional `M_s` realization remains element-DG0. A nodal visualization payload may use a volume-lumped projection of that DG0 coefficient, but it must be labelled as a nodal visualization projection and must not be presented as the canonical FEM density location.

## 3. Numerical interpretation

### 3.1 FDM

FDM CPU computes energy densities from the same field buffers used for scalar energy evaluation. Demag density must reuse the demag field from the current snapshot and must not trigger an additional FFT when the field has already been materialized. The first implementation targets the CPU reference path and the resource/data-plane contract; CUDA should follow with reusable device-side scalar buffers and selected/cadenced host copies.

### 3.2 FEM

FEM backends must expose element or quadrature density according to the operator contract. Native FEM CPU already has local energy-cache concepts; those should be the source for density publication. A viewport projection may resample to nodes or faces, but the API metadata must preserve the projection provenance.

The current live FEM preview payload is a node-aligned visualization projection. Its coefficient realization is resolved as follows:

- uniform `M_s`: the scalar plan value is repeated on active magnetic nodes;
- nodal-P1 `M_s`: the resolved nodal field is used directly;
- element-DG0/regional `M_s`: each active tetrahedron contributes `V_e / 4` to each incident node, and the nodal display coefficient is the corresponding volume-lumped weighted mean.

This projection is suitable for coloring and must carry `fem_nodal_visualization_projection` location/provenance. The backend scalar energies remain authoritative. Validation must independently integrate each projected term with the matching FEM lumped-volume rule and compare it with the native scalar term for qualified fixtures; passing a pointwise dot-product unit test alone is insufficient.

### 3.3 Hybrid

Hybrid density is deferred. When added, each subdomain must publish its own integration weights and density ownership so `eden_total` remains a sum of physically compatible terms.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No new public authoring semantics are required. Energy density is an observable selected through the canonical quantity IDs. Future Python convenience wrappers may expose `world.quantity("eden_total")` or equivalent, but this note does not introduce new physics authoring inputs.

### 4.2 ProblemIR representation

No new `ProblemIR` term is required. Energy-density observables are derived from the active physical terms already represented in IR. Availability and provenance must preserve requested execution intent and resolved backend support.

### 4.3 Planner and capability-matrix impact

The planner should advertise density quantities only for backends that can compute them from canonical solver state. Unsupported density requests fail as unavailable quantities rather than silently falling back to browser synthesis.

## 5. Validation strategy

### 5.1 Analytical checks

- Uniform Zeeman field: `sum(eden_ext * cell_volume)` equals `E_ext`.
- Exchange and demag density integration equals the existing scalar energy for the same snapshot.
- `eden_total` equals the pointwise sum of active density terms and integrates to `E_total`.

### 5.2 Cross-backend checks

- FDM CPU is the first reference path.
- FDM CUDA must match FDM CPU in double precision before single precision is exposed.
- FEM density must match FEM scalar energy under its documented quadrature rule.
- Native FEM qualification includes separate uniaxial and cubic anisotropy activation, interfacial versus bulk DMI selection, uniform/nodal-P1/element-DG0 `M_s`, and `eden_total` versus the sum of active native scalar terms.

### 5.3 Regression tests

- Quantity availability exposes `eden_*` only for supported active terms.
- Field data-plane responses carry `n_comp=1` scalar payloads for `eden_*`.
- Control-room result menus use canonical `eden_*` IDs and do not use `"energy_density"`.
- Displaying density does not add a duplicate demag solve/FFT in the CPU FDM preview path.

## 6. Completeness checklist

- [ ] Python API
- [x] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [ ] Outputs / observables
- [ ] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

- Canonical FEM element/quadrature density publication remains deferred. Until then, the live node-aligned payload is explicitly a visualization projection and backend scalar energies remain authoritative.
- `eden_*` scalar fields are not global scalar history columns; scalar history remains owned by `data/scalars` and solver-energy resources.
- Energy density visualization is scalar coloring, not vector glyph rendering.

## 8. References

- mumax3 energy-density registry and integration checks: `https://github.com/mumax/3`
- mumax+ field/scalar quantity split: `https://github.com/mumax/plus/blob/main/src/physics/energy.cu`
- Boris module energy display/output model: `https://github.com/SerbanL/Boris2`
