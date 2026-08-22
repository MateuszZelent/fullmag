---
title: Swept Hexahedral Mesh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-ferromagnet-swept-hex)=
# Swept hexahedral mesh

The Python schema can represent a quadrilateral source-face sweep producing hexahedra, but schema
representability is not a production-execution claim.

A legal request requires `mesh_strategy="swept_hex"`, quadrilateral source-face meshing, an explicit
sweep direction or resolved sweepable geometry, and a transition policy compatible with the final
shared domain. The prism-specific `pyramid_to_tetrahedra` transition is contradictory for the
current hex request schema.

The reviewed Control Room capability gate keeps swept hex disabled. Backend documentation therefore
classifies this mode as represented and capability-gated. A future executable claim must identify:

- supported geometry classes and layer distributions;
- conformity with neighbouring air or other objects;
- high-order and device-kernel coverage;
- Jacobian/warpage/skewness gates;
- CPU/GPU operator support for every realized family;
- validation and regression evidence.
