# Stage-local autosave storage implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stage-owned autosave policies to Relax and Run, with Zarr/HDF5/TXT output, explicit stage groups, and a non-duplicating continuous view authorable identically from Python and Control Room.

**Architecture:** `StageAutosaveIR` is the single semantic contract embedded in each materialized Relax/Run stage. The runner activates it only for that stage and sends scalar/field samples through the existing bounded artifact pipeline to format-specific stage writers; numerical payloads live under `stages/*`, while `continuous/*` contains indexes only. The authoring API, canonical Python exporter, and Inspector edit the same policy.

**Tech Stack:** Python 3 dataclasses and pytest; Rust nightly, serde, Fullmag IR/planner/runner/API; Zarr v2, h5py/HDF5, tab-separated text; React 19, TypeScript, Vitest, shared Inspector primitives; container-backed `just` FEM GPU runtime.

## Global constraints

- Zarr is the default format; supported formats are exactly `zarr`, `hdf5`, and `txt`.
- TXT supports scalar tables only and rejects every field autosave entry.
- Relax cadence counts accepted steps; Run cadence uses physical simulation time.
- Autosave belongs only to its owning stage and never leaks to a following stage.
- Continuous storage retains explicit stage groups and creates logical indexes without duplicating numerical arrays.
- Persistent legacy autosave actions remain readable but new Relax/Run authoring emits only the stage-local form.
- HTTP v2 remains authoritative; WebSocket events only invalidate resources.
- Solver callbacks enqueue bounded jobs only; encoding and filesystem I/O remain off the GPU control path.
- Strict execution fails closed on unsupported formats or incompatible continuous targets.
- Native FEM verification uses repository container-backed `just` recipes.

---

## File structure

- `packages/fullmag-py/src/fullmag/model/study.py`: public `StageAutosave` and `FieldAutosave` policy classes.
- `packages/fullmag-py/src/fullmag/world.py`: fluent Relax/Run builder ownership and captured-stage propagation.
- `packages/fullmag-py/src/fullmag/runtime/{loader.py,script_builder.py}`: lowering and canonical script round-trip.
- `crates/fullmag-ir/src/study.rs`: typed autosave storage IR and validation.
- `crates/fullmag-plan/src/sampling.rs`: cross-stage target compatibility and resolved policy.
- `crates/fullmag-cli/src/step_utils.rs`: materialize the stage-local policy into each executable stage.
- `crates/fullmag-runner/src/autosave_storage.rs`: storage-neutral target/stage/index model.
- `crates/fullmag-runner/src/autosave_{zarr,hdf5,txt}.rs`: format writers with no solver ownership.
- `crates/fullmag-runner/src/{artifact_pipeline.rs,table_autosave.rs,interactive_runtime.rs}`: enqueue, sampling, lifecycle, and diagnostics integration.
- `crates/fullmag-api/src/schemas/authoring.rs`: typed authoring/OpenAPI schemas.
- `apps/control-room/src/modules/inspector/panels/StageAutosaveDraft.ts`: focused UI draft conversion and validation.
- `apps/control-room/src/modules/inspector/panels/stages/StageAutosaveSection.tsx`: shared Relax/Run autosave editor.
- `apps/control-room/src/modules/inspector/panels/{StudyStageAuthoringModel.ts,StudyStageDraftEditor.tsx}`: transaction integration.
- `apps/control-room/src/modules/inspector/panels/stages/{RelaxStageInspector.tsx,RunStageInspector.tsx}`: render the shared section.
- `docs/physics/0910-table-autosave-observables.md`: canonical storage and clock semantics.

### Task 1: Publish the canonical storage contract

**Files:**
- Modify: `docs/physics/0910-table-autosave-observables.md`
- Test: `docs/superpowers/specs/2026-07-28-stage-local-autosave-storage-design.md`

**Interfaces:**
- Consumes: approved storage design.
- Produces: normative names `StageAutosave`, `FieldAutosave`, `target`, `layout`, `format`, `stages`, and `continuous`.

- [ ] Add equations/clock definitions for physical-time and accepted-step sampling, the Zarr/HDF5/TXT capability table, stage layout, continuous indexes, compatibility rules, and failure semantics.
- [ ] Verify terminology matches the design:

