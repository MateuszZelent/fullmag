# FEM GPU Solver Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Domknąć FEM GPU strict-device correctness/performance contracts bez udawania, że istniejąca ścieżka hybrid jest strict GPU, oraz zbudować source-bound qualification.

**Architecture:** `NativeFemGpuRkPlanInfo` i runtime contract opisują per-operator lokalizację, precyzję, rewizję i transfery. Strict plan odrzuca host solver/hot-loop; hybrid Poisson jest jawnie osobnym trybem. RK decision, statistics, FSAL i rollback pozostają na urządzeniu poza dozwolonymi, zaksięgowanymi scalar controls.

**Tech Stack:** C++17/CUDA, MFEM/Hypre device backend, Rust planner/runner, managed `just`, native contract tests, Nsight/Compute Sanitizer.

## Global Constraints

- Zawsze `just ensure-managed-fem-runtime` przed natywnym build/runtime; host build jest tylko diagnostyczny.
- Strict GPU jest fail-closed dla FP32, host preconditioner/operator apply, PBC/DG0/DMI/thermal i innych niezakwalifikowanych combinations.
- Nie deklarować matrix-free, CUDA Graph, mixed precision ani TPI GPU bez implementacji i receiptów.
- Każdy receipt musi być związany z aktualnym source hash, urządzeniem i planem.
- Nie kopiować derived full-vector fields w rollback, jeśli można odtworzyć je z authoritative state.

---

### Task 1: Per-operator strict residency receipt (FEM-GPU-ARCH-001, PERF-001, PERF-009)

**Files:**
- Modify: `crates/fullmag-runner/src/fem/runtime_contract.rs:109-265`
- Modify: `crates/fullmag-runner/src/fem/native_fem.rs`
- Modify: `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp`
- Modify: `backends/fem/gpu/cuda/state/gpu_state.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk_step_preflight.cu`
- Modify: `backends/fem/gpu/cuda/interactions/rk_demag_dispatch.cu`
- Modify: `backends/fem/gpu/cuda/runtime/rk_plan.cpp`
- Modify: `backends/fem/tests/gpu_rk_plan.cpp`, `transfer_audit.cpp`
- Create: `backends/fem/tests/gpu_operator_residency_receipt_contract.cpp`

**Interfaces:**
- Consumes: requested strict/hybrid mode, operator plan, HYPRE/preconditioner location and transfer counters.
- Produces: `FemGpuOperatorReceipt { operator_id, location, precision, revision, host_apply_count, h2d_bytes, d2h_bytes, sync_count }` and typed strict rejection.

- [ ] **Step 1: Write red strict test.** A `device_hypre_poisson` plan with host operator/preconditioner apply must fail closed; explicit hybrid must pass only with `host_roundtrip` receipt.
- [ ] **Step 2: Run `just verify-fem-time-domain-native-contract` and native GPU plan contracts; capture missing per-operator receipt.
- [ ] **Step 3: Add receipt structures to `NativeFemGpuRkPlanInfo` and populate them after preflight; strict validates every operator before first stage.
- [ ] **Step 4: Instrument full-vector transfer and host compute counters; ensure `rk_demag_dispatch.cu` selects hybrid only under explicit compatibility mode.
- [ ] **Step 5: Run strict/hybrid managed CPU/GPU scenarios and `just verify-fem-gpu-performance-regression`; commit `fix: enforce fem gpu operator residency`.

### Task 2: Precision and projected adaptive error policy (FEM-GPU-NUM-001/003)

**Files:**
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp:100-210`
- Modify: `backends/fem/gpu/cuda/state/runtime_coefficients_upload.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_error_norm_runtime.cu:37-118`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk23_stage_sequence.cu:57-100`
- Modify: `crates/fullmag-plan/src/fem.rs:3180-3210`
- Modify: `backends/fem/tests/gpu_state_runtime_contract.cpp`, `rk_explicit_contract.cpp`
- Create: `backends/fem/gpu/cuda/integrators/rk/rk_precision_policy.hpp`
- Create: `backends/fem/tests/gpu_projected_error_policy_contract.cpp`

**Interfaces:**
- Consumes: storage/operator/solver/reduction precision, active mass/mask and projected/unprojected candidate.
- Produces: versioned `FemGpuPrecisionPolicy` and `candidate_unprojected/projected` error receipt with CPU decision parity.

