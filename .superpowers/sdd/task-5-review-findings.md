# Task 5 review findings to fix

## Critical

1. Canonical `solver_policy` is enqueued in `fullmag-api`, but `crates/fullmag-cli/src/types.rs` has no matching field and `resolve_interactive_llg_policy` in `step_utils.rs` reads only legacy fields. Canonical fixed/adaptive commands are silently ignored at execution. The non-LLG/direct-minimizer guard also omits `solver_policy`.
2. Executable adaptive API/stage policy accepts omitted `dt_max`. Scene/UI drafts may preserve omission losslessly, but an execution command/stage must fail closed unless `dt_min`, `dt_max`, and exactly one tolerance mode are complete.
3. Omitted stage `dt_initial` is loaded as `"auto"`, then rejected by validation as nonnumeric. Omission must remain valid and resolve later to exactly `dt_min`.
4. Stage adaptive edits are absent from the Rust `stages` rewrite projection, so canonical Python export can retain an old policy and drop edited `dt_min`, `dt_max`, `max_err`, or advanced tolerances.
5. A new advanced global policy initializes required controller fields (`safety`, `growth_limit`, `shrink_limit`) as blanks/null, exposes no controls/defaults for them, and passes UI validation even though the Python generator rejects it.

## Important

6. Mixed fixed/convenience-adaptive/advanced-adaptive scene state is silently normalized by precedence. Add fail-closed authoring validation and deterministic conflict rejection. Malformed present numeric values must not silently become null.
7. Stage/global validation lacks complete ordered bounds and integrator compatibility. Enforce `dt_max >= dt_min`, optional `dt_initial` in range, adaptive only for supported embedded RK integrators, finite values, and exact tolerance-mode rules.
8. Capability gating uses only `algorithms_available` containing `llg_overdamped`. Gate or clearly fail closed using backend/device/precision/integrator capability data; do not advertise currently rejected adaptive FDM CUDA. API command validation must also consult the active execution lane before enqueue where possible.
9. OpenAPI uses free-form integrator strings and one loose adaptive object. Replace with typed integrator enum and schema variants/shape that encode fixed, max-error adaptive, and advanced adaptive without accepting mixed/missing tolerance modes at the type boundary.
10. Add integration proof from API command through CLI interactive resolution, not only API queue preservation. Add scene -> canonical Python tests for fixed, convenience adaptive, advanced adaptive, omitted `dt_initial`, and conflict/error cases.

## Verification constraints

- Use TDD for every correction and record RED/GREEN in `.superpowers/sdd/task-5-report.md`.
- Regenerate OpenAPI JSON/types/client only through repository scripts.
- Run focused `fullmag-authoring`, `fullmag-api`, `fullmag-cli` tests; focused Control Room model/panel tests; Python LLG contract; typecheck; lint; API hygiene; `git diff --check`.
- Do not hide the known full-suite/environment failures. Browser smoke may remain an explicit environment blocker if Playwright is unavailable; do not install unpinned dependencies.

## Re-review findings after `ab108488`

### Critical

11. Fix the real public Python stage path, not only artificial overrides. `_stage_draft` must carry `study.dynamics.adaptive_timestep`; a normal `relax_stage`/`add_relax` fixed, max-error, or advanced policy must survive `export_builder_draft -> rewrite_loaded_problem_script -> reload` with its exact tolerance mode and requested values.
12. Advanced stage rendering must preserve `rtol`, `safety`, `growth_limit`, `shrink_limit`, `max_spin_rotation`, and `norm_tolerance`; it must never fall through a max-error-only renderer.

### Important

13. Executable public Python adaptive stages require explicit finite positive `dt_min` and `dt_max`; only `dt_initial` is optional. Reject incomplete max-error and advanced policies at construction, not only later in IR validation.
14. Preserve legacy advanced stage payloads that omit `tolerance_mode` according to the Rust compatibility default (`advanced`). Add all controller/guard fields to the stage draft and preserve them on UI load/save; do not overwrite custom values with defaults.
15. Production UI validation must actually receive active algorithms and requested precision. Gate adaptive authoring on backend/device/precision, with double-only qualification and fail-closed FDM CPU behavior. API command lane validation must include requested precision and reject unqualified single before enqueue.
16. Validate malformed present `demag_interval_s` in Rust authoring rather than lowering it to null.

### Minor to record or eliminate

17. API and CLI duplicate the solver-policy transport enums. Prefer a shared backend-neutral transport/IR contract if it can be done surgically; otherwise add an explicit cross-crate serde compatibility test and record the bounded duplication in the report.
