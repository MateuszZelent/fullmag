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
| `Ferromagnet.absorbing_boundary` | `AbsorbingBoundaryLayer \| None` | `None` | mixed | typed profile and valid faces | object-scoped damping layer | capability-gated | `magnets[].absorbing_boundary` |
| `Ferromagnet._magnetization_constraints` | `list[object]` | empty list factory | $1$ | populated by typed helpers such as `freeze_spins`; direct mutation is not public workflow | object-scoped constraint accumulator | collected by problem/study lowering | canonical magnetization constraints |

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

FDM realizes the object as active cells; FEM realizes it as marked magnetic elements/nodes. The
constructor does not prove either mesh or device lane executable.

(python-api-magnets-and-textures-ferromagnet-implementation-mapping)=
## Implementation mapping

`packages/fullmag-py/src/fullmag/model/structure.py`, `class Ferromagnet`, owns construction,
default state, object identity, constraint accumulation, and magnet-record lowering.

(python-api-magnets-and-textures-ferromagnet-validation)=
## Validation

Tests compare this complete parameter inventory with `inspect.signature(Ferromagnet)` and validate
the adjacent source map.

(python-api-magnets-and-textures-ferromagnet-limitations)=
## Limitations

The underscore-prefixed accumulator is exposed by the dataclass signature but is not the preferred
user API. Use typed constraint helpers and stage/problem authoring rather than mutating it directly.

(python-api-magnets-and-textures-ferromagnet-scientific-bibliography)=
## Scientific bibliography

No new physical model is introduced; references belong to the interactions consuming the magnet.

(python-api-magnets-and-textures-ferromagnet-source-code-index)=

## Control Room crosswalk

Status: The exposed texture families are partial; unlisted presets remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Magnetization` | `partial` | Apply magnetization draft; authored object state is revised |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Magnetization` | `not implemented` | Python-only until implemented |

frontend support is not implemented for texture presets and arguments not exposed by ObjectMagneticTexturePanel.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx (ObjectMagneticTexturePanel)`.

## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| constructor and lowering | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Ferromagnet` | canonical object API | signature/source-map tests |
| stage-first facade | `packages/fullmag-py/src/fullmag/world.py` | `study.geometry` / magnetic handle | fluent object authoring | builder tests |
