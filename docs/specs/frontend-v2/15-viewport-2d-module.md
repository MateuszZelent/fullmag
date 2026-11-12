# Frontend v2 - Planar Field Map and 2D Analysis Surfaces

**Status:** Active production contract; implementation and qualification in progress
**Date:** 2026-07-18
**Decision records:** `docs/adr/0016-center-viewport-tabbed-surfaces.md`,
`docs/adr/0020-planar-field-map-and-monitor.md`,
[`docs/adr/0080-planar-field-layers-crop-and-node-probe.md`](../../adr/0080-planar-field-layers-crop-and-node-probe.md)
(toolbar, field layers, crop, node probe; 2026-11-12)

The former `viewport-2d` R3F module and the static `cross-section-image` center
module are no longer part of the active control-room module registry. They were
replaced by tabbed center surfaces:

- `field-map` for interactive revisioned field slices and projections without a
  second browser WebGL scene;
- `analysis-plots` for scalar histories and analysis charts;
- `viewport-3d` for the single live WebGL/R3F 3D scene.

This file is kept only as the numbered frontend-v2 spec entry for 2D analysis
surfaces. Historical implementation details for the removed live WebGL module
must be recovered from git history, not treated as current architecture.

## 1. Lifecycle Contract

All heavy center surfaces mount through the `viewport-main` tab host. Only the
active tab is mounted. Switching away from `viewport-3d` must unmount the 3D
module instead of hiding it, which releases its R3F canvas, render loop,
observers, and viewport-local resource subscriptions.

Inactive tabs may keep lightweight manifest metadata and command definitions in
the module registry, but they must not keep renderer instances, WebGL contexts,
object URLs, animation frames, or viewport-specific resource hooks alive.

## 2. Mesh-quality cross-section compatibility resource

The backend continues to expose committed FEM mesh-quality cross-section PNGs:

```text
GET /v2/sessions/current/meshing/meshes/shared-domain/cross-section/image
```

The resource is addressed by the committed plot query and render options:

- plane and normalized position;
- quality metric;
- color scale;
- resolution;
- wireframe, legend, shrink factor, and filter expression.

The frontend consumes this through the typed API client and resource-hook layer
for mesh diagnostics/export. It is not registered as a center module and does
not contribute `cross-section-image.open`. Spatial field PNG export belongs to
`field-map.export-png` and the planar `render.png` resource.

## 3. Analysis Plot Surface

`analysis-plots` owns 2D plot rendering for scalar histories and analysis
series. The implemented baseline uses ECharts Canvas v6; the canonical target
keeps renderer choice behind the shared neutral chart boundary and remains
demand-driven. Renderer replacement requires a reproducible hard-gate failure
and comparative spike; it is not assumed by this specification.

Plot modules must separate:

- scalar/time-series resource fetching;
- chart model construction;
- renderer choice;
- download/export commands.

They must not depend on `viewport-3d` internals or reuse 3D renderer buffers.

## 3.1 Field Map Surface

`field-map` is the canonical active-only center module for scientific spatial
field inspection. It consumes planar-monitor resources through the typed API
facade and resource hooks (`planar-default` and `planar-monitors`). The legacy
`samples/slice` and `projection` routes are not consumed by Control Room and
remain only for API compatibility. It supports heatmap, contours, bounded
vectors, probe, mesh/boundary overlays, occupancy, surface diagnostics, and
export without reconstructing FDM/FEM fields in the browser.

The renderer instance is created once per mount, updates only for resource
revision or user-control changes, resizes through an observer, and is disposed
on unmount. Source k-spectrum and spin-wave dynamic-structure-factor products
are read from `analysis` resources and rendered by `analysis-plots`; they are
not inferred from a scalar magnitude image.

