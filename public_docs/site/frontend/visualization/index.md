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

```{toctree}
:maxdepth: 1

viewport-3d-and-studio
planar-2d-and-monitors
charts-and-playback
```
