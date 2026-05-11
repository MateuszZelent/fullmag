# 3D Visualization — V2 vs V1 Feature Parity Report

**Generated:** 2026-05-12  
**Scope:** `apps/control-room` (v2) vs `apps/web` (v1)  
**Overall progress:** ~52% of v1 feature surface area is implemented or architecturally improved in v2

---

## Executive Summary

| Category | V1 features | V2 implemented | V2 planned | V2 progress |
|---|:---:|:---:|:---:|:---:|
| **Core rendering** | 5 | 5 | 0 | **100%** |
| **Mesh / topology** | 6 | 5 | 1 | **83%** |
| **Vector field** | 7 | 4 | 3 | **57%** |
| **Color / shading** | 6 | 3 | 3 | **50%** |
| **Camera / navigation** | 5 | 5 | 0 | **100%** |
| **HUD / widgets** | 4 | 3 | 1 | **75%** |
| **Interaction / picking** | 5 | 3 | 2 | **60%** |
| **Layer visibility** | 5 | 5 | 0 | **100%** |
| **Per-object visualization** | 4 | 4 | 0 | **100%** |
| **Resource management** | 6 | 4 | 2 | **67%** |
| **Performance** | 5 | 3 | 2 | **60%** |
| **Diagnostics** | 4 | 4 | 0 | **100%** |
| **Domain adapters** | 4 | 3 | 1 | **75%** |
| **2D slice** | 3 | 0 | 3 | **0%** |
| **Clipping** | 2 | 0 | 2 | **0%** |
| **TOTALS** | **71** | **51** | **20** | **72% arch / 52% runtime** |

> [!NOTE]
> "Implemented" means code exists and compiles. "Runtime functional" is a subset — some v2 features (like vector arrows) are wired but depend on a running backend to validate. The 52% figure is a conservative "end-to-end functional" estimate; the 72% figure counts architectural scaffolding that's in place but not yet rendering live data.

---

## Detailed Feature Matrix

### 1. Core Rendering Infrastructure

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| R3F `<Canvas>` integration | ✅ via host | ✅ **direct** | V2 owns the Canvas in `Viewport3DModule.tsx`, V1 injected it externally |
| `frameloop="demand"` | ❌ always-on | ✅ | V2 uses demand-driven rendering — major GPU win |
| WebGL context config (antialias, alpha, power) | ⚠️ defaults | ✅ | V2 explicitly sets `antialias: true, alpha: false, powerPreference: "high-performance"` |
| Background color from tokens | ❌ hardcoded | ✅ | V2 reads `--fm-bg-viewport` via `useViewport3DColors` |
| Lighting setup (ambient + directional) | ✅ | ✅ | V2: `ambientLight 0.72` + `directionalLight 0.9` |

### 2. Mesh / Topology Rendering

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| FEM surface mesh (triangulated faces) | ✅ | ✅ | V2 `MeshPartLayer` builds `BufferGeometry` from decoded topology positions + surface indices |
| FDM structured grid (bounding box fallback) | ✅ | ✅ | V2 `FallbackTopologyMeshLayer` uses fallback surface indices |
| Per-part mesh splitting | ⚠️ partial | ✅ | V2 has per-`MeshPartLayer` with independent geometry, settings, picking |
| Airbox mesh rendering | ⚠️ hack | ✅ | V2 `AirboxLayer` renders per-airbox-part with bounds boxes and vector overlays |
| Vertex normal computation | ✅ implicit | ✅ | V2 calls `geometry.computeVertexNormals()` explicitly |
| FDM cuboid mesh (true voxel faces) | ❌ | ❌ **planned** | Phase 5b: generate cube faces from FDM cell_size + grid dims |

### 3. Vector Field Visualization

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| Vector field line segments (direction sticks) | ✅ | ✅ | V2 `VectorFieldLayer` renders `lineSegments` from field data |
| Per-part vector segments | ⚠️ global only | ✅ | V2 `fieldModel.partVectorSegments` splits vectors per mesh part |
| Airbox vector overlay | ❌ | ✅ | V2 `AirboxLayer` renders vectors when `settings.vectorsVisible` |
| Vector density / downsampling | ✅ manual | ❌ **planned** | V1 had `sampledCount` vs `pointCount`; V2 passes full field (no LOD yet) |
| Arrow glyphs (3D cone+cylinder) | ✅ | ❌ **planned** | V2 uses line segments only, no 3D arrow instancing yet |
| Vector color by orientation (HSL) | ✅ | ❌ **planned** | V2 vectors use flat `colors.field` color; no per-vector HSL yet |
| Vector opacity control | ✅ | ✅ | V2 `VectorFieldLayer` accepts `opacity` prop, applied via `lineBasicMaterial` |

