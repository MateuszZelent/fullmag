# FEM CPU Solver Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć findingi FEM CPU dotyczące ownership stanu, norm adaptacyjnych, operator lifecycle, transakcji RK, projekcji masy, warm-startu, FSAL, wątków i materiałów.

**Architecture:** Natywny MFEM CPU zachowuje rozdział core/runtime/operatorów. Stan magnetyzacji dostaje jawny layout i granice commit/projection; operatorzy dostają dependency keys i receipts. Próba RK nie kopiuje pól pochodnych, a rollback odtwarza wyłącznie authoritative state i minimalny journal.

**Tech Stack:** C++17, MFEM/Hypre managed container, Rust planner/runner, native contract tests, JSON qualification receipts.

## Global Constraints

- Native FEM budować i uruchamiać przez `just rebuild-fem-runtime`, `just ensure-managed-fem-runtime` i właściwe managed recipes.
- Nie dodawać nowej semantyki fizycznej do `Context` ani `mfem_bridge.cpp`.
- CPU/GPU muszą dzielić kontrakt fizyczny, ale zachować osobne realizacje operatorów.
- Airbox i niemagnetyczne DOF mają jawny zero-RHS/membership contract.
- Brak świeżego managed receipt nie jest qualification.

---

### Task 1: Typowany layout stanu i granice PBC/Airbox (FEM-CPU-ARCH-001)

**Files:**
- Modify: `backends/fem/core/fem_state.cpp:1-80`
- Modify: `backends/fem/cpu/mfem/runtime/aos_field.cpp:90-185`
- Modify: `backends/fem/cpu/mfem/runtime/state_io.cpp`
- Modify: `backends/fem/tests/aos_field_contract.cpp`
- Modify: `backends/fem/tests/fem_state_contract.cpp`
- Create: `backends/fem/core/fem_state_layout.hpp`
- Create: `backends/fem/tests/fem_state_layout_contract.cpp`

**Interfaces:**
- Consumes: magnetic membership, PBC representatives, Airbox mask and AoS values.
- Produces: `MagnetizationStateLayout` and `commit_project_periodic_magnetization(...)`, with commit-only projection and zero Airbox RHS.

- [ ] **Step 1: Write red PBC/Airbox test.** Upload → step → reject → retry on a two-representative mesh; assert only magnetic DOF evolve, PBC projection happens only at commit, and Airbox values/RHS stay zero.
- [ ] **Step 2: Run `just verify-fem-time-domain-native-contract`; record failure before adding the type.
- [ ] **Step 3: Add `MagnetizationStateLayout { magnetic_dofs, airbox_dofs, periodic_representatives, revision }` in the core state module; keep ownership in state/runtime, not `Context` physics.
- [ ] **Step 4: Route `normalize_active_magnetization_aos` and `project_static_periodic_aos` through the layout and call projection only from the accepted-step epilogue.
- [ ] **Step 5: Add state I/O revision/receipt and verify `state_io_contract`, `aos_field_contract`, and managed CPU fixture.
- [ ] **Step 6: Commit `fix: make fem cpu state ownership explicit`.

### Task 2: Mass-weighted adaptive norm and stiffness policy (FEM-CPU-NUM-001/002)

**Files:**
- Modify: `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp:123-253`
- Modify: `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp:300-340`
- Modify: `backends/fem/cpu/mfem/runtime/step_metrics.cpp:197-240`
- Modify: `backends/fem/cpu/mfem/runtime/stage_completion.cpp:350-400`
- Modify: `crates/fullmag-plan/src/fem.rs:3160-3210`
- Modify: `backends/fem/tests/adaptive_dt_contract.cpp`, `rk_explicit_contract.cpp`, `step_metrics_contract.cpp`, `stage_completion_contract.cpp`
- Create: `backends/fem/cpu/mfem/integrators/adaptive_error_receipt.hpp`
- Create: `backends/fem/tests/fem_stiffness_policy_contract.cpp`

**Interfaces:**
- Consumes: active magnetic mass/measure, error vector, `h_min`, exchange stiffness/material and selected integrator.
- Produces: `AdaptiveErrorReceipt { weighted_rms, max_guard, active_measure }`, normalized energy plateau and planner `exchange_stiffness_limit`/policy receipt.

