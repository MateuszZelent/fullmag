# Frontend v2 - Per-Object Visualization Control

**Status:** Implementation target
**Date:** 2026-05-11

## 1. Goal

Every renderable visualization target can be configured independently:

- each scene object, including multi-ferromagnet models;
- airbox visualization;
- future 2D slice/projection views for the same targets.

The user must be able to choose, per target, whether the viewport shows shader surface, vectors, wireframe, points, visibility, and opacity. The View ribbon `Per selected object` group, explorer `Visualization` nodes, inspector panel, and viewport renderer all read and write the same target registry.

## 2. Target Identity

Canonical target ids:

| Target | Id |
|---|---|
| Scene object | `object:<object_id>` |
| Airbox | `airbox` |
| Mesh part fallback | `part:<part_id>` only when no object id exists |
| Future 2D mode-specific override | `<target_id>:2d:<mode>` if required by the 2D backend |

Object ids come from scene/model resources and mesh manifests. Airbox is never treated as a scene object.

## 3. State Ownership

The long-term owner is the v2 visualization resource. Until the backend exposes per-target fields, the frontend uses a kernel visualization controller as a temporary client-owned display-preference registry. Modules consume it through kernel hooks/controllers, not through cross-module imports.

The registry stores only small display preferences:

- visible;
- shader surface visible;
- wireframe visible;
- points visible;
- vectors visible;
- opacity percent;
- render mode summary for ribbon menus.

It must not store topology, field arrays, mesh manifests, scene documents, or backend runtime snapshots.

## 4. UI Contract

Explorer:

- each object node has a `Visualization` child;
- the universe or airbox branch exposes `Airbox Visualization`;
- selecting these nodes changes inspector focus only. Selection does not silently switch viewport mode.

Inspector:

- shows the selected target id and whether the target is object, airbox, or part fallback;
- provides toggles for shader, wireframe, points, vectors, visibility, and opacity;
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

## 5. 2D Extension

2D uses the same target ids. The first 2D implementation should read base object/airbox visibility, shader/mesh overlay, vector visibility, and opacity from the registry. It may add mode-specific fields only when slice/projection semantics truly differ from 3D.

## 6. Tests

Required tests:

- explorer creates `Visualization` nodes under every object;
- inspector resolves object and airbox visualization panels;
- registry patch/reset preserves defaults and notifies subscribers;
- ribbon selected-target controls reflect the current selection target;
- viewport render helpers can build per-part surface indices and apply target display settings without rebuilding unrelated topology.