```bash
rg -n "StageAutosave|FieldAutosave|continuous|hdf5|txt|accepted" docs/physics/0910-table-autosave-observables.md
git diff --check -- docs/physics/0910-table-autosave-observables.md
```

Expected: every normative term is present and `git diff --check` is silent.

- [ ] Commit only the physics note with `docs: define stage autosave storage semantics`.

### Task 2: Add Python policy classes with validation

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/model/__init__.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Test: `packages/fullmag-py/tests/test_table_autosave.py`

**Interfaces:**
- Produces: `FieldAutosave(quantity: str, *, every: SamplingPeriod | None = None, every_steps: int | None = None)` and `StageAutosave(target: str = "main", layout: str = "continuous", format: str = "zarr", table: TableAutosave | None = None, fields: Sequence[FieldAutosave] = ())`.

- [ ] Write failing tests asserting defaults, serde dictionaries, exactly-one cadence, safe target, supported enums, duplicate field rejection, empty policy rejection, and TXT/field rejection.
- [ ] Run:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_table_autosave.py
```

Expected: new tests fail because the classes are absent.

- [ ] Implement immutable dataclasses whose `to_ir()` emits:

```python
{
    "kind": "stage_autosave",
    "target": "main",
    "layout": "continuous",
    "format": "zarr",
    "table": table.to_ir() if table else None,
    "fields": [field.to_ir() for field in fields],
}
```

- [ ] Export both classes from `fullmag.model` and `fullmag`, rerun the focused tests, and commit `feat: add stage autosave policies`.

### Task 3: Bind policies to Relax and Run builders

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/loader.py`
- Test: `packages/fullmag-py/tests/test_study_stages.py`

**Interfaces:**
- Consumes: `StageAutosave` from Task 2.
- Produces: `RelaxStageBuilder.autosave(policy)` and `RunStageBuilder.autosave(policy)`; `CapturedStage.autosave` and `LoadedStage.autosave`.

- [ ] Write failing tests for stage ownership, duplicate attachment, Relax rejecting time cadence, Run rejecting accepted-step cadence, two stages sharing a continuous target, and no policy on the following unconfigured stage.
- [ ] Run the focused file and confirm RED.
- [ ] Generalize the stage builder without mutating `_state._outputs` or `_state._table_autosave`; replace only the matching immutable captured stage.
- [ ] Propagate the policy through loader objects, rerun tests, and commit `feat: bind autosave to run and relax stages`.

### Task 4: Preserve canonical script round-trip

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Test: `packages/fullmag-py/tests/test_script_builder_roundtrip.py`

**Interfaces:**
- Consumes: `LoadedStage.autosave`.
- Produces: pipeline payload field `autosave` and canonical `.autosave(fm.StageAutosave(...))` output.

- [ ] Add failing round-trip tests for continuous Zarr Relax, separate TXT Run, HDF5 field output, and a mixed Relax/Run sequence sharing `target="main"`.
- [ ] Render deterministic keyword order and omit only values equal to public defaults.
- [ ] Re-load the generated script and assert exact pipeline-document equality.
- [ ] Run both Python stage and round-trip suites; commit `feat: round trip stage autosave scripts`.

### Task 5: Add typed ProblemIR and validation

**Files:**
- Modify: `crates/fullmag-ir/src/study.rs`
- Test: `crates/fullmag-ir/tests/ir_tests.rs`

**Interfaces:**
- Produces: `StageAutosaveIR`, `AutosaveLayoutIR`, `AutosaveFormatIR`, and `FieldAutosaveIR`, embedded as `SamplingIR.stage_autosave: Option<StageAutosaveIR>`.

- [ ] Write failing serde and validation tests for all three formats, both clock kinds, TXT fields, duplicate quantities, unsafe targets, and study-kind cadence mismatches.
- [ ] Implement enums with snake-case serde and `deny_unknown_fields` on policy structs.
- [ ] Add `StageAutosaveIR::validate_for_study(&StudyIR)` and invoke it from canonical ProblemIR validation.
- [ ] Run:

```bash
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=.fullmag/target cargo +nightly test -p fullmag-ir --test ir_tests stage_autosave --no-default-features
```

Expected: all stage-autosave tests pass. Commit `feat: add stage autosave ir`.

