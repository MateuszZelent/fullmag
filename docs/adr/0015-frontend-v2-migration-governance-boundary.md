# ADR 0015 - Frontend v2 Migration Governance Boundary

**Date:** 2026-05-22
**Status:** Accepted for active migration only
**Relates:** `docs/adr/0013-frontend-v2-module-kernel.md`, `docs/specs/frontend-v2/01-module-kernel-architecture.md`, `docs/specs/frontend-v2/20-agent-governance.md`

## Context

Frontend v2 is active in `apps/control-room`, but it is still mid-migration. The app already has the intended kernel/module/API spine, while several files exceed the review-size thresholds defined in the module-kernel spec.

The thresholds remain correct. The exception is the migration state, not the target architecture. Splitting every oversized file before the current governance repair would expand the task into a broad product refactor and increase the risk of breaking viewport, inspector, runtime command, and visualization behavior at the same time.

## Decision

Existing oversized frontend v2 files may remain temporarily during the migration when all of the following are true:

- the file is already part of `apps/control-room` before this ADR;
- the file does not import across module boundaries;
- the file remains covered by the relevant local tests or hygiene checks;
- the owning module keeps accepting only scoped fixes, not new unrelated behavior;
- the file is split before cutover unless a newer ADR supersedes this one.

No new oversized file is approved by this ADR. Any new file crossing the thresholds in `01-module-kernel-architecture.md` needs either an immediate split or a separate ADR update.

## Current Exception Classes

Measured on 2026-05-22, excluding generated OpenAPI files and tests:

| Class | Current examples | Migration reason | Removal criterion |
|---|---|---|---|
| Ribbon command catalog | `src/modules/ribbon/ribbonContributions.tsx`, `src/modules/ribbon/ribbonCommands.ts` | The command registry is centralizing previously scattered menu/ribbon behavior. | Split by contribution group after command parity stabilizes. |
| Viewport render/adapters | `src/modules/viewport-3d/viewport3dRenderModel.ts`, `src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`, `src/modules/viewport-3d/layers/*` | The 3D viewport is still converging render-model, resource, camera, overlay, and lifecycle contracts. | Split only along already-proven layer/model boundaries, preserving one R3F canvas and demand rendering. |
| Inspector panels/models | `src/modules/inspector/panels/*` | Inspector migration is absorbing geometry, material, mesh, visualization, study, and magnetic-texture workflows from legacy without reintroducing a god context. | Split by panel model, form sections, and transaction helpers before cutover. |
| Runtime/resource command adapters | `src/kernel/runtime/studyRuntimeCommandContributions.ts`, `src/kernel/resources/*`, `src/kernel/authoring/*` | Runtime commands and resource invalidation are being consolidated behind the command registry and resource-hook layer. | Split by command family after the resource contracts stop changing. |
| API facade and visualization controllers | `src/kernel/api/ControlRoomApi.ts`, `src/kernel/visualization/*` | The facade and visualization registry are central boundaries that replace direct endpoint strings and per-component display state. | Split by resource family/controller responsibility after OpenAPI/resource parity is stable. |

The full 2026-05-22 inventory is recorded in `docs/reports/22.05.2026/control-room-frontend-v2-governance-report.md`.

## Consequences

- The module-size thresholds stay active for new work.
- Current oversized files are not treated as cutover-complete.
- Reviews must reject broad feature additions to the exception files unless the change also reduces size or ownership.
- Cutover acceptance still requires the exception inventory to shrink or be superseded by a narrower ADR.
