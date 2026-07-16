# Semantic Render Target–Explorer Invariant Design

**Status:** Approved  
**Date:** 2026-07-14

## Problem

The 3D viewport currently allows transport carriers to become UI identities.
For example, picking the Airbox carrier can select `part:__air__`, while the
Explorer contains only `model:airbox`. Magnetic FEM parts can likewise select a
mesh-part id instead of their authored object. Because renderer, Inspector, and
Explorer resolve these identities independently, one physical entity can gain
multiple visualization overrides and multiple overlapping render passes.

## Invariant

Every semantic and pickable 3D render target has exactly one Explorer node.
Every viewport pick selects that node. A render target without such an address
is rejected before scientific passes or picking are created.

Non-semantic helpers—grid, axes, lights, gizmos, camera helpers, bounds helpers,
and selection shells—are explicitly non-pickable and are outside this invariant.

## Canonical catalog

One kernel/domain function builds entries with:

- `targetId` and `targetKind` for visualization state;
- `explorerNodeId` and `explorerTabId` for navigation;
- zero or more `carrierIds` used only for topology, fields, and hit metadata;
- a stable label and ownership provenance.

Explorer, viewport adapters, picking, and Inspector consume the same resolver.
They must not reconstruct target identities independently.

Canonical mappings are:

- Airbox carriers with role `air` or `airbox` map to target `airbox` and node
  `model:airbox`;
- a FEM part whose canonical `object_id` or `geometry_id` exists in the current
  scene maps to `object:<id>` and `model:object:<id>`;
- regions map to `region:<object>:<region>` and the authored region node;
- a genuinely orphaned renderable part maps to its part target and a visible
  `model:mesh:unassigned:<encoded-part-id>` node;
- the FDM domain pick maps to the visible Universe node;
- stale owner ids that do not exist in the current scene are never accepted as
  object targets.

`__air__`, `object:__air__`, and Airbox mesh parts are compatibility/data-plane
identities only. They never create parallel scene objects, Explorer rows, or
visualization overrides.

## Fail-closed rendering

The render-model boundary admits a semantic carrier only when the catalog can
resolve it to an Explorer node. Rejected carriers create a bounded
`unaddressable-render-target` diagnostic containing carrier id and reason. They
receive no surface, shader, wireframe, point, vector, or picking pass.

Orphan parts are not silently discarded. They become explicit `Unassigned mesh
parts` children in the Model Explorer and are renderable only through those
fallback entries.

## Selection and reveal

The selection ref stores semantic identity separately from hit metadata:

- `nodeId` is always the Explorer node id;
- `visualizationTargetId` is always the canonical semantic target id;
- `carrierPartId` and `boundaryFaceIndex` are optional transport metadata.

When a viewport selection changes, Explorer switches to the Model tab, expands
the selected node's ancestors, keeps the selected path visible even under an
active text filter, scrolls the row into view, and marks it active. Repeated
identical selections are value-deduplicated.

## Resource/API boundary

HTTP v2 scene, mesh manifest, and visualization resources remain authoritative.
No new endpoint or WebSocket state channel is introduced. Backend visualization
target projection excludes synthetic Airbox identities and treats a part as
owned only when its canonical owner exists in the current scene; otherwise it
is a legal orphan fallback.

## Verification

- catalog tests cover Airbox roles, owned magnetic parts, stale owners, explicit
  orphan fallbacks, primitives, regions, and FDM domain addressing;
- a composed contract test builds scene, manifest, Explorer tree, and render
  targets, then proves every pickable target has exactly one Explorer node;
- selection tests prove `part:__air__` selects `model:airbox` and owned FEM parts
  select their authored object;
- Explorer tests prove tab switch, ancestor expansion, filter preservation,
  scrolling, and active-row state;
- API tests prove exactly one Airbox and correct stale-owner fallback behavior;
- browser smoke clicks Airbox, a magnetic body, and an orphan fallback and
  asserts the corresponding Explorer rows are visible and selected;
- full typecheck, lint, tests, React Doctor, and viewport WebGL lifecycle gates
  remain green.

