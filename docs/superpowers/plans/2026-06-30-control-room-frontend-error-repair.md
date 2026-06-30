# Control Room Frontend Error Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the frontend failures documented in `docs/diagnostics/control-room-frontend-error-audit-2026-06-30.md` until `apps/control-room` passes the relevant smoke and hygiene gates again.

**Architecture:** Keep the frontend v2 module boundary intact: Explorer must not import Inspector internals, React components must keep using the resource/API facade, and viewport rendering must consume token-derived visualization defaults. Fix the Study authoring smoke as a product/workflow contract: clicking the exact Explorer node must select that node and render the expected Inspector surface, not merely avoid a timeout.

**Tech Stack:** Next.js 16.2.6, React 19.2.4, TypeScript 5.8.3, Vitest, Playwright smoke scripts, `apps/control-room` v2 module kernel, resource-first API paths.

---

## Source Inputs

- Audit: `docs/diagnostics/control-room-frontend-error-audit-2026-06-30.md`
- Module boundary spec: `docs/specs/frontend-v2/01-module-kernel-architecture.md`
- Module catalog spec: `docs/specs/frontend-v2/02-module-catalog.md`
- State ownership spec: `docs/specs/frontend-v2/04-state-management.md`
- Performance spec: `docs/specs/frontend-v2/17-performance-memory-profiler.md`

## Non-Negotiable Success Criteria

- `pnpm --dir apps/control-room check:architecture-hygiene` passes.
- `pnpm --dir apps/control-room check:api-hygiene` passes.
- `CONTROL_ROOM_URL=http://localhost:3100/workspace pnpm --dir apps/control-room smoke:study-authoring-ui` passes.
- `CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY=1 pnpm --dir apps/control-room smoke:study-authoring-ui` passes.
- `CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d` passes after viewport color changes.
- `pnpm --dir apps/control-room typecheck`, `lint`, and `test` pass before final report.
- No direct component `fetch(` is introduced under `apps/control-room/src`.
- No new cross-module import from `src/modules/A` to `src/modules/B` is introduced.
- No frontend-only fake OpenAPI path is added for response-map unless backend/OpenAPI is changed in the same task.
- No commit is made unless the user explicitly asks for commits.

## Work Split For Subagents

Use subagents because the user requested them and the work splits cleanly.

- Worker A: Study authoring smoke and Inspector selection contract, Tasks 1-3.
- Worker B: architecture/API/viewport hygiene, Tasks 4-6.
- Worker C: performance/React Doctor repeatability, Tasks 7-8.
- Main agent: integration, final gates, and resolving conflicts.

Workers must not revert the existing dirty files unless explicitly assigned:

- `apps/control-room/src/modules/inspector/primitives/FormField.tsx`
- `apps/control-room/src/modules/inspector/primitives/FormField.test.ts`
- `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.test.ts`

## File Responsibility Map

### Study Smoke And Inspector Routing

- Modify: `apps/control-room/scripts/smoke-study-authoring-ui.mjs`
  - Keep the browser workflow smoke strict, but make failed Explorer selection observable.
  - Update stale Modal Spectrum heading assertion to the current `FMR Modal Spectrum Control` / `FMR Modal Spectrum Chart` contract.
- Modify: `apps/control-room/src/modules/inspector/panels/StudyAuthoringSmokeScript.test.ts`
  - Static script-contract test for selection assertion and current Modal Spectrum text.
- Modify: `apps/control-room/src/modules/inspector/panels/stages/StageInspectors.test.tsx`
  - Add direct coverage for smoke-shaped Hysteresis node ids and study-stage action routing.
- Modify if failing tests prove it is needed: `apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx`
  - Only if `study.stage.action` with selected Hysteresis stage does not resolve to Hysteresis.
