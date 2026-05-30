# Center Viewport Tabs and Server-Rendered 2D Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current live `viewport-2d` WebGL cross-section workflow with a tabbed center viewport architecture where only the active heavy surface is mounted, cross-section verification uses server-rendered PNG resources, and interactive 2D plots use a dedicated non-WebGL chart engine.

**Architecture:** `viewport-main` becomes a tabbed center workbench with mutually exclusive surfaces: 3D scene, cross-section image, and 2D plots. HTTP v2 resources remain authoritative; WebSocket remains invalidation-only; React components do not build endpoint URLs or call `fetch()` directly. The 3D viewport is unmounted when a non-3D tab is active so its WebGL context, buffers, workers, and large typed arrays can be released.

**Tech Stack:** Rust/Axum/OpenAPI v2 for server-rendered image resources, generated TypeScript transport plus `ControlRoomApi` facade, React 19/Next 16, shadcn-style shared primitives, Catppuccin token CSS, existing R3F only for the active 3D tab, server-side PNG rendering for mesh cross-sections, and a dynamically loaded Canvas/SVG chart engine for 2D analysis tabs.

---

## 1. Decisions

1. `viewport-aux` is retired for mesh cross-section viewing. The shell keeps the slot type for future optional modules, but cross-section workflows no longer register or focus a `viewport-aux` module.
2. `viewport-main` becomes tabbed. The active tab is the only mounted heavy visualization surface.
3. `viewport-3d` remains the only R3F/WebGL surface in the default control room.
4. Cross-section mesh visualization becomes a server-rendered image resource:
   `GET /v2/sessions/current/meshing/meshes/shared-domain/cross-section/image`.
5. Cross-section geometry and quality binary endpoints remain canonical data-plane resources for statistics, validation, and future advanced tools:
   - `/v2/sessions/current/meshing/meshes/shared-domain/cross-section`
   - `/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality`
6. Inspector edits remain the source of cross-section parameters. The inspector does not perform transport directly; it calls resource hooks/facade actions.
7. The image renderer includes axes, plane, position, metric, colorbar, quality min/mid/max, wireframe option, and mesh-node/intersection counts.
8. Default image resolution is `1024`, accepted values are `512`, `1024`, and `2048`. Invalid values return `400`.
9. The 2D chart engine is isolated behind a `ChartEngineAdapter`. The first implementation uses a lightweight dynamically loaded 2D engine for time-series/profile plots. Plotly is not part of the initial bundle; it can be introduced only as an advanced adapter behind the same interface when a concrete analysis workflow requires Plotly-specific interactions.
10. No direct component `fetch()`, no hand-built `/v2/...` strings in modules, no full snapshots over WebSocket, no heavy arrays in `status`.
11. `ViewportTabHost` is a generic kernel layout component. It reads eligible `viewport-main` module manifests from `ModuleRegistry`, uses manifest ids/titles for tab identity, and must not import `viewport-3d`, `cross-section-image`, `analysis-plots`, or any other module internals.
12. Inactive viewport tabs are not rendered. Hidden mounted panels, Radix `forceMount`, CSS-only tab hiding, and cached React subtrees are forbidden for heavy visualization surfaces.
13. The active `viewport-main` surface is kernel layout state, not local component state. Commands switch surfaces through `LayoutController`, then set slot focus if needed.
14. Global controllers may keep lightweight state while the 3D tab is inactive (`RealtimeInvalidationBridge`, `ResourceInvalidationController`, `VisualizationRegistrySyncController`, `CameraRegistryController`, `viewport3dStore`). They must not fetch 3D topology/field resources, rebuild 3D render models, send 3D client acks, or keep a WebGL canvas alive without a mounted `Viewport3DModule`.

## 2. Target User Experience

### 2.1 Center Viewport Tabs

The center viewport header shows compact tabs:

- `3D Scene`
- `Cross-Section`
- `Plots`

Behavior:

- Selecting `3D Scene` mounts `Viewport3DModule`.
- Selecting `Cross-Section` unmounts `Viewport3DModule` and mounts a lightweight image viewer.
- Selecting `Plots` unmounts `Viewport3DModule` and mounts a non-WebGL chart surface.
- Switching back to `3D Scene` remounts the 3D viewport, restores canonical camera state from `visualization/state`, and rebuilds GPU resources from current resource revisions.

