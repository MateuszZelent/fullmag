# FDM Multilayer Direct Minimizers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PG-BB and NCG public, physically correct FDM multilayer relaxation algorithms on CPU and every existing CUDA realization.

**Architecture:** A layer-major direct-minimizer driver reuses the existing backend-neutral BB, PR+, Armijo, and physical metric helpers. Backend adapters evaluate every trial by restoring per-layer state, refreshing all conservative fields including global demag, and returning the *realized* state, field, energy, and per-object scalars. No path calls the single-grid minimizer or silently changes device/precision.

**Tech Stack:** Rust, `fullmag-engine` multilayer observables, native CUDA FDM ABI, existing artifact/provenance model, cargo tests, managed CUDA runtime recipe.

## Global Constraints

- Direct-minimizer products use `mu0 * Ms_i * V_i`; inactive cells carry zero volume.
- Every Armijo trial uses fresh total conservative energy and `H_eff`.
- `max_torque_Apm` is fresh `max |m x H_eff|` in A/m; direct minimizers publish no physical time.
- CUDA FP32 evaluates the quantized magnetization it uploads; no CPU fallback is allowed.
- Rejected trials never publish an artifact, live update, or accepted iteration.
- Preserve the current public Python and ProblemIR algorithm vocabulary.

---

### Task 1: Establish multilayer planner and CPU regression tests

**Files:**
- Modify: `crates/fullmag-plan/src/fdm.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs`

**Interfaces:**
- Consumes: `FdmMultilayerPlanIR.relaxation: Option<RelaxationControlIR>`.
- Produces: executable CPU multilayer PG-BB/NCG with accepted-step semantics.

- [ ] Add a planner test that lowers a two-body FDM problem with each direct algorithm and currently expects the explicit `only 'llg_overdamped'` rejection.
- [ ] Run `cargo test -p fullmag-plan multilayer_direct --lib`; confirm red.
- [ ] Add CPU tests for uniform equilibrium, two-layer demag/exchange accepted-energy monotonicity, zero stage time, and minimizer provenance. Keep the failure specific to rejected/absent direct execution.
- [ ] Run `cargo test -p fullmag-runner multilayer_direct --lib`; confirm red.

### Task 2: Add backend-neutral multilayer direct-minimizer driver

**Files:**
- Create: `crates/fullmag-runner/src/relaxation/multilayer_direct_minimizer.rs`
- Modify: `crates/fullmag-runner/src/relaxation/mod.rs`
- Modify: `crates/fullmag-runner/src/relaxation/direct_minimizer.rs`

**Interfaces:**
- Produces `execute_multilayer_direct_minimizer(control, initial, weights, evaluate_trial)` where `evaluate_trial` returns the realized `m`, `H_eff`, total energy, per-object scalar map, and canonical `StepStats` ingredients.
- Uses `DirectMinimizerState`, `energy_metric_dot`, `projected_gradient_line_search`, and `nonlinear_cg_line_search` unchanged for numerical policy.

- [ ] Write unit tests whose evaluator counts calls and proves every backtracked trial is evaluated, but only accepted trials are emitted.
- [ ] Run the new test and confirm red because the driver is absent.
- [ ] Implement the smallest driver: flat layer-major state, BB/NCG branch, realized-trial replacement, physical weights, exact torque, accepted-step counters, and numerical-stagnation result.
- [ ] Generalize per-object diagnostics so the driver never invents the single-grid object id `free`.
- [ ] Run `cargo test -p fullmag-runner multilayer_direct_minimizer --lib`; confirm green.

### Task 3: Wire CPU multilayer evaluator and planner legality

**Files:**
- Modify: `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs`
- Modify: `crates/fullmag-plan/src/fdm.rs`

**Interfaces:**
- CPU evaluator splits a flat trial by `LayerContext.problem.grid.cell_count()`, calls `ExchangeLlgState::set_magnetization`, then `observe_multilayer`.
- The evaluator returns per-cell `Ms_i`, active-cell `V_i`, concatenated fresh `H_eff`, and total energy.

- [ ] Implement direct-minimizer dispatch before the LLG time loop; preserve the LLG path unchanged.
- [ ] Use `apply_energy_minimizer_provenance`; set direct rows to `time=0`, `dt=0`, and record final field snapshots.
- [ ] Remove the multilayer planner’s LLG-only rejection after CPU behavior is available.
- [ ] Run the Task 1 CPU/planner tests; confirm green.

### Task 4: Wire CUDA-assisted double and single evaluators

**Files:**
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer/tests.rs`

**Interfaces:**
- Double adapter uploads every layer, refreshes native/staged demag and observables, and returns `observe_multilayer_cuda` values.
- Single adapter first converts and uploads FP32, copies the resident magnetization, then evaluates the quantized realized state with `observe_multilayer_cuda_single`.

- [ ] Add failing CUDA-gated tests for PG-BB and NCG: an assisted configuration that is ineligible for native stacking, monotonic accepted energy, zero time, and truthful `cuda_assisted_multilayer` provenance.
- [ ] Implement adapters through the shared driver; do not duplicate Armijo/BB/NCG formulas.
- [ ] Add an FP32 test that asserts accepted energies are nonincreasing within the documented FP32 tolerance and that rounded-away steps become stagnation.
- [ ] Run the CUDA-gated tests; verify they skip only if CUDA is absent and pass when available.

### Task 5: Wire native-stacked CUDA and managed runtime qualification

**Files:**
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer/tests.rs`
- Modify: `justfile`
- Create: `scripts/verify_fdm_multilayer_relaxation_runtime.py`

**Interfaces:**
- Native-stacked adapter preserves layer ownership while using `NativeFdmBackend` for trial upload, refresh, and field copy.
- Runtime recipe proves one native-stacked and one assisted scenario for both direct algorithms.

- [ ] Add a failing native-stacked eligibility fixture using aligned equal-material layers and assert per-object scalar ownership is preserved.
- [ ] Implement the adapter and direct-minimizer dispatch before its time loop.
- [ ] Add `verify-fdm-multilayer-relaxation-runtime` as a managed recipe that writes a JSON summary and fails on missing accepted-energy/torque/provenance evidence.
- [ ] Run the managed recipe on CUDA hardware; retain the output artifact.

### Task 6: Publish capability and completion evidence

**Files:**
- Modify: `docs/physics/0500-fdm-relaxation-algorithms.md`
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `scripts/check_relaxation_contract_docs.py` and its tests if they encode the old multilayer gap

- [ ] Update the FDM multilayer rows only after all runtime adapters and tests are green; distinguish CUDA FP64 and FP32 qualification.
- [ ] Replace the temporary pending checklist entries with evidence-backed completion entries.
- [ ] Run `python3 scripts/check_relaxation_contract_docs.py` and the focused planner/runner/runtime suite.
- [ ] Perform a requirement-by-requirement audit against `0580`, this plan, and the capability matrix before claiming completion.
