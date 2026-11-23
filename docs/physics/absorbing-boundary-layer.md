# Per-object absorbing boundary layer for micromagnetics

- Status: draft
- Owners: Fullmag backend team
- Last updated: 2026-11-20
- Related ADRs: [ADR 0085](../adr/0085-one-formula-engine-for-antennas-and-absorbing-boundary.md)
- Related specs: `docs/superpowers/specs/2026-08-04-absorbing-boundary-layer-design.md`

(problem-statement)=
## 1. Problem statement

Finite micromagnetic domains reflect spin waves at their numerical boundary.
Fullmag needs the MuMax-style `ext_SetAbsorbingBoundaryAdvanced` behavior as a
first-class, per-object damping module that can be authored in Python, edited
in the control room, lowered to `ProblemIR`, and materialized by FEM/FDM
planners without a backend-specific script callback.

The following study places independent damping ramps on the left end of a strip and around a circle inside its central region.

```python
# %% Study and sampling mesh
import fullmag as fm

study = fm.study("strip_absorbers")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
film = study.geometry(fm.Box(1.2e-6, 0.6e-6, 20e-9), name="film", object_id="film-id")
film.mesh(cell_size=(5e-9, 5e-9, 5e-9))
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

# %% A left absorber and a radial band clipped to a central region
center = film.add_region("Center", fm.Box(0.8e-6, 0.5e-6, 20e-9), region_id="center-id")
film.alpha.absorbing_boundary(layers=[
    fm.SpatialAbsorbingLayer(
        layer_id="left", name="Left end", geometry=fm.AbsorbingGeometry.faces(("x-",)),
        total_width_m=100e-9, ramp_width_m=80e-9, max_damping=0.4, profile="quadratic",
    ),
    fm.SpatialAbsorbingLayer(
        layer_id="ring", name="Central ring", region_id=center.region_id,
        geometry=fm.AbsorbingGeometry.cylinder(
            center=(40e-9, 0.0, 0.0), axis=(0.0, 0.0, 1.0), radius_m=200e-9,
        ),
        total_width_m=50e-9, ramp_width_m=30e-9, max_damping=0.25,
        profile="custom", expression="u**3",
    ),
])

# %% Record the authored stage
study.exchange()
study.stages.add_run(stage_id="run", until=1e-12)
```

`frame="universe"` is available when the layer must use the explicit study
universe, matching the original MuMax source. The default is object-local so
the same object configuration remains stable when the object is translated.

## 2. Physical model

(governing-equations)=
### 2.1 Governing equations

The module does not add an energy term or a magnetic field. It changes the
dimensionless Gilbert damping coefficient supplied to the LLG equation:

```{math}
:label: eq-alpha-additive

\alpha(\mathbf r)=\alpha_0+\Delta\alpha(\mathbf r),\qquad
\Delta\alpha(\mathbf r)=\alpha_{\max}\max_{f\in F} w_f(\mathbf r).
```

For a selected face, let $d_f$ be the inward distance from that face to a
point. With full layer width $W$ and taper width $R$,

```{math}
:label: eq-profile-coordinate

t_f=\operatorname{clamp}\left(\frac{W-d_f}{R},0,1\right),
\qquad w_f=p(t_f).
```

where the profile is zero outside the layer and increases to one at the
outer boundary. The default smootherstep profile is

```{math}
:label: eq-smootherstep

p(t)=6t^5-15t^4+10t^3.
```

For the `logarithmic` and `tanh` choices the normalized taper is

```{math}
:label: eq-abl-normalized-profiles

p_{\mathrm{log}}(t)=\frac{\ln(1+9t)}{\ln 10},\qquad
p_{\mathrm{tanh}}(t)=\frac{1+\tanh(4t-2)/\tanh 2}{2}.
```

The constants 9 and 4 are dimensionless and fixed for these presets. The
`custom` choice evaluates the authored scalar `expression`, with `u` equal to
the dimensionless ramp coordinate $t_f$. For example, `u**3` is a cubic taper.

(abl-formula-language)=
The expression is written in the formula language shared with the antenna
masks and time functions, `field_expr.v1`
([mask-function contract](../specs/mask-function-v1.md), sections 3 and 8;
[ADR 0085](../adr/0085-one-formula-engine-for-antennas-and-absorbing-boundary.md)).
It is a profile formula: its only variable is `u`. The crate `fullmag-expr`
parses and evaluates it for the IR validator and the planner; the Python
package checks it with the same syntax-tree rules as the antenna functions and
evaluates the checked tree with the same IEEE-754 operations. The language
provides:

