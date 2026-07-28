# Stage-local Table Autosave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make table autosave an explicitly stage-owned relaxation setting, preserve legacy persistent actions, and expose actionable preparation-validation failures in the API, terminal, and Control Room.

**Architecture:** Python returns a stage handle that decorates one captured relax primitive without mutating global sampling state. The pipeline wire representation carries the stage-local override; CLI materialization lowers it to bounded enable/relax/restore lifecycle actions. Preparation failures publish a safe concrete validation summary with a correlation ID through the existing resource and frontend model.

**Tech Stack:** Python 3.10 dataclasses and pytest; Rust nightly with serde and cargo tests; Next.js 16/React/TypeScript/Vitest; managed FEM runtime through repository `just` recipes.

## Global Constraints

- Preserve accepted-step semantics from `docs/physics/0910-table-autosave-observables.md`.
- Relaxation accepts only positive integer `every_steps`; physical-time cadence remains invalid.
- Stage-local configuration must not mutate `_state._table_autosave` or leak to later stages.
- Existing serialized persistent `table_autosave` pipeline actions remain executable.
- Validation remains fail-closed and does not loosen solver tolerances or backend parity.
- Public errors contain safe summaries; detailed technical context is correlated, not copied into API payloads.
- Native FEM proof uses `just ensure-managed-fem-runtime` and the managed `just fullmag` path.
- Preserve unrelated dirty submodules and audit files.

---

### Task 1: Python stage handle and stage-local serialization

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/loader.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Test: `packages/fullmag-py/tests/test_study_builder.py`
- Test: `packages/fullmag-py/tests/test_script_builder.py`

**Interfaces:**
- Produces: `RelaxStageBuilder.tableautosave(*, every_steps: int, quantities: Sequence[str] | None = None, table_id: str = "default") -> RelaxStageBuilder`.
- Produces: optional `table_autosave` mapping on the captured relax primitive.
- Consumes: existing `TableAutosave.to_ir()` validation and `CapturedStage` replacement pattern.

- [ ] **Step 1: Write failing Python tests**

Add tests that build:

```python
handle = study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb")
returned = handle.tableautosave(every_steps=10, quantities=["step", "mx"])
assert returned is handle
assert exported_relax_node["table_autosave"]["every_steps"] == 10
assert loaded.pipeline_base_problem.study.to_ir()["sampling"].get("table_autosave") is None
```

Also assert a following run node has no stage-local table, duplicate attachment raises `ValueError`, invalid integer values raise `ValueError`, and legacy `study.stages.tableautosave(every_steps=10)` emits `DeprecationWarning` while retaining its action.

- [ ] **Step 2: Run RED tests**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src .fullmag/local/python/bin/python -m pytest -q packages/fullmag-py/tests/test_study_builder.py packages/fullmag-py/tests/test_script_builder.py
```

Expected: fluent-handle assertions fail because `add_relax()` currently returns `StudyStagesBuilder` and stage-local serialization is absent.

- [ ] **Step 3: Implement the minimal stage handle**

Add a focused immutable-stage decorator that records the allocated stage ID and replaces exactly that `CapturedStage`. Keep pipeline-building methods on `StudyStagesBuilder`; the stage handle owns only stage-local configuration. Store the serialized `TableAutosave` on the relax node and do not update `_state._table_autosave`.

- [ ] **Step 4: Update loader and canonical exporter**

Preserve the stage-local mapping through `LoadedStage` conversion. Render stage-local ownership as:

```python
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=50_000,
    tol=7.957747154594767,
).tableautosave(
    every_steps=10,
    quantities=["step", "mx"],
)
```

Continue rendering explicit legacy action nodes through `study.stages.tableautosave(every_steps=10)`.

- [ ] **Step 5: Run GREEN Python tests**

Run the command from Step 2 and require all selected tests to pass without new warnings outside the asserted deprecation.

---

### Task 2: Pipeline wire contract and bounded lifecycle materialization

**Files:**
- Modify: `crates/fullmag-authoring/src/builder.rs`
- Modify: `crates/fullmag-cli/src/types.rs`
- Modify: `crates/fullmag-cli/src/step_utils.rs`
- Test: `crates/fullmag-cli/src/step_utils.rs`
- Test: `crates/fullmag-authoring/src/builder.rs`

**Interfaces:**
- Consumes: relax primitive optional `table_autosave` emitted by Task 1.
- Produces: explicit persistent configuration transition immediately before relax and restoration immediately after relax.

- [ ] **Step 1: Write failing serde and materialization tests**

Create a relax pipeline node containing:

```json
{
  "kind": "relax",
  "payload": {
    "algorithm": "projected_gradient_bb",
    "table_autosave": {
      "kind": "table_autosave",
      "table_id": "default",
      "every_steps": 10,
      "quantities": ["step", "mx"]
    }
  }
}
```

Assert serde preserves the mapping, materialization orders enable → relax → restore, the restore disables sampling when no prior table existed, and a later run does not inherit it.

- [ ] **Step 2: Run RED Rust tests through focused workspace crates**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-stage-autosave-target cargo +nightly test -p fullmag-authoring -p fullmag-cli stage_local_table_autosave --no-default-features
```

