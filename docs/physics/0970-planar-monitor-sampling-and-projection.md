# Planar monitor sampling and projection

- Status: accepted scientific contract; implemented surfaces remain
  end-to-end unqualified
- Owners: Fullmag physics, runtime, API, and control-room maintainers
- Last updated: 2026-08-12
- Audited source: `5138078f7fd7b65dfc231faa4aa11c02d8ebf52d`
- Related ADRs:
  - `docs/adr/0011-resource-first-api.md`
  - `docs/adr/0016-center-viewport-tabbed-surfaces.md`
  - `docs/adr/0020-planar-field-map-and-monitor.md`
- Related specs:
  - `docs/specs/resource-first-control-room-api-v2.md`
  - `docs/specs/frontend-v2/15-viewport-2d-module.md`
  - `docs/specs/capability-matrix-v0.md`

(planar-monitor-problem-statement)=
## Problem statement

Fullmag publishes scalar and vector fields on cell-centred FDM grids and
nodal P1 FEM meshes. A planar monitor defines a reproducible physical
observation independently of the field quantity, renderer, palette, display
unit, or raster quality. Its authored state contains only:

1. a physical target;
2. an oriented frame and extent policy;
3. one support selector and reduction operator.

The following concerns are separate and must stay separate:

- **support selection** decides which physical points, volumes, or boundary
  pieces belong to a sample;
- **reconstruction and integration** decide how a published discrete field is
  evaluated or reduced on that support;
- **presentation** chooses quantity, component, display unit, resolution,
  palette, range, contours, glyph budget, and mesh overlay.

Changing a presentation option must not change the monitor or the sampled
physical operator. A solver GPU field consumed by the current CPU sampler is a
GPU-source/CPU-sampling path; it is not native GPU sampling.

(planar-monitor-governing-equations)=
## Governing equations

### Oriented frame and raster

The monitor frame is a right-handed orthonormal frame
$\mathcal F=(\mathbf o,\mathbf e_u,\mathbf e_v,\mathbf n)$ with
$\mathbf e_v=\mathbf n\times\mathbf e_u$. World coordinates are

```{math}
:label: eq-planar-frame
\mathbf x(u,v,s)
=\mathbf o+u\mathbf e_u+v\mathbf e_v+s\mathbf n .
```

For resolved bounds $[u_0,u_1]\times[v_0,v_1]$ and raster dimensions
$N_u\times N_v$, pixel $P_{ij}$ has footprint

```{math}
:label: eq-planar-pixel
P_{ij}
= [u_i,u_{i+1}]\times[v_j,v_{j+1}],\qquad
\Delta u=\frac{u_1-u_0}{N_u},\quad
\Delta v=\frac{v_1-v_0}{N_v}.
```

The `plane_sample` support is the point at the pixel centre:

```{math}
:label: eq-planar-plane-support
S^{\mathrm{plane}}_{ij}
=\left\{\mathbf x\!\left(u_i+\frac{\Delta u}{2},
v_j+\frac{\Delta v}{2},0\right)\right\}\cap\Omega_T .
```

Here $\Omega_T$ is the resolved physical target after any legal runtime scope
has intersected it. A point sample has occupancy but no volume or surface
measure.

### Slab, depth, and surface support

For finite thickness $t>0$, the slab support is

```{math}
:label: eq-planar-slab-support
S^{\mathrm{slab}}_{ij}
=\left\{\mathbf x(u,v,s)\in\Omega_T:
(u,v)\in P_{ij},\ -\frac{t}{2}\le s\le\frac{t}{2}\right\}.
```

The depth support replaces the finite interval with the complete target
intersection along the monitor normal:

```{math}
:label: eq-planar-depth-support
S^{\mathrm{depth}}_{ij}
=\left\{\mathbf x(u,v,s)\in\Omega_T:
(u,v)\in P_{ij},\ s\in\mathbb R\right\}.
```

For boundary selector $\Gamma_T\subseteq\partial\Omega_T$, surface projection
uses physical boundary measure on pieces whose projection intersects the
pixel:

```{math}
:label: eq-planar-surface-support
S^{\mathrm{surface}}_{ij}
=\left\{\mathbf x\in\Gamma_T:
\big((\mathbf x-\mathbf o)\cdot\mathbf e_u,
(\mathbf x-\mathbf o)\cdot\mathbf e_v\big)\in P_{ij}\right\}.
```