The physical definition is a quantity- and resolution-independent
`PlanarMonitor`: target, right-handed frame, extent policy, and one of
`plane_sample`, `slab_average`, `depth_projection`, or `surface_projection`.
Quantity/component/unit/range/palette/opacity and sampling resolution/quality belong to
the planar visualization profile or data request. Range is explicit
`auto | manual | symmetric`; manual limits are canonical SI and display units
only transform presentation. Runtime mesh-part and airbox
scopes narrow a monitor target but never enter canonical Python or `ProblemIR`.

Planar target presentation reuses the canonical visualization target registry
identity. The first additive contract is:

```text
PlanarTargetPresentationOverride {
  scope: airbox | object | part,
  scope_id: non-empty string,
  wireframe_style: { color: string, opacity: finite 0..1 }
}
```

`planar.target_overrides` is an ordered list with unique exact `(scope,
scope_id)` pairs. A PATCH that omits this field leaves it unchanged; a supplied
list replaces it, and removing an entry restores the global planar wireframe
fallback. Unknown scopes, blank IDs, duplicates, invalid colors, invalid
opacity, and identities absent from the current canonical target registry fail
PATCH validation. If a later scene/mesh revision removes a target, the stored
entry becomes dormant with a diagnostic and is not applied; the same canonical
identity may reactivate only that previously explicit preference. Entries never
copy target labels, ownership, carrier metadata, or selection state. Editing
the Airbox cannot change an object/part entry, editing an object cannot change
the Airbox, and wireframe-only changes cannot alter scalar/vector/mask/mesh
sampling request identity or their ETags. The visualization-state revision and
ETag do change. The exported `render.png` applies the session planar colormap
and SI color range, and its ETag combines the sample identity with that style;
it does not draw the target wireframe. Three-dimensional target overrides remain independent. Region,
FDM-domain, and native-layer overrides remain unsupported until the canonical
backend registry publishes them.

The backend performs physical sampling. FDM uses explicit cell reconstruction:
`plane_sample` averages the cells under each pixel footprint (exact when the
raster divides the cell counts) and slab/depth use cell-intersection measure.
FEM P1 uses barycentric (Tet4) or isoparametric (Prism6) point evaluation and
conservative element/boundary measure. Node count is diagnostics only.
Vector reduction precedes world or monitor-basis component derivation.

## 4. Planar Source and Monitor Authoring Flow

The View ribbon, Inspector, or opening 2D changes only the active center
surface. The session visualization state always has a typed planar source:
`Default` or an authored monitor selection. When no authored monitor is
selected, `field-map` resolves `Default` from the published domain with
`plane=xy` and `position_fraction=0.5`; it does not create a monitor draft,
change `SceneDocument`, or update canonical Python. The default source uses
the same backend sampler as authored monitors after the server resolves its
target, frame, extent, and operator.

For the `Default` source, the Inspector 2D tab section **Section plane**
(`PlanarSectionPlaneSection`) edits the session `default_slice`: source, plane
`XY/XZ/YZ`, `Single layer | Average`, the section (`Free section` or a named
object layer) and a numeric position. The position slider stays in the status
bar under the surface (§4.1, zone D) and writes the same `default_slice`;
there are no plane, mode or section controls above the surface (ADR 0080, U1
and U4). On a
structured FDM grid the position is a discrete layer index shown with its
snapped cell-centre coordinate (`fraction = (i + 0.5)/N`, mirrored by the
backend snap `i = ceil(fN) - 1`); on FEM it stays continuous. `Average` is a
slab of twice the normal extent, so it covers the whole domain from any snapped
centre and yields the occupied-measure mean over the full thickness. The
toolbar and the status bar stay visible on loading and error states so a
failing section can be changed. For a monitor source, plane, mode and position
are read-only in the Inspector with the reason "Defined by the monitor". FDM
rasters offer native-grid presets (one pixel per cell and integer reductions)
in the Inspector **Crop and view** section. A selected FDM multilayer layer
maps to the `layer` view scope; the Airbox scope is resolved by the backend
carrier for FDM and FEM.

