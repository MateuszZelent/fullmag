---
title: Swept-Hex API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-meshing-fem-ferromagnet-swept-hex)=
# Swept-Hex API

`PerObjectMeshRecipe` represents `mesh_strategy="swept_hex"` with quadrilateral source faces and
`element_family="hex"`.

The prism-to-pyramid transition is contradictory and rejected. The current Control Room exposes the
option as unsupported; Python representability is not a production qualification.
