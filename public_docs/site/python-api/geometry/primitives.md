---
title: Primitives
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Geometry primitives

(public-docs-python-api-geometry-primitives)=
(python-api-geometry-primitives-problem-statement)=
## Problem statement

Primitive constructors normalize their typed geometric representation before mesh generation.
FullMag exposes both direct primitive classes (`fm.Box`, `fm.Cylinder`, `fm.Ellipsoid`, `fm.Sphere`,
`fm.Ellipse`, `fm.Cone`, `fm.Torus`, `fm.PolygonPrism`) and ergonomic centered factories under
`fm.shapes.*`.

This page covers the Python authoring contract: construction validates positive dimensions, polygon
vertex lists, and finite axis vectors in Python, while `to_ir()` emits the canonical `ProblemIR`
record before mesh generation.

(python-api-geometry-primitives-governing-equations)=
## Governing equations

Each primitive defines a bounded three-dimensional region $\Omega_k \subset \mathbb{R}^3$
parameterized by its Cartesian extents, principal radii, toroidal radii, frustum/cone radii, or
extruded 2D polygon cross-section in metres ($\mathrm{m}$) and, for oriented solids (`Cylinder`,
`Cone`, `Torus`), a normalized unit axis vector $\hat{\mathbf{a}} \in \mathbb{S}^2$. Domain
conventions and CAD/mesh realization semantics are documented in
{doc}`../../physics/geometry-and-materials` and {doc}`../../numerical-methods/meshing/index`.

(python-api-geometry-primitives-symbols-and-si-units)=
## Symbols and SI units

Linear dimensions (`Box.size`, `Cylinder` radius/height, `Ellipsoid` principal radii, `Sphere`
radius, `Ellipse` semi-axes/height, `Cone` `radius_bottom`/`radius_top`/`height`, `Torus`
`major_radius`/`minor_radius`, and `PolygonPrism` `vertices_xy`/`thickness`) use SI metres
($\mathrm{m}$). Orientation vectors (`axis`) and identifiers (`name`) are dimensionless ($1$).

(python-api-geometry-primitives-assumptions-and-validity)=
## Assumptions and validity

All positive geometric extents must be finite and strictly positive; `Cone` requires at least one of
`radius_bottom` or `radius_top` positive (allowing pointed cones with `radius_top=0.0` or frustums);
`Torus` requires `major_radius > minor_radius > 0`; `PolygonPrism` requires at least three finite 2D
vertices and positive `thickness`; oriented solids require a finite non-zero three-vector `axis`;
and `name` must be a non-empty string. Zero or negative dimensions, non-finite coordinates, or
contradictory size arguments fail closed during construction or lowering.

(python-api-geometry-primitives-python-api)=
## Python API

### Constructors and `fm.shapes.*` factories

- **Direct primitive classes**: `fm.Box`, `fm.Cylinder`, `fm.Ellipsoid`, `fm.Sphere`, `fm.Ellipse`,
  `fm.Cone`, `fm.Torus`, `fm.PolygonPrism`.
- **Ergonomic `fm.shapes.*` factories** (`packages/fullmag-py/src/fullmag/shapes.py`):
  `fm.shapes.box(size, *, center=None, name="box")`,
  `fm.shapes.cylinder(*, radius, height, center=None, name="cylinder")`,
  `fm.shapes.disk(*, radius, thickness=None, center=(0,0,0), normal=(0,0,1), extrusion="finite", object_id=None)` (selection disk/cylinder),
  `fm.shapes.sphere(*, radius, center=None, name="sphere")`,
  `fm.shapes.ellipsoid(*, rx, ry, rz, center=None, name="ellipsoid")`,
  `fm.shapes.ellipse(*, rx, ry, height, center=None, name="ellipse")`,
  `fm.shapes.cone(*, radius_bottom, radius_top=0.0, height, axis=(0,0,1), center=None, name="cone")`,
  `fm.shapes.torus(*, major_radius, minor_radius, axis=(0,0,1), center=None, name="torus")`,
  `fm.shapes.polygon_prism(*, vertices_xy, thickness, center=None, name="polygon_prism")`,
  `fm.shapes.imported(...)`, `fm.shapes.sin_waveguide(...)`, and `fm.shapes.arch_waveguide(...)`.
  When `center` is non-zero, `fm.shapes.*` wraps the primitive in `fm.Translate(...)`.

