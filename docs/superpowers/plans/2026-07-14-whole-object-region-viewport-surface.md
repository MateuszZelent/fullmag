# Whole-object Region Viewport Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore ferromagnetic object surfaces and their scoped `m?component=x` field demand without changing independent visualization behavior for genuine subregions.

**Architecture:** Keep the repair inside the existing manifest-region-to-visualization-target classifier. Exclude only a region whose sole source object canonically equals its source-region candidate; preserve the existing region target construction for genuine and multi-object regions. Verify the lifecycle error independently after the surface is restored.

**Tech Stack:** TypeScript 5.8, React 19, Next.js 16, React Three Fiber 9, Vitest 4, Playwright smoke scripts, ESLint 9.

## Global Constraints

- Do not change backend field computation, OpenAPI, binary codecs, solver semantics, or visualization defaults.
- Preserve independent visibility, shader, vector, and field settings for genuine subregions.
- Component X continues to use quantity `m` with query component `x`.
- Do not introduce hardcoded data ranges, fallback geometry, reduced glyph density, or lower visualization quality.
- Every changed line must be directly required by this bug.
- Final proof requires typecheck, zero-warning lint, tests, React Doctor, and a visible live WebGL canvas with a non-lost context and non-zero drawing buffer.

---

### Task 1: Correct whole-object region target classification

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts:1985`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:1150`

**Interfaces:**
- Consumes: `resolveViewport3DRegionTargetByPartId(regions): Map<string, VisualizationTargetRef>` and `canonicalVisualizationSceneObjectId(id: string): string`.
- Produces: the same public function and return type, with whole-object manifest regions omitted from the map.

- [ ] **Step 1: Write the failing regression test**

Extend the existing mesh-backed region target test so its fixture contains both a whole-object material region and a genuine subregion:

```ts
const regions = [
  {
    bounds_max: [1, 1, 1],
    bounds_min: [0, 0, 0],
    element_count: 24,
    mesh_part_ids: ["part:film_geom"],
    name: "Film",
    region_id: "film",
    source_object_ids: ["film"],
    source_region_candidate_id: "film",
  },
  {
    bounds_max: [1, 1, 1],
    bounds_min: [0, 0, 0],
    element_count: 12,
    mesh_part_ids: ["part:film:core"],
    name: "Core",
    region_id: "film:core",
    source_object_ids: ["film"],
    source_region_candidate_id: "film:core",
  },
] as never;
```

Keep the expected map limited to `part:film:core`. This simultaneously proves that the whole-object part remains object-owned and the genuine subregion still maps to `region:film:film%3Acore`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts
```

Expected: FAIL because the actual map still contains `part:film_geom` with a region target.

- [ ] **Step 3: Implement the minimal classifier guard**

In `resolveViewport3DRegionTargetByPartId`, retain the non-empty source IDs and skip only the sole-source whole-object identity before constructing the target:

```ts
const sourceObjectIds = (region.source_object_ids ?? [])
  .map(asNonEmptyString)
  .filter((id): id is string => id !== null);
const objectId = sourceObjectIds[0] ?? null;
if (!objectId) continue;
if (
  sourceObjectIds.length === 1 &&
  canonicalVisualizationSceneObjectId(regionId) ===
    canonicalVisualizationSceneObjectId(objectId)
) {
  continue;
}
```

Do not alter membership overlay target creation or region visualization defaults.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run the same Vitest command. Expected: the file passes with no unhandled errors.

- [ ] **Step 5: Review the surgical diff**

Run:

```bash
git diff -- apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts
```

Expected: only the regression fixture/assertion and classifier guard are new; pre-existing semantic-target-catalog edits remain untouched.

### Task 2: Prove the restored field and WebGL path

Before running this task, repair the field-query identity exposed by the first managed smoke:

- Add a RED assertion in `apps/control-room/src/kernel/api/fieldQueryIdentity.test.ts` that `canonicalFieldVectorQuery` retains `part:film_mesh` for `scope_kind: "part"`, and that serialization emits `scope_id=part%3Afilm_mesh`.
- Keep the existing assertion that `object:film` becomes `film` for `scope_kind: "object"`.
- In `apps/control-room/src/kernel/api/fieldQueryIdentity.ts`, change `canonicalScopeId` so it strips only the `object:` visualization prefix and preserves exact part IDs.
- Run `pnpm --dir apps/control-room exec vitest run src/kernel/api/fieldQueryIdentity.test.ts` before and after implementation to prove RED and GREEN.

**Files:**
- Modify: `apps/control-room/src/kernel/api/fieldQueryIdentity.test.ts`
- Modify: `apps/control-room/src/kernel/api/fieldQueryIdentity.ts`
- Inspect only: `apps/control-room/scripts/smoke-viewport-3d-mixed-targets.mjs`
- Inspect only: `.fullmag/reports/viewport-3d-mixed-target-smoke/*`
- Modify only if a distinct reproduced lifecycle defect requires it: `apps/control-room/src/modules/viewport-3d/Viewport3DCanvas.tsx`
- Test only if that defect reproduces: `apps/control-room/src/modules/viewport-3d/Viewport3DCanvas.test.tsx`

**Interfaces:**
- Consumes: managed recipe `just run-viewport-3d-mixed-target-smoke fem_execution cpu_threads web_port api_port`.
- Produces: browser evidence for scoped field requests, visible magnetic geometry, and healthy WebGL lifecycle.

- [ ] **Step 1: Run the managed mixed-target smoke**

Run:

```bash
just run-viewport-3d-mixed-target-smoke cpu auto 3100 8195
```

Expected: smoke passes and reports an `m` request whose query contains `component=x` for the configured ferromagnetic target.

- [ ] **Step 2: Inspect the browser proof**

Confirm from smoke output/artifacts that the ferromagnetic surface is visible, the canvas has positive client dimensions, `gl.isContextLost()` is `false`, and drawing-buffer width and height are both positive.

- [ ] **Step 3: Check the reported React failure independently**

Search captured browser console errors for `Maximum update depth exceeded`. Expected: no match.

If it occurs, stop this task and create a focused RED lifecycle test that reproduces the render feedback at `Viewport3DCanvas.tsx`; change the canvas lifecycle only after that test fails for the same reason. Do not treat the region classifier as proof of a canvas fix.

### Task 3: Run production quality gates

**Files:**
- No planned source changes.

**Interfaces:**
- Consumes: the completed classifier repair.
- Produces: fresh repository-level correctness and quality evidence.

- [ ] **Step 1: Run TypeScript and lint gates**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Expected: both exit 0; ESLint reports zero warnings.

- [ ] **Step 2: Run the complete test suite**

```bash
pnpm --dir apps/control-room test
```

Expected: all test files pass with no unhandled errors.

- [ ] **Step 3: Run viewport performance and memory gates**

```bash
pnpm --dir apps/control-room test -- --run viewport
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
```

Expected: all commands exit 0 and no idle redraw, resource leak, or WebGL context-loss regression is reported.

- [ ] **Step 4: Run React Doctor**

```bash
npx -y react-doctor@latest apps/control-room --verbose --diff
```

Expected: command exits 0 and the score does not regress because of this change.

- [ ] **Step 5: Record final evidence without committing unrelated work**

Run `git diff --cached --name-only` separately before any commit. Commit only the approved spec, plan, focused test, and classifier change if no unrelated staged paths are present; otherwise leave the changes uncommitted and report that condition.
