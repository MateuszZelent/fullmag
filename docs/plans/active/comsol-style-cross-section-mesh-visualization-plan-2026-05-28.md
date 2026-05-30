# COMSOL-Style 2D Cross-Section Mesh Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Add interactive FEM shared-domain tetrahedral mesh cross-sections with parent-element quality coloring, wireframe overlay, filtering, and synchronized 3D cut-plane context in `apps/control-room`.

**Architecture:** Treat cross-section geometry as a meshing resource, not as a screen-shaped preview. Backend publishes a binary `FMCS` cross-section resource under OpenAPI v2. The frontend decodes it through `ControlRoomApi`, caches it through resource hooks, builds a domain-neutral 2D render model, and renders it in a new `viewport-2d` module mounted in `viewport-aux` once that slot is actually rendered by the workspace layout.

**Tech Stack:** Rust `crates/fullmag-api`, OpenAPI v2/utoipa, generated TypeScript transport, `ControlRoomApi`, React 19, Next 16, R3F/Three.js orthographic demand rendering, Vitest, Rust tests, Playwright smoke/audit scripts.

---

## 1. Current-State Diagnosis

The proposed direction is right, but the original plan has several contract gaps that must be fixed before implementation.

1. `viewport-aux` exists as a `SlotId`, but the current workspace layout does not mount it. `layoutModel.ts` only allows `panel-left`, `viewport-main`, and `panel-right` as workspace columns, and `WorkspaceDockLayout.tsx` only renders those plus `panel-bottom`. A `viewport-2d` manifest with `slots: ["viewport-aux"]` will not appear until the layout is extended.
2. `viewport-2d` is absent from `apps/control-room/src/modules/index.ts`. The v2 module catalog lists it as a target module, not current implementation.
3. `visualization/state` already owns `slice` and `clip`. New controls must extend/use these resources instead of creating an isolated 2D module store for canonical slice state.
4. Mesh quality per-element binary data already exists at `/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element` as `FMMQ`. The first cross-section implementation should reuse this resource and map `parent_element_ids` to quality values. A separate `/cross-section/quality` endpoint is not needed for MVP.
5. `fem_slice_overlay.rs` currently emits only wireframe segments. It already computes the sorted intersection points needed for polygons, so polygon output belongs there.
6. The proposed `FMCS` "32 byte header" is impossible as written. Four `f64` bounds alone require 32 bytes. Use a 64 byte header.
7. Additional quality metrics are not a Rust HTTP-only change. Current per-element quality originates in the Python/Gmsh meshing pipeline and `FMMQ` writer. New metrics require changes in `packages/fullmag-py`, artifact schema, Rust validation, frontend codec, UI, and tests.
8. A separate R3F canvas for `viewport-2d` is acceptable for large polygon counts only if the 2D viewport spec and lifecycle tests are updated. The current spec says mesh sections may use Canvas2D/SVG, and viewport governance requires explicit cleanup and demand rendering.

## 2. Decisions

1. **Slot:** Use `viewport-aux` as the default home for cross-section view, but Phase 0 must add real layout support. Also support maximize/replace into `viewport-main` through layout state later.
2. **Renderer:** Use WebGL via R3F orthographic canvas for cross-section polygons and line segments. Use `frameloop="demand"` and explicit disposal. Do not share 3D viewport buffers or WebGL objects.
3. **Quality metric:** Color by intersected parent tetrahedron quality. MVP supports existing `gamma`, `sicn`, and `volume` from `FMMQ`. Additional metrics are Phase 7.
4. **Cut planes:** One active plane for MVP. Multi-plane views are deferred.
5. **3D interaction:** Start with ribbon/inspector numeric controls plus passive 3D plane overlay. Add draggable 3D gizmo only after backend resource, 2D rendering, and clip state are stable.
6. **Scope:** FEM shared-domain mesh first. FDM slices use existing field slice resources later through the same `viewport-2d` module mode system, not through this FEM mesh-section endpoint.
7. **Filtering:** No arbitrary JavaScript evaluation. MVP supports a safe filter grammar: `<metric> <op> <number>` with `metric in gamma|sicn|volume`, `op in <|<=|>|>=|==`, and finite numeric literal. Prefer structured UI controls for common threshold filters.

