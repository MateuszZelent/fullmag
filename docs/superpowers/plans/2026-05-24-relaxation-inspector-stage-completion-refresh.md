# Relaxation Inspector Stage Completion Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a relaxation stage terminates because its stop criterion was reached, the explorer marks that stage as completed with the success/green status and the inspector refreshes from backend runtime resources to show the terminal stage state, stop metric, completion reason, timestamps, and artifacts.

**Architecture:** Keep backend `simulation/stages/execution` as the source of truth for stage lifecycle. Keep session status thin: `resources.stages_revision` invalidates the stage resource, and realtime `resource.batch_changed` recommends `/v2/sessions/current/simulation/stages/execution`. The explorer and inspector consume the same resource hook and derive UI-only display models without copying runtime snapshots into module stores.

**Tech Stack:** Rust API (`crates/fullmag-api`), Rust CLI/runtime publisher (`crates/fullmag-cli`, `crates/fullmag-runner`), Next.js/React control room (`apps/control-room`), Vitest, cargo tests, OpenAPI v2 generated TypeScript.

---

## Current Diagnosis

The current code is close but incomplete:

- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` already has `useStageExecutionResource()` for `SIMULATION_STAGES_EXECUTION_PATH`.
- `apps/control-room/src/modules/explorer/ExplorerModule.tsx` already loads stage execution and calls `modelTreeSnapshotWithStageExecution(...)`.
- `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx` already loads stage execution, solver status, command queue, current run, energy resources, checkpoints, and scene.
- `crates/fullmag-api/src/main.rs` already emits realtime `resource.batch_changed` for stages when `stages_revision > 0`.
- `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs` already exposes `metric_name`, `metric_value`, `threshold`, `reason`, `completed_at_unix_ms`, and `artifact_refs` per stage.

The gaps that explain the observed bug:

- `apps/control-room/src/design/styles/explorer.css` has no green/success styling for `data-status="completed"`, so completed stages do not read as green in the explorer.
- `apps/control-room/src/modules/explorer/explorerSelection.ts` does not create a typed selection ref for study stages; inspector selection is only a `nodeId` string.
- `apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.ts` computes stop-status rows from the active stage. When a stage is completed, `active_stage_index` becomes `null`, so terminal relaxation details can disappear from the runtime section.
- `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs` synthesizes stage IDs with `stage-{index:03}` in readback. That is stable by index but not by canonical scene `stage_id`, which makes explorer/inspector matching weaker than it should be.
- Existing tests assert runtime stage status projection but do not assert completed-stage visual styling, typed stage selection, terminal relaxation stop-metric display, or a backend/API readback that preserves stage identity and stop metrics together.

## File Structure

Modify these files only:

- `crates/fullmag-api/src/types.rs`
  - Add optional `stage_id` and `kind` to `StageExecutionRecord` if the runtime publisher cannot already carry canonical stage identity.
- `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs`
  - Prefer runtime record `stage_id` and `kind` when building `StageExecutionRecordResource`.
- `crates/fullmag-api/src/router_v2/tests.rs`
  - Add API contract tests for completed relaxation stage readback and status resource revision.
- `crates/fullmag-cli/src/types.rs`
  - Mirror `stage_id` and `kind` in the CLI current-live stage execution payload if needed by the API struct change.
- `crates/fullmag-cli/src/orchestrator.rs`
  - Populate stage identity in `ActiveSequenceState` and preserve completion metric fields.
- `apps/control-room/src/kernel/selection/selectionTypes.ts`
  - Add a `study-stage` selection ref.
- `apps/control-room/src/modules/explorer/explorerTypes.ts`
  - Add `stageId?: string` and `stageIndex?: number` to `ExplorerNode`.
- `apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts`
  - Merge stage execution by canonical `stage_id` first, then index fallback.
- `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
  - Put stage identity on `ExplorerNode` and keep completed stages as `status: "completed"`.
- `apps/control-room/src/modules/explorer/explorerSelection.ts`
  - Emit typed `study-stage` selection refs.
- `apps/control-room/src/design/styles/explorer.css`
  - Style `completed` and `skipped` as success/green.
- `apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.ts`
  - Add selected-stage runtime details from `StageExecutionRecordResource`.
- `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx`
  - Render terminal selected-stage details and resource freshness.