- the operators `+ - * / **` and parentheses, with Python's precedence
  (`-u**2` is $-(u^2)$; `u**2**0.5` is $u^{(2^{0.5})}$; the exponent may
  carry a sign, `2**-u**2`);
- the constant `pi`;
- the one-argument functions `sin cos tan asin acos atan sinh cosh tanh exp log
  log1p sqrt abs` (`log` is the natural logarithm, `log1p(a)` is
  $\ln(1+a)$) and the two-argument functions `atan2 min max`;
- decimal and scientific literals (`2`, `0.5`, `.5`, `5.`, `5e-1`). As in
  Python, a decimal integer literal must not start with `0` unless all its
  digits are zeros (`01` is rejected, `00`, `0.5` and `01.5` are accepted).

Every other text is rejected, among them attribute access (`math.sin(u)`,
`u.real`), a parenthesized function name (`(tanh)(u)`), the legacy power
spelling `^`, `heaviside`, the variables `x`, `y`, `z` and `t`, other names,
hexadecimal, octal, binary and underscore literals (`0x2`, `1_0`), comments,
comparisons, conditional expressions and a trailing comma in an argument
list. Arithmetic is IEEE-754 binary64: an intermediate value may be infinite
(`1/exp(999)` is $0$), and only the value of the expression is checked. The
expression is limited to 256 printable ASCII characters (tabs allowed) and to
128 levels of nesting.

The expression must give $p(0)=0$ and $p(1)=1$ within $10^{-12}$ and output
finite values in $[0,1]$ within the same tolerance. Validation probes 257 evenly
spaced values including the endpoints. Planning additionally checks every
evaluated ramp sample and rejects invalid values. The probe is a finite
validation check. Continuity and monotonicity between samples are properties
of the user's formula. The adjoining plateau has width $W-R$ and exact weight
one. Points outside the layer receive zero weight.

The presets, written as profile formulas, are `u`, `u**2`,
`6*u**5 - 15*u**4 + 10*u**3`, `log1p(9*u)/log(10)` and
`(1 + tanh(4*u - 2)/tanh(2))/2`; the presets themselves are evaluated by fixed
code, not by the formula engine.

At corners the face contributions are combined by `max`, so the requested
maximum damping is not multiplied by the number of faces.

### Independently positioned layers

Each magnetic object owns a collection of layers in `absorbing_boundary.layers`. Every layer has a stable identifier, an editable name, an enabled flag, a distance geometry and a ramp. An optional region clips the layer to part of the object. A legacy face configuration lowers to one layer on the same magnetic support.

```{math}
:label: eq-spatial-abl

\alpha(\mathbf r)=\alpha_{\rm material}(\mathbf r)+\max\bigl(\{0\}\cup\{M_i(\mathbf r)\,A_i\,p_i(u_i)\}_{i}\bigr),\qquad
u_i=\operatorname{clamp}((W_i-d_i(\mathbf r))/L_i,0,1).
```

Here $i$ indexes enabled layers, $M_i$ is a dimensionless indicator for the intersection of the magnetic body, the optional region and the band $0\le d_i\le W_i$. The local material damping already accounts for regional material assignments. The dimensionless amplitude $A_i$ is additive. Distances $d_i$, layer widths $W_i$ and ramp widths $L_i$ are measured in metres. The outermost $W_i-L_i$ metres form a plateau. Applying the maximum makes overlaps independent of layer order. The direction given by the user is spatial; the Gilbert coefficient is a scalar for all waves at a point.

A plane and a cylinder use the following coordinates in the layer frame.

```{math}
:label: eq-spatial-abl-coordinates

d_{\rm plane}=(\mathbf o-\mathbf r)\cdot\hat{\mathbf n},\qquad
\rho=\left\|(\mathbf r-\mathbf c)-[(\mathbf r-\mathbf c)\cdot\hat{\mathbf a}]\hat{\mathbf a}\right\|.
```

The plane normal points toward the plateau. For a cylindrical band, outward damping uses $d_i=a-\rho$, with $W_i\le a$. Inward damping uses $d_i=\rho-a$. A sphere uses $\|\mathbf r-\mathbf c\|$ in place of $\rho$. Normals and axes are normalized for evaluation. Face groups evaluate every selected face and take the greatest profile value, including for nonmonotone custom profiles.

A region mask clips the chosen band in the region's own frame. With `region_boundary` the distance is positive inside the named region and the boundary follows its shape. Boxes, spheres and finite cylinders have analytic metric distances. A finite cylinder includes its end caps. In a thin film a distance to the whole region boundary therefore also approaches zero at the top and bottom. Choose a cylindrical layer about the film normal for an absorber on the outer rim only. A cylinder with `direction="inward"` follows the inner rim of an annulus. A separate region mask limits its axial or angular extent.

