---
title: Ferromagnet Meshing API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-root)=
# Ferromagnet meshing API

Object-owned FEM policy is expressed through `object.mesh(...)`,
`object.mesh.thin_film(...)`, or `PerObjectMeshRecipe`.

```{toctree}
:maxdepth: 2

tetrahedral
thin-film
swept-prism
swept-hex
boundary-layers
imported-mesh
refinement
```

## Strategy values

| `mesh_strategy` | Meaning |
|---|---|
| `auto` | planner/build-mode resolution |
| `free_tetrahedral` | general unstructured tetrahedra |
| `thin_film_tetrahedral` | thickness-aware tetrahedra |
| `swept_prism` | strict layered prisms |
| `swept_hex` | represented hexahedral sweep, capability-gated |

A layered request is complete only when layer count, distribution, source-face family, sweep
direction, element family, transition policy, and exact-layer flag are all defined.
