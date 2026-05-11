# Frontend v2 - 2D Viewport Module

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Purpose

`viewport-2d` renders slices, projections, probes, line profiles, and 2D mesh overlays. It is not a fallback 3D viewport. It has separate data resources and separate lifecycle.

## 2. Modes

| Mode | Description |
|---|---|
| `slice` | plane slice through scalar/vector field |
| `projection` | projected view along an axis |
| `profile` | line sample across selected path |
| `probe` | point/region sample |
| `mesh-section` | 2D representation of mesh/topology section |

Modes are command-selected and resource-backed.

## 3. File Structure

```text
viewport-2d/
  manifest.ts
  Viewport2DModule.tsx
  store.ts
  components/
    SliceSurface.tsx
    SliceToolbar.tsx
    ProfileOverlay.tsx
    ProbeReadout.tsx
  hooks/
    useSliceResource.ts
    useProfileResource.ts
    useSliceInteraction.ts
  model/
    buildSliceRenderModel.ts
    buildProfileRenderModel.ts
```

## 4. Data Flow

The 2D module consumes slice/profile resources:

- active quantity id;
- axis or plane definition;
- sample resolution/budget;
- scope: full domain, selected object, mesh part, region;
- revision pointers;
- value range and units.

It does not read 3D renderer buffers. Shared decoded field resources may be reused only through the resource cache, never through direct viewport imports.

## 5. Rendering Backend

2D rendering may use ECharts, Canvas2D, or SVG depending on the data:

- dense raster slice: canvas or ECharts heatmap;
- line profile: ECharts line chart;
- mesh section: canvas/SVG overlay;
- probe markers: SVG/DOM overlay.

The renderer is chosen inside the module. The shell only sees a mounted module.

## 6. Interaction

Interactions:

- axis/plane selector;
- drag slice plane when linked to 3D view;
- click probe;
- drag profile line;
- zoom/pan within 2D data;
- add profile to charts module through command registry.

Cross-module linking uses events:

- `viewport:slice-plane-changed`;
- `viewport:probe-picked`;
- `charts:add-series-requested`;
- `workspace:selection-changed`.

## 7. Staleness

2D data shows stale states independently from 3D:

- field revision stale;
- topology revision stale;
- slice resource pending;
- sampling degraded;
- capability unsupported.

The user should see whether the problem is missing data, unsupported capability, or pending recompute.

## 8. Tests

Required tests:

- slice mode requests the expected resource key;
- changing axis invalidates slice resource, not full topology;
- probe emits canonical selection/probe event;
- unsupported capability shows direct explanation;
- unmount disposes chart/canvas resources and observers.
