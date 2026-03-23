# Exchange-only geometry and magnetization bootstrap semantics

- Status: draft
- Owners: Fullmag
- Last updated: 2026-03-23
- Related ADRs: none
- Related specs: `docs/specs/exchange-only-full-solver-architecture-v1.md`, `docs/specs/geometry-policy-v0.md`, `docs/specs/magnetization-init-policy-v0.md`, `docs/specs/problem-ir-v0.md`, `docs/specs/capability-matrix-v0.md`

## 1. Problem statement

Phase 1 needs a backend-neutral way to describe common exchange-only geometries and initial magnetization states without leaking FDM voxel indices or FEM mesh internals into the public API.
The shared semantics must let the same Python-authored problem describe an axis-aligned strip or cylinder, and must let authors choose deterministic uniform or seeded-random initial states before backend-specific lowering begins.

## 2. Physical model

### 2.1 Governing equations

The reduced magnetization field \(\mathbf{m}(\mathbf{x}, t)\) is dimensionless and satisfies

$$
\|\mathbf{m}\| = 1.
$$

For the exchange-only release, the exchange energy is

$$
E_{\mathrm{ex}} = \int_{\Omega} A \, \left(\|\nabla m_x\|^2 + \|\nabla m_y\|^2 + \|\nabla m_z\|^2\right) \, dV,
$$

with effective field

$$
\mathbf{H}_{\mathrm{ex}} = \frac{2 A}{\mu_0 M_s} \nabla^2 \mathbf{m},
$$

and the LLG evolution uses the shared reduced-form parameterization already frozen in the LLG policy.
Geometry defines the physical domain \(\Omega\), while the initial magnetization policy defines \(\mathbf{m}(\mathbf{x}, 0)\).

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|--------|---------|------|
| \(\Omega\) | magnetic body domain | m^3 via its spatial extent |
| \(A\) | exchange stiffness | J/m |
| \(M_s\) | saturation magnetisation | A/m |
| \(\mu_0\) | vacuum permeability | N/A^2 |
| \(\mathbf{m}\) | reduced magnetization | 1 |
| \(\mathbf{H}_{\mathrm{ex}}\) | exchange field | A/m |
| \(t\) | time | s |

### 2.3 Assumptions and approximations

- `Box` and `Cylinder` are axis-aligned analytic primitives only.
- Boolean CSG and rotated primitives are deferred.
- `uniform(vector)` assumes a spatially constant reduced magnetization.
- `random(seed)` denotes deterministic pseudo-random unit vectors generated during lowering, not during the time-stepping hot loop.
- `from_function(fn, sample_points)` is represented as sampled data in canonical IR; callable evaluation is a Python-side/lowering-time concern and is deferred beyond the current execution milestone.

## 3. Numerical interpretation

### 3.1 FDM

Analytic primitives lower to a voxel occupancy mask on a Cartesian grid.
`uniform` fills all covered cells with the same reduced vector.
`random(seed)` deterministically populates covered cells with normalized pseudo-random vectors.
`SampledField` values correspond to lowering-time sample locations chosen by the planner or Python-side helper.

### 3.2 FEM

Analytic primitives lower to a mesh-generation target or a meshed analytic domain.
`uniform` initializes nodal or element-associated fields consistently over the domain.
`random(seed)` deterministically populates the FEM field representation after mesh creation.
`SampledField` carries sampled vectors that are then interpolated/projected into the chosen FEM field space.

### 3.3 Hybrid

Hybrid execution requires a single physical geometry contract with projections between mesh and auxiliary Cartesian representations.
Initial magnetization semantics must remain identical before any projection: seeded randomness and sampled-field meaning are shared, while projection details stay planner-owned.

## 4. API, IR, and planner impact

### 4.1 Python API surface

- Add `fm.Box(size, name="box")`.
- Add `fm.Cylinder(radius, height, name="cylinder")`.
- Keep `fm.ImportedGeometry(source, name)` unchanged.
- Add `fm.init.random(seed)` and a deferred `fm.init.from_function(...)` stub.
- Keep `fm.init.uniform(vector)` as the canonical uniform initializer.
- `Ferromagnet.geometry` accepts the union of imported and analytic geometries.

### 4.2 ProblemIR representation

- `GeometryIR` stores `entries`, not only `imports`.
- Geometry entries are tagged unions covering `imported_geometry`, `box`, and `cylinder`.
- Initial magnetization is a tagged union covering `Uniform`, `RandomSeeded`, and `SampledField`.
- `IR_VERSION` advances to `0.2.0` because the canonical serialized geometry and magnetization shapes change.

### 4.3 Planner and capability-matrix impact

- Analytic primitives are legal shared semantics for `strict`, `extended`, and `hybrid` validation.
- The planner owns voxelization, meshing, and projection of primitives.
- `random(seed)` remains backend-neutral because canonical IR stores the seed rather than backend-specific samples.
- `from_function(...)` remains API-visible but execution-deferred until sampling locations are fully specified.

## 5. Validation strategy

### 5.1 Analytical checks

- Positive `Box.size` components and positive `Cylinder.radius`/`Cylinder.height` are required.
- Geometry names must be unique across imported and analytic entries.
- `random(seed)` requires a strictly positive seed.
- `SampledField` requires at least one sampled vector.

### 5.2 Cross-backend checks

- The same analytic geometry must lower to physically equivalent FDM/FEM domains up to documented geometric discretization error.
- Seeded-random initialization must be deterministic per backend and reproducible from the same canonical seed, while allowing backend-specific spatial discretization differences.
- Shared observable names remain `m`, `H_ex`, `E_ex`, `time`, `step`, and `solver_dt`.

### 5.3 Regression tests

- Python serialization tests for `Box`, `Cylinder`, and `fm.init.random`.
- Rust deserialization/validation tests for `GeometryEntryIR` and new magnetization variants.
- Smoke coverage for the new exchange-only example using analytic geometry.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [ ] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

- `from_function(...)` is intentionally a stub in Phase 1 because canonical sample-point selection is not finalized.
- Canonical IR carries sampled values but not planner-specific grid or mesh locations.
- Random initialization reproducibility is specified at the seed/semantic level; exact bitwise equality across backends is not required.
- Rotated primitives, boolean composition, and user-facing boundary-condition controls remain deferred.

## 8. References

- A. Hubert and R. Schäfer, *Magnetic Domains*, Springer, 1998.
- W. F. Brown, *Micromagnetics*, Interscience, 1963.
