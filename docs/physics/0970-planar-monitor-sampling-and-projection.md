# Planar monitor sampling and projection

- Status: accepted contract; implementation and qualification tracked by the
  viewport 2D masterplan
- Owners: Fullmag physics, runtime, API, and control-room maintainers
- Last updated: 2026-07-18
- Related ADRs:
  - `docs/adr/0011-resource-first-api.md`
  - `docs/adr/0016-center-viewport-tabbed-surfaces.md`
  - `docs/adr/0020-planar-field-map-and-monitor.md`
- Related specs:
  - `docs/specs/resource-first-control-room-api-v2.md`
  - `docs/specs/frontend-v2/15-viewport-2d-module.md`
  - `docs/specs/capability-matrix-v0.md`
- Implementation plan:
  `docs/plans/active/viewport-2d-planar-monitor-production-masterplan-2026-07-18-pl.md`

## 1. Problem statement

Fullmag publishes spatial scalar and vector quantities on FDM grids and FEM
meshes. A two-dimensional view must show the same physical field independently
of storage layout, mesh density, solver device, or browser renderer. Existing
axis-aligned slice, projection, and mesh-cross-section resources are useful
building blocks, but they do not define one reproducible physical observation.

The canonical observation is a `PlanarMonitor`: a physical frame, a physical
target, an extent policy, and one explicit sampling or reduction operator. It
does not select a quantity, component, display unit, palette, raster resolution,
or rendering quality. Those choices belong to a view profile and data request,
so one authored monitor can inspect every compatible published spatial
quantity.

The required scientific invariants are:

1. FDM and FEM implement the same physical operators.
2. A reduced value is weighted by physical measure, never by node count.
3. Vector reduction occurs before component or magnitude derivation unless an
   operator explicitly declares the opposite order.
4. Missing domain support is represented by occupancy, not silently filled
   with zero.
5. Authored intent and resolved runtime sampling are both preserved in
   provenance.

## 2. Physical model

### 2.1 Monitor frame

A monitor frame is the right-handed orthonormal basis

\[
\mathcal F=(\mathbf o,\mathbf e_u,\mathbf e_v,\mathbf n),\qquad
\mathbf e_v=\mathbf n\times\mathbf e_u,
\]

with world position

\[
\mathbf x(u,v,s)=
\mathbf o+u\mathbf e_u+v\mathbf e_v+s\mathbf n.
\]

The public authoring input is `origin`, `normal`, and `u_axis`. Normalization is
deterministic. A zero vector, non-finite component, or collinear
`normal`/`u_axis` is invalid.

Axis presets use:

| Preset | \(\mathbf e_u\) | \(\mathbf e_v\) | \(\mathbf n\) |
|---|---|---|---|
| `xy` | \(+\hat x\) | \(+\hat y\) | \(+\hat z\) |
| `xz` | \(+\hat x\) | \(+\hat z\) | \(-\hat y\) |
| `yz` | \(+\hat y\) | \(+\hat z\) | \(+\hat x\) |

The resolved basis is returned by the runtime. A client must not infer axis
orientation from the preset name.

### 2.2 Target and extent

The authored physical target is one of:

- the complete physical domain;
- the magnetic domain;
- one object;
- one object region.

`mesh_part` and `airbox` are runtime-only view scopes. They are not
`MonitorTargetIR` variants because their identities depend on a resolved mesh
revision. A runtime scope can only intersect and narrow the physical monitor
target; it cannot extend it.

Extent policies are:

- explicit \(u\) and \(v\) bounds in metres;
- projected target bounds plus SI padding;
- projected magnetic-domain bounds;
- projected universe bounds.

The IR preserves the policy. Runtime provenance records resolved bounds. A
geometry change therefore re-resolves dynamic bounds instead of turning them
into stale explicit coordinates.

### 2.3 Operators

#### Plane sample

`plane_sample` evaluates the reconstructed field at \(s=0\). Its raster support
is `point_center`: output \((i,j)\) represents
\(\mathbf x(u_i,v_j,0)\). The result has the source quantity unit.

#### Finite-thickness average

`slab_average(thickness_m=t)` requires finite \(t>0\) and uses
\(s\in[-t/2,t/2]\). For scalar \(q\),

