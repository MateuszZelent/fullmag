# FDM CPU Solver Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć i zweryfikować findingi FDM CPU bez zmiany kanonicznych równań, zachowując referencyjny lane `double` i osobne realizacje AoS/SoA.

**Architecture:** Wspólny kontroler accepted-step będzie właścicielem decyzji adaptacyjnej, RNG i rewizji cache. Integratory pozostaną osobnymi tableau, a layout będzie wybierany przez jawny kontrakt capability zamiast przez hot-loop heurystykę. Optymalizacje będą wprowadzane dopiero po testach poprawności i pomiarze.

**Tech Stack:** Rust `fullmag-engine`, `fullmag-runner`, rustfft, cargo test, Python benchmark/provenance scripts.

## Global Constraints

- Nie zmieniać `external_solvers/3` ani innych niezwiązanych zmian.
- Accepted-step jest jedynym miejscem publikacji magnetyzacji, historii, RNG i observables.
- `EngineError` nie może maskować `NaN`, `Inf` ani wyczerpania `dt_min`; komunikat musi być stabilnym typed reason.
- CPU `double` pozostaje oracle dla GPU i layout parity.
- Nie dodawać fizyki do runnera; runner tylko przekazuje `EvaluationRequest`, plan i provenance.
- Każdy test regresyjny ma mieć osobny czerwony przebieg przed implementacją.

---

### Task 1: Podłączenie rzeczywistego kontrolera adaptacyjnego (FDM-CPU-NUM-001)

**Files:**
- Modify: `crates/fullmag-engine/src/fdm/cpu/integrators.rs:17-101`, `817-1775`, `2217-2605`
- Modify: `crates/fullmag-engine/src/fdm/shared/problem.rs:500-545`
- Modify: `crates/fullmag-engine/src/fdm/shared/observables.rs:1-130`
- Create: `crates/fullmag-engine/tests/fdm_adaptive_cpu.rs`

**Interfaces:**
- Consumes: `AdaptiveStepConfig`, `StepReport::suggested_next_dt`, accepted `ExchangeLlgState`/`ExchangeLlgStateSoA`.
- Produces: one retry loop whose `dt` is replaced by the controller result, `DtMinExhausted` and `NonFiniteError` reasons, and unchanged accepted state on rejected attempts.

- [ ] **Step 1: Write the failing pure-controller tests.** Add cases for finite rejection (`error=4`), `NaN`, `+Inf`, `dt_min`, `dt_max`, and monotonic shrink:

```rust
#[test]
fn adaptive_controller_rejects_non_finite_and_stops_at_dt_min() {
    let cfg = test_config();
    assert_eq!(decide_adaptive_step(4, 1e-3, 4.0, None, cfg), AdaptiveDecision::Retry(2e-4));
    assert_eq!(decide_adaptive_step(4, 1e-6, f64::NAN, None, cfg), AdaptiveDecision::NonFinite);
    assert_eq!(decide_adaptive_step(4, cfg.dt_min, 4.0, None, cfg), AdaptiveDecision::DtMinExhausted);
}
```

- [ ] **Step 2: Run the focused test and record the expected failure.** Run `cargo test -p fullmag-engine adaptive_controller_rejects_non_finite_and_stops_at_dt_min -- --exact`; it must fail because `NonFinite` and the corresponding branch do not exist.
- [ ] **Step 3: Implement one controller result type.** Extend the private decision enum with `NonFinite`, reject non-finite errors before power operations, and keep `dt_next` clamped to `[dt_min, dt_max]`.
- [ ] **Step 4: Write the failing integration tests.** In `crates/fullmag-engine/tests/fdm_adaptive_cpu.rs`, exercise RK23 and RK45 through the AoS, SoA and persistent-SoA entry points. Use a deterministic one-cell problem and a test-only error injector in the buffer/controller boundary; assert that the second attempt receives the smaller `dt`, timeout is not reached, and state/time remain unchanged on `Err`.
- [ ] **Step 5: Run the integration tests red, then wire all six reject paths.** Replace the local `let dt_next` branches at lines 977, 1105, 1496, 1758, 2325 and 2591 with the controller result and assign `dt = next` before retry; do not duplicate controller math.
- [ ] **Step 6: Verify green and error identity.** Run `cargo test -p fullmag-engine fdm_adaptive_cpu -- --nocapture` and `cargo test -p fullmag-engine adaptive_decision_tests`; assert exact `dt_min_exhausted` and `non_finite_adaptive_error` messages.
- [ ] **Step 7: Commit.** Stage only the FDM CPU files and commit `fix: make fdm cpu adaptive retries progress`.

### Task 2: Jawny kontrakt layout × capability (FDM-CPU-ARCH-001)

