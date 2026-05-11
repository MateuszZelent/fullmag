# Frontend v2 - 3D Viewport Module

**Status:** Proposed implementation target
**Date:** 2026-05-11
**Decision:** one R3F viewport, one canvas, no split/multi-pane in Phase 5

## 1. Purpose

`viewport-3d` renders the physical domain, mesh, field quantities, vector glyphs, airbox, selection highlights, geometry overlays, and camera tools. It must stay domain-neutral at renderer level.

The renderer uses React Three Fiber (R3F), but R3F is not a substitute for resource ownership. The module must still prove cleanup of WebGL resources, decoded binary resources, workers, observers, subscriptions, and diagnostics state.

## 2. File Structure

```text
viewport-3d/
  manifest.ts
  Viewport3DModule.tsx
  store.ts
  components/
    Viewport3DCanvas.tsx
    ViewportToolbar.tsx
    ViewportOverlayStack.tsx
    OrbitCameraControls.tsx
  hooks/
    useViewport3DResources.ts
    useViewport3DResourceTracker.ts
    useViewport3DDiagnostics.ts
  layers/
    ObjectMeshLayer.tsx
    ScalarFieldLayer.tsx
    VectorGlyphLayer.tsx
    WireframeLayer.tsx
    AirboxLayer.tsx
    AxesGridLayer.tsx
    BoundsBoxLayer.tsx
    SelectionHighlightLayer.tsx
  model/
    buildViewport3DRenderModel.ts
    viewport3DTypes.ts
    fieldColorMapping.ts
    glyphSampling.ts
    lodStrategy.ts
```

Shared adapters and cache live outside the module:

```text
src/domain/adapters/
src/domain/render-models/
src/domain/resources/
src/kernel/api/
src/kernel/resources/
```

## 3. Render Model

The renderer consumes a render model:

```typescript
export interface Viewport3DRenderModel {
  objects: ObjectRenderData[];
  airbox: AirboxRenderData | null;
  universeBounds: Bounds3 | null;
  scalarField: ScalarFieldRenderData | null;
  vectorField: VectorFieldRenderData | null;
  layers: VisualizationLayerState;
  selection: SelectionRenderData;
  cameraHint: CameraHint | null;
  clip: ClipPlaneConfig | null;
  status: ResourceStatus;
  sampling: SamplingConfig;
  quantity: QuantityDisplayConfig;
}
```

No R3F layer receives raw API payloads. FDM/FEM resources are converted by adapters before rendering.

## 4. Single Canvas Rule

Phase 5 mounts exactly one R3F `<Canvas frameloop="demand">`.

Not in Phase 5:

- split viewport;
- multi-pane grid;
- synced cameras across panes;
- per-pane layer/quantity state;
- multiple WebGL canvases.

If multi-view returns later, it requires a separate ADR/performance plan. Multiple WebGL contexts are not allowed by default because they duplicate GPU uploads.

## 5. Dirty Rendering

The canvas renders only for dirty reasons:

- initial resource readiness;
- camera interaction;
- resize;
- topology revision change;
- field revision or quantity change;
- visualization layer/style change;
- selection change;
- context restoration;
- explicit solver animation mode.

Idle workspace must show zero viewport frames after settling. Status ticks, logs, tree expansion, unrelated inspector drafts, and unrelated resource invalidations must not invalidate the 3D canvas.

## 6. Resource Lifecycle

Every module-owned resource must have an owner and release trigger:

| Resource | Owner | Release trigger |
|---|---|---|
| Three.js geometry/material/texture/render target | R3F layer + viewport tracker | topology/style change or layer/module unmount |
| decoded topology/field buffer | `ResourceCache` | eviction or consumer release |
| render-side color/glyph buffer | viewport layer | field/topology change or layer/module unmount |
| worker | hook or worker pool | abort, idle timeout, or module unmount |
| observer/subscription/listener | hook/component | unmount |

Disposal rules:

- field value update updates buffers, not topology geometry;
- topology revision change releases stale topology geometry and compatible derived buffers;
- quantity style change updates uniforms/material state without rebuilding geometry when possible;
- module unmount releases all module-owned resources;
- context loss clears/rebuilds resource ownership from the current render model.

## 7. Layer Rules

| Layer | Update trigger |
|---|---|
| object mesh | topology revision, displayed object/part set, display style |
| scalar field | field revision, quantity/component, color range, compatible topology |
| vector glyphs | vector field revision, density, vector scope, glyph style |
| wireframe | topology revision or wireframe visibility |
| airbox | mesh/manifest revision or airbox visualization state |
| axes/grid/bounds | camera/domain setting |
| selection | kernel selection change |

Layers may share render-model inputs, but one layer cannot own another layer's disposal.

## 8. Picking

Picking emits canonical selection identity through the kernel. The viewport does not directly open inspector panels.

Phase 5 supports:

- object hit where mapping is reliable;
- mesh part hit where mapping is reliable;
- face index or instance id;
- world-space hit point;
- no-hit state.

Phase 5 does not claim numeric field probing unless a backend probe endpoint or topology extension supplies stable boundary face -> element/sample mapping and interpolation semantics.

## 9. Geometry Authoring in 3D

Geometry mode uses the same viewport module with authoring overlays when that feature is implemented. It must not mount a separate builder viewport.

Draft commits go through inspector/command transaction paths. The viewport may display draft overlays, but it does not define a second physical model.

## 10. Tests and Profiling

Required verification:

- one canvas mounts for `viewport-3d`;
- no split/multi-pane state exists in Phase 5 code;
- mount/unmount releases all tracked resources;
- quantity switch does not recreate topology geometry;
- selection change does not refetch field data;
- idle render loop stops after dirty frame;
- context loss recovery rebuilds without stale resource ownership;
- memory stress switches 3D/2D and quantities repeatedly with bounded growth;
- API hygiene proves no module-level fetch or raw `/v2/...` strings.