### Task 6: Validate continuous targets in planning

**Files:**
- Modify: `crates/fullmag-plan/src/sampling.rs`
- Modify: `crates/fullmag-plan/src/lib.rs`
- Test: `crates/fullmag-plan/src/tests.rs`

**Interfaces:**
- Consumes: stage policies from Task 5.
- Produces: `ResolvedStageAutosave` and `validate_continuous_autosave_targets(stages)`.

- [ ] Add failing tests for compatible Relax/Run membership and exact errors identifying conflicts in format, table schema, field set, mesh identity, component count, and clock metadata.
- [ ] Build a target registry keyed by target name; separate layouts do not join the registry.
- [ ] Preserve requested format/layout/target in the resolved plan and provenance.
- [ ] Run focused planner tests and commit `feat: plan continuous autosave targets`.

### Task 7: Materialize stage policies without leakage

**Files:**
- Modify: `crates/fullmag-cli/src/step_utils.rs`
- Test: `crates/fullmag-cli/src/step_utils.rs`

**Interfaces:**
- Consumes: pipeline payload `autosave` and `StageAutosaveIR`.
- Produces: each materialized Relax/Run `SamplingIR.stage_autosave`; unchanged base sampling after the stage.

- [ ] Add RED tests for Relax, Run, two continuous stages, a following unconfigured stage, and malformed payload failure.
- [ ] Deserialize and validate the payload before assigning it only to the materialized stage.
- [ ] Run:

```bash
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=.fullmag/target cargo +nightly test -p fullmag-cli step_utils::tests --no-default-features
```

- [ ] Commit `feat: materialize stage autosave policies`.

### Task 8: Build storage-neutral stage and continuous indexes

**Files:**
- Create: `crates/fullmag-runner/src/autosave_storage.rs`
- Modify: `crates/fullmag-runner/src/lib.rs`
- Test: `crates/fullmag-runner/src/autosave_storage.rs`

**Interfaces:**
- Produces: `AutosaveTargetWriter`, `StageSampleCoordinate`, `StageManifest`, `ContinuousIndexEntry`, `begin_stage`, `append_table_row`, `append_field_sample`, and `finish_stage`.

- [ ] Write unit tests proving monotonically increasing target/sample indexes, independent stage indexes, physical/accepted-step clock preservation, incomplete-stage recovery, and no payload bytes in continuous index entries.
- [ ] Implement a storage-neutral state machine that rejects schema drift before opening a new stage.
- [ ] Run focused runner tests and commit `feat: index stage autosave outputs`.

### Task 9: Implement TXT writer

**Files:**
- Create: `crates/fullmag-runner/src/autosave_txt.rs`
- Modify: `crates/fullmag-runner/src/autosave_storage.rs`
- Test: `crates/fullmag-runner/src/autosave_txt.rs`

**Interfaces:**
- Consumes: table rows and stage coordinates from Task 8.
- Produces: continuous `<target>.txt` or separate stage TXT files with stable headers.

- [ ] Write failing temp-directory tests for header units, stage columns, append order, separate filenames, flush, and rejected field samples.
- [ ] Implement buffered tab-separated output with atomic header creation and explicit flush at stage completion.
- [ ] Run focused tests and commit `feat: write stage autosave text tables`.

### Task 10: Implement Zarr stage storage and logical view

**Files:**
- Create: `crates/fullmag-runner/src/autosave_zarr.rs`
- Modify: `crates/fullmag-runner/src/autosave_storage.rs`
- Test: `crates/fullmag-runner/src/autosave_zarr.rs`

**Interfaces:**
- Consumes: scalar/field payloads and manifests from Task 8.
- Produces: schema-versioned `stages/*` arrays and metadata-only `continuous/*` indexes.

- [ ] Add golden-layout tests asserting `.zgroup`, `.zattrs`, stage table/field arrays, sample coordinates, and absence of numerical chunks below `continuous`.
- [ ] Reuse `initialize_zarr_group` and the existing Zarr v2 metadata/chunk conventions from `crates/fullmag-cli/src/orchestrator.rs`; write time-first arrays and compressed chunks once under the stage group.
- [ ] Add a reader test reconstructing ordered logical samples from indexes and direct stage chunks.
- [ ] Run focused tests and commit `feat: write indexed stage zarr outputs`.

