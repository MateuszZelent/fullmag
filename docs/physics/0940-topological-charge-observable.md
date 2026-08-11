# Planar skyrmion charge on FDM grids and FEM P1 meshes

- Status: accepted physical and numerical contract; implementation not production-qualified
- Owners: Fullmag core physics/runtime
- Last updated: 2026-07-11
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/03-api-integration-layer.md`, `docs/specs/frontend-v2/13-inspector-and-property-editing.md`
- Supersedes: the physical and numerical sections of `docs/plans/active/object-extensions-topological-charge-implementation-plan-2026-06-26-pl.md`

(problem-statement)=
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

(governing-equations)=
### 2.1 Governing equations

Let `Sigma` be an oriented planar support with an ordered orthonormal frame
`(e_u, e_v, n)` satisfying

```{math}
:label: topological-support-frame
\mathbf n = \mathbf e_u \times \mathbf e_v .
```

For a finite, nonzero magnetization field `M`, define

```{math}
:label: topological-normalized-magnetization
\hat{\mathbf m} = \frac{\mathbf M}{\lVert\mathbf M\rVert} .
```

The continuum topological-charge density and charge are

```{math}
:label: topological-charge-density
q(u,v) = \frac{1}{4\pi}
\hat{\mathbf m}\cdot
\left(
\frac{\partial\hat{\mathbf m}}{\partial u}
\times
\frac{\partial\hat{\mathbf m}}{\partial v}
\right),
```

```{math}
:label: topological-charge-integral
Q(\Sigma) = \int_\Sigma q(u,v)\,du\,dv .
```

Fullmag evaluates `Q` geometrically on an oriented triangle support. For unit
magnetization samples `a`, `b`, and `c` ordered consistently with the support
frame, the signed solid angle is

```{math}
:label: topological-solid-angle
\Omega(a,b,c) =
2\,\operatorname{atan2}\!\left(
a\cdot(b\times c),
1+a\cdot b+b\cdot c+c\cdot a
\right),
```

and the discrete charge is

```{math}
:label: topological-discrete-charge
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

(symbols-and-si-units)=
### 2.3 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf e_u,\mathbf e_v,\mathbf n$ | ordered orthonormal support-frame directions | $1$ |
| $\mathbf M$ | magnetization vector before normalization | $\mathrm{A\,m^{-1}}$ |
| $\hat{\mathbf m}$ | normalized magnetization direction | $1$ |
| $\mathbf a,\mathbf b,\mathbf c$ | ordered unit-magnetization samples of one triangle | $1$ |
| $u,v$ | physical in-plane coordinates | $\mathrm{m}$ |
| $s$ | physical coordinate along the canonical support normal | $\mathrm{m}$ |
| $\Sigma$ | oriented planar integration support; unit refers to its measure | $\mathrm{m^2}$ |
| $q$ | continuum topological-charge density | $\mathrm{m^{-2}}$ |
| $Q,Q_h$ | continuum and discrete topological charge | $1$ |
| $\Omega$ | signed solid angle | $\mathrm{rad}$ |
| $\mathcal T_h$ | oriented support triangulation | $1$ |
| $h$ | characteristic support-mesh length | $\mathrm{m}$ |
| $\bar Q$ | full-thickness averaged topological charge | $1$ |
| $Q(s_i)$ | topological charge at physical cut $s_i$ | $1$ |
| $\Delta s_i$ | physical thickness weight owned by FDM cut $i$ | $\mathrm{m}$ |
| $N$ | number of uniformly weighted FEM profile cuts | $1$ |
| $i$ | deterministic layer or profile-cut index | $1$ |
| $x,y$ | Cartesian coordinates of the analytic validation texture | $\mathrm{m}$ |
| $\lambda$ | scale parameter of the analytic Belavin-Polyakov texture | $\mathrm{m}$ |

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

(assumptions-and-validity)=
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

(discrete-realization)=
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

