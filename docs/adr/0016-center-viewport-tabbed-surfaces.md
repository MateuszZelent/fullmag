# ADR 0016: Center Viewport Tabbed Surfaces

- Status: accepted
- Date: 2026-05-30; amended 2026-08-03, 2026-10-16

## Context

The control room currently supports a live WebGL `viewport-2d` cross-section surface in the auxiliary viewport slot. This duplicates the GPU/WebGL lifecycle next to `viewport-3d`, competes for memory and rendering budget, and forces the workspace to keep a secondary dock column for a workflow that is primarily mesh verification and export.

The product invariant remains one unified workspace and one resource-first browser contract. Cross-section computation belongs to v2 meshing resources; the frontend should choose a rendering surface without inventing alternate mesh semantics or bypassing OpenAPI/resource hooks.

## Decision

`viewport-main` becomes a tabbed center surface host. The active center surface is mounted. A second surface is mounted only when the user explicitly opens it as the visible companion in a split view. `viewport-3d` remains the only default WebGL/R3F surface. Mesh cross-section visualization moves from the live `viewport-2d` WebGL module to a server-rendered PNG resource:

`GET /v2/sessions/current/meshing/meshes/shared-domain/cross-section/image`

The existing binary cross-section resources stay authoritative for statistics and future advanced tooling:

- `/v2/sessions/current/meshing/meshes/shared-domain/cross-section`
- `/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality`

`viewport-aux` remains a valid kernel slot for future optional modules, but mesh cross-section workflows no longer register or focus an auxiliary viewport module.

### Amendment — 2026-10-16: Explicit Visible Companion Lifecycle

The mounted center-surface set is the active module plus an explicitly opened, visible companion, when present. A visible module keeps the same mounted instance when its primary/companion role or split placement changes. Closing a companion unmounts it, and unopened modules outside the visible set remain unloaded. The 3D viewport keeps its WebGL canvas and viewport-local resources active while it is visible in either role; it unmounts when it leaves the visible set. This amendment does not promise background pausing for arbitrary modules.

The center host now has two chart surfaces with separate ownership. **Live Charts**
(`live-charts`) follows active-run scalar time series. **Analysis**
(`analysis-plots`) opens an **explicit selected dataset**, run, stage, or artifact
for postprocessing and never adopts the active table tail implicitly. **Quick
Chart** is not a center surface: it is active-tab-only content owned by
`transport-footer` in `panel-bottom`, so it can coexist with the 3D viewport.

## Consequences

- Switching away from `viewport-3d` unmounts `Viewport3DModule` only when it is neither the active surface nor the visible companion. CSS hiding must not substitute for unmounting surfaces outside the visible set.
- `Live Charts` and `Analysis` are independent registered center modules; neither imports the other's store or controller.
- Quick Chart imports neither center module and does not change the active center surface.
- Center surfaces outside the visible active/companion set must not keep resource hooks, WebGL canvases, animation frames, object URLs, workers, or large render buffers alive.
- Realtime remains invalidation-only. HTTP v2 resources remain the source of truth for cross-section images, binary geometry, binary quality, visualization state, and client acknowledgements.
- Cross-section image generation is cacheable by ETag and independent of browser GPU capacity.
- Loss of live 2D polygon hover is accepted for the first replacement. Inspector statistics remain available from FMCS/FMQS resources. A future image-map or click-to-query endpoint requires a separate design.

## Implementation Obligations

- Add the PNG resource to backend routing, OpenAPI v2, generated frontend paths/types, `ControlRoomApi`, and a resource hook that owns object URL lifecycle.
- Add a generic `ViewportTabHost` in kernel layout. It reads manifests for `viewport-main` and mounts the active manifest plus only an explicitly opened, visible companion.
- Persist the active center surface in `LayoutController` state.
- Replace `viewport-2d` registration and commands with `cross-section-image` commands and module registration.
- Remove `viewport-2d:fit-requested` when the WebGL module is deleted.
- Add browser smoke and memory audits proving that, while `viewport-3d` is outside the visible active/companion set, there is no mounted 3D canvas, no `Viewport3DModule` render measures, no 3D-only resource loads, and no 3D client acknowledgements.

## Validation

- Backend route tests cover PNG magic bytes, `image/png`, invalid query rejection, `204`, ETag, and `304`.
- Frontend API/resource tests cover facade use, ETag/304 handling, cache keys, and `URL.revokeObjectURL`.
- Layout tests prove inactive tab modules are not mounted and stale active surface ids fall back safely.
- Browser smoke proves zero active 3D canvas nodes when `viewport-3d` is outside the visible set, and exactly one WebGL canvas while it is visible as the active surface or companion. Closing the companion unmounts it; reopening creates one healthy canvas, and unopened modules remain unloaded.
- API hygiene checks prove no direct component `fetch()` and no hand-built `/v2/...` strings in modules.

## Rollback

The backend binary FMCS/FMQS resources remain unchanged. If the image renderer is unsafe, the cross-section image module can be disabled by removing its manifest while keeping `viewport-3d` as the only center surface. Reintroducing live WebGL 2D rendering would require a new ADR and the same visible-only lifecycle proof as `viewport-3d`.
