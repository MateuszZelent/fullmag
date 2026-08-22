---
title: Attributes And Interfaces
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-backend-meshing-fem-shared-domain-attributes-and-interfaces)=
# Attributes and interfaces

The solver consumes integer volume and boundary attributes, not UI names or viewport colours.
Required semantic partitions include:

- each magnetic object and material region;
- nonmagnetic air;
- magnetic outer surfaces;
- magnetic-air and material-material interfaces;
- external airbox boundary;
- selector-derived edge, corner, or boundary-layer targets;
- periodic source and destination faces.

A valid interface certificate verifies one conforming trace, expected adjacent region IDs, complete
marker coverage, no duplicate coincident node layer, and no orphan or nonmanifold faces.

Material coefficients, magnetization spaces, scalar-potential spaces, surface terms, and output
reductions select their domains through these attributes. A marker defect therefore changes the
discrete physical problem even when element geometry is visually plausible.
