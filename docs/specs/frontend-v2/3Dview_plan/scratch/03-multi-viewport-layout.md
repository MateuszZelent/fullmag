# 03 - Single Viewport Layout and Deferred Multi-View

**Decision:** Phase 5 has one viewport surface. The previous multi-viewport grid plan is superseded.

## 1. Current Scope

The 3D module owns one `viewport-main` surface:

```text
WorkspaceDockLayout
  -> viewport-main slot
    -> Viewport3DModule
      -> Viewport3DCanvas
        -> one R3F Canvas
```

There is no pane array, no active pane, no per-pane layer config, no synced camera, and no split/quad layout in Phase 5.

## 2. Layout Component

```tsx
function Viewport3DModule() {
  const resources = useViewport3DResources();
  const renderModel = buildViewport3DRenderModel(resources);

  return (
    <section className="fm-viewport-3d" data-module-id="viewport-3d">
      <Viewport3DCanvas renderModel={renderModel} />
      <ViewportToolbar renderModel={renderModel} />
      <ViewportOverlayStack renderModel={renderModel} />
    </section>
  );
}
```

CSS:

```css
.fm-viewport-3d {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--fm-surface-0);
}

.fm-viewport-3d__canvas {
  position: absolute;
  inset: 0;
}

.fm-viewport-3d__toolbar,
.fm-viewport-3d__overlay {
  position: absolute;
  z-index: 2;
}
```

## 3. Camera Store

Only one camera exists.

```typescript
interface ViewportCameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  projection: "perspective" | "orthographic";
}

interface Viewport3DStoreState {
  camera: ViewportCameraState;
  setCamera: (patch: Partial<ViewportCameraState>) => void;
  resetCamera: () => void;
  fitToBounds: (bounds: Bounds3) => void;
}
```

Controls call `invalidate()` while the user interacts and write back to the camera store on meaningful changes. Store updates must not create React snapshot loops.

## 4. Toolbar Scope

Toolbar controls operate on canonical visualization state or local camera state:

| Control | Owner |
|---|---|
| quantity | `VisualizationStateResource` |
| scalar/vector visibility | `VisualizationStateResource.layers` |
| vector density/domain | `VisualizationStateResource.layers` |
| airbox visibility | `VisualizationStateResource.layers.airbox` |
| wireframe/mesh view | `VisualizationStateResource.layers` |
| reset/fit camera | viewport store command |
| display quality profile | `VisualizationStateResource.sampling` |

No toolbar control writes private duplicated layer state when a backend visualization state field exists.

## 5. Deferred Multi-View Policy

Multi-view can return only through a new plan/ADR. It must answer:

1. Why a second view is required.
2. Whether single-canvas scissor viewports can satisfy it.
3. CPU/GPU memory budget for every additional view.
4. How decoded resources and WebGL buffers are shared or deliberately duplicated.
5. What tests prove idle frame and memory growth remain bounded.

Multiple WebGL canvases are not allowed by default because each canvas creates a separate context and duplicates GPU uploads.

## 6. Removed From Phase 5

The following old concepts are intentionally removed:

- `ViewportGrid`;
- `ViewportPane`;
- `PaneLayerVisibility`;
- `SyncedOrbitControls`;
- `activePaneId`;
- layout presets `single`, `split-h`, `split-v`, `quad`, `one-plus-two`;
- per-pane toolbars;
- per-pane quantity override.