\[
\bar q(u,v)=
\frac{\int_{\Omega_T\cap C_{uv}}q(\mathbf x)\,d\mu}
{\int_{\Omega_T\cap C_{uv}}d\mu},
\]

where \(C_{uv}\) is the physical pixel prism and \(d\mu\) is volume measure.
Only occupied measure contributes. The result has the source quantity unit.

#### Depth projection

`depth_projection` integrates over the complete target intersection along
\(\mathbf n\). It supports:

- `mean_occupied`;
- `thickness_integral`;
- `rms`;
- `min`;
- `max`;
- `abs_max`.

`thickness_integral` has source unit multiplied by metre. Other reductions keep
the source unit. Air is excluded by default. `include_air_as_zero` is an
explicit, capability-gated empty policy.

#### Surface projection

`surface_projection` selects a physical target boundary, projects boundary
measure into the monitor frame, and applies one explicit visibility policy:

- `frontmost`;
- `backmost`;
- `nearest_to_origin`;
- `area_weighted_overlap`.

The result reports overlap and fold counts. A non-injective curved surface is a
diagnostic/degraded projection, not a lossless UV parameterization.

### 2.4 Raster support and occupancy

Conservative operators use the physical pixel footprint:

- `slab_average` and `depth_projection`: `pixel_prism`;
- `surface_projection`: `projected_pixel_area`.

Changing raster resolution changes those footprints. Resolved dimensions and
physical pixel sizes are therefore part of request identity and provenance,
but not part of `PlanarMonitor`.

Each sample carries one occupancy state:

- `occupied`;
- `partial`;
- `empty`;
- `undefined_orientation`;
- `overlap_ambiguous`.

Empty and non-finite samples do not participate in extrema, histograms, or
automatic range selection.

### 2.5 Vector fields

For a vector quantity,

\[
\bar{\mathbf q}=
\frac{\int_{\Omega_T\cap C_{uv}}\mathbf q(\mathbf x)\,d\mu}
{\int_{\Omega_T\cap C_{uv}}d\mu}.
\]

Components are derived after reduction:

\[
q_u=\bar{\mathbf q}\cdot\mathbf e_u,\quad
q_v=\bar{\mathbf q}\cdot\mathbf e_v,\quad
q_n=\bar{\mathbf q}\cdot\mathbf n.
\]

The shared vocabulary is `x`, `y`, `z`, `u`, `v`, `normal`, `magnitude`,
`in_plane_magnitude`, and `orientation`. The default order is
`vector_then_component`. If a future operator supports
`component_then_reduce`, that order must be explicit in the request and
provenance.

Vectors below `orientation_epsilon` receive `undefined_orientation`; no
arbitrary hue is assigned. In-plane glyphs use \((q_u,q_v)\), while \(q_n\)
may be shown by an explicit out-of-plane marker.

### 2.6 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| \(\mathbf o\) | monitor origin | m |
| \(u,v,s\) | monitor coordinates | m |
| \(\mathbf e_u,\mathbf e_v,\mathbf n\) | basis vectors | dimensionless |
| \(t\) | slab thickness | m |
| \(q\) | scalar quantity | canonical quantity unit |
| \(\mathbf q\) | vector quantity | canonical quantity unit |
| \(d\mu\) | volume or surface measure | m³ or m² |

Transport remains in SI. Display conversions such as `A/m` to `T` are
presentation-only and never mutate field buffers or monitor definitions.

### 2.7 Assumptions and validity limits

- The first production FEM path is P1 tetrahedral data.
- Higher-order FEM is unavailable until the actual basis is evaluated; hidden
  P1 fallback is forbidden.
- A general folded curved surface is not a lossless 2D atlas.
- Movie/time-series export and simultaneous heavy viewports are outside this
  contract.
- Sampling execution is CPU in the first production release, including fields
  produced by GPU solvers. Provenance distinguishes source device from sampler
  device.

## 3. Numerical interpretation

### 3.1 FDM

Published FDM fields are cell-centred. `plane_sample` uses the explicit
`cell_constant` reconstruction and returns the cell containing the sample
point. Slab and depth reductions use cell/pixel-prism intersection volume.
Axis-aligned fast paths are legal only when they agree with the general
operator within the declared tolerance.

For a layered grid with cell values \(q_k\) and occupied intersection volumes
\(V_k\),

\[
\bar q=\frac{\sum_k q_kV_k}{\sum_k V_k}.
\]

