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

```{image} /_static/images/ui/viewport-3d-fem-mesh-airbox.png
:alt: 3D Viewport rendering FEM object geometry framed inside the exterior airbox wireframe with orientation cube and HSL legend
:align: center
:width: 100%
```

```{image} /_static/images/ui/inspector-fem-mesh-and-airbox.png
:alt: Airbox Mesh Overview inspector showing readiness badges, topology revision match, carrier part_airbox, element size targets, and growth rate
:align: center
:width: 100%
```

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