### 4. Color Mapping and Shading

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| Vertex scalar color (magnitude heat map) | ✅ | ✅ | V2 `viewport3dFieldMapping.ts` builds `ScalarColorBuffer`, applied via `applyVertexScalarColorBuffer` |
| HSL orientation color (mx,my→hue, mz→lightness) | ✅ | ✅ **logic only** | V2 `magnetizationColor.ts` has full `magnetizationHslRgb()` but NOT wired to mesh vertex colors yet |
| Chunked async color transform | ❌ | ✅ | V2 `buildVertexScalarColorsChunked()` with abort support and configurable chunk size |
| Color mode switching (orientation/magnitude/x/y/z) | ✅ | ❌ **planned** | V2 reads `vector_style.color_mode` from viz state but doesn't dispatch to different color functions |
| Monochrome color mode | ✅ | ❌ **planned** | V2 store has `mono_color` field but no renderer |
| `MeshStandardMaterial` with roughness | ⚠️ basic | ✅ | V2 uses `roughness: 0.86`, conditional `vertexColors` |

### 5. Camera and Navigation

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| OrbitControls (rotate/pan/zoom) | ✅ | ✅ | V2 `OrbitCameraControls` with `enableDamping: false` |
| Camera state persistence | ❌ | ✅ | V2 `viewport3dStore` persists position + target across re-renders |
| Fit-to-bounds command | ⚠️ | ✅ | V2 `CameraController` responds to `fitRevision` increments |
| Reset camera command | ❌ | ✅ | V2 `resetCameraRevision` in store |
| Camera snap to axis direction | ❌ | ✅ | V2 `snapCameraToDirection()` with Direction3 support via ViewCube clicks |

### 6. HUD / Widgets

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| ViewCube (3D orientation gizmo) | ❌ | ✅ | V2 `GizmoViewcube` via drei, with clickable face-snapping |
| HSL reference sphere | ❌ | ✅ | V2 `HslReferenceSphere` with vertex-colored sphere geometry, `buildHslSphereGeometry()` |
| HSL auto/on/off mode toggle | ❌ | ✅ | V2 store `hslReferenceMode: "auto" | "on" | "off"` |
| Status chips (VEC READY / LOADING) | ✅ | ❌ **planned** | V1 had `vectorStatusChip()` overlay; V2 has HUD bar but no vector status chips |

### 7. Interaction and Picking

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| Click to select object/part | ⚠️ basic | ✅ | V2 `MeshPartLayer.onPointerDown` → `onSelectPart()` with object_id resolution |
| Click domain background | ❌ | ✅ | V2 `DomainBoxLayer.onPointerDown` → `onSelectDomain()` |
| Click airbox boundary face → part resolution | ❌ | ✅ | V2 `resolveFemPartSelectionByBoundaryFace()` resolves faceIndex to mesh part |
| Face value probe readout | ⚠️ crude | ❌ **planned** | Deferred to backend probe/hit-test API |
| Node/vertex value inspection | ❌ | ❌ **planned** | Requires backend probe endpoint |

### 8. Layer Visibility Control

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| Shader pass toggle | ✅ | ✅ | V2 `settings.shaderVisible` per part |
| Wireframe pass toggle | ✅ | ✅ | V2 `settings.wireframeVisible` per part |
| Points pass toggle | ✅ | ✅ | V2 `settings.pointsVisible` per part |
| Vectors pass toggle | ✅ | ✅ | V2 `settings.vectorsVisible` per part |
| Global visibility toggle | ✅ | ✅ | V2 `settings.visible` master switch per visualization target |

