# Frontend v2 - Per-Object Visualization Control

**Status:** Object/part target overrides are backend-backed for display, shader/wire/vector style, arrow budget, and arrow length; airbox display plus arrow budget/length are backend-backed through `layers.airbox` and `vector_style`; strict active-session browser smoke is covered with a live local runtime
**Date:** 2026-05-11

## 1. Goal

Every renderable visualization target can be configured independently:

- each scene object, including multi-ferromagnet models;
- each realized object region, when it has a mesh-backed carrier;
- airbox visualization;
- future 2D slice/projection views for the same targets.

The user must be able to choose, per target, whether the viewport shows shader surface, vectors, wireframe, points, bounds, visibility, each pass opacity, arrow budget, and arrow length. The View ribbon `Per selected object` group, explorer `Visualization` nodes, inspector panel, and viewport renderer all read and write the same target registry.

## 2. Target Identity

Canonical target ids:

| Target | Id |
|---|---|
| Scene object | `object:<object_id>` |
| Object region | `region:<object_id>:<url_encoded_region_id>` |
| Airbox | `airbox` |
| Mesh part fallback | `part:<part_id>` only when no object id exists |
| Future 2D mode-specific override | `<target_id>:2d:<mode>` if required by the 2D backend |

Object ids come from scene/model resources and mesh manifests. Airbox is never treated as a scene object.
The synthetic mesh object `__air__` and the mesh part `part:__air__` are data-plane
carriers only and must not be published as additional visualization targets.
Selection of an air-role mesh carrier resolves to the canonical `airbox` target.
When loading persisted state, the backend canonicalizes legacy
`object:__air__`, `part:__air__`, and bare `__air__` overrides to `airbox` and
keeps at most one override, with an existing canonical `airbox` entry taking
precedence. A mesh part is published as a fallback target only when it is an
orphan carrier with no scene-object mapping.

This identity repair is a prerequisite for Visualization Debug. Debug always
observes the canonical user-facing target (`airbox` for Airbox) and reports its
mesh/data-plane carriers separately (`part:__air__` for the current Airbox
manifest). It must not expose the carrier as a second selectable target or
reintroduce synthetic `object:__air__` identity. The target registry filtering,
role-first mesh-part resolver, and canonical Airbox scoped vector path must be
in place before the Debug inspector is enabled.

Region target ids refer to authored object-region intent, but physical field
visualization for a region is available only when the current mesh manifest maps
that region to realized `mesh_part_ids`. The near-term data-plane carrier for a
region is therefore `region target -> manifest region -> mesh part id(s)`, not a
frontend-only `scope_kind=region`. If no manifest-backed mesh parts exist, region
field visualization must be reported as unavailable or degraded; authored and
projection overlays may still be shown as diagnostic overlays.

When a new object is committed but no current mesh exists yet, the target id still exists as `object:<object_id>`. Geometry context may show a viewport-local, monochrome `Primitive` fill derived from authored geometry/bounds, plus independent wireframe and bounds passes. Primitive is suppressed as soon as the object has a current mesh carrier. Primitive color, opacity, and visibility are viewport preferences, never physical field state or persisted target overrides. Target visualization state must not imply that solver topology or field data exists.

At initial resolution a region inherits every effective visualization setting
from its parent object. Only explicit sparse region overrides replace inherited
values. This includes visibility, passes, quantities, palettes, colors, and
per-pass opacity. Selecting a region must not mutate this state or silently
enable a diagnostic overlay.

## 3. State Ownership

The owner is the v2 visualization resource. Object and part display/style overrides are stored in `visualization/state.overrides`, including `vector_budget` and `vector_length_scale`. Airbox display reads and writes `visualization/state.layers.airbox` through the typed v2 facade; airbox arrow budget is `layers.airbox.vectors.density`, while airbox arrow length and vector thickness are persisted as the `airbox` target override style (`vector_length_scale`, `vector_thickness`) rather than global `vector_style`.

The kernel visualization controller is only the UI-side resolver/cache around the v2 resource. It may preserve immediate local feedback while a revision-driven refetch is pending, but it must not become a second persistence model for fields already present in the v2 contract.

The separate `VisualizationDebugController` is likewise not a visualization
state owner or server-resource cache. It holds only bounded, immutable,
opt-in observations of the currently mounted renderer. HTTP v2 resources remain
the source of truth; realtime events remain invalidation-only. Debug must not
extend the status resource or WebSocket payload with field, topology, render,
or snapshot data.

Global camera state is not a per-target override. It belongs to `visualization/state.camera`, is shared by all clients in the session, and changes through HTTP patches followed by WebSocket resource invalidation.

The registry stores only small display preferences:

- visible;
- shader surface visible;
- wireframe visible;
- points visible;
- vectors visible;
- independent surface, wireframe, point, vector, and bounds opacity;
- arrow budget;
- arrow length scale;
- geometry scope for pass sampling (`surface` or `full`);
- render mode summary for ribbon menus.

