---
title: Frontend Visualization
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-visualization-root)=
# Frontend Visualization

Visualization consumes published geometry, mesh, field, and selection resources across unified 3D,
2D planar, live chart, and saved-playback views. It distinguishes the authored CAD model, mesh
preview, current solver mesh, magnetic submesh, airbox, and spatial result fields.

For meshing, the critical rule is that a rendered surface is not a topology certificate. The
viewport may hide internal interfaces, duplicate coincident faces, inverted elements, region-marker
loss, or unsupported mixed element families. Those facts come from backend reports and quality
resources.

FDM and FEM use separate domain adapters (`FdmCuboidLayer`, `TopologyMeshLayer` / `MeshPartLayer`)
while sharing the same `Viewport3DModule`, `FieldMapModule`, `LiveChartsModule`,
`AnalysisPlotsModule`, and selection model.

```{image} /_static/images/ui/viewport-3d-interactive.png
:alt: Control Room 3D WebGL Viewport showing geometry, vector glyphs, dimension frame, and colorbars
:align: center
:width: 100%
```

```{image} /_static/images/ui/planar-2d-field-map-overview.png
:alt: 2D Planar Field Map showing slice plane controls and synchronized vector/scalar overlays
:align: center
:width: 100%
```

```{image} /_static/images/ui/charts-live-time-series.png
:alt: Live Charts view plotting real-time magnetization and energy traces
:align: center
:width: 100%
```

Screenshots illustrate the interface; they are not runtime or physics qualification evidence.

```{toctree}
:maxdepth: 1

viewport-3d-and-studio
planar-2d-and-monitors
charts-and-playback
```
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked {doc}`/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
