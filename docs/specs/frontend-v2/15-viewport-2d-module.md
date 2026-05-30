# Frontend v2 - 2D Viewport Module

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Purpose

`viewport-2d` renders slices, projections, probes, line profiles, 2D mesh overlays, and quality-colored mesh cross-sections. It is not a fallback 3D viewport. It has separate data resources and separate lifecycle.

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
  layers/
    SliceSurface.tsx
    CrossSectionPolygonLayer.tsx
    CrossSectionWireframeLayer.tsx
    GridLayer.tsx
    AxisLayer.tsx
    ColorbarLayer.tsx
    ProfileOverlay.tsx
    ProbeReadout.tsx
  hooks/
    useSliceResource.ts
    useCrossSectionResource.ts
    useProfileResource.ts
    useSliceInteraction.ts
  model/
    buildSliceRenderModel.ts
    buildCrossSectionRenderModel.ts
    buildProfileRenderModel.ts
```

## 4. Data Flow

The 2D module consumes slice/profile resources:

- active quantity id;
- axis or plane definition;
- sample resolution/budget;
- scope: full domain, selected object, mesh part, region;
- target visualization overrides for object and airbox display in the current 2D mode;
- revision pointers;
- value range and units.

`mesh-section` additionally consumes shared-domain cross-section resources:

- plane axis and normalized position;
- polygon and wireframe inclusion flags;
- parent element ids for each cross-section polygon;
- selected quality metric and quality range;
- intersection metadata for 3D COMSOL-style inspection: original edge
  endpoint node ids, edge-plane intersection coordinates, and original mesh
  nodes lying on the plane within tolerance;
- topology or mesh revision used to compute the section.

It does not read 3D renderer buffers. Shared decoded field resources may be reused only through the resource cache, never through direct viewport imports.

The first mesh-section implementation uses the shared-domain FEM endpoints:

- `GET /v2/sessions/current/meshing/meshes/shared-domain/cross-section`
- `GET /v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality`

The 2D mesh-section workflow is draft-first. The View ribbon creates an editable
cross-section draft, opens the universe-sized 3D cut-frame overlay, and selects
the draft under the Explorer `Visualizations 2D` branch. While the draft is
active, Inspector plane and position edits patch `visualization.clip` and
`visualization.slice` so the 3D frame moves immediately. Inspector frame
rotation is an in-plane visual frame rotation for the current axis-aligned
cut plane; it does not claim arbitrary tilted FEM slicing until the backend API
accepts a general plane normal and origin. The auxiliary
`viewport-2d` does not fetch or render the binary cross-section until the user
commits the draft as a saved `plot-*`. A saved plot owns the exact geometry
query, quality query, render options, frame extent, and in-plane frame rotation
value used by the 2D viewport, so later Inspector/ribbon edits cannot silently
mutate an already created plot. The auxiliary viewport renders committed plots as tabs;
selecting a tab activates that saved plot and drives the Inspector selection.
The `viewport-2d.toggle` command focuses between the main and auxiliary
viewport slots, and `viewport-2d.fit` focuses `viewport-aux` while emitting a
fit request consumed by the 2D canvas camera controller.

The linked 3D viewport shows the active cut plane as a COMSOL-style framed
rectangle over the mesh. It also renders metadata-backed markers on the plane:
larger accent markers are original mesh nodes lying on the plane, and smaller
wire-colored markers are edge-plane intersection points. This distinction is
required because most cross-section vertices are not original mesh nodes. The
Inspector and 2D viewport HUD expose the same marker counts so the user can
confirm whether the cut is passing through real mesh nodes or only through
tetrahedron edges.

The 2D viewport includes a quality colorbar for committed plots. The colorbar
uses the same color mapping as the WebGL polygon buffers, labels the active
quality metric and color scale, and shows min/mid/max tick values from the
quality payload.

The WebGL mesh-section scene renders a bounds-derived coordinate grid behind
the colored polygons. Tick spacing is computed from the committed plot bounds
with stable "nice" intervals, and zero-coordinate ticks are styled as axis
reference lines when the section crosses the origin.

Hovering a rendered cross-section polygon shows a module-local DOM tooltip next
to the pointer. The tooltip reports the parent tetrahedron id, active quality
metric value, polygon index, triangle count, and section-space centroid. It is
derived from the render model and does not fetch additional mesh data. The same
hover state renders a bright closed outline over the hovered polygon so the
tooltip and geometric face can be visually matched.

Clicking a polygon emits the existing mesh-quality element selection shape with
the parent tetrahedron id and a 3D world-space centroid derived from FMCS
intersection metadata. The 3D viewport consumes that centroid for its selection
bounds/highlight; section-space `u,v` coordinates must not be used as world
coordinates. While that selection remains active, the 2D viewport renders a
persistent selected-polygon outline in addition to the transient hover outline.

Committed cross-section plots have local canvas interaction state only. Mouse
wheel zoom changes the 2D view scale, middle-button drag pans the view, and
`viewport-2d.fit` resets that local scale and offset back to the committed plot
bounds. These pan/zoom values are not persisted to workspace or session state.

Draft cross-section display preferences are mirrored onto `visualization.slice`
for 3D frame synchronization and ribbon continuity:

- `mesh_quality_metric` selects the parent-tetrahedron quality metric;
- `mesh_color_scale` selects the polygon color map;
- `mesh_filter_expression` stores simple element filters such as `quality < 0.3`;
- `mesh_shrink_factor` controls COMSOL-style element shrink from `0.5` to `1.0`;
- `show_mesh` controls the wireframe overlay fetch/render path.

The binary cross-section geometry payload is `FMCS` version 2 with a 64-byte
header, polygon vertex data, polygon CSR offsets, parent tetrahedron ids,
optional wireframe segments, and per-polygon-vertex intersection metadata:
world `xyz`, edge endpoint node ids, interpolation parameter `t`, and point kind
(`edge_intersection` or `mesh_node`). The quality payload is `FMQS` version 1
and colors each cross-section polygon by the quality of its parent tetrahedron.
The exposed parent-tet metrics are `gamma`, `sicn`, `volume`, `skewness`,
`aspect_ratio`, `max_angle`, and `min_edge`. `gamma` and `sicn` come from the
FMMQ mesh-quality artifact when available. The geometric metrics are computed
from the intersected parent tetrahedron, so the cross-section quality endpoint
can still color a section when no FMMQ artifact exists.

## 5. Rendering Backend

2D rendering may use ECharts, Canvas2D, SVG, or a dedicated orthographic WebGL canvas depending on the data:

- dense raster slice: canvas or ECharts heatmap;
- line profile: ECharts line chart;
- mesh section: orthographic WebGL for large polygon sets, with Canvas2D/SVG only for low-count overlays;
- probe markers: SVG/DOM overlay.

The renderer is chosen inside the module. The shell only sees a mounted module.

The WebGL mesh-section renderer is allowed only for the mounted `viewport-2d` mode that owns it. It must render on demand, dispose geometries/materials/buffers on unmount or resource replacement, and never share live Three.js objects with `viewport-3d`.

Before a new Geometry object has current mesh/field resources, 2D object-scoped slice/profile/probe commands are disabled with a primitive-only or mesh-stale explanation. The 2D module must not render blank panels or invent client-side field data from primitive fallback geometry.

## 6. Interaction

Interactions:

- axis/plane selector;
- drag slice plane when linked to 3D view;
- click probe;
- drag profile line;
- zoom/pan within 2D data;
- fit-to-view for cross-section bounds;
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
- WebGL-backed mesh-section mode disposes geometries, materials, buffers, controls, and animation-frame handles.
- 2D layer controls use the same target ids as 3D object/airbox visualization instead of inventing a parallel 2D-only store.
- primitive-only or mesh-stale objects expose a clear disabled/stale 2D state until mesh and field resources exist.