It must not store topology, field arrays, mesh manifests, scene documents, or backend runtime snapshots.

Diagnostic region overlay mode is not the same state as region field
visualization. Authored, realized, and comparison overlays describe region
geometry/realization status. Diagnostics are viewport-local, off by default,
and outline-only; their source selection (`auto`, `authored`, `realized`, or
`both`) is independent from visibility. They must not create a filled surface or
be interpreted as `m`, `mx`, HSL, or other physical field coloring. Physical
region coloring always uses the normal manifest-backed mesh-part field path.

### 3.1 Configured vs effective display state

Target display state has two distinct meanings:

- **configured state**: the stored pass preferences, for example an airbox can keep
  `wireframe=true` while the whole target is hidden;
- **effective state**: the state shown to the user and consumed by active display
  controls after the target master visibility is applied.

When `visible=false`, shader, wireframe, points, vectors, and frame controls must
render as inactive and be disabled in both the View ribbon and inspector. Their
configured values are preserved so they can be restored when the target is made
visible again. This rule prevents the visible UI drift where `View -> Airbox` says
`off` while `Explorer -> Airbox Visualization` still appears to have an active
wireframe pass.

For airbox, backend-owned fields (`visible`, surface, wireframe, points, vectors,
opacity, vector budget, and vector length scale) are written only to
`visualization/state.layers.airbox` and `visualization/state.vector_style`. The
temporary kernel controller may store only local fields that are not present in
the v2 contract for airbox-specific styling.

## 4. UI Contract

Explorer:

- each object node has a `Visualization` child;
- the universe or airbox branch exposes `Airbox Visualization`;
- selecting these nodes changes inspector focus only. Selection does not silently switch viewport mode.

Inspector:

- shows the selected target id and whether the target is object, region, airbox,
  or part fallback;
- provides toggles for shader, wireframe, points, vectors, visibility, and opacity;
- exposes whether mesh/vector passes sample only boundary surface nodes or the full target volume;
- for region targets, exposes whether field visualization has a realized
  mesh-part carrier, and shows an unavailable/degraded state for authored-only
  or projection-only regions;
- auto-applies because these are safe display preferences;
- includes reset/clear override action.

Ribbon:

- `View -> Per selected object` reads the selected target;
- controls are enabled only when selection resolves to object, airbox, or part target;
- values update immediately when selection changes;
- changes update the registry and the inspector observes the same values.

Viewport:

- 3D object and airbox layers resolve the registry during render-model/layer construction;
- a target setting update dirties only affected display layers;
- topology rebuilds happen only for topology revisions, not for style toggles;
- vector glyph visibility can be independent per target when full-domain vector data is available.
- wireframe display must use the same geometry scope vocabulary as vectors, even when the renderer chooses a bounded fallback for very large full-volume meshes.
- vector glyph sampling must respect the target geometry scope: boundary-surface nodes for `surface`, the full target node selection for `full`.
- region target rendering resolves through manifest `mesh_part_ids`; projection
  membership and authored primitive overlays are diagnostic-only unless a future
  API explicitly promotes them to a field-capable carrier.
- no-session smoke must allow an absent runtime API only when `CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1`; active-session smoke may tolerate explicitly enumerated optional 404 resources for primitive-only sessions that have not built a mesh or run yet, but must still fail on missing `model/scene`, failed scene transactions, or websocket invalidation.
- renderer, Inspector, picker, and Explorer consume one semantic target address:
  `visualizationTargetId` identifies display state, `nodeId` identifies exactly
  one Explorer row, and `carrierPartId` is data-plane metadata only;
- a semantic/pickable target without an Explorer address fails closed before
  surface, shader, wireframe, point, vector, or picking passes are created;
- `__air__` and air-role scene objects never create object/part targets beside
  canonical `airbox`; stale object ownership is accepted only when the owner
  exists in the current scene, otherwise the part becomes an explicit Explorer
  fallback.

## 5. 2D Extension

2D uses the same target ids. The first 2D implementation should read base object/airbox visibility, shader/mesh overlay, vector visibility, and opacity from the registry. It may add mode-specific fields only when slice/projection semantics truly differ from 3D.

## 6. Tests

Required tests:

- explorer creates `Visualization` nodes under every object;
- inspector resolves object and airbox visualization panels;
- registry patch/reset preserves defaults and notifies subscribers;
- ribbon selected-target controls reflect the current selection target;
- viewport render helpers can build per-part surface indices and apply target display settings without rebuilding unrelated topology.
- backend `PATCH /v2/sessions/current/visualization/state` round-trips per-target `vector_budget` and `vector_length_scale` through `targets.*.settings`;
- no-session 3D smoke verifies visible canvas, non-lost WebGL context, and non-zero drawing buffer without requiring a live runtime;
- strict active-session 3D smoke verifies geometry authoring, `model/scene` refetch, websocket `resource.batch_changed`, explorer selection, viewport render-model/canvas delta, and inspector `SceneDocument`.
