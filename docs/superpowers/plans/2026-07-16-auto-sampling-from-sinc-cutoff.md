# Automatic Sinc Sampling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `t_sampling = "auto"` a canonical ordered-workflow policy that resolves table and field autosave cadence from the maximum active sinc cutoff with a fixed 30% Nyquist guard.

**Architecture:** Preserve the requested automatic policy in Python-authored and UI-authored stage payloads and ProblemIR, then resolve it once per executable `Run` after the active stage id and field-drive set are known. A backend-neutral Rust resolver produces explicit positive periods plus provenance before planner/backend dispatch; FDM and FEM continue consuming numerical periods only. Control Room uses one shared TypeScript sampling model for inspector previews and round-trip authoring.

**Tech Stack:** Python 3.10 dataclasses and pytest/unittest, Rust 2021 with serde and cargo tests, OpenAPI v2/Utoipa, TypeScript/React 19/Next.js 16, Vitest and Testing Library.

## Global Constraints

- The numerical rule is `t_sampling = 1 / (2 * 1.3 * max(active sinc cutoff_hz))`.
- `1.3` is a fixed canonical guard factor in this version and is not user-configurable.
- For `5 GHz`, the resolved target Nyquist is `6.5 GHz`, sampling frequency is `13 GHz`, and period is `1 / 13 GHz`.
- Resolution uses enabled drives added before the target `Run` and active for that run's stage id.
- No applicable active sinc drive is a validation error; do not infer from solver `dt`, duration, or non-sinc waveforms.
- Numeric periods retain their existing behavior and wire compatibility.
- Requested `"auto"` and resolved numerical values must both survive provenance; script export emits `"auto"`.
- Unknown future policy kinds fail closed and remain lossless/read-only in Control Room.
- Backend kernels receive explicit numerical periods only; no FDM/FEM or CPU/GPU implementation may duplicate the formula.
- Preserve the user's current edits in `examples/fem_periodic_antidot_relax_exchange_coupled_time_domain_k0.py`.

---

## File Structure

