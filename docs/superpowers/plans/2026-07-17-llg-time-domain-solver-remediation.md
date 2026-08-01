# LLG Time-Domain Solver Complete Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `subagent-driven-development` task by task. Every production-code task uses
> strict RED/GREEN: add the named failing contract, record the intended
> failure, implement the smallest complete cross-layer change, run focused
> gates, then pass task-scoped specification and quality review.

**Goal:** Close findings `LLG-TD-API-001` through `LLG-TD-PERF-013` and phases
0 through 6 of
`docs/audits/2026-07-16-llg-time-domain-solver-audit.md`, including the
approved `fix_dt`/adaptive API, removal of hidden timestep fallbacks,
order-aware fail-closed adaptive integration, full state atomicity,
demagnetization convergence, observability, scientific qualification, and a
separately qualified stiff time-domain lane.

**Approved contract:**
`docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`.
The audit remains the finding register and reproducer evidence. Where older
draft notes 0480/0490 disagree, note 0960 governs and those notes must be
reconciled rather than used to reintroduce hidden relative tolerance or
sentinel timesteps.

**Architecture:** Public authoring lowers one backend-neutral fixed or
adaptive timestep policy into ProblemIR. Validation and planning fail before
backend materialization when intent cannot be preserved. A typed runner
resolver records requested and resolved policy. FDM and FEM CPU/GPU keep
separate performance realizations while consuming the same scalar controller
semantics and golden vectors. Each attempted step is a transaction; field
solves, guards, final refresh, statistics, and trace complete before one
atomic commit. The stiff tangent-plane time integrator is a separate physical
integrator, not the existing relaxation minimizer and not a hidden RK
fallback.

**Tech stack:** Python DSL, Rust ProblemIR/planner/runner/authoring/API, C++20
MFEM/hypre, CUDA, C ABI, Next.js/TypeScript Control Room, repository-managed
Docker/`just` native gates, Python/Rust artifact validators.

## Global constraints

- Preserve the full scope. A repaired Python signature or one green CPU unit
  test is not completion.
- `fix_dt` is a true fixed timestep and is mutually exclusive with every
  adaptive knob.
- Adaptive mode uses `dt_initial` (optional), `dt_min`, `dt_max`, and
  `max_err`; omitted `dt_initial` resolves to exactly `dt_min`.
- `dt_initial == dt_min` is explicit, never a sentinel. Delete the global
  `1e-13`/`1e-10` fallback behavior.
- `max_err` is the absolute maximum node/cell embedded vector error. It must
  not inherit hidden `rtol=1e-3`. Advanced `atol/rtol` is separate and
  mutually exclusive with `max_err`.
- Legacy `dt` and `max_error` may be accepted only as deterministic deprecated
  aliases, with rejection on mixing and canonical export using new names.
- Requested intent and resolved execution are both typed and preserved in
  ProblemIR/provenance/artifacts.
- Unsupported multilayer, hybrid, device, precision, guard, or integrator
  combinations fail closed before native execution.
- Do not put algorithms or physics ownership in `Context`,
  `mfem_bridge.cpp`, runner dispatch, or libCEED glue.
- CPU and GPU may share pure scalar policy and immutable golden vectors, not
  hot-loop implementation or mutable state.
- A rejected or failed attempt never publishes magnetization, fields, time,
  counters, caches, controller history, FSAL state, energy, or telemetry as an
  accepted step.
- Iterative demag nonconvergence is an RHS failure, never a warning followed
  by publication.
- Native FEM builds and runtime proof use repository container-backed `just`
  recipes. Host builds are diagnostic only.
- Preserve unrelated changes in the original dirty checkout. Work only in
  `/tmp/fullmag-llg-time-domain-remediation` on
  `codex/llg-time-domain-remediation` until integration is explicitly chosen.
- Do not promote capability beyond a checked-in deterministic fixture and
  bounded qualification artifact.

## Baseline

