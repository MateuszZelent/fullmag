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
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.
## Source-code index

- Frontend implementation owners: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`, `ObjectMaterialPanel.tsx`, `PhysicsInteractionPanel.tsx`, `ObjectMagneticTexturePanel.tsx`, `ObjectMeshPolicyPanel.tsx`, and `StudyStageDraftEditor.tsx`, as applicable to the route above.

