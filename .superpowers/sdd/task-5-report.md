# Task 5 report: LLG solver policy authoring, API, and Control Room

Status: `DONE_WITH_CONCERNS`

No commit was created.

## Implemented

- Extended the authoring scene/builder solver state with canonical fixed and adaptive timestep fields, including advanced `atol`/`rtol` policy fields and demag interval.
- Projected exactly one solver policy into canonical Python rewrite overrides: fixed `fix_dt`, convenience adaptive `dt_initial`/`dt_min`/`dt_max`/`max_err`, or advanced `adaptive_timestep`.
- Preserved omitted `dt_initial` and `dt_max` as null/omitted requested intent rather than inventing values or converting adaptive policy to fixed policy.
- Added a tagged `solver_policy` request schema to structured run/relax commands, retained legacy fields solely for deterministic mixed-vocabulary rejection, validated bounds/tolerance/controller fields, stored the typed policy on the command, and exposed it in command-detail readback.
- Replaced the global raw solver JSON editor with typed fixed/adaptive controls and validation. Extended LLG relaxation stage controls with optional maximum timestep and explicit maximum-error versus advanced tolerance modes.
- Capability-gated adaptive controls from the active session's advertised LLG algorithm availability. No direct endpoint strings or component-level `fetch()` calls were introduced.
- Added focused Rust and frontend model/panel coverage for fixed, convenience adaptive, advanced adaptive, omitted initial timestep, separate tolerances, serialization, and legacy/canonical mixing.

## Files changed

- `crates/fullmag-authoring/src/{builder.rs,scene.rs,adapters.rs}`
- `crates/fullmag-api/src/schemas/{commands.rs,runtime.rs}`
- `crates/fullmag-api/src/router_v2/handlers/simulation/{commands.rs,runtime.rs}`
- `crates/fullmag-api/src/{types.rs,session.rs,router_v2/tests.rs}`
- `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.{ts,test.ts}`
- `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.{ts,test.ts}`
- `apps/control-room/src/modules/inspector/panels/StudyPipelineSection.tsx`
- `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.{tsx,test.tsx}`
- generated `apps/control-room/src/kernel/api/generated/openapi-v2.{json,types.ts}`

## TDD evidence

### RED

- `cargo test -p fullmag-authoring scene_projection_preserves_canonical_fixed_and_adaptive_solver_policies`
  - Failed to compile with missing solver-state fields (`dt_initial`, `dt_min`, `dt_max`, `max_err`, `adaptive_timestep`).
- `cargo test -p fullmag-api run_command_preserves_typed_fixed_solver_policy --no-run`
  - Failed because `SessionCommand` did not retain a typed solver policy.
- Focused Control Room model/panel tests
  - Six contract failures demonstrated the raw global JSON editor and absent stage `dt_max`/tolerance controls.
- `cargo test -p fullmag-api relax_command_preserves_omitted_adaptive_bounds_and_rejects_legacy_mixing --quiet`
  - Failed with `missing field dt_max`, exposing that the first API schema incorrectly required a canonically optional upper bound.

### GREEN collected before final optional-`dt_max` correction

- `cargo test -p fullmag-authoring`: 42 passed.
- Focused authoring solver-policy round-trip: passed.
- Focused API fixed/adaptive preservation and mixed-vocabulary rejection: passed.
- Focused Control Room global/stage/panel tests: 84 passed.
- `corepack pnpm --dir apps/control-room typecheck`: passed.
- `corepack pnpm --dir apps/control-room lint`: passed.
- `corepack pnpm --dir apps/control-room check:api-hygiene`: passed.
- Repository OpenAPI JSON/type/client generators: passed before the final optional-`dt_max` schema correction.
- `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q`: 24 tests and 24 subtests passed.
- `git diff --check`: passed at the independent pre-handoff audit.

## Broad-gate results

- Fresh `cargo test -p fullmag-api --quiet`: 619 passed, 4 failed. The failures were outside this task's diff, but no clean-baseline run was collected, so they are not labelled pre-existing:
  - `domain_slice_mesh_overlay_returns_json_for_fem`
  - `status_uses_fdm_artifact_layout_revision_before_first_live_step`
  - `python_waveguide_box_region_ms_override_changes_backend_mat_ms_mean`
  - `load_scene_document_state_accepts_change_device_stage`
- Full Control Room test: 3474 passed, 1 skipped, 1 failed because the sandbox rejected `spawnSync /usr/local/bin/node` with `EPERM` in `computePerformanceAuditScript.test.ts`.
- Study authoring browser smoke did not run because Playwright is unavailable in the worktree; no unpinned dependency was installed.
- Repo-wide `cargo fmt --all -- --check` reported broad formatting drift outside Task 5. Task-local accidental formatting in `router_v2/tests.rs` was reverted to a six-line functional diff.

