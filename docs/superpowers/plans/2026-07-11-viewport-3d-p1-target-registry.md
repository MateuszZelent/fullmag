# Viewport 3D P1 Target Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close F3D-005 and F3D-006 so every object or mesh-part control resolves to one target and renders backend-effective settings.

**Architecture:** `GET /v2/sessions/current/visualization/state` remains authoritative. Pure shared helpers resolve mesh parts using object ownership, scene-validated aliases, and `targets.*`; the effective registry becomes the settings base. Viewport, Inspector, and Ribbon consume those helpers rather than reconstructing target state.

**Tech Stack:** TypeScript, React 19, Vitest, R3F/Three.js, generated OpenAPI v2 types.

## Global Constraints

- HTTP v2 is authoritative and websocket remains invalidation-only; this batch changes no endpoint, OpenAPI schema, or generated transport.
- No cross-module imports, direct transport, second persistent store, quality reduction, or continuous render loop.
- `object_id` maps to `object:<id>`; `geometry_id` maps to an object only if it is present in the current scene; otherwise the target is `part:<mesh-part-id>`.
- A matching backend `targets.parts` entry has precedence over inferred object ownership.
- `targets.*.settings` is the effective base; raw overrides remain configured-state/clear-operation evidence only.
- Regions are deferred to F3D-009/F3D-011/F3D-012 and must not gain inherited active passes here.
- Each behavior change follows red, green, and focused verification before commit.

---

### Task 1: Add the canonical mesh-part target resolver

**Files:**
- Create: `apps/control-room/src/kernel/selection/visualizationTargetResolver.ts`
- Create: `apps/control-room/src/kernel/selection/visualizationTargetResolver.test.ts`
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.test.ts`

**Interfaces:** Produce `resolveVisualizationTargetForMeshPart({ part, sceneObjectIds, targetRegistry }): VisualizationTargetRef`.

- [ ] **Step 1: Add failing tests**

```ts
expect(resolveVisualizationTargetForMeshPart({
  part: { id: "part-film", geometry_id: "projection-film", object_id: null },
  sceneObjectIds: new Set(), targetRegistry: null,
})).toMatchObject({ id: "part-film", kind: "part" });
expect(resolveVisualizationTargetForMeshPart({
  part: { id: "part-film", geometry_id: "projection-film", object_id: null },
  sceneObjectIds: new Set(["projection-film"]), targetRegistry: null,
})).toMatchObject({ id: "object:projection-film", kind: "object" });
```

Also assert that a matching `targets.parts` entry with `scope: "part"` and `scope_id: "part-film"` resolves to the part even when `object_id` exists.

- [ ] **Step 2: Run RED**

Run: `pnpm --dir apps/control-room exec vitest run src/kernel/selection/visualizationTargetResolver.test.ts src/modules/viewport-3d/model/viewport3DTargets.test.ts`

Expected: FAIL because geometry-only parts currently become object targets and registry entries are ignored.

- [ ] **Step 3: Implement minimal resolver**

Match generated registry `scope` and `scope_id` first. Then normalize explicit `object_id`; only normalize `geometry_id` when the normalized id occurs in `sceneObjectIds`; otherwise return `{ id: part.id, kind: "part", label: part.label }`.

- [ ] **Step 4: Run GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-room/src/kernel/selection apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.*
git commit -m "fix(visualization): resolve mesh parts to canonical targets"
```