## 3. Resource And Binary Contract

### Endpoint

`GET /v2/sessions/current/meshing/meshes/shared-domain/cross-section`

Query parameters:

- `plane`: `xy | xz | yz`
- `cut_norm`: `0.0..1.0`, optional, default `0.5`
- `cut_world`: finite world coordinate in meters, optional, mutually exclusive with `cut_norm`
- `include_polygons`: bool, optional, default `true`
- `include_wireframe`: bool, optional, default `true`

Responses:

- `200 application/octet-stream`: binary `FMCS` payload
- `304`: ETag match
- `204`: active session exists but no FEM shared-domain mesh exists
- `400`: invalid query
- `404`: no active workspace/session

ETag token:

- `mesh_revision`
- FEM mesh `generation_id` or mesh id
- plane and resolved cut
- include flags
- `FMCS` schema version

### `FMCS` v1 Header

Use a fixed 64 byte little-endian header:

```text
0   magic              [u8; 4]  "FMCS"
4   version            u8       1
5   coordinate_kind    u8       1 = f32
6   index_kind         u8       1 = u32
7   flags              u8       bit0 polygons, bit1 wireframe, bit2 parent ids
8   polygon_count      u32
12  vertex_count       u32
16  segment_count      u32
20  reserved_u32       u32      0
24  mesh_revision      u64
32  u_min              f64
40  u_max              f64
48  v_min              f64
56  v_max              f64
```

Payload order:

```text
vertices            f32[vertex_count * 2]       // UV pairs
polygon_offsets     u32[polygon_count + 1]      // CSR offsets into vertices
parent_element_ids  u32[polygon_count]          // tetrahedron index per polygon
segments            f32[segment_count * 4]      // u1, v1, u2, v2
```

Frontend decoder rejects:

- invalid magic/version/kind/flags,
- mismatched byte length,
- non-monotonic polygon offsets,
- final offset not equal to `vertex_count`,
- non-finite bounds or vertex coordinates,
- `parent_element_ids.length !== polygon_count`.

## 4. Implementation Phases

### Phase 0 - Spec And Layout Prerequisites

**Files:**

- Modify: `docs/specs/frontend-v2/02-module-catalog.md`
- Modify: `docs/specs/frontend-v2/05-viewport-architecture.md`
- Modify: `docs/specs/frontend-v2/15-viewport-2d-module.md`
- Modify: `apps/control-room/src/kernel/layout/layoutModel.ts`
- Modify: `apps/control-room/src/kernel/layout/WorkspaceDockLayout.tsx`
- Modify: `apps/control-room/src/kernel/layout/layoutModel.test.ts`
- Modify: `apps/control-room/src/kernel/layout/SlotHost.test.tsx`

Steps:

- [ ] Update specs to state that `viewport-2d` may use WebGL/R3F for large mesh-section render models, with independent lifecycle and demand rendering.
- [ ] Add `viewport-aux` to workspace layout as an optional/resizable auxiliary viewport column or nested split next to `viewport-main`.
- [ ] Bump workspace layout storage key from `fullmag.workspace.layout.v1` to `v2` or add migration that tolerates old layouts without losing left/right panel visibility.
- [ ] Add a layout test proving `viewport-aux` is restored or default-mounted.
- [ ] Add a `SlotHost` test proving a module registered only for `viewport-aux` is discoverable.

Verification:

```bash
pnpm --dir apps/control-room test -- src/kernel/layout/layoutModel.test.ts src/kernel/layout/SlotHost.test.tsx
pnpm --dir apps/control-room check:architecture-hygiene
```

Done gate: an empty placeholder module can be mounted in `viewport-aux` without changing physics/session state and without breaking existing layout restoration.

### Phase 1 - Backend Cross-Section Geometry Core

**Files:**

- Modify: `crates/fullmag-api/src/fem_slice_overlay.rs`
- Add: `crates/fullmag-api/src/fem_cross_section.rs`
- Test: `crates/fullmag-api/src/fem_slice_overlay.rs`
- Test: `crates/fullmag-api/src/fem_cross_section.rs`