### Task 11: Implement HDF5 storage with capability gating

**Files:**
- Create: `crates/fullmag-runner/src/autosave_hdf5.rs`
- Modify: `crates/fullmag-runner/Cargo.toml`
- Modify: `crates/fullmag-plan/src/sampling.rs`
- Test: `crates/fullmag-runner/src/autosave_hdf5.rs`

**Interfaces:**
- Produces: HDF5 `/stages` datasets and metadata-only `/continuous` indexes; planner capability `stage_autosave_hdf5`.

- [ ] Inspect the managed image with `pkg-config --modversion hdf5` and `python3 -c 'import h5py; print(h5py.version.info)'`. If system development metadata is absent, add the matching `libhdf5-dev` package to `docker/fem-gpu/Dockerfile`; do not link against h5py's private wheel libraries.
- [ ] Add RED tests for hierarchy parity, field/table readback, no duplicated continuous payload, and unavailable-capability strict failure.
- [ ] Implement the writer behind an explicit Cargo feature and runtime capability.
- [ ] Verify inside the container-backed managed recipe and commit `feat: write stage autosave hdf5 outputs`.

### Task 12: Integrate writers with the bounded artifact pipeline

**Files:**
- Modify: `crates/fullmag-runner/src/artifact_pipeline.rs`
- Modify: `crates/fullmag-runner/src/table_autosave.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime.rs`
- Test: `crates/fullmag-runner/src/artifact_pipeline.rs`

**Interfaces:**
- Consumes: resolved policy and writers from Tasks 8-11.
- Produces: stage-aware scalar/field jobs and completion diagnostics.

- [ ] Add RED tests that callbacks enqueue only, queue capacity stays bounded, stage completion drains before commit, and a writer failure is propagated without silent sample loss.
- [ ] Extend artifact jobs with target/stage/sample metadata; keep host copies and encoding outside the callback deadline.
- [ ] Route table cadence through `TableStore` and field cadence through one stage-local scheduler; append initial/final accepted Relax states exactly once.
- [ ] Assert no policy survives `finish_stage` and commit `feat: stream stage autosave artifacts`.

### Task 13: Add typed authoring/OpenAPI transport

**Files:**
- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
- Test: `apps/control-room/src/kernel/api/`

**Interfaces:**
- Produces: typed `StageAutosaveResource`, `FieldAutosaveResource`, format/layout enums, and generated frontend types.

- [ ] Add backend schema round-trip tests and an invalid TXT/field request test.
- [ ] Register schemas in OpenAPI v2 and regenerate with:

```bash
corepack pnpm --dir apps/control-room generate:api
```

Expected: all three generated v2 files change consistently and generation exits zero.
- [ ] Confirm generated transport remains low-level and no component gains a direct endpoint.
- [ ] Run API contract tests and commit `feat: expose stage autosave authoring schema`.

### Task 14: Add the shared Relax/Run Inspector editor

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/StageAutosaveDraft.ts`
- Create: `apps/control-room/src/modules/inspector/panels/stages/StageAutosaveSection.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/stages/StageAutosaveSection.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/RelaxStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/RunStageInspector.tsx`
- Modify: `apps/control-room/src/design/styles/inspector-study.css`

**Interfaces:**
- Consumes: generated authoring types from Task 13.
- Produces: shared `StageAutosaveDraft`, conversion/validation helpers, and stage-local Inspector UI.

- [ ] Write component/model tests for Zarr defaults, master toggle, target, Continuous/Separate, format selector, table quantities, multiple field rows, Relax step cadence, Run time cadence, TXT blocking error, and exact transaction JSON.
- [ ] Implement a focused draft module; do not expand `StudyStageAuthoringModel.ts` with storage logic beyond delegation.
- [ ] Render the same section in Relax and Run; use shared `FormField`, `Button`, and tokenized `fm-` classes.
- [ ] Keep legacy standalone autosave stages readable and visibly marked legacy; new stage creation does not emit them.
- [ ] Run focused Vitest, typecheck, and targeted ESLint. Commit `feat: edit stage autosave in control room`.

### Task 15: Expose artifacts and continuous views through resource-first API

**Files:**
- Modify: `crates/fullmag-api/src/artifacts.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/artifacts.rs`
- Modify: `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
- Test: corresponding Rust and TypeScript resource tests.

