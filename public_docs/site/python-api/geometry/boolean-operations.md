---
title: Boolean Operations
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Boolean geometry operations

(public-docs-python-api-geometry-boolean-operations)=
(python-api-geometry-boolean-operations-problem-statement)=
## Problem statement

Boolean operations preserve operand structure in IR and do not perform hidden meshing at construction.

Construction validates operand types and names in Python; calling `to_ir()` emits the nested constructive solid geometry (CSG) record consumed by the meshing and study pipeline.

(python-api-geometry-boolean-operations-governing-equations)=
## Governing equations

`Difference`, `Union`, and `Intersection` define set-theoretic solid domains $\Omega_{\mathrm{diff}} = \Omega_{\mathrm{base}} \setminus \Omega_{\mathrm{tool}}$, $\Omega_{\mathrm{union}} = \Omega_a \cup \Omega_b$, and $\Omega_{\mathrm{int}} = \Omega_a \cap \Omega_b$ in $\mathbb{R}^3$. Meshing and active-cell/tetrahedral realization of CSG trees are documented in {doc}`../../physics/geometry-and-materials` and {doc}`../../numerical-methods/meshing/index`.

(python-api-geometry-boolean-operations-symbols-and-si-units)=
## Symbols and SI units

Operand geometries carry SI metre ($\mathrm{m}$) dimensions internally; the Boolean operator arguments (`base`/`tool`, `a`/`b`) and resulting object `name` are dimensionless ($1$).

(python-api-geometry-boolean-operations-assumptions-and-validity)=
## Assumptions and validity

Operands must be valid `Geometry` instances (including primitives, transforms, or nested Booleans), and `name` must be non-empty. Invalid operand types or empty result domains fail closed at construction, lowering, or mesh generation.

(python-api-geometry-boolean-operations-python-api)=
## Python API

### Constructor or function

`fm.Difference(base, tool, name="difference")`, `fm.Union(a, b, name="union")`, `fm.Intersection(a, b, name="intersection")`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `base/tool or a/b` | `Geometry` | `required` | $1$ | typed geometry operands | boolean operands | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `operands` |
| `name` | `str` | `operation default` | $1$ | non-empty | result name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |

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
value = fm.Difference(fm.Box(size=(100e-9, 20e-9, 5e-9)), fm.Cylinder(radius=5e-9, height=5e-9))
canonical_ir = value.to_ir()
```

In a complete simulation script, pass the CSG object directly to `study.geometry(...)`.

(python-api-geometry-boolean-operations-problem-ir)=
## ProblemIR

`value.to_ir()` emits a nested CSG dictionary with `"kind"` equal to `"difference"`, `"union"`, or `"intersection"`, `"name"`, and nested `"base"`/`"tool"` or `"a"`/`"b"` geometry records.

(python-api-geometry-boolean-operations-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the full recursive CSG tree in `ProblemIR` independently of `resolved execution`. `Validation errors` reject non-geometry operands or invalid names, while `unsupported combinations` (such as degenerate empty cuts during meshing) fail closed at the mesher or backend boundary.

(python-api-geometry-boolean-operations-discrete-realization)=
## Discrete realization

The Python contract supplies the CSG tree and canonical `ProblemIR` only; CAD/OpenCASCADE Boolean evaluation for FEM tetrahedral meshing and voxel occupancy evaluation for FDM grids are owned by the meshing backends in {doc}`../../numerical-methods/meshing/index`.

(python-api-geometry-boolean-operations-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/geometry.py` (`class Difference`, `class Union`, `class Intersection`). Constructor parameters, validation branches, defaults, and `to_ir()` keys come directly from that module.

(python-api-geometry-boolean-operations-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_boolean_geometry_exports_nested_ir`. Mesh realization and geometric accuracy require separate backend qualification.

(python-api-geometry-boolean-operations-limitations)=
## Limitations and Control Room

Python-authored Boolean CSG compositions (`Union`, `Intersection`, `Difference`) are surfaced read-only inside `GeometryObjectPanel` (`Model Explorer -> Objects -> <object> -> Geometry`) for inspection and placement. Interactive CSG creation buttons on the Ribbon remain gated behind `preview: true` and are excluded from the active toolbar, so authoring multi-body Boolean operations stays `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Script-authored CSG geometry inspection & translation | `Model Explorer -> Objects -> <object> -> Geometry` (`GeometryObjectPanel`) | `inspection-only` (translation editable in `ObjectPlacementPanel`) | Scene load / `fm.connect()` sync |
| Multi-body Boolean CSG creation/editing (`Union`, `Difference`, `Intersection`) | Ribbon CSG controls (`preview: true`) | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-geometry-and-csg.png
:alt: Control Room Geometry Inspector displaying the Primitive Geometry box editor and Geometry/Placement tabs while Ribbon CSG creation remains hidden
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/objects-and-materials`.

(python-api-geometry-boolean-operations-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-boolean-operations-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Difference` | public constructor and IR lowering |
