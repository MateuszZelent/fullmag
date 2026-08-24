---
title: Free-Tetrahedral API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-free-tetrahedral)=
# Free-Tetrahedral API

Ordinary object meshing uses the free-tetrahedral strategy unless a more specific route is requested.

```text
film.mesh(
    minimum_element_size=2.5e-9,
    maximum_element_size=5e-9,
    order=1,
    compute_quality=True,
)
```

The public `body.mesh(...)` facade may set `mesh_strategy="free_tetrahedral"`, Gmsh algorithms,
curvature and narrow-region controls, smoothing, optimizer, boundary layers, and size fields.
`PerObjectMeshRecipe` is the internal lowering carrier and is not available as
`fm.PerObjectMeshRecipe`.