Steps:

- [ ] Add `SliceOverlayPolygon { vertices: Vec<[f64; 2]>, parent_element_id: u32 }`.
- [ ] Add `polygons: Vec<SliceOverlayPolygon>` to `FemSliceOverlay`.
- [ ] Keep existing `segments` behavior unchanged for current field-slice overlay callers.
- [ ] Refactor element iteration so the sorted intersection points are emitted once as a polygon when `points.len() >= 3`.
- [ ] Preserve marker filtering: element marker `0` remains airbox/non-magnetic skip for magnetic mesh-section MVP unless product explicitly wants airbox sections visible.
- [ ] Reuse `FemNormalAxisIndex` for candidate filtering rather than scanning all elements on every slider tick.
- [ ] Add serializer for `FMCS` v1 with a 64 byte header and strict count/length checks.

Focused tests:

- [ ] One tetra cut through one vertex and opposite edges produces one triangle polygon and three wireframe segments.
- [ ] One tetra with two nodes below and two above the plane produces one quad polygon and four wireframe segments.
- [ ] A coplanar face does not duplicate vertices or create zero-length segments.
- [ ] Marker `0` element is omitted.
- [ ] `FemNormalAxisIndex` candidate path returns the same polygons as the full scan for a small two-tet mesh.
- [ ] `FMCS` serialization round-trips byte counts and preserves bounds.

Verification:

```bash
cargo test -p fullmag-api fem_slice_overlay --no-fail-fast
cargo test -p fullmag-api fem_cross_section --no-fail-fast
```

Done gate: geometry extraction is deterministic, parent element ids align to `FemMeshPayload.elements`, and existing field slice overlay output is not regressed.

### Phase 2 - Backend v2 Route And OpenAPI

**Files:**

- Modify: `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `crates/fullmag-api/src/schemas/mesh.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify generated frontend files through `pnpm --dir apps/control-room generate:api`

Steps:

- [ ] Add `MeshCrossSectionQuery` with `plane`, `cut_norm`, `cut_world`, `include_polygons`, `include_wireframe`.
- [ ] Add an utoipa path for `/v2/sessions/current/meshing/meshes/shared-domain/cross-section`.
- [ ] Implement `get_mesh_shared_domain_cross_section` from `snapshot.fem_mesh`.
- [ ] Return `204` when the active session has no FEM mesh.
- [ ] Return `400` if both `cut_world` and `cut_norm` are supplied, if values are non-finite, or if `cut_norm` is outside `0..1` after validation policy is decided.
- [ ] Add conditional binary response with ETag.
- [ ] Add route in `router_v2/mod.rs`.
- [ ] Add path to `openapi_v2.rs`.
- [ ] Run OpenAPI generation so `openapi-v2-paths.ts` contains the new literal.

Focused tests:

- [ ] Route returns `200` and `FMCS` magic for a fixture FEM mesh.
- [ ] Route returns `304` for matching `If-None-Match`.
- [ ] Route returns `204` when no FEM mesh is available.
- [ ] Route rejects mutually exclusive `cut_world` and `cut_norm`.
- [ ] Generated OpenAPI contains the new path and query schema.

Verification:

```bash
cargo test -p fullmag-api mesh_shared_domain_cross_section --no-fail-fast
cargo test -p fullmag-api openapi --no-fail-fast
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test -- src/kernel/api/openapiV2GeneratedContract.test.ts
```

Done gate: backend, OpenAPI, generated path literals, and frontend generated types are aligned. No handwritten frontend `/v2/...` string is introduced outside the API path layer.

### Phase 3 - Frontend Codec And API Facade

**Files:**

- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/api/binaryDecodePayload.ts`
- Add: `apps/control-room/src/kernel/api/codecs/crossSectionCodec.ts`
- Modify: `apps/control-room/src/kernel/api/codecs/index.ts`
- Modify: `apps/control-room/src/kernel/api/codecs/types.ts`
- Add: `apps/control-room/src/kernel/api/codecs/crossSectionCodec.test.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`

Steps:

- [ ] Add `MESHING_SHARED_DOMAIN_CROSS_SECTION_PATH = openApiV2Path("/v2/sessions/current/meshing/meshes/shared-domain/cross-section")`.
- [ ] Add `DecodedCrossSection` type to codec types.
- [ ] Implement `decodeCrossSection(buffer: ArrayBuffer)`.
- [ ] Add `"cross-section"` to `BinaryDecoderKind`, `BinaryDecodedPayload`, and worker decode dispatch.
- [ ] Add `api.meshing.sharedDomain.crossSection(query, options)` facade method.
- [ ] Query type should be handwritten and narrow: `plane`, `cut_norm`, `cut_world`, `include_polygons`, `include_wireframe`.
- [ ] Keep all binary fetching inside `ControlRoomApi`; no React component fetches.

Focused tests:

- [ ] Decoder accepts a valid minimal `FMCS` fixture.
- [ ] Decoder rejects invalid magic/version/flags.
- [ ] Decoder rejects payload byte-length mismatch.
- [ ] Decoder rejects polygon offsets not ending at `vertexCount`.
- [ ] `ControlRoomApi` calls the generated path with encoded query params and `x-api-contract-version`.
- [ ] Binary decode worker supports `cross-section`.

Verification:

```bash
pnpm --dir apps/control-room test -- src/kernel/api/codecs/crossSectionCodec.test.ts src/kernel/api/ControlRoomApi.test.ts
pnpm --dir apps/control-room typecheck
```

Done gate: all cross-section network and decoding work is available through the central API facade and worker-compatible codec.

### Phase 4 - Viewport 2D Resource Hooks And Render Model

**Files:**

- Add: `apps/control-room/src/modules/viewport-2d/manifest.ts`
- Add: `apps/control-room/src/modules/viewport-2d/Viewport2DModule.tsx`
- Add: `apps/control-room/src/modules/viewport-2d/viewport2dResources.ts`
- Add: `apps/control-room/src/modules/viewport-2d/model/buildCrossSectionRenderModel.ts`
- Add: `apps/control-room/src/modules/viewport-2d/model/crossSectionTypes.ts`
- Add: `apps/control-room/src/modules/viewport-2d/model/crossSectionQualityMapping.ts`
- Add: `apps/control-room/src/modules/viewport-2d/model/crossSectionFilters.ts`
- Add tests next to each model/resource file.
- Modify: `apps/control-room/src/modules/index.ts`

Steps:

- [ ] Create `viewport2dManifest` with `id: "viewport-2d"` and `slots: ["viewport-aux"]`.
- [ ] Register it in `ALL_MODULES` after `viewport3dManifest`.
- [ ] Add a module root that accepts `ModuleProps`, reads `visualization/state`, and delegates to resource hooks and scene components.
- [ ] Implement `useViewport2DCrossSectionResource` with a `ResourceCache<DecodedCrossSection>` keyed by mesh revision plus plane/cut/include flags.
- [ ] Reuse `useViewport3DMeshQualityData` logic by extracting shared mesh quality resource loading into `src/kernel/resources` or `src/shared/domain/mesh` if needed. Do not import from `viewport-3d`.
- [ ] Build render model by triangulating each CSR polygon with fan triangulation.
- [ ] Generate per-vertex colors by looking up quality arrays with `parent_element_ids`.
- [ ] If quality data is absent, render neutral polygons and expose stale/degraded reason.
- [ ] Implement safe threshold filtering over decoded parent quality values.

Focused tests:

- [ ] Manifest registers in `viewport-aux`.
- [ ] Resource key changes when plane or cut changes, but quality data key does not change when cut changes.
- [ ] Triangulation converts a triangle to 1 triangle and a quad to 2 triangles.
- [ ] Parent-element quality maps one value to all vertices of that polygon.
- [ ] Missing quality data returns neutral colors and a quality-unavailable diagnostic.
- [ ] Filter parser accepts `gamma < 0.1` and rejects arbitrary text such as `window.location`.
- [ ] No `viewport-2d` file imports from `../viewport-3d`.

Verification:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-2d
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
```

