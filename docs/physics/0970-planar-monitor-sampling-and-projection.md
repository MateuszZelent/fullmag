# Planar monitor sampling and projection

- Status: accepted scientific contract; implemented surfaces remain
  end-to-end unqualified
- Owners: Fullmag physics, runtime, API, and control-room maintainers
- Last updated: 2026-08-13
- Audited Task 7A implementation delta: `9c3a779571c2815dec8279dbd56d5604b09ab784`
- Historical Task 0 evidence source: `5138078f7fd7b65dfc231faa4aa11c02d8ebf52d`
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

(default-planar-source-contract)=
### Authored monitor and session-resolved default source

The planar view has two source identities. An authored `PlanarMonitor` is a
durable model object: it is created explicitly, round-trips through
`SceneDocument`, `ProblemIR`, and canonical Python, and owns its target, frame,
extent, and operator. `Default` is a session-resolved planar source: it is
derived from `visualization/state.planar` and the current published domain
metadata, is not a model object, and must never be serialized as a monitor.

| Source | Owner | Persistence | Python / `ProblemIR` | Resolved physical definition |
|---|---|---:|---:|---|
| Authored `PlanarMonitor` | `SceneDocument.monitors.planar[]` | model | yes | authored target, frame, extent, and operator |
| `Default` | session visualization state + domain metadata | session | no | domain target, axis-preset frame, resolved extent, and default operator |

After source resolution, both identities use the same frame validation,
interpolation, occupancy handling, physical-measure integration, and
measure-weighted reduction. Only the provenance of the target, frame, and
operator differs. `Default` therefore cannot be implemented by inventing a
monitor ID or by using a separate browser-side sampler.

For `Default`, the normal-axis coordinate is resolved from the published
domain bounds. Let $\phi$ be the validated dimensionless
`position_fraction`, and let $b_{\min}$ and $b_{\max}$ be the finite SI bounds
along the selected normal. The resolved `position_m` is

```{math}
:label: eq-planar-default-position
\phi=\operatorname{clamp}(\mathrm{position\_fraction},0,1),\qquad
p_n=b_{\min}+\phi\bigl(b_{\max}-b_{\min}\bigr),
\quad b_{\min},b_{\max},p_n\in\mathrm{m}.
```

Public state validation rejects non-finite `position_fraction` or a value
outside $[0,1]$; the clamp in the resolver is defensive for migrated state.
`position_m` must be finite and lie within the selected normal bounds.
The initial default is `xy`, $\phi=0.5$, and `plane_sample`. A default
`slab_average` is legal only with finite `thickness_m` and $t>0$; depth and surface
operators remain authored-monitor capabilities until they have an explicit
source and Inspector contract.

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
`empty`. The terminal contract excludes every `empty` sample from scientific
extrema and automatic display ranges, independently of its serialized scalar
payload. The current FDM implementation writes `0.0` for
`include_air_as_zero`, while `meta_resource` computes `scalar_min` and
`scalar_max` by filtering only non-finite values. That implementation therefore
includes empty-air zero in metadata extrema and diverges from the terminal
contract. Until an occupancy-aware extrema gate passes,
`include_air_as_zero` extrema and automatic ranges are unqualified; consumers
must apply the empty mask or request `exclude_empty`. A finite slab pixel is
`partial` when its occupied volume is less than the full pixel-prism volume,
using the implemented relative comparison.

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

Because every component is a function of the reduced vector $\bar{\mathbf q}$
alone, `x`, `y`, `z` and `magnitude` computed from the published vector raster
of a sample equal the backend scalar raster of that component exactly
(component-of-average; for the linear components this also equals the average
of the component, for `magnitude` it does not, $|\bar{\mathbf q}|\le\overline{|\mathbf q|}$).
The Control Room therefore switches among these four components of a
three-component, non-tensor `plane_sample` without requesting a new sample; it
uses the backend path for every other case, including slab, depth and surface
operators, although the identity above would also hold there.

(planar-monitor-symbols-and-si-units)=
## Symbols and SI units

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $\mathcal F$ | Oriented monitor frame | $1$ |
| $\mathbf x$ | World-space position | $\mathrm{m}$ |
| $\mathbf o$ | Monitor origin | $\mathrm{m}$ |
| $\mathbf e_u$ | First in-plane unit vector | $1$ |
| $\mathbf e_v$ | Second in-plane unit vector | $1$ |
| $\mathbf n$ | Monitor normal unit vector | $1$ |
| $u,v,s$ | Coordinates in the monitor frame | $\mathrm{m}$ |
| $u_0,u_1,v_0,v_1$ | Resolved planar bounds | $\mathrm{m}$ |
| $N_u,N_v$ | Raster dimensions | $1$ |
| $i,j$ | Raster indices | $1$ |
| $P_{ij}$ | Physical pixel footprint in the monitor plane | $\mathrm{m^2}$ |
| $\Delta u,\Delta v$ | Physical pixel side lengths | $\mathrm{m}$ |
| $\Omega_T$ | Resolved target volume | $\mathrm{m^3}$ |
| $\Gamma_T$ | Selected target boundary | $\mathrm{m^2}$ |
| $S_{ij}$ | Operator-specific occupied support | $\mathrm{m^3}\ \text{or}\ \mathrm{m^2}$ |
| $S^{\mathrm{plane}}_{ij}$ | Point support for plane sampling | $1$ |
| $S^{\mathrm{slab}}_{ij}$ | Finite-thickness pixel-prism support | $\mathrm{m^3}$ |
| $S^{\mathrm{depth}}_{ij}$ | Full-depth pixel-prism support | $\mathrm{m^3}$ |
| $S^{\mathrm{surface}}_{ij}$ | Selected boundary support projected into a pixel | $\mathrm{m^2}$ |
| $t$ | Full slab thickness | $\mathrm{m}$ |
| $\phi$ | Validated default-source position fraction | $1$ |
| $p_n$ | Resolved physical coordinate along the selected normal | $\mathrm{m}$ |
| $b_{\min},b_{\max}$ | Published domain bounds along the selected normal | $\mathrm{m}$ |
| $M_{ij}$ | Occupied volume or area | $\mathrm{m^3}\ \text{or}\ \mathrm{m^2}$ |
| $q$ | Scalar source quantity | $[q]$ |
| $\mathbf q$ | Vector source quantity | $[q]$ |
| $\bar q_{ij}$ | Occupied-measure scalar mean | $[q]$ |
| $\bar{\mathbf q}_{ij}$ | Occupied-measure vector mean | $[q]$ |
| $I_{ij}$ | Thickness integral per projected area | $[q]\,\mathrm{m}$ |
| $q_{\mathrm{rms},ij}$ | Occupied-measure RMS | $[q]$ |
| $dV$ | Physical volume element | $\mathrm{m^3}$ |
| $dA$ | Physical surface element | $\mathrm{m^2}$ |
| $d\mu$ | Operator-selected physical measure | $\mathrm{m^3}\ \text{or}\ \mathrm{m^2}$ |
| $q_u,q_v,q_n$ | Components in the resolved monitor frame | $[q]$ |
| $q_{\parallel}$ | In-plane vector magnitude | $[q]$ |
| $c$ | FDM cell index | $1$ |
| $q_c$ | Cell-constant FDM value | $[q]$ |
| $V_{c,ij}$ | Cell/pixel-support intersection volume | $\mathrm{m^3}$ |
| $A_{c,ij}$ | Area of the cell section inside the pixel footprint | $\mathrm{m^2}$ |
| $a$ | Local FEM node index | $1$ |
| $N_a$ | Tet4 barycentric or Prism6 triangle-P1 tensor-product interval-P1 basis function | $1$ |
| $r$ | First Prism6 triangle reference coordinate | $1$ |
| $s$ | Second Prism6 triangle reference coordinate | $1$ |
| $\zeta$ | Prism6 interval reference coordinate | $1$ |
| $J$ | Jacobian of the Prism6 isoparametric map | $\mathrm{m}$ |
| $q_a$ | Nodal P1 value | $[q]$ |
| $N$ | Number of nodes in an arithmetic average | $1$ |
| $q_{\mathrm{nodes}}$ | Illegal unweighted nodal mean | $[q]$ |
| $W_{pa}$ | Sampling-operator weight of carrier degree of freedom $a$ in pixel $p$ | $1\ \text{(plane)}\ \text{or}\ \mathrm{m^3}\ \text{(slab, depth)}$ |
| $M_p$ | Sampling-operator measure of pixel $p$ ($1$ for occupied plane pixels) | $1\ \text{or}\ \mathrm{m^3}$ |
| $\Pi_p$ | Pixel prism of pixel $p$ for slab/depth operators | $\mathrm{m^3}$ |
| $\boldsymbol\xi_e$ | Reference coordinates of a point in element $e$ | $1$ |
| $\xi,\eta$ | Hex8/Pyramid5 in-plane reference coordinates | $1$ |
| $\tau$ | Hex8/Pyramid5 vertical reference coordinate | $1$ |
| $h_e$ | Diameter of element $e$ | $\mathrm{m}$ |
| $\varepsilon_x$ | Scale-relative geometric tolerance | $\mathrm{m}$ |
| $\varepsilon_\xi$ | Reference-space containment tolerance | $1$ |
| $\mathbf x_\star$ | Probe world position | $\mathrm{m}$ |
| $p_n^{\mathrm{req}}$ | Requested coordinate along the default-slice normal | $\mathrm{m}$ |
| $p_n^{\mathrm{res}}$ | Resolved coordinate along the default-slice normal | $\mathrm{m}$ |
| $k$ | FDM cell-layer index along the normal | $1$ |
| $N_n$ | FDM cell count along the normal | $1$ |
| $h_n$ | FDM cell edge along the normal | $\mathrm{m}$ |
| $h_\perp$ | Navigation step of a continuous FEM section: median normal extent of the cut target elements | $\mathrm{m}$ |
| $\pi$ | Circle constant | $1$ |