Recorded on 2026-07-17 at
`707a50386cdfe6787aac06cca3070289dc731fa2`:

- focused Python legacy solver tests: `2 passed`;
- `cargo test -p fullmag-runner --lib initial_timestep_tests`: `5 passed`,
  including two tests that incorrectly require fallback `1e-13`;
- focused `fullmag-ir` adaptive search: `1 passed` but does not cover the LLG
  adaptive policy;
- `just verify-fem-time-domain-native-contract`: RED during CMake generation
  because `CUDA_ARCHITECTURES` is empty for FDM/FEM CUDA targets;
- the native recipe does not build or run `fem_adaptive_dt_contract` or
  `fem_llg_rhs_contract`.

The first task must separate infrastructure/source-contract drift from solver
failures so later green evidence is meaningful.

## Per-task RED/GREEN/review protocol

For every production task:

1. Add only the task-owned failing test/fixture.
2. Run the focused command and record a nonzero exit plus the intended named
   assertion in `.superpowers/sdd/llg-td-task-N-report.md`. A compile or
   environment failure unrelated to that assertion is not RED.
3. Implement the complete task contract across every named layer. No
   placeholder branches or fake capability flags.
4. Re-run the focused gate to GREEN.
5. Run the task's wider regression gates.
6. Run `git diff --check`, inspect `git status --short`, and review only
   task-owned hunks.
7. Pass a specification review and a code-quality review before advancing.
8. Commit the task with a descriptive subject and the RED/GREEN evidence in
   its report.

## Finding coverage

| Tasks | Findings closed |
|---|---|
| 1-4 | `LLG-TD-API-001`, `LLG-TD-TIME-002`, `LLG-TD-API-009` |
| 5-7 | `LLG-TD-STAB-003`, `LLG-TD-CTRL-004`, FDM/FEM parity portion |
| 8 | `LLG-TD-GUARD-005`, `LLG-TD-NORM-007` |
| 9 | `LLG-TD-DEMAG-006` |
| 10 | `LLG-TD-ATOMIC-008` |
| 11 | `LLG-TD-OBS-010`, telemetry part of phases 0 and 5 |
| 12 | `LLG-TD-TEST-011`, `LLG-TD-RELAX-012`, explicit qualification |
| 13-15 | phase 6 stiff lane and capability qualification |
| 6, 7, 12 | `LLG-TD-PERF-013` disposition and bounded FSAL evidence |

---

### Task 1: Freeze canonical documentation, capability vocabulary, and gate baseline

**Files:**

- Include: `docs/audits/2026-07-16-llg-time-domain-solver-audit.md`
- Include: `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`
- Modify: `docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md`
- Modify: `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md`
- Modify: `docs/physics/llg_conventions.md`
- Modify: `docs/physics/0910-table-autosave-observables.md`
- Modify: `docs/architecture/backend-golden-masterplan.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/physics/README.md`
- Modify: `justfile`
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `backends/fem/tests/adaptive_dt_contract.cpp`
- Modify: `backends/fem/tests/source_facade_gpu_rk_contract.cpp`

- [ ] Add a documentation contract test requiring fixed/adaptive/stiff rows,
  `fix_dt`, optional `dt_initial -> dt_min`, absolute `max_err`, typed
  `dt_min_exhausted`, atomic commit, and attempt artifacts.
- [ ] Reconcile draft notes 0480/0490 and conventions with note 0960; distinguish
  solver attempts from coalesced autosave output.
- [ ] Split capability rows by fixed/adaptive/stiff, backend, device, precision,
  and validation state without promoting unsupported lanes.
- [ ] Diagnose and fix the managed gate's empty CUDA architecture setup in the
  repo-owned container path without hardcoding one developer GPU.
- [ ] Fix `fem_adaptive_dt_contract` repository-root discovery and add it plus
  `fem_llg_rhs_contract` to the canonical native gate.
