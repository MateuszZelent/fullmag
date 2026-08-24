---
title: Meshing UI
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/resource-first-control-room-api-v2.md, docs/specs/frontend-v2/01-module-kernel-architecture.md
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
