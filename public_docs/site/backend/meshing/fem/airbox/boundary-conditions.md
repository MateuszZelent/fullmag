---
title: Airbox Boundary Markers And Closure
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-airbox-boundary-conditions)=
# Airbox boundary markers and closure

The mesh provides boundary attributes; the consuming magnetostatic operator assigns Dirichlet,
Robin, periodic, or Floquet semantics.

A valid boundary tuple records:

- external marker IDs and covered area;
- separation from magnetic surfaces and internal interfaces;
- closure kind;
- Robin coefficient and unit, where applicable;
- gauge or nullspace policy;
- periodic or Floquet pair identity and phase convention;
- operator and mesh digests.

Marker collision, empty coverage, or applying an open closure to a periodic mesh is a hard error.
The mesh page does not redefine the Poisson weak form; it establishes the geometric boundary on
which that form acts.