- [ ] **Step 1: Write red tests.** Independent FP32 storage/operator/reduction fields must be rejected without policy; synthetic large defect must distinguish projected and unprojected candidates; CPU/GPU accept/reject/`dt_next` must match.
- [ ] **Step 2: Run focused native tests and `just verify-fem-time-domain-native-contract`; record current scalar precision/ambiguous stage behavior.
- [ ] **Step 3: Add policy to planner/runtime/provenance; keep public strict lane FP64-only until a separate mixed policy passes.
- [ ] **Step 4: Make RK error kernel consume the declared candidate and active mass denominator; normalize stage only according to the declared realization.
- [ ] **Step 5: Run managed adaptive CPU/GPU parity with frozen/PBC and NaN/dt_min/max-reject cases; commit `fix: make fem gpu precision and error policy explicit`.

### Task 3: Device adaptive control and final statistics (FEM-GPU-PERF-004/006/008)

**Files:**
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_adaptive_decision_readback.cu:15-39`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_scalar_readback.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_stats.cu:463-488`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_energy_reductions.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_observable_reductions.cu`
- Modify: `crates/fullmag-runner/src/quantities.rs`
- Modify: `backends/fem/tests/source_facade_gpu_rk_contract.cpp`
- Create: `backends/fem/gpu/cuda/integrators/rk/rk_observation_mask.cu`

**Interfaces:**
- Consumes: device error/accept state, stop-required scalar policy and observation mask/stride.
- Produces: device-side `dt_next`/reason without per-attempt stream synchronization, and final stats only for requested reductions.

- [ ] **Step 1: Write red tests.** Rejected adaptive attempt must have zero `cudaStreamSynchronize`; `stats-none` must launch no display reductions; observation mask must not reduce inactive quantities while preserving stop scalar correctness.
- [ ] **Step 2: Run `just verify-fem-gpu-performance-regression` and `just capture-fem-gpu-nsight`; preserve baseline trace.
- [ ] **Step 3: Implement device decision buffer and one explicit control readback boundary; record scalar bytes/syncs in receipt.
- [ ] **Step 4: Thread `QuantityRequirements`/mask through final stats and reductions; do not infer requested output from a full status refresh.
- [ ] **Step 5: Run managed adaptive retry/mask scenarios and verify CPU/GPU stop reason; commit `perf: bound fem gpu adaptive and observation reductions`.

### Task 4: FSAL endpoint and persistent preconditioner lifecycle (FEM-GPU-PERF-002/005/007)

**Files:**
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_final_refresh.cu:63-126`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_fsal_policy.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp:49-210`
- Modify: `backends/fem/gpu/cuda/exchange/exchange_plan.cpp:50-80`
- Modify: `crates/fullmag-runner/src/fem/runtime_contract.rs:240-270`
- Modify: `backends/fem/tests/cuda_demag_timing_contract.cpp`, `gpu_rk_plan.cpp`, `demag_poisson_contract.cpp`
- Create: `backends/fem/gpu/cuda/runtime/operator_dependency_key.hpp`

**Interfaces:**
- Consumes: tableau, source/time/transport revisions and operator/preconditioner dependency key.
- Produces: tableau-correct RHS/Poisson counts, revisioned FSAL endpoint validity and persistent device preconditioner receipt.

- [ ] **Step 1: Write red tests.** Deterministic RK23 must not perform redundant final endpoint RHS when FSAL is valid; source/time/thermal changes invalidate it. Warm-up second step must not increase setup/allocation; a single key change rebuilds once.
- [ ] **Step 2: Run native contracts and managed performance regression to capture current `+1` RHS/readback/setup behavior.
- [ ] **Step 3: Implement `EndpointCacheValidity` and skip only the redundant endpoint refresh; requested final observables still require a fresh field.
- [ ] **Step 4: Add operator/preconditioner descriptor with location, precision, revision, reuse and rebuild reason; keep HYPRE setup persistent.
- [ ] **Step 5: Run `just verify-fem-gpu-relaxation-preconditioner-qualification`, RHS count tests and strict managed run; commit `fix: reuse fem gpu endpoint and preconditioners`.

### Task 5: Matrix-free/partial assembly policy and CUDA Graph decision (FEM-GPU-PERF-003/010)

**Files:**
- Modify: `backends/fem/gpu/cuda/exchange/exchange_plan.cpp:50-80`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_preflight.cu:70-85`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Create: `backends/fem/tests/fem_gpu_cuda_graph_contract.cpp`
- Create: `backends/fem/gpu/cuda/integrators/rk/rk_graph_schedule.cu` only if the baseline profile proves a benefit

**Interfaces:**
- Consumes: requested operator mode and fixed-topology stage schedule.
- Produces: fail-closed planner mode until matrix-free/partial assembly exists; optional graph capture/replay with revision invalidation.