### 9. Per-Object Visualization

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| Per-object render mode override | ⚠️ basic | ✅ | V2 `ObjectVisualizationController` with `resolveVisualizationSettings` |
| Per-object opacity control | ❌ | ✅ | V2 `opacityPercent` on visualization targets, applied to materials |
| Airbox separate visualization | ⚠️ hack | ✅ | V2 `AIRBOX_VISUALIZATION_TARGET` with independent settings |
| Inspector panel for visualization | ❌ | ✅ | V2 `ObjectVisualizationPanel` with toggles, render mode, opacity slider, reset |

### 10. Resource Management

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| ETag-based caching (If-None-Match) | ❌ | ✅ | V2 `BinaryRequestOptions.etag` → `If-None-Match` header |
| Resource revision tracking | ⚠️ | ✅ | V2 `useSyncExternalStore` + `ResourceRevisionMap` |
| Geometry disposal tracking | ❌ | ✅ | V2 `Viewport3DResourceTracker.track()` / `release()` |
| Abort controller on unmount | ⚠️ | ✅ | V2 `useResource` effect cleanup aborts in-flight requests |
| Web Worker decode offloading | ✅ | ❌ **planned** | V1 had `binaryDecode.worker.ts`; V2 decodes on main thread |
| Byte budget with LRU eviction | ❌ | ❌ **planned** | Specified in plan but not yet implemented |

### 11. Performance

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| Demand-driven frame loop | ❌ always | ✅ | V2 `frameloop="demand"` — zero GPU when idle |
| Error retry backoff | ❌ | ✅ | V2 `useResource` has `ERROR_RETRY_DELAY_MS` to prevent hot loops |
| Render loop guards | ❌ | ✅ | V2 `CameraController` uses refs to break update cycles |
| LOD mesh decimation | ❌ | ❌ **planned** | Plan mentions cell budget but no LOD yet |
| Instanced rendering for large meshes | ❌ | ❌ **planned** | V2 rebuilds geometry per part, no instancing |

### 12. Diagnostics

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| Resource count tracking | ❌ | ✅ | V2 `useViewport3DResourceCounts` |
| Dirty frame tracking | ❌ | ✅ | V2 `tracker.recordDirtyFrame("camera" | "camera-fit" | ...)` |
| Cache stats display | ❌ | ✅ | V2 `getViewport3DCacheStats()` in HUD diagnostics string |
| Canvas lifecycle probe | ❌ | ✅ | V2 `CanvasLifecycleProbe` component tracks mount/unmount |

### 13. Domain Adapters (FDM/FEM unification)

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| FDM domain meta adapter | ⚠️ bespoke | ✅ | V2 `adaptFdmDomainMeta()` with cell budget |
| FEM shared-domain manifest adapter | ⚠️ bespoke | ✅ | V2 `adaptFemSharedDomainManifest()` with magnetic/airbox part split |
| Unified topology render model | ❌ separate | ✅ | V2 `buildViewport3DTopologyRenderModel()` works for both |
| Field → topology mapping validation | ❌ | ❌ **planned** | Need to validate pointCount matches across domain types |

### 14. 2D Slice Visualization (in 3D viewport)

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| Z-axis slice plane | ✅ | ❌ **planned** | V1 had `SliceLayer`; V2 has no equivalent |
| Slice position control | ✅ | ❌ **planned** | V1 had axis + position + invert in `Viewport3DClipState` |
| Slice heat map texture | ✅ | ❌ **planned** | V1 rendered 2D texture on plane; V2 has no 2D plane rendering |

### 15. Clipping

| Feature | V1 status | V2 status | Notes |
|---|:---:|:---:|---|
| Clip plane (axis-aligned) | ✅ | ❌ **planned** | V1 had `clip: { enabled, axis, position, invert }` |
| Clip plane invert | ✅ | ❌ **planned** | V2 visualization state schema has clip fields but no renderer |

---

## Feature Status by Category (Chart)

```
Core rendering     ██████████████████████████████████████████ 100%
Camera/navigation  ██████████████████████████████████████████ 100%
Layer visibility   ██████████████████████████████████████████ 100%
Per-object viz     ██████████████████████████████████████████ 100%
Diagnostics        ██████████████████████████████████████████ 100%
Mesh/topology      █████████████████████████████████░░░░░░░░  83%
HUD/widgets        ██████████████████████████████░░░░░░░░░░░  75%
Domain adapters    ██████████████████████████████░░░░░░░░░░░  75%
Resource mgmt      ██████████████████████████░░░░░░░░░░░░░░░  67%
Performance        ████████████████████████░░░░░░░░░░░░░░░░░  60%
Interaction        ████████████████████████░░░░░░░░░░░░░░░░░  60%
Vector field       ██████████████████████░░░░░░░░░░░░░░░░░░░  57%
Color/shading      ████████████████████░░░░░░░░░░░░░░░░░░░░░  50%
2D slice           ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   0%
Clipping           ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   0%
```

