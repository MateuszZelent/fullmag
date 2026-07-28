# Table Autosave Relaxation Step Cadence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `TableAutosave` sample accepted relaxation states every N steps without presenting pseudo-time as physical time, while publishing the exact configured table schema and row count to Analysis.

**Architecture:** `TableAutosaveIR` receives a tagged cadence value: physical simulation seconds for time evolution or accepted solver steps for relaxation. The runner owns due-state decisions and produces table rows only from accepted states; the API exposes the resolved table schema and row count as the existing revisioned table resource. The Control Room consumes the existing resource hook and keeps the table configuration in the Inspector rather than copying server data into its workspace store.

**Tech Stack:** Python DSL, Rust serde/ProblemIR/planner/runner/API, OpenAPI v2 generation, React 19, TypeScript, Vitest.

## Global Constraints

- `every_steps` and time cadence are mutually exclusive.
- Step cadence counts accepted states only; rejected line-search attempts never create rows.
- A relaxation table records `step=0`, every divisible accepted step, and the final state once.
- Direct minimizers must not expose `t=0` as a physical time coordinate.
- HTTP v2 remains authoritative; realtime only invalidates table resources.
- Do not copy table rows or schema into persistent workspace preferences.

---

### Task 1: Document and model the cadence

**Files:**
- Modify: `docs/physics/0910-table-autosave-observables.md`
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Test: `crates/fullmag-ir/tests/ir_tests.rs`

**Produces:** `TableAutosaveCadenceIR::{SimulationTime, AcceptedSteps}` with validation that exactly one cadence is authored.

- [ ] Add cadence semantics, units, relaxation restrictions, provenance and validation criteria to the physics note.
- [ ] Write a failing IR test for `accepted_steps=10` and for ambiguous time-plus-step input.
- [ ] Add the typed cadence and validation/serde compatibility.
- [ ] Run `cargo test -p fullmag-ir --test ir_tests`.

### Task 2: Extend canonical Python authoring and script round-trip

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Test: `packages/fullmag-py/tests/test_table_autosave.py`

**Produces:** `TableAutosave(every_steps=10, ...)` and a `Relaxation.table_autosave(...)` helper with exact IR/script round-trip.

- [ ] Write failing tests for positive integer `every_steps`, rejection of both cadences, and script export.
- [ ] Implement strict constructor validation and `to_ir()` lowering.
- [ ] Render `every_steps=` in generated canonical scripts.
- [ ] Run `pytest packages/fullmag-py/tests/test_table_autosave.py`.

### Task 3: Sample table rows by accepted step in the runner

**Files:**
- Modify: `crates/fullmag-runner/src/table_autosave.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Test: `crates/fullmag-runner/src/table_autosave.rs`

**Produces:** A runner table store that emits initial, periodic accepted-step and final rows with explicit cadence metadata.

- [ ] Write failing table-store tests for steps `0, 10, 20, final=23` and for unchanged direct-minimizer time.
- [ ] Replace time-only due logic with a cadence enum and expose `append_final_if_needed`.
- [ ] Preserve time-cadence behavior unchanged for time evolution.
- [ ] Run `cargo test -p fullmag-runner table_autosave`.

### Task 4: Publish exact live-table metadata through v2 resources

**Files:**
- Modify: `crates/fullmag-api/src/schemas/tables.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/tables.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`

**Produces:** `TableResource` with exact configured columns, `total_rows`, cadence metadata and coordinate kind; rows reject unavailable requested columns rather than substituting zeros.

- [ ] Write route tests proving exact configured schema and total row count.
- [ ] Make table metadata derive from the active canonical table definition rather than a hard-coded default list.
- [ ] Regenerate OpenAPI v2 types using `corepack pnpm --dir apps/control-room generate:api`.
- [ ] Run `cargo test -p fullmag-api router_v2 --no-fail-fast` and typecheck the generated frontend client.

### Task 5: Repair Analysis Inspector and table legend consumers

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisTableSurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.test.tsx`
- Test: `apps/control-room/src/modules/analysis-plots/analysisWorkbench.test.tsx`

**Produces:** Inspector shows exact configured columns, row count and cadence; the table-chart legend can hide/show the same selected series as the Inspector.

- [ ] Write failing tests for Inspector row count/cadence and a clickable table legend.
- [ ] Use the existing `useTableResource` hook for summary metadata and pass the controller visibility callback to `ChartLegend`.
- [ ] Run targeted Vitest, then `corepack pnpm --dir apps/control-room typecheck`.

### Task 6: End-to-end verification

- [ ] Run focused Python, IR, runner, API and Control Room tests.
- [ ] Run `git diff --check` on changed paths.
- [ ] When a live API session is available, verify a relaxation with `every_steps=10` shows expected table rows and Inspector metadata without a UI loop or chart redraw leak.
