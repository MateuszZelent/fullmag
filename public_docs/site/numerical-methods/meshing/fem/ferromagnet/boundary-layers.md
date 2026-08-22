---
title: FEM Boundary Layers
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-boundary-layers)=
# FEM Boundary Layers

Boundary-layer operations extrude graded layers from selected surfaces or curves.

Controls include target selectors/tags, layer count, total thickness, stretching ratio, and
operation order. Raw Gmsh tags are fragile across geometry rebuilds; semantic selectors are
preferred.

Boundary layers can conflict with swept topology, sharp corners, Boolean fragmentation, and airbox
transitions. The build report must state whether the operation was applied, ignored, degraded, or
rejected.