- Modify if failing tests prove it is needed: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.ts`
  - Only if selected stage lookup fails for child node ids after a new stage is added.

### Module Boundary Repair

- Create: `apps/control-room/src/kernel/object-extensions/objectExtensionTypes.ts`
- Create: `apps/control-room/src/kernel/object-extensions/objectExtensionRegistry.ts`
- Create: `apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.ts`
- Create: `apps/control-room/src/kernel/object-extensions/useObjectExtensionActivation.ts`
- Create: `apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.test.ts`
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Modify: `apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSection.test.tsx`
- Delete after migration: old non-rendering Inspector-internal object-extension files:
  - `apps/control-room/src/modules/inspector/extensions/objectExtensionTypes.ts`
  - `apps/control-room/src/modules/inspector/extensions/objectExtensionRegistry.ts`
  - `apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSectionModel.ts`
  - `apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSectionModel.test.ts`
  - `apps/control-room/src/modules/inspector/extensions/useObjectExtensionActivation.ts`

Rendering stays in Inspector:

- Keep: `apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSection.tsx`
- Keep: `apps/control-room/src/modules/inspector/extensions/topological-charge/TopologicalChargeExtensionPanel.tsx`

### Viewport Color Token Repair

- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`
- Modify tests as needed:
  - `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
  - `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.test.ts`

### API Hygiene Repair

- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Do not modify `apps/control-room/src/kernel/api/apiPaths.ts` unless backend/OpenAPI really exposes `/response-map.v2`.

### Performance And React Doctor Repeatability

- Modify: `apps/control-room/scripts/smoke-viewport-3d.mjs`
- Modify: `apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`
- Optional follow-up after measurement: resource hook or Explorer startup fan-out files identified by request attribution.
- Optional only with explicit dependency approval: `apps/control-room/package.json`, `apps/control-room/react-doctor.config.json`, `pnpm-lock.yaml`

---

## Task 0: Baseline And Guardrails

**Files:**
- Read only: current worktree.
- Do not edit source in this task.

- [ ] **Step 1: Capture current dirty scope**

Run:

```bash
git status --short apps/control-room docs/diagnostics docs/superpowers/plans
```

Expected:

- Existing dirty Inspector/FormField/ObjectRegionsPanel files may be present from the earlier runtime-error fix.
- This plan file may be untracked.
- No unrelated file should be modified by this task.

- [ ] **Step 2: Confirm the known failures still reproduce before editing**

Run:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
CONTROL_ROOM_URL=http://localhost:3100/workspace \
pnpm --dir apps/control-room smoke:study-authoring-ui
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY=1 \
pnpm --dir apps/control-room smoke:study-authoring-ui
```

Expected:

- `check:architecture-hygiene` fails on Explorer -> Inspector imports and raw viewport `#ffffff`.
- `check:api-hygiene` fails on raw response-map endpoint literals in `buildModelTree.test.ts`.
- Full Study smoke fails on `Live Progress`.
- Frequency-only Study smoke fails on `Modal Spectrum`.

- [ ] **Step 3: Confirm baseline green gates still pass**

Run:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room audit:idle-performance
```

Expected:

- All pass. If one fails on a different error, record it in the implementation notes before continuing.

---

## Task 1: Fix Stale Frequency-Domain Modal Spectrum Smoke Assertion

**Files:**
- Modify: `apps/control-room/scripts/smoke-study-authoring-ui.mjs`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyAuthoringSmokeScript.test.ts`

**Rationale:** The smoke already waits for `data-inspector-surface="fmr-modal-spectrum"`. The current panel headings are `FMR Modal Spectrum Control` and `FMR Modal Spectrum Chart`, not exact heading text `Modal Spectrum`. This is a stale smoke assertion, not proof that the result node is absent.

- [ ] **Step 1: Strengthen the script-structure test before editing the smoke**

In `StudyAuthoringSmokeScript.test.ts`, extend the existing test with these assertions:

```ts
expect(smokeScript).toContain(
  '[data-inspector-surface="fmr-modal-spectrum"]',
);
expect(smokeScript).toContain("FMR Modal Spectrum Control");
expect(smokeScript).toContain("FMR Modal Spectrum Chart");
expect(smokeScript).not.toContain('name: "Modal Spectrum"');
```

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/inspector/panels/StudyAuthoringSmokeScript.test.ts
```

Expected before implementation:

- FAIL because the smoke still contains `name: "Modal Spectrum"` and does not contain the new exact heading text.

- [ ] **Step 2: Update the smoke to assert current headings**

In `verifyFrequencyDomainModalResults()` in `smoke-study-authoring-ui.mjs`, replace:

```js
await inspector.getByRole("heading", {
  exact: true,
  name: "Modal Spectrum",
}).waitFor({
  state: "visible",
  timeout: timeoutMs,
});
```

with:

```js
await inspector.getByRole("heading", {
  exact: true,
  name: "FMR Modal Spectrum Control",
}).waitFor({
  state: "visible",
  timeout: timeoutMs,
});
await inspector.getByRole("heading", {
  exact: true,
  name: "FMR Modal Spectrum Chart",
}).waitFor({
  state: "visible",
  timeout: timeoutMs,
});
```

Do not remove the existing `data-inspector-surface="fmr-modal-spectrum"` wait.

- [ ] **Step 3: Run targeted verification**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/inspector/panels/StudyAuthoringSmokeScript.test.ts
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY=1 \
pnpm --dir apps/control-room smoke:study-authoring-ui
```

