---
title: Boundary-Layer API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-boundary-layers)=
# Boundary-Layer API

Boundary layers can be authored with recipe fields or an ordered
`MeshOperation(kind="boundary_layers", params=...)`.

Relevant keys include count, total thickness, stretching, semantic surface/curve selectors, and raw
Gmsh tags. Prefer selectors because numeric tags are not stable across geometry rebuilds.