The visibility policy then chooses `frontmost`, `backmost`,
`nearest_to_origin`, or `area_weighted_overlap` contributions. Multiple
projected faces produce explicit overlap/fold diagnostics; projection is not a
lossless UV parameterization of a folded surface.

### Occupied measure and reductions

For slab and depth operators, the occupied volume and weighted mean are

```{math}
:label: eq-planar-volume-mean
M_{ij}=\int_{S_{ij}}dV,\qquad
\bar q_{ij}=\frac{1}{M_{ij}}\int_{S_{ij}}q(\mathbf x)\,dV,
\quad M_{ij}>0 .
```

For surface projection, replace $dV$ by physical $dA$. The depth
`thickness_integral` is an integral per projected pixel area,

```{math}
:label: eq-planar-thickness-integral
I_{ij}=\frac{1}{\Delta u\,\Delta v}
\int_{S^{\mathrm{depth}}_{ij}}q(\mathbf x)\,dV ,
```

and the RMS reduction is

```{math}
:label: eq-planar-rms
q_{\mathrm{rms},ij}
=\left(\frac{1}{M_{ij}}
\int_{S^{\mathrm{depth}}_{ij}}q(\mathbf x)^2\,dV\right)^{1/2}.
```

`mean_occupied`, `rms`, `min`, `max`, and `abs_max` retain the
source unit; `thickness_integral` multiplies it by metre. Current vector
`min`, `max`, and `abs_max` reductions operate component-wise before the
requested component or magnitude is derived. They must not be interpreted as
an extremum of vector magnitude.

With `exclude_empty`, $M_{ij}=0$ produces an `empty` sample with a non-finite
scalar payload. With `include_air_as_zero`, which is legal only with
`mean_occupied`, the empty scalar payload is zero but occupancy remains
`empty`. Empty samples never enter extrema or automatic display ranges.
A finite slab pixel is `partial` when its occupied volume is less than the
full pixel-prism volume, using the implemented relative comparison.

### Vector reduction and components

Vector fields are integrated component-wise before presentation derives a
component:

```{math}
:label: eq-planar-vector-mean
\bar{\mathbf q}_{ij}
=\frac{1}{M_{ij}}\int_{S_{ij}}\mathbf q(\mathbf x)\,d\mu .
```

```{math}
:label: eq-planar-components
q_u=\bar{\mathbf q}\cdot\mathbf e_u,\qquad
q_v=\bar{\mathbf q}\cdot\mathbf e_v,\qquad
q_n=\bar{\mathbf q}\cdot\mathbf n,\qquad
q_{\parallel}=\sqrt{q_u^2+q_v^2}.
```

The request vocabulary is `x`, `y`, `z`, `u`, `v`, `normal`,
`magnitude`, `in_plane_magnitude`, and `orientation`. Current orientation is
the normalized in-plane angle
$\operatorname{atan2}(q_v,q_u)/(2\pi)\bmod 1$. Vectors whose norm does not
exceed $10^{-12}$ times the maximum raster vector norm receive
`undefined_orientation` and a non-finite scalar.

(planar-monitor-symbols-and-si-units)=
## Symbols and SI units

