# Task 7 report: FDM CPU/CUDA fixed-adaptive parity

## Outcome

Task 7 separates fixed RK23/RK45 execution from adaptive embedded-error
execution in the FDM CPU reference and native CUDA implementations. Fixed
execution now consumes the exact requested step and emits no adaptive
suggestion. Adaptive attempts with normalized error above one at `dt_min`
terminate as `dt_min_exhausted` instead of being force-accepted. The native
single-grid FDM ABI has a versioned v2 descriptor/symbol that transports the
complete authored adaptive policy without changing the legacy layout.

This work does **not** qualify CUDA trajectories or FP32 physics. The managed
gate proves CUDA compilation of the FP64/FP32 RK23/RK45 translation units and
the ABI/controller behavior contract; it does not execute a trajectory-parity
qualification on GPU hardware.

## RED/GREEN evidence

### Fixed and adaptive CPU AoS/SoA

- RED: `fixed_rk23_rk45_aos_and_soa_use_exact_dt_without_adaptive_suggestion`
  observed an adaptive suggestion for a fixed RK step (`left: 1e-10`,
  `right: 0.002`).
- RED: `adaptive_rk23_rk45_aos_and_soa_fail_dt_min_exhausted_without_state_commit`
  received an accepted `StepReport` at the exhausted floor.
- GREEN: both tests pass for RK23 and RK45, AoS and SoA. Fixed mode asserts
  exact `dt_used`, exact time advance, and `suggested_next_dt == None`.
  Adaptive mode asserts typed floor failure and unchanged time/magnetization.
- The production runner construction test
  `fdm::cpu::reference::tests::reference_construction_preserves_fixed_vs_adaptive_embedded_rk_policy`
  proves that a real `FdmPlanIR` constructs the intended fixed/adaptive engine
  policy and preserves rollback at the adaptive floor.

### CUDA policy, ABI, and batching

- RED: `llg_time_policy_contract.cpp` initially failed at
  `v2 header preserves every adaptive field` because no v2 single-grid policy
  descriptor/symbol existed.
- GREEN: `fullmag_fdm_plan_desc_v2` and
  `fullmag_fdm_backend_create_time_policy_v2` carry tolerance mode, `atol`,
  `rtol`, `dt_min`, `dt_max`, safety, growth/shrink limits, and optional norm
  and rotation guard intent through C header, Rust FFI, C API, and native
  `Context`. Guard-enabled policies fail closed until Task 8 enforcement.
- Adaptive v2 accepts only RK23/RK45. Maximum-error mode requires `rtol=0`;
  advanced mode permits absolute-only, relative-only, or combined control and
  requires at least one of `atol` and `rtol` to be positive.
- RED: `cuda_batch_consumes_accepted_dt_suggested_only_for_adaptive_policy`
  documented the immutable initial-step bug.
- GREEN: the production CUDA loop in `crates/fullmag-runner/src/dispatch.rs`
  consumes accepted adaptive `dt_suggested` as the next attempted step; fixed
  execution keeps its original exact step. A final review caught and removed
  an earlier connection to an inactive duplicate execution source before
  approval.
- Native FP64 and FP32 RK23/RK45 sources have an explicit fixed branch before
  embedded-error control and report `dt_min_exhausted` without committing the
  rejected candidate. Rejected attempts restore magnetization and the
  base-state FSAL derivative before retry or terminal return. The managed CUDA
  build compiled all four translation units.
- FEM and FDM native execution consume one backend-neutral controller under
  `native/include`. FDM CPU matches the same q=2/q=4 immutable vectors and
  accepted-error PI history. FP64 ratio budget is `2e-15`; FP32-rounded budget
  is `8e-6`; the native FDM behavior contract exercises both budgets
  separately. Zero-error growth is bounded by `growth_limit`.

### Multilayer fail-closed behavior

- Planner test
  `staged_multilayer_rejects_adaptive_rk23_convenience_and_advanced` covers
  both `max_error` convenience and advanced tolerance modes.
- Runner entry points retain the shared pre-materialization guard; its error
  now explicitly states that adaptive multilayer execution is unsupported and
  that `fixed_timestep` is required before native materialization.