- [ ] **Step 1: Write red planner tests.** `partial_assembly_gpu` and `matrix_free_gpu` requests fail with a typed unsupported capability while only `legacy_sparse_gpu` is exposed.
- [ ] **Step 2: Run planner/native contracts; do not add graph code yet.
- [ ] **Step 3: Capture managed Nsight baseline. If launch overhead is not dominant, record `NOT VERIFIED` and close only the source-plan gap; otherwise add graph-disabled/enabled parity test with one recapture per revision.
- [ ] **Step 4: For a real matrix-free implementation, add operator/energy parity and memory/throughput sweep before exposing planner capability.
- [ ] **Step 5: Commit `docs: make fem gpu operator mode and graph evidence explicit` or the narrowly scoped implementation commit.

### Task 6: Transaction footprint and material/PBC parity (FEM-GPU-TRX-001, PHY-001, NUM-002)

**Files:**
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_transaction_device.cu:140-342`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_workspace_state.hpp`
- Modify: `backends/fem/gpu/cuda/state/gpu_state_runtime.cpp:70-130`
- Modify: DMI/thermal/exchange/PBC CUDA interaction modules
- Modify: `backends/fem/tests/rk_transaction_fault_injection_contract.cpp`, `dmi_contract.cpp`, `thermal_brown_contract.cpp`, `cuda_periodic_exchange_contract.cpp`, `cuda_periodic_demag_contract.cpp`
- Create: `backends/fem/tests/fem_gpu_material_parity_contract.cpp`

**Interfaces:**
- Consumes: authoritative device magnetization, minimal FSAL/control state, material membership, Airbox/PBC masks.
- Produces: transaction byte/VRAM receipt and strict per-interaction CPU/GPU field/RHS/stage/trajectory parity; tangent-plane GPU remains rejected until implemented.

- [ ] **Step 1: Write red fault-injection tests.** Successful step must not copy all 13 derived fields/Poisson solutions; every failure point restores digest and does not publish stale H.
- [ ] **Step 2: Write red sharp two-tet, Airbox, PBC, DMI boundary and thermal restart tests; unsupported combinations must fail closed. Forced GPU `TangentPlaneImplicit` must never call CPU.
- [ ] **Step 3: Run native contracts and `just verify-fem-mixed-prism-airbox-runtime`; record current gaps.
- [ ] **Step 4: Replace derived-field transaction copies with authoritative m + minimal journal/double buffer; rebuild derived state on retry from revisions.
- [ ] **Step 5: Complete supported device material uploads and per-operator strict checks; keep DMI/STT/DG0/thermal/PBC unqualified where implementation is absent.
- [ ] **Step 6: Run managed CPU/GPU field/RHS/stage/trajectory parity and commit `fix: make fem gpu transactions and material parity explicit`.

### Task 7: FEM GPU qualification and hardware evidence (FEM-GPU-QUAL-001)

**Files:**
- Modify: `justfile`
- Create: `scripts/validate_fem_gpu_qualification.py`
- Create: `scripts/test_validate_fem_gpu_qualification.py`
- Modify: `.github/workflows/bootstrap.yml`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `scripts/compare_fem_llg_time_domain_qualification.py`

**Interfaces:**
- Consumes: strict/hybrid receipts, sanitizer/Nsight, FP64 parity, interaction matrix, transaction/perf receipts.
- Produces: immutable FEM GPU qualification manifest; capability rows remain `implemented/unvalidated` until all required evidence exists.

- [ ] **Step 1: Write red validator fixtures for missing device identity, source hash, strict residency, sanitizer, leak delta, parity scope and wrong precision.
- [ ] **Step 2: Run validator tests and verify fail-closed output.
- [ ] **Step 3: Add managed recipes for strict public qualification, Compute Sanitizer, long-run VRAM and Nsight capture; make CI consume the receipt rather than a hand-edited matrix.
- [ ] **Step 4: Execute FP64 strict matrix on actual hardware; run hybrid separately with explicit roundtrip/break-even receipt; leave absent lanes unvalidated.
- [ ] **Step 5: Update capability matrix/docs only for passing scopes and commit `test: add source-bound fem gpu qualification matrix`.

### Task 8: Lane review

- [ ] Run `just ensure-managed-fem-runtime`, source/native contracts, strict/hybrid managed runs, performance regression, Nsight and sanitizer.
- [ ] Check no plan claims CUDA Graph/TPI/mixed precision/matrix-free as implemented without evidence.
- [ ] Map every FEM GPU finding to current source, test and receipt.