### Primitive catalog parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `Cylinder(radius, height, name="cylinder", *, axis=(0,0,1))` | `float`, `float`, `tuple[float,float,float]` | `axis=(0,0,1)` | $\mathrm{m}$, $1$ | positive `radius`/`height`; finite non-zero `axis` | right circular cylinder | FEM/FDM CPU/GPU: IR; resolver-specific | `kind="cylinder"`, `radius`, `height`, `axis` |
| `Ellipsoid(rx, ry, rz, name="ellipsoid")` | `float` | `required` | $\mathrm{m}$ | positive principal radii | triaxial ellipsoid | FEM/FDM CPU/GPU: IR; resolver-specific | `kind="ellipsoid"`, `radii` |
| `Sphere(radius, name="sphere")` | `float` | `required` | $\mathrm{m}$ | positive radius; returns equal-radii `Ellipsoid` | sphere primitive | FEM/FDM CPU/GPU: IR; resolver-specific | `kind="ellipsoid"`, `radii=[r, r, r]` |
| `Ellipse(rx, ry, height, name="ellipse")` | `float` | `required` | $\mathrm{m}$ | positive semi-axes and height | extruded elliptical cylinder | FEM/FDM CPU/GPU: IR; resolver-specific | `kind="ellipse"`, `radii`, `height` |
| `Cone(radius_bottom, radius_top, height, axis=(0,0,1), name="cone")` | `float`, `float`, `float`, `tuple[float,float,float]` | `axis=(0,0,1)`, `name="cone"` | $\mathrm{m}$, $1$ | non-negative radii (not both zero), positive `height`, non-zero `axis` | circular cone or frustum | FEM/FDM CPU/GPU: IR; resolver-specific | `kind="cone"`, `radius_bottom`, `radius_top`, `height`, `axis` |
| `Torus(major_radius, minor_radius, axis=(0,0,1), name="torus")` | `float`, `float`, `tuple[float,float,float]` | `axis=(0,0,1)`, `name="torus"` | $\mathrm{m}$, $1$ | `major_radius > minor_radius > 0`, non-zero `axis` | toroidal ring solid | FEM/FDM CPU/GPU: IR; resolver-specific | `kind="torus"`, `major_radius`, `minor_radius`, `axis` |
| `PolygonPrism(vertices_xy, thickness, name="polygon_prism")` | `Sequence[Sequence[float]]`, `float` | `name="polygon_prism"` | $\mathrm{m}$, $1$ | `>= 3` finite 2D vertices, positive `thickness` | extruded polygonal prism along $z$ | FEM/FDM CPU/GPU: IR; resolver-specific | `kind="polygon_prism"`, `vertices_xy`, `thickness` |

### Stage-first example

```python
# %% Stage-first authoring with Box, Cone, Torus, PolygonPrism, and fm.shapes.*
import fullmag as fm

nm = 1.0e-9

study = fm.study("primitives_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=5 * nm)

film = study.geometry(fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)

# Construct and verify IR for additional primitives and fm.shapes helpers:
cone = fm.shapes.cone(radius_bottom=25 * nm, radius_top=10 * nm, height=30 * nm, name="pillar")
ring = fm.shapes.torus(major_radius=40 * nm, minor_radius=8 * nm, name="ring")
triangle = fm.shapes.polygon_prism(
    vertices_xy=[(-20 * nm, -10 * nm), (20 * nm, -10 * nm), (0.0, 20 * nm)],
    thickness=5 * nm,
    name="wedge",
)
assert cone.to_ir()["kind"] == "cone"
assert ring.to_ir()["kind"] == "torus"
assert triangle.to_ir()["kind"] == "polygon_prism"
```

