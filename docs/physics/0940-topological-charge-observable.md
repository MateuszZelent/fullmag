# Skyrmion charge and topological charge observable

- Status: draft
- Owners: Fullmag core physics/runtime
- Last updated: 2026-06-27
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/03-api-integration-layer.md`

## 1. Problem statement

Fullmag exposes an object-scoped skyrmion-charge observable for skyrmion and
texture analysis. The observable is a geometric winding on an oriented
two-dimensional support: a native FDM layer, a native FEM surface, an exact FEM
tetrahedral plane cut, or a layer/profile made from such supports.

It is not a sum over all unordered vectors in a three-dimensional volume. A
future three-dimensional topological-flux or Hopf-index observable must use a
separate contract. The current charge resource must distinguish a physically
meaningful `Q` from missing current magnetization, empty supports, invalid
magnetization, stale fields, degenerate topology, or under-resolved textures.
A displayed `Q = 0` is valid only when it comes from a non-empty unit
magnetization sample set on the selected 2D support.

## 2. Physical model

### 2.1 Governing equations

For a smooth unit magnetization field on an oriented two-dimensional manifold,
the continuum topological charge is

```math
Q = \frac{1}{4\pi}\int_\Omega
\hat{\mathbf m}\cdot
\left(\frac{\partial \hat{\mathbf m}}{\partial u}
\times
\frac{\partial \hat{\mathbf m}}{\partial v}\right)\,du\,dv .
```

Fullmag uses the geometric Berg-Luescher solid-angle discretization on oriented
triangles. For a triangle with unit magnetization samples `a`, `b`, and `c`,
the oriented solid angle is

```math
\Omega(a,b,c) =
2\,\operatorname{atan2}
\left(
a\cdot(b\times c),
1+a\cdot b+b\cdot c+c\cdot a
\right),
```

and the discrete observable is

```math
Q_h = \frac{1}{4\pi}\sum_{\triangle\in\mathcal T_h}\Omega_\triangle .
```

### 2.2 Symbols and SI units

| Symbol | Meaning | SI units |
|---|---|---|
| `Q`, `Q_h` | continuum and discrete topological charge | dimensionless |
| `hat(m)` | normalized magnetization direction `M / |M|` | dimensionless |
| `u`, `v` | in-plane coordinates of the analysis plane | m |
| `Omega` | oriented solid angle on the unit sphere | rad |
| `Sigma` | oriented 2D support: grid layer, surface, or plane cut | m^2 |
| `T_h` | oriented triangle set covering the support | dimensionless |
| `nx`, `ny` | regular native-grid sample counts when the support is FDM | dimensionless |

### 2.3 Assumptions and approximations

- The sampled magnetization must be finite and nonzero. Samples are normalized
  before the solid-angle sum; zero or non-finite samples are rejected.
- The analysis plane must include the full texture whose charge is being
  measured. Cropping a skyrmion core or boundary tail changes `Q_h`.
- The method is geometric and robust for smooth unit-vector textures, but the
  integer interpretation is meaningful only when the texture is sufficiently
  resolved and the boundary state is approximately uniform.
- The selected support must be two-dimensional and oriented. Unordered 3D nodes
  do not define a skyrmion number.
- The FEM film interpretation is a selected surface/cut or a stack of
  two-dimensional charges `Q(s_i)`, not a global 3D sum. A scalar average is
  only a summary; the profile is part of the diagnostic contract.
- A rasterized preview is not the production observable. If a diagnostic path
  resamples the field, the API must report the method as resampled/preview.

## 3. Numerical interpretation

### 3.1 FDM

For FDM fields, Fullmag takes the selected native structured-grid plane (`xy`,
`xz`, or `yz`; `auto` chooses the thinnest axis), extracts all vector samples
on that native layer, normalizes valid samples, and applies the two-triangle
Berg-Luescher sum per grid cell. For thick 3D FDM textures, the correct
extension is a profile `Q(s_i)` over native layers or an explicitly selected
cross-section, not a global volume sum.

### 3.2 FEM

For FEM fields, Fullmag:

1. resolves the selected magnetic object to its FEM nodes and tetrahedra,
2. takes the object-scoped nodal vector field for the requested quantity,
3. resolves the requested analysis plane (`xy`, `xz`, or `yz`; `auto` chooses
   the thinnest object axis),
4. uses true planar layer faces when the mesh exposes them and computes the
   layer profile `Q(s_i)` on the native layer triangulations,
5. thickness-averages valid layer charges only as a scalar summary while
   preserving the per-layer profile in the resource,
6. falls back to an exact tetrahedral plane cut for general 3D FEM objects
   without native planar layer faces,
7. deduplicates cut vertices by mesh vertex or global edge key, linearly
   interpolates the current magnetization to cut vertices, triangulates each cut
   polygon, and orients triangles in the support frame,
8. normalizes valid vector samples and applies the Berg-Luescher solid-angle
   sum on the layer or cut triangulation.

A regular-grid FEM slice is a diagnostic raster path only when explicitly
requested; it is not the default scientific result.

### 3.3 Hybrid

Hybrid execution is not implemented for this observable. A future hybrid path
must state which surface, grid, or interface owns the orientation and sample
contract.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public Python authoring API is added by this note. The observable is a
runtime analysis resource over an already-authored object and field quantity.

### 4.2 ProblemIR representation

No new `ProblemIR` field is required. The observable depends on the existing
scene object identity, field quantity identity, mesh/domain provenance, field
revision, selected support, sign convention, and method version.

### 4.3 Planner and capability-matrix impact

No execution-planner choice changes. The analysis resource is available only
when the runtime has current magnetization samples and a valid oriented 2D
support. Empty support, invalid magnetization, or degenerate topology must be
reported as degraded analysis status rather than a physical zero.

Current status vocabulary:

- `ready`: result computed on a non-empty support,
- `no_current_magnetization`: no current vector field is available,
- `empty_support`: the selected object/plane does not provide a 2D support,
- `invalid_magnetization`: all support vectors are zero, NaN, Inf, or otherwise
  invalid,
- `degenerate_support`: the support has no usable oriented triangles,
- `under_resolved`: result computed, but quality diagnostics indicate a weak
  integer interpretation.

The inspector must default to on-demand evaluation. Continuous recalculation is
allowed only when the user explicitly selects it, or when a future table/quantity
consumer subscribes to `skyrmion_charge` as a displayed quantity. The backend
resource remains revision-keyed by mesh revision, field revision, support
definition, object id, and method version; preview/rasterized paths must not be
silently cached as production charge.

## 5. Validation strategy

### 5.1 Analytical checks

- Uniform unit magnetization must produce `Q_h = 0`.
- An analytic Neel skyrmion sampled on a regular grid must produce `Q_h` close
  to the known orientation sign.
- An analytic Neel skyrmion assigned to a thin FEM tetrahedral film and sampled
  through object-scoped native layer faces must produce the same charge within a
  documented tolerance. Exact plane-cut fallback is tested separately for FEM
  meshes without planar layer faces.

### 5.2 Cross-backend checks

FDM and FEM checks use the same Berg-Luescher solid-angle kernel after each
backend has produced an oriented triangle support. Differences are expected
only from native-grid resolution, FEM interpolation to cut vertices, mesh
quality, support selection, and sign convention.

### 5.3 Regression tests

- `compute_topological_charge_grid` covers uniform fields, analytic skyrmions,
  and zero-length samples.
- FEM tests cover native layer profiles, exact tetra-plane-cut fallback, and
  subpixel triangle visibility for the explicit raster diagnostic path.
- Router tests cover FDM, FEM uniform fields, stale cache invalidation,
  zero-valid-sample degradation, and analytic FEM skyrmion charge.

## 6. Completeness checklist

- [x] Python API: no new public authoring surface
- [x] ProblemIR: no new lowered representation
- [x] Planner: no execution-selection change
- [x] Capability matrix: no new capability vocabulary
- [x] FDM backend: native structured plane sampling into Berg-Luescher triangles
- [x] FEM backend: object-scoped layer triangulation profile into Berg-Luescher sums
- [x] FEM backend: object-scoped exact tetra-plane-cut fallback
- [ ] Hybrid backend
- [x] Outputs / observables: v2 analysis resource and inspector panel
- [x] Tests / benchmarks: targeted analytical and regression tests
- [x] Documentation: this note plus inspector equation text

## 7. Known limits and deferred work

- Full 3D topological flux, Hopf index, and density maps are separate
  observables/resources and are not implemented by this scalar inspector
  resource.
- Strongly curved surfaces or bobber-like textures require inspecting a full
  `Q(s_i)` profile or topological flux rather than trusting one scalar cut.
- A separate charge over arbitrary curved object surfaces needs an explicit
  orientation and boundary contract. It is not the default skyrmion-number
  interpretation for a film.
- Integer-charge claims should be treated as diagnostic unless the valid-sample
  fraction, boundary texture, and grid-convergence checks are acceptable for the
  study.

## 8. References

- Berg-Luescher geometric solid-angle discretization for lattice topological
  charge.
- Fullmag runtime implementation: `crates/fullmag-api/src/analysis/topological_charge.rs`.
- Fullmag FEM slice implementation: `crates/fullmag-api/src/fem_slice.rs`.
