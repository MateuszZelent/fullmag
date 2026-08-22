---
title: Swept-Hex Mesh API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-swept-hex)=
# Swept-hex mesh API

The represented request uses `mesh_strategy="swept_hex"`,
`element_family="hex"`, and `sweep_face_meshing="quadrilateral"` together with a complete layered
recipe.

The constructor rejects:

- hex family with `mesh_strategy` other than `swept_hex`;
- hex family with triangular source faces;
- hex family with `pyramid_to_tetrahedra` transition;
- incomplete layered fields.

The current Control Room option is disabled and the reviewed documentation makes no production
execution claim. Treat this page as a representability and validation reference until the backend
capability matrix publishes an executable scope.
