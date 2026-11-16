---
title: Geometry
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-root)=
# Geometry

Geometry objects define the physical domain. Create primitives, apply transforms and booleans,
import CAD meshes, select regions, and declare the simulation universe. Geometry is a physics
input: the same object lowers to FDM cells or FEM elements without changing its physical meaning.

```{toctree}
:maxdepth: 1

primitives
transforms
boolean-operations
imported-geometry
regions
universe-and-domain
auxiliary-geometry
```
## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Geometry / Placement` (`GeometryObjectPanel`,
`ObjectPlacementPanel`) for unit-aware primitive shape parameters (`box`, `cylinder`, `sphere`,
`microstrip`, `cpw`, `thin_film`) and rigid translation (`translation`, or interactive **Move** `W` on
the Ribbon). Multi-object region boxes are edited in `ObjectRegionsPanel` / `ObjectRegionGeometryPanel`.
Rigid `rotation` and `scale` remain disabled (`PROBLEM_IR_03_RIGID_TRANSFORM_REASON`), Ribbon CSG
builders remain `preview: true`, and boolean, imported-CAD, auxiliary, or expression-defined shapes
are inspected read-only while authoring remains Python-only (`TODO: frontend support`). See
{doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/objects-and-materials`.

```{image} /_static/images/ui/inspector-geometry-and-csg.png
:alt: Control Room Geometry Inspector showing Primitive Geometry box Size x/y/z inputs in SI metres and the Geometry/Placement tab switcher
:align: center
:width: 100%
```

## API and source scope

This is a navigation index, not an independent constructor contract. Terminal pages own the exact Python example, geometric assumptions, failure semantics, bibliography, and source-code index.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
