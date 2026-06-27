# Topological charge observable

- Status: draft
- Owners: Fullmag core physics/runtime
- Last updated: 2026-06-27
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/03-api-integration-layer.md`

## 1. Problem statement

Fullmag exposes an object-scoped topological charge observable for skyrmion and
texture analysis. The observable must distinguish a physically meaningful charge
from missing samples, stale fields, incomplete topology, or a projection that
does not cover the magnetic texture. A displayed `Q = 0` is valid only when it
comes from a non-empty unit magnetization sample set.

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

Fullmag currently reports the geometric Berg-Luescher grid discretization. Each
grid cell is split into two oriented triangles. For a triangle with unit
magnetization samples `a`, `b`, and `c`, the oriented solid angle is

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
| `nx`, `ny` | regular analysis-grid sample counts | dimensionless |

### 2.3 Assumptions and approximations

- The sampled magnetization must be finite and nonzero. Samples are normalized
  before the solid-angle sum; zero or non-finite samples are rejected.
- The analysis plane must include the full texture whose charge is being
  measured. Cropping a skyrmion core or boundary tail changes `Q_h`.
- The method is geometric and robust for smooth unit-vector textures, but the
  integer interpretation is meaningful only when the texture is sufficiently
  resolved and the boundary state is approximately uniform.
- The current FEM path is a plane-slice observable, not a mesh-intrinsic
  simplicial charge over arbitrary curved surfaces.

## 3. Numerical interpretation

### 3.1 FDM

For FDM fields, Fullmag takes the selected structured-grid plane (`xy`, `xz`, or
`yz`; `auto` chooses the thinnest axis), extracts the vector samples, normalizes
valid samples, and applies the two-triangle Berg-Luescher sum per grid cell.

### 3.2 FEM

For FEM fields, Fullmag:

1. resolves the selected magnetic object to its FEM nodes and tetrahedra,
2. takes the object-scoped nodal vector field for the requested quantity,
3. linearly interpolates tetrahedral data onto an exact plane cut,
4. rasterizes the cut into a regular `nx * ny` grid,
5. normalizes valid vector samples,
6. applies the same Berg-Luescher grid sum as the FDM path.

Subpixel FEM cut triangles must remain visible to the rasterizer. If a cut
triangle does not contain any pixel center, the rasterizer deposits a centroid
sample into the corresponding pixel so a physically present slice is not turned
into an empty analysis grid.

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
revision, and requested analysis plane/resolution.

### 4.3 Planner and capability-matrix impact

No execution-planner choice changes. The analysis resource is available only
when the runtime has compatible field samples and either an FDM plane or FEM
object topology. Unsupported or empty sampling must be reported as degraded
analysis status rather than a physical zero.

## 5. Validation strategy

### 5.1 Analytical checks

- Uniform unit magnetization must produce `Q_h = 0`.
- An analytic Neel skyrmion sampled on a regular grid must produce `Q_h` close
  to the known orientation sign.
- An analytic Neel skyrmion assigned to a thin FEM tetrahedral film and sampled
  through the object-scoped analysis endpoint must produce the same charge
  within a documented tolerance.

### 5.2 Cross-backend checks

FDM and FEM checks use the same Berg-Luescher solid-angle kernel after each
backend has produced a regular plane grid. Differences are expected only from
the FEM interpolation/rasterization step and the selected analysis plane.

### 5.3 Regression tests

- `compute_topological_charge_grid` covers uniform fields, analytic skyrmions,
  and zero-length samples.
- FEM slice tests cover exact tetra-plane cuts and subpixel triangle visibility.
- Router tests cover FDM, FEM uniform fields, stale cache invalidation,
  zero-valid-sample degradation, and analytic FEM skyrmion charge.

## 6. Completeness checklist

- [x] Python API: no new public authoring surface
- [x] ProblemIR: no new lowered representation
- [x] Planner: no execution-selection change
- [x] Capability matrix: no new capability vocabulary
- [x] FDM backend: structured plane sampling into Berg-Luescher grid
- [x] FEM backend: object-scoped tetra slice into Berg-Luescher grid
- [ ] Hybrid backend
- [x] Outputs / observables: v2 analysis resource and inspector panel
- [x] Tests / benchmarks: targeted analytical and regression tests
- [x] Documentation: this note plus inspector equation text

## 7. Known limits and deferred work

- The FEM observable is currently plane-based. A future mesh-intrinsic
  topological charge over triangulated object surfaces would need a separate
  orientation and boundary contract.
- The current resource reports one selected plane and resolution. Multi-plane
  convergence diagnostics are deferred.
- Integer-charge claims should be treated as diagnostic unless the valid-sample
  fraction, boundary texture, and grid-convergence checks are acceptable for the
  study.

## 8. References

- Berg-Luescher geometric solid-angle discretization for lattice topological
  charge.
- Fullmag runtime implementation: `crates/fullmag-api/src/analysis/topological_charge.rs`.
- Fullmag FEM slice implementation: `crates/fullmag-api/src/fem_slice.rs`.
