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
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.
## Source-code index

- Frontend implementation owners: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`, `ObjectMaterialPanel.tsx`, `PhysicsInteractionPanel.tsx`, `ObjectMagneticTexturePanel.tsx`, `ObjectMeshPolicyPanel.tsx`, and `StudyStageDraftEditor.tsx`, as applicable to the route above.

