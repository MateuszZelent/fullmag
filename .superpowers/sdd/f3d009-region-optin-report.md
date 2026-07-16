# F3D-009 report: opt-in region display visibility

## RED evidence

```text
pnpm --dir apps/control-room exec vitest run src/kernel/visualization/ObjectVisualizationController.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/ribbon/ribbonStructure.test.ts
```

Result before the implementation: 5 failed, 215 passed. The failures proved
that a quantity-only region inherited the owner `visible`, shader,
wireframe, and vector passes; the viewport also replaced an unconfigured
region's effective settings with its owner settings.

## Decision

`resolveRegionInheritedBaseline(ownerSettings)` is the single inheritance
boundary. It carries only the owner's quantity and color treatment:

- active quantity;
- scalar palette and surface color/projection treatment;
- point, vector, and wireframe colors.

It deliberately excludes master visibility, surface/wireframe/points/vectors,
bounds, primitive display, render mode, and geometry scope. Region defaults
therefore remain inactive until a region-scoped display override enables the
desired pass. `visible: true` alone makes the target eligible without silently
selecting a surface, wireframe, point, or vector pass.

The viewport now always consumes the region's effective settings for
manifest-backed region parts instead of falling back to the owner when the
region has no override. Inspector and Ribbon already resolve their region
settings through the same target resolver, so their disabled/active pass gates
now share this contract.

## GREEN evidence

```text
pnpm --dir apps/control-room exec vitest run src/kernel/visualization/ObjectVisualizationController.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/ribbon/ribbonStructure.test.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts src/kernel/visualization/visualizationCommandContributions.test.ts
```

Result: 5 files passed, 282 tests passed.

```text
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room exec eslint src/kernel/visualization/ObjectVisualizationController.ts src/kernel/visualization/ObjectVisualizationController.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/ribbon/ribbonStructure.test.ts
```

Both passed.

## Coverage

- quantity/style-only region remains hidden despite an active owner;
- visible-only region does not activate any unexpected pass;
- explicit region surface enable works while its owner remains hidden;
- mesh-backed region parts use the region effective settings;
- Ribbon reflects an inactive wireframe for a visible-only region while still
  allowing the user to explicitly enable it.

## Scope

No airbox/reset behavior (F3D-010) or carrier behavior (F3D-011/F3D-012) was
changed. This is frontend-only: no OpenAPI v2, generated transport, API facade,
resource hook, event, or codec changed. HTTP visualization state remains the
source of truth and realtime remains invalidation-only.
