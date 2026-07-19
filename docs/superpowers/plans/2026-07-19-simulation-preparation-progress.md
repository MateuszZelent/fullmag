# Simulation Preparation Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a backend-owned, resource-first preparation timeline that drives the approved Control Room option A with honest progress, stage times, bounded logs, reconnect state, and actionable failures.

**Architecture:** `fullmag-cli` owns and publishes the canonical preparation state at orchestration boundaries. `fullmag-api` exposes a thin status revision pointer plus `GET /v2/sessions/current/simulation/preparation`; generated transport and a handwritten Control Room resource hook feed a pure startup view-model and the kernel-owned overlay. HTTP v2 owns snapshots and WebSocket events only invalidate the resource.

**Tech Stack:** Rust, Axum, Serde, utoipa/OpenAPI v2, TypeScript 5.8, React 19, Next.js 16, Vitest, Radix/shadcn-style primitives, Playwright browser smoke, Catppuccin `--fm-*` tokens.

## Global Constraints

- Cover `runtime_startup`, `script_materialization`, `validation`, `planning`, `domain_preparation`, `meshing`, `mesh_postprocessing`, `solver_initialization`, and `ready`.
- Never invent a percentage or ETA; determinate progress exists only when the backend reports a measurable denominator.
- Backend duration calculations use a monotonic clock; Unix timestamps are presentation and correlation values only.
- Keep `GET /v2/sessions/current/status` thin: add only `simulation_preparation_revision`.
- Keep detailed mesh state in `meshing/builds/current` and full engine logs in `diagnostics/engine-log`.
- HTTP v2 is authoritative; WebSocket events carry revision invalidation only.
- Do not add direct component `fetch()`, handwritten component endpoint strings, Zustand copies of server state, v1 routes, or v2-to-v1 fallback.
- The startup overlay remains kernel-owned and does not import module internals.
- Use only `fm-` CSS classes and existing `--fm-*` Catppuccin tokens.
- Preserve SSR/client first-render parity and reduced-motion behavior.
- Preserve all unrelated edits in the shared dirty worktree. Inspect `git diff --cached --name-only` in a separate command immediately before every commit.

---

### Task 1: Canonical preparation state machine

**Files:**
- Create: `crates/fullmag-cli/src/simulation_preparation.rs`
- Modify: `crates/fullmag-cli/src/main.rs`
- Test: `crates/fullmag-cli/src/simulation_preparation.rs`

**Interfaces:**
- Consumes: `crate::formatting::unix_time_millis()` for correlation timestamps.
- Produces: `SimulationPreparationState`, `PreparationStageId`, `PreparationStageStatus`, `PreparationLogEntry`, `begin_stage`, `update_progress`, `complete_stage`, `skip_stage`, `fail_stage`, and `mark_ready`.

- [ ] **Step 1: Write failing transition and bounds tests**

Add unit tests beside the new module that assert the fixed nine-stage ordering, legal forward transitions, idempotent repeated updates, `0..=100` percentage validation, a 200-entry log bound, skipped stages, and failure ownership:

```rust
#[test]
fn preparation_transitions_keep_order_and_bound_log_tail() {
    let mut state = SimulationPreparationState::new("prep-1", 1_000);
    state.begin_stage(PreparationStageId::RuntimeStartup, 1_000, "Starting runtime").unwrap();
    state.complete_stage(PreparationStageId::RuntimeStartup, 1_180, "Runtime ready").unwrap();
    state.begin_stage(PreparationStageId::ScriptMaterialization, 1_180, "Materializing script").unwrap();
    for index in 0..205 {
        state.push_log(1_180 + index, PreparationLogLevel::Info,
            PreparationStageId::ScriptMaterialization, format!("entry {index}"));
    }
    assert_eq!(state.active_stage_id, Some(PreparationStageId::ScriptMaterialization));
    assert_eq!(state.stages[0].duration_ms, Some(180));
    assert_eq!(state.log_tail.len(), MAX_PREPARATION_LOG_ENTRIES);
    assert_eq!(state.log_tail.first().unwrap().message, "entry 5");
}

#[test]
fn preparation_rejects_regression_and_invalid_percent() {
    let mut state = SimulationPreparationState::new("prep-1", 1_000);
    state.begin_stage(PreparationStageId::Planning, 1_100, "Planning").unwrap();
    assert!(state.begin_stage(PreparationStageId::Validation, 1_200, "late validation").is_err());
    assert!(state.update_progress(PreparationStageId::Planning, 101, "invalid", 1_200).is_err());
}
```

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `cargo test -p fullmag-cli simulation_preparation --no-fail-fast`