Expected:

- Static test passes.
- Frequency-only smoke progresses past the Modal Spectrum heading wait. If it fails later, keep the new failure as a separate observation and do not revert the heading fix.

---

## Task 2: Make Study Smoke Explorer Selection Failures Observable

**Files:**
- Modify: `apps/control-room/scripts/smoke-study-authoring-ui.mjs`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyAuthoringSmokeScript.test.ts`

**Rationale:** The full Study smoke currently times out waiting for Inspector text. The next run must say whether Explorer selection failed, or whether selection succeeded but Inspector routing/rendering failed.

- [ ] **Step 1: Add static test coverage for the selection assertion helper**

In `StudyAuthoringSmokeScript.test.ts`, extend the smoke script assertions:

```ts
expect(smokeScript).toContain("assertExplorerRowSelected");
expect(smokeScript).toContain("collectStudyInspectorDiagnostics");
expect(smokeScript).toContain("aria-selected");
expect(smokeScript).toContain("data-active");
expect(smokeScript).toContain("Explorer selection did not settle");
expect(smokeScript).toContain("Inspector did not render expected Hysteresis context");
expect(smokeScript).toContain("data-scene-stage-count");
expect(smokeScript).toContain("data-stage-draft-count");
expect(smokeScript).toContain(
  "model:study:stages:stage:${stageId}:live-run",
);
expect(smokeScript).toContain(
  "model:study:stages:stage:${stageId}:points",
);
```

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/inspector/panels/StudyAuthoringSmokeScript.test.ts
```

Expected before implementation:

- FAIL because the helper does not exist.

- [ ] **Step 2: Replace raw DOM click helper with a Playwright-visible selection helper**

In `smoke-study-authoring-ui.mjs`, replace `clickExplorerRow(row)` with:

```js
async function clickExplorerRow(row, expectedNodeId = null) {
  await row.scrollIntoViewIfNeeded();
  await row.click();
  if (expectedNodeId) {
    await assertExplorerRowSelected(row, expectedNodeId);
  }
}

async function assertExplorerRowSelected(row, expectedNodeId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await row.getAttribute("aria-selected")) === "true") {
      return;
    }
    await page.waitForTimeout(50);
  }

  const selectedRows = await page
    .locator('.fm-explorer-tree-row[aria-selected="true"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-node-id")).filter(Boolean),
    );
  const inspectorKind = await page
    .locator(".fm-inspector .fm-inspector__header span")
    .textContent()
    .catch(() => null);
  const dataActive = await row.getAttribute("data-active").catch(() => null);

  throw new Error(
    `Explorer selection did not settle on ${expectedNodeId}; selected=${JSON.stringify(
      selectedRows,
    )}; dataActive=${dataActive ?? "unavailable"}; inspectorKind=${inspectorKind ?? "unavailable"}`,
  );
}

async function collectStudyInspectorDiagnostics() {
  const inspector = page.locator(".fm-inspector");
  const panel = inspector.locator(".fm-inspector-panel").first();
  const fieldRows = await inspector
    .locator(".fm-inspector-field-row")
    .evaluateAll((nodes) =>
      nodes.slice(0, 12).map((node) => node.textContent?.trim() ?? ""),
    )
    .catch(() => []);
  return {
    headerKind: await inspector
      .locator(".fm-inspector__header span")
      .textContent()
      .catch(() => null),
    sceneRevision: await panel.getAttribute("data-scene-revision").catch(() => null),
    sceneStageCount: await panel
      .getAttribute("data-scene-stage-count")
      .catch(() => null),
    stageDraftCount: await panel
      .getAttribute("data-stage-draft-count")
      .catch(() => null),
    fieldRows,
  };
}
```

