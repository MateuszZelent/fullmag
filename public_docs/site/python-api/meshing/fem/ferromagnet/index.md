---
title: FEM Ferromagnet Mesh API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-root)=
# FEM Ferromagnet Mesh API

Ferromagnet mesh commands are object-owned.

Use ordinary `object.mesh(...)` for unstructured policies and
`object.mesh.thin_film(...)` for explicit thin-film topology. `PerObjectMeshRecipe` is the internal
lowering carrier and is not exported as a top-level `fullmag` constructor.

Every mode below has its own command, required companion fields, and capability boundary.

```{toctree}
:maxdepth: 2

../../../discretization/per-object-meshing
free-tetrahedral
thin-film-tetrahedral
swept-prism
swept-hex
boundary-layers
imported-mesh
```
