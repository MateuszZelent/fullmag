---
title: Ferromagnet Refinement
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-ferromagnet-refinement)=
# Ferromagnet refinement

Object refinement combines multiple size fields through the smallest active target, followed by
mesher growth and conformity constraints.

Supported policy dimensions include:

- bulk `hmin` and `hmax`;
- interface target, band thickness, transition distance, and growth;
- edge target, edge band, and transition;
- corner target, extent, and transition;
- curvature and narrow-region sizing;
- manual box and object-core relaxation fields;
- ordered `refine`, `adapt`, and generic `size_field` operations where implemented.

The build report records each field's source, target, native field ID, and status: applied, ignored,
degraded, or rejected. Losing CAD component tags can invalidate selector-based fields even when a
volume mesh is generated.

Mesh convergence is observable-specific. Refining only the magnetic body does not establish airbox,
time-step, linear-solver, geometry-order, or layer convergence.