`[q]` denotes the canonical SI unit of the selected source quantity. Unit
conversion is presentation-only and never mutates the monitor or source
buffer.

(planar-monitor-assumptions-and-validity)=
## Assumptions and validity

- FDM fields are cell-centred and reconstructed as cell-constant.
- FEM sampling accepts complete or explicitly mapped nodal P1 payloads on
  topology-valid Tet4 and Prism6 cells: after
  component flattening, the value count must equal the complete published mesh
  node count. Element scoping is applied only after that carrier is loaded.
  Element-local, selected-part-only, discontinuous, cell-centred, and
  higher-order FEM payloads are unsupported; no P1 fallback is legal.
- FDM volume reduction decomposes each hexahedral cell into six tetrahedra.
- FEM volume reduction clips the native convex Tet4 or Prism6 cell against
  pixel prisms and integrates the P1 field over the clipped polyhedron. Prism6
  is not reduced to its first four nodes and is not silently tetrahedralized.
- FEM surface projection currently supports only `object_boundary`.
  `region_boundary` and `named_surface` are authorable but reject during
  sampling because their topology is not published.
- FDM surface projection rejects because boundary topology is not published.
- Dla legalnego FDM `monitor_target` operatorów `plane_sample`,
  `slab_average` i `depth_projection` warstwa `mesh` przedstawia proceduralny
  przekrój wybranych komórek structured grid przez centralną płaszczyznę
  monitora $s=0$. Dla slab/depth jest to geometria nośnika w płaszczyźnie
  środkowej, a nie obrys całej objętości całkowania. Reprezentacja `FMFG v1`
  zachowuje fizyczne współrzędne $(u,v)$ i nie może zostać zastąpiona
  prostokątem zasięgu monitora ani zrekonstruowana z rastra.
- `FMFG v1` nie publikuje topologii granicy targetu. Warstwa `boundaries`
  pozostaje dla FDM niedostępna z jawnym powodem
  `target_boundaries_unavailable`; żaden segment siatki nie może być
  przedstawiony jako dokładna granica obiektu lub regionu.
- FDM runtime scopes `mesh_part` and `airbox` reject. `domain` selects the
  rectangular field carrier, `magnetic_domain` selects all active cells, and
  `region` selects the matching numeric membership. `object` is correct only
  for a single-object/all-active-cells-equivalent grid: the current code checks
  that the requested object ID exists but then selects every active cell, so
  multi-object FDM object targeting is semantically incorrect and unqualified.
- FDM applies that target mask before resolving extent, then collapses
  `target_bounds`, `magnetic_domain`, and `universe` into one bounds algorithm
  over the already-selected mask. Consequently `target_bounds + object` is
  wrong on a multi-object grid; `magnetic_domain + domain` can include inactive
  carrier cells; `magnetic_domain + region` is too narrow; and `universe` with
  `magnetic_domain`, `object`, or `region` is too narrow. An object mask fixed
  in isolation would also make `magnetic_domain + object` too narrow. No FDM
  dynamic tag is qualified as a distinct semantic policy; use an explicit
  extent until the three policies are resolved independently of target scope.
- FEM target and runtime scopes select elements from mesh-part ranges, but only
  after the full-nodal P1 carrier has loaded. `mesh_part` and `airbox` therefore
  require a published intersecting part and a compatible full-mesh nodal
  quantity; they do not authorize a scoped carrier.
- FEM `target_bounds`, `magnetic_domain`, and `universe` dynamic extents all
  currently project every published mesh node. They do not distinguish the
  selected target or runtime scope, despite being resolved after element
  selection. Scoped FEM dynamic extents are therefore semantically incorrect
  and unqualified; use an explicit extent for a faithful scoped result.
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

### Session-resolved default-source state (not Python API)

The following fields belong to the session visualization contract, not to
`PlanarMonitor`, canonical Python, or `ProblemIR`. They are resolved by the
backend before the common sampler is called.

| Field | Type | Default | SI unit | Validation | Meaning | Lane status | `ProblemIR` destination |
|---|---|---|---|---|---|---|---|
| Session-resolved `Default` source contract | `docs/physics/0970-planar-monitor-sampling-and-projection.md` | `DOC-ANCHOR:default-planar-source-contract` | Distinguish session source resolution from authored monitor state without claiming a typed implementation | all | Task 0 documentation regression; typed state/resolver tests deferred | planned contract | pending implementation |
| `default_slice.position_fraction` | `float` | `0.5` | $1$ | finite and in $[0,1]$; public out-of-range values reject | Dimensionless position between the published bounds along the selected normal | planned typed session contract; no qualification yet | none |
| resolved `position_m` | `float` | resolved from domain bounds | $\mathrm{m}$ | finite and within `[normal_min_m, normal_max_m]`; read-only resolved value | Physical coordinate used to construct the default frame | planned typed session contract; no qualification yet | none |
| `default_slice.operator.thickness_m` | `float` | absent for `plane_sample` | $\mathrm{m}$ | required and strictly positive for `slab_average`; absent for `plane_sample` | Full slab thickness passed to the common measure-weighted sampler | planned typed session contract; no qualification yet | none |

