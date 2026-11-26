---
title: Ferromagnet
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-ferromagnet)=
# Ferromagnet

(python-api-magnets-and-textures-ferromagnet-problem-statement)=
## Contract

`Ferromagnet` binds one geometry, one magnetic material, an initial state, optional object-local
mesh/region data, and object-scoped constraints. The stage-first `study.geometry(...)` facade is
the normal user workflow; the constructor remains the canonical class API and serialization owner.

(python-api-magnets-and-textures-ferromagnet-governing-equations)=
## Governing equations

This object introduces no independent field equation. It defines ownership and identity for the
magnetic domain consumed by interactions and dynamics.

(python-api-magnets-and-textures-ferromagnet-symbols-and-si-units)=
## Symbols and SI units

Geometry lengths use metres. Material parameters retain their interaction-specific SI units.
Magnetization textures and region/constraint identities are dimensionless semantic data.

(python-api-magnets-and-textures-ferromagnet-assumptions-and-validity)=
## Assumptions and validity

Names and optional `object_id` values are non-empty. A supplied `Region` must refer to the same
geometry. When `m0` is omitted, the constructor installs uniform $+x$ magnetization. Planner
validation owns mesh, region, material-field, and constraint realization.

(python-api-magnets-and-textures-ferromagnet-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Ferromagnet.name` | `str` | required | $1$ | non-empty | magnetic object name | all authoring lanes | `magnets[].name` |
| `Ferromagnet.geometry` | `Geometry` | required | mixed | valid geometry object | occupied magnetic geometry | all authoring lanes | `magnets[].geometry` / geometry entry |
| `Ferromagnet.material` | `Material` | required | mixed | valid material object | magnetic coefficients | all authoring lanes | `magnets[].material` |
| `Ferromagnet.object_id` | `str \| None` | `None` | $1$ | non-empty when supplied | stable object identity used by selections and constraints | all authoring lanes; planner resolves | `magnets[].object_id` |
| `Ferromagnet.region` | `Region \| None` | `None` | $1$ | geometry must match magnet geometry | optional canonical magnet region | all authoring lanes | `magnets[].region` |
| `Ferromagnet.m0` | `InitialMagnetization \| None` | `None` | $1$ | typed initial state; defaults to uniform $+x$ | initial reduced magnetization | all authoring lanes | `magnets[].initial_magnetization` |
| `Ferromagnet.mesh` | `PerObjectMeshRecipe \| None` | `None` | mixed | typed mesh recipe | object-local meshing intent | planner-dependent | `magnets[].mesh_recipe` |
| `Ferromagnet.object_regions` | `tuple[ObjectRegion, ...]` | `()` | $1$ | unique object-owned identities | authored subregions | planner-dependent | `object_regions` |
| `Ferromagnet.allocated_region_ids` | `tuple[str, ...]` | `()` | $1$ | unique reserved IDs | builder/round-trip region ownership | authoring metadata | region identity registry |
| `Ferromagnet.material_parameter_fields` | `tuple[MaterialParameterAssignment, ...]` | `()` | parameter-dependent | typed, finite, cardinality checked later | spatial material fields | planner-dependent | `material_parameter_fields` |
| `Ferromagnet.absorbing_boundary` | `AbsorbingBoundaryLayer \| AbsorbingBoundaryLayers \| None` | `None` | mixed | valid geometry, widths, taper and region references | object-scoped damping layers | capability-gated | `magnets[].absorbing_boundary` |
| `Ferromagnet._magnetization_constraints` | `list[object]` | empty list factory | $1$ | populated by typed helpers such as `freeze_spins`; direct mutation is not public workflow | object-scoped constraint accumulator | collected by problem/study lowering | canonical magnetization constraints |

### Absorbing boundary layers

Damping ramps that suppress spin-wave reflections at boundaries are configured on a magnet via `film.alpha.absorbing_boundary(...)` or constructed explicitly with `fm.AbsorbingBoundaryLayer`, `fm.AbsorbingGeometry`, and `fm.SpatialAbsorbingLayer` (`packages/fullmag-py/src/fullmag/model/absorbing_boundary.py`).

#### `fm.AbsorbingBoundaryLayer` (single-layer box-face shortcut)

| Field | Type | Default | SI unit | Validation | Meaning |
|---|---|---|---|---|---|
| `total_width_m` | `float` | required | $\mathrm{m}$ | finite and $> 0$ | total absorbing zone depth measured inward from each selected face |
| `ramp_width_m` | `float` | required | $\mathrm{m}$ | finite, $> 0$, and $\le \text{total\_width\_m}$ | tapered transition width before the constant-damping plateau |
| `max_damping` | `float` | required | $1$ | finite and $\ge 0$ | peak Gilbert damping added inside the absorbing zone |
| `faces` | `Sequence[str]` | `("x+",)` | $1$ | non-empty unique subset of `"x+"`, `"x-"`, `"y+"`, `"y-"`, `"z+"`, `"z-"` | bounding-box faces carrying the absorbing layer |
| `profile` | `str` | `"smootherstep"` | $1$ | `"linear"`, `"quadratic"`, `"smootherstep"`, `"logarithmic"`, `"tanh"`, or `"custom"` | monotonic damping ramp shape $p(u) \in [0, 1]$ |
| `frame` | `str` | `"object"` | $1$ | `"object"` or `"universe"` | reference bounding box for face distances |
| `expression` | `str \| None` | `None` | $1$ | required when `profile="custom"`, $\le 256$ printable ASCII chars, $p(0)=0$, $p(1)=1$, $p(u)\in[0,1]$ | custom scalar profile expression in normalized depth $u$ |

#### `fm.SpatialAbsorbingLayer` and `fm.AbsorbingGeometry` (multi-layer general geometry)

Multiple independent layers are combined with `fm.AbsorbingBoundaryLayers(layers)` or passed directly to `film.alpha.absorbing_boundary(layers=[...])`. Each `fm.SpatialAbsorbingLayer` accepts keyword-only fields:

| Field | Type | Default | SI unit | Validation | Meaning |
|---|---|---|---|---|---|
| `layer_id` | `str` | required | $1$ | non-empty unique string | stable layer identifier |
| `name` | `str` | required | $1$ | non-empty string | human-readable layer label |
| `geometry` | `AbsorbingGeometry` | required | mixed | constructed via `.faces(...)`, `.plane(...)`, `.cylinder(...)`, `.sphere(...)`, `.region_boundary(...)`, or `.expression(...)` | spatial support defining distance to the absorbing boundary |
| `total_width_m` | `float` | required | $\mathrm{m}$ | finite and $> 0$; for outward cylinder/sphere, $\le r$ | total absorbing zone thickness |
| `ramp_width_m` | `float` | required | $\mathrm{m}$ | finite, $> 0$, and $\le \text{total\_width\_m}$ | taper width across which damping ramps to `max_damping` |
| `max_damping` | `float` | required | $1$ | finite and $\ge 0$ | peak added Gilbert damping |
| `region_id` | `str \| None` | `None` | $1$ | optional existing object region ID | restricts the absorbing layer to a named object region |
| `enabled` | `bool` | `True` | $1$ | boolean | toggles whether the layer contributes during planning |
| `profile` | `str` | `"smootherstep"` | $1$ | `"linear"`, `"quadratic"`, `"smootherstep"`, `"logarithmic"`, `"tanh"`, or `"custom"` | ramp profile shape |
| `expression` | `str \| None` | `None` | $1$ | required when `profile="custom"` | custom ramp expression in normalized coordinate $u$ |
| `frame` | `str` | `"object"` | $1$ | `"object"` or `"universe"` | coordinate frame for geometric predicates |

`fm.AbsorbingGeometry` exposes six classmethod constructors: `.faces(faces)`, `.plane(origin, normal)`, `.cylinder(center, axis, radius_m, direction="outward")`, `.sphere(center, radius_m, direction="outward")`, `.region_boundary(region_id)`, and `.expression(expression)`. The fluent helper `film.alpha.absorbing_boundary(parameters=None, *, layers=None, total_width=None, ramp_width=None, max_damping=None, faces=None, profile=None, frame=None, expression=None)` lowers directly onto `magnets[].absorbing_boundary`.

### Complete stage-first scenario

```python
# %% Ferromagnet authoring
import fullmag as fm

nm = 1.0e-9
study = fm.study("ferromagnet_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.alpha.absorbing_boundary(
    total_width=20 * nm,
    ramp_width=15 * nm,
    max_damping=0.5,
    faces=("x-", "x+"),
    profile="smootherstep",
)
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-magnets-and-textures-ferromagnet-problem-ir)=
## ProblemIR