### 2.2 Cross-Section Workflow

1. User clicks the existing View ribbon cross-section command.
2. Explorer selects `mesh.cross-section.draft`.
3. Inspector shows plane, position, metric, color scale, shrink, wireframe, and resolution controls.
4. The 3D tab shows the active cut frame while the user is still editing the draft.
5. User clicks `Generate Image`.
6. The app creates or updates a `CrossSectionPlot` entry, focuses the `Cross-Section` tab, and loads the PNG through `useCrossSectionImageResource`.
7. The image tab displays the PNG with resource revision, generation id, image resolution, and download action.
8. User can return to `3D Scene`; the 3D viewport remounts cleanly.

### 2.3 2D Plot Workflow

1. Scalar histories, profiles, line cuts, and future analysis curves open in the `Plots` tab.
2. The plot tab uses a non-WebGL chart engine.
3. High-frequency telemetry uses downsampling/windowing before it reaches the chart surface.
4. Plot tabs do not keep the 3D WebGL context alive.

## 3. File Structure

### Backend

- Create `crates/fullmag-api/src/fem_cross_section_image.rs`
  - Owns image request validation, polygon projection, quality color mapping, legend/colorbar layout, and PNG bytes.
- Modify `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`
  - Adds `MeshSharedDomainCrossSectionImageQuery`.
  - Adds `get_mesh_shared_domain_cross_section_image`.
  - Reuses existing `collect_fem_slice_overlay`, `cross_section_quality_from_fmmq`, and `cross_section_quality_from_parent_tets`.
- Modify `crates/fullmag-api/src/router_v2/mod.rs`
  - Registers `/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image`.
- Modify `crates/fullmag-api/src/openapi_v2.rs`
  - Adds the handler to generated OpenAPI.
- Modify `crates/fullmag-api/Cargo.toml`
  - Keep existing `png = "0.17"`.
  - Add `plotters = "0.3"` for CPU 2D rendering because it provides axes, labels, filled polygons, and bitmap output without WebGL.
- Modify `crates/fullmag-api/src/router_v2/tests.rs`
  - Adds endpoint, validation, ETag, PNG magic bytes, and invalid-query coverage.

### Frontend API And Resources

- Modify `apps/control-room/src/kernel/api/apiPaths.ts`
  - Add `MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH`.
