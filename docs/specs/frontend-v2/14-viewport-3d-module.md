# Frontend v2 - 3D Viewport Module

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Purpose

`viewport-3d` renders the physical domain, mesh, field quantities, vector glyphs, geometry authoring overlays, selection, and camera tools. It must stay domain-neutral at renderer level.

## 2. File Structure

```text
viewport-3d/
  manifest.ts
  Viewport3DModule.tsx
  store.ts
  components/
    ViewportSurface.tsx
    ViewportToolbar.tsx
    ViewportOverlayStack.tsx
  hooks/
    useViewport3DResources.ts
    useViewportCamera.ts
    useViewportPicking.ts
    useDirtyRenderLoop.ts
    useViewportResize.ts
  renderers/
    SceneController.ts
    MeshLayerRenderer.ts
    FieldSurfaceRenderer.ts
    VectorGlyphRenderer.ts
    SelectionLayerRenderer.ts
    AxesGridRenderer.ts
    AirboxRenderer.ts
  resources/
    WebglResourceTracker.ts
    BufferPool.ts
  model/
    buildViewport3DRenderModel.ts
    viewport3DTypes.ts
```

## 3. Render Model

The renderer consumes a render model:

```typescript
export interface Viewport3DRenderModel {
  domain: DomainRenderModel;
  topology: MeshRenderModel | GridRenderModel | null;
  scalarField: ScalarFieldRenderModel | null;
  vectorField: VectorFieldRenderModel | null;
  layers: LayerVisibility;
  selection: SelectionRenderModel;
  cameraHint: CameraHint | null;
  status: ResourceStatus;
}
```

No renderer receives raw API payloads. Adapters convert FDM and FEM resources into this model.

## 4. Dirty Render Loop

The loop is scheduled but only renders when dirty:

- `camera`;
- `resize`;
- `topology`;
- `field`;
- `quantity`;
- `layer`;
- `selection`;
- `context-restored`;
- `explicit-animation`.

Diagnostics record dirty reasons and frame count. Idle workspace should show zero viewport frames after settling.

## 5. Resource Lifecycle

Every WebGL resource must be registered with `WebglResourceTracker`:

- geometry;
- material;
- texture;
- render target;
- buffer attribute;
- shader program if manually managed;
- worker-backed transfer buffer owner.

Disposal rules:

- field value update updates buffer contents, not topology geometry;
- topology revision change releases topology geometry;
- quantity style change may update material uniforms without rebuilding geometry;
- module unmount releases all resources;
- context loss clears resource tracker and rebuilds from current resource model.

## 6. Layer Rules

| Layer | Update trigger |
|---|---|
| mesh surface | topology revision or mesh display style |
| vector glyphs | vector field revision, sampling, glyph style |
| scalar field | field revision, quantity, color range |
| selection | selection change |
| airbox | domain/mesh revision |
| axes/grid | camera/domain setting |
| geometry authoring overlay | geometry draft transaction |

Layers are independent renderer classes. One layer cannot own another layer's disposal.

## 7. Picking

Picking emits `viewport:object-picked` with canonical selection identity. The viewport does not directly open inspector panels.

Picking must support:

- object;
- mesh part;
- face/element where available;
- field probe location;
- no hit.

## 8. Geometry Authoring in 3D

Geometry mode uses the same viewport module with authoring overlays. It does not mount a separate builder viewport.

Authoring overlays must distinguish:

- draft geometry;
- committed geometry;
- invalid geometry;
- mesh-derived geometry;
- selected transform gizmo.

Draft commits go through inspector/command transaction paths.

## 9. Tests and Profiling

Required verification:

- mount/unmount releases all tracked resources;
- quantity switch does not recreate topology geometry;
- selection change does not refetch field data;
- idle render loop stops after dirty frame;
- context loss recovery rebuilds without leaking previous resources;
- memory stress test switches 3D/2D and quantities repeatedly with bounded growth.
