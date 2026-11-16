---
title: 2D Planar Field Map, Layers & Section Tools
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-visualization-planar-2d-and-monitors)=
# 2D Planar Field Map, Layers & Section Tools

`FieldMapModule` (`apps/control-room/src/modules/field-map/FieldMapModule.tsx`) provides the
Control Room's 2D planar probe, cross-section renderer, multi-layer overlay compositor, and
hysteresis snapshot browser. Sections can render either an authored `PlanarMonitor` or interactive
`XY` / `XZ` / `YZ` cut planes synchronized with visualization state.

```{image} /_static/images/ui/planar-2d-field-map-overview.png
:alt: 2D Planar Field Map showing slice plane controls, toolbar, vector field overlay, color legend, and live coordinate readout
:align: center
:width: 100%
```

## Section Planes, Interactive Tools & Exports (`PlanarToolbar`)

The top `PlanarToolbar` (`apps/control-room/src/modules/field-map/components/PlanarToolbar.tsx`)
exposes roving-focus toolbar controls grouped into section orientation, cursor mode, navigation,
overlay masks, and export:

| Toolbar group | Exact controls | Behavior |
|---|---|---|
| Section plane | `XY`, `XZ`, `YZ` (`PLANAR_SECTION_PLANES`) | Selects the active orthogonal slice plane (`fieldMapPlaneCommands.ts`) |
| Tools (`planarToolStore`) | `Navigate`, `Zoom to box`, `Crop`, `Inspect node`, `Line profile`, `Measure` | Controls pointer interaction on the planar canvas |
| Navigation | `Zoom in` (`+`), `Zoom out` (`−`), `Fit view` | Zooms or resets camera framing |
| Layer masks | `Vectors`, `Sample points`, `Mesh`, `Field lines`, `Contours`, `Slice panels`, `Legend` | Toggles overlaid vector glyphs, sample markers, cross-section mesh wireframe, magnetic/flux streamlines, scalar contours, multislice panel mode, and `PlanarColorLegend` |
| Exports | `Export PNG` (`captureVisibleFieldMapPng`), `Export data (CSV)` | Saves the visible 2D canvas capture or CSV slice values (`fieldMapExport.ts`) |

- **Field Lines & Contours**: Toggling **Field lines** and **Contours** renders iso-value contour lines and tangential vector streamlines derived from the sampled 2D slice (`planarFieldComposition.ts`).
- **Line Profile & Measure**: Using **Line profile** draws a draggable cut chord across the slice and opens `PlanarProfileChart` alongside exact spatial distances via **Measure**.
- **Hover & Click Probe**: `PlanarNodeInspector` (`PlanarNodeReadout.tsx`) reports exact physical $(x, y, z)$ coordinates, active quantity value, display unit conversion, and component vector readout.

```{image} /_static/images/ui/planar-2d-streamlines-and-contours.png
:alt: 2D Planar Field Map with magnetic streamlines, scalar contours, and HSL direction legend enabled
:align: center
:width: 100%
```

```{image} /_static/images/ui/planar-2d-line-profile-and-measure.png
:alt: 2D Planar Field Map displaying interactive Line Profile graph and point-to-point distance measurement
:align: center
:width: 100%
```

## Multi-Slice Panels, Ordered Layer Stack & Hysteresis Playback

- **Ordered Field Layer Stack (`PlanarFieldLayerList`)**: Under `inspector/visualization/PlanarFieldLayerList.tsx`, the 2D view supports up to `PLANAR_FIELD_LAYERS_MAX` stacked target layers (`all`, `airbox`, `object:<id>`), reorderable via drag-and-drop or `Alt+ArrowUp`/`Alt+ArrowDown`. Each layer independently configures quantity, derived component (`planarComponentDerivation.ts`), colormap, vector arrows, and visibility.
- **Multi-Slice Grid (`PlanarMultisliceGrid`)**: Enabling **Slice panels** tiles multiple axial slice offsets across the thickness or domain axis (`MULTISLICE_MIN_PANELS` to `MULTISLICE_MAX_PANELS`) with shared normalized or direction legends (`PlanarColorLegend`).
- **Hysteresis Snapshot Navigation (`PlanarSnapshotNavigator`)**: When browsing a completed or running hysteresis stage, a toolbar (`Snapshot k / N · B = ... mT`, Previous/Next, **Play**/**Pause**, **Live**) steps deterministically through saved field-sweep snapshots, waiting for each frame's `status === "ready"` before advancing playback.

```{image} /_static/images/ui/planar-2d-multislice-and-layers.png
:alt: 2D Planar Field Map showing tiled multislice grid panels and ordered multi-layer overlay list
:align: center
:width: 100%
```

Screenshots illustrate the interface; they are not runtime or physics qualification evidence.

## Control Room crosswalk

- **Primary module**: `FieldMapModule` (`apps/control-room/src/modules/field-map/FieldMapModule.tsx`).
- **Inspector companions**: `PlanarMonitorDraftInspectorPanel`, `PlanarMonitorInspectorPanel`, `PlanarFieldLayerList`, and `PlanarSectionPlaneSection`.
- **Rendering boundary**: Planar slices sample backend field resources (`usePlanarScalarResource`, `usePlanarVectorResource`, `usePlanarMeshOverlayResource`, `usePlanarProfileResource`) and never compute solver residuals locally.

## Python/API crosswalk

- Planar monitor definitions authored in UI commit to the session planar monitor catalog matching Python monitor definitions.
- Line profiles and CSV slice exports represent sampled visualization buffers for interactive analysis; full volumetric outputs remain in session/Zarr artifacts.

## Physics and bibliography scope

This page covers 2D slice rendering, component projection, contour/streamline generation, and UI probing tools; it introduces no independent physical equations.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| 2D planar field map module & data plan | `apps/control-room/src/modules/field-map/FieldMapModule.tsx` | `FieldMapModule` |
| Section, tool, navigation & mask toolbar | `apps/control-room/src/modules/field-map/components/PlanarToolbar.tsx` | `PlanarToolbar` |
| Multi-layer stack & keyboard reordering | `apps/control-room/src/modules/inspector/visualization/PlanarFieldLayerList.tsx` | `PlanarFieldLayerList` |
| Multi-slice panel layout | `apps/control-room/src/modules/field-map/components/PlanarMultisliceGrid.tsx` | `PlanarMultisliceGrid` |
| Hysteresis snapshot stepper & replay | `apps/control-room/src/modules/field-map/components/PlanarSnapshotNavigator.tsx` | `PlanarSnapshotNavigator` |
| Scalar & HSL direction legends | `apps/control-room/src/modules/field-map/components/PlanarColorLegend.tsx` | `PlanarColorLegend` |
| Line-profile chart & CSV export | `apps/control-room/src/modules/field-map/components/PlanarProfileChart.tsx` | `PlanarProfileChart` |
