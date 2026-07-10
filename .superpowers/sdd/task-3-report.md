# Task 3 report: canonical target routing consumers

## Scope delivered

- The viewport constructs canonical scene object ids once from the scene
  resource and resolves every FEM part through
  `resolveVisualizationTargetForMeshPart`, with `renderingState.targets` as
  the backend authority.
- The Inspector uses the same resolver for selected mesh parts, target snapshot
  registration, per-part settings, and vector patches.
- The View ribbon loads only the scene and mesh manifest it needs while active,
  resolves a selected mesh part from those resources, and uses the same target
  for its selected-display command controls.
- Region handling remains on its existing explicit region-target path; no new
  region inheritance or display pass was added.
- No API route, generated transport, resource schema, direct request, or
  websocket behavior changed. HTTP resources remain authoritative.

## TDD record

RED command:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts src/modules/ribbon/ribbonStructure.test.ts
```

Observed expected failures:

- the viewport result had no canonical `target` identity;
- the Inspector had no shared part-target entry point;
- the Ribbon had no shared mesh-part target resolver.

GREEN command:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts src/modules/ribbon/ribbonStructure.test.ts
```

Result: 3 files passed, 217 tests passed.

## Additional verification

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room exec eslint src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/inspector/panels/ObjectVisualizationPanel.tsx src/modules/inspector/panels/ObjectVisualizationPanelModel.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts src/modules/ribbon/RibbonModule.tsx src/modules/ribbon/ribbonContributions.tsx src/modules/ribbon/ribbonStructure.test.ts src/kernel/selection/visualizationTargetResolver.ts
git diff --check
```

All passed. The targeted search for the prior local `targetForMeshPart` helper
in these consumers returned no matches, which is expected after routing them
through the canonical resolver.