Expected: compilation fails because `simulation_preparation` and its types do not exist.

- [ ] **Step 3: Implement the minimal typed state machine**

Define serializable snake-case enums and a bounded state:

```rust
pub const MAX_PREPARATION_LOG_ENTRIES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparationStageId {
    RuntimeStartup, ScriptMaterialization, Validation, Planning,
    DomainPreparation, Meshing, MeshPostprocessing, SolverInitialization, Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparationStageStatus { Pending, Active, Completed, Failed, Skipped }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationPreparationState {
    pub preparation_id: String,
    pub revision: u64,
    pub status: PreparationStatus,
    pub active_stage_id: Option<PreparationStageId>,
    pub started_at_unix_ms: u64,
    pub completed_at_unix_ms: Option<u64>,
    pub stages: Vec<PreparationStage>,
    pub log_tail: VecDeque<PreparationLogEntry>,
}
```

Store a private `Instant` per active stage for runtime duration math and omit it from serialization. Increment `revision` only when the serialized semantic snapshot changes. Return a typed `PreparationTransitionError` for regressions, invalid terminal transitions, timestamps that precede stage start, and percentages above 100.

- [ ] **Step 4: Run the focused tests and confirm green**

Run: `cargo test -p fullmag-cli simulation_preparation --no-fail-fast`

Expected: all `simulation_preparation` tests pass.

- [ ] **Step 5: Review and commit the state machine**

Run `git diff --check`, inspect only the three listed files, then stage them. In a separate command run `git diff --cached --name-only`; it must list only those files. Commit with `git commit -m "Add simulation preparation state machine"`.

### Task 2: Publish preparation state through the local live protocol

**Files:**
- Modify: `crates/fullmag-cli/src/live_workspace.rs`
- Modify: `crates/fullmag-cli/src/types.rs`
- Modify: `crates/fullmag-cli/src/control_room.rs`
- Modify: `crates/fullmag-api/src/types.rs`
- Modify: `crates/fullmag-api/src/session.rs`
- Test: `crates/fullmag-cli/src/live_workspace.rs`
- Test: `crates/fullmag-api/src/session.rs`

**Interfaces:**
- Consumes: `SimulationPreparationState` from Task 1.
- Produces: optional `simulation_preparation` in snapshot/session frame payloads and `simulation_preparation_revision` in the API session snapshot.

- [ ] **Step 1: Write failing serialization and merge tests**

Add a CLI snapshot test proving `LocalLiveWorkspaceState::snapshot()` carries preparation without copying it into runtime frames, and an API merge test proving an older delta cannot overwrite a newer preparation revision:

```rust
#[test]
fn snapshot_publishes_preparation_in_session_frame() {
    let state = workspace_state_with_preparation(7);
    let payload = state.snapshot();
    assert_eq!(payload.simulation_preparation.as_ref().unwrap().revision, 7);
}

#[test]
fn current_session_keeps_newest_preparation_revision() {
    let mut current = current_session_with_preparation(7);
    current.merge_snapshot(snapshot_with_preparation(6));
    assert_eq!(current.simulation_preparation.as_ref().unwrap().revision, 7);
}
```

- [ ] **Step 2: Run the protocol tests and confirm red**

Run: `cargo test -p fullmag-cli snapshot_publishes_preparation --no-fail-fast`

Run: `cargo test -p fullmag-api current_session_keeps_newest_preparation_revision --no-fail-fast`

Expected: both fail because preparation is absent from the protocol.

- [ ] **Step 3: Extend snapshot and session-frame payloads**

Add `simulation_preparation: Option<SimulationPreparationState>` to `LocalLiveWorkspaceState`, `CurrentLiveSnapshotPayload`, `CurrentLiveSnapshotRequest`, and `CurrentLiveSessionFrameRequest`. Do not add it to `CurrentLiveRuntimeFrameRequest`. Populate it from `build_publish_payload()` and include it in `sync_current_live_snapshot`/session-frame serialization.

Mirror the payload in `crates/fullmag-api/src/types.rs` as serde-only internal
`SimulationPreparationSnapshot` structs. Task 4 converts that internal snapshot to the
public utoipa schema; the internal live protocol must not depend on the browser schema.
Merge only when `incoming.revision >= current.revision`.