Expected: tests fail because relax payload materialization ignores stage-local table ownership.

- [ ] **Step 3: Extend typed pipeline documents**

Add the optional field to the typed authoring and CLI pipeline node representations using `#[serde(default, skip_serializing_if = "Option::is_none")]`. Reuse `TableAutosaveIR`; do not create a second cadence model.

- [ ] **Step 4: Implement enable/relax/restore expansion**

In relax materialization, snapshot `current_ir.study.sampling().table_autosave`, materialize the enable action, materialize relax, then materialize a restoration action carrying either the previous table or disabled state. Validate stage-local cadence against relaxation before emitting actions and include `stage_id` in errors.

- [ ] **Step 5: Run GREEN Rust tests**

Run the Step 2 command and focused existing pipeline materialization tests; require all to pass.

---

### Task 3: Actionable validation diagnostics across CLI, API, and UI

**Files:**
- Modify: `crates/fullmag-cli/src/simulation_preparation.rs`
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify: `apps/control-room/src/kernel/layout/simulationPreparationModel.ts`
- Modify: `apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx`
- Test: `apps/control-room/src/kernel/layout/simulationPreparationModel.test.ts`
- Test: `apps/control-room/src/kernel/layout/SimulationStartupOverlay.test.tsx`

**Interfaces:**
- Produces: safe validation summary plus non-null `diagnostics_correlation_id` in the existing preparation failure resource.
- Consumes: existing API schema fields and frontend `correlationId` model; no OpenAPI shape change.

- [ ] **Step 1: Write failing Rust preparation tests**

Assert that a validation error such as:

```text
sampling.table_autosave.every_steps is only valid for relaxation studies
```

becomes the safe failure summary, appears in `log_tail`, and receives a deterministic non-empty correlation ID scoped to preparation and validation. Assert unsafe multiline/debug context stays only in the diagnostic log.

- [ ] **Step 2: Write failing frontend tests**

Build a failed preparation snapshot with a concrete summary and `diag-42`. Assert the view model and rendered overlay show both, while generic failures still render a safe fallback.

- [ ] **Step 3: Run RED diagnostics tests**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-stage-autosave-target cargo +nightly test -p fullmag-cli simulation_preparation --no-default-features
TMPDIR=/tmp pnpm --dir apps/control-room test -- simulationPreparationModel.test.ts SimulationStartupOverlay.test.tsx
```

Expected: Rust fails because validation ownership currently records a static summary with no correlation ID; frontend assertions expose any missing rendering.

- [ ] **Step 4: Implement safe error propagation**

Introduce one sanitizer for single-line validation messages, generate/store the correlation ID at the failure boundary, write full context to the correlated diagnostics sink, and pass the safe summary to `fail_owned_preparation_stage`. Print summary and ID before `wait_for_failed_preparation_close` loops.

- [ ] **Step 5: Render existing fields in Control Room**

Use the resource-first preparation model already carrying `summary` and `correlationId`. Add accessible failure detail and correlation text to the existing overlay without new fetching or polling.

- [ ] **Step 6: Run GREEN diagnostics tests and frontend gates**

Run the Step 3 commands, then:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
```

Require zero failures and zero lint warnings.

---

### Task 4: Migrate SP4 and prove end-to-end behavior

**Files:**
- Modify: `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
- Modify: `docs/physics/0910-table-autosave-observables.md`
- Test: `packages/fullmag-py/tests/test_table_autosave.py`

**Interfaces:**
- Consumes: fluent API, pipeline materialization, and diagnostics implemented in Tasks 1–3.
- Produces: canonical executable example and documented migration syntax.

- [ ] **Step 1: Add the real-scenario regression**

Load the SP4 script through `load_problem_from_script`, lower it for FEM/GPU/double, and assert base sampling is unset while the `relax` primitive owns `every_steps=10`.

- [ ] **Step 2: Run RED scenario test**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src .fullmag/local/python/bin/python -m pytest -q packages/fullmag-py/tests/test_table_autosave.py
```

Expected before migration: the scenario still emits the ordering-sensitive persistent action.

- [ ] **Step 3: Migrate scenario and physics note**

Replace the separate action with the approved fluent chain and document stage-local ownership as canonical. Mark persistent pipeline actions as compatibility behavior, not preferred relaxation authoring.

- [ ] **Step 4: Run cross-layer focused suites**

Run all focused Python and Rust commands from Tasks 1–3 plus the complete touched frontend test files.

- [ ] **Step 5: Run authoritative managed FEM verification**

Run:

```bash
just ensure-managed-fem-runtime
just fullmag build=False fem gpu headless tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py
```

Require bundle validation success and execution to pass validation/planning and reach FEM GPU solver initialization. If the full 50,000-step scenario is intentionally long, capture bounded startup evidence without weakening its numerical configuration.

- [ ] **Step 6: Final repository checks and publication**

Run `git diff --check`, inspect staged paths separately, preserve unrelated dirty files, commit only implementation scope, push `master`, and verify `git ls-remote origin refs/heads/master` equals local `HEAD`.
