# FEM GPU Performance Remediation Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in the isolated worktree. Use the existing performance package under `docs/performance/fem-gpu-performance-remediation-2026-09-01/` as the semantic specification. Do not commit, push, or modify the source checkout outside this worktree.

**Goal:** Zaimplementować potwierdzone korekty planu FEM GPU, zachowując fizykę,
strict residency, parytet CPU/GPU i dowodową separację source/contract/managed
runtime/scientific qualification.

**Architecture:** Każdy etap ma jednego właściciela w `backends/fem`: runtime
diagnostics, HYPRE demag, RK integrator, exchange, reductions i relaxation.
Rust pozostaje orkiestracją/provenance, a istniejący receipt i capability
contract są rozszerzane append-only. Wszystkie nowe warianty są fail-closed i
nie stają się publicznym `validated` profilem przed managed GPU A/B.

**Tech Stack:** C++17/CUDA, MFEM 4.9, HYPRE 3.1.0, CMake, C ABI v1 append-only,
Rust `fullmag-fem-sys`/runner, GoogleTest/CTest, Python contract tests, repo
`justfile` managed FEM recipes.

## Global Constraints

- Produkcyjna implementacja FEM pozostaje w `backends/fem`; nie dodawać fizyki do `Context`, `mfem_bridge.cpp` ani Rust runnera.
- Strict GPU odrzuca host/hybrid/unknown operator masks oraz bulk compute H2D/D2H; brak cichego CPU fallbacku.
- Nie zmieniać równań, znaków, jednostek, tolerancji, jakości meshu ani semantyki energii.
- Każdy nowy ABI jest wersjonowany i append-only; istniejące enumy/struktury są reuse’owane, nie duplikowane.
- Każda nowa funkcja dostaje test RED przed kodem produkcyjnym, test GREEN i statyczny/source contract.
- Runtime/build FEM używa najpierw `just rebuild-fem-runtime`, `just ensure-managed-fem-runtime` i właściwego managed targetu; hostowe buildy są tylko diagnostyczne.
- Każdy wynik wydajnościowy wymaga identycznego mesh/ProblemIR digest, source/runtime identity, GPU identity, warmupów, mediany i p95.
- `POTWIERDZONE` oznacza strukturę źródłową; `validated` wymaga odrębnego managed GPU receipt i walidacji naukowej.
- Nie usuwać ścieżki legacy/oracle do czasu kwalifikacji następcy.

## Source of truth and acceptance lanes

- Diagnozy i obecne symbole: `docs/performance/fem-gpu-performance-remediation-2026-09-01/fem-gpu-performance-remediation-2026-09-01/10-finding-coverage-matrix.md`.
- Runtime ownership: `backends/fem/gpu/cuda/runtime/`, `integrators/rk/`, `demag_poisson/`, `exchange/`, `relaxation/`.
- Native C ABI: `native/include/fullmag_fem.h`, `backends/fem/src/api.cpp`, `crates/fullmag-fem-sys/src/lib.rs`.
- Managed entrypoint: `just fem-sp4-run gpu <output_dir>` lub `just fem-managed-headless ...`; `fem-gpu-headless` jest diagnostyczny.
- Final gates: source contracts, managed runtime receipt, scientific parity i benchmark pełnego kroku są raportowane osobno.

---

### Task 0: Isolated baseline and evidence ledger

**Files:**
- Create: `.superpowers/sdd/progress.md`
- Modify: `docs/performance/fem-gpu-performance-remediation-2026-09-01/.../manifest.json` only when generated files change
- Test: `git status`, manifest/link/source-embedding checker

**Interfaces:**
- Consumes: `c3f49db708868f3649a3e894416d230269718920`, existing managed `justfile` targets.
- Produces: clean worktree baseline, immutable base SHA, and a ledger that records each task without committing.

- [ ] Step 1: Record `git rev-parse HEAD`, branch, worktree path, disk/process snapshot, and current source-contract status in `.superpowers/sdd/progress.md`.
- [ ] Step 2: Run `git diff --check`, the existing documentation manifest/link checker, and `just --list`; record exact exit codes.
- [ ] Step 3: Run only focused baseline contracts that do not require a native build; if a managed target is selected, run the container-backed recipe first and record environmental failures verbatim.
- [ ] Step 4: Copy the latest corrected performance documentation into this worktree, regenerate the combined document, and verify all 31 matrix rows before changing solver code.

### Task 1: Unified performance snapshot and strict artifact extension (RT-01, MEM-01, RK-05 telemetry, BL-01 evidence)