- Modify generated files through `pnpm --dir apps/control-room generate:api`
  - `apps/control-room/src/kernel/api/generated/openapi-v2.json`
  - `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
  - `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`
- Modify `apps/control-room/src/kernel/api/apiTypes.ts`
  - Add `CrossSectionImageQuery`.
  - Add image resolution, legend, wireframe, shrink, and filter query types.
- Modify `apps/control-room/src/kernel/api/ControlRoomApi.ts`
  - Add `api.meshing.sharedDomain.crossSectionImage(query, options)`.
  - Return a blob-like binary result with ETag and byte length; do not decode the PNG in JavaScript.
- Modify or create `apps/control-room/src/kernel/resources/crossSectionImageResource.ts`
  - Owns blob request, ETag, cache key, object URL creation, and `URL.revokeObjectURL` cleanup.
- Modify `apps/control-room/src/kernel/resources/crossSectionResources.ts`
  - Keep FMCS/FMQS hooks for statistics.
  - Remove any dependency on `viewport2dRenderModel`.

### Frontend Viewport And Modules

- Create `apps/control-room/src/kernel/layout/ViewportTabHost.tsx`
  - Renders tab chrome for `viewport-main`.
  - Mounts only the selected manifest/surface.
  - Uses shared `Tabs` primitive.
- Modify `apps/control-room/src/kernel/layout/SlotHost.tsx`
  - Keep generic slot mounting.
  - Delegate `viewport-main` to `ViewportTabHost` when more than one eligible center surface exists.
  - Extract or share the existing lazy `MountedModule` path so `SlotHost` and `ViewportTabHost` do not duplicate module-mount logic.
- Modify `apps/control-room/src/kernel/layout/layoutTypes.ts`
  - Add `activeViewportMainModuleId: ModuleId | null` to `LayoutState`.
- Modify `apps/control-room/src/kernel/layout/LayoutController.ts`
  - Add `setActiveViewportMainModule(moduleId: ModuleId | null)`.
  - Emit `workspace:layout-changed` for active center-surface changes.
- Modify `apps/control-room/src/kernel/layout/useLayout.ts`
  - Expose a typed action for switching the active center surface.
- Modify `apps/control-room/src/kernel/persistence/controlRoomUiState.ts`
  - Persist and restore `activeViewportMainModuleId`.
  - Validate only string/null shape during persistence import/export; registry-aware fallback belongs in `ViewportTabHost`, because persistence does not own `ModuleRegistry`.
- Modify `apps/control-room/src/kernel/layout/layoutModel.ts`
  - Remove `viewport-aux` from the default column layout.
  - Keep restore compatibility: old stored layouts containing `viewport-aux` normalize to left/main/right.
- Modify `apps/control-room/src/kernel/layout/WorkspaceDockLayout.tsx`
  - Stop rendering `viewport-aux` for cross-section.
  - Keep tests proving no auxiliary column appears when no module targets it.
- Modify `apps/control-room/src/modules/index.ts`
  - Remove `viewport2dManifest`.
  - Add `crossSectionImageManifest`.
  - Add `analysisPlotsManifest` when P5 lands.
- Create `apps/control-room/src/modules/cross-section-image/manifest.ts`
  - Slot: `viewport-main`.
  - Commands: `cross-section.generate-image`, `cross-section.download-image`, `cross-section.focus-image`.
- Create `apps/control-room/src/modules/cross-section-image/CrossSectionImageModule.tsx`
  - Lightweight image viewer with status, stale/error states, download action, and no WebGL.
- Create `apps/control-room/src/modules/cross-section-image/CrossSectionImagePanel.tsx`
  - Displays `<img>` from object URL, image metadata, and compact controls.
- Delete `apps/control-room/src/modules/viewport-2d/*` after replacement tests pass.
- Delete `apps/control-room/src/design/styles/viewport-2d.css`.
- Create `apps/control-room/src/design/styles/cross-section-image.css`.
- Modify `apps/control-room/app/globals.css`
  - Import the new CSS file.
  - Remove `viewport-2d.css` import.

### Inspector And Workspace State

- Modify `apps/control-room/src/kernel/workspace/crossSectionWorkspace.ts`
  - Replace `commitCrossSectionDraft` semantics from “create live 2D viewport plot” to “create image-backed cross-section plot”.
  - Add `resolution`, `legendVisible`, `imageRevision`, and `lastGeneratedAt` to plot state.
- Modify `apps/control-room/src/modules/inspector/panels/CrossSectionDraftEditor.tsx`
  - Rename `Create 2D Plot` to `Generate Image`.
  - Add resolution selector.
  - On click, update workspace plot state and execute/focus the image surface through commands/layout, not direct transport.
- Modify `apps/control-room/src/modules/inspector/panels/CrossSectionInspectorPanel.tsx`
  - Keep statistics from FMCS/FMQS.
  - Add an `Image` section showing generation status, resolution, and stale state.
  - Keep selected element readout only when a polygon selection exists from previous data or future image map support.

### Charts

- Create `apps/control-room/src/modules/analysis-plots/manifest.ts`.
- Create `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.tsx`.
- Create `apps/control-room/src/shared/charts/ChartEngineAdapter.ts`.
- Create `apps/control-room/src/shared/charts/TimeSeriesPlot.tsx`.
- Add the first chart engine only through dynamic import inside `AnalysisPlotsModule`.
- Keep existing `recharts` components untouched until the new engine proves equivalent behavior.
- Keep `recharts` during this project. Removing it is a separate cleanup after all current Recharts consumers have migrated to `ChartEngineAdapter`.

## 4. Backend Resource Contract

### 4.1 Endpoint

`GET /v2/sessions/current/meshing/meshes/shared-domain/cross-section/image`

Query:

- `plane=xy|xz|yz`
- `position_percent=0..100`
- `metric=gamma|sicn|volume|skewness|aspect_ratio|max_angle|min_edge`
- `color_scale=jet|viridis|hot|coolwarm`
- `resolution=512|1024|2048`
- `wireframe=true|false`
- `legend=true|false`
- `shrink_factor=0.5..1.0`
- `filter_expression=<simple quality expression>`

Response:

- `200 image/png`
- `204` when FEM topology is not available or metric data cannot be produced
- `304` for `If-None-Match`
- `400` for invalid query values
- `404` when no active workspace exists
- `409` when shared-domain FEM topology is inconsistent

Headers:

- `ETag`: stable strong ETag based on mesh revision, generation id, plane, position, metric, color scale, resolution, wireframe, legend, shrink, filter expression, and renderer version.
- `X-Fullmag-Resource-Key`: `meshing/meshes/shared-domain/cross-section/image`
- `X-Fullmag-Renderer`: `cross-section-image-v1`

### 4.2 Rendering Semantics

- Geometry source: existing FEM shared-domain mesh.
- Cross-section source: existing `collect_fem_slice_overlay`.
- Quality source priority:
  1. FMMQ artifact metric values when present.
  2. Parent-tetrahedron geometry metric fallback.
  3. `204` when neither source can produce the requested metric.
- Projection: use the section-space `u,v` coordinates already implied by FMCS, not world `x,y` for non-XY planes.
- Aspect ratio: preserve physical section aspect ratio inside the plot area.
- Background: token-neutral dark/light independent PNG background chosen by query or server default. First implementation uses a neutral light background for export readability.
- Colorbar: included by default, labeled with metric id and min/mid/max.
- Axes: labeled with physical axis names and SI-scaled units.
- Wireframe: rendered after polygon fills.
- Mesh-node markers: optional future query. First implementation does not draw markers unless there is a cheap count-only overlay.

## 5. Frontend Resource Contract

`useCrossSectionImageResource(query, { enabled })` returns:

```ts
interface CrossSectionImageResource {
  byteLength: number;
  etag: string | null;
  objectUrl: string;
  query: CrossSectionImageQuery;
  revision: string | number | null;
}
```

Rules:

- The hook owns `URL.createObjectURL`.
- The hook revokes old object URLs on resource replacement and unmount.
- The hook uses ETag and `If-None-Match`.
- The cache has a bounded byte budget.
- Components receive only `objectUrl`, metadata, status, error, and `refetch`.
- Components never call `fetch`.

## 6. Performance Budget

### 6.1 Baseline To Capture Before Implementation

Scenario:

1. Start control room with active 3D viewport.
2. Create cross-section draft.
3. Commit current live `viewport-2d` plot.
4. Pan/rotate 3D and switch 2D parameters.

Metrics:

- number of WebGL contexts after 2D view opens,
- 3D frame time during 2D open,
- JS heap after opening 2D view and after closing,
- retained `ArrayBuffer` bytes after 2D view close,
- responsiveness probe max delay,
- resource requests during parameter edits.

### 6.2 Target After Implementation

- Opening `Cross-Section` tab unmounts 3D WebGL.
- Active non-3D tab has zero R3F canvas.
- Cross-section image view does not allocate FMCS vertex buffers for display.
- FMCS/FMQS fetches are used only for inspector statistics, not for image rendering.
- No `viewport-aux` column appears by default.
- Switching from `Cross-Section` back to `3D Scene` leaves exactly one WebGL canvas.
- Image regeneration does not trigger topology or field-vector refetch.

### 6.3 Required 3D Inactivity Proof

The performance goal is not just "the canvas is hidden". It is "the 3D module is not executing".

When active `viewport-main` surface is not `viewport-3d`:

- `Viewport3DModule` is not mounted.
- `WorkspaceRenderProfiler` emits no `Viewport3DModule` render/update measures.
- There is no `.fm-viewport-3d` element and no `.fm-viewport-3d__canvas` canvas.
- `useViewport3DSceneModel` is not subscribed to resource revisions.
- `useViewport3DDomainTopology`, `useViewport3DMeshQualityData`, `useViewport3DFieldVector`, `useViewport3DAirboxFieldVectors`, and `useViewport3DQuantityFieldVectors` have no active listeners.
- Any in-flight 3D resource request is aborted by `ResourceRuntimeStore.releaseUnobservedEntry` when the last 3D listener is removed.
- WebSocket invalidations may continue, but they only update revisions. They must not cause loads for 3D-only resources unless a visible module is subscribed.
- Camera and visualization registry timers may remain alive, but they may only flush explicit user-originated patches. They must not emit 3D render acks or resource loads while `viewport-3d` is inactive.

3D-only resources to monitor in tests and browser audits:

- `/v2/sessions/current/data/domain/topology`
- `/v2/sessions/current/meshing/meshes/shared-domain/quality/data`
- `/v2/sessions/current/data/fields/{quantity_id}/samples/vector`
- `fullmag.viewport3d.*` performance measures
- `fullmag.react.render.Viewport3DModule.*` performance measures
- `/v2/sessions/current/visualization/client-acks` entries with `viewport_id=viewport-main` from the 3D renderer

Allowed while 3D is inactive:

- `/v2/sessions/current/visualization/state` because inspector and ribbon controls can still show or edit display state.
- Cross-section image requests.
- FMCS/FMQS cross-section requests used by inspector statistics.
- Session status, command status, telemetry, and resource invalidation bookkeeping.

## 7. Implementation Phases

### Phase P0: Architecture Decision And Spec Rewrite

**Files:**

- Create: `docs/adr/0016-center-viewport-tabbed-surfaces.md`
- Modify: `docs/specs/frontend-v2/01-module-kernel-architecture.md`
- Modify: `docs/specs/frontend-v2/02-module-catalog.md`
- Modify: `docs/specs/frontend-v2/05-viewport-architecture.md`
- Modify: `docs/specs/frontend-v2/15-viewport-2d-module.md`
- Modify: `docs/specs/resource-first-control-room-api-v2.md`

- [ ] Write ADR 0016 with the decision: one active center visualization surface, tabbed `viewport-main`, no cross-section `viewport-aux`, server-rendered cross-section images, non-WebGL chart surfaces.
- [ ] Update module catalog so `viewport-2d` no longer means a mandatory WebGL auxiliary module.
- [ ] Update viewport architecture so inactive heavy surfaces must be unmounted.
- [ ] Update resource-first spec with the cross-section image endpoint.
- [ ] Run `pnpm --dir apps/control-room test -- --run layout`.
- [ ] Commit: `docs: adopt tabbed center viewport plan`.

### Phase P1: Backend Cross-Section Image Resource

**Files:**

- Create: `crates/fullmag-api/src/fem_cross_section_image.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `crates/fullmag-api/Cargo.toml`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

- [ ] Add tests for valid PNG response, PNG signature bytes, `Content-Type: image/png`, ETag, `304`, invalid resolution, invalid position, invalid shrink, and no FEM mesh returning `204`.
- [ ] Implement query type with strict value validation.
- [ ] Implement renderer with physical aspect ratio, color mapping, wireframe, axes, and colorbar.
- [ ] Reuse existing cross-section geometry and quality functions.
- [ ] Add route and OpenAPI registration.
- [ ] Run `cargo test -p fullmag-api mesh_shared_domain_cross_section_image --no-fail-fast`.
- [ ] Run `pnpm --dir apps/control-room generate:api`.
- [ ] Commit: `feat(api): add cross-section image resource`.

### Phase P2: Frontend API Facade And Image Resource Hook

**Files:**

- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Create: `apps/control-room/src/kernel/resources/crossSectionImageResource.ts`
- Test: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- Test: `apps/control-room/src/kernel/resources/crossSectionImageResource.test.ts`

- [ ] Add failing tests proving image resource loads through `ControlRoomApi`, not direct `fetch`.
- [ ] Add ETag/304 tests for image resource.
- [ ] Add object URL lifecycle tests proving old URLs are revoked.
- [ ] Add API path and query typing.
- [ ] Implement `api.meshing.sharedDomain.crossSectionImage`.
- [ ] Implement `useCrossSectionImageResource`.
- [ ] Run `pnpm --dir apps/control-room exec vitest run src/kernel/api/ControlRoomApi.test.ts src/kernel/resources/crossSectionImageResource.test.ts`.
- [ ] Run `pnpm --dir apps/control-room check:api-hygiene`.
- [ ] Commit: `feat(control-room): add cross-section image resource hook`.

### Phase P3: Center Viewport Tab Host

**Files:**

- Create: `apps/control-room/src/kernel/layout/ViewportTabHost.tsx`
- Create: `apps/control-room/src/kernel/layout/ViewportTabHost.test.tsx`
- Modify: `apps/control-room/src/kernel/layout/SlotHost.tsx`
- Modify: `apps/control-room/src/kernel/layout/layoutTypes.ts`
- Modify: `apps/control-room/src/kernel/layout/LayoutController.ts`
- Modify: `apps/control-room/src/kernel/layout/LayoutController.test.ts`
- Modify: `apps/control-room/src/kernel/layout/useLayout.ts`
- Modify: `apps/control-room/src/kernel/persistence/controlRoomUiState.ts`
- Modify: `apps/control-room/src/kernel/layout/layoutModel.ts`
- Modify: `apps/control-room/src/kernel/layout/WorkspaceDockLayout.tsx`
- Modify: `apps/control-room/src/kernel/layout/WorkspaceDockLayout.test.tsx`
- Modify: `apps/control-room/src/kernel/events/eventTypes.ts`
- Modify: `apps/control-room/src/design/styles/workspace.css` or the current workspace layout CSS file.

- [ ] Add tests showing `viewport-main` renders tab headers when multiple center surfaces are eligible.
- [ ] Add tests showing only active tab module is mounted.
- [ ] Add tests showing inactive tab modules are never mounted through hidden tab panels or `forceMount`.
- [ ] Add tests with a fake 3D module that subscribes through `useResource`, then switch to another tab and prove the listener is removed, in-flight load is aborted, and later invalidations do not call the fake 3D load function.
- [ ] Add tests showing `LayoutController.setActiveViewportMainModule("cross-section-image")` updates layout state and does not confuse slot focus with active surface.
- [ ] Add persistence tests proving `activeViewportMainModuleId` round-trips as string/null.
- [ ] Add `ViewportTabHost` tests proving stale active center-surface ids fall back to the first registered `viewport-main` manifest.
- [ ] Add tests showing legacy persisted layouts with `viewport-aux` restore to left/main/right.
- [ ] Implement `ViewportTabHost` using shared `Tabs`.
- [ ] Implement `ViewportTabHost` without importing module internals; it must call the same `MountedModule` path as `SlotHost` for the active manifest only.
- [ ] Route `viewport-main` through `ViewportTabHost`.
- [ ] Remove `viewport-aux` from default workspace columns.
- [ ] Run `pnpm --dir apps/control-room exec vitest run src/kernel/layout`.
- [ ] Commit: `feat(control-room): add tabbed center viewport host`.

### Phase P4: Cross-Section Image Module And Inspector Flow

**Files:**

- Create: `apps/control-room/src/modules/cross-section-image/manifest.ts`
- Create: `apps/control-room/src/modules/cross-section-image/CrossSectionImageModule.tsx`
- Create: `apps/control-room/src/modules/cross-section-image/CrossSectionImagePanel.tsx`
- Create: `apps/control-room/src/modules/cross-section-image/CrossSectionImageModule.test.tsx`
- Modify: `apps/control-room/src/modules/index.ts`
- Modify: `apps/control-room/src/kernel/workspace/crossSectionWorkspace.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/CrossSectionDraftEditor.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/CrossSectionDraftEditor.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/CrossSectionInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/CrossSectionInspectorPanel.test.tsx`
- Create: `apps/control-room/src/design/styles/cross-section-image.css`
- Modify: `apps/control-room/app/globals.css`

- [ ] Add manifest tests proving the image module targets `viewport-main`, not `viewport-aux`.
- [ ] Add inspector tests proving the button says `Generate Image` and does not focus `viewport-aux`.
- [ ] Add module tests for ready, loading, stale, error, no-data, and download states.
- [ ] Implement `CrossSectionImageModule`.
- [ ] Update workspace state to track image-backed plots.
- [ ] Update inspector draft workflow to generate/focus image tab.
- [ ] Keep FMCS/FMQS statistics in inspector.
- [ ] Run `pnpm --dir apps/control-room exec vitest run src/modules/cross-section-image src/modules/inspector/panels/CrossSectionDraftEditor.test.tsx src/modules/inspector/panels/CrossSectionInspectorPanel.test.tsx`.
- [ ] Commit: `feat(control-room): show cross-section images in center viewport`.

### Phase P5: Remove Live WebGL `viewport-2d`

**Files:**

- Delete: `apps/control-room/src/modules/viewport-2d/*`
- Delete: `apps/control-room/src/design/styles/viewport-2d.css`
- Modify: `apps/control-room/src/modules/index.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/crossSectionExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`
- Modify: `apps/control-room/src/kernel/events/eventTypes.ts`
- Modify: `apps/control-room/src/design/styles/designStyles.test.ts`
- Modify: `apps/control-room/package.json`

- [ ] Remove `viewport2dManifest` import and registration.
- [ ] Remove `viewport-2d.toggle` and `viewport-2d.fit` commands.
- [ ] Remove `viewport-2d:fit-requested` event type and any listeners/tests that only served the removed WebGL module.
- [ ] Replace Explorer context command references with `cross-section.focus-image`.
- [ ] Remove viewport-2d CSS import assertions.
- [ ] Delete viewport-2d tests that only validate removed WebGL behavior.
- [ ] Keep shared cross-section statistics and codecs.
- [ ] Run `rg "viewport-2d|fm-viewport-2d|viewport-aux.*Section" apps/control-room/src apps/control-room/scripts docs/specs/frontend-v2`.
- [ ] Run `pnpm --dir apps/control-room test`.
- [ ] Commit: `refactor(control-room): remove live viewport-2d webgl module`.

### Phase P6: 2D Plot Engine Adapter

**Files:**

- Create: `apps/control-room/src/modules/analysis-plots/manifest.ts`
- Create: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.tsx`
- Create: `apps/control-room/src/shared/charts/ChartEngineAdapter.ts`
- Create: `apps/control-room/src/shared/charts/TimeSeriesPlot.tsx`
- Create: `apps/control-room/src/shared/charts/TimeSeriesPlot.test.tsx`
- Modify: `apps/control-room/src/modules/index.ts`
- Modify: `apps/control-room/package.json`

- [ ] Add an adapter interface for time-series, profile, heatmap, and scatter plot inputs.
- [ ] Add a first dynamically imported 2D engine for line/time-series plots.
- [ ] Add a bundle-size guard proving the chart engine is not in the initial workspace bundle.
- [ ] Add tests for mount/unmount cleanup.
- [ ] Add a plot tab that can render solver scalar history from existing resources.
- [ ] Keep Plotly as an optional advanced adapter behind the same interface if the first engine cannot cover required scientific interactions.
- [ ] Run `pnpm --dir apps/control-room test -- --run chart`.
- [ ] Run `react-doctor . --verbose --diff` from `apps/control-room`.
- [ ] Commit: `feat(control-room): add isolated 2d chart engine`.

### Phase P7: Browser Smoke And Performance Proof

**Files:**

- Modify: `apps/control-room/scripts/smoke-cross-section-workflow.mjs`
- Modify: `apps/control-room/scripts/smoke-cross-section-workflow-cdp.mjs`
- Modify: `apps/control-room/scripts/audit-viewport-2d-cross-section-performance.mjs`
- Create: `apps/control-room/scripts/audit-center-viewport-tabs-memory.mjs`
- Modify tests that assert smoke script contents.

- [ ] Update smoke to assert no `.fm-viewport-2d canvas`.
- [ ] Add assertion that `Cross-Section` tab contains an `<img>`.
- [ ] Add assertion that switching to `Cross-Section` leaves zero `.fm-viewport-3d` elements and zero active 3D canvas nodes.
- [ ] Add assertion that switching back to `3D Scene` creates exactly one visible WebGL canvas.
- [ ] Clear browser network/performance counters after switching away from `3D Scene`, wait longer than one field publication cadence, regenerate a cross-section image, and assert there are no new 3D-only resource requests listed in section 6.3.
- [ ] Assert there are no new `fullmag.viewport3d.*` or `fullmag.react.render.Viewport3DModule.*` performance measures while `Cross-Section` or `Plots` is active.
- [ ] Assert no 3D renderer client ack is sent while `viewport-3d` is inactive.
- [ ] Add a viewport memory stress loop that switches `3D Scene` -> `Cross-Section` -> `Plots` -> `3D Scene` repeatedly, changes quantity once per loop, and asserts bounded WebGL/resource-cache growth plus zero active module-owned 3D resources after the final non-3D tab.
- [ ] Add a resource-hook audit that emits unrelated revision ticks while `Cross-Section` is active and proves 3D-only hooks do not refetch.
- [ ] Add CDP memory audit for object URL cleanup and WebGL context count.
- [ ] Run `pnpm --dir apps/control-room smoke:cross-section-workflow` against a working backend.
- [ ] Run `pnpm --dir apps/control-room test -- --run viewport-memory-stress`.
- [ ] Run `pnpm --dir apps/control-room test -- --run resource-hooks`.
- [ ] Run `pnpm --dir apps/control-room audit:idle-performance`.
- [ ] Run `pnpm --dir apps/control-room audit:center-viewport-tabs-memory`.
- [ ] Commit: `test(control-room): prove tabbed viewport memory behavior`.

### Phase P8: Final Gates

Commands:

- `pnpm --dir apps/control-room generate:api`
- `pnpm --dir apps/control-room typecheck`
- `pnpm --dir apps/control-room lint`
- `pnpm --dir apps/control-room test`
- `pnpm --dir apps/control-room test -- --run viewport`
- `pnpm --dir apps/control-room test -- --run viewport-memory-stress`
- `pnpm --dir apps/control-room test -- --run resource-hooks`
- `pnpm --dir apps/control-room check:api-hygiene`
- `pnpm --dir apps/control-room audit:idle-performance`
- `cargo test -p fullmag-api mesh_shared_domain_cross_section --no-fail-fast`
- `cargo test -p fullmag-api mesh_shared_domain_cross_section_image --no-fail-fast`
- `git diff --check`
- `react-doctor . --verbose --diff` from `apps/control-room`

Acceptance:

- No direct component `fetch()`.
- No module builds `/v2/...` strings.
- No `viewport-2d` WebGL canvas remains.
- No cross-section workflow focuses `viewport-aux`.
- Cross-section PNG downloads successfully.
- 3D viewport is unmounted on image/plot tabs.
- Inactive viewport tabs are not mounted or hidden; only the active center-surface module is rendered.
- Switching away from `3D Scene` removes `Viewport3DModule` subscriptions, aborts in-flight 3D resource loads, and prevents later invalidations from loading 3D-only resources.
- No `Viewport3DModule` render measures, 3D model-build measures, or 3D client acks occur while `Cross-Section` or `Plots` is active.
- Only one WebGL canvas exists when 3D tab is active.
- The image resource endpoint is present in OpenAPI and generated paths.
- The inspector still shows cross-section statistics.
- The UI remains token-based with `fm-*` classes.

## 8. Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Server PNG rendering is slow for very large polygon counts | Add renderer benchmark in P1; cap resolution; preserve FMCS/FMQS for statistics; cache by ETag. |
| Plotly increases bundle size and hurts startup | Use adapter boundary and dynamic import; prefer lightweight engine first; add React Doctor and bundle gate. |
| Losing live polygon hover reduces inspection precision | Keep statistics in inspector; add future image map or click-to-query endpoint only after PNG workflow is stable. |
| 3D remount feels slow | Preserve camera state in `visualization/state`; add tab switch smoke and WebGL resource counters. |
| Deleting `viewport-2d` breaks Explorer/ribbon references | P5 includes explicit `rg` cleanup and tests for commands/selection. |
| Docs drift after changing module catalog | P0 updates ADR/specs before implementation. |

## 9. Self-Review

Spec coverage:

- Server-side PNG rendering is covered by P1 and P2.
- Removal of live 2D WebGL is covered by P3, P4, and P5.
- 3D RAM/GPU release through tabs is covered by P3 and P7.
- 2D chart engine direction is covered by P6.
- API/resource-first constraints are covered by P1, P2, and P8.
- Docs/ADR migration is covered by P0.
- Visual design and workspace layout are covered by P3, P4, and P8.

Placeholder scan:

- The plan contains no intentionally deferred implementation placeholders. Optional future work is explicitly outside this implementation boundary.

Type consistency:

- `CrossSectionImageQuery`, `CrossSectionImageResource`, `MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH`, `crossSectionImage`, `useCrossSectionImageResource`, and `cross-section-image` are consistently named across tasks.
