---
title: Auxiliary Geometry
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Auxiliary geometry

(public-docs-python-api-geometry-auxiliary-geometry)=
(python-api-geometry-auxiliary-geometry-problem-statement)=
## Problem statement

Waveguide helpers are geometric domain constructors with explicit dimensional validation.

Construction validates typed geometric parameters in Python; calling `to_ir()` lowers each waveguide into its canonical `ProblemIR` geometry descriptor before meshing.

(python-api-geometry-auxiliary-geometry-governing-equations)=
## Governing equations

`SinWaveguide` and `ArchWaveguide` define parametric curved three-dimensional domains $\Omega_m \subset \mathbb{R}^3$ for magnonic waveguide simulations (with sinusoidal height modulation $z(x) = z_0 + A\sin(2\pi x/\lambda + \varphi)$ or smooth arch modulation). Geometry lowering to structured FDM cells or conforming FEM tetrahedra is documented in {doc}`../../physics/geometry-and-materials` and {doc}`../../numerical-methods/meshing/index`.

(python-api-geometry-auxiliary-geometry-symbols-and-si-units)=
## Symbols and SI units

Waveguide `length`, `width`, `height`, `period`, `amplitude`, `z0`, and `arch_height` use SI metres ($\mathrm{m}$); `phase` uses radians ($\mathrm{rad}$); object `name` strings are dimensionless ($1$).

(python-api-geometry-auxiliary-geometry-assumptions-and-validity)=
## Assumptions and validity

`length`, `width`, `height`, and `period` must be finite and strictly positive; `amplitude`, `phase`, `z0`, and `arch_height` must be finite; and `name` must be non-empty. Invalid dimensions fail closed during construction or lowering rather than being silently rescaled.

(python-api-geometry-auxiliary-geometry-python-api)=
## Python API

### Constructor or function

`fm.SinWaveguide(...)` and `fm.ArchWaveguide(...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `length/width/height/period` | `float` | `required` | $\mathrm{m}$ | positive | waveguide dimensions and period | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `parameters` |
| `amplitude` | `float` | `required` | $\mathrm{m}$ | finite | sinusoidal amplitude | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `amplitude` |
| `phase` | `float` | `0.0` | $\mathrm{rad}$ | finite | phase offset | FEM/FDM CPU/GPU: IR; resolver-specific | `phase` |
| `z0` | `float` | `0.0` | $\mathrm{m}$ | finite | vertical offset | FEM/FDM CPU/GPU: IR; resolver-specific | `z0` |
| `arch_height` | `float` | `required` | $\mathrm{m}$ | finite for `ArchWaveguide` | arch height | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | `arch_height` |
| `name` | `str` | `sin_waveguide/arch_waveguide` | $1$ | non-empty | stable name | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |

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
value = fm.SinWaveguide(length=1.0e-6, width=1.0e-7, height=5.0e-8, period=5.0e-7, amplitude=2.0e-8)
canonical_ir = value.to_ir()
```

In a complete simulation script, pass the constructed waveguide geometry directly to `study.geometry(...)`.

(python-api-geometry-auxiliary-geometry-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind": "sin_waveguide"` (or `"arch_waveguide"`), `"name"`, and its validated dimensional fields (`"length"`, `"width"`, `"height"`, `"period"`, `"amplitude"`, `"phase"`, `"z0"` or `"arch_height"`).

(python-api-geometry-auxiliary-geometry-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing parameters, non-finite coordinates, and non-positive lengths or periods, while `unsupported combinations` fail closed at the mesher or backend boundary.

(python-api-geometry-auxiliary-geometry-discrete-realization)=
## Discrete realization

The Python contract supplies geometric parameters and canonical `ProblemIR` only; discrete tetrahedral/voxel mesh generation and boundary evaluation are owned by the FEM/FDM meshing backends documented in {doc}`../../numerical-methods/meshing/index`.

(python-api-geometry-auxiliary-geometry-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/geometry.py` (`class SinWaveguide` and `class ArchWaveguide`). Constructor arguments, validation branches, defaults, and `to_ir()` keys come directly from that module.

(python-api-geometry-auxiliary-geometry-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_waveguide_geometries_export_canonical_ir` and `test_waveguide_geometry_validation_rejects_invalid_dimensions`. Mesh realization and solver convergence require separate backend qualification.

(python-api-geometry-auxiliary-geometry-limitations)=
## Limitations and Control Room

Control Room has no dedicated interactive editor route for `SinWaveguide` or `ArchWaveguide`; author these shapes in Python scripts and inspect the resulting object geometry in active session views. See {doc}`/frontend/capability-register`.

(python-api-geometry-auxiliary-geometry-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-auxiliary-geometry-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/geometry.py` | `class SinWaveguide` | public constructor and IR lowering |
