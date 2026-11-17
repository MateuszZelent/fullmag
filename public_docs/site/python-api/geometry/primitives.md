---
title: Primitives
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Geometry primitives

(public-docs-python-api-geometry-primitives)=
(python-api-geometry-primitives-problem-statement)=
## Problem statement

Primitive constructors normalize their typed geometric representation before mesh generation.

This page covers the Python authoring contract: construction validates positive dimensions in Python, while `to_ir()` emits the canonical `ProblemIR` record before mesh generation.

(python-api-geometry-primitives-governing-equations)=
## Governing equations

Each primitive defines a bounded three-dimensional region $\Omega_k \subset \mathbb{R}^3$ parameterized by its Cartesian extents or principal radii in metres ($\mathrm{m}$) and, for oriented solids (`Cylinder`), a normalized unit axis vector $\hat{\mathbf{a}} \in \mathbb{S}^2$. Domain conventions and CAD/mesh realization semantics are documented in {doc}`../../physics/geometry-and-materials` and {doc}`../../numerical-methods/meshing/index`.

(python-api-geometry-primitives-symbols-and-si-units)=
## Symbols and SI units

Linear dimensions (`Box.size`, `Cylinder.radius/height`, `Ellipsoid.rx/ry/rz`, `Sphere.radius`, and `Ellipse.rx/ry/height`) use SI metres ($\mathrm{m}$). Orientation vectors (`Cylinder.axis`) and identifiers (`name`) are dimensionless ($1$).

(python-api-geometry-primitives-assumptions-and-validity)=
## Assumptions and validity

All geometric dimensions must be finite and strictly positive, `Cylinder.axis` must be a finite non-zero three-vector, and `name` must be a non-empty string. Zero or negative dimensions, non-finite coordinates, or contradictory size arguments in `Box` fail closed during construction or lowering.

(python-api-geometry-primitives-python-api)=
## Python API

### Constructor or function

`fm.Box`, `fm.Cylinder`, `fm.Ellipsoid`, `fm.Sphere`, `fm.Ellipse`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `Box.size` | `tuple[float,float,float]` | `required` | $\mathrm{m}$ | three positive components | box dimensions | FEM CPU/GPU: IR; FDM CPU/GPU: mesh/resolver-specific | `size` |
| `Box.name` | `str` | `box` | $1$ | non-empty | stable geometry name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `Cylinder.radius/height` | `float` | `required` | $\mathrm{m}$ | positive | cylinder dimensions | FEM/FDM CPU/GPU: IR; resolver-specific | `radius/height` |
| `Cylinder.axis` | `tuple[float,float,float]` | `(0,0,1)` | $1$ | finite non-zero; normalized | cylinder axis | FEM/FDM CPU/GPU: IR; resolver-specific | `axis` |
| `Ellipsoid.rx/ry/rz` | `float` | `required` | $\mathrm{m}$ | positive | principal radii | FEM/FDM CPU/GPU: IR; resolver-specific | `radii` |
| `Sphere.radius` | `float` | `required` | $\mathrm{m}$ | positive | sphere radius | FEM/FDM CPU/GPU: IR; resolver-specific | `radius` |
| `Ellipse.rx/ry/height` | `float` | `required` | $\mathrm{m}$ | positive | extruded ellipse dimensions | FEM/FDM CPU/GPU: IR; resolver-specific | `radii/height` |

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
value = fm.Box(size=(100.0e-9, 20.0e-9, 5.0e-9), name="film")
canonical_ir = value.to_ir()
```

In a complete simulation script, pass the constructed primitive to `study.geometry(...)` or compose it with `fm.Translate`, boolean operations, or `fm.Region`.

(complete-qualified-box-signature)=
### Complete qualified Box signature

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `Box.size_or_x` | `float or sequence or None` | `None` | $\mathrm{m}$ | positive scalar or three-vector form | size or x dimension | FEM/FDM CPU/GPU: IR; resolver-specific | `size` |
| `Box.y` | `float or None` | `None` | $\mathrm{m}$ | positive when scalar form is used | y dimension | FEM/FDM CPU/GPU: IR; resolver-specific | `size` |
| `Box.z` | `float or None` | `None` | $\mathrm{m}$ | positive when scalar form is used | z dimension | FEM/FDM CPU/GPU: IR; resolver-specific | `size` |
| `Box.size` | `sequence or None` | `None` | $\mathrm{m}$ | positive three-vector when supplied | keyword size | FEM/FDM CPU/GPU: IR; resolver-specific | `size` |
| `Box.name` | `str` | `box` | $1$ | non-empty | stable geometry name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |

(python-api-geometry-primitives-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind"` (`"box"`, `"cylinder"`, `"ellipsoid"`, or `"ellipse"`), `"name"`, and primitive dimension keys (for `Box`, `"size"` as a three-element SI list; `Sphere` serializes as an equal-radii `"ellipsoid"`).

(python-api-geometry-primitives-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves primitive kind, dimensions, normalized axes, and identifiers in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing arguments, non-finite values, non-positive extents, and contradictory `Box` size forms, while `unsupported combinations` fail closed in downstream meshers.

(python-api-geometry-primitives-discrete-realization)=
## Discrete realization

The Python contract supplies geometric parameters and canonical `ProblemIR` only; rasterization onto structured FDM grids or tetrahedral/mixed FEM meshing via Gmsh is handled by the backend meshers.

(python-api-geometry-primitives-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/geometry.py` (`class Box` and sibling primitive classes). Constructor parameters, validation branches, defaults, and `to_ir()` keys come directly from that module.

(python-api-geometry-primitives-validation)=
## Validation

Focused repository unit tests covering primitive IR export and validation include `test_waveguide_geometries_export_canonical_ir` and `test_waveguide_geometry_validation_rejects_invalid_dimensions`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-geometry-primitives-limitations)=
## Limitations and Control Room

Standard primitive shapes (`box`, `cylinder`, `sphere`, `microstrip`, `cpw`, `thin_film`) are authored and inspected in Control Room via `GeometryObjectPanel` (`Model Explorer -> Objects -> <object> -> Geometry`) using unit-aware `QuantityField` SI inputs (`m`, `mm`, `um`, `nm`). Exotic primitive subclasses or parametric expressions without exposed UI fields remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Supported primitive dimensions (`box`, `cylinder`, `sphere`, `microstrip`, `cpw`, `thin_film`) | `Model Explorer -> Objects -> <object> -> Geometry` (`GeometryObjectPanel`) | `partial` | `runAuthoringMutationWithHistory` on `scene_revision` (invalidates stale mesh) |
| Unsupported subclasses or scripted dimensions | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-geometry-and-csg.png
:alt: Control Room Geometry Inspector showing Primitive Geometry kind box and Size x/y/z inputs in SI metres
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/objects-and-materials`.

(python-api-geometry-primitives-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-primitives-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Box` | public constructor and IR lowering |