Done gate: `viewport-2d` can build a complete render model from API resources without direct transport, cross-module imports, or storing server payloads in Zustand.

### Phase 5 - Viewport 2D R3F Scene

**Files:**

- Add: `apps/control-room/src/modules/viewport-2d/components/Viewport2DCanvas.tsx`
- Add: `apps/control-room/src/modules/viewport-2d/layers/Viewport2DScene.tsx`
- Add: `apps/control-room/src/modules/viewport-2d/layers/CrossSectionPolygonLayer.tsx`
- Add: `apps/control-room/src/modules/viewport-2d/layers/CrossSectionWireframeLayer.tsx`
- Add: `apps/control-room/src/modules/viewport-2d/layers/GridLayer.tsx`
- Add: `apps/control-room/src/modules/viewport-2d/layers/ColorbarOverlay.tsx`
- Add: `apps/control-room/src/modules/viewport-2d/hooks/useCrossSectionCamera.ts`
- Add: `apps/control-room/src/modules/viewport-2d/viewport2dDiagnostics.ts`
- Add tests for layer lifecycle and geometry disposal.

Steps:

- [ ] Mount one R3F `<Canvas frameloop="demand" orthographic>` inside the 2D module.
- [ ] Convert UV coordinates to `Vector3(u, v, 0)` positions in a Three `BufferGeometry`.
- [ ] Render polygons with `MeshBasicMaterial({ vertexColors: true, side: DoubleSide })`.
- [ ] Render wireframe with `LineSegments` and a small positive z offset.
- [ ] Use a resource tracker like `viewport-3d` to dispose geometries/materials on render-model change and unmount.
- [ ] Implement fit-to-view, wheel zoom, drag pan, and double-click fit locally in the module.
- [ ] Store only camera UI state locally. Do not PATCH backend on every pan/zoom.
- [ ] Render nonblank loading/stale/unsupported states without pretending data exists.
- [ ] Use `fm-` CSS class prefixes and `--fm-*` tokens only.

Focused tests:

- [ ] Geometry and material dispose when render model changes.
- [ ] Idle render loop settles after resource load.
- [ ] Fit-to-view returns finite orthographic bounds for nanoscale meshes.
- [ ] Wireframe layer count equals decoded `segment_count`.
- [ ] CSS contract test finds no unprefixed module classes and no raw Catppuccin colors in module CSS.

Verification:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-2d --run
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Done gate: the 2D viewport renders quality-colored cross-section polygons and aligned wireframe with bounded WebGL resource lifetime.

### Phase 6 - Visualization State, Ribbon, And Inspector Wiring

**Files:**

- Modify: `crates/fullmag-api/src/schemas/visualization_state.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Modify: generated OpenAPI files through `pnpm --dir apps/control-room generate:api`
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonCommands.ts`
- Add: `apps/control-room/src/modules/inspector/panels/CrossSectionInspectorPanel.tsx`
- Modify inspector routing only through existing selection/layout patterns.

Steps:

- [ ] Extend `SliceVisualizationState` only for canonical display controls that must survive resource refresh: `quality_metric`, `mesh_section_colormap`, `mesh_section_filter`, `mesh_section_shrink`, `show_mesh_wireframe`.
- [ ] Keep hover point, selected polygon, and transient camera pan/zoom local to `viewport-2d`.
- [ ] Add ribbon commands that PATCH `visualization/state.slice`; do not import `viewport-2d` internals.
- [ ] Wire existing 2D slice plane controls to live `visualization/state.slice` values.
- [ ] Add quality metric selector for existing metrics only: `gamma`, `sicn`, `volume`.
- [ ] Add color scale selector with `jet`, `viridis`, `hot`, `coolwarm`; default can be `jet` for COMSOL mode, but preserve user preference in visualization state.
- [ ] Add structured filter controls before accepting a free-text expression UI.
- [ ] Add inspector statistics derived from current decoded resource and quality array: polygon count, intersected parent count, min/mean/max/p5 over visible polygons, below-threshold count.
- [ ] Histogram should reuse the `MeshQualityChart` visual pattern, but not import an inspector-private component into `viewport-2d`.