**Files:**
- Create: `backends/fem/gpu/cuda/runtime/performance_counters.hpp`, `backends/fem/gpu/cuda/runtime/performance_counters.cpp`
- Modify: `backends/fem/gpu/cuda/runtime/gpu_state_runtime.hpp`, `native/include/fullmag_fem.h`, `backends/fem/src/api.cpp`, `crates/fullmag-fem-sys/src/lib.rs`, `crates/fullmag-runner/src/fem/execution_receipt.rs`, native/CMake test registration
- Test: `backends/fem/tests/gpu_performance_snapshot_contract.cpp`, Rust ABI layout tests

**Interfaces:**
- Consumes: existing `fullmag_fem_gpu_execution_class_v1`, execution receipt, transfer audit, step stats, endpoint telemetry and phase timers.
- Produces: append-only `fullmag_fem_gpu_performance_snapshot_v1` and transactional physical/accepted/lifetime counters; no duplicate execution-class enum.

- [ ] Step 1: Add RED tests for ABI version/size/null handling, CPU unavailable behavior, active-attempt exclusion, reject accounting and atomic completed-step publication.
- [ ] Step 2: Add the snapshot structure and internal attempt delta owner; route module-local note functions through one runtime owner without adding `Context` fields.
- [ ] Step 3: Add the C ABI getter and Rust layout/validation mapping; preserve existing receipt error semantics until a dedicated contract defines CPU `ERR_UNAVAILABLE` versus `ERR_INVALID`.
- [ ] Step 4: Instrument direct normalizer readbacks, backup/raw/FSAL/reject D2D categories and existing phase timers; keep profiler-off free of new CUDA events/heap allocations.
- [ ] Step 5: Add a source contract proving strict validation reuses existing receipt masks and does not create a second strict gate.
- [ ] Step 6: Run focused CTest/Rust contracts through the matching managed `just` target and record source-only versus runtime evidence separately.

### Task 2: HYPRE policy ownership and conditional residual validation (NEW-HYPRE-01, DM-02)

**Files:**
- Create: `backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.hpp`, `backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.cpp`
- Modify: `backends/fem/gpu/cuda/runtime/hypre_device_policy.cpp`, `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`
- Test: HYPRE setter-owner source contract and residual truth-table contract

**Interfaces:**
- Consumes: current `validate_demag_linear_solve_result`, solver convergence flags, absolute/relative tolerance policy.
- Produces: one process-wide HYPRE setter owner and a pure `HypreResidualValidationNeeds` resolver.

- [ ] Step 1: Add RED source tests requiring all `HYPRE_SetMemoryLocation`, `HYPRE_SetExecutionPolicy` and vendor `SetSp*UseVendor` calls to remain only in `hypre_device_policy.cpp`.
- [ ] Step 2: Remove `configure_hypre_device_vendor_kernels` global setters while preserving solver-local tolerance/max-iteration setters and error propagation.
- [ ] Step 3: Add RED truth-table cases for solver-reported convergence, absolute tolerance and forced independent residual.
- [ ] Step 4: Implement the pure resolver and guard `b_par->Norml2()` plus independent residual computation with its result; increment the snapshot counter only when evaluated.
- [ ] Step 5: Run HYPRE contract and demag residual tests in the managed container; do not promote performance claims without a GPU receipt.

### Task 3: Demag stage modes, recovery pattern selection and timing completeness (DM-01, DM-03, DM-04, DM-05)

**Files:**
- Modify: `backends/fem/gpu/cuda/demag_poisson/stage_compute.hpp`, `stage_compute.cpp`, `operators.cpp`, `demag_kernels.cu`, `hypre_device_solver.cpp`, relevant state/workspace files
- Test: `cuda_demag_field_only_contract.cpp`, fused/split recovery parity contract, timing schema contract, tolerance-sweep harness

**Interfaces:**
- Consumes: persistent matrix/vector/solver setup, existing split recovery and event bridge.
- Produces: typed `GpuDemagEvaluationMode`/purpose request, legal shared-pattern fused recovery with split fallback, explicit purpose-tolerance experiment data.

- [ ] Step 1: Add RED `FieldOnly` tests proving no stage demag energy kernel/reduction and no stale energy slot publication.
- [ ] Step 2: Implement request threading through RK stage, endpoint, relaxation, observable and validation-oracle call sites; preserve final energy owner.
- [ ] Step 3: Add RED common/different CSR-pattern cases and memory-destroy checks for recovery.
- [ ] Step 4: Implement digest plus full pattern equality, shared value arrays and fused xyz recovery only for equal patterns; preserve split fallback and resolved-mode telemetry.
- [ ] Step 5: Extend timing artifact with AMG levels/unknowns per level and explicit host wait/API/device elapsed fields already available in the stream bridge.
- [ ] Step 6: Add benchmark-only tolerance policy/sweep; keep the current common `relative_tolerance` default and do not expose unqualified purpose fields.