**Files:**
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields.rs:1180-1220,1320-1825`
- Modify: `crates/fullmag-engine/src/fdm/shared/problem.rs:470-520`
- Modify: `crates/fullmag-engine/src/fdm/cpu/state.rs:450-510`
- Create: `crates/fullmag-engine/tests/fdm_layout_capability.rs`

**Interfaces:**
- Consumes: active interactions, material fields and frozen-spin mask.
- Produces: `FdmCpuLayout` plus a capability receipt stating supported layout, interactions, ownership and fallback reason; unsupported SoA combinations fail before stepping.

- [ ] **Step 1: Add red parity/selection tests.** Assert that exchange/demag/Zeeman/DMI/thermal/STT/SOT with homogeneous and spatial fields select the same supported layout, while frozen spins return an explicit AoS receipt rather than silently changing inside the step.
- [ ] **Step 2: Run `cargo test -p fullmag-engine fdm_layout_capability -- --exact` and verify the receipt/type is missing.**
- [ ] **Step 3: Implement `FdmCpuLayout` and `FdmCpuCapabilityReceipt`.** Derive them once in problem construction; `soa_fast_path_supported` becomes a projection of that receipt, not a second policy.
- [ ] **Step 4: Add AoS–SoA RHS/field/trajectory tests.** Use identical `ExchangeLlgProblem`, material fields and frozen mask; compare fields and accepted states with `1e-12` relative tolerance for all supported interactions.
- [ ] **Step 5: Verify `cargo test -p fullmag-engine fdm_layout_capability` and `cargo test -p fullmag-engine fdm -- --nocapture`.**
- [ ] **Step 6: Commit `feat: expose fdm cpu layout capability receipt`.

### Task 3: Projekcja, ABM3 i accepted-step RNG (FDM-CPU-NUM-002/003, TRX-001)

**Files:**
- Modify: `crates/fullmag-engine/src/fdm/cpu/integrators.rs:1900-2060`
- Modify: `crates/fullmag-engine/src/fdm/cpu/state.rs:270-350`
- Modify: `crates/fullmag-engine/src/fdm/shared/problem.rs:500-540`
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields.rs:3860-3950`
- Create: `crates/fullmag-engine/tests/fdm_projection_and_rng.rs`

**Interfaces:**
- Consumes: tableau stage states, `ProjectionPolicy`, thermal step counter and `AbmHistory`.
- Produces: explicit projection realization ID, reset-before-predictor ABM3 history and exactly one thermal RNG increment per accepted public step.

- [ ] **Step 1: Write red tests for projection order and ABM history.** Compare projected/unprojected step-doubling macrospin order; change `dt` by `1.01×` and `2×` and assert history is empty before the predictor.
- [ ] **Step 2: Write red transaction tests.** Inject an error before final observables and after RHS; assert the counter, state digest, history and time are unchanged. A successful step increments the counter exactly once.
- [ ] **Step 3: Run `cargo test -p fullmag-engine fdm_projection_and_rng`; record the failing assertions.**
- [ ] **Step 4: Add `ProjectionPolicy`/realization metadata to dynamics state and move `advance_thermal_step()` into the accepted branch of `step_with_buffers_evaluation` and `step_soa_with_buffers_evaluation`.** Coupled ARS commit paths must call the same accepted-step hook only once.
- [ ] **Step 5: Reset ABM history before predictor when `dt` is not equal to the stored fixed step; remove the post-predictor reset.
- [ ] **Step 6: Run focused tests plus `cargo test -p fullmag-engine fdm -- --nocapture`; compare macrospin convergence output.
- [ ] **Step 7: Commit `fix: make fdm cpu history and thermal rng transactional`.

### Task 4: Evaluation schedule and allocation regression (FDM-CPU-PERF-001/002/003)

