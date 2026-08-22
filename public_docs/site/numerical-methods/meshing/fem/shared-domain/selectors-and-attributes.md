---
title: FEM Selectors and Attributes
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-shared-domain-selectors-and-attributes)=
# FEM Selectors and Attributes

Physics is attached to integer region and boundary attributes, not viewport names or colours.

Selectors resolve authored concepts—object surface, interface, edge, corner, periodic source,
periodic destination—into native Gmsh/MFEM tags. The build report records requested selectors,
resolved tags, empty matches, ambiguity, and any fallback.

A selector-dependent size field or boundary condition must fail or be marked ignored/degraded when
its entities cannot be resolved. Applying it to the wrong marker changes the numerical problem.