### Task 4: Deferred RK normalization and typed attempt control (RK-01, RK-02, MEM-01)

**Files:**
- Create: `backends/fem/gpu/cuda/integrators/rk/rk_attempt_control_state.hpp`, `rk_attempt_control_memory.cpp`, `rk_attempt_control_kernels.cu`
- Modify: `backends/fem/gpu/cuda/fields/vector_field_kernels.cu`, `rk_attempt_setup.cu`, `rk23_stage_sequence.cu`, `rk4_stage_sequence.cu`, `rk45_stage_sequence.cu`, `rk_stage_schedule.cu`, `rk_adaptive_decision_readback.cu`, workspace/CMake
- Test: extend `cuda_rk_guard_contract.cpp`, add attempt-packet and fixed/adaptive rollback contracts

**Interfaces:**
- Consumes: current invalid-vector flag semantics, pinned scalar staging and transaction restore.
- Produces: deferred finite/normalization flags, safe finite fallback, one typed packet readback per attempt and one owner of control synchronization.

- [ ] Step 1: Add RED tests proving current invalid-vector behavior is preserved by the compatibility path and new deferred path reports enqueue failure separately from data invalidity.
- [ ] Step 2: Implement packet allocation/reuse and fallback ownership; never alias the existing generic scalar slots.
- [ ] Step 3: Fuse each predictor with normalization only after packet tests pass, preserving frozen/PBC canonical-author semantics.
- [ ] Step 4: Replace adaptive three-scalar readback with one packet while keeping PI arithmetic in the canonical shared host helper until device decision is qualified.
- [ ] Step 5: Instrument control bytes/fences and run source plus managed contracts; reject any direct normalizer D2H left outside the owner.

### Task 5: Adaptive-error specializations and typed reduction (AD-01, AD-02, AD-03)

**Files:**
- Create: method-specific adaptive kernels/policy/reduction headers under `backends/fem/gpu/cuda/integrators/rk/`
- Modify: `adaptive_error_kernels.cu`, `rk_error_norm_runtime.cu`, `rk_adaptive_runtime.cu`, `reduction_workspace_memory.cpp`, CMake
- Test: BS23/DP54 coefficient, guard, min-dot, flags and one-reduction contracts

**Interfaces:**
- Consumes: canonical `native/include/fullmag_adaptive_step_decision.hpp` policy and Task 4 control packet.
- Produces: compile-time BS23/DP54 kernels, typed `AdaptivePartial` combine, rotation threshold via `cos(theta_max)`, no per-node `acos` in decision path.

- [ ] Step 1: Add RED tests that distinguish ErrorOnly, ErrorAndNorm and Rotation and fail while the generic kernel still computes all channels.
- [ ] Step 2: Implement neutral/associative typed partial combine and setup-time temp storage; no allocation/query in hot step.
- [ ] Step 3: Add BS23/DP54 specializations retaining the generic kernel as oracle and compare CPU/device-host goldens.
- [ ] Step 4: Implement min-dot guard and publish-only angle calculation; preserve invalid/subnormal/frozen semantics and flags.
- [ ] Step 5: Keep device PI decision out of production until shared constants and managed trajectory parity pass.

### Task 6: Exact endpoint and FSAL reuse (RK-03)

**Files:**
- Modify: `rk_workspace_state.hpp`, `rk_stage_schedule.cu`, `rk_final_refresh.cu`, `rk45_stage_sequence.cu`, `rk_dp54_accept_kernel.cu`, transaction/thermal invalidation code
- Test: warm/reject/failure/time-dependent-source BS23 tests and DP54 endpoint identity contract

**Interfaces:**
- Consumes: existing `fsal_valid`, `gpu_rk_rhs_allows_fsal_reuse`, Task 4 packet and Task 1 endpoint counters.
- Produces: attempt-local endpoint token with state generation, method, slot, time, operator signature and exactly-once consumption.

- [ ] Step 1: Add RED tests for duplicate BS23 final RHS and DP54 reconstructed endpoint identity.
- [ ] Step 2: Implement token publication only after exact normalized endpoint/RHS/field completion; invalidate on reject, failure, source/material/mesh/operator change and external upload.
- [ ] Step 3: Gate `gpu_rk_finalize_accepted_step` on valid token and retain compatibility refresh otherwise.
- [ ] Step 4: Introduce resolved FSAL slot and swap/copy endpoint ownership without stale pointers; account all remaining D2D bytes.
- [ ] Step 5: Run source contracts, then managed warm/reject/failure cases; require `rhs=3`, `demag=3`, cache hit for warm BS23 before any promotion.