- [ ] **Step 4: Run the protocol tests and confirm green**

Run the two commands from Step 2.

Expected: both focused tests pass and preparation survives a full snapshot plus session-frame update.

- [ ] **Step 5: Commit the protocol extension**

Run `git diff --check`, inspect the listed files, stage only them, inspect `git diff --cached --name-only` separately, and commit with `git commit -m "Publish simulation preparation snapshots"`.

### Task 3: Instrument every preparation boundary

**Files:**
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Modify: `crates/fullmag-cli/src/live_workspace.rs`
- Modify: `crates/fullmag-cli/src/python_bridge.rs`
- Test: `crates/fullmag-cli/src/orchestrator.rs`
- Test: `crates/fullmag-cli/src/live_workspace.rs`
- Test: `crates/fullmag-cli/src/python_bridge.rs`

**Interfaces:**
- Consumes: transition methods from Task 1 and published state from Task 2.
- Produces: explicit stage transitions and safe preparation log entries for every canonical stage.

- [ ] **Step 1: Add failing event-to-stage mapping tests**

Cover existing structured mesh events and orchestration error ownership:

```rust
#[test]
fn mesh_events_update_canonical_preparation_stages() {
    let workspace = test_workspace_in_stage(PreparationStageId::DomainPreparation);
    apply_python_progress_event(&workspace, structured_event("mesh_build_phase", json!({
        "phase": "meshing", "progress_percent": 63,
        "progress_label": "142580 / 226318 elements", "duration_ms": 16_200,
        "message": "Optimizing element quality"
    })));
    let snapshot = workspace.snapshot();
    let preparation = snapshot.simulation_preparation.unwrap();
    assert_eq!(preparation.active_stage_id, Some(PreparationStageId::Meshing));
    assert_eq!(active_stage(&preparation).progress_percent, Some(63));
}
```

Add orchestration tests that prove validation failure marks `validation`, planner failure marks `planning`, and solver construction failure marks `solver_initialization` before the error propagates.

- [ ] **Step 2: Run focused orchestration tests and confirm red**

Run: `cargo test -p fullmag-cli 'preparation|mesh_events_update_canonical' --no-fail-fast`

Expected: new assertions fail because orchestration only updates coarse session status and mesh workspace JSON.

- [ ] **Step 3: Instrument the existing boundaries**

Add a small helper that updates preparation and publishes immediately:

```rust
fn transition_preparation(
    workspace: &LocalLiveWorkspace,
    update: impl FnOnce(&mut SimulationPreparationState) -> Result<(), PreparationTransitionError>,
) -> anyhow::Result<()> {
    let mut transition_result = Ok(());
    workspace.update(|state| {
        transition_result = match state.simulation_preparation.as_mut() {
            Some(preparation) => update(preparation),
            None => Err(PreparationTransitionError::NotInitialized),
        };
    });
    transition_result.map_err(Into::into)
}
```

`LocalLiveWorkspace::update` already publishes once after the mutation; do not add a second
publish call.

Call it at runtime bootstrap, script materialization, validation, planning, domain preparation, meshing, mesh postprocessing, solver initialization, and readiness. Map existing `mesh_build_phase` values to canonical stage ids. Record a safe failure summary on the active owning stage in each error branch. Keep raw errors in the existing engine log and persisted diagnostics only.

- [ ] **Step 4: Run focused tests and CLI compilation**

Run: `cargo test -p fullmag-cli 'preparation|mesh_events_update_canonical' --no-fail-fast`

Run: `cargo check -p fullmag-cli`

Expected: focused tests pass and the CLI compiles.

- [ ] **Step 5: Commit orchestration instrumentation**

Run `git diff --check`, inspect the three implementation files and tests, stage only them, inspect staging separately, and commit with `git commit -m "Report simulation preparation stages"`.

### Task 4: Add the resource-first API and invalidation contract

