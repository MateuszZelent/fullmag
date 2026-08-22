---
title: Swept Prism Mesh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-ferromagnet-swept-prism)=
# Swept prism mesh

A swept-prism mesh extrudes a triangular source-face mesh through the film thickness. The reviewed
strict route uses linear prisms in the magnetic body and pyramids to connect the prism interface to
a tetrahedral exterior.

A qualified realization proves:

- source and destination faces and resolved sweep direction;
- exact requested element-layer count and resulting node planes;
- strictly increasing layer coordinates within tolerance;
- `prism6`, `pyramid5`, and `tet4` family counts by role;
- complete interface and outer-boundary marker coverage;
- zero nonconforming, orphan, coincident, and nonmanifold interface faces;
- positive Jacobian and family-specific scaled-Jacobian statistics;
- deterministic topology fingerprint and mesher inputs.

The Control Room production gate currently advertises exact one-, two-, or three-element layers only
when all mixed-P1 capabilities are executable. A request outside the advertised scope is rejected;
strict prism intent must not become free tetrahedral silently.