## Concerns requiring reviewer action

1. The final correction made `dt_max` optional in the API and both global/stage UI validation, matching the canonical Python model and the task brief. Its RED test was captured, but the parent explicitly stopped further tests before a post-fix GREEN result could be collected.
2. Regenerating OpenAPI after that correction first failed with `No space left on device`, truncating `openapi-v2.json`. The temporary worktree incremental cache was removed, but the retry was interrupted. The generated JSON/types must be inspected and regenerated before integration; they may currently be empty, partial, or stale relative to the final optional-`dt_max` schema.
3. Because the final regeneration/test attempt was interrupted, the current worktree needs an independent `git status`, generated-artifact check, focused Task 5 tests, typecheck/lint/API-hygiene, and diff review before any commit.
4. Adaptive UI gating uses session-level `algorithms_available` and `llg_overdamped` because the API does not publish per-integrator adaptive capabilities. Planner validation remains authoritative for RK23/RK45 lane legality.

## Recommended immediate review commands

Do not trust the generated transport until regeneration succeeds. The reviewing agent should first regenerate through the repository commands, then run the focused authoring/API/frontend tests and the standard frontend hygiene gates. No Task 5 commit exists.

## Controller verification after implementer handoff

- Regenerated OpenAPI JSON, TypeScript types, and generated client through the three repository scripts; JSON parsing succeeded.
- `cargo test -p fullmag-authoring --quiet`: 42 passed.
- Focused API solver-policy tests: 2 passed.
- Focused Control Room model/panel tests: 84 passed.
- Control Room `typecheck`, `lint`, and `check:api-hygiene`: passed.
- `git diff --check`: passed.
- The remaining semantic question for review is whether an execution command may preserve omitted `dt_max` or must reject it before enqueue, while scene/UI draft round-trip remains lossless.

## Fix round after review findings

Status: `DONE_WITH_CONCERNS`

Base commit: `817f18e704e62aeaeeb560ebd673cf804386a363`

No commit was created.

### Binding contract resolved

- Scene and UI draft state preserves omitted `dt_max` losslessly.
- Executable run/relax command and executable stage policy requires finite positive `dt_min` and `dt_max`, ordered bounds, and exactly one typed tolerance mode.
- Omitted `dt_initial` remains valid and is preserved as `None`; the established IR/runtime rule resolves the first attempted step to `dt_min`.
- Adaptive FDM command/UI authoring fails closed unless CPU is explicit. FEM remains subject to the existing planner's native-controller restrictions.

### Fixes for all Critical and Important findings

1. Added matching typed solver-policy transport to `fullmag-cli`, mapped canonical fixed/max-error/advanced policies into `AdaptiveTimeStepIR`, and included canonical policy in direct-minimizer rejection. CLI does not redefine physics signs or units; API validates transport and existing IR/planner validation remains authoritative downstream.
2. Replaced the loose API adaptive object with three tagged variants: `fixed`, `adaptive_max_error`, and `adaptive_advanced`. Executable adaptive variants require `dt_max` at deserialization.
3. Omitted stage `dt_initial` now loads as an empty optional value instead of the invalid string `auto`.
4. Extended Rust stage builder/projection with typed adaptive policy, including edited bounds, tolerance mode, controller values, and optional guards.
5. Advanced global UI policy now supplies and exposes canonical controller defaults (`safety=0.9`, `growth_limit=2`, `shrink_limit=0.2`) and validates their ranges.
6. Authoring validation now rejects fixed/convenience/advanced conflicts and malformed present numerics instead of precedence-normalizing them or converting them to null.
7. Global and stage validation now enforces finite values, ordered bounds, optional initial-step range, RK23/RK45 compatibility, exact tolerance rules, and complete executable upper bounds.
8. UI capability gating combines active-session LLG availability with requested backend/device. API consults the active authoring scene when an adaptive command is submitted and rejects FDM auto/GPU lanes before enqueue.
9. OpenAPI now exposes typed fixed and embedded-RK integrator enums and disjoint policy shapes, preventing mixed or incomplete tolerance objects at the type boundary.
10. Added command-to-CLI resolution proof and scene/stage-to-canonical-Python export proof. Python stage authoring now accepts an advanced `AdaptiveTimestep` and reloaded generated scripts preserve advanced tolerances.

### TDD RED evidence

- `cargo test -p fullmag-cli interactive_command_resolves_canonical_adaptive_solver_policy --quiet`
  - RED: failed at `canonical adaptive policy must reach execution`; canonical queue payload was ignored.