**Files:**
- Create: `crates/fullmag-api/src/schemas/preparation.rs`
- Modify: `crates/fullmag-api/src/schemas/mod.rs`
- Modify: `crates/fullmag-api/src/schemas/status.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/sessions/status.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify: `docs/specs/resource-first-control-room-api-v2.md`

**Interfaces:**
- Consumes: API current-session preparation snapshot from Task 2.
- Produces: `SimulationPreparationResource`, `GET /v2/sessions/current/simulation/preparation`, and `resources.simulation_preparation_revision`.

- [ ] **Step 1: Write failing route, status, and OpenAPI tests**

Add router tests for running, ready, failed, and unavailable snapshots. Assert status contains only the revision pointer and OpenAPI contains the route and response schema:

```rust
#[tokio::test]
async fn simulation_preparation_returns_active_projection() {
    let app = test_router_with_preparation(active_preparation_fixture());
    let response = request(&app, "/v2/sessions/current/simulation/preparation").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["active_stage_id"], "meshing");
    assert_eq!(body["stages"][5]["progress_percent"], 63);
}
```

- [ ] **Step 2: Run API contract tests and confirm red**

Run: `cargo test -p fullmag-api simulation_preparation --no-fail-fast`

Expected: route/schema assertions fail because the resource is absent.

- [ ] **Step 3: Implement schema, handler, route, and revision pointer**

Define utoipa schemas matching the Task 1 serialized contract, including explicit enums, `0..100` percentage constraints, bounded strings, error correlation id, execution summaries, and the 200-entry log maximum. Implement:

```rust
#[utoipa::path(
    get,
    path = "/v2/sessions/current/simulation/preparation",
    responses(
        (status = 200, body = SimulationPreparationResource),
        (status = 404, body = ApiError)
    )
)]
pub async fn get_simulation_preparation(
    State(state): State<AppState>,
) -> Result<Json<SimulationPreparationResource>, ApiError> { /* current snapshot projection */ }
```

Register the handler and OpenAPI schema. Add `simulation_preparation_revision: u64` to `ResourceRevisionMap`, sourced from the current preparation revision. Emit the existing `resource.batch_changed` envelope with resource id `simulation/preparation`; do not include resource content.

- [ ] **Step 4: Run API and strict contract gates**

Run: `cargo test -p fullmag-api simulation_preparation --no-fail-fast`

Run: `cargo test -p fullmag-api router_v2 --no-fail-fast`

Expected: preparation tests pass and existing router v2 tests remain green.

- [ ] **Step 5: Commit the API contract**

Run `git diff --check`, inspect all Task 4 paths, stage only them, inspect staging separately, and commit with `git commit -m "Expose simulation preparation resource"`.

### Task 5: Generate transport and add the handwritten resource hook

**Files:**
- Modify (generated): `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Modify (generated): `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Modify (generated): `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
- Modify (generated): `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`
- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- Create: `apps/control-room/src/kernel/resources/useSimulationPreparation.ts`
- Create: `apps/control-room/src/kernel/resources/useSimulationPreparation.test.ts`
- Modify: `apps/control-room/src/kernel/resources/useSessionStatus.ts`

**Interfaces:**
- Consumes: OpenAPI resource and status revision from Task 4.
- Produces: `SIMULATION_PREPARATION_PATH`, `SimulationPreparationResource`, `api.simulation.preparation()`, and `useSimulationPreparation()`.

- [ ] **Step 1: Add failing facade and resource-hook tests**

Assert the facade uses the generated path and the hook retains stale data while a newer revision loads:

```ts
it("loads preparation through the simulation facade", async () => {
  server.respondJson(SIMULATION_PREPARATION_PATH, preparationFixture({ revision: 7 }));
  await expect(api.simulation.preparation()).resolves.toMatchObject({ revision: 7 });
  expect(server.lastPath()).toBe("/v2/sessions/current/simulation/preparation");
});
```

The hook test must invalidate revision 7 to 8, keep revision 7 with `status: "loading"`, then adopt revision 8 after the request resolves.

- [ ] **Step 2: Run focused frontend tests and confirm red**

Run: `env TMPDIR=/tmp pnpm --dir apps/control-room test -- src/kernel/api/ControlRoomApi.test.ts src/kernel/resources/useSimulationPreparation.test.ts`

Expected: compilation fails because the path, facade, type, and hook do not exist.

- [ ] **Step 3: Regenerate and implement the handwritten access layer**

Run: `pnpm --dir apps/control-room generate:api`

Then export the generated schema alias, add the central path constant, and implement:

```ts
export function useSimulationPreparation({ enabled = true } = {}) {
  const { api } = useKernel();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.simulation.preparation({ signal }),
    [api],
  );
  return useResource<SimulationPreparationResource>({
    enabled,
    load,
    minRefetchIntervalMs: statusRefreshIntervalMs(),
    resolveRevision: (data) => data.revision,
    resourceKey: SIMULATION_PREPARATION_PATH,
  });
}
```