- [ ] Reconcile the external-plus-regional-drive GPU source assertion
  semantically; do not weaken pointer/source checks.
- [ ] GREEN: documentation contract and
  `just verify-fem-time-domain-native-contract` reach the solver contracts.

### Task 2: Add canonical Python API and lossless script round-trip

**Files:**

- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/model/dynamics.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `packages/fullmag-py/tests/test_api.py`
- Modify/add focused script/scene round-trip tests under
  `packages/fullmag-py/tests/`

- [ ] RED for `StudyBuilder.solver(...)` and module `solver(...)` with fixed
  `fix_dt`, adaptive explicit/omitted `dt_initial`, equal-to-minimum initial
  step, `dt_max`, `max_err`, `g`, and staged `add_run(until=...)`.
- [ ] RED for every illegal mix, nonfinite/nonpositive value, inverted bounds,
  unsupported integrator, and deprecated-alias conflict.
- [ ] Preserve `AdaptiveTimestep.dt_initial=None`; remove lowering to `dt_min`.
- [ ] Make `max_error` a deprecated deterministic alias of absolute
  `max_err`, not an `atol`-only shortcut.
- [ ] Canonical export emits `fix_dt` or adaptive names and preserves omission.
- [ ] GREEN focused Python tests and full `packages/fullmag-py/tests/test_api.py`.

### Task 3: Extend ProblemIR validation, normalization, and planner legality

**Files:**

- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/validation.rs`
- Modify: `crates/fullmag-plan/src/validate.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Add/modify focused tests in `crates/fullmag-ir` and `crates/fullmag-plan`
- Modify: `docs/specs/problem-ir-v0.md`

- [ ] RED for nullable `dt_initial`, explicit equality with `dt_min`, maximum
  error versus advanced tolerance mode, finite values, bounds, safety/clamps,
  guard ranges, and fixed/adaptive mutual exclusion.
- [ ] Add a lossless IR representation of requested maximum-error mode while
  preserving legacy deserialization.
- [ ] Validate at least one positive advanced tolerance and allow `rtol=0`.
- [ ] Planner rejects any lane that would drop tolerance mode, bounds, guards,
  device/precision intent, or adaptive semantics.
- [ ] Preserve and duplicate at runner/native boundary the existing fail-closed
  multilayer adaptive rejection.
- [ ] GREEN: `cargo test -p fullmag-ir` and
  `cargo test -p fullmag-plan --lib --no-fail-fast`.

### Task 4: Remove timestep sentinels and add typed requested/resolved provenance

**Files:**

- Modify: `crates/fullmag-runner/src/lib.rs`
- Modify all `DEFAULT_ADAPTIVE_DT_INITIAL` consumers under
  `crates/fullmag-runner/src/`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify runner plan/runtime artifact serialization tests

- [ ] RED: omitted initial resolves to `dt_min`; explicit equality and distinct
  values are preserved; no code path resolves to hidden `1e-13` or `1e-10`.
- [ ] Replace the global sentinel with one resolver returning typed requested
  and resolved policies plus `explicit|dt_min_default` reason.
- [ ] Update interactive, batch, FDM, FEM CPU/GPU, dispatch, and execution
  consumers to use that resolver rather than local fallbacks.
- [ ] Replace lossy `dt_policy` string with bounded typed provenance while
  preserving compatible reads where required.
- [ ] GREEN: focused resolver/provenance tests and
  `cargo test -p fullmag-runner --lib --no-fail-fast`.

### Task 5: Preserve solver policy through authoring, OpenAPI, and Control Room

**Required skills before edits:** `resource-first-api-check`,
`frontend-v2-api-hygiene`, `frontend-v2-state-hygiene`, and
`frontend-v2-module-architecture`.

**Files:**

