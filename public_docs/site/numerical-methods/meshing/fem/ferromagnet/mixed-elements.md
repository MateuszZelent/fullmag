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

The current executable mixed-prism slice is deliberately bounded: strict P1, double precision,
one axis-aligned magnetic box in one airbox, exactly 1, 2, or 3 swept layers, prism6 magnetic
cells, pyramid5 transition cells, and tet4 far-air cells. Explicit FEM CPU and FEM GPU lanes are
implemented for that slice, but this is not universal production qualification. `auto`, `single`,
extended fallback, broader geometry, or unsupported interactions must fail closed.
