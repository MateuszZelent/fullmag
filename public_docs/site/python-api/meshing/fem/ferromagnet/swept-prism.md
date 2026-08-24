---
title: Swept-Prism API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-swept-prism)=
# Swept-Prism API

The canonical strict helper is:

```text
film.mesh.thin_film(
    minimum_element_size=3e-9,
    maximum_element_size=5e-9,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)
```

The equivalent internal recipe produced by the facade requires `mesh_strategy="swept_prism"`,
`through_thickness_elements`, fixed distribution, triangular source faces, prism family,
`pyramid_to_tetrahedra`, exact layer count, and P1 order. Missing companion fields fail validation.