| LaTeX token | Meaning | SI unit |
|---|---|---|
| `\mathcal F` | Oriented monitor frame | `1` |
| `\mathbf x` | World-space position | `\mathrm{m}` |
| `\mathbf o` | Monitor origin | `\mathrm{m}` |
| `\mathbf e_u` | First in-plane unit vector | `1` |
| `\mathbf e_v` | Second in-plane unit vector | `1` |
| `\mathbf n` | Monitor normal unit vector | `1` |
| `u,v,s` | Coordinates in the monitor frame | `\mathrm{m}` |
| `u_0,u_1,v_0,v_1` | Resolved planar bounds | `\mathrm{m}` |
| `N_u,N_v` | Raster dimensions | `1` |
| `i,j` | Raster indices | `1` |
| `P_{ij}` | Physical pixel footprint in the monitor plane | `\mathrm{m^2}` |
| `\Delta u,\Delta v` | Physical pixel side lengths | `\mathrm{m}` |
| `\Omega_T` | Resolved target volume | `\mathrm{m^3}` |
| `\Gamma_T` | Selected target boundary | `\mathrm{m^2}` |
| `S_{ij}` | Operator-specific occupied support | `\mathrm{m^3}\ \text{or}\ \mathrm{m^2}` |
| `S^{\mathrm{plane}}_{ij}` | Point support for plane sampling | `1` |
| `S^{\mathrm{slab}}_{ij}` | Finite-thickness pixel-prism support | `\mathrm{m^3}` |
| `S^{\mathrm{depth}}_{ij}` | Full-depth pixel-prism support | `\mathrm{m^3}` |
| `S^{\mathrm{surface}}_{ij}` | Selected boundary support projected into a pixel | `\mathrm{m^2}` |
| `t` | Full slab thickness | `\mathrm{m}` |
| `M_{ij}` | Occupied volume or area | `\mathrm{m^3}\ \text{or}\ \mathrm{m^2}` |
| `q` | Scalar source quantity | `[q]` |
| `\mathbf q` | Vector source quantity | `[q]` |
| `\bar q_{ij}` | Occupied-measure scalar mean | `[q]` |
| `\bar{\mathbf q}_{ij}` | Occupied-measure vector mean | `[q]` |
| `I_{ij}` | Thickness integral per projected area | `[q]\,\mathrm{m}` |
| `q_{\mathrm{rms},ij}` | Occupied-measure RMS | `[q]` |
| `dV` | Physical volume element | `\mathrm{m^3}` |
| `dA` | Physical surface element | `\mathrm{m^2}` |
| `d\mu` | Operator-selected physical measure | `\mathrm{m^3}\ \text{or}\ \mathrm{m^2}` |
| `q_u,q_v,q_n` | Components in the resolved monitor frame | `[q]` |
| `q_{\parallel}` | In-plane vector magnitude | `[q]` |
| `c` | FDM cell index | `1` |
| `q_c` | Cell-constant FDM value | `[q]` |
| `V_{c,ij}` | Cell/pixel-support intersection volume | `\mathrm{m^3}` |
| `a` | Local FEM node index | `1` |
| `N_a` | P1 barycentric basis function | `1` |
| `q_a` | Nodal P1 value | `[q]` |
| `N` | Number of nodes in an arithmetic average | `1` |
| `q_{\mathrm{nodes}}` | Illegal unweighted nodal mean | `[q]` |
| `\pi` | Circle constant | `1` |

`[q]` denotes the canonical SI unit of the selected source quantity. Unit
conversion is presentation-only and never mutates the monitor or source
buffer.

(planar-monitor-assumptions-and-validity)=
## Assumptions and validity

- FDM fields are cell-centred and reconstructed as cell-constant.
- FEM sampling is valid only for published tetrahedral P1 nodal fields.
  Higher-order basis evaluation is unsupported; no P1 fallback is legal.
- FDM volume reduction decomposes each hexahedral cell into six tetrahedra.
- FEM volume reduction clips tetrahedra against pixel prisms and integrates
  the P1 field over the clipped polyhedron.
- FEM surface projection currently supports only `object_boundary`.
  `region_boundary` and `named_surface` are authorable but reject during
  sampling because their topology is not published.
- FDM surface projection rejects because boundary topology is not published.
- FDM runtime scopes `mesh_part` and `airbox` reject. FEM permits them only
  when the current mesh publishes the matching part and the intersection with
  the authored target is non-empty.
- The sampler accumulates in binary64. The current planar metadata publishes
  `sampling_execution="cpu"` but does not publish source backend, source
  device, or source precision. Consequently it cannot by itself prove a GPU
  source lane.
- Current clipping code contains absolute coordinate tolerances
  $10^{-13}\,\mathrm m$, squared-distance/area thresholds near
  $10^{-24}\,\mathrm{m^2}$, and relative occupancy/orientation thresholds.
  Nanometre fixtures pass, but scale invariance outside those fixtures is not
  established. Production qualification requires scale-aware tolerances.

(planar-monitor-python-api)=
## Python API

The normal authoring route is `study.monitors.add_planar(...)`. The following
example is stage-first, fixes execution intent explicitly, and contains no
presentation state:

```python
# %% imports and execution intent
import fullmag as fm

study = fm.study("planar-monitor-contract")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(True)
study.wait_for_solve(True)

# %% physical domain
study.universe(
    mode="manual",
    size=(120e-9, 60e-9, 20e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(
    fm.Box(size=(100e-9, 40e-9, 5e-9), name="film"),
    name="film",
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% monitor and physics
monitor = study.monitors.add_planar(
    monitor_id="midplane",
    name="Midplane slab",
    target=fm.MonitorTarget.object("film"),
    frame=fm.PlanarFrame.xy(
        position=0.0,
        extent=fm.PlanarExtent.target_bounds(padding=2e-9),
    ),
    operator=fm.SlabAverage(thickness=5e-9),
)
study.exchange()
study.solver(dt=1e-15, integrator="heun", g=2.115)
study.save("m", every=1e-15)

# %% ordered stage
study.stages.add_run(stage_id="sample", until=1e-15)
```

### Exhaustive public monitor parameter mapping

`required` means that the public factory has no default. Units describe the
parameter itself, not the sampled quantity.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` destination |
|---|---|---|---|---|---|---|---|
| `fm.StudyMonitorRegistry.add_planar.name` | `str` | `required` | `1` | non-empty and unique in the study | Authored monitor name | FDM/FEM CPU/GPU authoring | `planar_monitors[].name` |
| `fm.StudyMonitorRegistry.add_planar.monitor_id` | `str \| None` | `None` | `1` | non-empty and unique when supplied; generated otherwise | Stable monitor identity | FDM/FEM CPU/GPU authoring | `planar_monitors[].id` |
| `fm.StudyMonitorRegistry.add_planar.target` | `MonitorTarget` | `required` | `1` | physical target object required | Physical support owner | FDM/FEM CPU/GPU authoring | `planar_monitors[].target` |
| `fm.StudyMonitorRegistry.add_planar.frame` | `PlanarFrame` | `required` | `1` | finite right-handed orthonormal frame | Plane orientation and extent policy | FDM/FEM CPU/GPU authoring | `planar_monitors[].frame` |
| `fm.StudyMonitorRegistry.add_planar.operator` | `PlanarOperator` | `required` | `1` | one supported tagged operator object | Support and reduction semantics | lane-dependent sampling | `planar_monitors[].operator` |
| `fm.MonitorTarget.object.object_id` | `str` | `required` | `1` | non-empty; must resolve to a magnet in IR validation | Select one object | FDM/FEM CPU/GPU authoring | `planar_monitors[].target.object_id` |
| `fm.MonitorTarget.region.object_id` | `str` | `required` | `1` | non-empty; owner-region pair must exist | Region owner | FDM/FEM CPU/GPU authoring | `planar_monitors[].target.object_id` |
| `fm.MonitorTarget.region.region_id` | `str` | `required` | `1` | non-empty; owner-region pair must exist | Region identity | FDM/FEM CPU/GPU authoring | `planar_monitors[].target.region_id` |
| `fm.PlanarExtent.explicit.u` | `Sequence[float]` | `required` | `\mathrm{m}` | exactly two finite values with minimum less than maximum | Explicit horizontal bounds | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent.u_min_m/u_max_m` |
| `fm.PlanarExtent.explicit.v` | `Sequence[float]` | `required` | `\mathrm{m}` | exactly two finite values with minimum less than maximum | Explicit vertical bounds | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent.v_min_m/v_max_m` |
| `fm.PlanarExtent.target_bounds.padding` | `float` | `0.0` | `\mathrm{m}` | finite and non-negative | Padding around resolved target bounds | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent.padding_m` |
| `fm.PlanarExtent.magnetic_domain.padding` | `float` | `0.0` | `\mathrm{m}` | finite and non-negative | Padding around magnetic-domain bounds | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent.padding_m` |
| `fm.PlanarExtent.universe.padding` | `float` | `0.0` | `\mathrm{m}` | finite and non-negative | Padding around universe bounds | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent.padding_m` |
| `fm.PlanarFrame.origin` | `Sequence[float]` | `required` | `\mathrm{m}` | exactly three finite values | Frame origin | FDM/FEM CPU/GPU | `planar_monitors[].frame.origin_m` |
| `fm.PlanarFrame.normal` | `Sequence[float]` | `required` | `1` | finite non-zero vector | Normal, normalized during lowering | FDM/FEM CPU/GPU | `planar_monitors[].frame.normal` |
| `fm.PlanarFrame.u_axis` | `Sequence[float]` | `required` | `1` | finite and not collinear with normal | First axis, Gram-Schmidt normalized | FDM/FEM CPU/GPU | `planar_monitors[].frame.u_axis` |
| `fm.PlanarFrame.extent` | `PlanarExtent` | `required` | `1` | valid extent object | Authored extent policy | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent` |
| `fm.PlanarFrame.xy/xz/yz.position` | `float` | `required` | `\mathrm{m}` | finite | Axis-preset plane position | FDM/FEM CPU/GPU | `planar_monitors[].frame.origin_m` |
| `fm.PlanarFrame.xy/xz/yz.extent` | `PlanarExtent` | `required` | `1` | valid extent object | Extent attached to preset frame | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent` |
| `fm.SlabAverage.thickness` | `float` | `required` | `\mathrm{m}` | finite and strictly positive | Full slab thickness | FDM/FEM CPU sampler; GPU-source legal | `planar_monitors[].operator.thickness_m` |
| `fm.DepthProjection.reduction` | `PlanarReduction` | `"mean_occupied"` | `1` | mean_occupied, thickness_integral, rms, min, max, or abs_max | Depth reduction | FDM/FEM CPU sampler; GPU-source legal | `planar_monitors[].operator.reduction` |
| `fm.DepthProjection.empty_policy` | `EmptyPolicy` | `"exclude_empty"` | `1` | exclude_empty or include_air_as_zero; latter only with mean_occupied | Empty-bin semantics | FDM/FEM CPU sampler; GPU-source legal | `planar_monitors[].operator.empty_policy` |
| `fm.SurfaceBoundary.region_boundary.region_id` | `str` | `required` | `1` | non-empty; sampling currently rejects unpublished topology | Region boundary selector | authoring only; sampling unsupported | `planar_monitors[].operator.boundary.region_id` |
| `fm.SurfaceBoundary.named.surface_id` | `str` | `required` | `1` | non-empty; sampling currently rejects unpublished topology | Named boundary selector | authoring only; sampling unsupported | `planar_monitors[].operator.boundary.surface_id` |
| `fm.SurfaceProjection.boundary` | `SurfaceBoundary` | `required` | `1` | boundary object required | Surface support selector | FEM P1 object boundary only | `planar_monitors[].operator.boundary` |
| `fm.SurfaceProjection.visibility_policy` | `SurfaceVisibilityPolicy` | `"frontmost"` | `1` | frontmost, backmost, nearest_to_origin, or area_weighted_overlap | Fold/overlap selection | FEM P1 object boundary only | `planar_monitors[].operator.visibility_policy` |

