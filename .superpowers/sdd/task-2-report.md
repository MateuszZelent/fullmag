# Task 2 report: canonical ProblemIR automatic sampling policy

## Status

DONE_WITH_CONCERNS. The canonical ProblemIR contract is implemented and committed after RED/GREEN verification. Numeric `sample_period_s` and `every_seconds` wire shapes remain unchanged. The user's uncommitted periodic-antidot example and `.superpowers/sdd/task-1-report.md` were preserved.

## Contract implemented

- Added `AUTO_SINC_NYQUIST_GUARD_FACTOR = 1.3` and tagged `SamplingPeriodPolicyIR::AutoSincCutoff`.
- Made `TableAutosaveIR.sample_period_s` optional and added optional `sample_period_policy` without changing legacy numeric JSON serialization.
- Added `TableAutosaveIR::{explicit_sample_period_s, requests_auto_sinc_cutoff, set_resolved_sample_period_s}`.
- Added tagged `OutputIR::FieldAuto` and `OutputIR::ScalarAuto`, plus `OutputIR::{periodic_name, requests_auto_sinc_cutoff}`.
- Validation accepts unresolved automatic authoring intent and resolved auto intent carrying both policy and resolved period.
- Validation rejects a missing table cadence, non-finite/non-positive explicit periods, empty names, and any automatic guard factor other than exactly `1.3`.
- Time-domain validation retains automatic field/scalar requests; spectral exhaustive filters reject them with other time-domain outputs.

## Changed files

- `crates/fullmag-ir/src/study.rs`
- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-ir/tests/ir_tests.rs`
- `crates/fullmag-plan/src/validate.rs`
- `crates/fullmag-runner/src/table_autosave.rs`
- `crates/fullmag-runner/src/regional_field_drive_artifacts.rs`

## RED evidence

Command:

```text
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-ir-red cargo test -p fullmag-ir sampling_policy -- --nocapture
```

Exact result: exit code `101`. Compilation failed with six expected errors: missing `TableAutosaveIR::explicit_sample_period_s`, missing `TableAutosaveIR::requests_auto_sinc_cutoff`, missing `OutputIR::periodic_name`, missing `OutputIR::requests_auto_sinc_cutoff`, and missing `OutputIR::FieldAuto` / `OutputIR::ScalarAuto` variants.

## GREEN evidence

Focused command:

```text
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-ir-red cargo test -p fullmag-ir sampling_policy -- --nocapture
```

Exact final result after review remediation: exit code `0`; `7 passed, 0 failed` in `ir_tests`.

Full command:

```text
env CARGO_TARGET_DIR=/tmp/fullmag-auto-sampling-ir-red cargo test -p fullmag-ir
```

Exact final result: exit code `0`; `49 passed, 0 failed` unit tests, `125 passed, 0 failed` integration tests, and `0` doc-test failures.

Whitespace command:

```text
git diff --check
```

Exact result: exit code `0`, no whitespace errors.

Formatting command requested by the brief:

```text
rustfmt --edition 2021 --config skip_children=true --check crates/fullmag-ir/src/study.rs crates/fullmag-ir/src/lib.rs crates/fullmag-ir/tests/ir_tests.rs
```

Exact result: exit code `1`. All Task 2 additions were formatted, but rustfmt also reported pre-existing formatting drift in unrelated lines of the same files (for example `FieldTargetIR`, cylinder-axis validation, FDM cell validation, and older tests). Running rustfmt without `skip_children` additionally rewrote sibling modules recursively. That generated churn was removed to obey the surgical-change requirement.

## Self-review

- The requested `FieldAuto` / `ScalarAuto` shape matches existing internally tagged `snake_case` IR conventions; no alternate contract was invented.
- Legacy numeric table payloads deserialize and serialize with `sample_period_s` as a number, and explicit output variants retain numeric `every_seconds`.
- `explicit_sample_period_s()` deliberately returns `None` when an automatic policy is present, including resolved auto state, preserving requested-versus-resolved semantics.
- Unknown policy kinds fail closed at serde deserialization because the tagged enum has only the canonical variant.
- Planner and runner received only the exhaustive-match and numeric-unwrapping changes required to restore downstream compilation; no automatic cutoff resolution was implemented here.
- Staging was restricted to the six Task 2 source/test files; this report remains a worktree handoff artifact.

## Concerns

- The exact rustfmt gate is not clean on current master without unrelated formatting churn. Tests and `git diff --check` are clean; formatting debt is outside Task 2 scope.
- `cargo check -p fullmag-plan` and `cargo check -p fullmag-runner` both pass. Runner emits two pre-existing dead-code warnings unrelated to this task.

## Review remediation

- Added `resolved_sample_period_s` as a separate optional field. The sole requested policy kind remains `auto_sinc_cutoff`.
- Validation now permits exactly three table states: explicit numeric, unresolved automatic intent, or automatic intent plus a resolved numeric period. All other field combinations fail as ambiguous.
- `set_resolved_sample_period_s` writes only the resolved field, preserving the requested policy and legacy explicit wire shape.
- Added direct tests for zero, negative, NaN, and infinite explicit table periods, ambiguous numeric-plus-auto authoring, and legacy numeric `field` serialization.
- Updated planner and runner exhaustive matches for `FieldAuto` and `ScalarAuto`; runtime table configuration accepts explicit or already-resolved numeric cadence and rejects unresolved input.

## Commit

`fb74cbec` — `Add automatic sampling policy to ProblemIR`

`f6a6cdad` — `Harden automatic sampling IR states`
