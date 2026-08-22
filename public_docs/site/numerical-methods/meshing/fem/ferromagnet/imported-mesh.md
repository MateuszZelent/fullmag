---
title: Imported FEM Mesh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-imported-mesh)=
# Imported FEM Mesh

An imported/prebuilt mesh bypasses generation, not validation.

The importer must establish:

- coordinate units and world frame;
- supported element type and order;
- positive orientation/Jacobians;
- magnetic regions and material attributes;
- external and internal boundary markers;
- periodic pairs and translations;
- compatibility with selected CPU/GPU operators.

The imported asset digest becomes part of the discrete problem. A filename alone is insufficient
provenance.