`MonitorTarget.magnetic_domain()` and `MonitorTarget.domain()` have no
parameters. `PlaneSample()` and `SurfaceBoundary.object_boundary()` also have
no parameters. Direct dataclass construction remains possible, but the factory
methods above are the canonical script-export surface.

(planar-monitor-problem-ir)=
## ProblemIR

The example's `monitor.to_ir()` output, stored as the sole member of
`ProblemIR.planar_monitors`, is:

```json
{
  "id": "midplane",
  "name": "Midplane slab",
  "target": {
    "kind": "object",
    "object_id": "film"
  },
  "frame": {
    "origin_m": [0.0, 0.0, 0.0],
    "u_axis": [1.0, 0.0, 0.0],
    "v_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
    "preset": "xy",
    "normalization_version": "planar_frame_v1",
    "extent": {
      "kind": "target_bounds",
      "padding_m": 2e-09
    }
  },
  "operator": {
    "kind": "slab_average",
    "thickness_m": 5e-09
  }
}
```

Python normalizes strings for reduction policies to lowercase, constructs
$\mathbf e_v=\mathbf n\times\mathbf e_u$, and serializes all coordinates in
metres. Rust validates unique IDs/names, target references, orthonormality,
right-handedness, normalization version, extents, thickness, and the
`include_air_as_zero` restriction. Missing `planar_monitors` in older payloads
normalizes to an empty list.

