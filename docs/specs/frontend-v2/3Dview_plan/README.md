# 3D View Plan - Canonical Index

**Status:** canonical implementation plan for frontend-v2 Phase 5.
**Decision date:** 2026-05-11.

Use only these files as implementation inputs:

1. `implementation_plan.md`
2. `scratch/01-viewport-architecture.md`
3. `scratch/02-render-pipeline.md`
4. `scratch/03-multi-viewport-layout.md`
5. `scratch/04-domain-adapters.md`
6. `scratch/05-testing-performance.md`
7. `audit-2026-05-11.md`

Files named `*.resolved*`, `*.metadata.json`, and `*:Zone.Identifier` are imported working artifacts. They are not implementation authority. If they disagree with the files above, ignore them.

## Locked Decisions

1. Phase 5 implements one 3D viewport, not a split or multi-pane viewport.
2. The renderer uses one R3F `<Canvas frameloop="demand">`.
3. R3F does not remove the need for explicit resource ownership. Geometry, materials, textures, worker buffers, decoded binary resources, and render buffers must be tracked and released.
4. HTTP v2 resources are the source of truth. WebSocket is invalidation only.
5. Modules consume only `ControlRoomApi` facade methods and resource hooks. No module-level `fetch()` and no hand-built `/v2/...` strings.
6. FDM and FEM share one render model, but adapters must explicitly handle topology, field location, object/part/airbox mapping, units, scope, LOD, and probing limits.
7. Field quantity switching must never rebuild topology unless a topology revision changed.
8. Field-value probing is not part of Phase 5 unless a backend probe contract is added first. Phase 5 picking emits canonical selection and hit metadata only.

