---
title: Mesh Quality and Reports
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-meshing-quality-and-reports)=
# Mesh Quality and Reports

Quality views are evidence views, not editable policy.

The frontend normalizes and presents:

- element and boundary counts;
- size, edge-length, and volume distributions;
- minimum, mean, percentile, and histogram quality values;
- inverted and degenerate counts;
- region/object/airbox scopes;
- topology and fallback status;
- requested-versus-realized layer counts;
- raw JSON report, quality, and size-field resources.

Histogram hover is linked to the viewport by semantic scope, allowing the user to locate elements in
a problematic size or quality bin. The current build and latest-successful build remain distinct so
a failed rebuild does not erase the last qualified mesh.
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.
## Source-code index

- Frontend implementation owners: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`, `ObjectMaterialPanel.tsx`, `PhysicsInteractionPanel.tsx`, `ObjectMagneticTexturePanel.tsx`, `ObjectMeshPolicyPanel.tsx`, and `StudyStageDraftEditor.tsx`, as applicable to the route above.