These fields do not add a second numerical method. `position_fraction` and
`position_m` select the target/frame provenance for `Default`; `thickness_m`
selects the same slab operator already documented for authored monitors.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` destination |
|---|---|---|---|---|---|---|---|
| `fullmag.model.StudyMonitorRegistry.add_planar.name` | `str` | `required` | $1$ | non-empty and unique in the study | Authored monitor name; normally called as `study.monitors.add_planar(name=...)` | FDM/FEM CPU/GPU authoring | `planar_monitors[].name` |
| `fullmag.model.StudyMonitorRegistry.add_planar.monitor_id` | `str \| None` | `None` | $1$ | non-empty and unique when supplied; generated otherwise | Stable monitor identity; normally called as `study.monitors.add_planar(monitor_id=...)` | FDM/FEM CPU/GPU authoring | `planar_monitors[].id` |
| `fullmag.model.StudyMonitorRegistry.add_planar.target` | `MonitorTarget` | `required` | $1$ | physical target object required | Physical support owner; normally called as `study.monitors.add_planar(target=...)` | FDM/FEM CPU/GPU authoring | `planar_monitors[].target` |
| `fullmag.model.StudyMonitorRegistry.add_planar.frame` | `PlanarFrame` | `required` | $1$ | finite right-handed orthonormal frame | Plane orientation and extent policy; normally called as `study.monitors.add_planar(frame=...)` | FDM/FEM CPU/GPU authoring | `planar_monitors[].frame` |
| `fullmag.model.StudyMonitorRegistry.add_planar.operator` | `PlanarOperator` | `required` | $1$ | one supported tagged operator object | Support and reduction semantics; normally called as `study.monitors.add_planar(operator=...)` | lane-dependent sampling | `planar_monitors[].operator` |
| `fullmag.model.StudyMonitorRegistry.storage` | `list[PlanarMonitor] \| None` | `None` | $1$ | existing list is retained by reference; no constructor type check | Initial mutable registry storage | authoring helper; not a root `fm` export | `planar_monitors[]` |
| `fm.PlanarMonitor.name` | `str` | `required` | $1$ | non-empty; constructor does not enforce cross-monitor uniqueness | Direct monitor name | FDM/FEM CPU/GPU authoring | `planar_monitors[].name` |
| `fm.PlanarMonitor.target` | `MonitorTarget` | `required` | $1$ | must be `MonitorTarget` | Direct physical target | FDM/FEM CPU/GPU authoring | `planar_monitors[].target` |
| `fm.PlanarMonitor.frame` | `PlanarFrame` | `required` | $1$ | must be `PlanarFrame` | Direct frame | FDM/FEM CPU/GPU authoring | `planar_monitors[].frame` |
| `fm.PlanarMonitor.operator` | `PlanarOperator` | `required` | $1$ | must be one of the four public operator classes | Direct operator | lane-dependent sampling | `planar_monitors[].operator` |
| `fm.PlanarMonitor.monitor_id` | `str \| None` | `None` | $1$ | generated when None; otherwise non-empty; constructor does not enforce cross-monitor uniqueness | Direct stable monitor identity | FDM/FEM CPU/GPU authoring | `planar_monitors[].id` |
| `fm.MonitorTarget.kind` | `Literal["magnetic_domain", "domain", "object", "region"]` | `required` | $1$ | supported tag; direct construction validates required IDs by presence, not non-empty text | Direct target tag | FDM/FEM CPU/GPU authoring | `planar_monitors[].target.kind` |
| `fm.MonitorTarget.object_id` | `str \| None` | `None` | $1$ | required by presence for object/region; forbidden for domain tags; IR must resolve it | Direct object identity | FDM/FEM CPU/GPU authoring | `planar_monitors[].target.object_id` |
| `fm.MonitorTarget.region_id` | `str \| None` | `None` | $1$ | required by presence for region; forbidden for domain tags; IR must resolve it | Direct region identity | FDM/FEM CPU/GPU authoring | `planar_monitors[].target.region_id` |
| `fm.MonitorTarget.object.object_id` | `str` | `required` | $1$ | non-empty; must resolve to a magnet in IR validation | Select one object | FDM/FEM CPU/GPU authoring | `planar_monitors[].target.object_id` |
| `fm.MonitorTarget.region.object_id` | `str` | `required` | $1$ | non-empty; owner-region pair must exist | Region owner | FDM/FEM CPU/GPU authoring | `planar_monitors[].target.object_id` |
| `fm.MonitorTarget.region.region_id` | `str` | `required` | $1$ | non-empty; owner-region pair must exist | Region identity | FDM/FEM CPU/GPU authoring | `planar_monitors[].target.region_id` |
| `fm.PlanarExtent.kind` | `Literal["explicit", "target_bounds", "magnetic_domain", "universe"]` | `required` | $1$ | supported extent tag | Direct extent policy tag | FDM/FEM CPU/GPU authoring; dynamic runtime unqualified | `planar_monitors[].frame.extent.kind` |
| `fm.PlanarExtent.u` | `tuple[float, float] \| None` | `None` | $\mathrm{m}$ | required and strictly increasing for explicit; forbidden for dynamic kinds | Direct horizontal bounds | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent.u_min_m/u_max_m` |
| `fm.PlanarExtent.v` | `tuple[float, float] \| None` | `None` | $\mathrm{m}$ | required and strictly increasing for explicit; forbidden for dynamic kinds | Direct vertical bounds | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent.v_min_m/v_max_m` |
| `fm.PlanarExtent.padding_m` | `float` | `0.0` | $\mathrm{m}$ | finite and non-negative; serialized only for dynamic kinds | Direct dynamic-extent padding | FDM/FEM CPU/GPU authoring; dynamic runtime unqualified | `planar_monitors[].frame.extent.padding_m` |
| `fm.PlanarExtent.explicit.u` | `Sequence[float]` | `required` | $\mathrm{m}$ | exactly two finite values with minimum less than maximum | Explicit horizontal bounds | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent.u_min_m/u_max_m` |
| `fm.PlanarExtent.explicit.v` | `Sequence[float]` | `required` | $\mathrm{m}$ | exactly two finite values with minimum less than maximum | Explicit vertical bounds | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent.v_min_m/v_max_m` |
| `fm.PlanarExtent.target_bounds.padding` | `float` | `0.0` | $\mathrm{m}$ | finite and non-negative | Padding around resolved target bounds | authoring implemented; FDM/FEM runtime unqualified | `planar_monitors[].frame.extent.padding_m` |
| `fm.PlanarExtent.magnetic_domain.padding` | `float` | `0.0` | $\mathrm{m}$ | finite and non-negative | Padding around magnetic-domain bounds | authoring implemented; FDM/FEM runtime unqualified | `planar_monitors[].frame.extent.padding_m` |
| `fm.PlanarExtent.universe.padding` | `float` | `0.0` | $\mathrm{m}$ | finite and non-negative | Padding around universe bounds | authoring implemented; FDM/FEM runtime unqualified | `planar_monitors[].frame.extent.padding_m` |
| `fm.PlanarFrame.origin` | `Vector3 = tuple[float, float, float]` | `required` | $\mathrm{m}$ | runtime accepts any length-3 finite sequence and normalizes storage to the declared tuple alias | Frame origin | FDM/FEM CPU/GPU | `planar_monitors[].frame.origin_m` |
| `fm.PlanarFrame.normal` | `Vector3 = tuple[float, float, float]` | `required` | $1$ | runtime accepts any finite, non-zero length-3 sequence and normalizes storage to the declared tuple alias | Normal, normalized during lowering | FDM/FEM CPU/GPU | `planar_monitors[].frame.normal` |
| `fm.PlanarFrame.u_axis` | `Vector3 = tuple[float, float, float]` | `required` | $1$ | runtime accepts any finite length-3 sequence not collinear with normal and normalizes storage to the declared tuple alias | First axis, Gram-Schmidt normalized | FDM/FEM CPU/GPU | `planar_monitors[].frame.u_axis` |
| `fm.PlanarFrame.extent` | `PlanarExtent` | `required` | $1$ | valid extent object | Authored extent policy | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent` |
| `fm.PlanarFrame.preset` | `Literal["xy", "xz", "yz"] \| None` | `None` | $1$ | valid tag or None; direct construction records provenance but does not replace supplied vectors | Direct preset provenance | FDM/FEM CPU/GPU | `planar_monitors[].frame.preset` |
| `fm.PlanarFrame.xy/xz/yz.position` | `float` | `required` | $\mathrm{m}$ | finite | Axis-preset plane position | FDM/FEM CPU/GPU | `planar_monitors[].frame.origin_m` |
| `fm.PlanarFrame.xy/xz/yz.extent` | `PlanarExtent` | `required` | $1$ | valid extent object | Extent attached to preset frame | FDM/FEM CPU/GPU | `planar_monitors[].frame.extent` |
| `fm.SlabAverage.thickness` | `float` | `required` | $\mathrm{m}$ | finite and strictly positive | Full slab thickness | FDM/FEM CPU sampler; GPU-source legal | `planar_monitors[].operator.thickness_m` |
| `fm.DepthProjection.reduction` | `PlanarReduction` | `"mean_occupied"` | $1$ | mean_occupied, thickness_integral, rms, min, max, or abs_max | Depth reduction | FDM/FEM CPU sampler; GPU-source legal | `planar_monitors[].operator.reduction` |
| `fm.DepthProjection.empty_policy` | `EmptyPolicy` | `"exclude_empty"` | $1$ | exclude_empty or include_air_as_zero; latter only with mean_occupied | Empty-bin semantics | FDM/FEM CPU sampler; GPU-source legal | `planar_monitors[].operator.empty_policy` |
| `fm.SurfaceBoundary.kind` | `Literal["object_boundary", "region_boundary", "named_surface"]` | `required` | $1$ | no direct-constructor validation; tagged IR/OpenAPI decoding must accept it | Direct surface selector tag | authoring; only object boundary samples | `planar_monitors[].operator.boundary.kind` |
| `fm.SurfaceBoundary.region_id` | `str \| None` | `None` | $1$ | no direct-constructor validation; required semantically for region boundary | Direct region-boundary identity | authoring only; sampling unsupported | `planar_monitors[].operator.boundary.region_id` |
| `fm.SurfaceBoundary.surface_id` | `str \| None` | `None` | $1$ | no direct-constructor validation; required semantically for named surface | Direct named-surface identity | authoring only; sampling unsupported | `planar_monitors[].operator.boundary.surface_id` |
| `fm.SurfaceBoundary.region_boundary.region_id` | `str` | `required` | $1$ | non-empty; sampling currently rejects unpublished topology | Region boundary selector | authoring only; sampling unsupported | `planar_monitors[].operator.boundary.region_id` |
| `fm.SurfaceBoundary.named.surface_id` | `str` | `required` | $1$ | non-empty; sampling currently rejects unpublished topology | Named boundary selector | authoring only; sampling unsupported | `planar_monitors[].operator.boundary.surface_id` |
| `fm.SurfaceProjection.boundary` | `SurfaceBoundary` | `required` | $1$ | boundary object required | Surface support selector | FEM P1 object boundary only | `planar_monitors[].operator.boundary` |
| `fm.SurfaceProjection.visibility_policy` | `SurfaceVisibilityPolicy` | `"frontmost"` | $1$ | frontmost, backmost, nearest_to_origin, or area_weighted_overlap | Fold/overlap selection | FEM P1 object boundary only | `planar_monitors[].operator.visibility_policy` |

`MonitorTarget.magnetic_domain()` and `MonitorTarget.domain()` have no
parameters. `PlaneSample()` and `SurfaceBoundary.object_boundary()` also have
no parameters. Direct dataclass constructors are public and are mapped above
with their actual defaults and weaker validation where applicable; the factory
methods remain the canonical script-export surface but do not erase those
public constructor contracts.

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

`Default` is deliberately absent from this representation. It is resolved
from session visualization state and current domain metadata at data-plane
request time; opening 2D or selecting `Default` does not append a
`planar_monitors[]` entry, mutate `SceneDocument`, or change canonical Python.

