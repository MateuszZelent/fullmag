---
title: Free Tetrahedral Mesh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-ferromagnet-free-tetrahedral)=
# Free tetrahedral mesh

Free tetrahedral meshing is the general-purpose FEM route for arbitrary conforming magnetic
geometry. A surface triangulation is generated first, followed by a volume tetrahedralization using
the resolved Gmsh 3D algorithm.

The mode consumes bulk, interface, edge, corner, curvature, narrow-region, transition, smoothing,
and optimizer policies. It can accommodate multiple objects and air regions more generally than a
strict sweep, but does not guarantee a prescribed number of elements through a thin dimension.

Qualification requires:

- positive Jacobian and zero inverted/degenerate element counts;
- preserved material and boundary attributes;
- acceptable lower-tail SICN or gamma/radius quality;
- magnetic volume and geometry convergence;
- sufficient resolution of the shortest magnetic and geometric length scales;
- an observable-based mesh-convergence study.

The actual algorithm and any retry must be recorded. `free_tetrahedral` is a topology request, not a
promise of one specific Gmsh algorithm number.
