# FDM GPU Solver Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zamknąć findingi FDM CUDA przez zgodny ABI, strict device execution, jawne policy precyzji, poprawne FSAL/rollback oraz source-bound qualification.

**Architecture:** C ABI jest jedynym właścicielem layoutu plan descriptor, a Rust FFI wykonuje pełne mapowanie i waliduje wersję/rozmiar. CUDA runtime publikuje operator/device receipts; strict GPU nie może użyć CPU fallbacku. CPU FDM `double` jest oracle pól, RHS, decyzji i trajektorii, a FP32 ma osobny status.

**Tech Stack:** C++17/CUDA, CMake managed runtime, `fullmag-fdm-sys`, `fullmag-runner`, CUDA tests, Compute Sanitizer and Nsight.

## Global Constraints

- Native CUDA build/runtime używa recept `justfile`; hostowe `cargo`/CMake są tylko diagnostyką.
- Forced GPU kończy się błędem przed wykonaniem, jeśli capability lub rezydencja nie są spełnione.
- Nie wolno traktować `region_owned_abi_contract.cpp` jako dowodu runtime bez sentinel/layout testu.
- FP32 nie dziedziczy qualification FP64; każda precyzja ma osobny receipt i tolerancje.
- Żaden accepted field, RNG, FSAL ani checkpoint nie może zostać opublikowany po reject/error.

---

### Task 1: Wersjonowany pełny ABI planu (FDM-GPU-ABI-001)

**Files:**
- Modify: `native/include/fullmag_fdm.h:267-494`
- Modify: `crates/fullmag-fdm-sys/src/lib.rs:281-328`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs:430-520`
- Modify: `backends/fdm/api/c_api.cpp:600-680`
- Modify: `backends/fdm/tests/region_owned_abi_contract.cpp`
- Create: `crates/fullmag-fdm-sys/tests/plan_desc_layout.rs`
- Create: `backends/fdm/tests/plan_desc_sentinel_contract.cpp`

**Interfaces:**
- Consumes: `fullmag_fdm_plan_desc_v2` fields from the public C header.
- Produces: `abi_version`, `struct_size`, complete `offset_of!`/`static_assert` parity, and a descriptor rejection for unknown versions/sizes.

- [ ] **Step 1: Write the red Rust layout test.** Assert exact offsets and `size_of::<fullmag_fdm_plan_desc>()`, including `ms_field`, `a_field`, `alpha_field`, DMI, masks and source descriptors:

```rust
#[test]
fn plan_descriptor_has_versioned_complete_layout() {
    assert_eq!(std::mem::offset_of!(fullmag_fdm_plan_desc, abi_version), 0);
    assert!(std::mem::size_of::<fullmag_fdm_plan_desc>() >= EXPECTED_V2_SIZE);
}
```

- [ ] **Step 2: Write the red C sentinel test.** Fill every pointer/scalar with distinct non-zero sentinel values, call the API constructor, and assert the backend receives the same values; unknown `(abi_version, struct_size)` must return the typed ABI error before allocation.
- [ ] **Step 3: Run `cargo test -p fullmag-fdm-sys --test plan_desc_layout` and the managed C contract target; record missing fields/failure.**
- [ ] **Step 4: Add the version/size fields to the canonical C struct and mirror them in Rust with `#[repr(C)]`; populate every field in `NativeFdmBackend::create`, never rely on zeroed defaults.
- [ ] **Step 5: Make `fullmag_fdm_backend_create` reject incompatible versions/sizes and expose the resolved field receipt; keep ABI compatibility only for explicitly supported older versions.
- [ ] **Step 6: Run `cargo test -p fullmag-fdm-sys`, C sentinel/layout tests and `cargo check -p fullmag-runner --features cuda`; add `just verify-fdm-gpu-abi-contract`.
- [ ] **Step 7: Commit `fix: complete fdm cuda plan descriptor abi`.

### Task 2: Strict execution and device residency (FDM-GPU-ARCH-001)

**Files:**
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native/device.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/route.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `backends/fdm/api/c_api.cpp`
- Create: `backends/fdm/tests/device_residency_receipt_contract.cpp`
- Create: `crates/fullmag-runner/src/fdm/gpu/cuda/native/residency.rs`

**Interfaces:**
- Consumes: requested execution mode and C API capability/device receipt.
- Produces: `FdmGpuExecutionReceipt { requested, resolved, executed, device, precision, operator_residency, fallback_count, transfer_counts }`.