```{math}
:label: fdm-thickness-weighted-charge
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

```{math}
:label: fem-midpoint-thickness-average
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

(python-api)=
### 4.1 Python API surface

No authoring class is added. This is an on-demand analysis over an existing
object and materialized magnetization field. Python analysis helpers may be
added later, but they must call the same versioned resource contract.

The following executable cell freezes the analysis-request shape without
claiming that a dedicated Python SDK helper already exists:

```python
# %%
request = {
    "method": "skyrmion_hall_angle_v1",
    "object_id": "racetrack",
    "quantity": "m",
    "plane": "xy",
    "support": "midplane",
}
assert request["method"] == "skyrmion_hall_angle_v1"
assert request["quantity"] == "m"
```

(problem-ir)=
### 4.2 ProblemIR representation

No `ProblemIR` field is added. Plane, support mode, profile sampling, snapshot,
and method version are analysis-query state, not physical problem definition.

(round-trip-and-failure-semantics)=
### 4.2.1 Requested intent, resolved execution, and failure semantics

The resource preserves requested intent separately from resolved execution.
Requested object, plane, support, snapshot, method version, weighting rule, and
steady-window policy are echoed alongside the resolved support frame, field
revision, mesh/domain revisions, accepted sample interval, and algorithm
version. Validation errors identify the failed physical gate.
Unsupported combinations fail closed; they never substitute a renderer trajectory, a
different object, a different plane, or a fixed frame interval.

(skyrmion-hall-angle-v1-contract)=
### 4.2.2 Planned trajectory and Hall-angle contract

`skyrmion_hall_angle_v1` is a planned analysis over an accepted sequence of
signed topological-density samples. It is not implemented or qualified by this
note. Each sample first passes the existing support, topology, boundary,
resolution, and provenance gates. On triangle $k$ at time $t_n$, the exact
discrete density moment uses its signed solid-angle charge and the arithmetic
centroid of its three physical support vertices:

```{math}
:label: skyrmion-signed-density-centre
\Delta Q_{n,k}=\frac{\Omega_{n,k}}{4\pi},\qquad
\mathbf c_{n,k}=\frac{\mathbf r_{n,k,0}+\mathbf r_{n,k,1}+\mathbf r_{n,k,2}}{3},
\qquad
Q_n=\sum_k\Delta Q_{n,k},\qquad
\mathbf r_n=\frac{\sum_k\Delta Q_{n,k}\mathbf c_{n,k}}{Q_n}
=(x_n,y_n).
```

The denominator is signed. Every $Q_n$ must have one nonzero sign over the
complete trajectory and satisfy $|Q_n|\ge0.5$. A renderer centroid, an
unsigned-density centre, a maximum-amplitude pixel, or a centre computed after
discarding negative triangle contributions is not admissible.

The steady interval is selected from all contiguous sample intervals $[i,j]$.
Times must be finite and strictly increasing. For $N=j-i+1$, adjacent secant
speeds, their mean, and the population coefficient of variation are

```{math}
:label: skyrmion-candidate-speed-statistics
s_k=\frac{\lVert\mathbf r_{k+1}-\mathbf r_k\rVert}{t_{k+1}-t_k},
\qquad
\bar s=\frac{1}{N-1}\sum_{k=i}^{j-1}s_k,\qquad
c_v=\frac{\sqrt{\frac{1}{N-1}\sum_{k=i}^{j-1}(s_k-\bar s)^2}}{\max(\bar s,1\,\mathrm{m\,s^{-1}})}.
```

A candidate requires all of the following exact `skyrmion_hall_angle_v1`
thresholds:

- at least $N=21$ samples and duration $t_j-t_i\ge100\,\mathrm{ps}$;
- one charge sign, $|Q_n|\ge0.5$, and
  $\max_n|Q_n-Q_{\mathrm{med}}|\le0.05|Q_{\mathrm{med}}|$, where the
  deterministic median is the sorted middle value or the arithmetic mean of
  the two sorted middle values for even $N$;
