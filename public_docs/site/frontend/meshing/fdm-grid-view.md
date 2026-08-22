---
title: FDM Grid Inspector
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-meshing-fdm-grid-view)=
# FDM Grid Inspector

FDM meshing is planner-owned structured-grid execution, not an interactive tetrahedral build. The
Control Room therefore exposes FDM object and region grids as read-only resources.

Displayed evidence includes:

- grid origin and cell-centre convention;
- spacing and integer shape;
- total cells and active/inactive participation;
- object and region membership;
- canonical mask status;
- grid fingerprint.

FEM policy writes and FEM mesh-build commands are withheld in the FDM lane. To change resolution,
edit the canonical Python/ProblemIR cell-size policy and re-plan or rerun the study.