---

## V2 Improvements Over V1 (Not Present in V1)

These are capabilities that exist only in V2:

| Feature | Description |
|---|---|
| ViewCube navigation gizmo | Clickable 3D cube with face-snap camera orientation |
| HSL reference sphere | Color reference widget with auto/on/off mode |
| Demand-driven frame loop | Zero GPU usage when nothing changes |
| Per-object visualization registry | Inspector-driven render overrides per object/airbox |
| Object visualization inspector panel | Full UI for per-target shader/wire/points/vectors/opacity |
| Canvas lifecycle diagnostics | Mount/unmount tracking, dirty frame counting |
| Error retry backoff | Prevents browser freeze when backend is unavailable |
| Camera state persistence | Survives re-renders and module swaps |
| Typed API facade | All viewport data through `ControlRoomApi`, no raw fetch |
| ETag binary caching | Conditional requests for topology + field data |
| Geometry disposal tracking | Explicit track/release for Three.js GPU resources |
| Chunked async color transform | Non-blocking scalar color computation with abort |
| Per-part vector segments | Independent vector overlays per mesh part |
| Airbox-specific visualization | Independent visibility, opacity, render passes for airbox |

---

## Critical Gaps (Priority Order)

| Priority | Gap | Impact | Estimated effort |
|---|---|---|---|
| **P0** | HSL orientation vertex colors not wired to mesh | Mesh shows magnitude heat map only, no direction colors | 1 day |
| **P0** | Color mode switching (orientation / magnitude / x / y / z) | Users can't change visualization mode | 1 day |
| **P1** | Arrow glyphs (instanced 3D arrows) | Vectors show as sticks, not publication-quality arrows | 2-3 days |
| **P1** | Vector density / downsampling | Large domains flood the viewport with vectors | 1 day |
| **P1** | Web Worker binary decode | Main-thread decode blocks UI for large topologies | 2 days |
| **P2** | Clip plane rendering | No cross-section visualization | 2 days |
| **P2** | 2D slice plane in 3D | No Z-slice overlay | 2 days |
| **P2** | FDM true voxel faces | FDM shows bounding box, not per-cell faces | 3 days |
| **P2** | LOD mesh decimation | No geometry simplification for very large meshes | 3 days |
| **P3** | LRU resource cache with byte budget | Memory grows without bound for large sessions | 2 days |
| **P3** | Face value probe readout | Can't inspect field value at a click point | Backend + 2 days |

---

## Test Coverage

| Test file | Scope | Tests |
|---|---|---|
| `viewport3dRenderModel.test.ts` | Topology + field render model builders | ✅ |
| `viewport3dFieldMapping.test.ts` | Scalar color transforms, chunking, range | ✅ |
| `viewport3dGeometryColors.test.ts` | Vertex color buffer application | ✅ |
| `viewport3dDomainAdapter.test.ts` | FDM/FEM domain adapter logic | ✅ |
| `viewport3dDiagnostics.test.ts` | Resource tracking, diagnostics string | ✅ |
| `viewport3dStore.test.ts` | Camera state, widget state, HSL mode | ✅ |
| `viewport3dResources.test.ts` | Resource hook keys and structure | ✅ |
| `magnetizationColor.test.ts` | HSL color mapping correctness | ✅ |
| `cameraOrientation.test.ts` | Camera snap directions | ✅ |
| `viewCubeModel.test.ts` | ViewCube face geometry | ✅ |
| `viewport3DTargets.test.ts` | Selection bounds, part target resolution | ✅ |
| `viewport-memory-stress.test.ts` | Geometry allocation / disposal stress | ✅ |
| `manifest.test.ts` | Module manifest + slot registration | ✅ |

**13 test files** covering the v2 viewport module — v1 had **4 test files** for the entire 3D feature area.