What is drawn is one ordered list of **field layers** (`planar.field_overlays`
on the wire, ADR 0080 W2), at most `PLANAR_FIELD_LAYERS_MAX = 16`. Each layer
owns its target (`monitor_target` "All objects", `airbox`, or one object or
region), quantity, component, colormap, range, opacity and its pass flags
`visible`, `raster_visible`, `vectors_visible`, `points_visible`,
`mesh_visible`, `contours_visible`, `streamlines_visible`. With
`planar.layer_model = layers` the base fields (`quantity_id`, `component`,
`colormap`, `range`, `raster_opacity`, `view_scope`) are not drawn; the base
sample only supplies `meta` (frame, section, cut-element count) and the mesh
overlay when the mesh mask is on. A new session starts with one layer
`all` (`m`, `hsl_direction`). The list, its editor and the per-object
selection rule are specified in
[23 §5](23-per-object-visualization-control.md#5-2d-extension); persisted
`legacy` sessions migrate once as defined in ADR 0080.

### 4.1 Layout, toolbar, direction colours and keyboard

Plans: `docs/plans/active/viewport-2d-mumax-parity-2026-10-27/` (direction
colours, glyphs, section metadata) and
[`docs/superpowers/plans/2026-11-12-viewport-2d-toolbar-layers-crop-node-inspect.md`](../../superpowers/plans/2026-11-12-viewport-2d-toolbar-layers-crop-node-inspect.md)
(layout, toolbar, tools; ADR 0080).

The 2D view has four zones:

| Zone | Content | Contract |
|---|---|---|
| A — toolbar (`PlanarToolbar`) | icon buttons in four groups plus an overflow menu `⋯` | 34 px, one line, never wraps; overflow goes to a `DropdownMenu`; `role="toolbar"`, `aria-label="2D view tools"` |
| B — surface | canvas with axes (`PlanarSurface`) and the tool overlay (`PlanarToolOverlay`, SVG) | renderer unchanged; Canvas 2D + worker (ADR 0020 decision 5) |
| C — legend (`PlanarColorLegend`) | one compact card per visible field layer, overlaid bottom-left on the surface | hidden by `field-map.toggle-legend` (`planar.viewport_colorbar_visible`) |
| D — status bar (`PlanarStatusBar`) | plane label, position slider with `‹ ›` steps, normal coordinate, cut-element count, cursor coordinates, zoom, crop chip with a clear button | 28 px; the slider commits `default_slice.position_fraction` once on release |

A and D stay visible over loading and error states. There are no Quantity,
Component, Scope, plane, `Single layer | Average`, `Free section` controls and
no text toggles (`Arrows`, `Lines`, `Mesh`, `Slices`) above the surface: what
is displayed is edited per layer in the Inspector 2D tab (ADR 0080 U1–U4). The
former `FieldMapToolbar` and `PlanarSectionStrip` are removed. The hover badge
"No sample" is removed; D shows `—` when the cursor is outside the frame.

Toolbar group 1 — tools (exactly one active, `role="radiogroup"`, each item
`aria-checked`). The active tool is ephemeral client state
(`kernel/visualization/planarToolStore.ts`, `useSyncExternalStore` with server
snapshot `navigate`); it is never persisted and returns to `navigate` when the
2D view closes or another centre module becomes active.

| Tool | `PlanarToolId` | Command | Icon (lucide) | Shortcut |
|---|---|---|---|---|
| Navigate | `navigate` | `field-map.tool.navigate` | `Hand` | `H`, `Esc` |
| Box zoom | `zoom-box` | `field-map.tool.zoom-box` | `ScanSearch` | `B` |
| Crop | `crop` | `field-map.tool.crop` | `Crop` | `C` |
| Inspect | `inspect` | `field-map.tool.inspect` | `Crosshair` | `I` |
| Profile | `profile` | `field-map.tool.profile` | `ChartSpline` | `P` |
| Ruler | `measure` | `field-map.tool.measure` | `Ruler` | `R` |

Group 2 — navigation (one-shot actions): `field-map.zoom-in` (`ZoomIn`, `+`),
`field-map.zoom-out` (`ZoomOut`, `-`), `field-map.fit` (`Maximize`, `F` and
`0`). Zoom steps multiply or divide `planar.interaction.zoom` by 1.25 around
the view centre within the wheel-zoom limits. With an active crop, `fit` fits
the crop.

Group 3 — view masks (toggles with `aria-pressed`):

| Toggle | Command | State field | Icon (lucide) |
|---|---|---|---|
| Vectors | `field-map.toggle-vectors` | `planar.layers.vectors` | `MoveUpRight` |
| Points | `field-map.toggle-points` | `planar.layers.points` | `Grip` |
| Mesh | `field-map.toggle-mesh` | `planar.layers.mesh` | `Triangle` |
| Streamlines | `field-map.toggle-streamlines` | `planar.layers.streamlines` | `Waves` |
| Contours | `field-map.toggle-contours` | `planar.layers.contours` | `CircleDashed` |
| Multislice | `field-map.toggle-multislice` | `planar.multislice.enabled` | `LayoutGrid` |
| Legend | `field-map.toggle-legend` | `planar.viewport_colorbar_visible` | `Palette` |

A mask applies to the whole view: a pass is drawn for a layer only when the
view mask AND the layer flag are on (ADR 0080 W5). Multislice draws the first
visible layer of the list (W7).

Group 4 — export: `field-map.export-png` (`Camera`) and
`field-map.export-data` (`FileDown`); both include an active crop.

`field-map.clear-crop` has no toolbar button; it is the clear button of the
crop chip in D and of the Inspector crop section.

Rules:

- Every button has a `Tooltip` with name and shortcut and an `aria-label`.
- An unavailable button stays visible, disabled, with its `disabledReason`
  (for example "Mesh unavailable for this source"). All `field-map.*` tool,
  navigation and mask commands are disabled with a reason when the active
  centre module is not `field-map`.
- Toolbar, ribbon (`view-slice-2d` group), shortcuts and the command palette
  render the same command registry entries (spec 12).
- Existing shortcuts stay: `[` `]`, `Shift+{` `Shift+}`, `V X Y Z M`, `A`, `G`.
  The new letters `H B C I P R F` do not collide with them. Shift+drag draws a
  profile in every tool.
- Every lucide icon is checked against the installed `lucide-react`; a missing
  icon is replaced with the closest available one and recorded in the PR.

### 4.2 Tool gesture contract

| Tool | Pointer gesture | Commit | Cancel | Result |
|---|---|---|---|---|
| `navigate` | drag pans; wheel zooms at the cursor; double click fits | immediate (one `interaction` patch per animation frame) | — | `planar.interaction` only |
| `zoom-box` | drag a rectangle | on release, if both sides are at least `MIN_TOOL_DRAG_PX = 4` screen px | `Esc` | one `interaction` patch fitting the rectangle (no resampling, W6); tool returns to `navigate` |
| `crop` | drag a rectangle; outside is dimmed; 8 handles; size label in axis units | `Enter` or the ✓ button; ✓ is disabled with a reason below 4 px on either side | `Esc` clears the draft and sends nothing | `queuePlanarCropPatch(rect)` once, rect clamped to `full_bounds_uv_m`; interaction resets to zoom 1, pan 0; backend resamples the window |
| `inspect` | hover reads the nearest node; click pins the reading | click | `Esc` closes the pinned reading | `/probe?nearest=node` per visible occupied layer (at most 4, list order), debounced 80 ms, stale responses dropped and aborted |
| `profile` | drag a segment | on release | `Esc` | profile chart of the segment (same as Shift+drag) |
| `measure` | drag a segment | on release | `Esc` clears | label with length, Δu, Δv and angle in axis units; no server state |

The wheel always zooms, in every tool. The crop is persisted session state
(`planar.crop`); a plane or source change clears it in the same PATCH. The
inspect overlay shows a crosshair at the requested point and a ring at the
node projection `(u_m, v_m)`; the reading has one block per visible layer
occupied at that point with node index, coordinates, in-plane distance,
normal offset (labelled "Δ from plane" when non-zero) and the value with its
unit. A block with `unsupported_operator` shows the point value and the
reason "Node unavailable for thickness averaging". A pinned reading survives a
tool change and has copy and close buttons.

### 4.3 Direction colours, glyphs and section metadata (mumax3 parity)

- `Direction` sets the planar colormap `hsl_direction`: the raster is coloured
  by the full vector with the mumax3 HSL wheel in the world frame (hue =
  atan2(v̂y, v̂x), lightness = 0.5·v̂z + 0.5, grey for vectors without a
  direction). The 2D and 3D viewports share one implementation
  (`shared/visualization/directionColor.ts`), the backend `render.png` uses
  the same formula, and the legend shows the two hemispheres. The scalar
  component stays `magnitude` for contours and probes. New sessions open `m`
  with this colormap.
- Cartesian presets use `coolwarm` with a symmetric range, `|v|` uses
  `viridis` with an automatic range; a manual range is never overwritten.
- Vectors are laid out on a screen-space 2D grid anchored to the (u, v)
  frame (`layoutScreenGlyphs`), spacing derived from `vector_budget` (a
  presentation-only density, outside the sample identity) with a 24 px
  minimum, length = mumax3 in-plane projection with a 7 px minimum,
  filled arrowheads, and `⊙/⊗` markers when |v∥|/|v| < 0.25. Over a
  direction raster, `orientation`-coloured arrows are drawn dark with a light
  halo.
- Frame retention ignores the default-slice position: a layer step keeps the
  last frame on screen and the status-bar section caption says
  `showing … · loading …`
  until the new frame arrives. Pointer gestures are coalesced to one patch per
  animation frame. The plot area is a size container that keeps the physical
  u:v aspect ratio.
- Sample metadata `section` publishes requested vs. resolved coordinate,
  `stops_kind` (`fdm_cell_layers | continuous`), layer index/count and
  navigation step; the Inspector shows `requested → resolved`.
- Commands (enabled only while 2D is the active centre module, except
  `export-data`): `[`/`]` layer, `Shift+{`/`Shift+}` ±10 layers,
  `V X Y Z M` component presets of the selected field layer, `A` vectors mask,
  `G` mesh mask, `fit`, `reset-view`, `toggle-contours`, and `export-data`
  (CSV of the sampled raster, or of the crop window when a crop is active, in
  SI with frame and world coordinates), plus the toolbar commands of §4.1. The
  toolbar renders the existing `field-map.toggle-vectors` (`A`),
  `field-map.toggle-mesh` (`G`) and `field-map.toggle-contours` commands
  unchanged; each `planar.layers.*` mask has exactly one command. The
  mounted surface publishes its presented
  profile, section geometry and frame evidence in
  `kernel/visualization/fieldMapSurfaceStore.ts`; commands and the Inspector
  read that single owner. The Inspector reports `Live` only for a frame whose
  meta, scalar and raster identities match.

Creating or editing an authored monitor remains an explicit Inspector
transaction. While that draft is active, the 3D viewport may show a
lightweight frame overlay. Apply commits the monitor through a revision-safe
`SceneDocument` transaction, updates canonical Python, selects the returned
monitor ID, and opens `field-map`. Discard leaves the session source and
authored model unchanged. Selecting `Default` later restores the session
slice controls without fabricating a persistent monitor.
Discard restores the committed monitor. A revision conflict must not overwrite
the scene.

The same semantic Inspector registry serves 3D and planar visualization
contexts for objects, regions, mesh parts, airbox, spatial result fields,
frequency/eigenmode fields when published, and monitor definitions. A `3D | 2D`
control changes the active center-surface command; it is not a second local
boolean. General material/physics forms do not acquire meaningless 2D copies.

## 5. Renderer and interaction contract

`field-map` uses a base raster canvas, an overlay canvas, and lightweight
DOM/SVG chrome for axes, colorbar, labels, selection, tool overlays (box-zoom
rectangle, crop rectangle and handles, ruler, node ring) and accessibility.
Colorization, contours, and glyph preparation may use one worker. There is no
React object per pixel/vector and no large typed array in React state.

Pointer handling branches on the active tool (§4.2). In `navigate`, drag pans
and double click fits; in the other tools a drag is handed to the tool
overlay. In every tool the wheel/pinch zoom is cursor anchored, Shift+drag
draws a profile, arrow keys pan, `+/-` zoom and `F`/`0` fit through the
`field-map.zoom-in`, `field-map.zoom-out` and `field-map.fit` commands. The
cursor position is published to `planarToolStore.setCursorUv` at most once per
animation frame and shown in the status bar; there is no hover-probe badge on
the canvas. Exact values come from the backend: the `inspect` tool requests
`/probe?nearest=node` (point value plus nearest FEM node or FDM cell centre,
ADR 0080 and note 0970 `eq-planar-nearest-node`) and a pinned reading resolves
the exact backend world coordinate and value. Draft position or thickness
interaction may use a bounded preview request and commits the target
resolution after pointer release.

Box zoom changes only `planar.interaction`; the crop changes the sampling
window. With `planar.crop` set, every planar request of the view (each
visible layer, the base `meta` sample, mesh overlay, probe, profile, PNG and
CSV export) carries the four `window_*` parameters from
`planarWindowParams(crop)`; the axes read `frame.bounds_uv_m` of the window
and the crop chip shows the range against `frame.full_bounds_uv_m`
(note 0970 `eq-planar-sampling-window`). Only visible field layers create data
requests; the composition draws the list from its end to its start so the
first layer is on top.

Scalar `auto` and `symmetric` range ignores empty/masked/non-finite samples;
empty input produces deterministic zero range. `raster_opacity` is passed to
the base raster only and has no implicit clamp. Vectors expose
world/monitor components and an explicit normal indicator. Contours stop at
masked cells. Mesh overlays use physical monitor coordinates. `FMCS v4`
segment classes distinguish `mesh_interior`, exact `target_boundary`, and
`unclassified_degenerate`; v3 has no exact-boundary interpretation and is
rendered only as degraded geometry. FDM `monitor_target` dla `plane`, `slab`
i `depth` używa osobnego `FMFG v1`: proceduralnych segmentów przecięcia
wybranych komórek structured grid z centralną płaszczyzną monitora. Deskryptor
oznacza `geometry_source=fdm_structured_grid`, a `boundaries` pozostaje
wyłączone z `target_boundaries_unavailable`. `FMFG` nie może być interpretowany
jako `FMCS`, prostokąt monitora ani dokładna topologia granicy targetu. Surface
folds or overlaps remain visible degraded diagnostics.

## 6. Tests

Required tests:

- center tab host renders all tab triggers but mounts only one active module;
- stale persisted active tab ids repair to a registered module;
- committing an authored monitor draft updates canonical model/script and switches
  `activeViewportMainModuleId` to `field-map`;
- the typed API exposes the cross-section PNG endpoint as a binary resource;
- object URLs created by the image surface are revoked on replacement/unmount;
- `field-map` reads planar resources only through `ControlRoomApi`
  and resource hooks, preserves ETag/query identity, and handles empty masks;
- the field-map renderer is created once, remains idle without changed
  revisions or controls, resizes by observer, and is disposed on tab switch;
- switching between `viewport-3d`, `field-map`, and `analysis-plots` mounts only
  the active heavy surface and keeps memory growth bounded;
- browser smoke confirms one-click/shortcut opening, scalar/slab/surface images,
  PNG export resources, and no removed live 2D or static cross-section center module;
- manufactured FDM/FEM tests prove plane, slab, depth, surface, vector-basis,
  occupancy, and refinement-invariant measure weighting;
- range-state migration/validation, `FMCS v4` exact-boundary decoding, v3
  degraded compatibility, `FMFG v1` FDM grid decoding, fail-closed codec
  dispatch, niedostępne FDM boundaries oraz representation ETag
  invalidation are covered below renderer integration;
- object/region/part/airbox/result/monitor inspector coverage uses one registry
  with independent 3D and planar profiles;
- schema-9 persisted planar state without `target_overrides` restores schema 10
  with an empty list and the unchanged global fallback;
- replacement PATCH, omitted-field no-op, removal-to-fallback, duplicate/
  unsupported/unknown-target rejection, and expected-revision conflict are
  covered by API tests;
- Airbox/object/part overrides remain exact and independent through optimistic
  state and HTTP ACK, while 3D overrides stay byte-identical;
- wireframe-only edits change visualization-state identity but leave
  `sample_token` plus scalar/vector/mask/mesh-overlay requests and ETags
  unchanged;
- a 100-switch browser audit proves no increasing worker/listener/canvas count,
  no idle RAF, bounded heap, and a healthy 3D WebGL context after returning.

### 6.1 Toolbar, field layers, crop and node probe (ADR 0080)

Vitest (frontend; run only if the unit-test compilation ban does not cover
Vitest, otherwise listed as NOT RUN):

- `kernel/visualization/planarToolStore.test.ts`: initial and server
  snapshots have `activeTool === "navigate"`; `setActiveTool("crop")` notifies
  subscribers once; a tool change clears `cropDraft`.
- `modules/field-map/fieldMapToolCommands.test.ts`: each `field-map.tool.*`
  has `isActive` matching the store; `field-map.toggle-vectors` patches
  `{ planar: { layers: { ...current, vectors: !current.vectors } } }`; every
  command is disabled with a `disabledReason` when the active module is not
  `field-map`; `H B C I P R F` collide with no shortcut of
  `fieldMapViewCommands`; `zoom-in`/`zoom-out` multiply/divide
  `interaction.zoom` by 1.25 around the view centre within the wheel limits.
- `components/PlanarToolbar.test.tsx`: `role="toolbar"` with
  `aria-label="2D view tools"`, four groups, a six-item tool `radiogroup`;
  clicking Crop runs `field-map.tool.crop` and the active tool has
  `aria-checked="true"`; the vectors toggle `aria-pressed` follows
  `planar.layers.vectors`; the 2D DOM contains no "Quantity", "Scope",
  "Free section" or "Single layer" labels.
- `components/PlanarStatusBar.test.tsx`: dragging the slider does not call
  `onPositionCommit` before release and calls it once on release; caption
  `x: 0.00 nm · 1,699 el.` from `section.resolved_coordinate_m` and
  `cut_element_count`; `—` when `cursorUv === null`; no "No sample" text; the
  crop chip is shown only with a crop and its button calls `onClearCrop`.
- `model/planarToolGeometry.test.ts`: `interactionForUvRect` gives zoom 1 and
  zero pan for the full bounds, zoom 2 for the centred half rectangle, and
  keeps a rectangle of another aspect ratio fully visible;
  `measureSegment` of (3 nm, 4 nm) gives 5 nm and ≈ 53.13°;
  `normalizeUvRect` orders corners for any drag direction.
- `renderer/PlanarToolOverlay.test.tsx`: box zoom below 4 px sends no patch,
  above sends one `interaction` patch on release and returns to `navigate`;
  the ruler label uses axis units and `Esc` clears it; crop commit (Enter or
  ✓) calls `queuePlanarCropPatch` once in metres, `Esc` sends nothing and
  clears the draft, a sub-4 px rectangle cannot be committed and ✓ shows a
  `disabledReason`, a rectangle beyond `full_bounds_uv_m` is clamped.
- `VisualizationRegistrySyncController.test.ts`: `queuePlanarCropPatch(null)`
  sends `{ planar: { crop: null, interaction: { zoom: 1, pan_u_m: 0,
  pan_v_m: 0 } } }`; a plane change with an active crop carries `crop: null`.
- `planarFieldResources.test.ts` / `fieldMapDataPlan.test.ts`:
  `planarWindowParams(null)` is `{}` and a crop gives the four `window_*`
  keys; window parameters are added to every layer and to the base sample;
  CSV and PNG export use the same window; `field-map.fit` fits the crop and
  `field-map.clear-crop` clears it; in the `layers` model the base sample
  requests only `meta` (plus `mesh-overlay` with the mesh mask on).
- `hooks/usePlanarNodeProbes.test.ts`: requests only layers whose local mask
  is occupied at the point, in list order, at most 4; two moves 20 ms apart
  give one request per layer for the second position; a late response for an
  old position is dropped and the old request aborted; `enabled === false`
  sends nothing.
- `components/PlanarNodeReadout.test.tsx`: an `ok` block shows the node
  number, coordinates in axis units, both distances and the value with unit,
  vectors as three components; `unsupported_operator` shows the point value
  and the thickness-averaging reason; click pins, the pinned reading survives
  a tool change and has copy and close, `Esc` in `inspect` closes it; the ring
  is drawn at `(node.u_m, node.v_m)` with "Δ from plane" when
  `normal_offset_m !== 0`.
- `modules/inspector/visualization/planarFieldLayers.test.ts`,
  `PlanarFieldLayerList.test.tsx`, `PlanarTargetFieldSection.test.tsx`,
  `PlanarVisualizationSection.test.tsx`, `PlanarSectionPlaneSection.test.tsx`,
  `PlanarCropViewSection.test.tsx`, `InspectorModule.test.tsx`,
  `ribbonStructure.test.ts`: the layer-list, inspector and ribbon cases of
  spec 23 §5 and spec 12 §5; "Fit view" runs `field-map.fit` while 2D is
  active and `viewport-3d.fit` otherwise; the 2D section registers a
  `liveViewport` edit session and "Reset display" keeps `source` and
  `default_slice`.

Rust (API; written, **NOT RUN** while unit-test compilation is banned): the
layer-model, migration and crop tests of plan Task 2, the window tests of
note 0970 gate PM-N30 and the nearest-node tests of gate PM-N31.

Browser smoke (`apps/control-room/scripts/smoke-viewport-2d.mjs`, asserting
`data-planar-*` attributes and DOM; a result without run evidence is NOT
VERIFIED):

1. the toolbar has six tools and there are no Quantity/Scope/Free section
   controls above the surface;
2. box zoom increases `planar.interaction.zoom`; `F` restores 1;
3. after a crop commit `meta.frame.bounds_uv_m` equals the rectangle,
   `sample_token` changes and the axis ticks show the crop range; `×` in the
   status bar restores the full bounds;
4. inspect over a FEM object shows a block with a node number; the same
   scenario on an FDM scene shows a cell centre;
5. adding an object layer and an Airbox layer, hiding one and reordering keeps
   the number of legend cards equal to the number of visible layers;
6. the toolbar vectors mask hides vectors of all layers without changing the
   layer flags;
7. the status-bar position slider changes `default_slice.position_fraction`
   once per release;
8. a session saved before the change (fixture `legacy`) opens with the same
   image.

`scripts/smoke-inspector.mjs` adds the Object and Airbox layer-list regression:
no panel remount and no scroll reset after a mutation.
