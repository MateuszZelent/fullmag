---
title: Meshing UI
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-meshing-root)=
# Meshing UI

Meshing controls are split by selected semantic owner rather than placed in one monolithic dialog.

| Selection | Canonical panel | Writable lane |
|---|---|---|
| magnetic object | Object Mesh Policy | FEM |
| universe / airbox | Airbox Mesh Parameters | FEM; geometry-only subset for FDM |
| object-owned region | Region Mesh | FEM |
| FDM object or region | structured-grid inspector | read-only |
| realized mesh | Quality / History | read-only evidence |

The following pages document each panel, its exact transaction boundary, and its mapping to backend
resources and Python.

```{toctree}
:maxdepth: 2

object-mesh
airbox-mesh
region-mesh
fdm-grid-view
build-lifecycle
quality-and-reports
python-round-trip
```
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
