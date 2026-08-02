# M3 Coupled Stage Owner Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public CPU M3 transient-spin path a genuinely coupled, second-order, transactional ARS(2,3,2) implementation with complete adaptive and restart semantics.

**Architecture:** `ExchangeLlgProblem` owns the one documented ARS tableau and identifies each stage to the transport workflow. The workflow solves only the implicit stage requested by that owner from the committed origin; it never starts a nested full ARS step. A cloned coupled trial is committed by one swap only after final observation and workflow validation, while checkpoint persistence serializes the same complete coupled state and compatibility identity used by the runner.

**Tech Stack:** Rust workspace, serde JSON checkpoint documents, Axum v2 session resources, Python DSL, repository `just` verification recipes.

## Global Constraints

- CPU FDM only; no CUDA or FEM changes.
- Coefficients are exactly the canonical `docs/physics/0970-spin-hall-drift-diffusion-transport.md` ARS(2,3,2) coefficients.
- Adaptive acceptance uses full-step versus two-half-step differences divided by three and accepts the two-half candidate.
- Public capability may be promoted only when a repo-owned managed CPU workload executes the exact planner/runner path.
- All trial state, including thermal state, remains unchanged on every injected failure.

---

### Task 1: Canonical shared tableau and order oracle

**Files:**
- Modify: `crates/fullmag-engine/src/fdm/cpu/integrators.rs`
- Modify: `crates/fullmag-engine/src/fdm/cpu/transport/transient_spin.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- Test: the colocated unit tests in those files

**Interfaces:**
- Produces: one public engine stage descriptor carrying the canonical stage identity and coefficients.
- Produces: transient-spin implicit-stage solves from the committed origin and previous implicit stage.
- Removes: `try_fixed_step(origin, elapsed)` from an outer LLG callback.

- [ ] Add a coefficient/sequence test that records initial, implicit-stage-one, implicit-stage-two, and final-observation calls and rejects any nested complete step.
- [ ] Add a manufactured coupled temporal-convergence test proving approximately second-order error reduction.
- [ ] Run the focused tests and confirm they fail for the nested owner.
- [ ] Expose stage-one and stage-two implicit solves in `TransientSpinIntegrator`, using committed-origin mass assembly and the documented implicit coefficients.
- [ ] Pass the stage descriptor from the one LLG tableau owner into the workflow and materialize charge/spin/Oersted terms at the matching magnetization and time.
- [ ] Run the focused engine and runner tests and confirm the coefficient, sequence, and order oracles pass.

### Task 2: Complete adaptive state and atomic transaction

**Files:**
- Modify: `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- Test: colocated runner tests

**Interfaces:**
- Produces: one normalized coupled-state difference covering magnetization, V, J, spin accumulation, Q, torque, Oersted field, histories, controller, and cache identities.
- Produces: a trial value containing LLG state, workflow state, final report, and deferred thermal commit.

- [ ] Add tests that perturb each canonical component independently and require a nonzero normalized difference or an exact consistency failure for discrete identity/counter fields.
- [ ] Add injected failures at charge solve, spin solve, final observation, and workflow commit; assert byte-equivalent LLG/workflow/thermal state after each failure.
- [ ] Run the tests and confirm current partial comparison and early LLG commit fail.
- [ ] Calculate full/two-half error from complete trial snapshots and validate discrete identities exactly.
- [ ] Validate workflow commit on a clone, then atomically replace the caller-visible LLG/workflow state and advance thermal state once.
- [ ] Run fixed/adaptive/rollback tests and confirm all pass.

### Task 3: Complete checkpoint and public persistence

**Files:**
- Modify: `crates/fullmag-engine/src/fdm/cpu/transport/transient_spin.rs`
- Modify: the runner live/checkpoint state owner discovered from `LiveStepConsumer`
- Modify: `crates/fullmag-api/src/session_persistence.rs`
- Modify: OpenAPI/generated types only if the v2 JSON resource schema changes
- Test: engine, runner, API persistence tests

**Interfaces:**
- Produces: a versioned coupled checkpoint envelope with schema, ABI, byte order, scalar layout, vector layout, formula/operator/source versions, RNG/thermal state, previous magnetization, previous timestep, histories, controllers, warm starts, caches, counters, and requested/resolved execution identity.
- Produces: public checkpoint capture/load that restores this envelope instead of magnetization alone when M3 is active.

- [ ] Add compatibility mismatch tests for every identity class and a runner oracle comparing uninterrupted artifacts with checkpoint-restored artifacts.
- [ ] Add an API test showing public checkpoint capture/load retains the coupled envelope.
- [ ] Run and confirm both tests fail with magnetization-only public persistence.
- [ ] Extend the checkpoint schema and validate all shapes, finite values, versions, ABI/layout/endianness, and previous-state identities before restore.
- [ ] Carry the coupled checkpoint through live runner state into the existing session persistence resource; keep status thin and do not add a second endpoint family.
- [ ] Regenerate OpenAPI/client artifacts if and only if the public response schema changes.
- [ ] Run engine, runner, session-persistence, API-hygiene, and restart-equivalence tests.

### Task 4: Capability truth and Python contract

**Files:**
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: planner tests or public validation only as required by the chosen truth
- Modify: `packages/fullmag-py/src/fullmag/model/dynamics.py`
- Modify/Create: repo-owned `just`/managed M3 CPU verification inputs and tests

**Interfaces:**
- Produces: either `reference_executable` backed by an exact managed workload, or a planner error while status remains `semantic_only`.

- [ ] Add a contract test that fails if planner execution exceeds matrix status or if promoted status lacks the exact managed M3 workload.
- [ ] Add/run the CPU M3 managed workload through canonical Python to ProblemIR to planner to runner to artifacts.
- [ ] Promote the exact matrix row only if that workload executes; otherwise enforce planner fail-closed.
- [ ] Update `AdaptiveTimestep` documentation to include coupled ARS step doubling and its error semantics.
- [ ] Run Python serialization/validation tests and capability governance checks.

### Task 5: Final evidence

**Files:**
- Create: `/tmp/fullmag-spin-transport/.superpowers/sdd/m3-stage-owner-report.md` (outside commit)

- [ ] Run focused order, restart, rollback, and API persistence tests.
- [ ] Run the repo-owned managed M3 CPU recipe and capture the exact output.
- [ ] Run `just check` and any required API generation/hygiene checks.
- [ ] Inspect `git diff --check`, status, and the complete diff for unrelated changes.
- [ ] Record exact commands, results, capability status, remaining gaps, and commit hash in the report.
- [ ] Commit only the M3 remediation paths with a descriptive message.
