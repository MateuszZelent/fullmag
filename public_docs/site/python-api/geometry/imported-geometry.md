---
title: Imported Geometry
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Imported geometry

(public-docs-python-api-geometry-imported-geometry)=
(python-api-geometry-imported-geometry-problem-statement)=
## Problem statement

Imported geometry records the source and volume policy; conversion is a later resolver step.

Construction validates source asset identifiers, scale factors, and import options in Python; calling `to_ir()` emits the canonical `ProblemIR` record before mesh import or discretization.

(python-api-geometry-imported-geometry-governing-equations)=
## Governing equations

`ImportedGeometry` maps an external CAD or boundary-representation asset (`STEP`, `IGES`, `BREP`, or `STL`) onto physical SI coordinates $\mathbf{x}_{\mathrm{SI}} = s \cdot \mathbf{x}_{\mathrm{src}}$ via the dimensionless scale factor `scale` (and optional `units` tag) to form the domain $\Omega_m \subset \mathbb{R}^3$. Coordinate normalization and mesh import semantics are documented in {doc}`../../physics/geometry-and-materials` and {doc}`../../numerical-methods/meshing/fem/ferromagnet/imported-mesh`.

(python-api-geometry-imported-geometry-symbols-and-si-units)=
## Symbols and SI units

After applying `scale` and `units`, realized physical coordinates and domain extents use SI metres ($\mathrm{m}$). The parameters `source`, `scale`, `units`, `name`, and `volume` are dimensionless descriptors ($1$).

(python-api-geometry-imported-geometry-assumptions-and-validity)=
## Assumptions and validity

`source` must be non-empty, `scale` must be strictly positive (scalar or three-component vector), and `volume` currently accepts `"full"`. Unrecognized file formats, non-positive scales, or unsupported surface-only import modes fail closed during construction, lowering, or meshing.

(python-api-geometry-imported-geometry-python-api)=
## Python API

### Constructor or function

`fm.ImportedGeometry(source, scale=1.0, units=None, name=None, volume="full")`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `source` | `str or PathLike` | `required` | $1$ | non-empty | source asset path or identifier | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `source` |
| `scale` | `float or tuple[float,float,float]` | `1.0` | $1$ | positive scalar/vector | import scale | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `scale` |
| `units` | `str or None` | `None` | $1$ | recognized unit when supplied | source units | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `units` |
| `name` | `str or None` | `None` | $1$ | non-empty when supplied | stable name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `volume` | `str` | `full` | $1$ | current supported value `full` | surface/volume import policy | FEM/FDM CPU/GPU: IR; resolver-specific | `volume` |

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
value = fm.ImportedGeometry("mesh.step", scale=1.0e-9, units="nm", volume="full")
canonical_ir = value.to_ir()
```

In a complete simulation script, pass the constructed `ImportedGeometry` object to `study.geometry(...)`.

(python-api-geometry-imported-geometry-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind": "imported_geometry"`, `"name"`, `"source"`, `"format"` (inferred from the extension), and combined `"scale"`.

(python-api-geometry-imported-geometry-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the external asset path, format, and unit scaling in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, empty paths, non-positive scales, and unrecognized `units` or `volume` modes, while `unsupported combinations` fail closed at the mesher or backend boundary.

(python-api-geometry-imported-geometry-discrete-realization)=
## Discrete realization

The Python contract supplies asset metadata and canonical `ProblemIR` only; CAD tessellation, surface-to-volume healing, and FEM mesh extraction are owned by the meshing backends documented in {doc}`../../numerical-methods/meshing/fem/ferromagnet/imported-mesh`.

(python-api-geometry-imported-geometry-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/geometry.py` (`class ImportedGeometry`). Constructor parameters, validation branches, defaults, and `to_ir()` keys come directly from that module.

(python-api-geometry-imported-geometry-validation)=
## Validation

Focused repository unit tests covering authoring and IR round-tripping include `test_script_rewrite_preserves_imported_geometry_surface_volume`. Native CAD import and solver convergence require separate backend qualification.

(python-api-geometry-imported-geometry-limitations)=
## Limitations and Control Room

Control Room has no dedicated interactive editor route for `ImportedGeometry`; author external geometry imports in Python scripts and inspect the realized geometry in active session views. See {doc}`/frontend/capability-register`.

(python-api-geometry-imported-geometry-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-imported-geometry-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/geometry.py` | `class ImportedGeometry` | public constructor and IR lowering |