Focused tests:

- [ ] PATCH rejects invalid `position_percent`, invalid metric, invalid shrink range.
- [ ] Ribbon action emits `visualization.patch` command input, not direct fetch.
- [ ] Inspector stats update when quality metric changes without refetching cross-section geometry.
- [ ] Module boundary check remains clean.

Verification:

```bash
cargo test -p fullmag-api visualization_state --no-fail-fast
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test -- src/modules/ribbon src/modules/inspector src/modules/viewport-2d
pnpm --dir apps/control-room check:architecture-hygiene
```

Done gate: controls, 2D rendering, and inspector all read the same canonical `visualization/state.slice` resource.

### Phase 7 - 3D Clip Plane Overlay And Later Gizmo

**Files:**

- Add: `apps/control-room/src/modules/viewport-3d/layers/ClipPlaneLayer.tsx`
- Add later: `apps/control-room/src/modules/viewport-3d/layers/CutPlaneGizmoLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`

Steps:

- [ ] First implement passive clip plane overlay from `visualization.state.clip`.
- [ ] Set `gl.clippingPlanes` and restore previous clipping state on unmount/change.
- [ ] Ensure existing viewport materials either respect global clipping or document which layers are excluded.
- [ ] Render translucent cut plane bounds using current domain bounds.
- [ ] Keep plane overlay render-only; dragging is deferred until passive clipping passes browser smoke.
- [ ] For gizmo phase, use pointer drag constrained to the normal axis and throttle PATCH to drag end or low frequency. Do not reproduce the old camera PATCH churn failure mode.
- [ ] Disable orbit controls while gizmo drag is active.

Focused tests:

- [ ] `Viewport3DScene` includes clip layer only when `clip.enabled`.
- [ ] Clip layer cleanup resets renderer clipping planes.
- [ ] Wheel/orbit camera gestures still avoid PATCH churn.
- [ ] Browser smoke proves 3D canvas remains nonblank with clip enabled.

Verification:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/layers/Viewport3DScene.test.ts
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

Done gate: 3D clip context is visually aligned with 2D cut state and does not destabilize camera interaction or WebGL lifecycle.

### Phase 8 - Additional Quality Metrics

This phase is intentionally separate from MVP.

**Files:**

- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py`
- Modify: `packages/fullmag-py/tests/test_meshing.py`
- Modify: `apps/control-room/src/kernel/api/codecs/meshQualityDataCodec.ts`
- Modify: `apps/control-room/src/kernel/api/codecs/meshQualityDataCodec.test.ts`
- Modify Rust API tests for `FMMQ` artifact handling if flags expand.

Steps:

- [ ] Confirm exact Gmsh quality names for each metric before coding. Do not assume names for `skewness`, `aspect_ratio`, or `max_angle`.
- [ ] Extend `MeshQualityReport` with new arrays only after source metrics are confirmed.
- [ ] Version `FMMQ` to v2 or define new flags that v1 decoders reject safely.
- [ ] Update artifact writer to include new metrics only when all arrays have `element_count`.
- [ ] Update Rust endpoint validation to accept v2 and still serve old v1 artifacts.
- [ ] Update frontend decoder and metric selector.
- [ ] Add docs explaining metric direction: higher-is-better vs lower-is-better and default color inversion.

Focused tests:

- [ ] Python test writes an artifact with all metrics and verifies flags/order.
- [ ] Frontend decoder rejects unsupported metric flags until implementation supports them.
- [ ] Frontend quality mapping handles higher-is-better and lower-is-better metrics correctly.

Verification:

```bash
PYTHONPATH=packages/fullmag-py/src pytest packages/fullmag-py/tests/test_meshing.py -k quality
pnpm --dir apps/control-room test -- src/kernel/api/codecs/meshQualityDataCodec.test.ts src/modules/viewport-2d
cargo test -p fullmag-api mesh_shared_domain_quality_data --no-fail-fast
```

Done gate: new metrics are produced by the meshing pipeline, serialized, served, decoded, documented, and selectable without breaking existing `gamma|sicn|volume` artifacts.

### Phase 9 - End-To-End Browser, Performance, And Regression Gates

**Files:**

- Add: `apps/control-room/scripts/smoke-viewport-2d-cross-section.mjs`
- Add: `apps/control-room/scripts/audit-viewport-2d-cross-section-performance.mjs`
- Add Playwright/Vitest fixtures as needed.

Scenarios:

- [ ] FEM session with current shared-domain mesh and `FMMQ` artifact.
- [ ] FEM session with mesh but no per-element quality artifact.
- [ ] No FEM mesh.
- [ ] Large synthetic cross-section fixture with at least 100k polygons for renderer stress.

Performance targets:

- Geometry endpoint under 100 ms for target production meshes after spatial index is warm; record actual numbers instead of claiming.
- Frontend decode plus render-model build under 50 ms for 100k polygons on development workstation; move triangulation/coloring to worker if exceeded.
- 2D viewport idle frame count reaches zero after settling.
- Memory growth remains bounded over 100 plane sweeps.

Verification:

```bash
pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room check:architecture-hygiene
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
pnpm --dir apps/control-room smoke:viewport-2d-cross-section
pnpm --dir apps/control-room audit:viewport-2d-cross-section-performance
cargo test -p fullmag-api router_v2 --no-fail-fast
```

Done gate: automated tests pass, browser smoke shows nonblank 2D and 3D canvases, WebGL contexts are not lost, drawing buffers are non-zero, and performance claims include measured evidence.

## 5. Risks And Mitigations

1. **`viewport-aux` not mounted:** Fix layout first. Do not pretend manifest registration is enough.
2. **Backend full scan too slow:** Reuse/build normal-axis spatial index and cache it per mesh generation.
3. **Quality artifact missing:** Render geometry in neutral mode, show explicit degraded state, and offer mesh rebuild with `per_element_quality=True` only through existing mesh controls.
4. **Multiple WebGL contexts:** Keep 2D canvas independent, demand-rendered, and resource-tracked. Add memory stress before claiming safe.
5. **Ribbon cross-module import debt:** Do not add new direct imports from ribbon to viewport modules. Commands and visualization state are the boundary.
6. **Free-text filter injection or complexity:** MVP grammar is tiny and parsed, never evaluated.
7. **New metrics scope creep:** Keep new metrics out of MVP. They are a pipeline/schema feature, not a UI-only dropdown.
8. **Clip/gizmo camera churn:** Passive overlay first; drag patching is throttled and validated with a zero-PATCH camera smoke for ordinary camera gestures.

## 6. Suggested Work Split

1. Backend/API worker: Phases 1-2.
2. Frontend API/resource worker: Phase 3 and the resource part of Phase 4.
3. 2D renderer worker: Phase 4 render model and Phase 5.
4. UI integration worker: Phase 0 layout, Phase 6 ribbon/inspector.
5. 3D viewport worker: Phase 7 only after Phases 1-6 are green.
6. Metrics worker: Phase 8 after MVP acceptance.

Each worker must run its focused tests before handoff. Final integration runs Phase 9 gates.

## 7. MVP Definition

MVP is complete when:

- `viewport-2d` appears in `viewport-aux`,
- backend serves `FMCS` cross-section geometry for a FEM shared-domain mesh,
- frontend decodes and renders polygons plus wireframe,
- coloring works for existing parent tetrahedron metrics from `FMMQ`,
- plane and position changes update the 2D view through `visualization/state.slice`,
- 3D viewport shows at least passive clip-plane context,
- missing mesh or missing quality data has explicit degraded UI,
- tests and browser smoke prove nonblank canvases and bounded resource lifecycle.

Deferred:

- multiple simultaneous planes,
- click-to-select parent tetrahedron in 3D,
- draggable 3D gizmo,
- FDM structured-grid cross-sections,
- new quality metrics beyond existing `gamma`, `sicn`, `volume`,
- advanced COMSOL shrink-element rendering and animation sweep.
