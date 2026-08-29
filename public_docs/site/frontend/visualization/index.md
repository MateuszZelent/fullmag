---
title: Frontend Visualization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-visualization-root)=
# Frontend Visualization

Visualization consumes published geometry, mesh, field, and selection resources. It must distinguish
the authored CAD model, mesh preview, current solver mesh, magnetic submesh, airbox, and result
fields.

For meshing, the critical rule is that a rendered surface is not a topology certificate. The
viewport may hide internal interfaces, duplicate coincident faces, inverted elements, region-marker
loss, or unsupported mixed element families. Those facts come from backend reports and quality
resources.

FDM and FEM use separate render adapters but share the viewport and inspection model. FDM renders
structured cells/masks; FEM renders extracted vertices, cells, boundary subsets, and semantic mesh
parts.
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
