# Complete Relaxation Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć wszystkie defekty i luki dowodowe FM-RELAX-001–018 bez promowania żadnego lane'u ponad poziom potwierdzony świeżym, source-bound managed-runtime evidence.

**Architecture:** Kanoniczna semantyka pozostaje w `docs/physics/0580-*`, `ProblemIR` i wspólnych kontrolerach relaksacji. Dostępność wykonawcza, walidacja naukowa i kwalifikacja produkcyjna zostają rozdzielone; promocja jest wyliczana z immutable receipts zamiast ręcznie wpisanych statusów. FDM i FEM zachowują osobne realizacje, lecz wspólne kryteria accepted-state, energii, torque i provenance.

**Tech Stack:** Python DSL/pytest, Rust/serde/cargo, C++17/MFEM/hypre/CUDA, JSON qualification receipts, repository `just` managed/container recipes.

## Global Constraints

- Native FEM/MFEM/CUDA/hypre/libCEED build i runtime wyłącznie przez kontenerowe recepty repo `justfile`.
- IR przechowuje torque wyłącznie w A/m; requested unit pozostaje osobnym provenance.
- Forced GPU nigdy nie może fallbackować; auto/extended fallback musi być jawny.
- Status produkcyjny wymaga świeżego receipt z commit, tree/diff hash, command, device identity, precision, scope i artifact hash.
- FP32 nie dziedziczy kwalifikacji FP64.
- Brak, stary lub niezgodny receipt daje status unvalidated/development, nigdy produkcyjny.
- Nie zmieniać cudzych plików w brudnym współdzielonym drzewie i nie aktualizować checksum inwentarza bez rozliczenia jego zmian.

---

### Task 1: Fail-closed capability and qualification registry (FM-RELAX-001, 017)

**Files:**
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `docs/specs/capability-matrix-v0.md`
- Create: `scripts/validate_relaxation_capability_evidence.py`
- Create: `scripts/test_validate_relaxation_capability_evidence.py`
- Modify: `justfile`

**Interfaces:**
- Consumes: relaxation capability rows and qualification receipts under `.fullmag/reports/`.
- Produces: validator rejecting production statuses without exact source-bound receipts.

- [ ] Write RED tests for empty `validated_workloads`, missing artifact, stale commit/tree, wrong device/precision/scope and failed solver-audit prerequisite.
- [ ] Run the validator tests and confirm each fixture fails for its intended reason.
- [ ] Implement the validator and downgrade relaxation rows to truthful development/reference states until receipts exist.
- [ ] Remove prose claiming PG-BB is production-qualified without current evidence.
- [ ] Add `just verify-relaxation-capability-evidence` and verify RED fixtures plus current matrix.

### Task 2: Mandatory final execution-resolution provenance (FM-RELAX-011, 018)

**Files:**
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime.rs`
- Test: `crates/fullmag-runner/src/artifacts.rs`
- Test: `crates/fullmag-runner/src/dispatch.rs`

**Interfaces:**
- Produces: one serialized final record containing requested backend/device/precision/mode, resolved backend/device/precision/mode, resolution mode and nullable fallback reason.

- [ ] Write RED artifact tests for no-fallback CPU, forced GPU success, auto GPU→CPU fallback, strict rejection and TPI auto→CPU.
- [ ] Add typed provenance with mandatory strings and explicit `fallback_occurred`/`fallback_reason`.
- [ ] Populate it from the effective request and actual engine immediately before final artifact serialization.
- [ ] Require forced-device mismatch to return an error before execution.
- [ ] Verify every final metadata fixture contains the record and round-trips through serde.

### Task 3: Retracted-curve Armijo proof and TPI cancellation safety (FM-RELAX-005, 009)

**Files:**
- Modify: `crates/fullmag-runner/src/relaxation/direct_minimizer.rs`
- Modify: `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs`
- Modify: `backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`
- Modify: `backends/fem/cpu/mfem/relaxation/direct_energy_increment.cpp`
- Modify: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.source-map.json`

**Interfaces:**
- Consumes: accepted magnetization, retracted trial curve, effective field and interaction-resolved energy difference.
- Produces: numerical proof that the canonical tangent slope is the derivative of the retracted curve at zero, plus strict TPI Armijo on a direct energy increment with bounded roundoff interval.

- [ ] Add a macrospin derivative-consistency test proving that the finite-difference derivative along the normalization retraction converges to the canonical tangent slope. This is hardening evidence for the finding rejected as false, not a behavior change.
- [ ] Write RED TPI cancellation test with large common energy offset and resolvable negative increment.
- [ ] Route TPI through `direct_minimizer_armijo_accepts` and bounded refinement instead of endpoint-total subtraction.
- [ ] Run managed FEM energy-derivative/source contracts and focused FDM tests.
- [ ] Revalidate the scientific source map and equation contract.

### Task 4: Atomic FDM transport and accepted-state convergence parity (FM-RELAX-003, 006–010)