For constructive solid geometry the planner compiles exact distances on the sampled side. It supports translated metric primitives, interior intersections and differences with a supported exterior distance for the subtracted solid. An interior union requires disjoint bounding boxes. The boxes establish separation only. The component surfaces determine the actual distance. Overlapping branches of a Y-junction, unsupported transforms or imported contours require an explicit coordinate or suitable analytic layer plus a supported mask. The UI checks an enabled boundary region against the same metric evaluator before saving, even before a mesh is available. Planning checks the same geometry when a script is run. A translated Boolean difference such as `fm.Sphere(R) - fm.Sphere(r)` is supported for a spherical shell. At a nominal plane, radial surface or metric region boundary, the zero-distance comparison accounts for roundoff in the geometry operations. A custom coordinate uses the sign returned by its mathematical expression.

A custom `geometry.expression` is a distance formula of the same language: the rules of the profile apply with the variables `x`, `y`, `z` in place of `u` (`t` and `u` are rejected). Coordinates and results are in metres. The 256-character limit applies, and planning rejects nonfinite sampled values. For example, `min(5e-7-sqrt(x*x+y*y), sqrt(x*x+y*y)-2e-7)` measures the inward distance from either circular edge of an annulus. Points in the hole have negative distance. A general implicit function gives the requested physical width only where its scalar coordinate equals distance. A subsequent `expression="u**3"` on the layer chooses the ramp independently.

FDM samples the same analytical field at magnetic cell centers and FEM at magnetic nodes. The oracle compares against each discretization's sampling locations. Validate the legacy mapping, independent ends, translated and tilted rings, region clipping and overlap, curved contours and invalid or dangling references. Qualify FDM CPU, FDM GPU, FEM CPU and FEM GPU individually; material-map agreement and reflection measurements are separate outcomes.

(symbols-and-si-units)=
### 2.2 Symbols and SI units