- Modify: `crates/fullmag-authoring/src/builder.rs`
- Modify: `crates/fullmag-authoring/src/scene.rs`
- Modify: `crates/fullmag-authoring/src/adapters.rs`
- Modify: `crates/fullmag-api/src/schemas/commands.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs`
- Modify: `crates/fullmag-api/src/types.rs`
- Modify generated OpenAPI/frontend transport through repository generators
- Modify: `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyPipelineSection.tsx`
- Modify focused model/panel tests

- [ ] RED scene -> IR -> canonical Python round-trip for fixed and adaptive
  policy, including omitted `dt_initial` and `dt_max`.
- [ ] Replace raw global-solver JSON with typed capability-gated controls.
- [ ] Keep UI fields, OpenAPI command schema, scene document, and script export
  on one vocabulary; no direct component endpoint strings.
- [ ] Generate types/client through repo commands and pass API-hygiene checks.
- [ ] GREEN: `cargo test -p fullmag-authoring`, `cargo test -p fullmag-api`,
  focused frontend tests, typecheck, lint, full test, and study-authoring smoke.

### Task 6: Implement one order-aware fail-closed FEM adaptive decision contract

**Files:**

- Add backend-neutral scalar policy types under `backends/fem/core/`
- Modify: `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`
- Modify: `backends/fem/cpu/mfem/integrators/rk_tableau.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu`
- Modify: `backends/fem/tests/adaptive_dt_contract.cpp`
- Add shared CPU/GPU golden-vector contract tests

- [ ] RED: RK23 `order_est=2` and RK45 `order_est=4` produce their documented
  different ratios for the same scalar history.
- [ ] RED: accepted PI history may shrink `dt_next`; error above one at
  `dt_min` returns typed `dt_min_exhausted`; invalid/nonfinite input fails.
- [ ] Freeze one decision/reason vocabulary and startup/history rule in the
  physics note and tests.
- [ ] CPU and GPU-host realizations consume identical immutable vectors and
  return equal decisions within scalar precision budgets.
- [ ] GREEN: focused adaptive contracts and canonical managed native gate.

### Task 7: Bring FDM CPU/CUDA adaptive and fixed semantics to parity

**Files:**

- Modify: `crates/fullmag-engine/src/fdm/cpu/integrators.rs`
- Modify: `crates/fullmag-engine/src/fdm/shared/problem.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- Modify: `native/include/fullmag_fdm.h` using a new ABI version/symbol where
  layout changes require it
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs`
- Modify: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` and FP32 owner
- Add CPU AoS/SoA and CUDA FP32/FP64 focused contracts

- [ ] RED: fixed RK23/RK45 performs no adaptive retry or suggestion.
- [ ] RED: no CPU/CUDA lane force-accepts at `dt_min`.
- [ ] Preserve `rtol`, growth/shrink, norm and rotation guards through the new
  native ABI; do not silently approximate unsupported fields.
- [ ] Batch CUDA consumes each accepted `dt_next`.
- [ ] Every multilayer entry fails before native execution if adaptive intent
  is unsupported.
- [ ] GREEN focused FDM parity gates and existing production parity recipes.

### Task 8: Add finite/norm/rotation guards and safe normalization

**Files:**

- Modify: `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu`
- Modify: `backends/fem/cpu/mfem/integrators/llg_rhs.cpp`
- Modify: `backends/fem/gpu/cuda/fields/vector_field_kernels.cu`
- Modify FEM request/ABI/runner guard propagation
- Add guard/nonfinite contract tests

- [ ] RED zero, subnormal, NaN, and Inf at every RK stage.
- [ ] Measure norm defect before normalization and rotation against the
  pre-attempt state; reject rotation independently when `eta <= 1`.
- [ ] GPU performs vector reductions on device and transfers only bounded
  scalars.
- [ ] No failed guard mutates accepted state or publishes an attempt as a step.
- [ ] GREEN CPU/GPU guard contracts and canonical native gate.

### Task 9: Make every FEM demagnetization solve fail closed

**Files:**

- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/demag_fem_bem_linear_solve.cpp`
- Modify typed error/telemetry transport and focused demag contracts

