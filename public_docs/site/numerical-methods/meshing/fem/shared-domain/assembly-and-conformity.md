---
title: FEM Assembly and Conformity
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-shared-domain-assembly-and-conformity)=
# FEM Assembly and Conformity

The preferred build path uses CAD/OCC fragmentation to create one conforming volume complex. Two
adjacent regions share the same geometric face and compatible trace degrees of freedom.

A valid assembly checks:

- positive-volume magnetic and air partitions;
- no overlapping duplicate volumes;
- one shared interface rather than coincident disconnected faces;
- consistent element orientation;
- complete external boundary;
- periodic-face topology where requested.

Concatenating independently meshed STL components can remain executable, but it is a degraded
realization when semantic interfaces or selectors are lost.
