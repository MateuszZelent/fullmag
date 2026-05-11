---
name: frontend-v2-viewport-lifecycle
description: Use when modifying frontend v2 3D or 2D viewport modules, Three.js/WebGL/ECharts renderers, render loops, workers, canvas lifecycle, or viewport resource cleanup.
---

# Frontend v2 Viewport Lifecycle

Use this for all viewport and rendering work.

## Required Checks

1. Read `docs/specs/frontend-v2/05-viewport-architecture.md`, `14-viewport-3d-module.md`, and `15-viewport-2d-module.md`.
2. Identify whether the change affects topology, field buffer, visualization state, camera, selection, or chart/slice resources.
3. Keep topology rebuilds separate from field-buffer updates.
4. Use dirty-driven rendering; idle means no continuous frames.
5. Track and dispose WebGL/ECharts/worker resources.
6. Keep renderer inputs domain-neutral; FDM/FEM handling belongs in adapters/render-model builders.
7. Keep 2D viewport lifecycle independent from 3D WebGL resources.

## Banned Patterns

- `renderer.render()` every animation frame without a dirty reason;
- WebGL resources in React state;
- missing cleanup for geometries, materials, textures, workers, observers, or ECharts instances;
- component-level FDM/FEM renderer fork;
- quantity switching that rebuilds topology without topology revision change;
- hiding memory leaks by disabling layers.

## Verification

```bash
pnpm --dir apps/control-room test -- --run viewport
pnpm --dir apps/control-room test -- --run viewport-memory-stress
pnpm --dir apps/control-room audit:idle-performance
```

If implementation is not present yet, write the intended lifecycle test with the module.
