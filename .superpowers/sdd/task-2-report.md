# Task 2 report: separate stale ghost geometry from field-compatible topology

## RED evidence

Command:

```text
pnpm --dir apps/control-room exec vitest run src/kernel/visualization/visualizationDisplayResolution.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts
```

Result: failed as expected before implementation: 2 failed, 96 passed. The stale-resolution assertion received no degradation reason, and the scene-model assertion could not find either explicit render-model boundary.

## GREEN evidence

The focused command above passed after implementation: 2 test files, 98 tests passed.

Additional verification:

```text
pnpm --dir apps/control-room typecheck
git diff --check
```

Both completed successfully.

## Files changed

- `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts`
- `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.test.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- `apps/control-room/src/modules/viewport-3d/layers/TopologyMeshLayer.tsx`
- `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`

## Result

Stale and unknown topology now use constrained wireframe-only ghost settings. The scene model uses `topologyRenderModelForGeometry` for retained ghost geometry and `fieldCompatibleTopologyRenderModel` only when freshness is current for field requests, demand plans, ranges, scalar colors, glyphs, and field-model construction.

## Concerns

No unresolved concerns. The report and pre-existing Task 1 report remain intentionally unstaged; no `node_modules` symlinks were staged.

## Review-blocker remediation: mesh-quality resource enablement

### RED evidence

After adding an assertion that `useViewport3DMeshQualityData` receives the
current-only `fieldCompatibleTopologyRenderModel`, this focused command failed
as expected against the reviewed implementation:

```text
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts
```

Result: 1 failed, 93 passed. The failing assertion showed that mesh-quality
data was enabled with `topologyRenderModelForGeometry`, which remains non-null
for stale and unknown ghost topology.

### GREEN evidence

After changing only the mesh-quality hook enablement to use
`fieldCompatibleTopologyRenderModel`, the required focused Task 2 suite passed:

```text
pnpm --dir apps/control-room exec vitest run src/kernel/visualization/visualizationDisplayResolution.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts
```

Result: 2 test files passed, 98 tests passed.

### Files changed for this remediation

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- `.superpowers/sdd/task-2-report.md`

### Self-review

- Ghost geometry still uses `topologyRenderModelForGeometry`; this change does
  not hide stale or unknown topology.
- Mesh-quality data is a field-dependent resource and is now disabled unless
  topology is current through `fieldCompatibleTopologyRenderModel`.
- The test asserts the exact hook enablement boundary, preventing this resource
  path from regressing to geometry-based enablement.