- [ ] RED force a nontrivial solve with `max_iterations=1` in standard CPU,
  periodic CPU, GPU, and hybrid realizations.
- [ ] Reject false convergence, nonfinite residual, and residual above the
  requested bound with solver kind, iterations, residual, tolerance, and max
  iterations.
- [ ] Failed fields are neither current nor cached and cannot enter RHS,
  energy, or output.
- [ ] GREEN focused contracts and `just verify-fem-demag-poisson-contract`.

### Task 10: Make accepted-step publication atomic on FEM CPU and GPU

**Files:**

- Modify: `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_stage_schedule.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu`
- Modify: `backends/fem/cpu/mfem/runtime/backend_step.cpp`
- Add solver-local transaction/snapshot owners and failure-injection tests

- [ ] RED inject failure after candidate magnetization, during final field
  refresh, and during final statistics.
- [ ] Compare full pre/post state, including time, step, fields, caches, FSAL,
  controller history, device residency, and counters.
- [ ] Construct on private candidate state and commit all live state once.
- [ ] On success, fields/energy/torque are fresh for the committed state and
  telemetry commits exactly once.
- [ ] GREEN CPU/GPU atomicity contracts and canonical native gate.

### Task 11: Publish bounded attempt/step telemetry and typed artifacts

**Files:**

- Extend ABI types in `native/include/fullmag_fem.h` with versioned symbols
- Modify native CPU/GPU RK workspace telemetry owners
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Modify relevant v2 diagnostics OpenAPI/resource hooks and Control Room
- Modify: `docs/physics/0910-table-autosave-observables.md`
- Add artifact validators and trace-replay tests

- [ ] RED one-record-per-attempt and deterministic trace replay.
- [ ] Add bounded `solver_config.json`, `solver_attempts.csv`,
  `solver_steps.csv`, and `qualification.json` schemas.
- [ ] Include attempted/accepted `dt`, eta, guards, decision/reason, rejects,
  energy terms/budget, torque/RHS, demag solve counts/residuals, estimator order,
  and requested/resolved policy.
- [ ] Keep attempt trace separate from coalesced table autosave.
- [ ] GREEN artifact validators, API tests, frontend diagnostics tests, and
  runner suite.

### Task 12: Qualify repaired explicit solvers and exact relax-to-run behavior

**Files:**

- Add deterministic macrospin, exchange eigenmode, fast-mode, and autonomous
  relax-to-run fixtures under repo validation ownership
- Add a checked-in reduced periodic-antidot mesh/problem asset after its exact
  reduction is reviewed
- Add Python artifact validators and managed `just` recipes
- Update capability matrix only from generated qualification evidence

- [ ] RED macrospin trajectory/frequency/damping for
  `alpha={0.1,1,10}` and `|m|-1`.
- [ ] RED periodic exchange eigenmode frequency, decay, and temporal order
  under `dt`, `dt/2`, `dt/4`.
- [ ] RED the audit fast mode: no accepted growing solution for a decaying
  exact mode.
- [ ] RED exact autonomous relax-to-run state handoff, run clock, fresh fields,
  energy descent budget, trace replay, and demag residual.
- [ ] Qualify CPU FP64 before GPU FP64; compare at common physical times and
  prove no forced-device fallback. Keep FP32 unqualified until its own gate.
- [ ] Treat strict relaxation certification as fixture precondition, not a
  workaround for unstable integration.
- [ ] GREEN all managed scientific recipes and canonical native gate.

### Task 13: Publish and implement the stiff tangent-plane time integrator on FEM CPU

**Files:**

- Extend note 0960 with the selected fully discrete weak form and solver
  tolerances before production code
- Add backend-neutral scheme/config/diagnostic structs under
  `backends/fem/core/`
- Add CPU owner under
  `backends/fem/cpu/mfem/integrators/tangent_plane/`