**Interfaces:**
- Produces: artifact metadata for target, format, layout, stage membership, completeness, schema version, and resource/download identity.

- [ ] Add failing resource tests for in-progress, completed, and failed-stage artifacts.
- [ ] Keep payloads out of status JSON; expose metadata through artifacts and heavy data through the existing data plane.
- [ ] Ensure realtime only invalidates artifact revisions.
- [ ] Run resource-first strict gates and commit `feat: publish stage autosave artifacts`.

### Task 16: Migrate examples and compatibility documentation

**Files:**
- Modify: `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
- Modify: `docs/physics/0980-mumag-standard-problem-4-fem-application-validation.md`

**Interfaces:**
- Consumes: final Python API.
- Produces: one real Relax example using stage-local continuous Zarr autosave.

- [ ] Replace the temporary `.tableautosave(...)` chain with one `StageAutosave` containing its table policy; retain numerical scenario settings.
- [ ] Add a short migration table from persistent actions to stage-local policies.
- [ ] Run Python materialization and round-trip tests; commit `docs: migrate sp4 stage autosave`.

### Task 17: Cross-layer verification and performance qualification

**Files:**
- No production edits unless a failing gate reveals a defect.

**Interfaces:**
- Produces: evidence that semantics, formats, UI, and GPU callback budget are production-executable.

- [ ] Run Python suites:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_table_autosave.py packages/fullmag-py/tests/test_study_stages.py packages/fullmag-py/tests/test_script_builder_roundtrip.py
```

- [ ] Run Rust suites:

```bash
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=.fullmag/target cargo +nightly test -p fullmag-ir --test ir_tests --no-default-features
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=.fullmag/target cargo +nightly test -p fullmag-plan --no-default-features
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=.fullmag/target cargo +nightly test -p fullmag-cli step_utils::tests --no-default-features
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=.fullmag/target cargo +nightly test -p fullmag-runner autosave_ --no-default-features
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=.fullmag/target cargo +nightly test -p fullmag-api router_v2 --no-default-features
```

- [ ] Run Control Room gates:

```bash
env TMPDIR=/tmp corepack pnpm --dir apps/control-room test
corepack pnpm --dir apps/control-room typecheck
corepack pnpm --dir apps/control-room exec eslint src/modules/inspector/panels/StageAutosaveDraft.ts src/modules/inspector/panels/stages/StageAutosaveSection.tsx src/modules/inspector/panels/stages/StageAutosaveSection.test.tsx src/modules/inspector/panels/StudyStageAuthoringModel.ts src/modules/inspector/panels/StudyStageDraftEditor.tsx src/modules/inspector/panels/stages/RelaxStageInspector.tsx src/modules/inspector/panels/stages/RunStageInspector.tsx --max-warnings=0
npx -y react-doctor@latest . --verbose --diff
```

Record React Doctor as an environment failure, not a passing score, if the installed Node runtime cannot load the doctor.
- [ ] Run `git diff --check` and inspect the scoped diff.
- [ ] Use `just ensure-managed-fem-runtime` twice: first builds if stale, second proves the bundle is fresh.
- [ ] Run a bounded managed FEM GPU Relax/Run scenario and verify runtime identity, actual GPU lane, stage-local files, continuous indexes, no duplicate field chunks, and no autosave leakage.
- [ ] Compare solver callback/fence/artifact enqueue telemetry against the pre-change baseline; reject the implementation if autosave materially regresses the hot path.
- [ ] Record exact commands/results in the plan's execution log and commit any evidence docs separately.

### Task 18: Review and publish

**Files:**
- All scoped files from Tasks 1-17.

**Interfaces:**
- Produces: reviewed commits on `master` and verified remote publication.

- [ ] Use `requesting-code-review` and resolve every correctness issue.
- [ ] Confirm unrelated submodule changes and untracked audit files remain unstaged.
- [ ] Run `git diff --cached --name-only` as a separate command immediately before each final commit.
- [ ] Push `master`, then verify remote equality with `git ls-remote origin refs/heads/master` and local `git rev-parse HEAD`.
- [ ] Summarize implemented, production-executable, validated, and any capability-gated behavior separately.