- [ ] **Step 1: Write red tests.** Unequal nodal volumes must use weighted RMS; Airbox/frozen DOF must not alter denominator; equal physics with different active measure must have the same normalized plateau; halving `h_min` must tighten the explicit RK limit.
- [ ] **Step 2: Run `just verify-fem-time-domain-native-contract` and planner tests to capture nodewise-max/no-limit failure.
- [ ] **Step 3: Implement weighted norm with explicit active denominator and preserve a separate max guard for NaN/Inf/safety.
- [ ] **Step 4: Replace raw joule plateau comparison with energy-per-active-measure (retain raw J for reporting).
- [ ] **Step 5: Add `estimate_fem_exchange_stiffness_limit(...)` to planner and keep TPI marked CPU development fallback until a managed production receipt exists.
- [ ] **Step 6: Run native contracts, planner tests and managed CPU mesh-refinement/retry fixture; commit `fix: make fem cpu adaptive metrics physical`.

### Task 3: Operator dependency lifecycle and PBC warm-start (FEM-CPU-PERF-001/005)

**Files:**
- Modify: `backends/fem/cpu/mfem/interactions/exchange_operator.cpp:1-210`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_lifecycle.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp:70-300`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp:176-225`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_cache.cpp`
- Modify: `backends/fem/tests/exchange_contract.cpp`, `demag_poisson_contract.cpp`, `demag_contract.cpp`
- Create: `backends/fem/cpu/mfem/interactions/operator_dependency.hpp`
- Create: `backends/fem/tests/fem_operator_lifecycle_contract.cpp`

**Interfaces:**
- Consumes: mesh/material/BC/PBC/device revisions and RHS.
- Produces: `OperatorDependencyKey`, `OperatorLifecycleReceipt`, `DemagWarmStartPolicy` and exact setup/rebuild reason counters.

- [ ] **Step 1: Write red lifecycle tests.** 100 steps build/setup once; changing one key rebuilds only its operator; source time does not rebuild; failed rebuild retains the previous active operator. Two similar PBC RHS calls must preserve the reduced initial guess; reject/key change resets it.
- [ ] **Step 2: Run `just verify-fem-exchange-runtime` and the native contract; record current PBC `x_p=0` behavior.
- [ ] **Step 3: Add dependency keys/receipts to exchange and demag owners; commit new operator only after setup succeeds.
- [ ] **Step 4: Remove unconditional PBC reduced-vector zeroing; preserve warm-start under matching key and reset on reject/failure/operator change.
- [ ] **Step 5: Add endpoint freshness and iteration counters; run `just verify-fem-demag-amg-policy-contract`, `just verify-fem-time-domain-native-contract` and managed PBC run.
- [ ] **Step 6: Update stale `docs/physics/0823-native-fem-cpu-pbc-demag-reduced-warm-start.md` to match code and commit `perf: reuse fem cpu operator and demag warm starts`.

### Task 4: Mass projection workspace (FEM-CPU-PERF-004)

**Files:**
- Modify: `backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp:1-280`
- Modify: `backends/fem/tests/exchange_contract.cpp`
- Create: `backends/fem/cpu/mfem/interactions/mass_projection_workspace.hpp`
- Create: `backends/fem/tests/mass_projection_workspace_contract.cpp`

**Interfaces:**
- Consumes: consistent mass operator, periodic reduced map, three magnetization components and tolerance.
- Produces: persistent/block projection workspace with residual/iteration receipt and no per-apply host vector rebuild.

- [ ] **Step 1: Write red manufactured-field tests on a distorted tetra, PBC representatives, three RHS components and tolerance sweep.
- [ ] **Step 2: Run `just verify-fem-exchange-runtime`; confirm unpreconditioned scalar CG/host allocations.
- [ ] **Step 3: Implement precomputed consistent mass/preconditioner and block/reused component solve; retain a typed fallback only where planner says unsupported.
- [ ] **Step 4: Record residual, iterations, allocation and trajectory error in the receipt; run native contracts and managed projection case.
- [ ] **Step 5: Commit `perf: reuse fem cpu mass projection workspace`.

### Task 5: Minimal RK attempt checkpoint and FSAL validity (FEM-CPU-PERF-002/003/006)

**Files:**
- Modify: `backends/fem/cpu/mfem/integrators/rk_step_transaction.hpp`
- Modify: `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp:220-320,430-446,608-710`
- Modify: `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp:150-190,470-570`
- Modify: `backends/fem/tests/rk_transaction_fault_injection_contract.cpp`, `rk_explicit_contract.cpp`
- Create: `backends/fem/cpu/mfem/integrators/rk_attempt_checkpoint.hpp`

**Interfaces:**
- Consumes: authoritative magnetization, FSAL/source/time/operator revisions, solver tokens and accepted publication state.
- Produces: preallocated `RkAttemptCheckpoint`/`RkStepJournal`, zero full-field snapshots on successful steps, and `EndpointCacheValidity`/`FinalRefreshReason`.

- [ ] **Step 1: Write red tests.** Each `RkStepFailurePoint` restores accepted digest; N rejects allocate no new full snapshot after setup; derived H/demag/Poisson are not copied for a successful step; FSAL is valid only for matching source/time/transport/projection revisions.
- [ ] **Step 2: Run `just verify-fem-time-domain-native-contract` and record allocation/snapshot failures.
- [ ] **Step 3: Allocate attempt buffers once in stepper workspace and journal only accepted-state mutations; retain deep snapshot behind an explicit debug-only mode for diagnostics.
- [ ] **Step 4: Replace boolean `final_stage_cache_valid` with revisioned validity and make tableau-specific endpoint refresh decisions explicit.
- [ ] **Step 5: Run fault injection, RHS count tests for Heun/RK4/RK23/RK45 and `just verify-fem-oersted-rk-time-convergence`.
- [ ] **Step 6: Run managed CPU retry/restart case and commit `perf: make fem cpu rk attempts transactional`.

### Task 6: CPU execution policy and material membership (FEM-CPU-PERF-007, PHY-001)

**Files:**
- Modify: `backends/fem/cpu/mfem/runtime/cpu_threads.hpp`, `cpu_threads.cpp:66-153`
- Modify: `backends/fem/cpu/mfem/runtime/step_metrics.cpp:120-150`
- Modify: `backends/fem/core/fem_material_fields.cpp:186-295`
- Modify: `backends/fem/cpu/mfem/interactions/thermal_brown_sampler.cpp:100-180`
- Modify: `backends/fem/cpu/mfem/interactions/llg_rhs.cpp:60-100`
- Modify: `backends/fem/cpu/mfem/interactions/dmi_weak_residual.cpp:20-140`
- Modify: `backends/fem/tests/cpu_threads_contract.cpp`, `fem_material_fields_contract.cpp`, `dmi_contract.cpp`, `thermal_brown_contract.cpp`
- Create: `backends/fem/cpu/mfem/runtime/cpu_execution_policy.hpp`
- Create: `backends/fem/core/fem_material_coefficient_accessor.hpp`

**Interfaces:**
- Consumes: requested OMP/Hypre/BLAS threads, affinity/NUMA policy and element/quadrature material ownership.
- Produces: `CpuExecutionPolicy` receipt with nested-parallelism control and one typed `FemMaterialCoefficientAccessor` shared by DMI/thermal/LLG.

- [ ] **Step 1: Write red tests for thread receipt (OMP/Hypre/BLAS, no nested parallelism), deterministic 1/2/N behavior and two-tet sharp material/DMI/thermal/Airbox contract.
- [ ] **Step 2: Run `just verify-fem-time-domain-native-contract` and material contracts; record missing owner/fallback.
- [ ] **Step 3: Implement session policy and pass it through runtime plan/provenance, not a new global Context field.
- [ ] **Step 4: Implement the shared material accessor; unsupported DG0/P1 combinations fail closed before operator setup, while supported operators use identical ownership.
- [ ] **Step 5: Run CPU scaling/NUMA managed benchmark and two-material/PBC/Airbox managed fixture; commit `fix: align fem cpu material and thread contracts`.

### Task 7: FEM CPU qualification (FEM-CPU-QUAL-001)

**Files:**
- Modify: `backends/fem/tests/llg_time_domain_qualification.cpp`
- Modify: `justfile`
- Create: `scripts/validate_fem_cpu_qualification_matrix.py`
- Create: `scripts/test_validate_fem_cpu_qualification_matrix.py`
- Modify: `docs/physics/0980-fem-llg-time-domain-integrators.md`

**Interfaces:**
- Consumes: native contracts and managed CPU receipts for mesh refinement, all tableau, adaptive/retry, PBC/Airbox, fault injection and performance.
- Produces: immutable CPU `double` qualification manifest, with requested/resolved/executed and no fallback.

- [ ] **Step 1: Write red manifest tests requiring coarse/medium/fine, topology, Airbox, all supported RK, adaptive/retry, oracle, fault injection, RSS and time-to-accuracy.
- [ ] **Step 2: Run validator tests; missing any axis must be `unvalidated`.
- [ ] **Step 3: Implement manifest/hash validator and add a managed CPU matrix recipe using `ensure-managed-fem-runtime` and `fem-managed-headless cpu`.
- [ ] **Step 4: Run the matrix when resources exist; preserve blocker receipts otherwise and do not update capability to production.
- [ ] **Step 5: Commit `test: add source-bound fem cpu qualification matrix`.

### Task 8: Lane review

- [ ] Run all focused native contracts, managed build/runtime gates, `git diff --check`, and inspect the stale-doc correction.
- [ ] Map every FEM CPU finding to direct source/test/receipt evidence and hand the result to common qualification.
