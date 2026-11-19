---
title: 3D WebGL Viewport, Projections & Studio Rendering
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-visualization-viewport-3d-and-studio)=
# 3D WebGL Viewport, Projections & Studio Rendering

In the FEM visualization Inspector, **Wireframe mesh** defaults to **Surface
mesh**. Choose **Full volume mesh** to inspect interior element edges. This
selection affects wireframe edges independently of vector and point sampling.
While zooming or rotating, a lighter surface preview keeps navigation responsive;
the selected edge detail returns when the camera stops.

`Viewport3DModule` (`apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`) and
`Viewport3DCanvas` render the unified 3D scene across both structured FDM grids and unstructured
FEM tetrahedral/prism meshes using **Three.js** and **@react-three/fiber**. All camera,
layer, quality-profile, clipping, and lighting controls share one state controller cleanly across
live simulations, frequency-domain mode overlays, and offline saved playback.

```{image} /_static/images/ui/viewport-3d-interactive.png
:alt: Interactive 3D WebGL Viewport displaying vector glyphs, HSL surface field colors, dimension cage, and scalar colorbars
:align: center
:width: 100%
```

## Discretization Adapters, Meshes, and Airbox Overlays

- **FDM Adapter (`FdmCuboidLayer`)**: Consumes active cell masks and region assignments (`FMRM`, `FMBM`) to draw structured cells cleanly without generating spurious exterior triangles.
- **FEM Adapter (`TopologyMeshLayer`, `MeshPartLayer`, `RegionMeshOverlayLayer`)**: Decodes streamed binary topology (`FMMT`) and quality bins (`FMMQ`), distinguishing magnetic object bodies, sub-object regions, exterior **Airbox** wireframes/points/surfaces, and **Periodic Pairs** (`PeriodicPairsOverlayLayer`).
- **Scene Overlays & Selection**: Dedicated layers visualize **Move Object Gizmo** (`MoveObjectGizmo`), **Frozen Spins** preview masks (`FrozenSpinsOverlay`), **Planar Monitor** handle/rotation rings, **Dimension Frame** floor/cage reference ticks (`DimensionFrameLayer`), and **Hysteresis Replay** directional glyphs (`HysteresisReplayGlyphLayer`).

```{image} /_static/images/ui/viewport-3d-fem-mesh-airbox.png
:alt: 3D WebGL Viewport rendering FEM object geometry enclosed by the exterior airbox wireframe
:align: center
:width: 100%
```

## Surface Projections, Clipping, Vectors, and Eigenmode Overlays

Through `ObjectVisualizationPanel`, the **View** / **Results** ribbon tabs, and the contextual
**Analysis** tab (`analysis-context`), operators configure per-target (`all`, `airbox`,
`object:<id>`) and global visualization settings:

- **Surface & Texture Coloring**: Render modes (`Shaded`, `Shaded + wireframe`, `Wireframe`, `Points`) paired with `Solid`, **HSL orientation**, scalar components (`X`, `Y`, `Z`, Magnitude $|m|$), and scientific perceptually uniform colormaps (`VisibleColorScales` HUD).
- **Spatial Quantities & Phase Projection**: Inspect canonical $M$, $H_{\text{eff}}$, $H_{\text{demag}}$, $H_{\text{ex}}$, $H_{\text{anis}}$, Torque, Energy, pre-solved antenna fields (`AntennaFieldLayer`), or eigenmode / FMR complex overlays (`real`, `imag`, `magnitude`, `phase_rotated_real`, animated in phase over $0..2\pi$).
- **Vectors & 3D Clipping (`ClipPlaneLayer`)**: Adjustable instanced `THREE.InstancedMesh` glyph density (`8..4096`), domain scope (`auto`, `magnetic_only`, `full_domain`, `airbox_only`), anchor/offset, vector colors, and orthogonal volume clipping/trimming along **XY**, **XZ**, or **YZ** cut planes.

```{image} /_static/images/ui/viewport-3d-surface-projections-clipping.png
:alt: 3D Viewport displaying FEM airbox geometry intersected by an active cross-section cut plane and sample markers
:align: center
:width: 100%
```

```{image} /_static/images/ui/viewport-3d-eigenmode-spatial-profile.png
:alt: 3D Viewport rendering spatial eigenmode amplitude/phase profile overlay
:align: center
:width: 100%
```

## Studio Lighting, Quality Profiles, and High-Resolution PNG Export

