---
title: Regions
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Geometry regions

(public-docs-python-api-geometry-regions)=
(python-api-geometry-regions-problem-statement)=
## Problem statement

Regions are owner-scoped typed subvolumes (`Region`, `ObjectRegion`, `RegionRef`) carrying optional
mesh policies, material overrides (`RegionMaterialOverride`), boundary transition specs, texture
overrides (`RegionTextureOverride`), and frozen-spin constraints (`ObjectRegion.freeze_spins`).
Composable spatial/logical selection expressions (`Selection`, `SelectionDefinition`,
`SelectionScalar`, and the `fm.select` module) complement object regions for constraints, drives,
and diagnostics.

(python-api-geometry-regions-governing-equations)=
## Governing equations

An object-owned region $\Omega_r \subseteq \Omega_{\mathrm{owner}}$ selects a subvolume using a
typed geometric `shape` (evaluated in the owning object's frame or world coordinates) and resolves
overlaps by descending integer `priority` (equal highest priorities fail closed). Region
partitioning, material override precedence, and texture clipping are documented in
{doc}`../../physics/geometry-and-materials`, {doc}`../materials/spatial-parameter-fields`, and
{doc}`../magnets-and-textures/preset-textures`.

(python-api-geometry-regions-symbols-and-si-units)=
## Symbols and SI units

Region metadata, identifiers, conflict/realization policies, boolean `enabled` flags, and integer
`priority` values are dimensionless ($1$). Nested geometry `shape` objects carry coordinates and
dimensions in SI metres ($\mathrm{m}$); `RegionMaterialOverride.value` carries the SI unit of the
overridden material parameter.

(python-api-geometry-regions-assumptions-and-validity)=
## Assumptions and validity

Region `name` must be non-empty, `shape`/`geometry` must be a typed geometry object, `enabled` is
boolean, `priority` is an integer, and `frame` / `realization_policy` / `conflict_policy` must be
recognized policy strings. Cross-object owner mismatches, empty names, duplicate region IDs, or
equal-priority ambiguous overlaps fail closed during construction, lowering, or planning.

(python-api-geometry-regions-python-api)=
## Python API

### Constructors, handle methods, and selection helpers

- **Region & override classes**: `fm.Region(name, geometry)`, `fm.ObjectRegion(...)`,
  `fm.RegionRef(object_id, region_id=None)`,
  `fm.RegionMaterialOverride(parameter, value, priority=0, conflict_policy="error")`,
  `fm.RegionTextureOverride(initial_magnetization)`.
- **`MagnetHandle` region management**:
  - `magnet.add_region(name, shape, *, region_id=None, frame="object", enabled=True, priority=0, realization_policy="inherit") -> ObjectRegion`
  - `magnet.remove_region(region: ObjectRegion \| str \| int) -> ObjectRegion`
  - `magnet.rename_region(region: ObjectRegion \| str \| int, name: str) -> ObjectRegion`
  - `magnet.reorder_region(region: ObjectRegion \| str \| int, index: int) -> ObjectRegion`
- **Region constraint helper**: `region.freeze_spins(*, id=None, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")`.
- **Selection expressions**: `fm.Selection(expression)`, `fm.SelectionDefinition(selection_id, expression, name=None)`, `fm.SelectionScalar(expression)`, and the `fm.select` module helpers (`in_object`, `in_region`, `in_geometry`, `where`, `all_of`, `any_of`, `not_`, coordinate scalars `x`, `y`, `z`, `r`).

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `Region.name` | `str` | `required` | $1$ | non-empty | canonical geometry region name | FEM/FDM CPU/GPU: IR; resolver-specific | `regions[].name` |
| `Region.geometry` | `Geometry` | `required` | $1$ | typed geometry | region shape | FEM/FDM CPU/GPU: IR; resolver-specific | `regions[].geometry` |
| `ObjectRegion.owner_object` | `str` | `required` | $1$ | owner-scoped object identifier | owning magnetic object | FEM/FDM CPU/GPU: IR; resolver-specific | `object_regions[].owner_object` |
| `ObjectRegion.name` | `str` | `required` | $1$ | non-empty | region display name | FEM/FDM CPU/GPU: IR; resolver-specific | `object_regions[].name` |
| `ObjectRegion.shape` | `Geometry` | `required` | $1$ | typed geometry object | subvolume bounding/clipping shape | FEM/FDM CPU/GPU: IR; resolver-specific | `object_regions[].shape` |
| `ObjectRegion.region_id` | `str \| None` | `None` | $1$ | stable unique ID when supplied | region identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `object_regions[].region_id` |
| `ObjectRegion.frame` | `str` | `"object"` | $1$ | `"object"` or `"world"` | coordinate frame for `shape` evaluation | FEM/FDM CPU/GPU: IR; resolver-specific | `object_regions[].frame` |
| `ObjectRegion.enabled` | `bool` | `True` | $1$ | boolean | region activation flag | FEM/FDM CPU/GPU: IR; resolver-specific | `object_regions[].enabled` |
| `ObjectRegion.priority` | `int` | `0` | $1$ | integer; equal highest priorities fail closed | overlap precedence | FEM/FDM CPU/GPU: IR; resolver-specific | `object_regions[].priority` |
| `ObjectRegion.realization_policy` | `str` | `"inherit"` | $1$ | supported realization policy | mesh/realization inheritance | FEM/FDM CPU/GPU: IR; resolver-specific | `object_regions[].realization_policy` |
| `ObjectRegion.mesh_policy` | `dict[str, object] \| None` | `None` | $1$ | typed region mesh policy mapping | optional local FEM/FDM mesh sizing policy | FEM/FDM CPU/GPU: IR; planner-validated | `object_regions[].mesh_policy` |
| `ObjectRegion.material_overrides` | `list[RegionMaterialOverride] \| None` | `None` | parameter-dependent | typed `RegionMaterialOverride` list | local spatial/constant material overrides | FEM/FDM CPU/GPU: IR; planner-validated | `object_regions[].material_overrides` |
| `ObjectRegion.material_transition_spec` | `MaterialTransitionSpec \| None` | `None` | $1$ | typed boundary transition policy | explicit transition width/scope for `Ms`/`Aex` | FEM/FDM CPU/GPU: IR; planner-validated | `object_regions[].material_transition_spec` |
| `ObjectRegion.texture_override` | `RegionTextureOverride \| None` | `None` | $1$ | typed `RegionTextureOverride` | local initial magnetization override clipped to the winning region | FEM/FDM CPU/GPU: IR; planner-validated | `object_regions[].texture_override` |
| `RegionRef.object_id` | `str` | `required` | $1$ | non-empty object identity | referenced object ID (with optional `RegionRef.region_id`) | FEM/FDM CPU/GPU: IR | `object_id`, `region_id` |
| `RegionMaterialOverride.parameter` | `str` | `required` | $1$ | canonical or alias material parameter name | material parameter overridden inside the region | FEM/FDM CPU/GPU: IR | `material_overrides[].parameter` |
| `RegionMaterialOverride.value` | `MaterialParameterField` | `required` | parameter-dependent | typed `MaterialParameterField` | replacement field value inside the region | FEM/FDM CPU/GPU: IR | `material_overrides[].value` |
| `RegionTextureOverride.initial_magnetization` | `InitialMagnetization` | `required` | $1$ | typed initializer or preset texture | region-local initial magnetization | FEM/FDM CPU/GPU: IR | `texture_override.initial_magnetization` |
| `SelectionDefinition.selection_id` | `str` | `required` | $1$ | unique non-empty selection identifier | named composable selection expression (`SelectionDefinition.expression`) | FEM/FDM CPU/GPU: IR | `selections[].selection_id` |

### Stage-first example

```python
# %% Stage-first study with MagnetHandle region CRUD, overrides, freeze_spins, and Selection
import fullmag as fm

nm = 1.0e-9

study = fm.study("regions_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=5 * nm)

film = study.geometry(fm.Box(size=(100 * nm, 40 * nm, 5 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

core = film.add_region(
    "core_pin",
    fm.Cylinder(radius=10 * nm, height=5 * nm),
    priority=10,
)
film.rename_region(core, "pinned_core")
core.set_texture(fm.texture.uniform(0.0, 0.0, 1.0))
core.freeze_spins(id="core_pin_freeze", reference="initial_state")

ref = fm.RegionRef(object_id="film", region_id=core.region_id)
mat_ov = fm.RegionMaterialOverride(
    parameter="Ku1",
    value=fm.fields.constant(5.0e4, unit="J/m^3"),
    priority=10,
)
tex_ov = fm.RegionTextureOverride(initial_magnetization=fm.texture.uniform(0.0, 0.0, 1.0))
assert ref.region_id == core.region_id
assert mat_ov.to_ir()["parameter"] == "ku1"
assert tex_ov.to_ir()["initial_magnetization"]["preset_kind"] == "uniform"

study.exchange()
study.stages.add_relax(stage_id="relax", dt=5e-13, max_steps=1)
```

(python-api-geometry-regions-problem-ir)=
## ProblemIR

`Region.to_ir()` lowers to `{"name": ..., "geometry": ...}` under `regions[]`, while
`ObjectRegion.to_ir()` lowers owner-scoped metadata (`owner_object`, `name`, `region_id`, `frame`,
`enabled`, `priority`, `realization_policy`, `shape`, plus optional `mesh_policy`,
`material_overrides`, `material_transition_spec`, and `texture_override`) into `object_regions[]`.
Named `SelectionDefinition` records lower into `selections[]`.

(python-api-geometry-regions-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves region ownership, priority ordering, coordinate frame, realization
policy, overrides, and selection ASTs in `ProblemIR` independently of `resolved execution`.
`Validation errors` reject empty names, invalid frames, cyclic selections, and equal-priority
overlaps, while `unsupported combinations` fail closed when a backend cannot realize a region
policy.

(python-api-geometry-regions-discrete-realization)=
## Discrete realization

| Solver | Device | Region & selection realization | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Evaluates region predicates and selection ASTs on structured cell centres with numeric winning-region masks | Overlap priority and clipping covered by planner tests |
| FDM | GPU | Consumes planner-materialized cellwise masks/arrays on single-grid CUDA (multilayer region fields gated) | Executed-device GPU qualification remains separate |
| FEM | CPU | Evaluates region predicates on magnetic mesh elements/nodes (with optional conformal subdomain tagging) | Conformal meshing and nodal interface priority covered by planner tests |
| FEM | GPU | Consumes host-materialized FEM region assignments and masks uploaded to CUDA | Executed-device GPU qualification remains separate |

(python-api-geometry-regions-implementation-mapping)=
## Implementation mapping

Authoritative implementations live in `packages/fullmag-py/src/fullmag/model/structure.py`
(`class ObjectRegion`, `class Region`, `class RegionMaterialOverride`, `class RegionTextureOverride`),
`packages/fullmag-py/src/fullmag/model/spin_torque.py` (`class RegionRef`),
`packages/fullmag-py/src/fullmag/model/selection.py` (`class Selection`,
`class SelectionDefinition`, `class SelectionScalar`), `packages/fullmag-py/src/fullmag/select.py`,
and `packages/fullmag-py/src/fullmag/world.py` (`MagnetHandle.{add,remove,rename,reorder}_region`).

(python-api-geometry-regions-validation)=
## Validation

Focused repository unit tests covering owner-scoped regions and selections include
`test_region_registries_are_owner_scoped_and_study_read_only`,
`test_region_shape_translation_adds_to_existing_center`, and selection-graph cycle/reference tests.

(python-api-geometry-regions-limitations)=
## Limitations and Control Room

Object-owned spatial regions (`ObjectRegion`) are inspected and authored in Control Room under
`Model Explorer -> Objects -> <object> -> Regions` via `RegionsRootSpec`
(`apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionsRootSpec.tsx`) and
`RegionDetailSpec`
(`apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionDetailSpec.tsx`),
together with `RegionMagneticParametersSpec`
(`apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionMagneticParametersSpec.tsx`)
and `MagneticTextureInspectorPanel` for region-scoped texture overrides. Arbitrary programmatic
`Selection` combinators not represented by region primitives remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Region CRUD, geometry bounds, material overrides, texture, & mesh policy | `Model Explorer -> Objects -> <object> -> Regions -> <region>` (`RegionsRootSpec`, `RegionDetailSpec`, `RegionMagneticParametersSpec`) | `partial` | Staged draft validation & `runAuthoringMutationWithHistory` on `scene_revision` |
| Complex scripted `Selection` / `fm.select` combinators | Python DSL | `Python-only` | Preserved read-only; author in Python |

```{image} /_static/images/ui/inspector-material-and-regions.png
:alt: Control Room Object Regions inspector listing Pinning Annulus and Skyrmion Core cylindrical regions for obj_yig_film with Add Region controls
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/objects-and-materials`.

(python-api-geometry-regions-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-regions-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/structure.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L386) | [`class ObjectRegion`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L386), `class RegionMaterialOverride`, `class RegionTextureOverride` | owner-scoped region constructor, overrides, and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/spin_torque.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L74) | [`class RegionRef`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/spin_torque.py#L74) | typed object/region reference |
| [`packages/fullmag-py/src/fullmag/model/selection.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/selection.py#L437) | [`class SelectionDefinition`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/selection.py#L437), `class Selection`, `class SelectionScalar` | composable selection ASTs and named definitions |
