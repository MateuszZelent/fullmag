---
title: FEM Region Mesh Panel
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-meshing-region-mesh)=
# FEM Region Mesh Panel

Object-owned regions have a separate FEM mesh policy rather than silently mutating the parent
object policy. The region panel exposes:

- enable/disable of the region mesh override;
- maximum and minimum element size;
- transition distance;
- finite-element order;
- membership and quality resources;
- Apply, Revert, Duplicate, Delete, and region-build actions.

The region policy is valid only when the region is committed, belongs to the selected object, and the
session mesh lane is FEM. Under FDM the same panel becomes a read-only membership inspector over
structured-grid cells.

Region mesh settings participate in shared-domain conformity. A fine region request can refine
neighbouring elements through transition and conformity constraints; the UI therefore displays
realized membership and quality rather than promising an exact local element count.