(planar-monitor-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Canonical Python export uses `study.monitors.add_planar(...)` and preserves
semantic equality through Python → `ProblemIR` → `SceneDocument` → canonical
Python → `ProblemIR`. The authored monitor contains requested intent. Dynamic
bounds and runtime scopes are resolved execution facts and must not overwrite
that intent. The session-resolved `Default` source follows a separate path:
its source selection and default slice controls are session presentation state,
while its resolved target, frame, and operator are ephemeral execution facts.
They never become an authored monitor, a `ProblemIR` entry, or a canonical
Python statement.

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

| Source lane | Target and runtime-scope legality | Required source carrier | Legal current operators | Sampler | Default-source contract | Qualification at audited source |
|---|---|---|---|---|---|---|
| FDM CPU | `domain`: full rectangular carrier; `magnetic_domain`: all active cells; `region`: exact numeric membership; `object`: only conditionally correct for single-object/all-active-equivalent grids and incorrect for general multi-object grids; `mesh_part`/`airbox`: unsupported; every dynamic extent tag is unqualified because all three reuse post-target selected-mask bounds | Published cell-centred structured-grid field plus matching membership for non-domain targets; explicit extent required for authored monitors | plane, slab, depth; surface unsupported | CPU binary64 | `Default` resolves a full-domain target and axis-preset frame, then reuses these operators; it adds no qualification to the lane | managed science artifact passed only for its explicit/fixture extent; multi-object object targeting, all dynamic extent policies, default-source runtime/browser/production, and end-to-end runtime remain unqualified because the same recipe ended RED in the browser |
| FDM GPU | Same target and dynamic-extent restrictions as FDM CPU after compatible field transport | Compatible transported cell-centred structured-grid field; source device/precision is absent from planar metadata; explicit extent required for authored monitors | plane, slab, depth; surface unsupported | CPU binary64 | `Default` is source-compatible with the same CPU sampler only; no device identity or native GPU sampler is implied | no fresh GPU-source/device proof, no correct distinct dynamic-policy proof, no multi-object object-target proof, and no native GPU sampling |
| FEM CPU | Authored target plus optional intersecting `mesh_part`/`airbox` element scope | Complete or explicitly mapped nodal first-order field on Tet4/Prism6/Pyramid5/Hex8 (Pyramid5 basis equality with MFEM is gate PM-N19) | plane, slab, depth, `object_boundary` surface | CPU binary64 | `Default` selects `magnetic_domain` for `magnetic_only` quantities and `domain` for full-domain quantities | focused Tet4 and Prism6 numerical/target tests pass; managed FEM and browser qualification remain separate gates |
| FEM GPU | Same target, scope, and surface rules as FEM CPU after compatible field transport | Transported nodal first-order Tet4/Prism6/Pyramid5/Hex8 field; source device/precision is absent from planar metadata | same CPU P1 postprocessor | CPU binary64 | quantity-domain-aware target selection is identical; no native GPU sampler is implied | source-compatible only until fresh managed GPU-source/browser proof |

### FDM realization

`plane_sample` on an FDM carrier averages the cell-constant field over the
in-plane footprint of each pixel. With $A_{c,ij}$ the area of
$(c\cap\{s=0\})\cap P_{ij}$ for selected cells $c$,

```{math}
:label: eq-planar-fdm-plane-area
\bar q_{ij}^{\mathrm{FDM,plane}}
=\frac{\sum_{c}q_c A_{c,ij}}{\sum_c A_{c,ij}} ,
```

which removes the aliasing of a pixel-centre point sample when the raster is
coarser than the grid. The occupied fraction $\sum_c A_{c,ij}/|P_{ij}|$ only
decides occupancy (any positive area occupies the pixel); empty area does not
enter the mean, consistent with `mean_occupied` for slabs. The realization is a
midpoint quadrature with $m_u\times m_v$ sub-points per pixel,
$m_u=\min(32,\lceil\Delta u/p_u\rceil)$ and likewise for $v$, where
$p_u=\min_k h_k/|e_{u,k}|$ is the distance between successive cell faces met
along $\mathbf e_u$ ($h_k$ is the cell edge along world axis $k$). For an axis-aligned frame whose pixel
edges coincide with cell faces (raster dimensions dividing the cell counts) the
quadrature hits every covered cell centre exactly once and equals
{eq}`eq-planar-fdm-plane-area` exactly. When pixels are not larger than cells
($m_u=m_v=1$) it reduces to the cell-constant value at the pixel centre, i.e.
the previous point sample. The sample method is reported as
`fdm_cell_area_plane`. This differs deliberately from the MuMax3 fork preview,
whose layer average is an arithmetic mean that also counts empty cells as
zero.

Slab and depth operators decompose every selected grid cell into
six tetrahedra, clip them against the pixel prism, and accumulate physical
intersection volume:

```{math}
:label: eq-planar-fdm-discrete
\bar q_{ij}^{\mathrm{FDM}}
=\frac{\sum_{c}q_c V_{c,ij}}{\sum_c V_{c,ij}} .
```

The resolved FDM membership artifact supplies grid origin, cell size, active
support, object identities, numeric region membership, and legend. Missing or
incompatible membership rejects for non-domain targets; the sampler must not
silently use the full rectangular storage grid. Region targeting compares the
per-cell numeric membership with the requested object/region legend entry.
Object targeting does not: after verifying that the object identity exists, it
selects every active cell. It is therefore correct only when those active cells
are exactly the requested object's cells and is incorrect for a general
multi-object grid.

The following dynamic-extent defect is historical Task 0 evidence, not a
claim about the current implementation: at the Task 0 revision, the resolver
collapsed all three dynamic variants to `padding_m` over one post-target mask.
The current request builder has two distinct responsibilities:
`resolve_resolution` validates only bounded raster dimensions, while
`ResolvedSpatialTarget::resolve_dynamic_extent` chooses separately between
target, magnetic-domain, and universe bounds. This source distinction is not
fresh FDM/FEM managed-runtime qualification; explicit $(u,v)$ bounds remain the
only dynamic-extent form with Task 0 numerical evidence.

### FEM P1 realization

Plane sampling locates a containing Tet4 or Prism6 element. Tet4 uses
barycentric interpolation:

```{math}
:label: eq-planar-fem-p1
q_h(\mathbf x)=\sum_{a=1}^{4}N_a(\mathbf x)\,q_a,\qquad
\sum_{a=1}^{4}N_a(\mathbf x)=1 .
```

For Prism6, the reference basis is triangle-P1 $\times$ interval-P1:

```{math}
:label: eq-planar-fem-prism6
\begin{aligned}
N_1&=(1-r-s)(1-\zeta), & N_2&=r(1-\zeta), & N_3&=s(1-\zeta),\\
N_4&=(1-r-s)\zeta,     & N_5&=r\zeta,     & N_6&=s\zeta,\\
\mathbf x(r,s,\zeta)&=\sum_{a=1}^{6}N_a\mathbf x_a,
&q_h(\mathbf x)&=\sum_{a=1}^{6}N_a q_a .
\end{aligned}
```

The sampler solves the isoparametric inverse map with a bounded Newton solve
and rejects singular Jacobians or reference coordinates outside the prism.
Hex8 and Pyramid5 use the bases of {ref}`planar-monitor-mixed-element-bases`
with the same inversion.
The basis has partition of unity and reproduces constant and affine physical
fields because geometry and field use the same $N_a$.

Slab/depth integration clips each native convex cell against the pixel prism;
Tet4 integrates the clipped linear field exactly, Prism6, Hex8 and Pyramid5
integrate their own basis with the clipped-element quadrature.
The Prism6 carrier supplies two triangular and three quadrilateral faces;
surface projection extracts those native exterior faces, clips them in
$(u,v)$, integrates their P1 trace with physical area, and applies the requested
visibility policy. Plane sampling rasterizes element by element (only pixel
centres inside an element's bounding box are inverted) and caches the
resulting operator per geometry identity; sub-pixel elements are evaluated in
their own parent element, never by a scan of the whole mesh.

The API admits this realization only when the flattened field has exactly
$n_{\mathrm{comp}}$ values for every node of the complete published mesh and
every cell is Tet4, Prism6, Pyramid5 or Hex8. Target and runtime scope alter element markers after loading;
they do not narrow the field carrier. Moreover, all three FEM dynamic extent
tags currently derive bounds from the complete `fem.nodes` array. Thus
`target_bounds`, `magnetic_domain`, and `universe` resolve to the same global
projected mesh bounds (apart from padding), even for a scoped element subset.
That behavior is executable but not a correct scoped-extent realization.

### Why node-count averaging is illegal

An unweighted nodal mean,

```{math}
:label: eq-planar-node-average
q_{\mathrm{nodes}}=\frac{1}{N}\sum_{a=1}^{N}q_a ,
```

changes under local refinement even when the represented continuous field does
not. The FEM regression refines a skew tetrahedral P1 field and requires the
measure-weighted result to remain invariant.

(planar-monitor-sampling-operator)=
### Linear sampling operator and field gather

Plane sampling and the `mean`/`integral` slab and depth reductions are linear
in the carrier degrees of freedom. For a fixed geometry identity (carrier
topology, resolved target and runtime scope, frame, operator, raster
resolution, sampler version) every pixel $p$ is

```{math}
:label: eq-planar-sampling-operator
\bar q_p=\frac{\sum_a W_{pa}\,q_a}{M_p},\qquad
W_{pa}=
\begin{cases}
N_a\!\left(\boldsymbol\xi_e(\mathbf x_p)\right), & \text{plane sample},\ \mathbf x_p\in e,\\[2pt]
\displaystyle\int_{e\cap\Pi_p} N_a\,dV, & \text{slab / depth},
\end{cases}
\qquad
M_p=
\begin{cases}
1, & \text{plane sample},\\
|\Omega_T\cap\Pi_p|, & \text{slab / depth}.
\end{cases}
```

For FDM the degrees of freedom are cells: plane sampling has the area weights
$W_{pc}=A_{c,p}$ with $M_p=\sum_c A_{c,p}$ of {eq}`eq-planar-fdm-plane-area`,
and slab/depth the volume weights $W_{pc}=V_{c,p}$ with $M_p=\sum_c V_{c,p}$ of
{eq}`eq-planar-fdm-discrete`. The weights depend only on geometry, so the
implementation may compute $(W,M)$ once per geometry identity and evaluate a
new field revision by the sparse product {eq}`eq-planar-sampling-operator`
(a gather of at most eight entries per plane pixel). This changes only the
cost, not the definition: the cached and direct evaluations of the same
operator must agree within a relative tolerance of $10^{-13}$ of the occupied
range (summation order differs), and two constructions of the same operator
must be bitwise identical. RMS, minimum, maximum and surface projection with a
visibility policy are not linear in $q_a$ and keep direct evaluation; the
metadata reports `operator_cache: none` for them.

Element location uses a spatial index over element bounding boxes (an
interval list per world axis for axis-aligned frames and a bounding-volume
hierarchy for arbitrary frames). Elements are rasterized element by element:
only pixels whose centres lie in the element section are inverted. A pixel
centre on a shared face belongs to exactly one element by a deterministic
top-left rule on the section polygon; two candidates with different values
increase `overlap_count` instead of being resolved silently. All geometric
tolerances are scale-relative, $\varepsilon_x=c\,h_e$ with a fixed
dimensionless $c$, and reference containment uses $\varepsilon_\xi$; the same
mesh expressed in nm, µm or mm yields the same weights after rescaling.

(planar-monitor-mixed-element-bases)=
### Hex8 and Pyramid5 bases

Hex8 uses the trilinear reference basis on $[0,1]^3$,

```{math}
:label: eq-planar-fem-hex8
N_{abc}(\xi,\eta,\tau)=\ell_a(\xi)\,\ell_b(\eta)\,\ell_c(\tau),\qquad
\ell_0(x)=1-x,\ \ell_1(x)=x,\qquad a,b,c\in\{0,1\},
```

and Pyramid5 the first-order rational basis of the reference pyramid with base
$[0,1]^2\times\{0\}$ and apex $(0,0,1)$,

```{math}
:label: eq-planar-fem-pyramid5
\begin{aligned}
N_1&=\frac{(1-\xi-\tau)(1-\eta-\tau)}{1-\tau}, &
N_2&=\frac{\xi\,(1-\eta-\tau)}{1-\tau}, &
N_3&=\frac{\xi\,\eta}{1-\tau}, \\
N_4&=\frac{(1-\xi-\tau)\,\eta}{1-\tau}, &
N_5&=\tau, &&
\end{aligned}
```

with $N_1=\dots=N_4=0$ at the apex $\tau=1$. The sampler must use the basis of
the solver that produced the nodal field; for the MFEM-backed runtime this is
the first-order pyramid element of the linked MFEM release, and the equality
of {eq}`eq-planar-fem-pyramid5` with that element is a release gate
(PM-N19), not an assumption. Geometry and field share the basis, so constant
and affine fields are reproduced. Points are located by a damped Newton
inversion of $\mathbf x(\boldsymbol\xi)=\sum_a N_a\mathbf x_a$ with a
scale-relative stopping rule and rejection of singular Jacobians. Splitting
Hex8 or Pyramid5 into tetrahedra is not a legal realization: it replaces the
trilinear or rational interpolant by a different piecewise-linear field.

Slab and depth weights of Prism6, Hex8 and Pyramid5 integrate the element's
own basis over the clipped region; tensor-product Gauss quadrature on the
reference image of $e\cap\Pi_p$ is used. Linear interpolation of vertex
values along clipped edges is exact only for affine fields and is therefore
insufficient for these elements.

(planar-monitor-default-section)=
### Default-section publication

The resolved `Default` slice publishes its section in the sample metadata:
plane, normal axis, requested fraction $\phi$, requested coordinate
$p_n^{\mathrm{req}}=b_{\min}+\phi\,(b_{\max}-b_{\min})$, resolved coordinate
$p_n^{\mathrm{res}}$ and, on a structured FDM grid, the snapped layer

```{math}
:label: eq-planar-default-layer
k=\min\!\left(N_n-1,\ \max\!\left(0,\lceil\phi N_n\rceil-1\right)\right),\qquad
p_n^{\mathrm{res}}=b_{\min}+\left(k+\tfrac12\right)h_n .
```

On a swept FEM mesh whose mixed-layer topology certificate lists the magnetic
node-plane coordinates $z_0<\dots<z_{L}$ along the sweep axis, and when the
section normal is that axis, the request snaps to the nearest plane
$z_k$ only within a relative window
$|z_k-p_n^{\mathrm{req}}|\le\max(\varepsilon_{\mathrm{cert}},10^{-9}(z_L-z_0))$.
Outside the window the plane is sampled at $p_n^{\mathrm{req}}$ itself, which
is legal because the Prism6 interpolant is linear along the sweep within each
layer. A node plane is a geometric stop, not a data layer: the sampled field on
$z_k$ is the nodal trace, and between planes it is the element interpolant.

On other FEM meshes the section is continuous. Its navigation step is the
median normal extent of the elements cut by the current plane,

```{math}
:label: eq-planar-navigation-step
h_\perp=\operatorname{median}\{\max_a n_a-\min_a n_a : e\in\mathcal T,\ \min_a n_a\le p_n^{\mathrm{res}}\le\max_a n_a\},
```

where $\mathcal T$ is the sampled target and $n_a=(\mathbf x_a-\mathbf o)\cdot\mathbf n$ are the projected element
vertices. $h_\perp$ is a navigation aid that depends on the current plane; it
does not define layers and does not enter any sampled value. It is computed in
the geometry pass of the cached `plane_sample` operator and published with the
number of cut elements; when no operator was built (slab and depth operators,
or no cut element) the step stays one hundredth of the normal extent.

A slab-average Default slice is centred at $p_n^{\mathrm{req}}$ itself:
neither {eq}`eq-planar-default-layer` nor the node-plane snap applies, because
moving the centre of a slab of thickness $t$ to a cell centre would shift
$[p_n-t/2,\,p_n+t/2]$ by up to $h_n/2$ into the neighbouring material. A named
object layer is such a slab with $p_n$ and $t$ taken from the realized
geometry bounds $[a,b]$ of the object along the normal, $p_n=(a+b)/2$ and
$t=b-a$; its value is the occupied-measure mean of the slab, which also
contains any other material inside $[a,b]$ in the sampled target. Restricting
it to one object or region is a scope (`scope_kind=region`, or an object
monitor target), not a different reduction.

`stops_kind` is `fdm_cell_layers` when {eq}`eq-planar-default-layer` applies,
`fem_node_planes` or `fem_node_planes_between` on a certified swept mesh, and
`continuous` otherwise; `navigation_step_m` is $h_n$, the mean node-plane
spacing, $h_\perp$, or one hundredth of the normal extent, and
`navigation_step_kind` names which. The user interface shows
$p_n^{\mathrm{req}}$ and $p_n^{\mathrm{res}}$ together and never hides the snap.

(planar-monitor-probe-evaluation)=
### Probe evaluation

A pinned probe is a point evaluation at the exact world position
$\mathbf x_\star=\mathbf o+u\,\mathbf e_u+v\,\mathbf e_v$ with the same
locator and basis as the raster: $q_h(\mathbf x_\star)=\sum_a N_a(\boldsymbol\xi_e(\mathbf x_\star))\,q_a$
for FEM and the containing cell value for FDM. Its status is `occupied`
(value, cell or element identity), `outside` (outside the frame bounds; no
value), `empty` (inside the frame, outside the selected target; no value) or
`stale` (the field revision advanced). The position is never clamped to the
raster edge, and the reported position and value always refer to the same
point.

(planar-monitor-line-profile)=
### Line profile sampling

A line profile is a sequence of point evaluations along the straight segment
from $\mathbf a=(u_0,v_0)$ to $\mathbf b=(u_1,v_1)$ in the frame of one planar
sample. With $L=\lVert\mathbf b-\mathbf a\rVert$ and the arc length $s\in[0,L]$,

```{math}
:label: eq-planar-line-profile
\mathbf p(s)=\mathbf o+\bigl(u_0+\tfrac{s}{L}(u_1-u_0)\bigr)\mathbf e_u+\bigl(v_0+\tfrac{s}{L}(v_1-v_0)\bigr)\mathbf e_v,\qquad
q_h(s)=\sum_a N_a\bigl(\boldsymbol\xi_e(\mathbf p(s))\bigr)\,q_a ,
```

evaluated with the same locator, basis and component derivation as the probe
({ref}`planar-monitor-probe-evaluation`). The sample set is $N\ge 2$ uniform
arc lengths $s_k=kL/(N-1)$ and, on FEM carriers, every arc length at which the
segment crosses an edge of the published section polygons, i.e. an element
face inside the plane. Because the P1/Prism6 interpolant is linear along a
straight segment inside one element section (and smooth for Hex8/Pyramid5),
the profile drawn through these points is the exact trace on affine elements
rather than a resampling. On FDM carriers the value is the cell value of the
containing cell (piecewise constant); no smoothing or interpolation across
cells is applied. Points outside the frame are `outside`, points outside the
sampled target are `empty`, and neither carries a value. A profile is a derived
resource of one sample (`sample_token`); it never resamples the raster.

### Spatial index for point location

Point evaluations of a FEM sample ({ref}`planar-monitor-probe-evaluation`,
{eq}`eq-planar-line-profile`) locate the element that contains a world point.
For a batch of points (a line profile, from 32 points on) the locator first
builds a bounding-volume hierarchy over the axis-aligned boxes of the selected
elements (median split on the longest centroid axis, leaves of at most 8
elements) and tests only the elements whose box, padded by $10^{-9}$ of the
mesh diagonal to cover the $10^{-11}$ weight tolerance of the containment
test, contains the point. Candidates are tested in ascending element index,
the order of the direct scan (gate PM-N28), so a point on a shared face resolves to the same
element and the value, entity id and occupancy are identical to the direct
traversal; the index changes cost, never results. For point batches it is built per request and discarded with it; a single
probe keeps the direct scan, which is cheaper than building the index. The
plane operator (gate PM-N17) uses the same hierarchy, cached by the carrier's
topology fingerprint (nodes, connectivity, markers; four most recent
carriers), and rasterizes only the elements whose box meets the plane, in
ascending element order: the box test is conservative because an element's
nodes lie in its box, and the exact node-distance test that follows is the
direct traversal's, so pixel claims, weights and cut extents are unchanged.
Gathering the cached operator on the device for the FEM GPU lane is not
implemented.

### In-plane streamlines (presentation)

Streamlines are a presentation of the in-plane projection of one vector
sample; they are not 3D trajectories, not field lines of $\mathbf B$, and not
a resampling. Let $\mathbf w_{ij}=(\mathbf q_{ij}\cdot\mathbf e_u,\,
\mathbf q_{ij}\cdot\mathbf e_v)$ be the frame components of the published
vector raster at pixel centre $(u_i,v_j)$. The continuous direction field is
the bilinear interpolant of $\mathbf w$ between the four surrounding pixel
centres, and a streamline is the curve $\mathbf x(s)$ in $(u,v)$ with

```{math}
:label: eq-planar-streamlines
\frac{\mathrm d\mathbf x}{\mathrm ds}=\frac{\tilde{\mathbf w}(\mathbf x)}{\lVert\tilde{\mathbf w}(\mathbf x)\rVert},\qquad
\tilde{\mathbf w}(\mathbf x)=\sum_{a=1}^{4}\lambda_a(\mathbf x)\,\mathbf w_a ,
```

integrated by classical RK4 in physical length with the step
$h=\tfrac12\min(\Delta u,\Delta v)$. Integration runs in both directions from
a seed and stops when a corner pixel of the interpolation cell is not
renderable (empty, outside or masked), when $\lVert\tilde{\mathbf w}\rVert<
\varepsilon\max_{ij}\lVert\mathbf w_{ij}\rVert$ with $\varepsilon=10^{-3}$
(out-of-plane or vanishing projection), when the curve leaves the sample
bounds, when it comes closer than $d_\mathrm{test}=\tfrac12 d_\mathrm{sep}$
to another accepted line, or when the per-line point budget is reached.
Seeds follow Jobard and Lefer [4]: candidates at
distance $d_\mathrm{sep}$ on both sides of accepted lines, then a fixed
row-major lattice of pitch $d_\mathrm{sep}$; a seed is accepted only at
distance $\ge d_\mathrm{sep}$ from every accepted point. The order is fixed,
so the same sample gives the same lines. Line and point counts are bounded;
reaching a bound marks the result truncated instead of dropping lines
silently. The FDM raster is piecewise constant per cell; the bilinear
interpolant is a presentation device for drawing a continuous curve and is
not used for any value, probe or export. Streamlines live in the browser
worker on the vector raster of the displayed sample and are recomputed for a
new `sample_token`; they never enter the sampling query or its identity.

### Multislice panels

A multislice view shows $N\in\{2,3,4\}$ samples of the `Default` source that
differ only in the position fraction $\phi_k$ along the current plane normal.
Each panel resolves its section exactly as the single default section does
({ref}`planar-monitor-default-section`) with $\phi_k$ in place of the session
fraction, so the published coordinate, the FDM layer of
{eq}`eq-planar-default-layer` and the FEM node-plane stop follow the same rules,
and the panel carries its own `sample_token`. The override is a query
parameter (`position_fraction`) of the sampling request, valid only for the
`Default` source; the source hash, and with it the sample identity, is
computed from the overridden slice, so panels never share or alias a cached
operator or a field gather. Plane, operator, quantity, component, view scope,
resolution and palette are common to all panels. The colour range is common
too: in `auto` mode it is the union of the occupied extrema of all panels,
$[\min_k q^{\min}_k,\max_k q^{\max}_k]$ of the per-panel extrema over
renderable samples (the same reduction as the single view); `symmetric` uses
$a=\max_k\max(|q^{\min}_k|,|q^{\max}_k|)$ and `manual` applies unchanged. Multislice is presentation: it does not alter any panel's values,
and a panel whose sample fails shows its own error without hiding the others.

(planar-monitor-implementation-mapping)=
## Implementation mapping

The `Default` source is a documentation/API contract in this task, not an
implemented source symbol. The typed state, source discriminator, and resolver
are deliberately deferred to the later implementation task. Until then, this
page maps the contract to the stable `default-planar-source-contract` anchor
and does not claim runtime execution, source parity, or qualification.

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

### Presentation state and target-boundary overlay

Presentation is a session-scoped visualization resource and is never lowered
to Python, `ProblemIR`, the planner, monitor identity, or the sampling query.
Its canonical planar range is `range: { mode, min, max }`, where `mode` is
`auto`, `manual`, or `symmetric`. Limits are canonical SI values: the selected
display unit transforms only labels, ticks, and colorbar values. `manual`
requires finite `$\\min < \\max$`; `auto` and `symmetric` require null limits.
`symmetric` computes `$[-a,a]$`, where `$a$` is the maximum absolute finite
sample value after empty and masked samples have been excluded. When no such
value exists it deterministically uses `$[0,0]$`; it must not borrow a previous
range. `raster_opacity` is a finite presentation value in `$[0,1]$`, defaults
to `$1$`, and is rejected outside that interval rather than silently clamped.

The optional mesh-overlay resource is independent of `surface_projection`.
For FEM it carries the topological boundary of the resolved selected target
intersected by the monitor plane, not material interfaces and not the monitor
rectangle. Each segment is classified before serialization as
`mesh_interior`, `target_boundary`, or `unclassified_degenerate`; degenerate
segments must never be labelled boundary. FDM has no published topology and
therefore returns unavailable (`204`) rather than an inferred rectangle. The
classification is exact only when the backend derives it from target
topology/adjacency. A legacy `FMCS v3` payload has no segment classification
and is degraded/unavailable for target-boundary rendering; the frontend must
not float-deduplicate it heuristically. `FMCS v4` publishes the parallel
classification bytes. Its representation-specific ETag includes the codec
version while preserving the sample token and all sampling identities.

Persisted visualization state migration from schema 6 is one-way: legacy
`auto_contrast=true` or missing becomes `range.auto`; `false` with finite
ordered legacy limits becomes `range.manual`; malformed legacy manual limits
produce controlled restore diagnostics/reset (or restore rejection), never a
silent clamp. New HTTP and OpenAPI payloads expose only `range` and
`raster_opacity` for planar presentation.

(planar-monitor-validation)=
## Validation

### Required numerical gates

| ID | Fixture | Acceptance |
|---|---|---|
| PM-N01 | constant scalar/vector FDM | exact plane/slab/depth values and frame components |
| PM-N02 | linear/layered FDM | analytic volume-weighted mean/RMS and occupied support |
| PM-N03 | arbitrary plane through skew P1 tetrahedron | barycentric value within declared tolerance |
| PM-N04 | P1 slab/depth on skew tetrahedra | analytic integral and refinement invariance |
| PM-N05 | partial and empty support under both empty policies | occupancy remains `empty`; metadata extrema and automatic ranges exclude empty bins even when the serialized payload is zero; current `include_air_as_zero` metadata path fails this gate |
| PM-N15 | FDM `plane_sample` with raster dimensions dividing the cell counts (e.g. $8\times4$ cells on a $2\times2$ raster) | each pixel equals the arithmetic mean of its covered cells (eq. {eq}`eq-planar-fdm-plane-area`); a raster equal to the grid reproduces the cell values exactly |
| PM-N06 | zero and non-zero vector raster | correct `u/v/normal` components and undefined orientation |
| PM-N07 | planar FEM boundary | analytic physical-area weighted value |
| PM-N08 | overlapping/folded FEM surface | explicit ambiguity and fold diagnostics |
| PM-N09 | unsupported surface selector | stable rejection; no object-boundary substitution |
| PM-N10 | FDM target membership on a multi-object grid | `object` selects only the requested object's cells; current all-active-cell object mask fails this gate |
| PM-N11 | geometry scale sweep | unchanged dimensionless result with scale-aware tolerances |
| PM-N12 | FEM target/scope dynamic extents | each dynamic extent follows its named target/scope rather than all mesh nodes; the current distinct-bounds source path requires fresh per-lane qualification |
| PM-N13 | FDM target × dynamic-extent cross-product | `target_bounds`, `magnetic_domain`, and `universe` resolve independently of target masking for `domain`, `magnetic_domain`, `object`, and `region`; the current distinct-bounds source path requires fresh per-lane qualification |
| PM-N14 | FDM procedural grid overlay | `FMFG v1` zawiera skończone, nieduplikowane segmenty przecięcia wybranych komórek z $s=0$, zachowuje sample identity i odrzuca przekroczenie budżetu zamiast zwracać uciętą geometrię |
| PM-N16 | cached operator vs. direct evaluation on Tet4, Prism6 and FDM | relative agreement $\le 10^{-13}$ of the occupied range; two operator builds bitwise identical |
| PM-N17 | spatial index on 10k, 200k and 2M Tet4 elements | identical raster to the direct traversal; bounded candidate count per plane |
| PM-N18 | Hex8 linear and trilinear manufactured fields, axis and oblique planes | reproduction within $10^{-12}$ relative; no tetrahedral split |
| PM-N19 | Pyramid5 basis against the linked MFEM first-order pyramid | pointwise agreement of all five shape functions at interior and face points |
| PM-N20 | Prism6/Hex8/Pyramid5 slab of the element interpolant ($q=\xi\tau$) | integral exact to quadrature tolerance; linear clipping fails this gate |
| PM-N21 | probe on the raster edge, outside the frame and outside the target | `occupied`, `outside` and `empty` respectively; no clamped value |
| PM-N22 | default section on even/odd FDM grids at $\phi\in\{0,0.5,1\}$ | published $k$ and $p_n^{\mathrm{res}}$ follow {eq}`eq-planar-default-layer`; requested coordinate preserved |
| PM-N23 | continuous FEM section through a graded Tet4 film (fine film, coarse air) | published $h_\perp$ equals {eq}`eq-planar-navigation-step` over the cut elements and changes with the plane; raster bitwise unchanged by the step |
| PM-N24 | FDM stack of two objects, object-layer slab on an even cell count; region scope on one object with two regions of opposite $\mathbf m$ | slab centre equals the object centre (no half-cell shift); the two region maps differ and each is empty outside its region |
| PM-N25 | line profile through an affine FEM field across several elements, and through an FDM field | FEM values equal the affine field at uniform and face-crossing points within $10^{-12}$ relative; every in-plane element-face crossing is present; FDM values equal the containing cell values; outside/empty points carry no value |
| PM-N28 | batched point location through the element AABB hierarchy (structured Tet4 with unselected elements; interior, face, edge and outside points; runtime profile on a mixed FEM carrier) | located element, value and occupancy identical to the direct scan for every point; candidate count bounded by the elements around a node |
| PM-N26 | in-plane streamlines on a uniform field, a vortex raster and a masked raster | uniform field gives straight parallel lines along $\mathbf w$ within $10^{-9}$ of the pixel pitch; vortex lines close or stay within the disk; no point lies in a non-renderable cell; repeated runs are identical; budget overflow is reported as truncated |
| PM-N27 | multislice of an FDM stack at $\phi\in\{0.25,0.5,0.75\}$ and of an FEM film | each panel equals the single default section at the same $\phi$ (same resolved coordinate and bitwise-equal raster); the panels' sample tokens differ; the auto range is the union of the panels' renderable extrema; a monitor source with `position_fraction` is rejected |
| PM-D01 | default source identity | `Default` resolves from session state and domain metadata without creating a monitor, changing `ProblemIR`, or changing canonical Python |
| PM-D02 | default position validation | `position_fraction` is finite and in $[0,1]$; resolved `position_m` is finite and inside the selected normal bounds |
| PM-D03 | default/authored sampler parity | after source resolution, both source identities use the same interpolation and measure-weighted reduction; source provenance remains distinct |

### Task 0 evidence boundary

Task 0 establishes the distinction between authored monitors and the
session-resolved `Default` source. It does not claim that the typed default
state, resolver, API resource family, or browser behavior already exists.
Future source-map rows for those symbols belong to their implementation task
and are intentionally absent here. The shared sampler equations and
measure-weighted reductions remain the only implementation truth reused by
both source identities.

At historical exact managed source
`5138078f7fd7b65dfc231faa4aa11c02d8ebf52d`,
`just run-viewport-2d-planar-monitor-smoke fdm cpu` produced an FDM CPU science
report with all recorded science gates true, including plane, slab, depth,
surface-fixture, analytic RMS, occupancy, probe identity, explicit CPU
postprocessing, and cross-backend manufactured-field checks.

The same historical invocation then exited 1 after 180000 ms waiting for a visible
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
- FDM target-boundary topology and FDM mesh-part/airbox scopes are absent;
  proceduralny `FMFG v1` publikuje wyłącznie linie przekroju structured grid.
- General multi-object FDM `object` targeting is incorrect because all active
  cells are selected after object-existence validation.
- All FDM dynamic extent tags share bounds over the post-target mask instead of
  implementing distinct target, magnetic-domain, and universe policies;
  explicit extents are required until PM-N13 passes.
- FEM region-boundary and named-surface topology are absent.
- FEM planar carriers support nodal first-order Tet4, Prism6, Pyramid5 and
  Hex8 with identity or explicit local-to-global mapping. The Pyramid5 basis
  is the rational first-order basis of {eq}`eq-planar-fem-pyramid5`; it is
  identical to `mfem::LinearPyramidFiniteElement::CalcShape` of the linked
  MFEM sources (only the apex tolerance differs), so gate PM-N19 holds at the
  source level; a pointwise runtime comparison remains to be recorded. Discontinuous, cell-centred and higher-order carriers reject
  explicitly.
- FEM dynamic extents ignore target/scope markers and use all mesh nodes, so
  scoped dynamic extents are incorrect and unqualified.
- `include_air_as_zero` currently contributes empty-bin zeros to API metadata
  extrema; this diverges from the occupancy-aware terminal range contract.
- Source backend/device/precision are missing from planar resource metadata.
- Planar target-boundary rendering is only contract-implemented after the
  `FMCS v4` codec, route, and frontend decoder tests; it remains browser and
  runtime unqualified until the requested backend/mode evidence is captured.
- FEM plane-sampling and Newton tolerances are scale-relative; the polygon
  clipping de-duplication distance in `geometry.rs` is still absolute
  ($10^{-12}\,\mathrm{m}$). Plane sampling is element-driven without a
  bounding-volume hierarchy; the cached operator removes repeated geometry
  work across field revisions, but the first build is $O(E)$ per plane.
- The probe is a point evaluation with `occupied`, `outside` and `empty`
  statuses; FEM point location for the probe is a linear element scan.
- `vector_budget` is a presentation parameter: it sets the screen-space glyph
  density of the 2D view and is not part of the sample identity. The vector
  resource always carries the full raster, so changing the budget never
  resamples.
- The failed current browser smoke blocks visible-canvas, lifecycle,
  accessibility, performance, and 3D/2D preservation qualification.
- The session-resolved `Default` source is contract-only until its typed state,
  resolver, data resources, and browser lifecycle are implemented and tested.
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
4. B. Jobard and W. Lefer, “Creating evenly-spaced streamlines of arbitrary
   density,” in *Visualization in Scientific Computing '97*, Springer, 1997,
   pp. 43–55, [doi:10.1007/978-3-7091-6876-9_5](https://doi.org/10.1007/978-3-7091-6876-9_5).

(planar-monitor-source-code-index)=
## Source-code index

Rows explicitly labelled **Task 0 historical** link to the historical source;
Task 7A rows link to its audited implementation delta. Test names are stable
symbols, not line-number claims.

| Equation or claim | Path | Stable symbol | Responsibility | Lane | Tests/evidence | Status | Immutable link |
|---|---|---|---|---|---|---|---|
| Python monitor constructors, factories, and normalization | `packages/fullmag-py/src/fullmag/model/planar_monitor.py` | `class PlanarMonitor`; `class MonitorTarget`; `class PlanarExtent`; `class PlanarFrame`; `class PlaneSample`; `class SlabAverage`; `class DepthProjection`; `class SurfaceBoundary`; `class SurfaceProjection`; `class StudyMonitorRegistry` | Public direct constructors, canonical factories, registry, validation, and lowering | all authoring lanes | `packages/fullmag-py/tests/test_planar_monitor.py::PlanarMonitorContractTests`; signature-to-manifest completeness gate | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/packages/fullmag-py/src/fullmag/model/planar_monitor.py) |
| Canonical Python export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_planar_monitors` | `SceneDocument`/IR to stage-first Python | all authoring lanes | `test_planar_monitors_roundtrip_through_scene_and_canonical_python` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/packages/fullmag-py/src/fullmag/runtime/script_builder.py) |
| Canonical monitor IR | `crates/fullmag-ir/src/planar_monitor.rs` | `PlanarMonitorIR`, `MonitorTargetIR`, `PlanarFrameIR`, `PlanarExtentIR`, `PlanarOperatorIR`; `axis_preset` | Own canonical monitor, target, frame, extent, and operator serialization plus preset-frame construction | all authoring lanes | `crates/fullmag-ir/tests/ir_tests.rs::planar_monitor_validation_rejects_invalid_values_and_duplicates` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-ir/src/planar_monitor.rs) |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_planar_monitors` | Identity, target, frame, extent, and operator validation | all authoring lanes | `crates/fullmag-ir/tests/ir_tests.rs::planar_monitor_validation_rejects_invalid_values_and_duplicates` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-ir/src/validation.rs) |
| OpenAPI monitor schema | `crates/fullmag-api/src/schemas/planar_monitors.rs` | `PlanarMonitorSchema` | Publish the canonical planar-monitor authoring schema | API authoring | OpenAPI planar monitor contract tests | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/schemas/planar_monitors.rs) |
| OpenAPI planar field schemas | `crates/fullmag-api/src/schemas/planar_fields.rs` | `PlanarFieldQuery`, `PlanarFieldMetaResource` | Define bounded resource queries and revisioned sampling metadata | API data plane | planar field resource/OpenAPI tests | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/schemas/planar_fields.rs) |
| Canonical planar presentation | `crates/fullmag-api/src/schemas/visualization_state.rs` | `PlanarVisualizationState`; `PlanarColorRangeState` | Public state owns range mode, SI limits, and raster opacity; legacy aliases are not public writable fields | API visualization | exact PUT/PATCH legacy-alias rejection | Task 7A focused API test; runtime/browser unqualified | [source](https://github.com/MateuszZelent/fullmag/blob/9c3a779571c2815dec8279dbd56d5604b09ab784/crates/fullmag-api/src/schemas/visualization_state.rs) |
| Persistence-only planar presentation migration | `crates/fullmag-api/src/session_persistence.rs` | `restore_display_presentation` | Map unversioned v6 aliases privately, preserve v7, and reject unsupported versions before workspace mutation | API persistence | v6 manual/invalid migration, v7 preservation, unknown-version rejection | Task 7A focused persistence tests; runtime/browser unqualified | [source](https://github.com/MateuszZelent/fullmag/blob/9c3a779571c2815dec8279dbd56d5604b09ab784/crates/fullmag-api/src/session_persistence.rs) |
| Exact target-boundary codec | `crates/fullmag-api/src/fem_cross_section.rs` | `serialize_planar_overlay_fmcs_v4` | Serialize parallel exact segment classes in representation-specific `FMCS v4` | FEM postprocessing | Tet4 interior/boundary/degenerate and route ETag tests | contract implementation pending Task 7A validation | [source](https://github.com/MateuszZelent/fullmag/blob/9c3a779571c2815dec8279dbd56d5604b09ab784/crates/fullmag-api/src/fem_cross_section.rs#L140) |
| Procedural FDM grid overlay | `crates/fullmag-api/src/planar_sampling/fdm.rs`; `crates/fullmag-api/src/fdm_planar_grid_overlay.rs` | `build_grid_overlay`; `serialize_fmfg_v1` | Intersect selected structured-grid cells with $s=0$, deduplicate and serialize bounded `FMFG v1` segments | FDM postprocessing | `planar_fdm_grid_overlay_is_physical_deduplicated_and_fmfg_v1`; route and decoder tests | implementation branch; managed/browser unqualified | generated immutable link pending integration |
| Target-boundary classifier | `crates/fullmag-api/src/planar_sampling/fem.rs` | `build_overlay` | Derive interior, target-boundary, and degenerate classes from selected-target topology | FEM postprocessing | scoped overlay tests | contract implementation pending Task 7A validation | [source](https://github.com/MateuszZelent/fullmag/blob/9c3a779571c2815dec8279dbd56d5604b09ab784/crates/fullmag-api/src/planar_sampling/fem.rs#L82) |
| Frame equations | `crates/fullmag-api/src/planar_sampling/frame.rs` | `try_from_ir` | Resolve and validate physical frame | all sampling lanes | `planar_sampling_fem_p1_linear_arbitrary_plane_is_barycentric` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/frame.rs) |
| Backend-neutral sampler entry | `crates/fullmag-api/src/planar_sampling/contract.rs` | `sample_fdm` | Validate request and apply requested component | FDM source | `planar_sampling_fdm_constant_scalar_and_vector_basis_are_exact` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/contract.rs) |
| Vector component semantics | `crates/fullmag-api/src/planar_sampling/contract.rs` | `apply_component` | Derive world/monitor components after reduction | FDM/FEM source | `planar_sampling_orientation_uses_monitor_basis_and_masks_zero_vectors` | source + focused tests | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/contract.rs) |
| FDM point and volume operators | `crates/fullmag-api/src/planar_sampling/fdm.rs` | `sample` | Dispatch cell-constant plane/slab/depth and reject surface | FDM CPU sampler | `planar_sampling_fdm_linear_depth_is_measure_weighted_and_masks_empty_pixels` | managed FDM CPU science pass; browser RED | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/fdm.rs) |
| Conservative clipping | `crates/fullmag-api/src/planar_sampling/geometry.rs` | `integrate_clipped_tetra` | Clip and integrate volume support | FDM/FEM CPU sampler | `planar_sampling_fem_volume_mean_is_not_node_count_average_and_is_refinement_invariant` | focused tests; scale sweep open | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/geometry.rs) |
| Measure-weighted reductions | `crates/fullmag-api/src/planar_sampling/reduction.rs` | `finish` | Mean, integral, RMS, extrema, and empty result semantics | FDM/FEM CPU sampler | `planar_sampling_fdm_linear_depth_is_measure_weighted_and_masks_empty_pixels` | focused tests; managed FDM CPU science pass | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/reduction.rs) |
| FEM P1 point and volume operators | `crates/fullmag-api/src/planar_sampling/fem.rs` | `sample` | Dispatch P1 plane/slab/depth/surface | FEM CPU sampler | `planar_sampling_fem_p1_linear_arbitrary_plane_is_barycentric` | focused tests; managed/browser open | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/fem.rs) |
| FEM physical boundary projection | `crates/fullmag-api/src/planar_sampling/surface.rs` | `sample_boundary` | Clip boundary faces and apply visibility | FEM CPU sampler | `planar_sampling_surface_clips_boundary_faces_across_pixel_footprints` | focused tests; managed/browser open | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/planar_sampling/surface.rs) |
| Dynamic-extent resolution | `crates/fullmag-api/src/planar_sampling/target.rs` | `resolve_dynamic_extent` | Choose target, magnetic-domain, or universe bounds before projecting into monitor coordinates | FDM/FEM source | `target_tests.rs` dynamic-extent cases; PM-N12 + PM-N13 | structural source/tests only; fresh managed and browser qualification open | [source](https://github.com/MateuszZelent/fullmag/blob/9c3a779571c2815dec8279dbd56d5604b09ab784/crates/fullmag-api/src/planar_sampling/target.rs) |
| FEM carrier admission | `crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs` | `extract_fem_field` | Require a complete nodal value tuple for every node and Tet4 connectivity before element scoping | FEM source | focused planar API tests | source + focused tests; scoped carriers unsupported | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs) |
| Metadata extrema | `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs` | `meta_resource` | Compute finite-value metadata extrema without consulting occupancy; currently includes serialized empty-air zero | FDM/FEM source | PM-N05 terminal gate required | known contract divergence for `include_air_as_zero` | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs) |
| Frontend request plan | `apps/control-room/src/modules/field-map/model/fieldMapDataPlan.ts` | `buildFieldMapDataPlan` | Bound resource requests and reject illegal FDM scopes | browser | `fieldMapDataPlan.test.ts` | component tests; browser RED | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/apps/control-room/src/modules/field-map/model/fieldMapDataPlan.ts) |
| Revisioned frontend resources | `apps/control-room/src/kernel/resources/planarFieldResources.ts` | `usePlanarFieldMetaResource` | Typed resource hook and revision identity | browser | `planarFieldResources.test.ts` | component tests; browser RED | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/apps/control-room/src/kernel/resources/planarFieldResources.ts) |
| Canvas renderer | `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx` | `PlanarSurface` | Render sampled raster and overlays | browser | `PlanarSurface.test.tsx`; Task 0 visible-canvas timeout | browser RED | [source](https://github.com/MateuszZelent/fullmag/blob/5138078f7fd7b65dfc231faa4aa11c02d8ebf52d/apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx) |
