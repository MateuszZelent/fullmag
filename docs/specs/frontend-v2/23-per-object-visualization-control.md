# Frontend v2 - Per-Object Visualization Control

**Status:** Object/part target overrides are backend-backed for display, shader/wire/vector style, arrow budget, and arrow length; airbox display plus arrow budget/length are backend-backed through `layers.airbox` and `vector_style`; strict active-session browser smoke is covered with a live local runtime
**Date:** 2026-05-11

## 1. Goal

Every renderable visualization target can be configured independently:

- each scene object, including multi-ferromagnet models;
- airbox visualization;
- future 2D slice/projection views for the same targets.

The user must be able to choose, per target, whether the viewport shows shader surface, vectors, wireframe, points, visibility, opacity, arrow budget, and arrow length. The View ribbon `Per selected object` group, explorer `Visualization` nodes, inspector panel, and viewport renderer all read and write the same target registry.

## 2. Target Identity

Canonical target ids:

| Target | Id |
|---|---|
| Scene object | `object:<object_id>` |
| Airbox | `airbox` |
| Mesh part fallback | `part:<part_id>` only when no object id exists |
| Future 2D mode-specific override | `<target_id>:2d:<mode>` if required by the 2D backend |

Object ids come from scene/model resources and mesh manifests. Airbox is never treated as a scene object.

When a new object is committed but no current mesh exists yet, the target id still exists as `object:<object_id>`. Its default display uses primitive surface plus simplified wireframe fallback in Geometry context. Target visualization state must not imply that solver topology or field data exists.

## 3. State Ownership

The owner is the v2 visualization resource. Object and part display/style overrides are stored in `visualization/state.overrides`, including `vector_budget` and `vector_length_scale`. Airbox display reads and writes `visualization/state.layers.airbox` through the typed v2 facade; airbox arrow budget is `layers.airbox.vectors.density`, while airbox arrow length and vector thickness are persisted as the `airbox` target override style (`vector_length_scale`, `vector_thickness`) rather than global `vector_style`.

The kernel visualization controller is only the UI-side resolver/cache around the v2 resource. It may preserve immediate local feedback while a revision-driven refetch is pending, but it must not become a second persistence model for fields already present in the v2 contract.

Global camera state is not a per-target override. It belongs to `visualization/state.camera`, is shared by all clients in the session, and changes through HTTP patches followed by WebSocket resource invalidation.

The registry stores only small display preferences:

- visible;
- shader surface visible;
- wireframe visible;
- points visible;
- vectors visible;
- opacity percent;
- arrow budget;
- arrow length scale;
- geometry scope for pass sampling (`surface` or `full`);
- render mode summary for ribbon menus.

It must not store topology, field arrays, mesh manifests, scene documents, or backend runtime snapshots.

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

- shows the selected target id and whether the target is object, airbox, or part fallback;
- provides toggles for shader, wireframe, points, vectors, visibility, and opacity;
- exposes whether mesh/vector passes sample only boundary surface nodes or the full target volume;
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
- no-session smoke must allow an absent runtime API only when `CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1`; active-session smoke may tolerate explicitly enumerated optional 404 resources for primitive-only sessions that have not built a mesh or run yet, but must still fail on missing `model/scene`, failed scene transactions, or websocket invalidation.

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