Include `simulation_preparation_revision` in the focused session-status revision key list. Do not edit generated files manually.

- [ ] **Step 4: Run generated-contract and focused tests**

Run the test command from Step 2.

Run: `pnpm --dir apps/control-room check:api-hygiene`

Expected: tests and API hygiene pass; generated transport remains the only low-level browser transport.

- [ ] **Step 5: Commit generated and handwritten API changes**

Run `git diff --check`, stage only Task 5 files, inspect staging separately, and commit with `git commit -m "Add preparation resource hook"`.

### Task 6: Build the approved operational startup panel

**Files:**
- Create: `apps/control-room/src/kernel/layout/simulationPreparationModel.ts`
- Create: `apps/control-room/src/kernel/layout/simulationPreparationModel.test.ts`
- Create: `apps/control-room/src/kernel/layout/SimulationPreparationLog.tsx`
- Create: `apps/control-room/src/kernel/layout/SimulationPreparationLog.test.tsx`
- Modify: `apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx`
- Modify: `apps/control-room/src/kernel/layout/SimulationStartupOverlay.test.tsx`
- Modify: `apps/control-room/src/design/styles/dialog-simulation-startup.css`

**Interfaces:**
- Consumes: `useSimulationPreparation`, status connection state, and `SimulationPreparationResource`.
- Produces: pure `resolveSimulationPreparationViewModel()`, approved option A markup, safe diagnostics serialization, and scroll-follow behavior.

- [ ] **Step 1: Write failing pure-model tests**

Cover connecting, running determinate, running indeterminate, skipped, stale/reconnecting, ready, and failed states:

```ts
it("uses numeric progress only for a measurable active stage", () => {
  const model = resolveSimulationPreparationViewModel(
    readyResource(preparationFixture({ activeStage: "meshing", progressPercent: 63 })),
    readyStatus(),
    18_700,
  );
  expect(model.progress).toEqual({ kind: "determinate", value: 63 });
  expect(model.activeStage?.elapsedLabel).toBe("16.2s");
});

it("does not fabricate percent for planning", () => {
  const model = resolveSimulationPreparationViewModel(
    readyResource(preparationFixture({ activeStage: "planning", progressPercent: null })),
    readyStatus(),
    2_100,
  );
  expect(model.progress).toEqual({ kind: "indeterminate" });
});
```

- [ ] **Step 2: Run focused model tests and confirm red**

Run: `env TMPDIR=/tmp pnpm --dir apps/control-room test -- src/kernel/layout/simulationPreparationModel.test.ts`

Expected: module is missing.

- [ ] **Step 3: Implement the pure adapter and option A view**

The adapter must format backend durations, preserve backend stage ordering, expose textual stage state, and never calculate an ETA or percentage from browser elapsed time. Replace the spinner-only visible state with a discriminated union containing connection or preparation data.

Render:

```tsx
<section className="fm-simulation-startup__panel" role="status">
  <header className="fm-simulation-startup__header">...</header>
  <Progress
    aria-label="Simulation preparation progress"
    value={model.progress.kind === "determinate" ? model.progress.value : undefined}
  />
  <div className="fm-simulation-startup__body">
    <ol className="fm-simulation-startup__stages">...</ol>
    <SimulationPreparationLog entries={model.logEntries} />
  </div>
</section>
```

Use existing shared Progress, Button, ScrollArea, and Tooltip primitives. Keep `aria-live="polite"` on stage/terminal summaries only; mark the changing log container `aria-live="off"`. Use `fm-` classes and tokens exclusively. Add a responsive single-column layout below the existing narrow desktop breakpoint and disable continuous animation under `prefers-reduced-motion: reduce`.

- [ ] **Step 4: Implement bounded log scrolling and diagnostics actions test-first**

Write component tests proving: at-bottom updates follow the tail; scrolled-up updates preserve `scrollTop`; a new-entry control returns to the tail; copy diagnostics contains only the bounded safe projection; failure keeps the gate mounted; and `Open full diagnostics` emits the existing kernel diagnostics navigation event.

Implement scroll ownership with refs and an `onScroll`-maintained `isFollowingTail` boolean. Do not place log entries or timers in a store. Use one one-second display tick only while the overlay is visible; derive elapsed labels from backend timestamps and pause the tick under ready/failed terminal states.

- [ ] **Step 5: Run focused overlay tests and confirm green**