| Symbol | Python parameter | Type/default | Unit | Validation | Meaning | Backend support | `ProblemIR` destination |
|---|---|---|---:|---|---|---|---|
| $\alpha(\mathbf r)$ | resolved field | derived | $1$ | finite, non-negative | local Gilbert damping supplied to LLG | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `FdmMaterialIR.material.alpha_field` / FEM material alpha field |
| $\alpha_0$ | `film.alpha` | `float`, required base assignment | $1$ | finite, non-negative | base Gilbert damping | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | material damping |
| $W$ | `total_width` | `float`, required | $\mathrm{m}$ | finite, $W>0$ | full inward extent of the layer | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.total_width_m` |
| $R$ | `ramp_width` | `float`, required | $\mathrm{m}$ | finite, $0<R\le W$ | taper extent | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.ramp_width_m` |
| $\alpha_{\max}$ | `max_damping` | `float`, required | $1$ | finite, $\alpha_{\max}\ge0$ | additive damping at the selected face | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.max_damping` |
| $F$ | `faces` | `tuple[str, ...]`, `("x+",)` | $1$ | non-empty, unique `x±/y±/z±` | selected boundary faces | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.faces` |
| $p$ | `profile` | `str`, `"smootherstep"` | $1$ | `linear`, `quadratic`, `smootherstep`, `logarithmic`, `tanh`, or `custom` | taper profile | common material-field planner | `magnets[].absorbing_boundary.profile` |
| $u$ | `expression` | optional `str`, `None` | $1$ | required for `custom`, using the normalized coordinate and rules above | user-authored taper | common material-field planner | `magnets[].absorbing_boundary.expression` |
| — | `frame` | `str`, `"object"` | $1$ | `object` or `universe` | coordinate frame for bounds | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary.frame` |
| $d_f$ | internal | derived | $\mathrm{m}$ | finite sampled point and bounds | inward distance from face $f$ | planner only | not serialized |
| $t_f$ | internal | derived | $1$ | clamped to $[0,1]$ | profile coordinate | planner only | not serialized |
| $w_f(\mathbf r)$ | internal | derived | $1$ | profile output in $[0,1]$ | selected-face profile weight | planner only | not serialized |
| $p(t)$ | `profile` implementation | derived | $1$ | selected profile formula | scalar taper profile | planner only | not serialized |

| Spatial symbol | Physical meaning | SI unit |
|---|---|---|
| $i$ | index of an enabled layer | $1$ |
| $\mathbf r$ | sample position in the specified coordinate frame | $\mathrm{m}$ |
| $\alpha_{\rm material}(\mathbf r)$ | local damping after regional material assignments | $1$ |
| $M_i(\mathbf r)$ | membership in the active body, region and band | $1$ |
| $A_i$ | maximum added damping for layer $i$ | $1$ |
| $u_i$ | normalized ramp coordinate of layer $i$ | $1$ |
| $p_i(u_i)$ | normalized ramp weight of layer $i$ | $1$ |
| $W_i$ | full extent of layer $i$ | $\mathrm{m}$ |
| $L_i$ | ramp extent of layer $i$ | $\mathrm{m}$ |
| $d_i(\mathbf r)$ | coordinate measured inward from the plateau edge | $\mathrm{m}$ |
| $\mathbf o$ | point on the plane at the plateau edge | $\mathrm{m}$ |
| $\hat{\mathbf n}$ | unit normal indicating the direction of increasing damping | $1$ |
| $\mathbf c$ | sphere center or point on the cylinder axis | $\mathrm{m}$ |
| $\hat{\mathbf a}$ | normalized cylinder axis | $1$ |
| $\rho$ | perpendicular distance from the cylinder axis | $\mathrm{m}$ |
| $a$ | radius of the cylindrical or spherical plateau edge | $\mathrm{m}$ |
| $d_{\rm plane}$ | signed inward plane distance | $\mathrm{m}$ |

Faces use `x+`, `x-`, `y+`, `y-`, `z+`, and `z-`. `frame="object"` uses the
axis-aligned bounds of the object's sampled magnetic points after removing
the object's translation. `frame="universe"` uses the explicit study-universe
box; when the universe is automatic, the planner uses the sampled object
bounds as the deterministic fallback. For FDM, the extrema come from the
centres of active magnetic cells. Inactive cells, including holes and the
padding of an imported grid, receive zero ABL contribution. A multilayer grid
uses each magnet's own active mask. An explicit universe keeps its declared
faces in world coordinates.

W FEM bounds obejmują sumę węzłów wszystkich segmentów należących do jednego
obiektu, z deduplikacją wspólnych węzłów. Marker podregionu konformalnego nie
tworzy nowego brzegu warstwy tłumiącej. Pole alpha obiektu jest rozwiązywane
raz dla tej sumy, więc kolejność markerów nie zmienia profilu ani wartości na
ich wspólnej granicy. Ta sama reguła dotyczy fallbacku automatycznego universe;
różne obiekty zachowują odrębne bounds. Regresja planera sprawdza mapę alpha,
bez deklaracji nowej kwalifikacji dynamiki FEM CPU/GPU.

(assumptions-and-validity)=
### 2.3 Assumptions and approximations

The layer is a local damping approximation. It does not solve electromagnetic
radiation, conductor currents, or PML equations. The object frame is
axis-aligned; rotation-aware object frames are deferred. The damping is
materialized at the planner's FDM cells or FEM nodes, so convergence requires
the ramp to be resolved by the selected mesh.

(discrete-realization)=
## 3. Numerical interpretation

### 3.1 FDM

The planner evaluates the same closed profile at cell sample points and writes
the resulting values to `FdmMaterialIR.material.alpha_field`. FDM CPU consumes
the field. Single-grid FDM CUDA plans cellwise damping and its LLG kernels
read local alpha. This records source support. Managed GPU execution and parity
for the new profiles require evidence.

### 3.2 FEM

The planner evaluates the profile at FEM mesh points and writes
`FemPlanIR.material.alpha_field`. The existing FEM CPU and GPU native ABI
already carries `alpha_field`; this feature does not change the equation or
the ABI. Managed runtime execution remains subject to the existing FEM
qualification gates and must not be inferred from source support alone.

### 3.3 Spatial-layer execution and qualification

| Solver | Device | Material sampling and transfer | Qualification for spatial layers |
|---|---|---|---|
| FDM | CPU | Active magnetic cells receive the sampled alpha field. | Managed trajectory and reflection evidence pending. |
| FDM | GPU | The single-grid CUDA path consumes cellwise damping. Multilayer CUDA support remains subject to planner admission. | Managed GPU run, device identity, parity and reflection evidence pending. |
| FEM | CPU | Regional material assignment precedes evaluation on the union of the object's FEM nodes. | Managed trajectory and reflection evidence pending. |
| FEM | GPU | The same nodal alpha field enters the native FEM material interface. | Managed GPU run, device identity, parity and reflection evidence pending. |

The local damping coefficient is the LLG stepper input. Requested engine, device, precision and mode remain in the study and its provenance. Qualification requires the resolved device, source revision, mesh and trajectories for each lane. For Material alpha, compare field samples after Apply on the same mesh revision, including the node-to-triangle display path for FEM.

### 3.4 Hybrid

No hybrid-specific realization is introduced. The planner preserves the
object-owned module and applies the same scalar field in each participating
material realization. Cross-backend parity is a validation result, not an
implicit promise.

## 4. API, IR, and planner impact

(python-api)=
### 4.1 Python API surface

`MagnetHandle.alpha` remains assignment-compatible with numeric values. Reads
return an alpha control proxy exposing `absorbing_boundary(...)`; assigning a
number updates the base damping. The module is one-per-object and a second
call replaces the previous configuration. The configuration is represented by
`AbsorbingBoundaryLayer` in the legacy face-only form. Passing `layers=[...]` replaces the object configuration with named `fm.SpatialAbsorbingLayer` instances. A later call with an empty list clears all contributions. Scripts can retain a stable ID when replacing or renaming a layer.

```python
# %% Authoring intent
import fullmag as fm

