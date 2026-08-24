---
title: Mixed Prism–Pyramid–Tetrahedron Mesh
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-mixed-elements)=
# Mixed Prism–Pyramid–Tetrahedron Mesh

The bounded mixed-element route connects a layered prismatic magnetic film to a tetrahedral exterior
through pyramids.

Its certificate records requested/resolved layer count and axis, exact node planes, family counts,
marker coverage, magnetic/air/shared volumes, interface conformity, Jacobian and scaled-Jacobian
statistics, deterministic inputs, fallback history, and a topology fingerprint.

A valid CPU mesh does not prove GPU support. Every realized family (`prism6`, `pyramid5`, `tet4`)
must be supported by every enabled device operator.
