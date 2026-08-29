---
title: Primitives
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-primitives)=
# Primitives

(python-api-geometry-primitives-problem-statement)=
<!-- (problem-statement)= -->
## Contract

This page records the complete public geometry-primitive surface. Primitives define the physical
objects; each one lowers to a canonical `geometry.entries[]` shape, independent of whether the
planner later selects FDM cells or FEM elements.

(python-api-geometry-primitives-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations

A primitive is pure geometry and introduces no physical equation. Boolean composition and spatial
transforms are documented in {doc}`boolean-operations` and {doc}`transforms`; imported CAD/mesh
geometry is documented in {doc}`imported-geometry`.

(python-api-geometry-primitives-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units

All lengths, radii, semi-axes, heights, periods, amplitudes, and offsets are in metres; the
cylinder axis and shape directions are unit vectors ($1$); `phase_rad` is not used by these
primitives (sinusoid phase is dimensionless).

(python-api-geometry-primitives-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity

Every primitive validates positive lengths/radii and a non-empty `name` immediately. The cylinder
axis is normalized to a unit vector; a malformed axis fails authoring rather than being silently
re-normalized.

(python-api-geometry-primitives-python-api)=
<!-- (python-api)= -->
## Python API

### Primitive inventory

| Primitive | Class | `fm.shapes` helper | Shape | ProblemIR `kind` |
|---|---|---|---|---|
| Box | `fm.Box` | `fm.shapes.box` | Axis-aligned cuboid centred at the origin | `box` |
| Cylinder | `fm.Cylinder` | `fm.shapes.cylinder` | Circular cylinder centred at the origin | `cylinder` |
| Sphere | `fm.Sphere` | `fm.shapes.sphere` | Sphere (a uniform ellipsoid) | `ellipsoid` |
| Ellipsoid | `fm.Ellipsoid` | `fm.shapes.ellipsoid` | Tri-axial ellipsoid centred at the origin | `ellipsoid` |
| Ellipse | `fm.Ellipse` | `fm.shapes.ellipse` | Elliptical disk with its axis along $z$ | `ellipse` |
| SinWaveguide | `fm.SinWaveguide` | `fm.shapes.sin_waveguide` | Sinusoid waveguide | `sin_waveguide` |
| ArchWaveguide | `fm.ArchWaveguide` | `fm.shapes.arch_waveguide` | Arched waveguide | `arch_waveguide` |
| Imported geometry | `fm.ImportedGeometry` | `fm.shapes.imported` | Imported CAD/mesh volume | `imported_geometry` |

### Box

`fm.Box` accepts both the keyword and the three-scalar positional form.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Box.size_or_x` | `three floats, scalar, or `None`` | `None` | $\mathrm{m}$ | Positional size input; when size= is supplied, the implementation uses size and ignores positional size values. | Positional size input; when size= is supplied, the implementation uses size and ignores positional size values. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].shape.size` |
| `Box.y` | `float \| None` | `None` | $\mathrm{m}$ | Positional $L_y$ when scalar `size_or_x` is used. | Positional $L_y$ when scalar `size_or_x` is used. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].shape.size` |
| `Box.z` | `float \| None` | `None` | $\mathrm{m}$ | Positional $L_z$ when scalar `size_or_x` is used. | Positional $L_z$ when scalar `size_or_x` is used. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].shape.size` |
| `Box.size` | `three positive floats` | `required in keyword form` | $\mathrm{m}$ | Keyword size; when supplied, it takes precedence and positional size values are ignored. | Keyword size; when supplied, it takes precedence and positional size values are ignored. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].shape.size` |
| `Box.name` | `str` | `"box"` | $1$ | Non-empty geometry identity. | Non-empty geometry identity. | FEM/FDM CPU/GPU; planner checks combinations | `geometry.entries[].name` |

### Cylinder

| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `Cylinder.radius` | `float` | `required` | $\mathrm{m}$ | Positive | Cylinder radius | `radius` |
| `Cylinder.height` | `float` | `required` | $\mathrm{m}$ | Positive | Cylinder height | `height` |
| `Cylinder.axis` | `tuple[float, float, float]` | `(0, 0, 1)` | $1$ | Non-zero, normalized to a unit vector | Cylinder axis | `axis` |
| `Cylinder.name` | `str` | `"cylinder"` | $1$ | Non-empty | Geometry identity | `name` |

### Sphere and ellipsoid

`fm.Sphere(radius, name=...)` is a convenience constructor returning
`Ellipsoid(rx=radius, ry=radius, rz=radius, name=...)`.

| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `Ellipsoid.rx` | `float` | `required` | $\mathrm{m}$ | Positive | Semi-axis along $x$ | `radii[0]` |
| `Ellipsoid.ry` | `float` | `required` | $\mathrm{m}$ | Positive | Semi-axis along $y$ | `radii[1]` |
| `Ellipsoid.rz` | `float` | `required` | $\mathrm{m}$ | Positive | Semi-axis along $z$ | `radii[2]` |
| `Ellipsoid.name` | `str` | `"ellipsoid"` | $1$ | Non-empty | Geometry identity | `name` |
| `Sphere.radius` | `float` | `required` | $\mathrm{m}$ | Positive | Sphere radius | expands to equal radii |

### Ellipse

| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `Ellipse.rx` | `float` | `required` | $\mathrm{m}$ | Positive | Semi-axis along $x$ | `rx` |
| `Ellipse.ry` | `float` | `required` | $\mathrm{m}$ | Positive | Semi-axis along $y$ | `ry` |
| `Ellipse.height` | `float` | `required` | $\mathrm{m}$ | Positive | Disk thickness along $z$ | `height` |
| `Ellipse.name` | `str` | `"ellipse"` | $1$ | Non-empty | Geometry identity | `name` |

### SinWaveguide

| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `SinWaveguide.length` | `float` | `required` | $\mathrm{m}$ | Positive | Waveguide length | `length` |
| `SinWaveguide.width` | `float` | `required` | $\mathrm{m}$ | Positive | Waveguide width | `width` |
| `SinWaveguide.height` | `float` | `required` | $\mathrm{m}$ | Positive | Waveguide thickness | `height` |
| `SinWaveguide.period` | `float` | `required` | $\mathrm{m}$ | Positive | Sinusoid period | `period` |
| `SinWaveguide.amplitude` | `float` | `required` | $\mathrm{m}$ | Finite | Sinusoid amplitude | `amplitude` |
| `SinWaveguide.phase` | `float` | `0.0` | $1$ | Finite | Sinusoid phase | `phase` |
| `SinWaveguide.z0` | `float` | `0.0` | $\mathrm{m}$ | Finite | Base height | `z0` |
| `SinWaveguide.name` | `str` | `"sin_waveguide"` | $1$ | Non-empty | Geometry identity | `name` |

### ArchWaveguide

| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `ArchWaveguide.length` | `float` | `required` | $\mathrm{m}$ | Positive | Waveguide length | `length` |
| `ArchWaveguide.width` | `float` | `required` | $\mathrm{m}$ | Positive | Waveguide width | `width` |
| `ArchWaveguide.height` | `float` | `required` | $\mathrm{m}$ | Positive | Waveguide thickness | `height` |
| `ArchWaveguide.arch_height` | `float` | `required` | $\mathrm{m}$ | Finite | Arch elevation | `arch_height` |
| `ArchWaveguide.z0` | `float` | `0.0` | $\mathrm{m}$ | Finite | Base height | `z0` |
| `ArchWaveguide.name` | `str` | `"arch_waveguide"` | $1$ | Non-empty | Geometry identity | `name` |

### Shape helpers with explicit centre

The `fm.shapes.*` helpers mirror the classes and add a `center=` convenience that emits a
translation when the centre is non-zero; all geometric arguments use the keyword form.

| Helper | Signature | Meaning |
|---|---|---|
| `fm.shapes.box` | `(size, *, center=None, name="box")` | Axis-aligned box |
| `fm.shapes.cylinder` | `(*, radius, height, center=None, name="cylinder")` | Cylinder |
| `fm.shapes.sphere` | `(*, radius, center=None, name="sphere")` | Sphere |
| `fm.shapes.ellipsoid` | `(*, rx, ry, rz, center=None, name="ellipsoid")` | Ellipsoid |
| `fm.shapes.ellipse` | `(*, rx, ry, height, center=None, name="ellipse")` | Elliptical disk |
| `fm.shapes.arch_waveguide` | `(*, length, width, height, arch_height, center=None, z0=0.0, name=...)` | Arched waveguide |
| `fm.shapes.sin_waveguide` | `(*, length, width, height, period, amplitude, center=None, phase=0.0, z0=0.0, name=...)` | Sinusoid waveguide |
| `fm.shapes.imported` | `(source, *, center=None, name=None, scale=1.0, units=None, volume="full")` | Imported geometry |

### Complete stage-first example

```python
# %% Box with a cylindrical hole, built from primitives and CSG
import fullmag as fm

nm = 1.0e-9
study = fm.study("primitives_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))

body = fm.Box(size=(100 * nm, 40 * nm, 20 * nm)) - fm.Cylinder(radius=15 * nm, height=20 * nm)
film = study.geometry(body, name="perforated_box")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=500, tolT=1e-8)
```

Additional primitives follow the same stage-first pattern:

```python
# %% Ellipsoid and a quadratic-centred sphere helper
import fullmag as fm

nm = 1.0e-9
study = fm.study("primitives_more")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))