- Reuse only mathematically valid operator actions from relaxation code; do
  not call `run_tangent_plane_implicit_step()` as a time step
- Add new versioned C ABI selection/diagnostics and Rust planner/runner path
- Add managed CPU qualification recipe

- [ ] RED macrospin precession and damping, proving physical-time advancement
  and the precessional operator absent from the minimizer.
- [ ] RED stiff periodic exchange mode with documented temporal order and no
  explicit `dt ~ h^2` stability dependence over the qualified range.
- [ ] RED linear/nonlinear solve nonconvergence and full transaction rollback.
- [ ] Implement the approved tangent-velocity weak form, solver tolerances,
  preconditioner, projection/update, and exact requested/resolved provenance.
- [ ] GREEN CPU FP64 analytic, autonomous-energy, and stiff-mode managed gates.

### Task 14: Implement and qualify the stiff tangent-plane FEM GPU realization

**Files:**

- Add GPU owner under
  `backends/fem/gpu/cuda/integrators/tangent_plane/`
- Extend versioned ABI/runner realization without host fallback
- Add device-residency and CPU/GPU parity contracts
- Add managed GPU qualification recipe

- [ ] RED forced GPU unavailable/fallback, unbounded host vector round-trip,
  nonconverged device solve, and CPU/GPU trajectory mismatch.
- [ ] Implement separate CUDA/libCEED/hypre realization of the same frozen
  scheme; keep hot-loop vectors device-resident.
- [ ] Qualify GPU FP64 against CPU FP64 at common physical times, including
  macrospin, exchange eigenmode, autonomous energy, residuals, and rollback.
- [ ] Keep GPU FP32 unavailable or development-only until a separate bounded
  qualification passes.
- [ ] GREEN managed device-residency, parity, and stiff GPU runtime recipes.

### Task 15: Final cross-layer qualification, review, and integration handoff

**Files:**

- Update: `docs/audits/2026-07-16-llg-time-domain-solver-audit.md` with a
  finding-by-finding closure ledger and artifact links
- Update physics/spec/capability docs from actual evidence
- Add `.superpowers/sdd/llg-td-final-report.md`

- [ ] Re-run Python, IR, planner, runner, authoring, API, generated-client,
  Control Room, FDM, FEM explicit, demag, atomicity, telemetry, scientific,
  and stiff CPU/GPU gates from a clean worktree.
- [ ] Verify exact `fix_dt` and adaptive user examples round-trip and execute.
- [ ] Verify no `DEFAULT_ADAPTIVE_DT_INITIAL`, float-equality sentinel, hidden
  `rtol=1e-3`, `dt_min` force-accept, fail-open demag, or unsupported adaptive
  materialization remains using repository searches plus tests.
- [ ] Run `git diff --check`, inspect task commits, and obtain independent
  specification and code review.
- [ ] Use `verification-before-completion`; report exact evidence and remaining
  unqualified lanes without broad claims.
- [ ] Use `finishing-a-development-branch` and ask the user how to integrate;
  do not merge into the dirty original checkout automatically.

## Final acceptance gates

At minimum, all of the following must be green from clean state:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m unittest packages.fullmag-py.tests.test_api
cargo test -p fullmag-ir --no-fail-fast
cargo test -p fullmag-plan --lib --no-fail-fast
cargo test -p fullmag-runner --lib --no-fail-fast
cargo test -p fullmag-authoring --no-fail-fast
cargo test -p fullmag-api --no-fail-fast
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room smoke:study-authoring-ui
just verify-fem-time-domain-native-contract
just verify-fem-demag-poisson-contract
just <new-explicit-relax-to-run-qualification-recipe>
just <new-stiff-cpu-qualification-recipe>
just <new-stiff-gpu-qualification-recipe>
```

Recipe placeholders above are task outputs, not permission to omit gates.
Tasks 12-14 must replace them with stable repo-owned names before final review.