- `cargo test -p fullmag-api relax_command_requires_complete_typed_adaptive_policy_and_rejects_legacy_mixing --quiet`
  - RED: `unknown variant adaptive_max_error, expected fixed or adaptive`; API type boundary was loose.
- `cargo test -p fullmag-authoring scene_projection_ --quiet`
  - RED: 2 failed / 1 passed; fixed+adaptive conflict was accepted and stage adaptive projection returned null.
- Focused Control Room global/stage model tests
  - RED: advanced controller defaults were blank and omitted adaptive `dt_initial` loaded as `auto`.
- `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q -k stage_overrides_export`
  - RED: canonical rewritten stage omitted `max_error`, `dt_min`, `dt_max`, and advanced adaptive policy.

### GREEN verification evidence

- `cargo test -p fullmag-authoring --quiet`
  - 44 passed, 0 failed.
- Fresh final focused authoring run: `cargo test -p fullmag-authoring scene_projection_ --quiet`
  - 3 passed, 0 failed.
- `cargo test -p fullmag-cli --quiet`
  - 157 passed, 0 failed.
- Fresh final CLI canonical resolution: `cargo test -p fullmag-cli canonical_solver_policy --quiet`
  - 1 passed, 0 failed.
- API fixed policy: `cargo test -p fullmag-api solver_policy --quiet`
  - 1 passed, 0 failed.
- API typed adaptive policy: `cargo test -p fullmag-api typed_adaptive_policy --quiet`
  - 1 passed, 0 failed.
- API HTTP direct-minimizer rejection: `cargo test -p fullmag-api relax_command_rejects_llg_only_controls_for_direct_minimizer --quiet`
  - 1 passed, 0 failed.
- Focused Control Room models/panel: `vitest run StudyGlobalAuthoringModel.test.ts StudyStageAuthoringModel.test.ts StudyInspectorPanel.test.tsx`
  - 3 files passed, 86 tests passed.
- `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q`
  - 25 tests passed and 24 subtests passed.
- Repository generators:
  - `generate:openapi-v2`: exit 0.
  - `generate:api-v2-types`: exit 0.
  - `generate:api-v2-client`: exit 0.
- `corepack pnpm --dir apps/control-room typecheck`: exit 0.
- `corepack pnpm --dir apps/control-room lint`: exit 0 with `--max-warnings=0`.
- `corepack pnpm --dir apps/control-room check:api-hygiene`: exit 0.
- `git diff --check`: exit 0 before the report update; repeated at handoff.

### Generated transport and architecture

- OpenAPI v2 JSON and generated TypeScript types were regenerated from backend schema through repository scripts; the generated client script also completed.
- HTTP v2 remains the authoritative command transport. No route, resource hook, WebSocket payload, endpoint string, direct component `fetch()`, binary codec, ribbon, or viewport path changed.
- Inspector state remains transaction-local draft state; server resource ownership and module boundaries are unchanged.

### Remaining concerns / unchanged environment blockers

- The known full `fullmag-api` suite snapshot previously had four failures outside the Task 5 diff; the fix round intentionally used focused API gates and does not relabel those failures as baseline.
- Full frontend test/browser smoke was not repeated: the previously confirmed sandbox `spawnSync ... EPERM` and unavailable Playwright environment did not change, and no dependency was installed.
- Repo-wide `rustfmt --check` still reports existing formatting drift across large CLI/authoring files. `git diff --check`, compilation, focused tests, typecheck, and lint are clean; no broad formatting rewrite was applied.

## Follow-up: staged max-error `dt_initial` round-trip

The stage max-error exporter previously discarded an explicit `dt_initial` and emitted the deprecated `max_error` spelling. The public staged-relaxation contract now accepts canonical keyword-only `dt_initial` and `max_err` on both `relax_stage` and `study.stages.add_relax`. Their values are retained in `RelaxStageSpec`, lowered into max-error-mode `AdaptiveTimestepIR`, and rendered as human-editable public Python. Generated scripts do not expose the private `_from_max_error` constructor and do not convert max-error mode into advanced mode. Mixing canonical controls with legacy `dt`/`max_error`, or convenience controls with `adaptive_timestep`, fails deterministically.

### Follow-up TDD evidence

- RED: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q -k 'stage_overrides_export or stage_convenience_policy'`
  - 2 failed: `relax_stage` rejected `dt_initial`, while exported stage Python emitted `max_error` and omitted the explicit initial timestep.
- GREEN focused rerun of the same command:
  - 2 passed, 24 deselected, 3 subtests passed.
- Final Python LLG contract: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q`
  - 26 passed, 28 subtests passed.