- `docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md`: canonical numerical and workflow semantics.
- `crates/fullmag-ir/src/study.rs`: requested sampling policy and wire-compatible table/output representations.
- `crates/fullmag-ir/src/validation.rs` and `crates/fullmag-ir/src/lib.rs`: structural validation for explicit and automatic policies.
- `crates/fullmag-plan/src/sampling.rs`: the only Rust resolver for active sinc cutoff, guard factor, resolved period, and provenance.
- `crates/fullmag-plan/src/lib.rs`: exports the resolver without moving backend ownership.
- `packages/fullmag-py/src/fullmag/model/study.py`: public `TableAutosave` acceptance and serialization of `"auto"`.
- `packages/fullmag-py/src/fullmag/model/outputs.py`: public field/scalar autosave acceptance and serialization of `"auto"`.
- `packages/fullmag-py/src/fullmag/world.py`: stage builder signatures and error messages.
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`: canonical export/reload of automatic policies.
- `crates/fullmag-cli/src/step_utils.rs`: ordered-stage resolution after assigning `active_stage_id`, before planning.
- `crates/fullmag-cli/src/orchestrator.rs`: resolved-sampling provenance in stage artifacts.
- `crates/fullmag-runner/src/time_events.rs`, `schedules.rs`, and `table_autosave.rs`: fail closed if unresolved policy crosses the planner boundary; retain numerical scheduling.
- `apps/control-room/src/shared/domain/physics/autoSampling.ts`: pure UI resolver/diagnostics model.
- `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`: auto policy parsing, validation, transaction payload, and round-trip.
- `apps/control-room/src/modules/inspector/panels/stages/studyWorkflowState.ts`: ordered active-drive and resolved-clock state.
- Table/Autosave/Run/AddFieldDrive/FFT stage inspectors: mode controls and diagnostics.
- `apps/control-room/src/kernel/api/generated/*`: regenerated OpenAPI artifacts.

---

### Task 1: Publish the canonical numerical contract

**Files:**
- Modify: `docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md`
- Reference: `docs/superpowers/specs/2026-07-16-auto-sampling-from-sinc-cutoff-design.md`

**Interfaces:**
- Consumes: approved formula and ordered-workflow semantics.
- Produces: canonical physics sections referenced by every implementation layer.

- [ ] **Step 1: Add the equations, symbols, units, and failure conditions**

Add a subsection containing this exact contract:

```markdown
### Automatic response sampling from a sinc cutoff

For the active sinc-drive set `D_sinc(run)`,

\[
f_{c,max}=\max_{d\in D_{sinc}(run)} f_{c,d},\qquad
f_{N,target}=1.3 f_{c,max},\qquad
\Delta t_{sample}=\frac{1}{2f_{N,target}}.
\]

All frequencies are in Hz and `Delta t_sample` is in seconds. The fixed factor
1.3 supplies a 30% Nyquist guard. For `f_c,max=5 GHz`, `f_N,target=6.5 GHz`,
`f_sample=13 GHz`, and `Delta t_sample=76.923076923 ps`.
```

Document Python/UI round-trip, ProblemIR policy, per-Run resolution, FDM/FEM parity, provenance, and fail-closed behavior using the approved design.

- [ ] **Step 2: Verify the note is complete**

Run:

```bash
rg -n "Automatic response sampling|6.5 GHz|auto_sinc_cutoff|provenance|FDM|FEM" docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md
```

Expected: every required term is present and the new subsection contains no placeholder markers.

- [ ] **Step 3: Commit the physics note**

```bash
git add docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md
git commit -m "Document automatic sinc sampling"
```

---

### Task 2: Add the canonical ProblemIR sampling policy

**Files:**
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Test: `crates/fullmag-ir/tests/ir_tests.rs`

**Interfaces:**
- Consumes: numeric legacy `sample_period_s` and `every_seconds` payloads.
- Produces: `SamplingPeriodPolicyIR`, automatic table-autosave representation, automatic field/scalar output variants, and validation helpers used by planner/CLI.

- [ ] **Step 1: Write failing legacy and auto round-trip tests**

Add tests that assert the legacy numeric shape is unchanged and the automatic shape is tagged:

```rust
#[test]
fn sampling_policy_round_trips_legacy_explicit_and_auto_sinc() {
    let legacy: TableAutosaveIR = serde_json::from_value(serde_json::json!({
        "kind": "table_autosave",
        "table_id": "default",
        "sample_period_s": 2e-12,
        "quantities": ["t", "mx"]
    })).unwrap();
    assert_eq!(legacy.explicit_sample_period_s(), Some(2e-12));

    let automatic: TableAutosaveIR = serde_json::from_value(serde_json::json!({
        "kind": "table_autosave",
        "table_id": "default",
        "sample_period_policy": {
            "kind": "auto_sinc_cutoff",
            "nyquist_guard_factor": 1.3
        },
        "quantities": ["t", "mx"]
    })).unwrap();
    assert!(automatic.requests_auto_sinc_cutoff());
    assert_eq!(serde_json::to_value(automatic).unwrap()["sample_period_policy"]["kind"], "auto_sinc_cutoff");
}
```

Also test `OutputIR` automatic field and scalar forms:

```rust
let output: OutputIR = serde_json::from_value(serde_json::json!({
    "kind": "field_auto",
    "name": "m",
    "sample_period_policy": {
        "kind": "auto_sinc_cutoff",
        "nyquist_guard_factor": 1.3
    }
})).unwrap();
assert!(matches!(output, OutputIR::FieldAuto { .. }));
```

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-ir-red cargo test -p fullmag-ir sampling_policy -- --nocapture
```

Expected: compilation fails because the policy and helper methods do not exist.

- [ ] **Step 3: Implement the IR types and compatibility helpers**

Add:

```rust
pub const AUTO_SINC_NYQUIST_GUARD_FACTOR: f64 = 1.3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SamplingPeriodPolicyIR {
    AutoSincCutoff {
        #[serde(default = "default_auto_sinc_nyquist_guard_factor")]
        nyquist_guard_factor: f64,
    },
}
```

Make `TableAutosaveIR.sample_period_s` optional and add optional
`sample_period_policy`. Enforce one requested mode, while allowing both fields
only after resolution when the policy is auto and `sample_period_s` is the
resolved value. Add `OutputIR::FieldAuto` and `OutputIR::ScalarAuto` variants
with `name` and `sample_period_policy`.

Add helpers with these signatures:

```rust
impl TableAutosaveIR {
    pub fn explicit_sample_period_s(&self) -> Option<f64>;
    pub fn requests_auto_sinc_cutoff(&self) -> bool;
    pub fn set_resolved_sample_period_s(&mut self, period_s: f64);
}

impl OutputIR {
    pub fn periodic_name(&self) -> Option<&str>;
    pub fn requests_auto_sinc_cutoff(&self) -> bool;
}
```

- [ ] **Step 4: Update validation and all exhaustive matches**

Explicit periods must be finite and positive. Automatic policies must have the
exact kind and guard factor `1.3`; unresolved automatic policies are valid
authoring intent but not executable backend input. Update time-domain output
filtering to retain `FieldAuto` and `ScalarAuto`.

- [ ] **Step 5: Run IR tests and formatting**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-ir-red cargo test -p fullmag-ir
rustfmt --edition 2021 --check crates/fullmag-ir/src/study.rs crates/fullmag-ir/src/lib.rs
```

Expected: all `fullmag-ir` tests pass.

- [ ] **Step 6: Commit the IR contract**

```bash
git add crates/fullmag-ir/src/study.rs crates/fullmag-ir/src/lib.rs crates/fullmag-ir/tests/ir_tests.rs
git commit -m "Add automatic sampling policy to ProblemIR"
```

---

### Task 3: Implement Python DSL acceptance and canonical export

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/model/outputs.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Test: `packages/fullmag-py/tests/test_table_autosave.py`
- Test: `packages/fullmag-py/tests/test_study_stages.py`
- Test: `packages/fullmag-py/tests/test_script_builder_roundtrip.py`

**Interfaces:**
- Consumes: `SamplingPeriodPolicyIR` JSON shapes from Task 2.
- Produces: `tableautosave("auto")`, `autosave(..., every="auto")`, and script export preserving `"auto"`.

- [ ] **Step 1: Write failing public API tests**

```python
def test_table_autosave_accepts_auto_sinc_policy() -> None:
    table = fm.TableAutosave(t_sampl="auto", quantities=["t", "mx"])
    assert table.to_ir() == {
        "kind": "table_autosave",
        "table_id": "default",
        "sample_period_policy": {
            "kind": "auto_sinc_cutoff",
            "nyquist_guard_factor": 1.3,
        },
        "quantities": ["t", "mx"],
    }

def test_stage_autosave_accepts_auto_and_exports_it() -> None:
    study = fm.study("auto-sampling")
    study.stages.tableautosave("auto", quantities=["t", "mx"])
    study.stages.autosave("m", every="auto")
    script = fm.runtime.script_builder.render_script(study)
    assert 'tableautosave("auto"' in script
    assert 'autosave("m", every="auto"' in script
```

Add rejection cases for `"AUTO"`, `"fast"`, booleans, zero, negative, NaN,
and infinity.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
PYTHONPATH=packages/fullmag-py/src python -m pytest packages/fullmag-py/tests/test_table_autosave.py packages/fullmag-py/tests/test_study_stages.py packages/fullmag-py/tests/test_script_builder_roundtrip.py -q
```

Expected: current `float("auto")` or numeric validation fails.

- [ ] **Step 3: Add one Python cadence normalizer**

Implement a private helper shared by study and output models:

```python
SamplingPeriod = float | Literal["auto"]

def normalize_sampling_period(value: object, name: str) -> SamplingPeriod:
    if value == "auto" and isinstance(value, str):
        return "auto"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'{name} must be a positive finite number or "auto"')
    period = float(value)
    if not math.isfinite(period) or period <= 0.0:
        raise ValueError(f'{name} must be a positive finite number or "auto"')
    return period
```

Use it in `TableAutosave`, `SaveField`, `SaveScalar`,
`StudyStagesBuilder.tableautosave`, and `StudyStagesBuilder.autosave`.
Automatic output JSON uses `kind: "field_auto"` or `"scalar_auto"` and the
canonical policy object.

- [ ] **Step 4: Update importer/exporter without replacing requested intent**

Teach `_table_autosave_from_override`, `_render_table_autosave`, and workflow
stage rendering to recognize the policy object and automatic output variants.
Export the literal `"auto"`; never export the optional resolved number.

- [ ] **Step 5: Run Python tests**

```bash
PYTHONPATH=packages/fullmag-py/src python -m pytest packages/fullmag-py/tests/test_table_autosave.py packages/fullmag-py/tests/test_study_stages.py packages/fullmag-py/tests/test_script_builder_roundtrip.py packages/fullmag-py/tests/test_api.py -q
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the Python API**

```bash
git add packages/fullmag-py/src/fullmag packages/fullmag-py/tests
git commit -m "Accept automatic sampling in the Python DSL"
```

---

### Task 4: Resolve automatic cadence once per ordered Run

**Files:**
- Create: `crates/fullmag-plan/src/sampling.rs`
- Modify: `crates/fullmag-plan/src/lib.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`
- Modify: `crates/fullmag-cli/src/step_utils.rs`
- Modify: `crates/fullmag-cli/src/types.rs`
- Test: `crates/fullmag-cli/src/step_utils.rs`

**Interfaces:**
- Consumes: unresolved automatic policies and `problem_meta.runtime_metadata.active_stage_id`.
- Produces: `resolve_auto_sampling_for_stage(&mut ProblemIR) -> Result<Option<SamplingResolutionIR>, PlanError>` and explicit runtime output periods.

- [ ] **Step 1: Write failing resolver tests**

Cover maximum cutoff, activation filtering, disabled drives, no-sinc failure,
and the 5 GHz oracle:

```rust
#[test]
fn auto_sampling_uses_maximum_active_sinc_cutoff_with_guard() {
    let mut problem = auto_sampling_problem(&[3.0e9, 5.0e9], "excite");
    let resolution = resolve_auto_sampling_for_stage(&mut problem)
        .unwrap()
        .expect("auto policy should resolve");
    assert_eq!(resolution.maximum_cutoff_hz, 5.0e9);
    assert_eq!(resolution.target_nyquist_hz, 6.5e9);
    assert!((resolution.sample_period_s - 1.0 / 13.0e9).abs() < 1e-24);
    assert_eq!(resolution.source_drive_ids, ["drive-3", "drive-5"]);
}
```

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-plan-red cargo test -p fullmag-plan auto_sampling -- --nocapture
```

Expected: resolver symbols are missing.

- [ ] **Step 3: Implement the backend-neutral resolver**

Create:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamplingResolutionIR {
    pub requested_policy: SamplingPeriodPolicyIR,
    pub sample_period_s: f64,
    pub maximum_cutoff_hz: f64,
    pub nyquist_guard_factor: f64,
    pub target_nyquist_hz: f64,
    pub sampling_frequency_hz: f64,
    pub source_drive_ids: Vec<String>,
    pub target_stage_id: String,
}
```

Filter drives with the existing `field_drive_is_active` semantics. Require a
`TimeDependenceIR::SincPulse` with finite positive cutoff. Resolve the table
period and replace automatic field/scalar output variants with existing numeric
`Field`/`Scalar` variants. Insert the serialized resolution under
`problem_meta.runtime_metadata["sampling_resolution"]`.

- [ ] **Step 4: Call the resolver at the ordered-stage boundary**

In `walk_study_pipeline_nodes`, assign `active_stage_id` to the materialized
stage, then call the resolver only for solver stages whose study is
`TimeEvolution`. Keep `current_ir` unresolved so later Runs can resolve from
their own active drive state.

Apply the same helper in the flat captured-stage path after its stage id is
known. A standalone non-workflow time evolution containing auto policy must
receive a clear planner error naming the missing active stage/drive context.

- [ ] **Step 5: Run planner and CLI tests**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-plan-red cargo test -p fullmag-plan auto_sampling -- --nocapture
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-cli cargo test -p fullmag-cli sampling -- --nocapture
```

Expected: all automatic resolution and legacy workflow tests pass.

- [ ] **Step 6: Commit ordered resolution**

```bash
git add crates/fullmag-plan/src/sampling.rs crates/fullmag-plan/src/lib.rs crates/fullmag-plan/src/tests.rs crates/fullmag-cli/src/step_utils.rs crates/fullmag-cli/src/types.rs
git commit -m "Resolve automatic sampling per Run stage"
```

---

### Task 5: Enforce the resolved-only runtime boundary and provenance

**Files:**
- Modify: `crates/fullmag-runner/src/time_events.rs`
- Modify: `crates/fullmag-runner/src/schedules.rs`
- Modify: `crates/fullmag-runner/src/table_autosave.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Test: corresponding `#[cfg(test)]` modules.

**Interfaces:**
- Consumes: explicit periods and `sampling_resolution` produced by Task 4.
- Produces: exact output event schedules, table/field cadence, and versioned provenance artifacts.

- [ ] **Step 1: Add failing boundary and event-time tests**

```rust
#[test]
fn unresolved_auto_output_is_rejected_before_event_schedule() {
    let output = OutputIR::FieldAuto {
        name: "m".into(),
        sample_period_policy: SamplingPeriodPolicyIR::auto_sinc_cutoff(),
    };
    let error = require_resolved_periodic_outputs(&[output]).unwrap_err();
    assert!(error.contains("unresolved automatic sampling"));
}

#[test]
fn resolved_5ghz_clock_lands_on_output_ticks_and_stage_boundary() {
    let dt = 1.0 / 13.0e9;
    let events = build_resolved_stage_event_schedule(&[], 0.0, 4.0 * dt, &[OutputIR::Field {
        name: "m".into(), every_seconds: dt,
    }], 1e-24);
    assert_eq!(events.times_s, vec![0.0, dt, 2.0 * dt, 3.0 * dt, 4.0 * dt]);
}
```

The final `4*dt` entry is the integrator's required stage-end event. FFT/table
sample rows remain half-open (`t_n < T`) and must not duplicate that boundary
unless the output writer's existing contract explicitly records a final row.

- [ ] **Step 2: Run focused runner tests and confirm RED**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-runner cargo test -p fullmag-runner auto_sampling -- --nocapture
```

- [ ] **Step 3: Add resolved-only guards and provenance**

All schedule constructors and table writers reject automatic variants. Preserve
existing numerical logic otherwise. Include requested policy, resolved period,
cutoff, guard, Nyquist, sample frequency, source ids, and stage id in the stage
record and table schema/provenance JSON.

- [ ] **Step 4: Run runner and orchestrator tests**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-runner cargo test -p fullmag-runner time_events table_autosave -- --nocapture
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-cli cargo test -p fullmag-cli orchestrator -- --nocapture
```

Expected: unresolved policies fail before backend dispatch; explicit schedules
and prior tests remain green.

- [ ] **Step 5: Commit runtime enforcement**

```bash
git add crates/fullmag-runner/src crates/fullmag-cli/src/orchestrator.rs
git commit -m "Enforce resolved sampling at runtime"
```

---

### Task 6: Add Control Room auto authoring and diagnostics

**Files:**
- Create: `apps/control-room/src/shared/domain/physics/autoSampling.ts`
- Create: `apps/control-room/src/shared/domain/physics/autoSampling.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/studyWorkflowState.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/studyWorkflowState.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/TableAutosaveStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/AutosaveStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/RunStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/AddFieldDriveStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/FftResponseStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/StageInspectors.test.tsx`

**Interfaces:**
- Consumes: tagged policy and ordered stage/drive data.
- Produces: one pure UI resolver, editable automatic mode, diagnostics, and lossless unsupported-policy handling.

- [ ] **Step 1: Write the pure-model tests**

```ts
it("resolves 5 GHz with the canonical 30 percent guard", () => {
  expect(resolveAutoSincSampling({ cutoffHz: [3e9, 5e9] })).toEqual({
    maximumCutoffHz: 5e9,
    nyquistGuardFactor: 1.3,
    targetNyquistHz: 6.5e9,
    samplingFrequencyHz: 13e9,
    samplePeriodS: 1 / 13e9,
  });
});

it("fails closed without an active sinc cutoff", () => {
  expect(resolveAutoSincSampling({ cutoffHz: [] }).status).toBe("unresolved");
});
```

- [ ] **Step 2: Run model tests and confirm RED**

```bash
corepack pnpm --dir apps/control-room test -- src/shared/domain/physics/autoSampling.test.ts
```

- [ ] **Step 3: Implement the shared UI resolver**

Export `AUTO_SINC_NYQUIST_GUARD_FACTOR`, `resolveAutoSincSampling`, and a result
union with `ready`/`unresolved` status. Validate finite positive cutoffs and use
the same formula and field names as `SamplingResolutionIR`.

- [ ] **Step 4: Extend stage drafts and transaction serialization**

Add `samplingMode: "explicit" | "auto_sinc_cutoff"` to table/autosave drafts.
Automatic Table Autosave serializes `sample_period_policy` and omits
`sample_period_s`. Automatic outputs serialize `field_auto`/`scalar_auto`.
Unknown policy kinds retain raw payload and become read-only.

- [ ] **Step 5: Implement inspector controls and ordered diagnostics**

Use shared segmented/select primitives for Explicit/Automatic. Disable the
numeric period editor in auto mode. Resolve only drives applicable to the next
Run. Show source drives, maximum cutoff, 30% guard, target Nyquist, sampling
frequency, period, `N`, `df`, and actual Nyquist. Show a blocking unresolved
message if no active sinc drive applies.

- [ ] **Step 6: Run focused UI tests**

```bash
corepack pnpm --dir apps/control-room test -- src/shared/domain/physics/autoSampling.test.ts src/modules/inspector/panels/StudyStageAuthoringModel.test.ts src/modules/inspector/panels/stages/studyWorkflowState.test.ts src/modules/inspector/panels/stages/StageInspectors.test.tsx
```

Expected: authoring, round-trip, calculations, and inspector rendering pass.

- [ ] **Step 7: Commit Control Room authoring**

```bash
git add apps/control-room/src/shared/domain/physics apps/control-room/src/modules/inspector/panels
git commit -m "Add automatic sampling controls to Control Room"
```

---

### Task 7: Regenerate OpenAPI and close end-to-end verification

**Files:**
- Modify: `crates/fullmag-api/src/schemas/authoring.rs` if explicit schema annotations are required.
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Regenerate: `apps/control-room/src/kernel/api/generated/v2Client.ts`
- Preserve/verify: `examples/fem_periodic_antidot_relax_exchange_coupled_time_domain_k0.py`
- Modify: `apps/control-room/scripts/smoke-study-authoring-ui.mjs`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: generated transport, browser smoke coverage, and proof that the user's exact script loads with `"auto"`.

- [ ] **Step 1: Add an end-to-end loader test for the user's script**

Run the helper in read-only authoring mode and assert successful scene/stage
materialization. The test command is:

```bash
PYTHONPATH=packages/fullmag-py/src python -m fullmag.runtime.helper export-run-config --skip-geometry-assets --script examples/fem_periodic_antidot_relax_exchange_coupled_time_domain_k0.py
```

Expected: exit 0; no `float("auto")` traceback; emitted workflow contains
automatic table and field autosave policies.

- [ ] **Step 2: Regenerate the API artifacts**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-openapi corepack pnpm --dir apps/control-room run generate:openapi-v2
corepack pnpm --dir apps/control-room run generate:api-v2-types
corepack pnpm --dir apps/control-room run generate:api-v2-client
```

Expected: generated JSON/types contain `auto_sinc_cutoff`, `field_auto`, and
`scalar_auto`; handwritten API transport remains unchanged unless generation
requires it.

- [ ] **Step 3: Extend the browser smoke**

In `smoke-study-authoring-ui.mjs`, select Automatic, verify the 5 GHz fixture
shows 6.5 GHz Nyquist and approximately 76.923 ps, export Python, and assert the
script contains both `tableautosave("auto"` and `every="auto"`.

- [ ] **Step 4: Run complete non-native gates**

```bash
PYTHONPATH=packages/fullmag-py/src python -m pytest packages/fullmag-py/tests -q
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-final cargo test -p fullmag-ir -p fullmag-plan -p fullmag-cli -p fullmag-runner -p fullmag-api
corepack pnpm --dir apps/control-room typecheck
corepack pnpm --dir apps/control-room lint
env TMPDIR=/tmp corepack pnpm --dir apps/control-room test
```

Expected: all commands pass. Existing unrelated warnings must be reported but
must not be hidden as feature failures.

- [ ] **Step 5: Run the managed FEM time-domain contract**

```bash
just verify-fem-time-domain-native-contract
```

Expected: managed/container FEM time-domain contract passes; host Cargo tests
remain auxiliary evidence only for native FEM runtime claims.

- [ ] **Step 6: Inspect the final diff and commit generated/integration files**

```bash
git diff --check
git add crates/fullmag-api/src/schemas/authoring.rs apps/control-room/src/kernel/api/generated apps/control-room/scripts/smoke-study-authoring-ui.mjs
git diff --cached --name-only
git commit -m "Expose automatic sampling across API and UI"
```

Do not stage the user's example modifications unless they explicitly request
that separate example change be committed.

---

## Final Review Checklist

- [ ] `t_sampling = "auto"` loads without `float()` conversion errors.
- [ ] `tableautosave("auto")` and `autosave(..., every="auto")` round-trip.
- [ ] 5 GHz resolves to 6.5 GHz target Nyquist and `1 / 13 GHz` period.
- [ ] Multiple drives use the maximum applicable cutoff.
- [ ] Ordered activation and stage ids are respected.
- [ ] No-sinc auto sampling fails before backend dispatch.
- [ ] Requested and resolved values are present in provenance.
- [ ] Runtime backends receive explicit periods only.
- [ ] UI displays period, sample frequency, Nyquist, `N`, and `df`.
- [ ] Generated OpenAPI/types are synchronized.
- [ ] Python, Rust, Control Room, and managed FEM gates pass.
- [ ] The user's uncommitted example edits are preserved.
