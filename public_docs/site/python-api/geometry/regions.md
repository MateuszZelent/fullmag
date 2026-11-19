---
title: Regions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Geometry regions

(public-docs-python-api-geometry-regions)=
(python-api-geometry-regions-problem-statement)=
## Problem statement

Regions are owner-scoped typed records; registration and realization remain separate operations.

This page covers the Python authoring contract: construction validates region identifiers, owner scope, and shape metadata in Python, while `to_ir()` emits the canonical `ProblemIR` record before mesh realization.

(python-api-geometry-regions-governing-equations)=
## Governing equations

An object-owned region $\Omega_r \subseteq \Omega_{\mathrm{owner}}$ selects a subvolume using a typed geometric shape (evaluated in the owning object's frame or world coordinates) and resolves overlaps by descending integer `priority`. Region partitioning and parameter override semantics are documented in {doc}`../../physics/geometry-and-materials` and {doc}`../materials/spatial-parameter-fields`.

(python-api-geometry-regions-symbols-and-si-units)=
## Symbols and SI units

The constructor metadata and policy flags (`name`, `region_id`, `frame`, `enabled`, `priority`, and `realization_policy`) are dimensionless descriptors ($1$). Any nested `geometry` / `shape` object carries coordinates and dimensions in SI metres ($\mathrm{m}$).

(python-api-geometry-regions-assumptions-and-validity)=
## Assumptions and validity

Region `name` must be non-empty, `geometry` must be a typed geometry object, `enabled` is boolean, `priority` is an integer, and `frame` / `realization_policy` must be recognized policy strings. Cross-object owner mismatches, empty names, or unsupported realization policies fail closed during construction or lowering.

(python-api-geometry-regions-python-api)=
## Python API

### Constructor or function

`fm.Region(name, geometry)` and `fm.ObjectRegion(...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `Region.name` | `str` | `required` | $1$ | non-empty | region name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `Region.geometry` | `Geometry` | `required` | $1$ | typed geometry | region shape | FEM/FDM CPU/GPU: IR; resolver-specific | `shape` |
| `ObjectRegion.owner_object` | `str or object` | `required` | $1$ | owner-scoped | owning object | FEM/FDM CPU/GPU: IR; resolver-specific | `owner` |
| `ObjectRegion.name` | `str` | `required` | $1$ | non-empty | region name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `ObjectRegion.region_id` | `str or None` | `None` | $1$ | stable when supplied | region identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `region_id` |
| `ObjectRegion.frame` | `str` | `object` | $1$ | supported frame | coordinate frame | FEM/FDM CPU/GPU: IR; resolver-specific | `frame` |
| `ObjectRegion.enabled` | `bool` | `True` | $1$ | boolean | activation flag | FEM/FDM CPU/GPU: IR; resolver-specific | `enabled` |
| `ObjectRegion.priority` | `int` | `0` | $1$ | integer | overlap precedence | FEM/FDM CPU/GPU: IR; resolver-specific | `priority` |
| `ObjectRegion.realization_policy` | `str` | `inherit` | $1$ | supported policy | mesh/realization inheritance | FEM/FDM CPU/GPU: IR; resolver-specific | `realization_policy` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("public-api-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
# Author the documented object after the stage exists.
value = fm.Region("film", fm.Box(size=(100e-9, 20e-9, 5e-9)))
canonical_ir = value.to_ir()
```

In a complete simulation script, attach regions on an owning study object (`obj.regions...`) or register typed `Region` descriptors at geometry construction time.

(python-api-geometry-regions-problem-ir)=
## ProblemIR

`Region.to_ir()` emits a dictionary with `"name"` and serialized `"geometry"`, while `ObjectRegion.to_ir()` lowers owner-scoped region metadata (`"owner"`, `"name"`, `"region_id"`, `"frame"`, `"enabled"`, `"priority"`, `"realization_policy"`, and nested `"shape"`).

(python-api-geometry-regions-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves region ownership, precedence, coordinate frame, and realization policy in `ProblemIR` independently of `resolved execution`. `Validation errors` reject empty names, invalid coordinate frames, and non-typed geometry shapes, while `unsupported combinations` fail closed when a backend cannot realize a region policy.

(python-api-geometry-regions-discrete-realization)=
## Discrete realization

The Python contract supplies owner-scoped region descriptors and canonical `ProblemIR` only; cell/tetrahedron tagging, subdomain conformity, and overlap resolution are performed by the backend meshers and material evaluators.

(python-api-geometry-regions-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/structure.py` (`class ObjectRegion` and `class Region`). Constructor parameters, validation branches, defaults, and `to_ir()` keys come directly from that module.

(python-api-geometry-regions-validation)=
## Validation

Focused repository unit tests covering owner-scoped regions include `test_region_registries_are_owner_scoped_and_study_read_only` and `test_region_shape_translation_adds_to_existing_center`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-geometry-regions-limitations)=
## Limitations and Control Room

Object-owned spatial regions (`ObjectRegion`) are inspected and authored in Control Room under `Model Explorer -> Objects -> <object> -> Regions` (`ObjectRegionsPanel`, `RegionsListPanel`, and `inspector/panels/region/` sub-panels: `ObjectRegionOverviewPanel`, `ObjectRegionGeometryPanel`, `ObjectRegionMagneticParametersPanel`, `ObjectRegionMeshPanel`, `ObjectRegionTexturePanel`, `ObjectRegionVisualizationPanel`, `ObjectRegionDiagnosticsPanel`, `ObjectRegionNestedRegionsPanel`). UI geometry drafts validate bounds against the owning object (`clampObjectRegionDraftShapeToOwnerBounds`); arbitrary selection combinators not represented by region boxes stay `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Region geometry bounds, material overrides, texture, & mesh policy | `Model Explorer -> Objects -> <object> -> Regions -> <region>` (`ObjectRegionsPanel`) | `partial` | `QuantityFieldDraftScope` validation & `runAuthoringMutationWithHistory` |
| Complex scripted selectors or unsupported nested rules | Python DSL | `Python-only` | Preserved read-only; author in Python |

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
| `packages/fullmag-py/src/fullmag/model/structure.py` | `class ObjectRegion` | public constructor and IR lowering |