Run: `env TMPDIR=/tmp pnpm --dir apps/control-room test -- src/kernel/layout/simulationPreparationModel.test.ts src/kernel/layout/SimulationPreparationLog.test.tsx src/kernel/layout/SimulationStartupOverlay.test.tsx`

Expected: all model, log, gate, accessibility, and failure tests pass.

- [ ] **Step 6: Run targeted lint and typecheck**

Run: `pnpm --dir apps/control-room exec eslint src/kernel/layout/SimulationStartupOverlay.tsx src/kernel/layout/SimulationPreparationLog.tsx src/kernel/layout/simulationPreparationModel.ts --max-warnings=0`

Run: `pnpm --dir apps/control-room typecheck`

Expected: zero warnings and no TypeScript errors.

- [ ] **Step 7: Commit the approved startup UI**

Run `git diff --check`, stage only Task 6 files, inspect staging separately, and commit with `git commit -m "Show simulation preparation progress"`.

### Task 7: Prove realtime invalidation and full startup behavior

**Files:**
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`
- Create: `apps/control-room/scripts/smoke-simulation-preparation.mjs`
- Modify: `apps/control-room/package.json`
- Modify: `docs/superpowers/specs/2026-07-19-simulation-preparation-progress-design.md` only if implementation evidence requires a clarified rollout note

**Interfaces:**
- Consumes: complete Tasks 1-6 chain.
- Produces: automated evidence that WebSocket invalidation refreshes HTTP state and the real rendered overlay matches approved option A.

- [ ] **Step 1: Add failing invalidation test**

Publish a `resource.batch_changed` event containing only:

```ts
{
  resource: "simulation",
  resource_id: "preparation",
  revision: 8,
}
```

Assert that `SIMULATION_PREPARATION_PATH` is invalidated at revision 8 and that no preparation body is read from the event.

- [ ] **Step 2: Run the invalidation test and confirm red**

Run: `env TMPDIR=/tmp pnpm --dir apps/control-room test -- src/kernel/realtime/RealtimeInvalidationBridge.test.ts`

Expected: the preparation mapping assertion fails until the bridge recognizes the canonical resource key.

- [ ] **Step 3: Add the minimal invalidation mapping and smoke fixture**

Map `simulation/preparation` to the central resource path. Add a controlled browser fixture that serves connection, planning, 63% meshing, reconnecting, ready, and failed snapshots in sequence. The smoke script must assert visible canvas-independent overlay geometry, semantic progress values, exact stage/log text, stale marker, and that `[data-slot-id="viewport-main"]` is absent until ready.

Add `"smoke:simulation-preparation": "node scripts/smoke-simulation-preparation.mjs"` to the package scripts.

- [ ] **Step 4: Run the browser smoke and capture visual evidence**

Build with the existing audit build lane, start the app on an unused audit port, then run:

`pnpm --dir apps/control-room smoke:simulation-preparation`

Expected: the script reports connection, determinate, indeterminate, reconnect, failure, and ready assertions as passed; screenshots show option A at representative and narrow widths.

- [ ] **Step 5: Run complete proportional verification**

Run:

```bash
cargo test -p fullmag-cli simulation_preparation --no-fail-fast
cargo test -p fullmag-api simulation_preparation --no-fail-fast
cargo test -p fullmag-api router_v2 --no-fail-fast
pnpm --dir apps/control-room generate:api
env TMPDIR=/tmp pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
./scripts/ci-resource-first-gates.sh --strict
./scripts/ci/contract_guard.sh --strict
```

Expected: every command exits zero. Then run targeted React Doctor according to `.agents/skills/react-doctor/SKILL.md`; do not accept an unpinned npm download without explicit user approval. Record the score or an explicit supply-chain block.

- [ ] **Step 6: Audit the completion contract**

Search for regressions:

```bash
rg '"/v2/' apps/control-room/src --glob '!kernel/api/generated/**'
rg 'fetch\(' apps/control-room/src
rg '/v1/live/current|/v1/health|/v1/capabilities' apps/control-room/src crates/fullmag-api/src
rg 'simulation_preparation_revision|simulation/preparation' crates/fullmag-api crates/fullmag-cli apps/control-room docs/specs
```

For each approved requirement, point to a backend transition test, route/OpenAPI test, hook/model/component test, or browser screenshot. Treat missing proof as unfinished work.

- [ ] **Step 7: Commit final invalidation and verification assets**

Run `git diff --check`, stage only Task 7 files, inspect staging separately, and commit with `git commit -m "Verify simulation preparation lifecycle"`.