- `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
  - Extend stage runtime projection tests.
- `apps/control-room/src/modules/explorer/ExplorerTreeView.test.ts`
  - Add completed-stage row/status coverage through exported row model helpers or a shallow render test if practical.
- `apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.test.ts`
  - Add terminal completed relaxation stage model tests.
- `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.test.tsx`
  - Add static render coverage for completed selected stage details.
- `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`
  - Add coverage that stage recommended fetch invalidates the stage resource and session status if the bridge is updated.
- Generated OpenAPI files under `apps/control-room/src/kernel/api/generated/*`
  - Regenerate only if the Rust schema changes.

Do not modify:

- `apps/legacy_web/**`
- viewport modules
- unrelated FEM/Gmsh/Python dependency work
- existing dirty files unrelated to this bug

## Task 1: Lock the Backend Stage Execution Contract

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify only if required by failing tests: `crates/fullmag-api/src/types.rs`
- Modify only if required by failing tests: `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs`

- [ ] **Step 1: Write a failing API test for terminal relaxation readback**

Add a test near the existing stage execution endpoint tests in `crates/fullmag-api/src/router_v2/tests.rs`:

```rust
#[tokio::test]
async fn stage_execution_endpoint_exposes_completed_relaxation_stop_metric() {
    let state = test_app_state_with_live_session().await;
    if let Some(snapshot) = state.current_live_state.write().await.as_mut() {
        snapshot.state_version = 42;
        snapshot.stage_execution = Some(StageExecutionState {
            total_stages: 1,
            completed_stage_indexes: vec![0],
            stages: vec![StageExecutionRecord {
                status: StageLifecycleState::Completed,
                command_id: Some("cmd-relax".into()),
                started_at_unix_ms: Some(1_700_000_000_000),
                completed_at_unix_ms: Some(1_700_000_010_000),
                reason: Some(fullmag_ir::StageStopReason::Torque),
                artifact_refs: vec!["runs/run-1/stages/stage-relax".into()],
                checkpoint_ref: Some("cp-relaxed".into()),
                loaded_state_ref: None,
                resume_from_checkpoint_ref: None,
                state_transition: Some("preserved".into()),
                metric_name: Some("max_torque_apm".into()),
                metric_value: Some(7.5e1),
                threshold: Some(8.0e1),
            }],
            stage_statuses: vec![StageLifecycleState::Completed],
            active_stage_index: None,
            active_stage_kind: None,
            runtime_state: RuntimeLifecycleState::Completed,
        });
    }

    let app = test_router(state).await;
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/simulation/stages/execution")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["revision"], 42);
    assert_eq!(json["runtime_state"], "completed");
    assert_eq!(json["completed_stage_indexes"], serde_json::json!([0]));
    assert_eq!(json["stages"][0]["status"], "completed");
    assert_eq!(json["stages"][0]["command_id"], "cmd-relax");
    assert_eq!(json["stages"][0]["reason"], "torque");
    assert_eq!(json["stages"][0]["metric_name"], "max_torque_apm");
    assert_eq!(json["stages"][0]["metric_value"], 75.0);
    assert_eq!(json["stages"][0]["threshold"], 80.0);
    assert_eq!(json["stages"][0]["completed_at_unix_ms"], 1_700_000_010_000u64);
    assert_eq!(json["stages"][0]["artifact_refs"][0], "runs/run-1/stages/stage-relax");
    assert_eq!(json["stages"][0]["checkpoint_ref"], "cp-relaxed");
}
```

- [ ] **Step 2: Run the backend test and confirm the current contract**

Run:

```bash
cargo test -p fullmag-api stage_execution_endpoint_exposes_completed_relaxation_stop_metric
```

Expected before implementation: the test may pass for metric fields. If it fails, the failure should identify the missing field or wrong serialization. Do not broaden the test.

- [ ] **Step 3: Add stage identity only if the test proves identity is missing in live data**

If runtime records need canonical identity, change `StageExecutionRecord` in `crates/fullmag-api/src/types.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StageExecutionRecord {
    #[serde(default)]
    pub stage_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    pub status: StageLifecycleState,
    // existing fields stay unchanged
}
```

Then update each struct literal in `crates/fullmag-api/src/session.rs` and tests with:

```rust
stage_id: None,
kind: None,
```

This is mechanical and must not change status, command, metric, checkpoint, or artifact behavior.

- [ ] **Step 4: Prefer record identity in API readback**

In `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs`, change the stage resource mapping to prefer record identity:

```rust
stage_id: record
    .stage_id
    .clone()
    .unwrap_or_else(|| stage_id_for_index(index)),
kind: record.kind.clone().or_else(|| stage_kind_for_index(stage, index)),
```

If `StageExecutionRecord` remains unchanged after Step 2, skip this step.

- [ ] **Step 5: Verify backend contract**

Run:

```bash
cargo test -p fullmag-api stage_execution_endpoint_exposes_completed_relaxation_stop_metric
```

Expected: PASS.

## Task 2: Preserve Stage Identity in Runtime Publication

**Files:**
- Modify only if Task 1 added record identity: `crates/fullmag-cli/src/types.rs`
- Modify only if Task 1 added record identity: `crates/fullmag-cli/src/orchestrator.rs`

- [ ] **Step 1: Mirror stage identity in CLI payload types**

If Task 1 added `stage_id` and `kind`, update `CurrentLiveStageExecutionRecord` in `crates/fullmag-cli/src/types.rs`:

```rust
pub(crate) struct CurrentLiveStageExecutionRecord {
    #[serde(default)]
    pub stage_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    pub status: String,
    // existing fields stay unchanged
}
```

- [ ] **Step 2: Populate IDs in orchestrator sequence state**

In `crates/fullmag-cli/src/orchestrator.rs`, initialize records with stable IDs when constructing `ActiveSequenceState`:

```rust
fn stage_record(index: usize, kind: Option<&str>) -> CurrentLiveStageExecutionRecord {
    CurrentLiveStageExecutionRecord {
        stage_id: Some(format!("stage-{index:03}")),
        kind: kind.map(str::to_string),
        status: "pending".to_string(),
        command_id: None,
        started_at_unix_ms: None,
        completed_at_unix_ms: None,
        reason: None,
        artifact_refs: Vec::new(),
        checkpoint_ref: None,
        loaded_state_ref: None,
        resume_from_checkpoint_ref: None,
        state_transition: None,
        metric_name: None,
        metric_value: None,
        threshold: None,
    }
}
```

Use this helper in `ActiveSequenceState::new` and `ActiveSequenceState::single_current`. When `mark_current(...)` replaces a record, preserve `stage_id` and `kind`:

```rust
stage_id: previous.stage_id,
kind: previous.kind,
```

- [ ] **Step 3: Preserve completion metric fields**

In `ActiveSequenceState::mark_current(...)`, keep the existing behavior:

```rust
metric_name: completion.and_then(|value| value.metric_name.clone()),
metric_value: completion.and_then(|value| value.metric_value),
threshold: completion.and_then(|value| value.threshold),
```

Add a focused test near existing orchestrator stage execution tests:

```rust
#[test]
fn active_sequence_preserves_completed_relaxation_metric_and_identity() {
    let mut state = ActiveSequenceState::single_current();
    state.mark_current_started("cmd-relax", 1_700_000_000_000, None);
    let completion = fullmag_ir::StageCompletionIR {
        status: "completed".into(),
        reason: Some(fullmag_ir::StageStopReason::Torque),
        metric_name: Some("max_torque_apm".into()),
        metric_value: Some(75.0),
        threshold: Some(80.0),
    };
    state.mark_current("completed", Some(&completion), Some(1_700_000_001_000), None);
    let execution = state.completed_stage_execution("completed");

    assert_eq!(execution.completed_stage_indexes, vec![0]);
    assert_eq!(execution.stages[0].status, "completed");
    assert_eq!(execution.stages[0].stage_id.as_deref(), Some("stage-000"));
    assert_eq!(execution.stages[0].metric_name.as_deref(), Some("max_torque_apm"));
    assert_eq!(execution.stages[0].metric_value, Some(75.0));
    assert_eq!(execution.stages[0].threshold, Some(80.0));
}
```

- [ ] **Step 4: Verify runtime publication**

Run:

```bash
cargo test -p fullmag-cli active_sequence_preserves_completed_relaxation_metric_and_identity
```

Expected: PASS.

## Task 3: Add Typed Study Stage Selection

**Files:**
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.ts`
- Test: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`

- [ ] **Step 1: Extend selection types**

In `apps/control-room/src/kernel/selection/selectionTypes.ts`, add to `SelectionRef`:

```ts
| {
    kind:
      | "study.stage.action"
      | "study.stage.eigenmodes"
      | "study.stage.relax"
      | "study.stage.run";
    nodeId: string;
    stageId: string;
    stageIndex: number;
    type: "study-stage";
  }
```

Add equality handling:

```ts
case "study-stage":
  return (
    right.type === "study-stage" &&
    left.kind === right.kind &&
    left.nodeId === right.nodeId &&
    left.stageId === right.stageId &&
    left.stageIndex === right.stageIndex
  );
```

- [ ] **Step 2: Add stage identity to explorer nodes**

In `apps/control-room/src/modules/explorer/explorerTypes.ts`, add optional fields to `ExplorerNode`:

```ts
stageId?: string;
stageIndex?: number;
```

- [ ] **Step 3: Populate stage identity in tree nodes**

In `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`, update `studyStageNode(...)`:

```ts
function studyStageNode(stage: ModelTreeStudyStageSnapshot): ExplorerNode {
  const displayKind = formatStudyStageKind(stage.kind);
  const nodeStageId = stage.stageId ?? `${stage.index}`;
  return {
    id: `model:study:stage:${nodeStageId}`,
    kind: studyStageKind(stage.kind),
    label: `${displayKind} ${stage.index + 1}`,
    parentId: "model:study",
    badge: studyStageBadge(stage),
    icon: stage.kind === "relax" || stage.kind === "run" ? "play" : "activity",
    stageId: nodeStageId,
    stageIndex: stage.index,
    status: stage.status ?? "ready",
    contextCommands: ["study.skip", "workspace.focus-selection"],
  };
}
```

- [ ] **Step 4: Emit study-stage refs from explorer selection**

In `apps/control-room/src/modules/explorer/explorerSelection.ts`, add this branch before the final `return null`:

```ts
if (
  node.stageId &&
  node.stageIndex !== undefined &&
  (node.kind === "study.stage.action" ||
    node.kind === "study.stage.eigenmodes" ||
    node.kind === "study.stage.relax" ||
    node.kind === "study.stage.run")
) {
  return {
    kind: node.kind,
    nodeId: node.id,
    stageId: node.stageId,
    stageIndex: node.stageIndex,
    type: "study-stage",
  };
}
```

- [ ] **Step 5: Add a failing tree identity test**

In `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`, extend the runtime stage test:

```ts
expect(
  flattened.find((node) => node.id === "model:study:stage:runtime-relax"),
).toMatchObject({
  stageId: "runtime-relax",
  stageIndex: 0,
  status: "completed",
});
```

- [ ] **Step 6: Verify explorer model tests**

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/explorer/builders/buildModelTree.test.ts
```

Expected: PASS.

## Task 4: Merge Runtime Stage Data by Stage ID First

**Files:**
- Modify: `apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts`
- Test: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`

- [ ] **Step 1: Add failing test for stage-id merge**

Add this test to `buildModelTree.test.ts`:

```ts
it("merges stage execution by stage id before falling back to index", () => {
  const sceneSnapshot = modelTreeSnapshotFromScene({
    objects: [],
    study: {
      stages: [
        { kind: "relax", stage_id: "relax-main" },
        { kind: "run", stage_id: "run-main" },
      ],
    },
  });

  const snapshot = modelTreeSnapshotWithStageExecution(sceneSnapshot, {
    active_stage_index: null,
    active_stage_kind: null,
    completed_stage_indexes: [1],
    revision: 9,
    runtime_state: "completed",
    stage_statuses: ["running", "completed"],
    stages: [
      { index: 1, stage_id: "run-main", status: "completed" },
      { index: 0, stage_id: "relax-main", status: "running" },
    ],
    total_stages: 2,
  } as never);

  const flattened = flattenExplorerNodes(buildModelTree(snapshot));

  expect(
    flattened.find((node) => node.id === "model:study:stage:relax-main"),
  ).toMatchObject({ label: "Relax 1", status: "running" });
  expect(
    flattened.find((node) => node.id === "model:study:stage:run-main"),
  ).toMatchObject({ label: "Run 2", status: "completed" });
});
```

- [ ] **Step 2: Implement ID-first merge**

In `sceneModelTreeAdapter.ts`, replace the direct index lookup with a map:

```ts
const runtimeByStageId = new Map(
  stageExecution.stages
    .filter((stage) => typeof stage.stage_id === "string")
    .map((stage) => [stage.stage_id, stage]),
);

stages: snapshot.study.stages.map((stage, index) => {
  const runtimeStage =
    (stage.stageId ? runtimeByStageId.get(stage.stageId) : undefined) ??
    stageExecution.stages.find((candidate) => candidate.index === index) ??
    stageExecution.stages[index] ??
    null;
  const runtimeStatus =
    runtimeStage?.status ?? stageExecution.stage_statuses[index] ?? null;
  return {
    ...stage,
    stageId: runtimeStage?.stage_id ?? stage.stageId,
    status: explorerStatusFromRuntimeStage(runtimeStatus) ?? stage.status,
  };
});
```

- [ ] **Step 3: Verify merge behavior**

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/explorer/builders/buildModelTree.test.ts
```

Expected: PASS.

## Task 5: Make Completed Stages Green in Explorer

**Files:**
- Modify: `apps/control-room/src/design/styles/explorer.css`
- Test: `apps/control-room/src/modules/explorer/ExplorerTreeView.test.ts`

- [ ] **Step 1: Add a focused test for completed status labels**

If `ExplorerTreeView` static rendering is already practical in the test file, add:

```ts
it("keeps completed study stages addressable by status", () => {
  const rows = flattenVisibleExplorerRows(
    [
      {
        id: "model:study:stage:stage-000",
        kind: "study.stage.relax",
        label: "Relax 1",
        parentId: "model:study",
        status: "completed",
      },
    ],
    new Set(),
  );

  expect(rows[0]?.node).toMatchObject({
    id: "model:study:stage:stage-000",
    status: "completed",
  });
});
```

Then protect the CSS contract with a text-level assertion in the same test file:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const explorerCssUrl = new URL("../../design/styles/explorer.css", import.meta.url);

it("styles completed explorer rows with the success token", () => {
  const css = readFileSync(fileURLToPath(explorerCssUrl), "utf8");
  expect(css).toContain('.fm-explorer-tree-row[data-status="completed"]');
  expect(css).toContain("var(--fm-success)");
});
```

- [ ] **Step 2: Add completed/skipped success CSS**

In `apps/control-room/src/design/styles/explorer.css`, add completed and skipped to the success rule:

```css
.fm-explorer-tree-row[data-status="completed"],
.fm-explorer-tree-row[data-status="skipped"],
.fm-explorer-tree-row[data-status="mesh-ready"] {
  color: var(--fm-success);
}
```

Keep the existing `mesh-ready` behavior; do not duplicate a separate `mesh-ready` rule.

- [ ] **Step 3: Verify explorer tests**

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/explorer/ExplorerTreeView.test.ts src/modules/explorer/builders/buildModelTree.test.ts
```

Expected: PASS.

## Task 6: Model Terminal Relaxation Details in the Inspector

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.ts`
- Test: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.test.ts`

- [ ] **Step 1: Add the selected runtime record model**

In `StudyInspectorPanelModel.ts`, extend `StudyStageModel`:

```ts
export type StudyStageModel = StudyStageSnapshot & {
  artifactRefs: readonly string[];
  checkpointRef: string | null;
  commandId: string | null;
  completedAtUnixMs: number | null;
  label: string;
  progressPercent: number;
  runtimeMetric: StudyStageRuntimeMetricModel | null;
  stopReason: string | null;
};

export interface StudyStageRuntimeMetricModel {
  name: string;
  threshold: string;
  value: string;
}
```

- [ ] **Step 2: Resolve selected stage from typed ref first**

Change the model input from `selectedNodeId` to selected identity:

```ts
selectedStageRef?: {
  nodeId: string | null;
  stageId?: string | null;
  stageIndex?: number | null;
} | null;
```

Keep `selectedNodeId` as a temporary compatibility input only if too many call sites would change in one diff:

```ts
selectedNodeId?: string | null;
```

Use this order:

```ts
const selectedStageIndex =
  selectedStageRef?.stageIndex ??
  selectedStageIndexFromId(selectedStageRef?.stageId ?? null, stageExecution) ??
  selectedStageIndexFromNode(selectedNodeId ?? null, stageExecution);
```

- [ ] **Step 3: Attach runtime record data to each stage**

Inside `resolveStudyInspectorModel(...)`, build a runtime record map:

```ts
const runtimeStageByIndex = new Map(
  (stageExecution?.stages ?? []).map((stage, index) => [
    typeof stage.index === "number" ? stage.index : index,
    stage,
  ]),
);
```

When building `stages`, attach terminal details:

```ts
const runtimeRecord = runtimeStageByIndex.get(stage.index) ?? null;
const status = runtimeRecord?.status ?? stageExecution?.stage_statuses[stage.index] ?? stage.status;
const isCompleted = status.toLowerCase() === "completed";

return {
  ...stage,
  artifactRefs: runtimeRecord?.artifact_refs ?? [],
  checkpointRef: runtimeRecord?.checkpoint_ref ?? null,
  commandId: runtimeRecord?.command_id ?? null,
  completedAtUnixMs: runtimeRecord?.completed_at_unix_ms ?? null,
  label: stageLabel(stage),
  progressPercent: isCompleted ? 100 : stage.index === activeStageIndex ? progressPercent : 0,
  runtimeMetric: runtimeMetricModel(runtimeRecord),
  stageId: runtimeRecord?.stage_id ?? stage.stageId,
  status,
  stopReason: runtimeRecord?.reason ?? null,
};
```

Add helper:

```ts
function runtimeMetricModel(
  record: StageExecutionResource["stages"][number] | null,
): StudyStageRuntimeMetricModel | null {
  if (!record?.metric_name) return null;
  return {
    name: record.metric_name,
    value: metricValueText(record.metric_name, record.metric_value),
    threshold: metricValueText(record.metric_name, record.threshold),
  };
}

function metricValueText(name: string, value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unavailable";
  if (name === "max_torque_apm") return formatTorquePairFromApm(value);
  if (name === "total_energy_plateau_range_J") return `${formatScientific(value)} J`;
  if (name === "physical_time_s" || name === "pseudotime_s") return `${formatScientific(value)} s`;
  if (name === "steps") return String(value);
  return formatScientific(value);
}
```

- [ ] **Step 4: Keep terminal relax stop visible when active stage is null**

Use selected stage as fallback for relaxation stop rows:

```ts
const relaxReferenceStage =
  activeStage ?? (selectedStage && isRelaxStageKind(selectedStage.kind) ? selectedStage : null);
```

Then pass `relaxReferenceStage` into `resolveRelaxTorqueStop`, `resolveRelaxEnergyStop`, and `resolveRelaxTimeStop`. This keeps a completed selected relaxation stage informative even after `active_stage_index` becomes `null`.

- [ ] **Step 5: Add model test for completed selected relax stage**

Add to `StudyInspectorPanelModel.test.ts`:

```ts
it("keeps terminal relaxation completion details for a selected completed stage", () => {
  const snapshot = studySnapshotFromScene({
    study: {
      stages: [
        {
          kind: "relax",
          stage_id: "stage-relax",
          torque_tolerance_apm: 80,
          max_steps: "1000",
        },
      ],
    },
  } as never);

  const model = resolveStudyInspectorModel({
    commandQueue: null,
    currentRun: null,
    selectedStageRef: {
      nodeId: "model:study:stage:stage-relax",
      stageId: "stage-relax",
      stageIndex: 0,
    },
    snapshot,
    solverStatus: {
      can_accept_commands: true,
      converged: true,
      is_busy: false,
      max_torque_Apm: 75,
      revision: 12,
      runtime_state: "completed",
      runtime_status_code: "completed",
      runtime_status_kind: "completed",
      session_status: "completed",
      warnings: [],
    } as never,
    stageExecution: {
      active_stage_index: null,
      active_stage_kind: null,
      completed_stage_indexes: [0],
      revision: 13,
      runtime_state: "completed",
      stage_statuses: ["completed"],
      stages: [
        {
          artifact_refs: ["runs/run-1/stages/stage-relax"],
          checkpoint_ref: "cp-relaxed",
          command_id: "cmd-relax",
          completed_at_unix_ms: 1_700_000_010_000,
          index: 0,
          kind: "relax",
          metric_name: "max_torque_apm",
          metric_value: 75,
          reason: "torque",
          stage_id: "stage-relax",
          status: "completed",
          threshold: 80,
        },
      ],
      total_stages: 1,
    } as never,
  });

  expect(model.selectedStage).toMatchObject({
    artifactRefs: ["runs/run-1/stages/stage-relax"],
    checkpointRef: "cp-relaxed",
    commandId: "cmd-relax",
    completedAtUnixMs: 1_700_000_010_000,
    progressPercent: 100,
    runtimeMetric: {
      name: "max_torque_apm",
      threshold: "1.005e-4 T / 8.000e1 A/m",
      value: "9.425e-5 T / 7.500e1 A/m",
    },
    status: "completed",
    stopReason: "torque",
  });
  expect(model.runtime.state).toBe("completed");
  expect(model.runtime.relaxTorqueStop?.status).toBe("93.8% of threshold");
});
```

- [ ] **Step 6: Verify model tests**

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/StudyInspectorPanelModel.test.ts
```

Expected: PASS.

## Task 7: Render Terminal Stage Details in the Inspector

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.test.tsx`

- [ ] **Step 1: Pass typed selected stage ref into the model**

In `StudyInspectorPanel.tsx`, derive this before `resolveStudyInspectorModel(...)`:

```ts
const selectedStageRef =
  selection.ref?.type === "study-stage"
    ? {
        nodeId: selection.ref.nodeId,
        stageId: selection.ref.stageId,
        stageIndex: selection.ref.stageIndex,
      }
    : {
        nodeId: selection.nodeId,
      };
```

Then pass:

```ts
selectedStageRef,
```

- [ ] **Step 2: Render stage terminal fields**

In `StudySelectedStageSection`, add rows after the existing kind row:

```tsx
<FieldRow label="Status" value={model.selectedStage?.status ?? "none"} />
<FieldRow
  label="Stop reason"
  value={model.selectedStage?.stopReason ?? "not available"}
/>
<FieldRow
  label="Completed"
  value={
    model.selectedStage?.completedAtUnixMs
      ? new Date(model.selectedStage.completedAtUnixMs).toISOString()
      : "not completed"
  }
/>
<FieldRow
  label="Command"
  value={model.selectedStage?.commandId ?? "not linked"}
/>
```

Render metric details when present:

```tsx
{model.selectedStage?.runtimeMetric ? (
  <>
    <FieldRow
      label="Stop metric"
      value={model.selectedStage.runtimeMetric.name}
    />
    <FieldRow
      label="Metric value"
      value={model.selectedStage.runtimeMetric.value}
    />
    <FieldRow
      label="Metric threshold"
      value={model.selectedStage.runtimeMetric.threshold}
    />
  </>
) : null}
```

Render artifacts compactly:

```tsx
<FieldRow
  label="Checkpoint"
  value={model.selectedStage?.checkpointRef ?? "not available"}
/>
<FieldRow
  label="Artifacts"
  value={
    model.selectedStage?.artifactRefs.length
      ? model.selectedStage.artifactRefs.join(", ")
      : "none"
  }
/>
```

- [ ] **Step 3: Render stage resource freshness**

Add a row in the selected stage section:

```tsx
<FieldRow
  label="Stage resource"
  value={
    stageExecutionRevision === null
      ? "not loaded"
      : `simulation/stages/execution@${stageExecutionRevision}`
  }
/>
```

Pass `stageExecution.data?.revision ?? null` from `StudyInspectorPanel` into `StudySelectedStageSection`.

- [ ] **Step 4: Add static render coverage**

Add a pure render test by exporting `StudySelectedStageSection` if needed:

```tsx
it("renders terminal selected relaxation details", () => {
  const html = renderToStaticMarkup(
    <StudySelectedStageSection
      stageExecutionRevision={13}
      model={{
        boundary: { demagRealization: "default", externalField: "0, 0, 0 T" },
        requested: { backend: "auto", device: "auto", mode: "strict", precision: "double" },
        runtime: {
          activeStageLabel: "No active stage",
          commandBadge: "idle",
          commandError: null,
          commandId: null,
          commandLabel: "No queued commands",
          maxTorque: "9.425e-5 T",
          progressPercent: 100,
          relaxEnergyStop: null,
          relaxTimeStop: null,
          relaxTorqueStop: null,
          runId: "run-1",
          state: "completed",
        },
        selectedStage: {
          algorithm: null,
          artifactRefs: ["runs/run-1/stages/stage-relax"],
          checkpointRef: "cp-relaxed",
          commandId: "cmd-relax",
          completedAtUnixMs: 1_700_000_010_000,
          energyTolerance: null,
          index: 0,
          kind: "relax",
          label: "Relax 1",
          maxSteps: "1000",
          progressPercent: 100,
          runtimeMetric: {
            name: "max_torque_apm",
            threshold: "1.005e-4 T / 8.000e1 A/m",
            value: "9.425e-5 T / 7.500e1 A/m",
          },
          stageId: "stage-relax",
          status: "completed",
          stopReason: "torque",
          torqueTolerance: "80",
          torqueToleranceFormatted: "1.005e-4 T / 8.000e1 A/m",
          torqueToleranceShortFormatted: "1.005e-4 T",
          untilSeconds: null,
        },
        stages: [],
      }}
    />,
  );

  expect(html).toContain("completed");
  expect(html).toContain("torque");
  expect(html).toContain("cmd-relax");
  expect(html).toContain("cp-relaxed");
  expect(html).toContain("max_torque_apm");
  expect(html).toContain("simulation/stages/execution@13");
  expect(html).toContain("runs/run-1/stages/stage-relax");
});
```

- [ ] **Step 5: Verify inspector render tests**

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/StudyInspectorPanel.test.tsx src/modules/inspector/panels/StudyInspectorPanelModel.test.ts
```

Expected: PASS.

## Task 8: Strengthen Realtime/Resource Refresh Guarantees

**Files:**
- Modify only if failing: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`
- Test: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`
- Test: `apps/control-room/src/kernel/resources/studyRuntimeResources.test.ts`

- [ ] **Step 1: Add stage invalidation test**

In `RealtimeInvalidationBridge.test.ts`, add:

```ts
import { SIMULATION_STAGES_EXECUTION_PATH } from "@/kernel/api/apiPaths";

it("invalidates stage execution when realtime recommends the stage resource", () => {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const bridge = new RealtimeInvalidationBridge(resources);

  const handled = bridge.handleEvent({
    payload: {
      changes: [
        {
          recommended_fetch: SIMULATION_STAGES_EXECUTION_PATH,
          resource: "stages",
          revision: 44,
        },
      ],
    },
    type: "resource.batch_changed",
  });

  expect(handled).toBe(true);
  expect(resources.getRevision(SIMULATION_STAGES_EXECUTION_PATH)).toBe(44);
});
```

- [ ] **Step 2: Decide whether session status also needs invalidation**

If live testing shows the stage hook is mounted and receives resource invalidation directly, do not invalidate `session:status` for stage-only changes. If the stage hook is disabled because `status.resources.stages_revision` starts at `0`, add `SIMULATION_STAGES_EXECUTION_PATH` to `SESSION_STATUS_RECOMMENDED_FETCHES`:

```ts
const SESSION_STATUS_RECOMMENDED_FETCHES = new Set<string>([
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
]);
```

Add this assertion to the test only if that change is made:

```ts
expect(resources.getRevision("session:status")).toBe(44);
```

- [ ] **Step 3: Keep `shouldLoadRuntimeStageExecution` strict**

Do not change this function unless there is a proven first-load bug:

```ts
return hasPositiveRevision(status?.resources.stages_revision);
```

The backend already sets `stages_revision` to `snapshot.state_version` when `stage_execution` exists. Loading before that should still return 404/null.

- [ ] **Step 4: Verify resource tests**

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/realtime/RealtimeInvalidationBridge.test.ts src/kernel/resources/studyRuntimeResources.test.ts
```

Expected: PASS.

## Task 9: Regenerate OpenAPI Only If Schema Changed

**Files:**
- Modify only if Task 1 changed Rust schemas: OpenAPI generated files under `apps/control-room/src/kernel/api/generated/*`
- Verify: `apps/control-room/src/kernel/api/apiTypes.ts`

- [ ] **Step 1: Check whether schema changed**

Run:

```bash
git diff -- crates/fullmag-api/src/schemas/runtime.rs crates/fullmag-api/src/types.rs
```

If only internal `types.rs` changed and public `StageExecutionRecordResource` did not change, skip regeneration.

- [ ] **Step 2: Regenerate API bindings if public schema changed**

Use the repo's existing OpenAPI generation command. Find it with:

```bash
rg -n "openapi-v2|generate.*openapi|api.*generate" package.json apps/control-room/package.json justfile scripts crates
```

Then run the exact existing command. Do not hand-edit generated OpenAPI files.

- [ ] **Step 3: Verify generated type usage**

Run:

```bash
pnpm --dir apps/control-room typecheck
```

Expected: PASS.

## Task 10: End-to-End Verification

**Files:**
- No additional edits unless verification finds a defect.

- [ ] **Step 1: Run focused frontend tests**

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/explorer/builders/buildModelTree.test.ts src/modules/explorer/ExplorerTreeView.test.ts src/modules/inspector/panels/StudyInspectorPanelModel.test.ts src/modules/inspector/panels/StudyInspectorPanel.test.tsx src/kernel/realtime/RealtimeInvalidationBridge.test.ts src/kernel/resources/studyRuntimeResources.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run backend/API focused tests**

Run:

```bash
cargo test -p fullmag-api stage_execution_endpoint_exposes_completed_relaxation_stop_metric command_detail_endpoint_exposes_stage_state_linkage
```

Expected: PASS.

If Task 2 changed CLI orchestrator:

```bash
cargo test -p fullmag-cli active_sequence_preserves_completed_relaxation_metric_and_identity
```

Expected: PASS.

- [ ] **Step 3: Run control-room quality gates**

Run:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
```

Expected: all PASS.

- [ ] **Step 4: Run hygiene searches**

Run:

```bash
rg "fetch\\(" apps/control-room/src/modules apps/control-room/src/shared
rg "/v2/" apps/control-room/src/modules apps/control-room/src/shared
rg "stageExecution" apps/control-room/src/modules/inspector apps/control-room/src/modules/explorer
```

Expected:

- No new direct `fetch(...)` in modules.
- No hand-written `/v2/...` endpoint strings in modules/shared code.
- Stage execution usage stays in resource hooks and pure view-model builders.

- [ ] **Step 5: Browser smoke for the actual bug**

Start the app using the repo's normal control-room dev command:

```bash
pnpm --dir apps/control-room exec next dev -p 3101
```

Then run a Playwright smoke against `/workspace` with a fixture or live session that has:

```json
{
  "resources": { "stages_revision": 44 },
  "stage_execution": {
    "revision": 44,
    "runtime_state": "completed",
    "completed_stage_indexes": [0],
    "active_stage_index": null,
    "stage_statuses": ["completed"],
    "stages": [
      {
        "stage_id": "stage-relax",
        "index": 0,
        "kind": "relax",
        "status": "completed",
        "reason": "torque",
        "metric_name": "max_torque_apm",
        "metric_value": 75,
        "threshold": 80,
        "completed_at_unix_ms": 1700000010000,
        "artifact_refs": ["runs/run-1/stages/stage-relax"],
        "checkpoint_ref": "cp-relaxed"
      }
    ]
  }
}
```

Manual acceptance criteria:

- Explorer row `Relax 1` has `data-status="completed"` and green/success color.
- Selecting `Relax 1` opens the Study inspector.
- Inspector selected stage badge is `completed`.
- Inspector shows stop reason `torque`.
- Inspector shows metric `max_torque_apm`, value, threshold, checkpoint, artifact, and `simulation/stages/execution@44`.
- No console error and no React hydration warning.

## Completion Criteria

This work is complete only when all of these are true:

- Backend stage execution resource exposes completed relaxation stop data.
- Realtime/resource invalidation can refresh `simulation/stages/execution`.
- Explorer completed stages are green/success and still selectable.
- Explorer stage selection carries typed `study-stage` identity.
- Inspector uses backend stage execution data for terminal selected stages.
- A completed relaxation remains visible after `active_stage_index` becomes `null`.
- Focused frontend tests pass.
- Focused backend tests pass.
- `pnpm --dir apps/control-room typecheck`, `pnpm --dir apps/control-room test`, and `pnpm --dir apps/control-room check:api-hygiene` pass.
- Browser smoke verifies the original symptom.

