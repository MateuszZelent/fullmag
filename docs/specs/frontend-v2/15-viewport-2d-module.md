# Frontend v2 - Planar Field Map and 2D Analysis Surfaces

**Status:** Active production contract; implementation and qualification in progress
**Date:** 2026-07-18
**Decision records:** `docs/adr/0016-center-viewport-tabbed-surfaces.md`,
`docs/adr/0020-planar-field-map-and-monitor.md`

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
facade and resource hooks. Existing slice/projection resources remain
compatibility adapters during migration. It supports heatmap, contours, bounded
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
ETag do change, and styled `render.png` identity includes the effective target
wireframe. Three-dimensional target overrides remain independent. Region,
FDM-domain, and native-layer overrides remain unsupported until the canonical
backend registry publishes them.

The backend performs physical sampling. FDM uses explicit cell reconstruction
and cell-intersection measure. FEM P1 uses barycentric point evaluation and
conservative tetrahedron/boundary measure. Node count is diagnostics only.
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
DOM/SVG chrome for axes, colorbar, labels, selection, and accessibility.
Colorization, contours, and glyph preparation may use one worker. There is no
React object per pixel/vector and no large typed array in React state.

Wheel/pinch zoom is cursor anchored; drag pans; double click and `0` fit; arrow
keys pan; `+/-` zoom. Hover probe is renderer-local and frame-throttled. A
pinned probe resolves exact backend world coordinate/value. Draft position or
thickness interaction may use a bounded preview request and commits the target
resolution after pointer release.

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
- `field-map` reads slice/projection resources only through `ControlRoomApi`
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
- wireframe-only edits change visualization-state and `render.png` identity but
  leave `sample_token` plus scalar/vector/mask/mesh-overlay requests and ETags
  unchanged;
- a 100-switch browser audit proves no increasing worker/listener/canvas count,
  no idle RAF, bounded heap, and a healthy 3D WebGL context after returning.