### Task 2: Make the backend registry the effective settings base

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`

**Interfaces:** Produce `resolveEffectiveTargetRegistryEntry(state, target)` and use `entry.settings` in `resolveTargetVisualization` for airbox, object, and part targets.

- [ ] **Step 1: Add failing tests**

```ts
expect(resolveTargetVisualization({ snapshot, target: objectTarget,
  visualizationState: stateWithObjectRegistrySettings,
}).effectiveSettings).toMatchObject({ surfaceProjectionMode: "thickness_average_z" });
expect(resolveTargetVisualization({ snapshot, target: partTarget,
  visualizationState: stateWithPartRegistrySettings,
}).effectiveSettings).toMatchObject({ shaderVisible: false, wireframeVisible: true });
```

- [ ] **Step 2: Run RED**

Run: `pnpm --dir apps/control-room exec vitest run src/kernel/visualization/ObjectVisualizationController.test.ts`

Expected: FAIL because only airbox currently consumes `targets.*.settings`.

- [ ] **Step 3: Implement one registry lookup**

Match `airbox`, `objects`, and `parts` by generated `scope` plus `scope_id`; map `entry.settings` through the existing resolved-settings mapper before normalizing. Preserve raw overrides only as the returned configured override, and retain a local patch only during a bounded pending transaction.

- [ ] **Step 4: Run GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts
git commit -m "fix(visualization): consume effective target registry"
```

### Task 3: Route every visualization consumer through the resolver

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Modify: the existing focused Ribbon visualization-selection test, or create one beside `ribbonContributions.tsx`.

**Interfaces:** Consume Task 1 and Task 2 with `sceneObjectIds` from the scene resource and `renderingState.targets` from the visualization resource.

- [ ] **Step 1: Add cross-consumer failing tests**

```ts
expect(resolveViewport3DPartVisualizationSettings({
  part: geometryOnlyPart, sceneObjectIds: new Set(),
  visualizationState: stateWithPartRegistry, snapshot,
}).target.id).toBe("part-film");
expect(resolveObjectVisualizationPanelTarget({
  part: geometryOnlyPart, sceneObjectIds: new Set(),
  visualizationState: stateWithPartRegistry,
})).toMatchObject({ id: "part-film", kind: "part" });
```

Assert the Ribbon command target key matches both returned ids.

- [ ] **Step 2: Run RED**

Run: `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts src/modules/ribbon/ribbonContributions.test.tsx`

Expected: FAIL because one or more consumers infer an object directly from `geometry_id`.

- [ ] **Step 3: Integrate shared identity**

Build the scene-id set once per resource revision, pass it and `renderingState?.targets` to shared target resolution, and remove local geometry-id guesses. Keep regions on their current explicit deferred path.

- [ ] **Step 4: Run GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-room/src/modules/viewport-3d apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.* apps/control-room/src/modules/ribbon
git commit -m "fix(viewport): share canonical visualization target routing"
```

### Task 4: Repair the canonical projection fixture and visual gate

**Files:**
- Modify: `apps/control-room/scripts/screenshot-viewport-3d.mjs`
- Modify: `apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

**Interfaces:** Fixture scene has `projection-film`; `targets.parts` entries use generated-shape `scope`, `scope_id`, `source`, and complete `settings`.

- [ ] **Step 1: Add failing fixture-shape tests**

```ts
expect(screenshotScript).toContain('scope: "part"');
expect(screenshotScript).toContain('scope_id: "part-film"');
expect(screenshotScript).toContain('source: "mesh_part"');
expect(screenshotScript).toContain('object_id: "projection-film"');
```

Also assert that the gate rejects zero pixel differences for any pair of the three projection modes.

- [ ] **Step 2: Run RED**

Run: `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

Expected: FAIL because the fixture does not publish a current scene or current target registry shape.

- [ ] **Step 3: Correct only fixture data and assertions**

Publish the OpenAPI v2 registry shape and retain existing visual-difference thresholds; do not waive or lower the visual assertion.

- [ ] **Step 4: Run GREEN and browser gate**

Run: `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

Then: `pnpm --dir apps/control-room screenshot:viewport-3d`

Expected: tests pass and each projection pair has a positive stable pixel difference.

- [ ] **Step 5: Commit**

```bash
git add apps/control-room/scripts/screenshot-viewport-3d.mjs apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
git commit -m "test(viewport): make projection gate use canonical targets"
```

## Final Verification

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room build:webpack
pnpm --dir apps/control-room check:api-hygiene
./scripts/ci-resource-first-gates.sh --strict
```

Run the screenshot gate against its canonical fixture. Any false-positive gate must be corrected with a regression fixture in this branch, not waived.