- [ ] **Step 1: Add red forced-GPU tests.** An unavailable CUDA capability and a CPU-instrumented route must fail before a CPU call; auto mode may fallback only with `fallback_reason`.
- [ ] **Step 2: Run the focused runner tests and native C contract; capture current silent/missing receipt behavior.**
- [ ] **Step 3: Implement receipt construction at backend creation and final artifact serialization; strict preflight compares requested capabilities with receipt and rejects mismatch.
- [ ] **Step 4: Add a managed native fixture counting full-vector H2D/D2H and host compute in the hot loop; zero is required for strict device mode (scalar control bytes are separately counted).
- [ ] **Step 5: Add `just verify-fdm-gpu-strict-residency`, run it on managed CUDA, and retain the receipt even when the runtime is unavailable as `unvalidated` evidence.
- [ ] **Step 6: Commit `feat: make fdm gpu execution residency explicit`.

### Task 3: Adaptive norm, precision policy and heterogeneous physics (FDM-GPU-NUM-001/002, PHY-001)

**Files:**
- Modify: `backends/fdm/gpu/cuda/integrators/llg_rk23_fp32.cu`
- Modify: `backends/fdm/gpu/cuda/integrators/llg_dp45_fp32.cu`
- Modify: FP64 RK23/DP45 counterparts and `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`
- Modify: `native/include/fullmag_fdm.h`, `crates/fullmag-plan/src/fdm.rs`
- Modify: `backends/fdm/include/context.hpp`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs`
- Modify: `backends/fdm/gpu/cuda/interactions/demag_fp64.cu`, `energy_density_fp64.cu`
- Create: `backends/fdm/tests/adaptive_error_reduction_contract.cpp`
- Create: `backends/fdm/tests/heterogeneous_material_cuda_contract.cpp`

**Interfaces:**
- Consumes: active/frozen mask, storage/compute/FFT/reduction precision policy and spatial `Ms/A/alpha/Dind/Dbulk` fields.
- Produces: active-domain error norm, explicit precision rejection/receipt, and CPU↔CUDA FP64 field/energy/directional-derivative parity.

- [ ] **Step 1: Write red tests.** Embedded error from frozen/inactive cells must not influence `dt`; zero active cells must fail closed. A descriptor with independent FP32 storage and FP64 reduction must serialize all policy fields. Heterogeneous material sentinels must alter CUDA field/energy; unsupported fields must reject in planner.
- [ ] **Step 2: Run `just verify-fdm-gpu-adaptive-norm-runtime` (new) and focused C++ tests to demonstrate failure.**
- [ ] **Step 3: Implement mask-weighted reduction and zero-active guard; use the same active denominator as CPU oracle.
- [ ] **Step 4: Add `FdmGpuPrecisionPolicy` to plan/receipt; keep unsupported mixed cases fail-closed and separate FP32 tolerances.
- [ ] **Step 5: Complete ABI field upload and route spatial material fields to CUDA interactions, including DMI/bulk-DMI boundary rules; do not silently substitute scalar values.
- [ ] **Step 6: Run FP64 CPU↔CUDA field/RHS/energy/trajectory parity first, then separate FP32 envelope; update capability only for passing scopes.
- [ ] **Step 7: Commit `fix: qualify fdm cuda adaptive and material semantics`.

### Task 4: Atomic transaction and FSAL invalidation (FDM-GPU-TRX-001, NUM-003)

**Files:**
- Modify: `backends/fdm/include/context.hpp`
- Modify: `backends/fdm/gpu/cuda/runtime/llg_checkpoint.cpp`
- Modify: `backends/fdm/gpu/cuda/transport/context.cu`
- Modify: RK23/DP45 FP32 and FP64 integrators
- Modify: `backends/fdm/tests/thermal_brown_contract.cpp`
- Modify: `backends/fdm/tests/gpu_m1_transport_llg_stage_v1_contract.cpp`
- Create: `backends/fdm/tests/fdm_gpu_transaction_fault_injection.cpp`

**Interfaces:**
- Consumes: accepted state, step/source/time revisions, checkpoint and thermal key.
- Produces: rollback digest equality, one thermal RNG increment per accepted public step, and `fsal_valid` only when all revisions match.

- [ ] **Step 1: Write red fault-injection tests after each RK stage.** Assert exact `m`, time, adaptive history, FSAL, thermal key and field revision after error; checkpoint/restart must equal uninterrupted trajectory.
- [ ] **Step 2: Write red FSAL tests.** Thermal temperature, waveform/source revision and rejected attempt must all force `fsal_reused=false`; deterministic no-source RK23/DP45 keeps FSAL.
- [ ] **Step 3: Run focused native tests and capture the current stale-FSAL/transaction mismatch.
- [ ] **Step 4: Add immutable `state_revision`, `source_revision`, `time_revision`, `material_revision` to `Context`; checkpoint them with accepted state.
- [ ] **Step 5: Move RNG key/step increment to the accepted commit epilogue; restore all authoritative buffers on rollback and invalidate derived fields.
- [ ] **Step 6: Gate FSAL reuse through one `fsal_revision_matches()` function before `compute_rhs_into`.
- [ ] **Step 7: Run managed CUDA transaction/thermal/restart gate and commit `fix: make fdm cuda retries and fsal transactional`.

### Task 5: Device-control and observation performance (FDM-GPU-PERF-001/002/004)

**Files:**
- Modify: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`
- Modify: `backends/fdm/include/context.hpp`, `backends/fdm/gpu/cuda/runtime/context.cu`
- Modify: `backends/fdm/api/c_api.cpp`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native/observables.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native/snapshots.rs`
- Create: `backends/fdm/tests/fdm_gpu_observation_schedule.cpp`

**Interfaces:**
- Consumes: output/stop/observation mask and persistent workspace revisions.
- Produces: device adaptive decisions without per-attempt host sync, no-output stats mode with zero expensive reductions, and persistent FFT/workspace allocation receipts.

- [ ] **Step 1: Write red tests for zero host control sync in adaptive device mode, zero display reductions for `stats-none`, and no allocation/FFT plan in warmed-up steps.
- [ ] **Step 2: Run current C++ contract and Nsight baseline; preserve the baseline before optimization.
- [ ] **Step 3: Implement device-side accept/reject reason and `dt_next`; host readback is allowed only for explicitly requested scalar control and is counted.
- [ ] **Step 4: Make public construction honor `StatsMode`/stride/observation mask rather than forcing `FULL/1`; keep stop-required scalars separate.
- [ ] **Step 5: Add workspace dependency key (grid/PBC/kernel/precision/mask), reuse plans and count rebuild reason/allocation.
- [ ] **Step 6: Run `just verify-fdm-gpu-adaptive-control-perf`, `just verify-fdm-gpu-observation-schedule-runtime`, managed warm-run and Nsight; do not claim PERF-003 until a profile identifies a launch bottleneck.
- [ ] **Step 7: Commit `perf: remove unnecessary fdm gpu control readbacks`.

### Task 6: GPU qualification (FDM-GPU-QUAL-001)

**Files:**
- Modify: `justfile`
- Create: `scripts/validate_fdm_gpu_qualification.py`
- Create: `scripts/test_validate_fdm_gpu_qualification.py`
- Modify: `.github/workflows/bootstrap.yml`
- Modify: `docs/specs/capability-matrix-v0.json`

**Interfaces:**
- Consumes: managed receipts from ABI, residency, parity, transaction, performance and sanitizer gates.
- Produces: immutable FDM GPU qualification matrix split by FP64/FP32, integrator, interaction, source and device.

- [ ] **Step 1: Write red validator fixtures for missing/stale source hash, wrong GPU/precision, absent sanitizer, fallback and incomplete interaction matrix.
- [ ] **Step 2: Run Python validator tests and confirm fail-closed status.
- [ ] **Step 3: Implement receipt schema/hash validation and add managed recipes `verify-fdm-gpu-public-qualification`, `verify-fdm-gpu-compute-sanitizer` and `benchmark-fdm-gpu-time-to-accuracy`.
- [ ] **Step 4: Run the actual matrix when CUDA is available; otherwise preserve exact blocker and leave rows unvalidated.
- [ ] **Step 5: Update capability rows only for scopes with current receipts; run `just verify-fdm-gpu-abi-contract` and `git diff --check`.
- [ ] **Step 6: Commit `test: add source-bound fdm gpu qualification`.

### Task 7: Lane review

- [ ] Review all FDM GPU findings against current code, not the audit plan; run ABI, C++ contract, Rust feature, managed runtime and sanitizer gates.
- [ ] Verify strict/auto/hybrid labels and fallback reasons in final artifacts.
- [ ] Commit scoped review fixes and hand receipts to the common qualification plan.