**Files:**
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs:780-820,1360-1390,1460-1480,2010-2040`
- Modify: `crates/fullmag-engine/src/fdm/shared/problem.rs:480-490`
- Modify: `crates/fullmag-engine/src/fdm/cpu/integrators.rs:1450-1510`
- Modify: `crates/fullmag-engine/src/fdm/cpu/fft.rs`
- Modify: `crates/fullmag-engine/src/fdm/cpu/fft_backend.rs`
- Create: `crates/fullmag-runner/tests/fdm_cpu_evaluation_schedule.rs`

**Interfaces:**
- Consumes: output/stop schedule and `EvaluationRequest`.
- Produces: minimal per-step evaluation by default, no steady-state O(N) clones after warm-up, and measured FFT backend/cache identity.

- [ ] **Step 1: Add red counters for Full vs Minimal.** A demag case with no output must assert only the requested field/reduction calls; an output-stride case must assert full evaluation only on the stride.
- [ ] **Step 2: Add a counting allocator test around ten warmed-up steps.** Assert zero state clone/to_vec allocation in the hot loop and distinguish output allocations from rollback storage.
- [ ] **Step 3: Run `cargo test -p fullmag-runner fdm_cpu_evaluation_schedule`; verify current public runner fails by using `EvaluationRequest::Full` and cloning state.
- [ ] **Step 4: Pass a schedule-derived `EvaluationRequest` from the runner and replace FSAL `to_vec`/previous-state clones with preallocated buffers or a bounded transaction view.
- [ ] **Step 5: Keep `FdmFftBackend` persistent, add explicit cache key (grid/PBC/kernel/threads), and add direct-vs-FFT parity tests. Do not claim FFTW/MKL/R2C support without implementation and benchmark.
- [ ] **Step 6: Run focused Rust tests, `cargo test -p fullmag-runner fdm_cpu_evaluation_schedule`, and the CPU benchmark smoke with allocation counters.
- [ ] **Step 7: Commit `perf: bound fdm cpu evaluation and retry allocations`.

### Task 5: DMI boundary and local thermal material fields (FDM-CPU-PHY-001/002)

**Files:**
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields.rs:1320-1465,1880-1980,2010-2050`
- Modify: `docs/physics/0440-fdm-interfacial-dmi.md`
- Modify: `docs/physics/0460-fdm-bulk-dmi.md`
- Modify: `docs/physics/0406-thermal-noise.md`
- Create: `crates/fullmag-engine/tests/fdm_boundary_material_parity.rs`

**Interfaces:**
- Consumes: active-cell mask, region-local `Ms`/`alpha`, DMI constants and boundary policy.
- Produces: natural ghost closure for inactive neighbors and local thermal amplitude with inactive/`Ms=0` zero contribution.

- [ ] **Step 1: Write red one-dimensional boundary-twist tests for interfacial and bulk DMI, both signs of `D`, masked geometry and PBC.
- [ ] **Step 2: Write red two-region thermal variance tests with different `Ms`/`alpha`, plus deterministic restart and inactive-cell cases.
- [ ] **Step 3: Run `cargo test -p fullmag-engine fdm_boundary_material_parity`; record central-spin and scalar-material failures.
- [ ] **Step 4: Implement the documented natural ghost closure in AoS and SoA and route thermal sigma through `ms_field`/`alpha_field` at each cell.
- [ ] **Step 5: Compare AoS/SoA and CPU reference energy derivative/trajectory at `1e-11` relative tolerance; update physics notes/source-map with exact realization limits.
- [ ] **Step 6: Commit `fix: honor fdm cpu dmi boundaries and local thermal fields`.

### Task 6: Public benchmark and FDM CPU qualification (FDM-CPU-QUAL-001)

**Files:**
- Modify: `crates/fullmag-bench/src/main.rs:1-500`
- Create: `crates/fullmag-bench/tests/public_plan_benchmark.rs`
- Modify: `justfile`
- Create: `scripts/validate_fdm_cpu_qualification.py`

**Interfaces:**
- Consumes: public requested problem/plan and FDM CPU runner.
- Produces: manifest-driven JSON with requested/resolved/executed plan, integrator, outputs, counters, stop reason and time-to-accuracy.

- [ ] **Step 1: Write red manifest tests requiring all supported integrators, dynamic sources, output schedules and provenance.
- [ ] **Step 2: Run the benchmark tests and verify direct `ExchangeLlgProblem` construction is rejected by the fixture.
- [ ] **Step 3: Implement the public-plan adapter and emit immutable JSON with source hash, command, tolerances and artifact hashes.
- [ ] **Step 4: Add `just verify-fdm-cpu-audit-qualification` with hard timeout and explicit non-convergence failure.
- [ ] **Step 5: Run `cargo test -p fullmag-bench public_plan_benchmark`, Python validator tests and the small CPU matrix; leave unexecuted scopes unvalidated.
- [ ] **Step 6: Commit `test: qualify fdm cpu through public plans`.

### Task 7: Lane review

**Files:** Review all FDM CPU changes and `docs/physics/0970-fdm-remediation-physical-contract.md`.

- [ ] Run `cargo test -p fullmag-engine fdm -- --nocapture`, `cargo test -p fullmag-runner fdm_cpu`, benchmark validator, `just verify-fdm-time-domain-native-contract` and `git diff --check`.
- [ ] Confirm each FDM CPU finding has direct source/test evidence; no runtime claim may rely only on unit tests.
- [ ] Commit the review fixes as one explicitly scoped commit and hand receipts to the common qualification plan.