(planar-monitor-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Canonical Python export uses `study.monitors.add_planar(...)` and preserves
semantic equality through Python → `ProblemIR` → `SceneDocument` → canonical
Python → `ProblemIR`. The authored monitor contains requested intent. Dynamic
bounds and runtime scopes are resolved execution facts and must not overwrite
that intent.

Validation errors reject non-finite or degenerate frames, invalid extents,
duplicate identities, missing targets, invalid policies, and non-positive slab
thickness. Unsupported combinations fail explicitly:

- FDM + `surface_projection`:
  `unsupported_planar_operator: FDM boundary surface topology is not published`;
- FEM + region or named surface:
  `unsupported_region_boundary_projection` or
  `unsupported_named_surface_projection`;
- FDM + `mesh_part` or `airbox` runtime scope:
  `planar_scope_unsupported`;
- absent field: `quantity_not_materialized`;
- stale target/scope/revision: the corresponding stable stale or empty-scope
  reason.

`strict` and `extended` preserve the same monitor semantics. `extended` does
not authorize a hidden substitute. Future `hybrid` execution must be explicit
and must preserve both requested intent and resolved execution in provenance.

(planar-monitor-discrete-realization)=
## Discrete realization and lane legality

The source lane names the solver that produced the published field. All
currently implemented sampling kernels execute on CPU.

| Source lane | Legal current sampling | Sampler | Qualification at audited source |
|---|---|---|---|
| FDM CPU | plane, slab, depth; monitor target scope | CPU binary64 | managed science artifact passed; end-to-end runtime/browser/production unqualified because the same recipe ended RED in the browser |
| FDM GPU | plane, slab, depth only after a compatible field is published and transported | CPU binary64 | source-compatible by code path only; no fresh GPU-source/device proof and no native GPU sampling |
| FEM CPU | P1 plane, slab, depth, object-boundary surface; FEM mesh-part/airbox only with published intersecting topology | CPU binary64 | focused numerical/API tests exist; no fresh managed FEM or browser qualification for this task |
| FEM GPU | same P1 operators only after a compatible field is published and transported | CPU binary64 | source-compatible by code path only; no fresh GPU-source/device proof and no native GPU sampling |

### FDM realization

`plane_sample` returns the cell-constant value of the selected cell at the
pixel centre. Slab and depth operators decompose every selected grid cell into
six tetrahedra, clip them against the pixel prism, and accumulate physical
intersection volume:

```{math}
:label: eq-planar-fdm-discrete
\bar q_{ij}^{\mathrm{FDM}}
=\frac{\sum_{c}q_c V_{c,ij}}{\sum_c V_{c,ij}} .
```

The resolved FDM membership artifact supplies grid origin, cell size, active
support, object identities, numeric region membership, and legend. Missing or
incompatible membership rejects; the sampler must not silently use the full
rectangular storage grid. Current object targeting selects active cells for the
object after verifying that the object identity exists; the published
membership does not yet distinguish multiple object IDs cell-by-cell.

### FEM P1 realization

Plane sampling locates a containing tetrahedron and evaluates the nodal P1
field by barycentric interpolation:

```{math}
:label: eq-planar-fem-p1
q_h(\mathbf x)=\sum_{a=1}^{4}N_a(\mathbf x)\,q_a,\qquad
\sum_{a=1}^{4}N_a(\mathbf x)=1 .
```

Slab/depth integration clips each tetrahedron against the pixel prism and
integrates the linear field over the clipped polyhedron. Surface projection
extracts exterior tetrahedral faces, clips them in $(u,v)$, integrates the P1
trace with physical triangle area, and applies the requested visibility
policy. Spatial lookup is currently a direct element traversal, not the
previously planned revision-keyed spatial index.

### Why node-count averaging is illegal

An unweighted nodal mean,

```{math}
:label: eq-planar-node-average
q_{\mathrm{nodes}}=\frac{1}{N}\sum_{a=1}^{N}q_a ,
```

changes under local refinement even when the represented continuous field does
not. The FEM regression refines a skew tetrahedral P1 field and requires the
measure-weighted result to remain invariant.

(planar-monitor-implementation-mapping)=
## Implementation mapping

The public model, IR, runtime sampler, API resource, and UI renderer are
separate owners. The API resolves authored target/extent and presentation
query into `ResolvedPlanarSampleRequest`, then invokes
`PlanarSamplingEngine`. The Control Room consumes revisioned metadata and
binary scalar/vector/mask/overlay resources through resource hooks; it does
not recompute sampling.

The API metadata currently exposes monitor identity/hash, revisions, frame,
resolution, pixel size, support, sampling execution/method/version, basis and
integration order, occupancy, overlap/fold diagnostics, extrema, ETag, and
resource links. It does not yet expose source backend/device/precision or a
complete requested/resolved execution record. That provenance gap blocks GPU
source qualification.

(planar-monitor-validation)=
## Validation

### Required numerical gates

| ID | Fixture | Acceptance |
|---|---|---|
| PM-N01 | constant scalar/vector FDM | exact plane/slab/depth values and frame components |
| PM-N02 | linear/layered FDM | analytic volume-weighted mean/RMS and occupied support |
| PM-N03 | arbitrary plane through skew P1 tetrahedron | barycentric value within declared tolerance |
| PM-N04 | P1 slab/depth on skew tetrahedra | analytic integral and refinement invariance |
| PM-N05 | partial and empty support | correct occupancy; empty excluded from extrema |
| PM-N06 | zero and non-zero vector raster | correct `u/v/normal` components and undefined orientation |
| PM-N07 | planar FEM boundary | analytic physical-area weighted value |
| PM-N08 | overlapping/folded FEM surface | explicit ambiguity and fold diagnostics |
| PM-N09 | unsupported surface selector | stable rejection; no object-boundary substitution |
| PM-N10 | FDM membership target | inactive/non-selected cells remain empty |
| PM-N11 | geometry scale sweep | unchanged dimensionless result with scale-aware tolerances |

### Task 0 evidence boundary

At exact managed source
`5138078f7fd7b65dfc231faa4aa11c02d8ebf52d`,
`just run-viewport-2d-planar-monitor-smoke fdm cpu` produced an FDM CPU science
report with all recorded science gates true, including plane, slab, depth,
surface-fixture, analytic RMS, occupancy, probe identity, explicit CPU
postprocessing, and cross-backend manufactured-field checks.

The same invocation then exited 1 after 180000 ms waiting for a visible
`.fm-field-map__canvas`. A pre-existing browser JSON carrying `pass: true` is
not evidence for this invocation because the current browser process failed
before producing a qualifying visible-canvas result. Therefore:

- the FDM CPU managed science artifact is accepted as a narrow numerical gate;
- no lane is browser-qualified;
- the complete implementation is not end-to-end runtime-qualified or
  production-qualified;
- FDM GPU, FEM CPU, and FEM GPU require their own fresh managed source,
  requested/resolved lane, device where applicable, science, API data-origin,
  and browser evidence.

### Publication gates

The page and adjacent source map must pass the scientific validator, its unit
tests, the changed-page gate from the audited base, strict documentation build,
rendered MathJax/copy-control validation, and the public-example guard.
Structural validation does not prove scientific correctness.

(planar-monitor-limitations)=
## Limitations

- Native GPU sampling is absent.
- FDM surface topology and FDM mesh-part/airbox scopes are absent.
- FEM region-boundary and named-surface topology are absent.
- FEM higher-order basis evaluation is absent.
- Source backend/device/precision are missing from planar resource metadata.
- Scale-aware clipping tolerances and a spatial index remain required for
  production performance and scale invariance.
- The failed current browser smoke blocks visible-canvas, lifecycle,
  accessibility, performance, and 3D/2D preservation qualification.
- Movie/time-series export and simultaneous heavy center surfaces are outside
  this contract.
- A stage output that mandates `quantity @ monitor` requires a separate output
  and lifecycle contract.

(planar-monitor-scientific-bibliography)=
## Scientific bibliography

1. P. G. Ciarlet, *The Finite Element Method for Elliptic Problems*,
   SIAM Classics in Applied Mathematics, 2002,
   [doi:10.1137/1.9780898719208](https://doi.org/10.1137/1.9780898719208).
2. J. K. Dukowicz and J. W. Kodis, “Accurate conservative remapping
   (rezoning) for arbitrary Lagrangian-Eulerian computations,”
   *SIAM Journal on Scientific and Statistical Computing* 8(3), 1987,
   [doi:10.1137/0908037](https://doi.org/10.1137/0908037).
3. I. E. Sutherland and G. W. Hodgman, “Reentrant polygon clipping,”
   *Communications of the ACM* 17(1), 1974,
   [doi:10.1145/360767.360802](https://doi.org/10.1145/360767.360802).

(planar-monitor-source-code-index)=
## Source-code index

Immutable links below resolve against the audited Task 0 source. Test names are
stable symbols, not line-number claims.

| Equation or claim | Path | Stable symbol | Responsibility | Lane | Tests/evidence | Status | Immutable link |
|---|---|---|---|---|---|---|---|
| Python monitor authoring and normalization | `packages/fullmag-py/src/fullmag/model/planar_monitor.py` | `class PlanarMonitor` | Public monitor object and lowering | all authoring lanes | `packages/fullmag-py/tests/test_planar_monitor.py::PlanarMonitorContractTests` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/packages/fullmag-py/src/fullmag/model/planar_monitor.py) |
| Canonical Python export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_planar_monitors` | `SceneDocument`/IR to stage-first Python | all authoring lanes | `test_planar_monitors_roundtrip_through_scene_and_canonical_python` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/packages/fullmag-py/src/fullmag/runtime/script_builder.py) |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_planar_monitors` | Identity, target, frame, extent, and operator validation | all authoring lanes | `crates/fullmag-ir/tests/ir_tests.rs::planar_monitor_validation_rejects_invalid_values_and_duplicates` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-ir/src/validation.rs) |
| Frame equations | `crates/fullmag-api/src/planar_sampling/frame.rs` | `try_from_ir` | Resolve and validate physical frame | all sampling lanes | `planar_sampling_fem_p1_linear_arbitrary_plane_is_barycentric` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/frame.rs) |
| Backend-neutral sampler entry | `crates/fullmag-api/src/planar_sampling/contract.rs` | `sample_fdm` | Validate request and apply requested component | FDM source | `planar_sampling_fdm_constant_scalar_and_vector_basis_are_exact` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/contract.rs) |
| Vector component semantics | `crates/fullmag-api/src/planar_sampling/contract.rs` | `apply_component` | Derive world/monitor components after reduction | FDM/FEM source | `planar_sampling_orientation_uses_monitor_basis_and_masks_zero_vectors` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/contract.rs) |
| FDM point and volume operators | `crates/fullmag-api/src/planar_sampling/fdm.rs` | `sample` | Dispatch cell-constant plane/slab/depth and reject surface | FDM CPU sampler | `planar_sampling_fdm_linear_depth_is_measure_weighted_and_masks_empty_pixels` | managed FDM CPU science pass; browser RED | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/fdm.rs) |
| Conservative clipping | `crates/fullmag-api/src/planar_sampling/geometry.rs` | `integrate_clipped_tetra` | Clip and integrate volume support | FDM/FEM CPU sampler | `planar_sampling_fem_volume_mean_is_not_node_count_average_and_is_refinement_invariant` | focused tests; scale sweep open | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/geometry.rs) |
| Measure-weighted reductions | `crates/fullmag-api/src/planar_sampling/reduction.rs` | `finish` | Mean, integral, RMS, extrema, and empty result semantics | FDM/FEM CPU sampler | `planar_sampling_fdm_linear_depth_is_measure_weighted_and_masks_empty_pixels` | focused tests; managed FDM CPU science pass | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/reduction.rs) |
| FEM P1 point and volume operators | `crates/fullmag-api/src/planar_sampling/fem.rs` | `sample` | Dispatch P1 plane/slab/depth/surface | FEM CPU sampler | `planar_sampling_fem_p1_linear_arbitrary_plane_is_barycentric` | focused tests; managed/browser open | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/fem.rs) |
| FEM physical boundary projection | `crates/fullmag-api/src/planar_sampling/surface.rs` | `sample_boundary` | Clip boundary faces and apply visibility | FEM CPU sampler | `planar_sampling_surface_clips_boundary_faces_across_pixel_footprints` | focused tests; managed/browser open | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/surface.rs) |
| Resource extent resolution | `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs` | `resolve_dynamic_extent` | Resolve authored dynamic bounds from FDM/FEM field support | FDM/FEM source | `planar_field_resources_publish_meta_binary_probe_png_and_etag` | focused API tests; browser RED | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs) |
| Frontend request plan | `apps/control-room/src/modules/field-map/model/fieldMapDataPlan.ts` | `buildFieldMapDataPlan` | Bound resource requests and reject illegal FDM scopes | browser | `fieldMapDataPlan.test.ts` | component tests; browser RED | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/apps/control-room/src/modules/field-map/model/fieldMapDataPlan.ts) |
| Revisioned frontend resources | `apps/control-room/src/kernel/resources/planarFieldResources.ts` | `usePlanarFieldMetaResource` | Typed resource hook and revision identity | browser | `planarFieldResources.test.ts` | component tests; browser RED | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/apps/control-room/src/kernel/resources/planarFieldResources.ts) |
| Canvas renderer | `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx` | `PlanarSurface` | Render sampled raster and overlays | browser | `PlanarSurface.test.tsx`; Task 0 visible-canvas timeout | browser RED | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx) |
