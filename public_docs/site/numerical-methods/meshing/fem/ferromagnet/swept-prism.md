---
title: Swept Prism Mesh
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-swept-prism)=
# Swept Prism Mesh

A swept-prism mesh extrudes a triangular source-face mesh through the film thickness. The strict
reviewed recipe uses P1 prisms, exact layer count, fixed/uniform distribution, triangular source
faces, and a `pyramid_to_tetrahedra` transition to the exterior.

The Control Room capability gate advertises the supported exact layer counts; the reviewed UI scope
accepts 1, 2, or 3 element layers. A request outside the advertised scope is rejected.

The report must certify source/destination faces, sweep direction, node-plane coordinates, prism and
pyramid counts, transition conformity, positive Jacobians, and no silent free-tetrahedral fallback.