- distance from the centre to every track edge of at least $16\,\mathrm{nm}$;
- net displacement at least $4\,\mathrm{nm}$ and $\bar s\ge1\,\mathrm{m\,s^{-1}}$;
- $c_v\le0.10$.

Enumerate every interval in increasing start index and then increasing end
index. Among passing candidates select maximum duration; an exact duration tie
selects the minimum start index, then the minimum end index. This is the only
candidate-window selection and tie-break rule.

Each sample supplies finite nonnegative centre-coordinate variances
$\sigma_{x,n}^2$ and $\sigma_{y,n}^2$. Both regressions use the same sample
mask. Define $\sigma_{r,n}^2=\sigma_{x,n}^2+\sigma_{y,n}^2$ and use the same
weight $w_n=1/\max(\sigma_{r,n}^2,10^{-18}\,\mathrm{m^2})$.
Define $W=\sum_nw_n$, the weighted means, and the centred normal-matrix entry
$S_{tt}$. Weighted least squares with an intercept is exactly

```{math}
:label: skyrmion-hall-weighted-regression
W=\sum_nw_n,\quad
\bar t_w=\frac{\sum_nw_nt_n}{W},\quad
\bar x_w=\frac{\sum_nw_nx_n}{W},\quad
\bar y_w=\frac{\sum_nw_ny_n}{W},\quad
S_{tt}=\sum_nw_n(t_n-\bar t_w)^2,
\qquad
v_x=\frac{\sum_nw_n(t_n-\bar t_w)(x_n-\bar x_w)}{S_{tt}},\quad
v_y=\frac{\sum_nw_n(t_n-\bar t_w)(y_n-\bar y_w)}{S_{tt}},\quad
b_x=\bar x_w-v_x\bar t_w,\quad b_y=\bar y_w-v_y\bar t_w.
```

The fit is invalid when $S_{tt}\le0$ or $N-2\le0$. For $a,b\in\{x,y\}$,
$r_{a,n}=a_n-(b_a+v_at_n)$ and the cross-coordinate weighted residual scale
uses exactly $N-2$ degrees of freedom. The complete reported two-coordinate
velocity covariance is

```{math}
:label: skyrmion-hall-weighted-covariance
r_{a,n}=a_n-(b_a+v_at_n),\qquad
\chi_{ab}=\frac{1}{N-2}\sum_nw_nr_{a,n}r_{b,n},\qquad
\operatorname{Cov}(v_a,v_b)=\frac{\chi_{ab}}{S_{tt}}.
```

The signed Hall angle uses the principal branch

```{math}
:label: skyrmion-hall-angle
\Theta_H=\operatorname{atan2}(v_y,v_x)\in(-\pi,\pi].
```

Its uncertainty uses the full fitted velocity covariance, including the
off-diagonal term:

```{math}
:label: skyrmion-hall-angle-variance
\operatorname{Var}(\Theta_H)=
\frac{v_y^2\operatorname{Cov}(v_x,v_x)
+v_x^2\operatorname{Cov}(v_y,v_y)
-2v_xv_y\operatorname{Cov}(v_x,v_y)}
{(v_x^2+v_y^2)^2}.
```