### Task 7: LLG metrics, effective-field composition, output masks and reductions (RK-04, RK-06, HF-01, HF-02, RD-01)

**Files:**
- Modify: `rk_llg_rhs_dispatch.cu`, `llg_rhs_kernels.cu`, `rk_effective_field.cu`, `fields/vector_field_kernels.cu`, reduction kernels/workspace, `rk_step_stats.cu`, step ABI/API
- Test: no-metric, H_eff combinations, materialization, typed partial and cadence contracts

**Interfaces:**
- Consumes: Task 1 snapshot and Task 5 typed reductions.
- Produces: `GpuLlgMetricMode`, one fused base H_eff pass when legal, planner-owned input/materialization masks and append-only step request/output mask ABI.

- [ ] Step 1: Add RED no-metric tests asserting intermediate stages do not allocate/reduce metric channels while final metric behavior remains unchanged.
- [ ] Step 2: Implement compile-time/runtime metric mode and move global max reduction to explicit consumers.
- [ ] Step 3: Add RED ext on/off and all active-field combinations; fix unconditional `has_ext=true` from resolved state.
- [ ] Step 4: Implement bounded compose variants and lazy writes only where dependency graph says a field is required; preserve separate DMI/element owners.
- [ ] Step 5: Add typed Armijo/NCG/PGBB/final-observable partials with CPU oracles and roundoff bounds.
- [ ] Step 6: Add output-mask v2 compatibility wrapper; prove final stats are not silently omitted when requested.

### Task 8: Exchange row scale, off-diagonal CSR, fused XYZ and accuracy modes (EX-02, EX-03, EX-07, EX-08)

**Files:**
- Create: canonical internal exchange operator-kind/header and host builder under `backends/fem/gpu/cuda/exchange/`
- Modify: `exchange_state.hpp`, `exchange_upload.*`, `exchange_plan.*`, `exchange_kernels.*`, `rk_exchange_dispatch.cu`, exchange energy/difference consumers, PG-BB/NCG preflight, CMake
- Test: builder, off-diagonal, fused xyz, accumulation parity and register/spill contracts

**Interfaces:**
- Consumes: MFEM `LEGACY` CSR/lumped mass from `cpu/mfem/interactions/exchange_operator.cpp`; existing string `legacy_sparse_gpu` compatibility.
- Produces: one canonical typed operator state, precomputed row scale, deterministic off-diagonal CSR, fused SoA xyz kernel and qualified accumulation modes.

- [ ] Step 1: Add RED builder/CSR tests for monotonic offsets, duplicate merge, bounds, sorted columns, diagonal removal and digest.
- [ ] Step 2: Implement host row-scale and off-diagonal artifacts without device readback; retain full CPU CSR oracle/diagonal for relaxation preconditioner.
- [ ] Step 3: Add RED field/energy/difference parity tests and three-launch accounting.
- [ ] Step 4: Implement fused xyz kernel with strict compensated mode first; preserve legacy compatibility mode and all consumer call sites.
- [ ] Step 5: Add accurate FP64/FMA candidate only behind qualified mode ID; capture register/spill artifacts.
- [ ] Step 6: Run operator CPU/GPU parity and managed microbenchmark before changing planner defaults.

### Task 9: Periodic reduced exchange representation (EX-01)

**Files:**
- Modify: exchange builder/state/upload/kernels, periodic metadata upload, RK energy reductions, relaxation direct-energy difference and all PBC consumers
- Test: reduced PBC field/energy/direct-energy/material mismatch/complexity contracts

**Interfaces:**
- Consumes: Task 8 canonical CSR and periodic representative metadata.
- Produces: validated class-level `PᵀKP`, `PᵀM_L`, deterministic lift, reduced fused xyz apply with split fallback.

- [ ] Step 1: Add RED tests for class map bijection/coverage, magnetic/Ms/material/frozen compatibility and representative indexing.
- [ ] Step 2: Build and digest reduced CSR/mass on host; fail closed on incompatible classes.
- [ ] Step 3: Implement reduced apply and `O(nnz_reduced + N)` lift; prohibit source-row full scans in production path.
- [ ] Step 4: Port RK exchange energy and relaxation direct-energy difference to identical reduced semantics; retain full oracle for parity.
- [ ] Step 5: Add visited-NNZ/launch telemetry and benchmark scaling; do not claim O(N²) removal without measured complexity artifact.

### Task 10: Qualified exchange planner, cuSPARSE and partial assembly (EX-04, EX-06, PA-01)

