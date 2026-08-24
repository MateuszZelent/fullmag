---
title: Boundary-Layer API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-boundary-layers)=
# Boundary-Layer API

Public scripts author boundary layers through `body.mesh(boundary_layer_count=...,
boundary_layer_thickness=..., boundary_layer_stretching=..., ...)`. The lowering carrier can also
hold an ordered `MeshOperation(kind="boundary_layers", params=...)`, but `MeshOperation` is not
exported from the top-level `fullmag` namespace.

Relevant facade keys include count, total thickness, positive stretching, semantic surface/curve
selectors, and raw Gmsh tags. No upper stretching bound of 2 is enforced by the Python facade.
Prefer selectors because numeric tags are not stable across geometry rebuilds.
