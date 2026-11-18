---
title: Transforms
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Geometry transforms

(public-docs-python-api-geometry-transforms)=
(python-api-geometry-transforms-problem-statement)=
## Problem statement

Translation is a nested IR operation; existing geometry centers are not silently discarded.

This page covers the Python authoring contract: construction validates a typed geometry operand and finite translation offset in Python, while `to_ir()` emits the nested `ProblemIR` record before mesh generation.

(python-api-geometry-transforms-governing-equations)=
## Governing equations

Translating a geometry $\Omega_{\mathrm{base}} \subset \mathbb{R}^3$ by a Cartesian displacement $\mathbf{b} = (b_x, b_y, b_z) \in \mathbb{R}^3$ produces $\Omega' = \{ \mathbf{x} + \mathbf{b} : \mathbf{x} \in \Omega_{\mathrm{base}} \}$, preserving nested offsets when composed around existing translations or centered regions. Domain conventions and mesh realization semantics are documented in {doc}`../../physics/geometry-and-materials` and {doc}`../../numerical-methods/meshing/index`.

(python-api-geometry-transforms-symbols-and-si-units)=
## Symbols and SI units

The displacement `offset` is a three-component Cartesian vector in SI metres ($\mathrm{m}$). The source `geometry` operand and optional `name` descriptor are dimensionless ($1$).

(python-api-geometry-transforms-assumptions-and-validity)=
## Assumptions and validity

`geometry` must be a typed geometry node, `offset` must be a finite three-element sequence (even if zero along some axes), and `name` must be non-empty when supplied. Non-finite coordinates, malformed offset lengths, or untyped operands fail closed at construction or lowering.

(python-api-geometry-transforms-python-api)=
## Python API

### Constructor or function

`fm.Translate(geometry, offset, name=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `geometry` | `Geometry` | `required` | $1$ | typed geometry | source geometry | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `base` |
| `offset` | `tuple[float,float,float]` | `required` | $\mathrm{m}$ | finite three-vector | translation offset | FEM/FDM CPU/GPU: IR; resolver-specific | `by` |
| `name` | `str or None` | `None` | $1$ | non-empty when supplied | optional result name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |

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
value = fm.Translate(fm.Box(size=(100e-9, 20e-9, 5e-9)), offset=(10e-9, 0.0, 0.0))
canonical_ir = value.to_ir()
```

In a complete simulation script, pass the translated geometry node directly to `study.geometry(...)`, region selectors, or boolean CSG nodes.

(python-api-geometry-transforms-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind": "translate"`, `"name"`, nested `"base"` geometry IR, and the three-component SI offset vector `"by"`.

(python-api-geometry-transforms-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves nested translation composition and additive offsets in `ProblemIR` independently of `resolved execution`. `Validation errors` reject untyped base geometries and non-finite offsets, while `unsupported combinations` (such as arbitrary rigid rotations where a backend only accepts axis-aligned translations) fail closed downstream.

(python-api-geometry-transforms-discrete-realization)=
## Discrete realization

The Python contract preserves the translation hierarchy as canonical `ProblemIR` only; evaluating transformed bounding boxes, Gmsh BREP translations, or structured FDM voxel placement is performed by the backend meshers.

(python-api-geometry-transforms-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/geometry.py` (`class Translate`). Constructor parameters, validation branches, defaults, and `to_ir()` keys come directly from that module.

(python-api-geometry-transforms-validation)=
## Validation

Focused repository unit tests covering additive center/region translation include `test_region_shape_translation_adds_to_existing_center`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-geometry-transforms-limitations)=
## Limitations and Control Room

Rigid `translation` vectors are edited in Control Room via `ObjectPlacementPanel` (`Model Explorer -> Objects -> <object> -> Placement`) or interactively in the 3D viewport using Ribbon **Move** (`W`), with `scene_revision` rebase reconciliation if a live Python script modifies unrelated objects. Rigid `rotation` and `scale` controls stay disabled in the UI (`PROBLEM_IR_03_RIGID_TRANSFORM_REASON`); `Rotate`, `Scale`, and composite transforms remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| `Translate` (rigid translation offset) | `Model Explorer -> Objects -> <object> -> Placement` (`ObjectPlacementPanel`) / Move `W` | `implemented` | `runAuthoringMutationWithHistory` on `scene_revision` |
| `Rotate`, `Scale`, and nested transform chains | Python DSL | `Python-only` | Disabled in UI (`PROBLEM_IR_03_RIGID_TRANSFORM_REASON`); author in Python |

```{image} /_static/images/ui/inspector-geometry-and-csg.png
:alt: Control Room Geometry Inspector showing the Geometry and Placement tab switcher above Primitive Geometry box dimensions
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/objects-and-materials`.

(python-api-geometry-transforms-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-transforms-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Translate` | public constructor and IR lowering |