### 3.2 FEM

P1 plane sampling locates the containing tetrahedron and evaluates its
barycentric basis at the pixel centre. Slab/depth reductions integrate the P1
field over tetrahedron/pixel-prism intersections. Boundary projection
integrates over physical boundary triangles with the P1 trace basis.

Spatial indices are keyed by `mesh_revision`. They are not rebuilt for a
quantity-only change. The result reports basis order, integration order,
sampling method, spatial-index revision, and an error estimate where available.

This postprocessing contract does not add physics to the MFEM solver
`Context`, `mfem_bridge.cpp`, or an FDM/FEM runtime lane. It consumes published
fields through a backend-neutral `PlanarSamplingEngine`.

### 3.3 Why node-count averaging is invalid

The arithmetic node average

\[
q_\mathrm{nodes}=\frac1N\sum_{a=1}^Nq_a
\]

changes when a mesh is refined in one part of the domain even if the continuous
field is unchanged. For example, on \(x\in[0,1]\) with \(q(x)=x\), two equally
sized regions have exact mean \(1/2\). Refining only \([0,1/2]\) introduces
more low-\(x\) nodes and biases the unweighted node average below \(1/2\).
Measure-weighted integration remains \(1/2\).

The validation fixture uses a skew tetrahedron with linear \(q\), then refines
only one subregion. The acceptance condition is invariant integral/average
within integration tolerance while `selected_node_count` changes.

### 3.4 CPU, GPU, and precision

The sampling equations are device-neutral. The first implementation resolves
`sampling_execution=cpu`. `source_device=gpu` only means the sampled field was
published by a GPU execution lane. It does not advertise native GPU sampling.

All accumulation is double precision in the first production sampler,
including single-precision source fields. Source precision and accumulation
precision are both recorded.

## 4. API, IR, planner, and workspace impact

### 4.1 Python API surface

Python adds immutable `PlanarMonitor`, `MonitorTarget`, `PlanarFrame`,
`PlanarExtent`, `PlaneSample`, `SlabAverage`, `DepthProjection`, and
`SurfaceProjection` constructs. `study.monitors.add_planar(...)` returns a
stable monitor identity. Quantity, component, resolution, quality, palette, and
display unit are intentionally absent.

Canonical script export must reproduce every authored monitor field and retain
semantic equality after a second lowering to `ProblemIR`.

### 4.2 ProblemIR representation

`ProblemIR.planar_monitors` is a default-empty list of typed monitor records.
Validation checks finite values, orthonormal frame construction, positive
thickness, valid extent, unique identity/name, target references, and
operator-specific policies. `mesh_part` and `airbox` are rejected as authored
targets.

Old IR without the list deserializes to an empty list. If repository versioning
requires an IR version change, migration is implemented in the canonical Rust
migrator and mirrored by Python tests.

### 4.3 Planner and capabilities

A monitor is passive authoring intent. Declaring it does not select a solver,
materialize every quantity, or change equations. Sampling a quantity requests
the existing field-materialization path. Missing data returns
`quantity_not_materialized`; unsupported semantics return a stable capability
reason.

The capability vocabulary is:

- `planar_monitor_authoring`;
- `planar_plane_sample`;
- `planar_slab_average`;
- `planar_depth_projection`;
- `planar_surface_projection`;
- `planar_arbitrary_frame`;
- `planar_vector_sampling`;
- `planar_mesh_overlay`;
- `planar_airbox_sampling`;
- `planar_high_order_basis`.

Strict and extended execution use the same authored monitor. No planner may
silently replace an unsupported operator or high-order basis with a different
one.

### 4.4 Runtime and provenance

Runtime provenance records authored monitor identity/hash and resolved:

- frame, extent, operator, and runtime scope;
- quantity, canonical unit, component expression, and reduction order;
- field, mesh, scene, stage, and snapshot revisions;
- source backend, device, and precision;
- sampler implementation/version, execution device, basis/integration order;
- raster dimensions, pixel size, occupancy, extrema, and error diagnostics;
- ETags for component resources.

### 4.5 Resource-first API

JSON model resources expose revision-safe monitor CRUD. Planar field resources
expose thin metadata and separate bounded binary scalar, vector, occupancy, and
mesh-overlay payloads. Probe and PNG export remain separate resources.
WebSocket messages carry invalidation only; session status carries no rasters.