The magnet record preserves object identity, material binding, region, initial magnetization,
mesh recipe, and absorbing-boundary data. Object regions, fields, and constraints retain separate
typed ownership rather than being flattened into the magnet name.

(python-api-magnets-and-textures-ferromagnet-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves object IDs, region ownership, material bindings, texture versions,
mesh recipes, and constraint identities. Resolved execution adds concrete cell/element ownership,
normalized data, masks, solver, device, and precision without replacing authored intent.
Validation errors reject unknown references, duplicate identities, mismatched region geometry, and
malformed data. Unsupported combinations fail closed and are not silently omitted or converted.

(python-api-magnets-and-textures-ferromagnet-discrete-realization)=
## Discrete realization

| Solver | Device | Realization | Qualification status |
|---|---|---|---|
| FDM | CPU | planner realizes the magnet as active cells with resolved material, region, initial-state, and ABL masks | authoring and IR documented; runtime qualification separate |
| FDM | GPU | consumes the shared planner-materialized cell masks, material arrays, and initial vectors | authoring and IR documented; GPU runtime qualification separate |
| FEM | CPU | planner realizes the magnet as marked magnetic tetrahedral elements and P1 nodes | authoring and IR documented; runtime qualification separate |
| FEM | GPU | consumes the shared planner-materialized magnetic mesh and nodal arrays | authoring and IR documented; GPU runtime qualification separate |

FDM realizes the object as active cells; FEM realizes it as marked magnetic elements/nodes. The
constructor does not prove either mesh or device lane executable.

(python-api-magnets-and-textures-ferromagnet-implementation-mapping)=
## Implementation mapping

`packages/fullmag-py/src/fullmag/model/structure.py`, `class Ferromagnet`, owns construction,
default state, object identity, constraint accumulation, and magnet-record lowering.
`packages/fullmag-py/src/fullmag/model/absorbing_boundary.py` (`AbsorbingBoundaryLayer`,
`AbsorbingGeometry`, `SpatialAbsorbingLayer`, and `AbsorbingBoundaryLayers`) owns absorbing-layer
validation and serialization.

(python-api-magnets-and-textures-ferromagnet-validation)=
## Validation

Tests compare this complete parameter inventory with `inspect.signature(Ferromagnet)`.

(python-api-magnets-and-textures-ferromagnet-limitations)=
## Limitations

The underscore-prefixed accumulator is exposed by the dataclass signature but is not the preferred
user API. Use typed constraint helpers and stage/problem authoring rather than mutating it directly.

(python-api-magnets-and-textures-ferromagnet-scientific-bibliography)=
## Scientific bibliography

No new physical model is introduced; references belong to the interactions consuming the magnet.

## Control Room support

Status: Scalar object material fields (`ObjectMaterialSpec`), region overrides (`RegionsRootSpec` / `RegionDetailSpec` / `RegionMagneticParametersSpec`), and the `20` built-in `MAGNETIZATION_TEXTURE_PRESETS` in `MagneticTextureInspectorPanel` are `partial`; custom spatial callbacks and unlisted Python options remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Initial magnetization presets | `Model Explorer -> Objects -> <object> -> Magnetization` | `partial` | Apply magnetization draft (`commitMagneticTextureApply`); authored object state is revised |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Magnetization` | `Python-only` | Authored in Python |

Open **Physics -> Add ABL** on a magnetic object to configure independently placed damping layers. Their geometry, target region, widths, and profiles round-trip through `film.alpha.absorbing_boundary(...)`. See {doc}`/frontend/inspectors/absorbing-boundaries` for complete examples and the effective damping field.
See {doc}`/frontend/inspectors/objects-and-materials` and [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/magnetic-texture/MagneticTextureInspectorPanel.tsx` (`MagneticTextureInspectorPanel`).

```{image} /_static/images/ui/inspector-magnetic-texture.png
:alt: Semantic Inspector Magnetic Texture panel configuring a ferromagnet initial magnetization
:width: 92%
```

(python-api-magnets-and-textures-ferromagnet-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| constructor and lowering | [`packages/fullmag-py/src/fullmag/model/structure.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L825) | [`class Ferromagnet`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L825) | canonical object API | signature and API contract tests |
| box-face absorbing layer | [`packages/fullmag-py/src/fullmag/model/absorbing_boundary.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/absorbing_boundary.py#L149) | [`class AbsorbingBoundaryLayer`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/absorbing_boundary.py#L149) | box-face damping layer validation and IR | Python validation tests |
| absorbing geometry predicates | [`packages/fullmag-py/src/fullmag/model/absorbing_boundary.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/absorbing_boundary.py#L268) | [`class AbsorbingGeometry`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/absorbing_boundary.py#L268) | faces, plane, cylinder, sphere, region, and expression ABL geometry | Python validation tests |
| independent absorbing layers | [`packages/fullmag-py/src/fullmag/model/absorbing_boundary.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/absorbing_boundary.py#L317) | [`class SpatialAbsorbingLayer`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/absorbing_boundary.py#L317) | geometry, region target and taper | Python validation and scene export/import tests |
| stage-first facade | `packages/fullmag-py/src/fullmag/world.py` | `study.geometry` / magnetic handle | fluent object authoring | builder tests |
