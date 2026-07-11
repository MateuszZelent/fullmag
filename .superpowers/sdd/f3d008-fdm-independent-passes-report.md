# F3D-008 — independent FDM visualization passes

## Scope

Implement the audited contract that an FDM target independently renders surface,
wireframe, points, and vectors. Bounds remain owned by the existing domain-bounds
layer and therefore do not create an FDM cuboid build on their own.

## TDD evidence

RED (before implementation):

```text
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts
2 failed / 22 total
TypeError: hasAnyEffectiveFdmPass is not a function
TypeError: buildFdmPointPositions is not a function
```

GREEN:

```text
FdmCuboidLayer.test.ts: 23 passed
FdmCuboidLayer.test.ts + viewport3dInspect.test.ts + useViewport3DSceneModel.test.ts:
121 passed
FdmCuboidLayer.test.ts + fdmCuboidBuildState.test.ts + VectorFieldLayer.test.ts + viewport3dPointGeometry.test.ts:
40 passed
pnpm --dir apps/control-room typecheck: passed
targeted ESLint: passed
```

## Implementation

- `resolveFdmCuboidPassPlan` makes the complete effective pass set explicit.
  All-off targets have no cell build; bounds-only remains visible through its
  existing non-cuboid owner.
- Surface and wireframe pass ownership moved to `FdmCuboidSurfacePass`; neither
  a `BoxGeometry` nor surface materials are created for points-only or
  vectors-only state.
- `FdmCuboidPointsPass` builds a tracked Three.js point geometry from bounded
  sampled FDM cell centres. `full` includes every sampled cell; `surface`
  includes only sampled boundary cells. The source model is capped by the
  existing display-cell budget.
- The scene-model build gate now includes points, and its build key includes
  point visibility and geometry scope.
- Vector pass stays independently renderable without a surface instance pass.

## Out of scope

No API, OpenAPI, generated transport, resource hook, or realtime-contract change
was necessary. HTTP v2 remains the field/topology source of truth.