**Files:**
- Modify: `backends/fdm/api/c_api.cpp`
- Modify: `backends/fdm/tests/multilayer_abi_v2_contract.cpp`
- Modify: `crates/fullmag-runner/src/relaxation/convergence.rs`
- Modify: `crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs`
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs`
- Modify: `backends/fem/tests/relaxation_source_contract.cpp`

**Interfaces:**
- Produces: one accepted-state torque confirmation policy and transaction invariant `begin = commit + rollback`.

- [ ] Add RED fault-injection tests for every post-begin error/cancel branch and exact pre/post snapshot equality.
- [ ] Add RED transient-low-torque, exact-equilibrium, zero-gradient/high-torque and NaN cases across direct minimizers.
- [ ] Consolidate transaction cleanup behind RAII/common epilogue; no early return may bypass rollback.
- [ ] Publish confirmation count/reason in telemetry/provenance.
- [ ] Run managed native FDM ABI/CUDA tests and FEM consistency contracts.

### Task 5: Practical FDM physics qualification (FM-RELAX-014, 017)

**Files:**
- Modify: `crates/fullmag-runner/tests/physics_validation/fdm_relaxation.rs`
- Create: `scripts/validate_fdm_relaxation_qualification.py`
- Create: `scripts/test_validate_fdm_relaxation_qualification.py`
- Modify: `justfile`
- Modify: `.github/workflows/bootstrap.yml`

**Interfaces:**
- Produces: bounded CI smoke and release-only managed CPU/CUDA FP64/FP32 qualification receipt.

- [ ] Profile current scenarios and record per-case step/time/energy/torque behavior.
- [ ] Split small analytic CI cases from SP4/demag release cases; every case gets a hard timeout and explicit non-convergence failure.
- [ ] Add LLG, PG-BB and NCG macrospin/exchange/demag tests, energy-down/torque-up adversary and small-step/non-equilibrium case.
- [ ] Add CPU↔CUDA FP64 parity and separate CUDA FP32 envelope; never skip when lane is requested.
- [ ] Emit immutable JSON with source identity, commands, device, precision, oracle, tolerances and artifact hashes.
- [ ] Require the release workflow to consume the receipt before capability promotion.

### Task 6: FEM material representation and realization parity (FM-RELAX-012, 015, 017)

**Files:**
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
- Modify: `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`
- Modify: `scripts/analysis/fem_gpu_benchmark.py`
- Modify: `justfile`

**Interfaces:**
- Produces: separate uniform/P1-nodal/DG0 capability identities and explicit CPU/GPU NCG realization identities with bounded endpoint-equivalence qualification.

- [ ] Add RED planner tests proving no interpolation or scalar fallback between uniform, P1 and DG0 representations.
- [ ] Add manufactured two-material interface tests for Ms/A jumps, region-ID permutation and unequal volumes.
- [ ] Implement coefficient ownership/access needed by each supported interaction; unsupported combinations remain typed fail-closed.
- [ ] Either implement the equivalent GPU preconditioner or preserve distinct realization IDs and qualify endpoint equivalence only.
- [ ] Add three-level mesh refinement, CPU/GPU FP64 parity and separate FP32 cases for every promoted representation.
- [ ] Emit source-bound receipts and update capability rows only for scopes that pass.

### Task 7: Production qualification orchestrator and final evidence bundle (FM-RELAX-017)

**Files:**
- Create: `scripts/verify_relaxation_production_matrix.py`
- Create: `scripts/test_verify_relaxation_production_matrix.py`
- Modify: `justfile`
- Modify: `docs/audits/2026-08-20-relaxation-audit-v2-verification-remediation.md`

**Interfaces:**
- Consumes: FDM/FEM CPU/GPU receipts for algorithms, precision, mesh and oracle scopes.
- Produces: one fail-closed D6 bundle and promotion decision.

- [ ] Write RED tests for every missing lane/algorithm/precision/oracle/refinement/repeatability receipt and all identity mismatches.
- [ ] Implement deterministic manifest/checksum generation and reject dirty/stale/mixed-source evidence.
- [ ] Add `just verify-relaxation-production-matrix` invoking only managed sub-recipes.
- [ ] Run the full matrix and preserve stdout/stderr, device identity, source identity and artifact hashes.
- [ ] Update the audit row-by-row from fresh evidence; unresolved rows remain explicitly unqualified.

### Task 8: Independent review and completion audit

**Files:**
- Review all files changed by Tasks 1–7.

- [ ] Dispatch a spec-compliance reviewer against FM-RELAX-001–018.
- [ ] Dispatch a numerical/code-quality reviewer for FDM/FEM line search, convergence and transaction semantics.
- [ ] Resolve every Critical/Important finding and repeat focused tests.
- [ ] Re-run scientific-doc validators, source contracts, managed runtime matrix and `git diff --check`.
- [ ] Mark complete only if every finding has direct current-tree evidence and the production matrix is qualified or explicitly remains non-production without a contradictory claim.