| id | latex | meaning | si_unit |
|---|---|---|---|
| $t_n$ | $t_n$ | accepted trajectory time sample | $\mathrm{s}$ |
| $w_n$ | $w_n$ | inverse position-variance regression weight | $\mathrm{m^{-2}}$ |
| $x_n$ | $x_n$ | signed-density centre coordinate along the track | $\mathrm{m}$ |
| $y_n$ | $y_n$ | signed-density centre coordinate along the transverse axis | $\mathrm{m}$ |
| $v_x$ | $v_x$ | fitted longitudinal velocity | $\mathrm{m\,s^{-1}}$ |
| $v_y$ | $v_y$ | fitted transverse velocity | $\mathrm{m\,s^{-1}}$ |
| $\Theta_H$ | $\Theta_H$ | signed skyrmion Hall angle in the reported frame | $\mathrm{rad}$ |
| $\Delta Q_{n,k}$ | $\Delta Q_{n,k}$ | signed triangle contribution to charge sample $n$ | $1$ |
| $\Omega_{n,k}$ | $\Omega_{n,k}$ | signed solid angle of triangle $k$ at sample $n$ | $\mathrm{rad}$ |
| $\mathbf c_{n,k}$ | $\mathbf c_{n,k}$ | physical centroid of support triangle $k$ | $\mathrm{m}$ |
| $\mathbf r_{n,k,\ell}$ | $\mathbf r_{n,k,\ell}$ | physical position of support vertex $\ell$ on triangle $k$ | $\mathrm{m}$ |
| $\mathbf r_n$ | $\mathbf r_n$ | signed-density skyrmion centre | $\mathrm{m}$ |
| $Q_n$ | $Q_n$ | signed topological charge at trajectory sample $n$ | $1$ |
| $Q_{\mathrm{med}}$ | $Q_{\mathrm{med}}$ | deterministic median charge in a candidate window | $1$ |
| $s_k$ | $s_k$ | adjacent secant speed | $\mathrm{m\,s^{-1}}$ |
| $\bar s$ | $\bar s$ | arithmetic mean of adjacent secant speeds | $\mathrm{m\,s^{-1}}$ |
| $c_v$ | $c_v$ | coefficient of variation of adjacent speeds | $1$ |
| $N$ | $N$ | number of samples in a candidate window | $1$ |
| $W$ | $W$ | sum of common inverse-position-variance weights | $\mathrm{m^{-2}}$ |
| $S_{tt}$ | $S_{tt}$ | centred weighted time normal-matrix entry | $\mathrm{m^{-2}\,s^2}$ |
| $\bar t_w$ | $\bar t_w$ | weighted mean trajectory time | $\mathrm{s}$ |
| $\bar x_w,\bar y_w$ | $\bar x_w,\bar y_w$ | weighted mean centre coordinates | $\mathrm{m}$ |
| $b_x$ | $b_x$ | fitted longitudinal intercept | $\mathrm{m}$ |
| $b_y$ | $b_y$ | fitted transverse intercept | $\mathrm{m}$ |
| $r_{a,n}$ | $r_{a,n}$ | coordinate-$a$ regression residual | $\mathrm{m}$ |
| $a,b$ | $a,b$ | coordinate indices taking values $x$ or $y$ | $1$ |
| $\chi_{ab}$ | $\chi_{ab}$ | weighted residual cross-coordinate scale | $1$ |
| $\sigma_{x,n}^2,\sigma_{y,n}^2$ | $\sigma_{x,n}^2,\sigma_{y,n}^2$ | supplied centre-coordinate variances | $\mathrm{m^2}$ |
| $\sigma_{r,n}^2$ | $\sigma_{r,n}^2$ | summed centre-coordinate variance before flooring | $\mathrm{m^2}$ |
| $\sigma_{\mathrm{floor}}^2$ | $\sigma_{\mathrm{floor}}^2$ | fixed common-weight variance floor | $\mathrm{m^2}$ |
| $\operatorname{Cov}(v_a,v_b)$ | $\operatorname{Cov}(v_a,v_b)$ | fitted velocity covariance entry | $\mathrm{m^2\,s^{-2}}$ |
| $\operatorname{Var}(\Theta_H)$ | $\operatorname{Var}(\Theta_H)$ | delta-method Hall-angle variance | $\mathrm{rad^2}$ |