Update calls for the failing paths:

```js
await clickExplorerRow(modalSpectrumNode, "results:frequency-domain:fmr:modal-spectrum");
await clickExplorerRow(liveRunNode, `model:study:stages:stage:${stageId}:live-run`);
await clickExplorerRow(pointsNode, `model:study:stages:stage:${stageId}:points`);
```

Keep simple calls without `expectedNodeId` only for paths where the smoke does not assert a selected Inspector state.

In `assertHysteresisChildInspectors(stageId)`, after clicking `liveRunNode` and before waiting for `Live Progress`, add a bounded context assertion:

```js
const liveRunDiagnostics = await collectStudyInspectorDiagnostics();
if (liveRunDiagnostics.headerKind !== "study.stage.action") {
  throw new Error(
    `Inspector did not render expected Hysteresis context for ${stageId}: ${JSON.stringify(
      liveRunDiagnostics,
    )}`,
  );
}
```

Do not accept this diagnostic check as the final proof. The existing `Live Progress`, `Measurement Plan` hidden, `Hysteresis Points`, and `Live Progress` hidden assertions must remain.

- [ ] **Step 3: Run targeted static test**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/inspector/panels/StudyAuthoringSmokeScript.test.ts
```

Expected:

- PASS.

- [ ] **Step 4: Run both Study smokes and classify the next failure**

Run:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY=1 \
pnpm --dir apps/control-room smoke:study-authoring-ui

CONTROL_ROOM_URL=http://localhost:3100/workspace \
pnpm --dir apps/control-room smoke:study-authoring-ui
```

Expected:

- Frequency-only smoke passes after Task 1, or reports a later actionable failure.
- Full smoke either passes Hysteresis child inspector checks or fails with one of:
  - `Explorer selection did not settle...`: fix Explorer click/selection behavior.
  - `Live Progress` timeout after selected row is correct: continue to Task 3.

---

## Task 3: Repair Hysteresis Child Inspector Routing

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/stages/StageInspectors.test.tsx`
- Modify if needed: `apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx`
- Modify if needed: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.test.ts`
- Modify if needed: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.ts`
- Verify: `apps/control-room/scripts/smoke-study-authoring-ui.mjs`

**Rationale:** Do not fix this by loosening the smoke to accept any Inspector content. The product contract is: `:live-run` renders `Live Progress`; `:points` renders `Hysteresis Points` and hides `Live Progress`.

- [ ] **Step 1: Add smoke-shaped Hysteresis view resolver tests**

In `StageInspectors.test.tsx`, extend the existing `resolveHysteresisInspectorView` test with the exact node ids used by the smoke:

```ts
expect(
  resolveHysteresisInspectorView(
    "model:study:stages:stage:hysteresis-3:live-run",
  ),
).toBe("live-run");
expect(
  resolveHysteresisInspectorView(
    "model:study:stages:stage:hysteresis-3:points",
  ),
).toBe("points");
```

Also add a router-kind assertion near the `StudyStageInspectorRouter` tests:

```ts
expect(resolveStudyStageInspectorKind("study.stage.action", "hysteresis")).toBe(
  "hysteresis",
);
```

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/inspector/panels/stages/StageInspectors.test.tsx
```

Expected:

- PASS if suffix and router-kind logic are already correct.
- FAIL only if the lower-level mapping is actually broken; fix `HysteresisInspectorUtils.ts` or `StudyStageInspectorRouter.tsx` minimally in that case.

- [ ] **Step 2: Add selected-stage lookup coverage that prefers stable stage ids**

In `StudyInspectorPanelModel.test.ts`, add a RED test proving that a Hysteresis child node selects by stable `stageId` even when `stageIndex` is stale or wrong:

```ts
it("prefers stage id over stale stage index for child action refs", () => {
  const snapshot = studySnapshotFromScene({
    study: {
      stages: [
        { kind: "relax", stage_id: "relax-1" },
        { kind: "run", stage_id: "run-1" },
        { kind: "frequency_response", stage_id: "frequency-response-1" },
        { kind: "hysteresis", stage_id: "hysteresis-3" },
      ],
    },
  } as never);

  const model = resolveStudyInspectorModel({
    commandQueue: null,
    currentRun: null,
    selectedNodeId: "model:study:stages:stage:hysteresis-3:live-run",
    selectedStageRef: {
      nodeId: "model:study:stages:stage:hysteresis-3:live-run",
      stageId: "hysteresis-3",
      stageIndex: 0,
    },
    snapshot,
    solverStatus: null,
    stageExecution: null,
  });

  expect(model.selectedStage).toMatchObject({
    index: 3,
    kind: "hysteresis",
    stageId: "hysteresis-3",
  });
});
```

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/inspector/panels/StudyInspectorPanelModel.test.ts
```

Expected:

- FAIL before implementation if `resolveStudyInspectorModel()` still trusts `selectedStageRef.stageIndex` before `stageId`.

- [ ] **Step 3: Fix selected-stage resolution if the RED test fails**

In `StudyInspectorPanelModel.ts`, change selected-stage resolution so it prefers stable ids from the canonical scene snapshot before any index fallback.

Replace the current selected index precedence:

```ts
const selectedStageIndex =
  selectedStageRef?.stageIndex ??
  selectedStageIndexFromId(selectedStageRef?.stageId ?? null, stageExecution) ??
  selectedStageIndexFromNode(selectedNodeId ?? null, stageExecution);
```

with:

```ts
const selectedStageIndex =
  selectedStageIndexFromSnapshotStageId(
    selectedStageRef?.stageId ?? null,
    snapshot,
  ) ??
  selectedStageIndexFromId(selectedStageRef?.stageId ?? null, stageExecution) ??
  selectedStageRef?.stageIndex ??
  selectedStageIndexFromNode(selectedNodeId ?? null, stageExecution);
```

Add this helper near `selectedStageIndexFromId()`:

```ts
function selectedStageIndexFromSnapshotStageId(
  stageId: string | null,
  snapshot: StudyInspectorSnapshot,
): number | null {
  if (!stageId) return null;
  const index = snapshot.stages.findIndex((stage) => stage.stageId === stageId);
  return index >= 0 ? index : null;
}
```

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/inspector/panels/StudyInspectorPanelModel.test.ts
```

Expected:

- PASS.

- [ ] **Step 4: Re-run the full Study smoke**

Run:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
pnpm --dir apps/control-room smoke:study-authoring-ui
```

Expected:

- PASS.
- If it still fails after Tasks 2 and 3 lower-level tests pass, capture the new error message from `assertExplorerRowSelected`, inspect the Inspector header kind, and fix the specific mismatch. Do not change the smoke expectations away from `Live Progress` and `Hysteresis Points`.

---

## Task 4: Move Object Extension Shared Model And State Out Of Inspector

**Files:**
- Create/move: `apps/control-room/src/kernel/object-extensions/objectExtensionTypes.ts`
- Create/move: `apps/control-room/src/kernel/object-extensions/objectExtensionRegistry.ts`
- Create/move: `apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.ts`
- Create/move: `apps/control-room/src/kernel/object-extensions/useObjectExtensionActivation.ts`
- Create/move: `apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.test.ts`
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Modify: `apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSection.test.tsx`
- Delete old non-rendering files under `apps/control-room/src/modules/inspector/extensions/`.

**Rationale:** Explorer currently imports Inspector internals, violating the module-kernel boundary. The shared object-extension registry/model and activation snapshot are cross-module state, so they belong under kernel, not under `shared` rendering primitives and not under Inspector.

- [ ] **Step 1: Move files without changing behavior**

Move these files:

```text
apps/control-room/src/modules/inspector/extensions/objectExtensionTypes.ts
apps/control-room/src/modules/inspector/extensions/objectExtensionRegistry.ts
apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSectionModel.ts
apps/control-room/src/modules/inspector/extensions/useObjectExtensionActivation.ts
apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSectionModel.test.ts
```

to:

```text
apps/control-room/src/kernel/object-extensions/objectExtensionTypes.ts
apps/control-room/src/kernel/object-extensions/objectExtensionRegistry.ts
apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.ts
apps/control-room/src/kernel/object-extensions/useObjectExtensionActivation.ts
apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.test.ts
```

Keep the exported names unchanged.

- [ ] **Step 2: Update imports**

In `ExplorerModule.tsx`, replace:

```ts
import {
  resolveActiveObjectExtensionExplorerItems,
} from "@/modules/inspector/extensions/ObjectExtensionsSectionModel";
import {
  useObjectExtensionActivationSnapshot,
} from "@/modules/inspector/extensions/useObjectExtensionActivation";
```

with:

```ts
import {
  resolveActiveObjectExtensionExplorerItems,
} from "@/kernel/object-extensions/ObjectExtensionsSectionModel";
import {
  useObjectExtensionActivationSnapshot,
} from "@/kernel/object-extensions/useObjectExtensionActivation";
```

In `ObjectExtensionsSection.tsx`, replace imports from local model/types/hook with kernel imports:

```ts
import {
  resolveObjectExtensionsSectionModel,
} from "@/kernel/object-extensions/ObjectExtensionsSectionModel";
import type {
  ObjectExtensionActivationState,
} from "@/kernel/object-extensions/objectExtensionTypes";
import {
  useObjectExtensionActivation,
} from "@/kernel/object-extensions/useObjectExtensionActivation";
```

Update tests similarly:

```ts
import {
  createObjectExtensionActivationState,
} from "@/kernel/object-extensions/ObjectExtensionsSectionModel";
```

- [ ] **Step 3: Confirm no duplicate singleton exists**

Search:

```bash
rg "let activationSnapshot|useObjectExtensionActivationSnapshot|setGlobalObjectExtensionEnabled" apps/control-room/src
```

Expected:

- `let activationSnapshot` appears only in `src/kernel/object-extensions/useObjectExtensionActivation.ts`.
- Explorer and Inspector both import the same kernel hook.

- [ ] **Step 4: Run targeted tests and architecture gate**

Run:

```bash
pnpm --dir apps/control-room test -- \
  src/kernel/object-extensions/ObjectExtensionsSectionModel.test.ts \
  src/modules/inspector/extensions/ObjectExtensionsSection.test.tsx \
  src/modules/explorer/builders/buildModelTree.test.ts