body = fm.Ellipsoid(60 * nm, 40 * nm, 20 * nm, name="crystal")
crystal = study.geometry(body, name="crystal")
crystal.Ms = 800.0e3
crystal.Aex = 13.0e-12
crystal.alpha = 0.02
crystal.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

sphere = fm.shapes.sphere(radius=25 * nm, center=(10 * nm, 0.0, 0.0))
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=500, tolT=1e-8)
```

(python-api-geometry-primitives-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR

Each primitive emits its `kind` plus its defining geometric fields under `geometry.entries[]`.
`Ellipsoid` and `Sphere` share the `ellipsoid` kind whose `radii` list carries the three
semi-axes. The final column of each table gives the serialized destination.

(python-api-geometry-primitives-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent is preserved in Python and IR; resolved execution is selected by the planner.
Validation errors reject non-positive lengths or radii, a zero cylinder axis, and empty names.
Unsupported combinations fail capability checks without silent fallback.

(python-api-geometry-primitives-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization

FDM voxelizes primitives onto Cartesian cells; FEM meshes them with the selected meshing policy.
The same primitive lowers to either representation.

(python-api-geometry-primitives-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping

The adjacent map anchors the canonical owner to `packages/fullmag-py/src/fullmag/model/geometry.py`
(`class Box` and its sibling primitive classes); helper constructors live in
`packages/fullmag-py/src/fullmag/shapes.py`.

(python-api-geometry-primitives-validation)=
<!-- (validation)= -->
## Validation

Ownership tests compare this inventory with live signatures and validate the adjacent source map.

(python-api-geometry-primitives-limitations)=
<!-- (limitations)= -->
## Limitations

Representability does not prove every backend combination executable; planner capabilities are
authoritative.

(python-api-geometry-primitives-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography

No physical model is introduced; primary references belong to consuming interaction pages.

(python-api-geometry-primitives-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Basic object/shape fields are partial; advanced boolean, imported, auxiliary, and transform parameters remain TODO.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Geometry` | `partial` | Apply geometry draft; object resources become stale |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Geometry` | `TODO` | Python-only until implemented |

frontend support is not implemented for every geometry parameter not rendered by GeometryObjectPanel.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx (GeometryObjectPanel)`.

## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Box primitive | `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Box` | Canonical Python API behavior | Ownership test and source-map validator |
| Cylinder primitive | `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Cylinder` | Cylinder validation and lowering | Ownership test |
| Sphere/ellipsoid primitives | `packages/fullmag-py/src/fullmag/model/geometry.py` | `Sphere`, `class Ellipsoid` | Sphere/ellipsoid validation and lowering | Ownership test |
| Ellipse primitive | `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Ellipse` | Ellipse validation and lowering | Ownership test |
| Waveguide primitives | `packages/fullmag-py/src/fullmag/model/geometry.py` | `class SinWaveguide`, `class ArchWaveguide` | Waveguide validation and lowering | Ownership test |
| Centre-aware helpers | `packages/fullmag-py/src/fullmag/shapes.py` | `box`, `cylinder`, `sphere`, `ellipsoid`, `ellipse`, `arch_waveguide`, `sin_waveguide`, `imported` | Helper constructors | Ownership test |