The method returns no angle and exactly one stable reason code. Precedence is
`topology_lost` → `edge_contaminated` → `insufficient_samples` → `no_motion` → `no_stationary_window`.
`topology_lost` wins for any
nonfinite/unqualified sample, $|Q_n|<0.5$, or charge-sign change;
`edge_contaminated` wins next for any centre closer than $16\,\mathrm{nm}$ to
an edge; `insufficient_samples` wins next when fewer than 21 base-qualified
samples remain; `no_motion` means no enumerated interval reaches both the
$4\,\mathrm{nm}$ displacement and $1\,\mathrm{m\,s^{-1}}$ mean-speed gates;
`no_stationary_window` is the remaining case in which motion exists but no
interval passes duration, charge-stability, and $c_v$ gates.

`reverse_transverse_axis` is a reporting-frame transformation: it maps
`(v_x,v_y)` to `(v_x,-v_y)` and therefore maps the principal-branch
`Theta_H` to `-Theta_H`; it does not alter the solver frame or physical
trajectory.

The current CPU topological-charge resource and its managed FDM/FEM checks are
prerequisites only. They do not prove `SkyrmionTrajectoryV1`,
`SkyrmionHallAngleV1`, GPU execution, uncertainty calibration, or the
`racetrack_m1_v1` production workload. Those symbols remain planned and
unqualified until their own managed evidence gates pass.

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

(implementation-mapping)=
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

(validation)=
## 6. Validation strategy

Convergence error is measured against an independent continuum reference on
the same finite physical support, not blindly against an infinite-domain
integer. The primary smooth oracle is the Belavin-Polyakov texture

```{math}
:label: belavin-polyakov-texture
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

(limitations)=
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

(scientific-bibliography)=
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

(source-code-index)=
## 10. Source-code index

Rows marked as current source identify implemented CPU/resource contracts.
Documentation anchors own accepted or planned equations but are not executable
evidence. The Hall-angle row remains planned and unqualified.

| Claim | Path | Symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Continuum topological-charge contract | docs/physics/0940-topological-charge-observable.md | DOC-ANCHOR:governing-equations | own the accepted frame, normalization, density, and continuum integral definitions | documentation contract; not executable evidence |
| Oriented charge kernel | crates/fullmag-api/src/analysis/topological_charge.rs | compute_oriented_charge | integrate signed solid angles over an oriented triangle support | current CPU source and focused unit tests |
| Support topology gate | crates/fullmag-api/src/analysis/topological_charge.rs | qualify_support_topology | reject duplicate, nonmanifold, or disconnected supports | current CPU source and focused unit tests |
| Boundary trust gate | crates/fullmag-api/src/analysis/topological_charge.rs | qualify_boundary | qualify boundary uniformity separately from the charge value | current CPU source and focused unit tests |
| FDM profile weighting | crates/fullmag-api/src/analysis/topological_charge.rs | fdm_weighted_mean | compute thickness-weighted FDM layer summaries | current CPU source and focused unit tests |
| FEM profile weighting | crates/fullmag-api/src/analysis/topological_charge.rs | fem_midpoint_weights | compute equal physical bin-midpoint weights for FEM profile summaries | current CPU source and focused unit tests |
| Automatic FEM profile count | crates/fullmag-api/src/schemas/analysis_extensions.rs | resolved_profile_sample_count | resolve `auto` to exactly 33 physical cuts | current schema source and focused unit tests |
| Cache identity | crates/fullmag-api/src/quantity_data_plane.rs | topological_charge_cache_key | bind object, field, support, method, mesh, domain, and snapshot identity | router cache-key regression |
| Managed evidence validator | scripts/validate_topological_charge_runtime.py | validate_evidence | reject incomplete FDM/FEM managed-runtime evidence | managed cross-backend recipes |
| Belavin-Polyakov validation contract | docs/physics/0940-topological-charge-observable.md | DOC-ANCHOR:validation | own the independent continuum validation target | documentation contract; not production-kernel evidence |
| Planned trajectory and Hall angle | docs/physics/0940-topological-charge-observable.md | DOC-ANCHOR:skyrmion-hall-angle-v1-contract | freeze signed-density centre, steady-window, regression, covariance, angle, and reason-code semantics | planned contract only; not implemented or qualified |
