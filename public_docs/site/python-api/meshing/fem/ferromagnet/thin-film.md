---
title: Thin-Film Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-thin-film)=
# Thin-film mesh API

The high-level helper is:

```text
magnet.mesh.thin_film(
    minimum_element_size=...,
    maximum_element_size=...,
    layers=...,
    topology="tetrahedral" or "prismatic",
    exact_layers=...,
    transition=...,
    order=...,
)
```

`layers` counts **elements** through thickness; the corresponding number of nodal planes is
`layers + 1`. Tetrahedral topology requests a thickness-aware unstructured route. Prismatic topology
lowers to the strict swept-prism contract and requires P1 order, exact layers, triangular source
faces, fixed distribution, and `pyramid_to_tetrahedra` transition.

One layer is not automatically converged. Compare at least multiple layer counts for quantities that
can vary through thickness.