In a complete simulation script, pass any constructed primitive directly to `study.geometry(...)` or
compose it with `fm.Transform`, Boolean CSG operators, `SlicePlane`, `Array3D`, or `ObjectRegion`.

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

`value.to_ir()` emits a typed dictionary with `"kind"` (`"box"`, `"cylinder"`, `"ellipsoid"`,
`"ellipse"`, `"cone"`, `"torus"`, or `"polygon_prism"`), `"name"`, and primitive dimension keys
(for `Box`, `"size"` as a three-element SI list; `Sphere` serializes as an equal-radii
`"ellipsoid"`).

(python-api-geometry-primitives-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves primitive kind, dimensions, normalized axes, vertex lists, and
identifiers in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid
types, missing arguments, non-finite values, non-positive extents, degenerate polygons, and
contradictory `Box` size forms, while `unsupported combinations` fail closed in downstream meshers.

(python-api-geometry-primitives-discrete-realization)=
## Discrete realization

| Solver | Device | Primitive discretization | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Evaluates analytic inside/outside predicates at cell centres to build active-cell masks | Staircase boundary convergence remains problem-dependent |
| FDM | GPU | Consumes the planner-materialized active-cell mask on CUDA | GPU solver parity validated separately |
| FEM | CPU | Builds exact OpenCASCADE/Gmsh B-Rep solids for tetrahedral/swept meshing | Mesh quality and element sizing validated per study |
| FEM | GPU | Consumes the host-built conforming FEM mesh uploaded to CUDA | Executed-device GPU qualification remains separate |

(python-api-geometry-primitives-implementation-mapping)=
## Implementation mapping

The authoritative implementations are `packages/fullmag-py/src/fullmag/model/geometry.py`
(`class Box`, `Cylinder`, `Ellipsoid`, `Sphere`, `Ellipse`, `Cone`, `Torus`, `PolygonPrism`) and
`packages/fullmag-py/src/fullmag/shapes.py` (`fm.shapes.*` convenience factories).

(python-api-geometry-primitives-validation)=
## Validation

Focused repository unit tests covering primitive IR export and validation include
`test_waveguide_geometries_export_canonical_ir` and geometry primitive contract tests. Live solver
runtime and Control Room browser behavior require separate qualification.

(python-api-geometry-primitives-limitations)=
## Limitations and Control Room

Control Room's geometry inspector (`ObjectGeometrySpec` in
`apps/control-room/src/modules/inspector/inspectors/objects/geometry/ObjectGeometrySpec.tsx`)
authors and edits **9 parametric shapes** (`Box`, `Cylinder`, `Ellipsoid`, `Sphere`, `Tube`,
`Cone`, `Torus`, `ArchWaveguide`, `PolygonExtrusion`) plus **Import STL** (`ImportedMesh`) using
unit-aware SI inputs (`m`, `mm`, `um`, `nm`). Parametric helpers without matching UI forms (such as
`SinWaveguide` or scripted `fm.shapes.disk` selection geometries) remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| 9 parametric shapes (`Box`, `Cylinder`, `Ellipsoid`, `Sphere`, `Tube`, `Cone`, `Torus`, `ArchWaveguide`, `PolygonExtrusion`) + Import STL | `Model Explorer -> Objects -> <object> -> Geometry` (`ObjectGeometrySpec`) | `implemented` | `applyGeometryDraftMutation` on `scene_revision` (invalidates stale mesh) |
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
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2035) | [`class Box`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2035) | public primitive constructors (`Box`, `Cylinder`, `Ellipsoid`, `Cone`, `Torus`, `PolygonPrism`) and IR lowering |
| [`packages/fullmag-py/src/fullmag/shapes.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/shapes.py#L42) | `box`, `cone`, `torus`, `polygon_prism`, `disk` | centered `fm.shapes.*` convenience factories |
