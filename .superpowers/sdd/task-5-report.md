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
