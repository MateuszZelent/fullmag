---
title: Geometry
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-root)=
# Geometry

Geometry objects define the physical domain. Create primitives (`Box`, `Cylinder`, `Ellipsoid`,
`Sphere`, `Ellipse`, `Cone`, `Torus`, `PolygonPrism`, and `fm.shapes.*`), apply translations and
affine/rigid transforms (`Translate`, `Transform`, `RigidTransform`), compose Boolean CSG trees and
modifiers (`Union`, `Difference`, `Intersection`, `Xor`, `SlicePlane`, `Array3D`), import CAD or
mesh assets (`ImportedGeometry`), author waveguides and 3D conductor antenna layouts
(`SinWaveguide`, `ArchWaveguide`, `MicrostripAntennaLayout`, `CPWAntennaLayout`,
`MeanderAntennaLayout`, `InductiveLoopLayout`, `PiecewisePath3DLayout`), attach owner-scoped regions
and selections (`ObjectRegion`, `RegionMaterialOverride`, `RegionTextureOverride`, `Selection`), and
declare the simulation universe and periodic boundary policy (`StudyUniverseConfig`,
`StudyUniverseHandle.mesh`, `FdmPbc`). Geometry is a physics input: the same object lowers to FDM
cells or FEM elements without changing its physical meaning.

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
