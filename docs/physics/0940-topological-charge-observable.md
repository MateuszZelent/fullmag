# Planar skyrmion charge on FDM grids and FEM P1 meshes

- Status: accepted physical and numerical contract; implementation not production-qualified
- Owners: Fullmag core physics/runtime
- Last updated: 2026-07-11
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/03-api-integration-layer.md`, `docs/specs/frontend-v2/13-inspector-and-property-editing.md`
- Supersedes: the physical and numerical sections of `docs/plans/active/object-extensions-topological-charge-implementation-plan-2026-06-26-pl.md`

## 1. Problem statement

Fullmag exposes an object-scoped observable for the planar skyrmion charge of
the normalized magnetization direction. The observable is the degree-like
oriented area swept by a two-dimensional magnetization texture on the unit
sphere. It is evaluated on one of these supports:

1. an object-scoped native FDM plane;
2. an oriented planar cut through an object-scoped tetrahedral FEM P1 mesh;
3. a profile of such planes through the thickness of a film.

The current observable is deliberately not any of the following:

- a sum over unordered nodes in a three-dimensional volume;
- a charge on an arbitrary curved surface;
- a three-dimensional topological-flux integral;
- a Hopf invariant;
- an estimate from renderer, shader, decimated viewport, or preview geometry;
- a high-order FEM observable.

Those quantities require separate physical contracts and separate resource
identities. They must not be added as hidden fallbacks to this observable.

The production result must distinguish the numerical value of the integral
from whether that value is topologically quantized. A finite integral can be
computed on an open support with a nonuniform boundary, but `nearest_integer`
and `integer_error` are meaningful only when the boundary and resolution
qualification gates pass.

## 2. Physical model

### 2.1 Governing equations

Let `Sigma` be an oriented planar support with an ordered orthonormal frame
`(e_u, e_v, n)` satisfying

```math
\mathbf n = \mathbf e_u \times \mathbf e_v .
```

For a finite, nonzero magnetization field `M`, define

```math
\hat{\mathbf m} = \frac{\mathbf M}{\lVert\mathbf M\rVert} .
```

The continuum topological-charge density and charge are

```math
q(u,v) = \frac{1}{4\pi}
\hat{\mathbf m}\cdot
\left(
\frac{\partial\hat{\mathbf m}}{\partial u}
\times
\frac{\partial\hat{\mathbf m}}{\partial v}
\right),
```

```math
Q(\Sigma) = \int_\Sigma q(u,v)\,du\,dv .
```

Fullmag evaluates `Q` geometrically on an oriented triangle support. For unit
magnetization samples `a`, `b`, and `c` ordered consistently with the support
frame, the signed solid angle is

```math
\Omega(a,b,c) =
2\,\operatorname{atan2}\!\left(
a\cdot(b\times c),
1+a\cdot b+b\cdot c+c\cdot a
\right),
```

and the discrete charge is

```math
Q_h = \frac{1}{4\pi}
\sum_{\triangle\in\mathcal T_h}\Omega_\triangle .
```

The triangle order is part of the observable. Reversing the support
orientation reverses `Q_h`.

### 2.2 Canonical support orientation

The plane name fixes an ordered frame. It is not an unordered pair of axes.

| `plane` | `u` axis | `v` axis | canonical normal `n=e_u x e_v` |
|---|---|---|---|
| `xy` | `+x` | `+y` | `+z` |
| `xz` | `+x` | `+z` | `-y` |
| `yz` | `+y` | `+z` | `+x` |

This convention matches the visible axis order in the UI and the existing
plane coordinate frames. Every response must return this resolved frame. Tests
must cover all three planes and the sign change produced by reversing triangle
order. No backend may infer a different orientation from tetrahedron numbering,
surface normals, or renderer winding.

`plane=auto` selects the plane whose normal-axis Cartesian extent is smallest.
Exact or tolerance-level ties resolve in the fixed order `xy`, then `xz`, then
`yz`; the response always echoes `requested_plane=auto` and the concrete
resolved plane.

### 2.3 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `M` | magnetization vector before normalization | `A/m` when dimensional |
| `hat(m)` | normalized magnetization direction | `1` |
| `u`, `v` | physical in-plane coordinates | `m` |
| `s` | physical coordinate along the canonical support normal | `m` |
| `Sigma` | oriented two-dimensional support | no unit; its measure has `m^2` |
| `q` | continuum topological-charge density | `1/m^2` |
| `Q`, `Q_h` | continuum and discrete topological charge | `1` |
| `Omega` | signed solid angle | `rad`, dimensionally `1` |
| `T_h` | oriented support triangulation | no unit |
| `h` | characteristic support-mesh length | `m` |

FDM layer indices are not physical coordinates. A response containing a layer
profile must return both `index` and `coordinate_m`; it must never place a grid
index in a field documented as metres.

### 2.4 Quantization and terminology

`Q` is an oriented integral. It is integer-like only when the support covers
the full texture, the boundary magnetization is sufficiently uniform, the
support topology is qualified, and the numerical resolution is sufficient.

The sign of `Q` is not the skyrmion-core polarity. Polarity, vorticity, and
helicity are separate texture descriptors. The topological-charge resource
must not expose a field named `polarity` unless a separate, documented
classifier actually evaluates the core magnetization. The production v2
resource therefore removes the current derived `polarity` field.

### 2.5 Assumptions and validity limits

The production observable requires all of the following:

- the requested quantity is the canonical magnetization direction `m`;
- every consumed vector is finite and has norm strictly above `1e-12` before
  normalization;
- the support is planar and uses the canonical frame above;
- FEM geometry and magnetization are nodal P1 on tetrahedra;
- the support triangulation is nonempty, consistently oriented, manifold, and
  free of overlapping duplicate triangles;
- every included triangle has three valid magnetization samples;
- no triangle contains an exceptional or ambiguous solid-angle configuration;
- source field, mesh, object scope, scene, domain, and snapshot provenance are
  mutually consistent.

The following are explicit unsupported cases for this resource:

- `fe_order != 1`;
- curved or nonplanar surface charge;
- missing node-index mapping for a compact `magnetic_only` field;
- an object composed of multiple disconnected magnetic supports;
- a support with invalid interior holes caused by missing/zero/nonfinite data;
- a support whose triangle ownership cannot be proved from object-scoped mesh
  metadata.

Unsupported input returns a typed status. It must never fall back to a global
domain, a surface preview, a raster preview, or a different quantity.

## 3. Numerical interpretation

### 3.1 Shared oriented-triangle kernel

The shared kernel consumes normalized-or-normalizable vectors and explicit
oriented triangles. It returns the integral plus diagnostics; it does not
decide object scope, plane selection, layer selection, cache identity, or UI
status.

Normalization uses a scaled Euclidean norm: divide finite components by their
maximum absolute component before squaring, compute the unit direction from
those scaled components, and compare the original norm with `1e-12` as
`max_abs > 1e-12/scaled_norm`. The implementation does not need to form
`max_abs*scaled_norm`, which could overflow. Direct `x*x+y*y+z*z` is forbidden
because finite large components can overflow and finite small components can
underflow.

For each triangle it must compute:

- the numerator `N=a dot (b cross c)`;
- the denominator `D=1+a dot b+b dot c+c dot a`;
- the three edge angles `acos(clamp(a dot b,-1,1))`,
  `acos(clamp(b dot c,-1,1))`, and `acos(clamp(c dot a,-1,1))`;
- the signed solid angle `2 atan2(N,D)` only after admissibility checks.

A triangle is invalid when any sample is invalid. A triangle is exceptional
when both `abs(N) <= 1e-14` and `abs(D) <= 1e-14`, or when any edge angle is
within `1e-8 rad` of `pi`. Exceptional triangles make the support
`invalid_magnetization`; they are not assigned zero area.

The conservative resolution diagnostic is:

- `resolved`: maximum edge angle `< pi/2`;
- `under_resolved`: maximum edge angle `>= pi/2` but every triangle remains
  non-exceptional;
- `invalid`: at least one exceptional triangle.

`under_resolved` may return a finite diagnostic `Q`, but it may not qualify
nearest-integer interpretation.

The kernel must report at least:

- total and valid vertex counts;
- total, valid, invalid, and exceptional triangle counts;
- maximum edge angle in radians;
- minimum absolute solid-angle denominator;
- connected-component count;
- boundary-edge count;
- boundary-loop count and Euler characteristic;
- accumulated charge using deterministic `f64` summation.

Production accumulation uses compensated summation so reordering triangles
does not introduce avoidable drift.

### 3.2 Support topology qualification

Support construction and kernel evaluation are separate phases. Before the
kernel is called, the support builder must establish:

1. every triangle belongs to the selected magnetic object;
2. every triangle has positive projected area in the canonical `(u,v)` frame;
3. ownership duplicates created by a plane exactly coincident with a shared
   tetrahedral face are resolved by one deterministic owner; any other
   duplicate triangle is a topology error;
4. every interior edge has incidence two;
5. every boundary edge has incidence one;
6. no edge has incidence greater than two;
7. the support has exactly one connected component;
8. invalid samples do not create an interior boundary.

The qualifier also reports boundary-loop count and Euler characteristic. A
connected manifold integral may remain diagnostic when it is not disk-like,
but integer qualification requires exactly one boundary loop and Euler
characteristic one. An object with multiple components is rejected as
`unsupported_geometry` rather than summing unrelated textures.

### 3.3 Boundary qualification

Boundary qualification does not change the integral. It controls whether
integer interpretation is allowed.

Let boundary samples be weighted by their incident boundary-edge lengths. Form
the weighted mean direction and normalize it. Report the maximum geodesic angle
between that direction and every boundary sample. If the weighted mean has norm
`<= 1e-12`, the boundary is not qualified; no arbitrary mean direction is
selected. Accumulate the three weighted components with compensated `f64`
summation and normalize with the same scaled-norm rule as the kernel.

The quantization policy is:

- `qualified` when the support passes topology and resolution gates and the
  maximum boundary deviation is `<= 10 deg`;
- `not_qualified_boundary` when the integral is valid but the boundary
  deviation is larger;
- `not_qualified_resolution` when the result is under-resolved;
- `not_qualified_topology` when topology permits a diagnostic integral but not
  a degree-like interpretation.

`nearest_integer` and `integer_error` are present only for `qualified`.

### 3.4 FDM

The FDM path must use an object-scoped field and object mask. A request for
object `A` must not integrate cells owned by object `B` or the global domain.
If the runtime cannot provide an object mask for a multi-object grid, the
resource returns `unsupported_geometry`.

For a single plane, each rectangular cell is split deterministically into
triangles `(p00,p10,p11)` and `(p00,p11,p01)`, which are positive in the
canonical `(u,v)` frame. A rectangle belongs to the support only when all four
cell-centred samples are mapped to the selected object. Mixed-ownership
rectangles are excluded and become part of the reported support boundary.

For a layer profile, `Q(s_i)` is computed on each object-scoped native plane.
FDM samples are cell-centred, so the scalar thickness summary is the
cell-thickness-weighted mean

```math
\bar Q = \frac{\sum_i \Delta s_i Q(s_i)}{\sum_i \Delta s_i}.
```

For uniform cells this is the arithmetic mean. The endpoint trapezoidal rule
must not be applied to cell-centred samples.

### 3.5 FEM P1

The FEM path consumes:

- the object-scoped tetrahedra;
- global mesh-node ids;
- an explicit mapping from every field sample to its global mesh-node id;
- nodal P1 magnetization values;
- `fe_order=1` provenance.

Both full-domain fields and compact `magnetic_only` fields are valid when the
global node mapping is complete. A vector array is never matched to a mesh by
length alone.

Let `s=n dot x`, and let `[s_min,s_max]` be the selected object's projected
extent. The default FEM support is the exact physical plane
`s=(s_min+s_max)/2`. For every intersected tetrahedron, the support builder:

1. intersects all six tetrahedral edges with the physical plane;
2. identifies cut vertices by global mesh-node id or canonical global-edge key;
3. evaluates the P1 vector field by linear interpolation on the edge;
4. normalizes the interpolated vector at the cut vertex;
5. orders polygon vertices counter-clockwise in `(u,v)`;
6. triangulates the convex polygon deterministically;
7. deduplicates coincident triangles when the cut coincides with a tetrahedral
   face;
8. verifies manifold incidence and object ownership.

The algorithm does not search arbitrary tetrahedral faces for coplanarity and
does not expose a native-layer optimization in resource v2. Exact plane cuts
are authoritative for every FEM request.

For a profile, Fullmag evaluates exact cuts at explicit physical coordinates.
`auto` uses `33` uniformly spaced interior bin-midpoint cuts
`s_i=s_min+(i+1/2)(s_max-s_min)/33`, for integer `i` from `0` through `32`.
Every returned coordinate
is in metres. Failed cuts remain in the profile with a typed status; they are
not silently removed before averaging.

A profile must not rescan every tetrahedron independently for every cut. Build
each object tetrahedron's projected interval once, sort requested cuts by `s`,
and sweep deterministic start/end events to obtain the active tetrahedra for
each cut. Candidate tetrahedra are evaluated in canonical global-id order. The
required work is `O(T log T + K log K + I)` for `T` object tetrahedra, `K` cuts,
and `I` tetra-cut candidate incidences, rather than `O(T*K)` full scans.

The FEM scalar summary is a thickness average over the full interval
`[s_min,s_max]`. Each interior bin-midpoint cut owns its complete bin width, so
uniform `N`-cut profiles use

```math
\bar Q = \frac{1}{N}\sum_{i=0}^{N-1}Q(s_i).
```

Every profile row returns `integration_weight_m=(s_max-s_min)/N`. A
trapezoidal rule over only the interior cut coordinates is forbidden because
it would omit both boundary half-bins. The scalar summary is returned only when
all requested cuts are valid. Otherwise the profile remains available and the
scalar summary is absent.

### 3.6 High-order FEM

This resource rejects missing `fe_order` provenance and `fe_order != 1` with
`unsupported_discretization`; it never assumes P1 from tetrahedral connectivity
alone.
High-order FEM requires a separate versioned method that evaluates geometry and
magnetization at high-order points or performs a certified adaptive
subtriangulation. Linear interpolation over mesh vertices is not an acceptable
high-order fallback.

### 3.7 Hybrid

Hybrid execution is not implemented. A future hybrid observable must name the
owning discretization, support, transfer operator, orientation, and provenance.
It must not average FDM and FEM charges implicitly.

## 4. Runtime, API, IR, and planner impact

### 4.1 Python API surface

No authoring class is added. This is an on-demand analysis over an existing
object and materialized magnetization field. Python analysis helpers may be
added later, but they must call the same versioned resource contract.

### 4.2 ProblemIR representation

No `ProblemIR` field is added. Plane, support mode, profile sampling, snapshot,
and method version are analysis-query state, not physical problem definition.

### 4.3 Planner and capability impact

No solver-selection capability changes. The observable belongs to the
`observables` subsystem and is legal only when its runtime prerequisites are
present. UI availability is determined from object role plus the typed analysis
resource, not from a new global backend capability.

The endpoint must preserve:

- requested and resolved plane;
- requested and resolved support mode;
- method and schema version;
- object id;
- field id, field revision, field storage domain, and global-node mapping id;
- scene revision, mesh revision, mesh generation id, and domain generation id;
- snapshot id and stage id when supplied;
- FEM order and resolved discretization;
- exact cache-key digest.

### 4.4 Resource status and trust

Computation status and trust are separate fields.

Computation status values:

- `ready`;
- `no_current_magnetization`;
- `empty_support`;
- `invalid_magnetization`;
- `degenerate_support`;
- `under_resolved`;
- `unsupported_geometry`;
- `unsupported_discretization`.

Trust values:

- `qualified`;
- `diagnostic_boundary`;
- `diagnostic_resolution`;
- `diagnostic_topology`;
- `unavailable`.

Status is selected by this precedence:

1. missing canonical current/snapshot `m` -> `no_current_magnetization`;
2. unsupported discretization/order -> `unsupported_discretization`;
3. unsupported object ownership, missing object mask/mapping, or disconnected
   object support -> `unsupported_geometry`;
4. no intersecting support triangles -> `empty_support`;
5. zero-area, duplicate, inconsistent, or nonmanifold support ->
   `degenerate_support`;
6. nonfinite, zero-norm, missing, or exceptional magnetization sample ->
   `invalid_magnetization`;
7. otherwise maximum edge angle `>=pi/2` -> `under_resolved`;
8. otherwise -> `ready`.

Trust uses the precedence `unavailable`, `diagnostic_resolution`,
`diagnostic_topology`, `diagnostic_boundary`, `qualified`. All applicable
diagnostics remain in `quality` and `warnings`; the single trust enum never
hides a second failed gate. `nearest_integer` is legal only at the final
`qualified` state.

`Q=0` is displayed as a physical result only when at least one valid triangle
exists and all status invariants pass. Missing or rejected support is never
encoded as zero.

`idle`, `loading`, `stale`, and `error` are resource-transport lifecycle states,
not scientific computation statuses. A provenance race returns HTTP `409`; an
unexpected server failure returns HTTP `500`. Neither is serialized as a
successful scientific result.

### 4.5 Cache and concurrency

The cache identity includes every requested and resolved input listed in
section 4.3 plus the algorithm version. Source identity is mandatory: an
explicit snapshot/stage identity is used for snapshot analysis, while current
analysis uses a canonical `current` source kind plus the captured field
revision. An absent snapshot id is never conflated with an arbitrary preview or
latest persisted snapshot.

Handlers copy the minimum immutable field/mesh metadata under a short-lived
session read lock, release the lock, perform cache lookup, and compute only on a
cache miss. Heavy support construction and serialization must never hold the
live-session lock.

The analysis cache remains bounded by the shared analysis-resource cache
budget. Concurrent misses for the same composite key are single-flight: one
request computes and the others await that result. The keyed-flight entry is
removed on success or failure. Different keys may compute independently, and
no single-flight wait may reacquire or retain the live-session lock.

### 4.6 Realtime invalidation

HTTP v2 is authoritative. WebSocket events only invalidate cached resources.
The object charge family is invalidated by:

- exact or broad changes to magnetization samples;
- mesh revision or mesh generation changes;
- domain generation changes;
- scene changes that affect the selected object scope;
- snapshot replacement or deletion.

On-demand UI remains paused after invalidation and shows stale state until the
user recomputes. Continuous mode refetches through the kernel's existing
invalidation-coalescing policy; it must not add an interval or issue overlapping
loads for the same resource key.

## 5. Unified workspace and Inspector contract

The observable remains an object extension in the unified Explorer and
Inspector. It does not create a separate FEM application or viewport.

The Inspector must provide:

- on-demand evaluation by default;
- explicit continuous mode;
- plane selector `auto|xy|xz|yz`;
- support selector `midplane|layer_profile`;
- profile sample control when automatic certified layers are unavailable;
- snapshot selector when snapshot resources exist;
- resolved orientation frame and normal;
- `Q`, trust state, and qualified integer interpretation;
- a bounded table of every `Q(s_i)` sample with coordinate in metres;
- all warnings, not only the first;
- topology, boundary, resolution, provenance, and cache diagnostics;
- explicit unsupported P1/high-order messaging.

Explorer status is derived from the resource state. Enabling an extension must
not create a child labelled `ready` before a result exists. The activation
state is session/workspace UI state owned by the kernel, not a module-global
singleton.

The extension is offered only for committed magnetic objects. Unsupported
objects remain visible only when explaining a typed reason is useful; they do
not appear as apparently runnable analyses.

## 6. Validation strategy

Convergence error is measured against an independent continuum reference on
the same finite physical support, not blindly against an infinite-domain
integer. The primary smooth oracle is the Belavin-Polyakov texture

```math
\hat{\mathbf m}(x,y)=
\frac{(2\lambda x,\ 2\lambda y,\ x^2+y^2-\lambda^2)}
{x^2+y^2+\lambda^2},
```

with an in-plane rotation for the Bloch variant. A separate adaptive `f64`
quadrature integrates the analytic continuum density over the exact finite
support to absolute tolerance `1e-10`. That reference implementation must not
call the production triangle kernel. Integer-qualification tests use a larger
domain whose raw boundary-deviation diagnostic independently satisfies the
`10 deg` policy; convergence tests may legitimately remain
`diagnostic_boundary`.

### 6.1 Analytical kernel checks

- Uniform magnetization: `abs(Q) <= 1e-12`.
- Analytic Neel and Bloch skyrmions: correct sign for the canonical frame.
- Reversed triangle orientation: equal magnitude and opposite sign to within
  `1e-12`.
- Vortex/meron fixture: half-integer diagnostic charge without false polarity.
- Exceptional antipodal triangle: typed invalid result, never zero.
- Partially invalid 2x2 support: no `ready` result.

### 6.2 FDM convergence

Use the same analytic skyrmion at `33x33`, `65x65`, and `129x129`:

- absolute error `< 0.15`, `< 0.07`, and `< 0.035` respectively;
- empirical convergence rate between successive resolutions `>= 0.8`;
- object-scoped two-object fixture returns independent charges;
- uniform nonunit cell thicknesses use thickness weights;
- uniform cell-centred layers use the arithmetic mean.

For nested refinements with characteristic lengths `h` and `h/2`, the reported
empirical rate is `p=log(e_h/e_{h/2})/log(2)`, using errors against the finite
continuum reference above. A zero reference error is reported separately and
is not divided or replaced by an arbitrary finite rate.

### 6.3 FEM P1 convergence

Use matched regular and skewed tetrahedral films with maximum support edge
lengths `h`, `h/2`, and `h/4`:

- analytic charge error decreases monotonically;
- empirical convergence rate on the last two levels is `>= 0.8`;
- finest-level absolute error is `< 0.05`;
- regular and skewed finest-level results differ by `< 0.03`;
- full-domain and compact `magnetic_only` field layouts agree to `1e-12`;
- tetrahedron numbering and local-node permutation change `Q` by `< 1e-12`;
- exact cuts remain continuous as the plane moves through nondegenerate
  positions;
- `fe_order=2` is rejected with `unsupported_discretization`.

### 6.4 Cross-discretization checks

At matched physical support and comparable resolution:

- FDM and FEM P1 use the same canonical orientation;
- their finest-level analytic errors are each below `0.05`;
- their charges differ by `< 0.05`;
- boundary qualification and trust states agree for the same analytic field.

### 6.5 API and provenance checks

- distinct snapshots produce distinct cache identities and expected charges;
- invalid method, plane, support, profile-sample, and snapshot/stage
  combinations return `400` with typed diagnostics;
- stale field/mesh/domain combinations never return `ready`;
- preview-only and renderer-derived fields are rejected by the production
  resource;
- cache hit occurs before the kernel and does not hold the session lock;
- broad and quantity-scoped realtime events invalidate the same object family;
- OpenAPI, generated types, facade, hook, and Inspector fixtures stay aligned.

### 6.6 Managed runtime proof

Production qualification requires repository-managed recipes, including a
container-backed FEM runtime check. Unit and router tests alone are insufficient.
The implementation plan defines:

- `just verify-topological-charge-fdm-runtime`;
- `just verify-topological-charge-fem-runtime`;
- `just verify-topological-charge-cross-backend`.

The FEM recipe must use the managed FEM runtime bundle and must not substitute a
host-only build.

## 7. Completeness checklist

- [x] Physical problem, equations, units, orientation, and validity limits
- [x] FDM object-scoped and layer-aggregation contract
- [x] FEM P1 exact-cut and profile contract
- [x] High-order rejection contract
- [x] Runtime status, trust, cache, provenance, and invalidation contract
- [x] Python and ProblemIR impact
- [x] Unified Explorer and Inspector contract
- [x] Analytical, convergence, cross-backend, API, and managed-runtime validation targets
- [ ] Runtime implementation conforms to this note
- [ ] OpenAPI and generated client conform to this note
- [ ] Inspector and Explorer conform to this note
- [x] Managed FDM/FEM runtime evidence passes (`just verify-topological-charge-cross-backend`)

## 8. Known limits and deferred work

- Curved-surface degree requires a separate oriented-surface note and resource.
- Full three-dimensional topological flux and Bloch-point diagnostics require a
  separate vector-flux observable.
- Hopf invariant requires a separate 3D contract and validation suite.
- High-order FEM requires a versioned evaluation method; it is not emulated by
  vertex interpolation.
- Density maps require a separate heavy data-plane resource with explicit
  triangle-area projection and units `1/m^2`.
- Component-wise charge for disconnected objects is deferred until component
  identity is stable in mesh provenance.

## 9. References

1. B. Berg and M. Luescher, "Definition and statistical distributions of a
   topological number in the lattice O(3) sigma-model", Nuclear Physics B 190
   (1981), 412-424, DOI `10.1016/0550-3213(81)90568-X`.
2. A. A. Belavin and A. M. Polyakov, "Metastable states of two-dimensional
   isotropic ferromagnets", JETP Letters 22 (1975), 245-247.
3. Existing comparison implementation:
   `external_solvers/amumax/src/cuda/topologicalchargelattice.cu`.
4. Fullmag production implementation target:
   `crates/fullmag-api/src/analysis/topological_charge.rs` and the dedicated
   support-builder modules defined by the implementation plan.
