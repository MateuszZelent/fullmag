---
title: Free Tetrahedral Mesh
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-free-tetrahedral)=
# Free Tetrahedral Mesh

The general-purpose FEM mode fills the object with unstructured tetrahedra.

Primary controls are maximum/minimum element size, surface and volume algorithms, growth,
curvature/narrow-region fields, smoothing, optimizer, order, and local interface/edge/corner
targets. It is the most broadly applicable route for arbitrary conforming CAD but can be inefficient
or poorly conditioned for very thin bodies.

Qualification requires positive Jacobians, lower-tail quality metrics, region/marker completeness,
and observable convergence under controlled refinement.