- Explicit single-grid adaptive FDM requires `device=cpu|cuda|gpu`; omitted or
  `auto` device intent fails closed. No hidden device fallback was added.

## ABI compatibility

- Legacy `fullmag_fdm_backend_create` and its descriptor layout are retained.
- Legacy embedded-RK callers retain their historical proportional controller,
  including no ratio clamp beyond `dt_min`/`dt_max`.
- New callers use `fullmag_fdm_backend_create_time_policy_v2`; fixed policy
  sets `adaptive_enabled=0`, and adaptive policy validates every transported
  field before overriding the legacy compatibility defaults.
- Invalid v2 policy follows the established deferred-create convention: C API
  returns a handle carrying `last_error`; the runner reads that error
  immediately, destroys the handle, and returns `RunError` before constructing
  the backend or attempting a step. The managed source contract asserts this
  complete fail-closed chain with a live native handle.
- The same live v2 behavior contract creates and destroys valid advanced
  handles for both `atol>0, rtol=0` and `atol=0, rtol>0`; the both-zero case
  remains invalid.
- `FULLMAG_FDM_ERR_DT_MIN_EXHAUSTED = -5` is the typed terminal native return.

## Verification

Authoritative managed native gate:

```text
env COMPOSE_PROJECT_NAME=fullmag-llg-time-domain-remediation \
  just verify-fdm-time-domain-native-contract
CPU-only FDM LLG time-policy ABI/source contract: PASS
CUDA enabled: 12.4.131
Built target fullmag_fdm
Built target fdm_llg_time_policy_contract
FDM LLG time-policy ABI/source contract: PASS
```

The `COMPOSE_PROJECT_NAME` override reused an existing local Compose network
after Docker reported exhausted predefined subnet pools. The checked-in
recipe remains generic and environment-independent.

Rust gates:

```text
cargo test -p fullmag-engine --lib     # 200 passed
cargo test -p fullmag-plan --lib       # 230 passed
cargo test -p fullmag-runner --lib     # 561 passed
cargo test -p fullmag-fdm-sys          # 1 passed
FULLMAG_FDM_LIB_DIR=native/build/backends/fdm \
  cargo check -p fullmag-runner --features cuda # passed
```

The first post-cleanup runner link attempt ended with a transient host linker
`Bus error`; the subsequent full runner gate linked and passed all 561 tests.
After configuring `FULLMAG_FDM_LIB_DIR` to the managed native build output, an
additional host `cargo check -p fullmag-runner --features cuda` passed. This
proved that the production Rust CUDA dispatch path, including consumption of
the accepted adaptive `dt_suggested`, is type-checked with the CUDA feature.

Because Task 6's controller was moved to the backend-neutral native owner, the
managed FEM time-domain contract gate was also rebuilt and passed. Its first
120-second invocation timed out during compilation at about 44%; the
incremental 300-second rerun completed and ran every FEM time-domain contract.

## Capability and documentation outcome

- FDM CPU double fixed/adaptive remains `reference_executable`, executable,
  and scientifically `unvalidated`; focused behavioral contracts now pass.
- FDM CUDA double/single fixed remains production-executable but
  scientifically unvalidated.
- FDM CUDA double/single adaptive remains source-visible/executable and
  unvalidated. The managed gate proves v2 ABI and CUDA compilation only.
- FP32 remains separate from FP64 and receives no qualification promotion.
- Note 0960 and the capability overlay record these exact evidence limits.

## Honest residual limits

1. Optional norm and spin-rotation guard intent is preserved across the v2
   ABI, but guard-enabled execution is rejected until Task 8 enforcement.
2. No CUDA trajectory, energy-descent, CPU/CUDA parity, or physical-order
   qualification was executed on GPU hardware.
3. The fixed persistent-SoA reference path delegates through the established
   AoS conversion boundary for correctness; removing that allocation is a
   performance follow-up, not a semantics blocker.
4. The floor-failure rollback claim is limited to accepted magnetization,
   time, and FSAL state. CUDA terminal failure restores the exact pre-attempt
   FSAL validity, including preserving an initially invalid cache as invalid.
   Candidate H/work/demag caches remain Task 10 debt.
5. Scientific relaxation-to-run energy descent and full attempt trace replay
   remain later qualification gates.