- Final authoring stage projection: `cargo test -p fullmag-authoring scene_projection_ --quiet`
  - 3 passed, 0 failed, 41 filtered out.

## Second fix round after re-review of `ab108488`

Status: `DONE_WITH_CONCERNS`

No commit was created.

### Findings 11-16 resolved

- Real public `relax_stage` / `study.stages.add_relax` policies now flow through `export_builder_draft -> rewrite_loaded_problem_script -> reload`. Stage drafts carry their actual adaptive policy instead of relying on a renderer fallback.
- Max-error stages preserve explicit or omitted `dt_initial`, explicit `dt_min`/`dt_max`, `max_err`, and `tolerance_mode="max_error"`. Advanced stages preserve `atol`, `rtol`, `safety`, `growth_limit`, `shrink_limit`, `max_spin_rotation`, and `norm_tolerance` and remain advanced.
- Explicit public adaptive stage controls now fail during stage construction unless both finite positive bounds are present. `dt_initial` remains optional. Advanced `AdaptiveTimestep` stages require a non-null `dt_max`; their validated `dt_min` is carried by the public policy object.
- Control Room treats a legacy stage adaptive object without `tolerance_mode` as `advanced`, matching the Rust serde default. Stage draft load/edit/save now retains every controller and guard rather than replacing custom values with defaults.
- Production global and stage validation receives active-session algorithms and requested precision. Adaptive authoring is available only for advertised LLG, a qualified backend/device lane, and `double` precision. The API reads requested precision from the active authoring scene and rejects adaptive `single` requests before queue mutation.
- Rust authoring validates every present global `demag_interval_s` as finite and positive before projection; malformed text, non-finite values, zero, and negative values fail closed instead of becoming null.

### Finding 17 bounded duplication and compatibility proof

The API and CLI solver-policy enums remain duplicated. Extracting them was not surgical: both crates are binaries, the API variant owns OpenAPI `ToSchema`, and moving that browser transport dependency into `fullmag-ir` would invert the backend-neutral IR boundary. Instead, both crates now decode and re-encode one shared backend-neutral JSON fixture covering fixed, max-error adaptive with omitted `dt_initial`, and advanced adaptive with all optional guards. The proof exposed a real mismatch: CLI encoded omitted optional fields as explicit null while API omitted them. CLI serde omission attributes now match the API wire contract.

### Exact RED evidence

- Python public stage pipeline: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_llg_solver_contract.py -q -k 'public_relax_stages or stage_convenience_policy'`
  - RED: 5 subfailures. Explicit max-error export lost `max_err`; advanced export reloaded as max-error and lost `rtol`, controller values, and guards; three incomplete adaptive stage policies were accepted.
- Rust demag validation: `cargo test -p fullmag-authoring scene_solver_rejects_malformed_present_demag_interval --quiet`
  - RED: malformed present `demag_interval_s` validated successfully.
- API precision lane: `cargo test -p fullmag-api adaptive_command_rejects_single_precision_before_enqueue --quiet`
  - RED: HTTP returned 200 instead of 400 for adaptive FDM CPU `single`.
- Control Room focused models/panel with `TMPDIR=/tmp`:
  - RED: 3 failed / 85 passed. `single` was accepted, the production boundary omitted capability/precision errors, and discriminator-less advanced stage values loaded as max-error with controller/guard loss.
- Cross-crate serde fixture:
  - API proof passed; CLI proof failed because omitted adaptive `dt_initial` serialized as `null` instead of being omitted.

### Exact GREEN evidence

- Python public stage focused: 2 passed, 25 deselected, 11 subtests passed.
- Python full LLG contract: 27 passed, 35 subtests passed.
- Legacy staged-relax Python compatibility focus: 3 passed, 249 deselected.
- Rust authoring stage projection: 3 passed, 42 filtered out.
- Rust malformed demag validation: 1 passed, 44 filtered out.
- API adaptive-single HTTP rejection: 1 passed, 624 filtered out; the test also asserts the queue length is unchanged.
- Shared solver-policy serde fixture: API 1 passed / 624 filtered out; CLI 1 passed / 157 filtered out.
- Control Room models/panel: 3 files passed, 88 tests passed.
- Control Room `typecheck`, `lint --max-warnings=0`, and `check:api-hygiene`: exit 0.

### Transport and remaining concern

No command schema shape, route, resource, event, binary codec, endpoint string, generated OpenAPI artifact, generated TypeScript type, generated client, facade, hook, ribbon, or viewport path changed in this round. HTTP v2 remains authoritative and realtime remains invalidation-only. The remaining concern is the deliberately bounded API/CLI enum duplication; the shared serde fixture now fails either crate if their wire shapes drift.