pnpm --dir apps/control-room check:architecture-hygiene
```

Expected:

- Tests pass.
- Architecture gate no longer reports Explorer importing Inspector internals.
- It may still report raw viewport colors until Task 5 is complete.

---

## Task 5: Replace Raw Viewport `#ffffff` Fallbacks With Token-Derived Defaults

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`
- Modify tests as needed:
  - `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
  - `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.test.ts`

**Rationale:** The existing defaults already express token-backed visualization colors:

- `DEFAULT_OBJECT_VISUALIZATION.shaderMonoColor` -> `var(--fm-surface-magnetic)`
- `DEFAULT_AIRBOX_VISUALIZATION.shaderMonoColor` -> airbox token default

Use those instead of raw `#ffffff`.

- [ ] **Step 1: Add or update unit expectations**

In viewport render-plan tests, assert that missing object/part shader mono color falls back to `DEFAULT_OBJECT_VISUALIZATION.shaderMonoColor`, and airbox falls back to `DEFAULT_AIRBOX_VISUALIZATION.shaderMonoColor`.

Example expectation:

```ts
expect(plan.settings.shaderMonoColor).toBe(
  DEFAULT_OBJECT_VISUALIZATION.shaderMonoColor,
);
```

For airbox:

```ts
expect(plan.settings.shaderMonoColor).toBe(
  DEFAULT_AIRBOX_VISUALIZATION.shaderMonoColor,
);
```

Run the relevant targeted test file and verify it fails while raw `#ffffff` remains:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/model/viewport3DFieldDataPlan.test.ts
```

- [ ] **Step 2: Replace raw color fallback in `useViewport3DSceneModel.ts`**

Add import:

```ts
import {
  DEFAULT_OBJECT_VISUALIZATION,
} from "@/kernel/visualization/ObjectVisualizationController";
```

Replace:

```ts
shaderMonoColor: settings.shaderMonoColor ?? "#ffffff",
```

with:

```ts
shaderMonoColor:
  settings.shaderMonoColor ?? DEFAULT_OBJECT_VISUALIZATION.shaderMonoColor,