`Viewport3DSettingsDialog` (`apps/control-room/src/modules/viewport-3d/components/Viewport3DSettingsDialog.tsx`),
`Viewport3DLightingRig`, `Viewport3DStudioEnvironment`, and `PostProcessingLayer` expose
publication-quality rendering alongside strict quantitative safeguards:

- **Quality Profiles (`viewport3dVisualProfile.ts`)**: `Interactive Lite` (no AA, DPR cap 1, 700 glyphs, no AO/shadows), `Interactive` (AA, DPR 1.25, 1,200 glyphs, 512px shadows, half-res AO), `Balanced` (DPR 1.5, 2,000 glyphs, 1024px shadows), `Figure` (DPR 2, 2,800 glyphs, 2048px shadows, full-res AO), and `Capture` (DPR 2, 3,200 glyphs, `preserveDrawingBuffer: true`).
- **Scientific vs. Presentation Lighting**: In `Scientific — faithful field colors` mode, field surfaces remain unlit and AO/Bloom cannot alter their colors. In `Presentation — PBR and studio HDRI` mode, both field-colored surfaces and uniform geometry respond to key/fill lights, an offline softbox HDRI processed with `PMREMGenerator`, roughness/metalness, soft shadows, and AO. Field values and color interpolation are unchanged, but lighting changes displayed brightness: use Scientific to read exact colors or the HSL Z component. Select **3D View → Visualization mode → Presentation** to reveal shape in a nearly uniform magnetization field. The Scientific/Presentation selector stays above all settings tabs; **Quality → Quality profile** separately chooses Interactive Lite, Interactive, Balanced, or Figure.
- **High-Resolution PNG Export (`viewport3dImageExport.ts`)**: `captureViewport3DImage` captures `1×`, `2×`, or `4×` scaled frames (bounded by GPU limits up to `8192` px per edge / `16,000,000` pixels) with either matching viewport background or true **Transparent** background decoded cleanly from linear premultiplied `RGBA16F` composed targets (`unpremultiplySrgbChannel`), with optional scale-frame, legend, and orientation annotations.

```{image} /_static/images/ui/viewport-3d-studio-rendering.png
:alt: 3D Viewport in Presentation Studio HDRI rendering mode displaying a skyrmion disk on the nm coordinate grid, orientation cube, View settings HUD, and HSL color legend
:align: center
:width: 100%
```

## Controls, boundaries, and state synchronization

- **Primary module**: `Viewport3DModule` and `Viewport3DCanvas` (`apps/control-room/src/modules/viewport-3d/`).
- **Controls**: Ribbon **View** / **Results** / **Analysis** tabs, `Viewport3DAppearanceHud` (**View settings**), `Viewport3DSettingsDialog`, `Viewport3DCameraDialog`, and `ObjectVisualizationPanel`.
- **Rendering boundary**: A rendered surface never guarantees element quality or mesh validity; inspect `MeshQualityStatisticsView` and backend validation diagnostics before claiming solver readiness.
- **Session synchronization**: The 3D viewport consumes published scene, mesh, and field resources and synchronizes visualization state cleanly across live browser sessions and Python `fm.connect()` scripts. Studio lighting, quality profiles, clipping, and PNG capture settings affect browser rendering only and never alter solver physics.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| 3D viewport module & layer orchestration | `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx` | `Viewport3DModule` |
| Custom R3F canvas lifecycle & loss guard | `apps/control-room/src/modules/viewport-3d/Viewport3DCanvas.tsx` | `Viewport3DCanvas` |
| Quality profiles & MSAA/DPR mapping | `apps/control-room/src/modules/viewport-3d/viewport3dVisualProfile.ts` | `getViewport3DVisualProfile` |
| Synthesized studio HDRI & shadow/AO tiers | `apps/control-room/src/modules/viewport-3d/viewport3dPresentation.ts` | `createViewport3DStudioHdri` |
| PMREM studio environment loader | `apps/control-room/src/modules/viewport-3d/layers/Viewport3DStudioEnvironment.tsx` | `Viewport3DStudioEnvironment` |
| 3D View Settings modal dialog | `apps/control-room/src/modules/viewport-3d/components/Viewport3DSettingsDialog.tsx` | `Viewport3DSettingsDialog` |
| Super-sampled transparent/view PNG capture | `apps/control-room/src/modules/viewport-3d/viewport3dImageExport.ts` | `captureViewport3DImage` |
