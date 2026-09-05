---
name: frontend-v2-viewport-lifecycle
description: "Use when modifying apps/control-room 3D or 2D viewport modules, Three.js/WebGL/ECharts renderers, render loops, workers, canvas lifecycle, or viewport resource cleanup."
---

# Frontend v2 Viewport Lifecycle

Use this skill for viewport and rendering work in `apps/control-room`. The user instruction and root `AGENTS.md` take precedence. Reuse already loaded frontend skills.

## Required checks

1. Read the relevant viewport specs: `05-viewport-architecture.md`, `14-viewport-3d-module.md`, and/or `15-viewport-2d-module.md`.
2. Identify whether the change affects topology, field buffers, visualization state, camera, selection, chart/slice resources, workers, or cleanup.
3. Keep topology rebuilds separate from field-buffer updates.
4. Use dirty-driven rendering; idle means no continuous frames.
5. Track and dispose WebGL, ECharts, worker, observer, object-URL, geometry, material, texture, and buffer resources.
6. Keep renderer inputs domain-neutral; FDM/FEM handling belongs in adapters/render-model builders.
7. Keep 2D lifecycle independent from 3D WebGL resources.
8. For ECharts, create once per mount, update only on revision/control changes, resize through an observer, and dispose on unmount.
9. For 3D browser proof, assert canvas visibility, `gl.isContextLost() === false`, and non-zero drawing-buffer dimensions after load. Treat startup context loss as failure until teardown-only behavior is proven.

## Banned patterns

- `renderer.render()` every frame without a dirty reason;
- WebGL resources in React state;
- missing cleanup;
- component-level FDM/FEM renderer forks;
- quantity switching that rebuilds topology without a topology revision change;
- hiding memory leaks by disabling layers;
- interval-driven chart resize/redraw;
- chart options rebuilt from large artifacts on unrelated renders;
- raw artifact arrays kept in React state only for renderer convenience.

## Verification matrix

- 3D/WebGL change: focused viewport test plus the repository browser/WebGL smoke;
- 2D/ECharts change: focused chart/lifecycle test and idle audit;
- shared viewport lifecycle or resource cleanup: both lanes;
- worker or large-buffer change: the relevant memory/leak stress scenario.

Run only applicable commands, for example:

~~~powershell
pnpm --dir apps/control-room test -- --run <focused-test>
pnpm --dir apps/control-room smoke:viewport-3d
pnpm --dir apps/control-room test -- --run <focused-chart-test>
pnpm --dir apps/control-room audit:idle-performance
~~~

If a proof command is unavailable, report the missing evidence instead of claiming closure.