```

- [ ] **Step 3: Replace raw color fallbacks in `viewport3DFieldDataPlan.ts`**

Add import:

```ts
import {
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
} from "@/kernel/visualization/ObjectVisualizationController";
```

Replace the airbox fallback:

```ts
shaderMonoColor: "#ffffff",
```

with:

```ts
shaderMonoColor: DEFAULT_AIRBOX_VISUALIZATION.shaderMonoColor,
```

Replace the scoped part fallback:

```ts
shaderMonoColor: "#ffffff",
```

with:

```ts
shaderMonoColor: DEFAULT_OBJECT_VISUALIZATION.shaderMonoColor,
```

- [ ] **Step 4: Run viewport and architecture checks**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d
pnpm --dir apps/control-room check:architecture-hygiene
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

Expected:

- Viewport tests pass.
- Architecture hygiene no longer reports raw `#ffffff`.
- Browser viewport smoke still passes.

---

## Task 6: Remove Raw Response-Map Endpoint Literal From Explorer Fixture

**Files:**
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`

**Rationale:** The current test fixture uses `/v2/sessions/current/analysis/frequency-domain/response-map.v2`, but current central API paths do not expose that endpoint. Adding a fake API path would make the API layer lie. Keep this as fixture metadata derived from an existing central path unless backend/OpenAPI changes are intentionally made.

- [ ] **Step 1: Add a local fixture resource key constant**

Near the frequency-domain fixture constants in `buildModelTree.test.ts`, add:

```ts
const FREQUENCY_DOMAIN_RESPONSE_MAP_RESOURCE_KEY =
  `${ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH}#response-map.v2`;
```

- [ ] **Step 2: Replace both raw endpoint literals**

Replace:

```ts
"/v2/sessions/current/analysis/frequency-domain/response-map.v2"
```

with:

```ts
FREQUENCY_DOMAIN_RESPONSE_MAP_RESOURCE_KEY
```

in both the manifest fixture and the `resourceRef` assertion.

- [ ] **Step 3: Verify API hygiene**

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/explorer/builders/buildModelTree.test.ts
pnpm --dir apps/control-room check:api-hygiene
```

Expected:

- Targeted Explorer test passes.
- API hygiene gate passes.

- [ ] **Step 4: Search for new raw endpoint literals**

Run:

```bash
rg '"/v2/|`/v2/' apps/control-room/src/modules apps/control-room/src/shared \
  --glob '!**/*.md'
```

Expected:

- No new runtime UI raw v2 endpoint literals.
- Any test fixture literals must either be existing allowlisted API path tests or removed.

---

## Task 7: Add Viewport Startup Request Attribution Before Optimizing

**Files:**
- Modify: `apps/control-room/scripts/smoke-viewport-3d.mjs`
- Modify: `apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

**Rationale:** The audit found a functional pass but high startup request count and long tasks. Do not optimize blindly. First make the smoke output identify top request groups.

- [ ] **Step 1: Extend script-structure test**

In `viewportSmokeProjectionScript.test.ts`, add assertions that the smoke script includes request attribution fields:

```ts
expect(script).toContain("requestGroups");
expect(script).toContain("sessionRequestGroups");
expect(script).toContain("totalDurationMs");
expect(script).toContain("maxDurationMs");
```

Run:

```bash
pnpm --dir apps/control-room test -- src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
```

Expected before implementation:

- FAIL if request attribution does not exist.

- [ ] **Step 2: Add request grouping to `collectViewport3DPerformancePhase`**

In `smoke-viewport-3d.mjs`, group session requests by method and normalized path prefix. The group record should include:

```js
{
  count,
  maxDurationMs,
  method,
  path,
  totalDurationMs,
  transferSize,
}
```

Normalize dynamic path segments enough to group repeated resource calls. Keep the grouping local to diagnostics output; do not change product code in this task.

- [ ] **Step 3: Run smoke and capture new metrics**

Run:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

Expected:

- Smoke passes.
- Output includes top request groups for the startup and full smoke phases.

- [ ] **Step 4: Decide whether to optimize now**

If the top request groups clearly show duplicate resource hook fan-out from one module, create a separate follow-up implementation plan for that optimization. Do not mix request fan-out optimization into Tasks 1-6 unless it is required to make a failing gate pass.

---

## Task 8: Make React Doctor Repeatable Without `npx @latest`

**Files:**
- Modify only with explicit dependency approval:
  - `apps/control-room/package.json`
  - `apps/control-room/react-doctor.config.json`
  - `pnpm-lock.yaml`

**Rationale:** The audit correctly blocked `npx -y react-doctor@latest` because it executes unpinned third-party code. The fix is either a pinned dev dependency or an explicit decision not to include React Doctor in the local required gate.

- [ ] **Step 1: Choose the dependency policy**

Before editing, decide one of these two concrete paths:

- Path A: add a pinned `react-doctor` dev dependency and scripts.
- Path B: document React Doctor as intentionally excluded until the repo approves that dependency.

Do not run `npx -y react-doctor@latest`.

- [ ] **Step 2A: If Path A is approved, add scripts**

In `apps/control-room/package.json`, add:

```json
"doctor:react": "react-doctor . --verbose",
"doctor:react:diff": "react-doctor . --verbose --diff"
```

Add a pinned `react-doctor` dev dependency using the exact version approved by the user or maintainer.

Run:

```bash
pnpm --dir apps/control-room install --lockfile-only
pnpm --dir apps/control-room doctor:react:diff
```

Expected:

- Lockfile updates deterministically.
- Doctor command runs from the pinned dependency.

- [ ] **Step 2B: If Path B is chosen, update the audit follow-up note only**

Add a short note to the final implementation summary:

```text
React Doctor remains excluded from required gates because the repo does not pin the dependency yet. No unpinned npx @latest command was run.
```

No code change is needed for Path B.

---

## Task 9: Final Full Verification

**Files:**
- No edits unless a verification failure points to a task-specific bug.

- [ ] **Step 1: Run static and unit gates**

Run:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
```

Expected:

- All pass.

- [ ] **Step 2: Run browser smokes**

Run:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY=1 \
pnpm --dir apps/control-room smoke:study-authoring-ui

CONTROL_ROOM_URL=http://localhost:3100/workspace \
pnpm --dir apps/control-room smoke:study-authoring-ui

CONTROL_ROOM_URL=http://localhost:3100/workspace \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

Expected:

- All pass.
- Viewport smoke reports no browser console/page errors.

- [ ] **Step 3: Check forbidden patterns**

Run:

```bash
rg "\\bfetch\\(" apps/control-room/src
rg "from ['\\\"]@/modules/" apps/control-room/src/modules
rg "#[0-9a-fA-F]{3,8}" apps/control-room/src/modules/viewport-3d/hooks apps/control-room/src/modules/viewport-3d/model
rg '"/v2/|`/v2/' apps/control-room/src/modules apps/control-room/src/shared
```

Expected:

- No direct `fetch(` under `apps/control-room/src`.
- No Explorer -> Inspector or other module-to-module runtime imports.
- No raw viewport runtime hex colors in changed viewport files.
- No raw v2 endpoint strings in UI modules/shared code.

- [ ] **Step 4: Diff review**

Run:

```bash
git diff --stat
git diff --check
git diff -- apps/control-room/src/modules/explorer/ExplorerModule.tsx
git diff -- apps/control-room/scripts/smoke-study-authoring-ui.mjs
```

Expected:

- Diff is limited to this plan's files and earlier user-requested runtime-error fixes.
- No whitespace errors.
- No drive-by formatting or unrelated refactors.

## Final Report Template

Use this exact structure in the implementation closeout:

```text
Naprawione:
- Study smoke: frequency-domain modal spectrum assertion now follows the current Inspector surface.
- Study smoke: Hysteresis child selection renders Live Progress / Hysteresis Points and fails with explicit selection diagnostics if it regresses.
- Architecture hygiene: Explorer no longer imports Inspector internals.
- Viewport colors: raw #ffffff fallbacks removed from runtime viewport planning.
- API hygiene: response-map fixture no longer uses raw v2 endpoint literal.

Zweryfikowane:
- pnpm --dir apps/control-room typecheck
- pnpm --dir apps/control-room lint
- pnpm --dir apps/control-room test
- pnpm --dir apps/control-room audit:idle-performance
- pnpm --dir apps/control-room check:architecture-hygiene
- pnpm --dir apps/control-room check:api-hygiene
- CONTROL_ROOM_URL=http://localhost:3100/workspace pnpm --dir apps/control-room smoke:study-authoring-ui
- CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_STUDY_AUTHORING_SMOKE_FREQUENCY_ONLY=1 pnpm --dir apps/control-room smoke:study-authoring-ui
- CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d

Pozostałe ryzyko:
- React Doctor: [pinned dependency added and run / intentionally excluded because dependency is not pinned].
- Viewport startup performance: request attribution [added / deferred] and top request groups [summarized].
```
