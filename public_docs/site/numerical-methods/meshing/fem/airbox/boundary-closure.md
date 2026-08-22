---
title: Airbox Boundary Closure
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-airbox-boundary-closure)=
# Airbox Boundary Closure

The mesh supplies the selected outer boundary marker; the demagnetization operator supplies
Dirichlet, Robin, or gauge/nullspace semantics.

These responsibilities must not be conflated. A correct mesh with the wrong marker selection applies
the closure to the wrong surface; a correct marker with an incompatible gauge yields an ill-posed or
incorrect algebraic problem.

Provenance records the marker, covered area/facets, closure kind, Robin coefficient and units,
gauge/nullspace policy, and Poisson solver diagnostics.