**Files:**
- Create: canonical planner/profile types under `backends/fem/gpu/cuda/exchange/`, profile artifact under `docs/performance/`
- Modify: `exchange_plan.*`, capability/provenance mapping, `backends/fem/examples/pa_benchmark.cpp` or new exchange benchmark, CMake and Rust string compatibility
- Test: deterministic planner, explicit fail, stale-profile, VRAM preflight and exchange benchmark contracts

**Interfaces:**
- Consumes: Task 8/9 operator kinds, row histogram, FE/PBC/strictness/device inputs.
- Produces: one `GpuExchangeOperatorKind`, qualified profile projection, explicit fallback/fail semantics and setup/apply break-even report.

- [ ] Step 1: Add RED tests for unsupported explicit kind, stale profile, no silent PA and compatibility string mapping.
- [ ] Step 2: Implement deterministic resolver with no runtime autotune; default only to already-qualified legacy/fused profile.
- [ ] Step 3: Extend/create an actual exchange benchmark with CUDA events, setup/apply decomposition, histogram, correctness and JSON provenance.
- [ ] Step 4: Add cuSPARSE descriptor path only after operator oracle passes; do not infer exchange support from PETSc modal linkage.
- [ ] Step 5: Keep P1 tetra PA target-only until its own profile and parity evidence exist.

### Task 11: GPU relaxation preconditioning and device control (RL-01, RD-01 in NCG/PG-BB)

**Files:**
- Create: focused preconditioner owner under `backends/fem/gpu/cuda/relaxation/`
- Modify: `relaxation_state.*`, `nonlinear_cg.cpp`, `pgbb.cpp`, direct-energy/reduction consumers, `RelaxationControlIR` only after qualification
- Test: diagonal oracle, invalid/mask, preconditioned PR+, Armijo/PG-BB rollback and time-to-tolA qualification contracts

**Interfaces:**
- Consumes: CPU `M+wK` oracle, Task 8 row/diagonal artifacts, Task 7 typed reductions.
- Produces: persistent diagonal/Chebyshev/PCG candidates, correct preconditioned PR+ numerator/denominator and device decision packets, all gated by qualified planner profiles.

- [ ] Step 1: Add RED CPU/GPU mathematical oracle for `D_i=M_ii+wK_ii`, tangent transport and PR+ roundoff/restart behavior.
- [ ] Step 2: Implement persistent diagonal candidate with exact invalidation key; no host transfer in apply.
- [ ] Step 3: Benchmark and qualify Chebyshev/PCG only if diagonal does not improve time-to-tolA; preserve `None` baseline.
- [ ] Step 4: Add Armijo/PG-BB packet tests and move policy decisions only after arithmetic parity; preserve bounded refinement and rollback.
- [ ] Step 5: Update IR/planner/provenance with a distinct NCG preconditioner vocabulary; never reuse demag `AMG/JACOBI` field semantics.

### Task 12: Managed qualification, documentation and final branch review

**Files:**
- Modify: corrected performance package, `docs/architecture/backend-golden-masterplan.md`, relevant `docs/physics/` notes, capability/provenance docs, benchmark index
- Test: managed `just` recipes, source contracts, scientific parity, benchmark receipt validator and final diff review

**Interfaces:**
- Consumes: all qualified task artifacts and existing strict receipt.
- Produces: immutable SP4 managed receipt, final cubin/CC evidence, updated capability status and a branch-level review package.

- [ ] Step 1: Run `just rebuild-fem-runtime` and `just ensure-managed-fem-runtime` in the managed/container path.
- [ ] Step 2: Run `just fem-sp4-run gpu <output_dir>` or the exact current managed equivalent with fixed `mixed_p1/layers=1/medium/baseline/native` inputs.
- [ ] Step 3: Validate final bundle with required native cubin derived from actual compute capability; store source SHA, ProblemIR/mesh digest, library hashes, GPU identity, receipt and median/p95.
- [ ] Step 4: Run separate CPU/GPU physics parity and analytical/SP4 validation; mark missing lanes `NOT VERIFIED`, never infer them from source contracts.
- [ ] Step 5: Regenerate the performance manifest/combined document and run markdown, JSON, source-map and diff checks.
- [ ] Step 6: Perform a whole-branch review against the matrix; unresolved Critical/Important issues keep the branch unqualified.

## Definition of Done

The implementation is complete only when every matrix ID has either a merged
implementation with its required tests and managed/scientific evidence, or an
explicit fail-closed `NOT VERIFIED` status with no public promotion. The final
report must list source, contract, managed runtime, scientific validation and
production qualification separately, including any environment blockers.