### 4.6 Unified workspace

`field-map` is the `viewport-main` owner for interactive 2D spatial fields. It
uses Canvas 2D/worker rendering and does not create WebGL resources. Only the
active heavy center surface is mounted. Object, region, mesh-part, airbox,
spatial-result, mode, and monitor visualization inspectors use one registry and
derive a `three-d` or `planar` presentation context.

`cross-section-image` remains export/fallback during migration and is removed
as a competing top-level workflow only after parity evidence exists.

## 5. Validation strategy

### 5.1 Analytical checks

| ID | Fixture | Required result |
|---|---|---|
| PM-N01 | constant scalar FDM | exact constant for plane/slab/depth |
| PM-N02 | layered cell-constant FDM | analytic volume-overlap average |
| PM-N03 | linear P1 skew tetra | barycentric plane value |
| PM-N04 | linear P1 skew tetra slab | analytic measure-weighted value |
| PM-N05 | nonuniform refinement | invariant result despite node-count change |
| PM-N06 | analytic vector field | correct world and monitor components |
| PM-N07 | partial/empty domain | correct occupancy and excluded extrema |
| PM-N08 | planar boundary | analytic area-weighted surface value |
| PM-N09 | folded surface | explicit non-injective diagnostic |

Constant and linear P1 point evaluations target near-machine precision.
Clipping/integration tests declare fixture-specific absolute and relative
tolerances derived from integration order. A timeout or lower-quality operator
is not a scientific fallback.

### 5.2 Cross-backend checks

FDM and FEM sample the same continuous manufactured fields on refined
discretizations. The report includes reconstruction policy, resolution,
occupied measure, error norms, and observed convergence. Comparisons are not
bitwise across discretizations.

GPU-source checks prove only that GPU-published fields can be consumed by the
CPU sampler. They do not qualify native GPU sampling.

### 5.3 Runtime and browser checks

Managed FDM/FEM runtime checks use the repository `just` recipe and record
requested/resolved backend/device. FEM native runtime proof begins with
`just ensure-managed-fem-runtime`; host-only builds are diagnostics.

Browser checks prove scalar, vector, contour, mesh, probe, export, 3D/2D state
preservation, active-only mounting, no idle RAF, worker/object cleanup, and a
healthy 3D WebGL context after repeated switches.

### 5.4 Regression tests and artifacts

Science reports are written below
`.fullmag/reports/viewport-2d-planar-monitor-smoke/`. Each report records the
monitor hash, sampler version, source and sampling execution, revisions,
occupancy, tolerances, and pass/fail gates. Status documentation may claim only
the lanes proven by current reports.

## 6. Completeness checklist

- [x] Physical model, equations, units, assumptions, and validity limits
- [x] FDM and FEM interpretations
- [x] CPU/GPU and precision interpretation
- [x] Python API contract
- [x] ProblemIR and migration contract
- [x] Planner and capability vocabulary
- [x] Runtime and provenance contract
- [x] OpenAPI/resource contract
- [x] Unified workspace and inspector contract
- [x] Analytical, cross-backend, managed-runtime, and browser validation plan
- [ ] Python API implementation and tests
- [ ] ProblemIR/SceneDocument implementation and round-trip tests
- [ ] PlanarSamplingEngine implementation and numerical tests
- [ ] Resource-first API/OpenAPI/generated client implementation
- [ ] Control-room field-map and inspector implementation
- [ ] Managed FDM/FEM validation artifacts
- [ ] Browser, performance, memory, and accessibility artifacts

## 7. Known limits and deferred work

- Higher-order FEM basis evaluation is capability-gated.
- General curved-surface atlas/UV unfolding is deferred.
- Native GPU sampling is not claimed.
- Animated/movie export is deferred.
- Multiple simultaneously mounted heavy center surfaces are forbidden.
- A future stage output that mandates `quantity @ monitor` requires a separate
  planner/output contract.

## 8. References

- Fullmag quantity and unit conventions in `docs/physics/units.md`.
- Native FEM operator qualification in
  `docs/physics/0900-native-fem-operator-contracts-and-validation.md`.
- Backend ownership in `docs/architecture/backend-golden-masterplan.md`.
- Center-surface lifecycle in
  `docs/adr/0016-center-viewport-tabbed-surfaces.md`.

