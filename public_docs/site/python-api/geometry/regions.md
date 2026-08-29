---
title: Regions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-regions)=
# Regions

(python-api-geometry-regions-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Regions name geometric subdomains so material parameters, textures, and mesh policy can be
assigned to specific volumes.

(python-api-geometry-regions-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; regions are domain-decomposition metadata.

(python-api-geometry-regions-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All fields are names, priorities, and policy identifiers.

(python-api-geometry-regions-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Names must be non-empty; frame and realization policy accept only the supported identifiers.

(python-api-geometry-regions-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `Region.name` | `str` | `required` | Non-empty | Region name | `name` |
| `Region.geometry` | `Geometry` | `required` | Geometry object | Region domain | `geometry` |
| `ObjectRegion.owner_object` | `str` | `required` | Non-empty | Owning magnet | region owner |
| `ObjectRegion.frame` | `str` | `"object"` | `object` or `world` | Reference frame | `frame` |
| `ObjectRegion.realization_policy` | `str` | `"inherit"` | `inherit`, `conformal`, or `project` | Realization policy | policy |
| `ObjectRegion.priority` | `int` | `0` | Integer | Override priority | priority |
| `ObjectRegion.mesh_policy` | `dict \| None` | `None` | Mapping | Region-local mesh policy | mesh policy |

### Complete stage-first context

Regions are attached to authored geometry and consumed by material/texture overrides.

```python
# %% Declare a region and later assign a localized material override
import fullmag as fm

nm = 1.0e-9

study = fm.study("regions_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-geometry-regions-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`Region.to_ir()` emits `name` and the referenced `geometry` name; object regions carry owner and
policy fields into the object-region mesh specs.

(python-api-geometry-regions-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Duplicate names and invalid policy identifiers fail immediately.

(python-api-geometry-regions-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Regions intersect the mesh state and drive material parameter fields and per-region meshing.

(python-api-geometry-regions-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/structure.py` (`Region`, `ObjectRegion`).

(python-api-geometry-regions-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-geometry-regions-limitations)=
<!-- (limitations)= -->
## Limitations
Region selection is authoring metadata; mesh conformity depends on the selected backend.

(python-api-geometry-regions-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-geometry-regions-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Basic object/shape fields are partial; advanced boolean, imported, auxiliary, and transform parameters remain TODO.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Geometry` | `partial` | Apply geometry draft; object resources become stale |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Geometry` | `TODO` | Python-only until implemented |

TODO: frontend support for every geometry parameter not rendered by GeometryObjectPanel.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx (GeometryObjectPanel)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Domain regions | `packages/fullmag-py/src/fullmag/model/structure.py` | `Region`, `ObjectRegion` | Region lowering | Ownership test |