study = fm.study("absorbing_boundary_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Object-owned damping layer
film = study.geometry(fm.Box(1.2e-6, 0.6e-6, 20e-9), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.alpha.absorbing_boundary(
    total_width=200e-9,
    ramp_width=150e-9,
    max_damping=0.5,
    faces=("x+", "x-"),
    profile="smootherstep",
    frame="object",
)

# %% Interactions and stage
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_run(stage_id="run", until=1e-12)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` mapping |
|---|---|---|---|---|---|---|---|
| `film.alpha` | `float` | required | $1$ | finite and >= 0 | Base Gilbert damping | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `materials[].damping` |
| `film.alpha.absorbing_boundary(total_width=...)` | module | disabled | m and 1 by parameter | positive widths; ramp <= total; non-negative max_damping; valid unique faces/profile/frame | Per-object additive damping layer | FDM CPU, single-grid FDM CUDA, FEM CPU/GPU | `magnets[].absorbing_boundary` |
| `film.alpha.absorbing_boundary(expression=...)` | `str or None` | None | $1$ | Required for custom; finite normalized scalar ramp with endpoints 0 and 1 | Formula in dimensionless ramp position u | Common material-field planner | `magnets[].absorbing_boundary.expression` |

### Spatial authoring parameters

Geometry factories belong to `fm.AbsorbingGeometry`. Each table entry below maps to the serialized layer on the owning magnet. The first table entry selects the collection. Solver-specific qualification is given in section 3.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | `ProblemIR` mapping |
|---|---|---|---|---|---|---|---|
| `layers` | `sequence of SpatialAbsorbingLayer` | `None` | $1$ | Unique layer IDs within the owner, exclusive of legacy settings | Ordered editable collection | Shared planner | `magnets[].absorbing_boundary.layers` |
| `layer_id` | `str` | `required` | $1$ | Nonempty and unique per object | Stable layer identity | Shared planner | `magnets[].absorbing_boundary.layers[].layer_id` |
| `name` | `str` | `required` | $1$ | Nonempty | Editable layer name | Shared planner | `magnets[].absorbing_boundary.layers[].name` |
| `enabled` | `bool` | `True` | $1$ | Boolean | Include the layer in materialization | Shared planner | `magnets[].absorbing_boundary.layers[].enabled` |
| `region_id` | `str or None` | `None` | $1$ | Live ID in the owner; disabled region contributes zero | Optional material scope | Shared planner | `magnets[].absorbing_boundary.layers[].region_id` |
| `frame` | `str` | `object` | $1$ | object or universe | Origin for position-dependent coordinates | Shared planner | `magnets[].absorbing_boundary.layers[].frame` |
| `geometry` | `AbsorbingGeometry` | `required` | $1$ | One of the six factories listed below | Distance construction | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.kind` |
| `total_width_m` | `float` | `required` | $\mathrm{m}$ | Finite and positive, at most the radius for an outward radial band | Full width | Shared planner | `magnets[].absorbing_boundary.layers[].total_width_m` |
| `ramp_width_m` | `float` | `required` | $\mathrm{m}$ | Finite, positive and at most total_width_m | Width of the rising part | Shared planner | `magnets[].absorbing_boundary.layers[].ramp_width_m` |
| `max_damping` | `float` | `required` | $1$ | Finite and nonnegative | Peak additive damping | Shared planner | `magnets[].absorbing_boundary.layers[].max_damping` |
| `profile` | `str` | `smootherstep` | $1$ | linear, quadratic, smootherstep, logarithmic, tanh or custom | Ramp function | Shared planner | `magnets[].absorbing_boundary.layers[].profile` |
| `expression` | `str or None` | `None` | $1$ | Required for custom only, normalized at both endpoints | Formula for the ramp | Shared planner | `magnets[].absorbing_boundary.layers[].expression` |
| `faces(faces)` | `sequence of str` | `required` | $1$ | Unique, nonempty subset of the six signed faces | Faces sharing one ramp | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.faces` |
| `plane(origin)` | `three floats` | `required` | $\mathrm{m}$ | Finite components | Point on the plane | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.origin` |
| `plane(normal)` | `three floats` | `required` | $1$ | Finite nonzero vector, normalized during planning | Normal toward the plateau | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.normal` |
| `center` | `three floats` | `required` | $\mathrm{m}$ | Finite components | Point on cylinder axis or sphere center | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.center` |
| `cylinder(axis)` | `three floats` | `required` | $1$ | Finite nonzero vector, normalized during planning | Axis along the cylinder | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.axis` |
| `radius_m` | `float` | `required` | $\mathrm{m}$ | Finite and positive | Reference radius of cylinder or sphere | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.radius_m` |
| `direction` | `str` | `outward` | $1$ | outward or inward | Direction of increasing radial damping | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.direction` |
| `region_boundary(region_id)` | `str` | `required` | $1$ | Live owner region with supported metric boundary | Region whose boundary locates the band | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.region_id` |
| `AbsorbingGeometry.expression(expression)` | `str` | `required` | $\mathrm{m}$ | Restricted finite scalar coordinate in x, y, z | Distance coordinate supplied by the author | Shared planner | `magnets[].absorbing_boundary.layers[].geometry.expression` |

(problem-ir)=
### 4.2 ProblemIR representation

The legacy form of the optional `MagnetIR.absorbing_boundary` contains
`total_width_m`, `ramp_width_m`, `max_damping`, `faces`, `profile`, and `frame`.
The optional `expression` string is present only for `profile="custom"`. Older
profiles retain their existing representation. The inspector shows an expression
field for `Custom`, and canonical script export writes the same expression as a
string keyword to `.alpha.absorbing_boundary(...)`.
IR validation rejects non-finite values, non-positive widths, `ramp_width_m`
greater than `total_width_m`, negative damping, duplicate/unknown faces, and
unknown profile/frame names.

For the strip study in section 1, the first stage serializes the following `magnets[0].absorbing_boundary` value. `region_id` refers to the owner's `object_regions` entry, independently of its display name. The record keeps the authored geometry and ramp, while the solver plan carries the sampled damping array.

```json
{
  "layers": [
    {
      "layer_id": "left",
      "name": "Left end",
      "enabled": true,
      "frame": "object",
      "total_width_m": 1e-07,
      "ramp_width_m": 8e-08,
      "max_damping": 0.4,
      "profile": "quadratic",
      "geometry": {
        "kind": "faces",
        "faces": [
          "x-"
        ]
      }
    },
    {
      "layer_id": "ring",
      "name": "Central ring",
      "enabled": true,
      "frame": "object",
      "total_width_m": 5e-08,
      "ramp_width_m": 3e-08,
      "max_damping": 0.25,
      "profile": "custom",
      "geometry": {
        "kind": "cylinder",
        "center": [
          4e-08,
          0,
          0
        ],
        "axis": [
          0,
          0,
          1
        ],
        "radius_m": 2e-07,
        "direction": "outward"
      },
      "expression": "u**3",
      "region_id": "center-id"
    }
  ]
}
```

(round-trip-and-failure-semantics)=
### 4.3 Round-trip and failure semantics

The requested intent is preserved as `MagnetIR.absorbing_boundary` and is also
retained in the scene resource and canonical script export. The resolved execution
is the planner-produced `alpha_field` at FDM cells or FEM nodes; it is not
inferred from the base material after planning. Invalid values fail at Python or
IR validation with structured validation errors. The v2 authoring mutation
also validates a profile before saving the object. The UI writes a typed
configuration via the same optional scene field used for existing profiles.
Region references are validated against their owner at capture. Removing a referenced region through the Python object API requires first removing or retargeting its layer. A disabled layer, disabled mask region or disabled boundary region contributes zero. An explicit `null` in the object patch clears the layer. Omitting the field preserves it. Unsupported combinations,
including forced CUDA multilayer with unqualified cellwise material fields, are
still rejected by the execution planner.

(implementation-mapping)=
### 4.4 Implementation mapping

| Contract | Source symbol | Responsibility |
|---|---|---|
| Python module | `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py:AbsorbingBoundaryLayer` | parameter validation and profile serialization |
| Object API | `packages/fullmag-py/src/fullmag/world.py:AlphaControl.absorbing_boundary` | per-object attachment |
| Canonical IR | `crates/fullmag-ir/src/model.rs:MagnetIR` | typed optional module |
| IR validation | `crates/fullmag-ir/src/absorbing_boundary.rs:validate_absorbing_boundary` | fail-closed schema validation |
| Shared ramp evaluator | `crates/fullmag-ir/src/absorbing_boundary.rs:ResolvedAbsorbingBoundaryProfile` | normalized presets and checked scalar expression sampling |
| Formula language | `crates/fullmag-expr/src/function.rs:compile_function` | parse and evaluate profile (`FunctionKind::Profile`) and distance (`FunctionKind::Distance`) formulas |
| Python formula front end | `packages/fullmag-py/src/fullmag/model/mask_function.py:compile_formula` | check a formula with the antenna syntax-tree rules and evaluate the checked tree |
| FDM/FEM lowering | `crates/fullmag-plan/src/spatial_absorber.rs:apply_absorbing_boundary_layer` | cell/node alpha-field materialization |
| UI authoring | `apps/control-room/src/modules/inspector/panels/constraint/ObjectExtensionsSpecs.tsx:ObjectAbsorbingBoundaryInspectorPanel` | v2 scene-resource editing |

### 4.5 Planner and capability-matrix impact

The planner applies the layer after region-owned alpha resolution. This keeps
the module additive to the object's base/region material semantics. The
existing single-grid FDM CUDA and FEM/CPU routes receive the resolved alpha
samples through their existing material field. The UI and script builder carry
the same optional object field. The new profiles add no device selection, native
ABI or capability field.

(validation)=
## 5. Validation strategy

### 5.1 Analytical checks

Test zero contribution outside `total_width`, unit contribution at the outer
face, exact smootherstep midpoint, additive base damping, and `max` corner
combination. Test object translation invariance and universe-frame behavior.

For the section 1 strip, the ring's cylindrical radius is measured from the offset center. At radii of 140, 165, 185 and 205 nm, its added damping is respectively 0, 0.03125, 0.25 and 0. These samples assume the central region is enabled and the left face is outside its band. Tilt the cylinder and repeat along two perpendicular radii and at two axial positions. Test a thin annulus at both rims and inside the hole. On a Y-junction, sample the three arms, the gap and each region clip independently. A layer referencing a disabled region must vanish. Compare independent contributions at overlaps, then reverse the layer order and verify the same maximum.

### 5.2 Cross-backend checks

Compare FDM cell samples and FEM nodal samples on the same box and mesh. The
comparison is a field/materialization check; it is not a claim of converged
spin-wave absorption. A qualified FEM run must use the managed `just` recipe
and record the actual device/runtime provenance.

### 5.3 Regression tests

Python tests cover proxy compatibility, validation, IR lowering, and script
round-trip. The new profile tests check analytic midpoint values, exact plateau,
invalid custom expressions, and Python export. One case table,
`crates/fullmag-ir/tests/fixtures/absorbing_boundary_formula_cases.json`, lists
accepted and rejected profile and distance formulas with their values and error
category; the Rust and the Python tests both read it. A second table,
`absorbing_boundary_formula_baseline.json`, holds the values of the evaluator
that preceded the shared language at all 257 probe points; both tests require
the same values for every formula that evaluator accepted. Rust tests cover IR validation,
planner profiles, region ordering,
and single-grid FDM CUDA planner materialization. Authoring tests cover scene and script
builder round-trip. The `examples/fem_absorbing_boundary.py` loader test verifies the
flat top-level `study` style and the per-object layer parameters.

### 5.4 Normal-incidence exchange-wave reflection

The [reflection qualification](../../tests/standard_problems/absorbing_boundary/README.md)
pairs each logarithmic, tanh and custom cubic absorber with a free-end control
on longitudinal meshes of 4 nm and 2 nm. A central probe records the incident
packet and its first return in disjoint windows predicted from the group
velocity. Each FDM/FEM CPU/GPU run supplies its completed trajectory, resolved
damping, source identity and actual execution provenance. The project gate
requires a reflected-to-incident amplitude ratio at most one quarter of the
paired control and checks sensitivity to spatial refinement and device choice.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

(limitations)=
## 7. Known limits and deferred work

Rotation-aware object frames and FEM boundary-integral/PML absorption remain
deferred. The physical reflection and GPU/CPU parity gates require measured
trajectories for the full matrix in section 5.4. Their runtime qualification
remains unverified until the managed results pass those gates.

(scientific-bibliography)=
## 8. References

- G. Venkat, H. Fangohr and A. Prabhakar (2017). Damping profiles, incidence angles and reflected-wave measurements. [Absorbing boundary layers for spin wave micromagnetics](https://doi.org/10.1016/j.jmmm.2017.06.057)

(source-code-index)=
## 9. Source-code index

The adjacent source map is the machine-readable index for every equation, API
parameter, backend lane, and implementation symbol cited here:
`docs/physics/absorbing-boundary-layer.source-map.json`.

| Source path | Symbol | Role |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py` | `class AbsorbingBoundaryLayer` | Python module validation and serialization |
| `packages/fullmag-py/src/fullmag/world.py` | `absorbing_boundary` | Per-object alpha attachment |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | Python-to-IR lowering |
| `crates/fullmag-ir/src/absorbing_boundary.rs` | `validate_absorbing_boundary` | IR validation |
| `crates/fullmag-ir/src/absorbing_boundary.rs` | `ResolvedAbsorbingBoundaryProfile` | Shared preset and expression evaluator |
| `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py` | `compile_profile_expression` | Python profile-formula validation and analytic sampling |
| `packages/fullmag-py/src/fullmag/model/mask_function.py` | `compile_formula` | Shared Python front end of the formula language |
| `crates/fullmag-expr/src/function.rs` | `compile_function` | Shared Rust parser and evaluator of the formula language |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_absorbing_boundary` | Canonical editable profile export |
| `crates/fullmag-plan/src/spatial_absorber.rs` | `apply_absorbing_boundary_layer` | FDM/FEM alpha-field materialization |
| `tests/standard_problems/absorbing_boundary/prepare.py` | `prepare_case` | Matched wave-packet inputs for both meshes and all execution lanes |
| `tests/standard_problems/absorbing_boundary/verify.py` | `inspect_case` | Stage provenance, damping and physical incident/reflected amplitudes |
| `crates/fullmag-plan/src/fem.rs` | `build_region_material_fields` | FEM material-field handoff |
| `crates/fullmag-plan/src/tests.rs` | `fdm_absorbing_boundary_uses_magnetic_support` | Masked single-grid and multilayer alpha, including explicit universe faces. |
| `crates/fullmag-plan/src/tests.rs` | `fdm_cuda_absorbing_boundary_plans_cellwise_damping` | Single-grid FDM CUDA planner regression |
| `apps/control-room/src/modules/inspector/panels/constraint/ObjectExtensionsSpecs.tsx` | `ObjectAbsorbingBoundaryInspectorPanel` | UI authoring and persistence |
| `crates/fullmag-plan/src/tests/material_audit_fem.rs` | `fem_absorber_uses_the_union_of_conformal_owner_segments` | Mapa alpha nie zależy od podziału ownera na markery ani ich kolejności. |
| `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py` | `class SpatialAbsorbingLayer` | Validate immutable layer identity, geometry and profile. |
| `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py` | `class AbsorbingGeometry` | Validate named distance geometries and their SI parameters. |
| `crates/fullmag-ir/src/model.rs` | `SpatialAbsorbingLayerIR` | Represent a named layer and its optional region scope. |
| `crates/fullmag-ir/src/absorbing_boundary.rs` | `validate_absorbing_boundary_config` | Validate unique layer IDs, numeric domains and geometry expressions. |
| `crates/fullmag-ir/src/absorbing_boundary.rs` | `AbsorbingBoundaryCoordinate` | Compile the distance formula with `fullmag-expr` and evaluate finite samples. |
| `packages/fullmag-py/src/fullmag/model/absorbing_boundary.py` | `compile_distance_expression` | Validate distance formulas independently from normalized profiles. |
| `crates/fullmag-plan/src/spatial_absorber.rs` | `MetricShape` | Compile the exact sided distance for supported region boundaries. |
| `crates/fullmag-plan/src/spatial_absorber.rs` | `RegionMask` | Restrict contributions to the referenced region in its own frame. |
| `packages/fullmag-py/tests/test_absorbing_boundary.py` | `test_spatial_layers_round_trip_scene_script_and_ir` | Round-trip six geometries and independent profiles through scene export and canonical IR. |
| `crates/fullmag-plan/src/spatial_absorber.rs` | `spatial_region_cutout_masks_material_and_tracks_its_real_boundary` | Check a signed boundary distance and material scope around a cutout. |
| `crates/fullmag-plan/src/spatial_absorber.rs` | `spatial_tilted_translated_cylinder_is_axially_invariant` | Check oriented cylindrical coordinates and translation invariance. |
