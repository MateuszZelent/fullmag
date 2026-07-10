# FEM Dynamic Solver Complete Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` task-by-task. Every production-code
> task is test-driven: capture RED on the current task base, implement the
> minimum GREEN change, run the focused managed gate, commit only task-owned
> files, then pass task-scoped spec and quality review.

**Goal:** Close every applicable finding A-01 through A-43 and remediation
DS-01 through DS-27 from
`docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`
for the FEM dynamic solver, without expanding any capability beyond fresh
managed evidence.

**Approved design:**
`docs/superpowers/specs/2026-07-10-fem-frequency-domain-masterplan-hardening-design.md`.
The detailed scientific finding register and acceptance criteria remain in
plan 20. The existing scoped Poisson plan
`docs/superpowers/plans/2026-07-09-real-fem-poisson-airbox-modal.md` supplies
the real-assembly fixture details reused by Tasks 17 and 18 below.

**Architecture:** Introduce one backend-neutral, typed dynamic pencil and one
canonical request before any backend selection. CPU and GPU realizations own
performance, not physics semantics. Spectrum evidence, modal-response
eligibility, runtime qualification and production capability are separate
objects. Poisson-airbox modes are solved on the finite Schur-reduced dynamic
pencil and reconstructed into the full descriptor for blockwise residuals.
GPU host-Krylov/operator, device Krylov, tiny dense modal validation and
production modal capabilities remain separate lanes.

**Tech stack:** C++20, C ABI, Rust FFI/runner, MFEM, PETSc/SLEPc, hypre,
CUDA, Python artifact verifiers, repository-managed container `just` recipes.

## Global Constraints

- FEM only. Do not add or alter FDM solver behavior.
- Preserve `exp(+i*omega*t)`, `lambda=i*omega`, fields in `A/m`, and
  `gamma0=mu0*abs(gamma)` in `m/(A s)` as the canonical public convention.
- Preserve the exact equations `L v=lambda B_alpha v` and
  `A(omega)=+i*omega*B_alpha-L`; the minus-phasor mapping is explicit, not a
  second implementation.
- Do not add physics ownership to `Context` or `mfem_bridge.cpp`.
- Modal materialization, driven apply, true residual, adjoint and CPU/GPU
  parity consume the same typed operator descriptors and digests.
- Keep interfacial/bulk DMI in its dedicated element weak-residual operator;
  never encode DMI as a scalar exchange edge.
- Preserve frame-aware exchange transport `E_i^T E_j`. Arbitrary tangent
  gauge is legal; only explicit identical-gauge APIs may compare transport to
  identity.
- Synthetic dense/Poisson oracles remain validation-only and can never set a
  production claim.
- Nonzero-k dynamic demag and nonzero-k DMI remain unavailable until the full
  FE constraint/`grad_k` operator and their managed physics gates exist.
- Old C ABI symbols are frozen. New layouts are prefix-first and receive new
  symbols; request and result capacities are both explicit.
- No exception crosses C ABI. Public results remain library-owned and use an
  idempotent library release function.
- Forced GPU never falls back silently. Host-GMRES with CUDA operator remains
  a truthful separate lane while device FGMRES is being qualified.
- Native FEM build/runtime proof uses repository container-backed `just`
  recipes. Host compiler checks are diagnostics only.
- Preserve unrelated dirty relaxation/STT work. `backends/fem/CMakeLists.txt`
  and `justfile` require hunk-level staging; never commit unrelated hunks.
- Every artifact and qualification record binds git/build identity, operator,
  equilibrium, mesh/topology, boundary/gauge, precision, device/backend,
  phase, frequency/window, tolerances and run identity as applicable.
- Every capability change uses the repository status vocabulary and records a
  bounded `validated_scope`; no broad CPU/GPU promotion from a narrow fixture.

## Baseline and Final Gates

The baseline recorded on 2026-07-10 at HEAD
`1163fc817771c6d4363c3fb27ef3ac54eaf7fd3b` is green:

```text
just verify-fem-frequency-domain-native-contract
```

The final program must also run the focused gates introduced below and the
existing managed runtime suite. A task may use a narrower managed recipe during
iteration, but its final verification includes the main native contract.

## Per-task RED/GREEN/commit protocol

Every Task 2-20 adds or extends exactly the named focused target below. The
implementer performs these steps verbatim; “RED” is not satisfied by a compile
error unrelated to the new assertion.

1. Add only the named test cases to the named test file.
2. Run `just <focused-recipe>` and record exit code nonzero plus the named
   failing assertion in `.superpowers/sdd/task-N-report.md`.
3. Implement the interfaces frozen below.
4. Re-run `just <focused-recipe>`; expected result is exit code 0 and every
   case in that target passing.
5. Run `just verify-fem-frequency-domain-native-contract`; expected exit code
   0. Tasks 18-20 additionally run their named managed runtime/GPU recipe.
6. Run `git diff --check` and inspect `git status --short`.
7. Stage only the exact task-owned paths. For dirty shared `CMakeLists.txt` or
   `justfile`, stage only the frequency-domain hunk and verify with
   `git diff --cached --check` plus `git diff --cached --stat`.
8. Commit with subject `Fix FEM dynamic solver <task-owned contract>` and put
   RED/GREEN commands and outputs in the report file before review.

| Task | Focused test file/target | Focused managed recipe | Required RED symptom |
|---|---|---|---|
| 2 | `checked_extent_test.cpp` / `fem_frequency_domain_checked_extent_contract` | `verify-fem-frequency-domain-checked-extents` | overflow basis view is accepted |
| 3 | `mode_kinematics_test.cpp` / `fem_mode_kinematics_contract` | `verify-fem-frequency-domain-mode-kinematics` | no shared mapper/conflicting gamma accepted |
| 4 | `linearized_dynamic_pencil_test.cpp` / `fem_linearized_dynamic_pencil_contract` | `verify-fem-frequency-domain-dynamic-pencil` | fused/reference mismatch is not detectable |
| 5 | `canonical_dynamic_request_test.cpp` / `fem_canonical_dynamic_request_contract` | `verify-fem-frequency-domain-canonical-request` | two active sources route by precedence |
| 6 | `matrix_view_contract_test.cpp` / `fem_frequency_domain_matrix_view_contract` | `verify-fem-frequency-domain-matrix-views` | short dense buffer is read/accepted |
| 7 | `frequency_domain_abi_v13_contract.c` plus `frequency_domain_abi_v13_fault_test.cpp` / `fem_frequency_domain_abi_v13_contract` | `verify-fem-frequency-domain-abi-sanitizers` | tail-less request or short result is unsafe |
| 8 | `operator_contract_test.cpp` / existing `fem_operator_contract` | `verify-fem-frequency-domain-native-contract` | uncertified frameless edge path accepts mismatched gauge |
| 9 | `floquet_tangent_constraint_test.cpp` / `fem_floquet_tangent_constraint_contract` | `verify-fem-frequency-domain-floquet-tangent-contract` | scalar phase-only magnetic seam changes lifted result |
| 10 | `linearization_state_contract_test.cpp` / `fem_linearization_state_contract` | `verify-fem-frequency-domain-linearization-state` | enabled recompute/periodic options are ignored |
| 11 | `operator_term_linearization_contract_test.cpp` / `fem_operator_term_linearization_contract` | `verify-fem-frequency-domain-term-linearization-parity` | at least one directional derivative/parity assertion fails |
| 12 | `modal_basis_certificate_test.cpp` / `fem_modal_basis_certificate_contract` | `verify-fem-frequency-domain-modal-certificates` | negative certificate/collision pair is accepted |
| 13 | `modal_response_contract_test.cpp` / `fem_modal_response_contract` | `verify-fem-frequency-domain-modal-reduced-runtime` | right-only/self-reconstructed residual accepts nonnormal case |
| 14 | `driven_response_contract_test.cpp` / existing `fem_driven_response_contract` | `verify-fem-frequency-domain-native-contract` | allowed zero RHS returns validation error |
| 15 | `gpu_device_krylov_contract_test.cpp` / `fem_gpu_device_krylov_contract` | `verify-fem-frequency-domain-device-krylov-contract` | fake history/inf omega/no-op probe is accepted |
| 16 | `complex_shift_contract_test.cpp` / `fem_frequency_domain_complex_shift_contract` | `verify-fem-frequency-domain-complex-shift` | real `EPSSetTarget(omega2)` selects wrong mode |
| 17 | `poisson_airbox_finite_pencil_test.cpp` / `fem_poisson_airbox_finite_pencil_contract` | `verify-fem-frequency-domain-poisson-finite-pencil` | algebraic/infinite mode enters reported spectrum |
| 18 | `mfem_poisson_airbox_modal_assembly_test.cpp` / `fem_poisson_airbox_modal_assembly_contract` | `verify-fem-frequency-domain-poisson-airbox-production` | synthetic/Kittel-calibrated payload satisfies production verifier |
| 19 | existing Poisson GPU test plus Python G5a verifier tests | `verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action` | broad device-resident modal claim is accepted |
| 20 | `device_fgmres_test.cu` / `fem_device_fgmres_contract` | `verify-fem-frequency-domain-device-krylov-runtime` | device engine unavailable/host vector roundtrip detected |

Task 1 uses its three explicit Python commands as RED/GREEN. Tasks 21-23 use
their explicit Python/Rust/API/documentation commands and do not introduce
native numerical algorithms.

## Interfaces frozen between tasks

- Task 2 owns `checked_extent.hpp`; later tasks consume it and do not create
  alternate arithmetic helpers.
- Task 3 owns `DynamicPencilMetadata`, `ComplexEigenvalue` and
  `map_eigenvalue()` in `mode_kinematics.hpp`.
- Task 4 owns `CanonicalDigestBuilder` in new
  `canonical_digest.hpp/.cpp` and `LinearizedDynamicPencil` in
  `linearized_dynamic_pencil.hpp/.cpp`. Task 10 builds a
  `linearization_state.v2` payload with this builder; Task 12 builds
  `modal_basis_cache_key.v2` and `spectrum_certificate.v2` with the same
  builder. Task 12 must not replace or fork Task 10's digest.
- Task 5 owns `CanonicalDynamicSolveRequest` and `CanonicalOperatorSource`.
  Tasks 7, 9, 16-20 consume the immutable result.
- Task 7 owns C ABI v13. All later native/Rust propagation extends v13 only;
  no later task extends old C layouts.
- Task 9 owns `FloquetTangentConstraint` and `FullFeTopologyCertificate`.
  Tasks 10, 11 and 18 consume their digests and true-DOF maps.
- Task 10 owns `LinearizationAssemblyContext` and immutable
  `LinearizationStateNative` v2.
- Task 11 owns `LinearizedInteractionJvp`; Task 4's pencil aggregates these
  descriptors, while modal/driven/GPU adapters only realize them.
- Task 12 owns `SpectrumCountCertificate`; Task 13 owns the distinct
  `ModalResponseEligibilityCertificate`.
- Task 15 owns device static/request/result/qualification types. Task 20
  implements them and is the only task allowed to set
  `production_loop_available=true`.
- Task 16 is fixed to a real-scalar PETSc real-block `STShell`; no complex
  PETSc dependency fork remains.
- Task 20 is fixed to the repository-owned bounded CUDA FGMRES engine described
  below; the local dependency audit already establishes that managed PETSc
  lacks CUDA and the current matrix-free operator cannot use ParCSR-only hypre
  FlexGMRES without materializing a different operator.

## Finding Coverage

| Tasks | Findings/remediations closed |
|---|---|
| 1 | truthful status for A-14, A-15, A-39, A-42, A-43; documentation prerequisite for DS-01..DS-27 |
| 2 | A-03 and all active extent variants; DS-13 |
| 3 | A-09, A-10; DS-02, DS-03 |
| 4 | A-08; DS-01 |
| 5 | A-19..A-22, A-27 request portion; DS-04 |
| 6 | A-30, A-31, A-36 correction; DS-21, DS-24 |
| 7 | A-32..A-35; DS-22, DS-23 |
| 8 | A-23..A-25; DS-18 |
| 9 | A-21, A-26..A-29; DS-19, DS-20 |
| 10 | A-37 and A-02 linearization signature portion; DS-25 |
| 11 | exchange/PMA/DMI/demag parity blocker; DS-26 |
| 12 | A-01, A-02 modal cache portion, A-13; DS-05, DS-06, DS-09 |
| 13 | A-11, A-12; DS-07, DS-08 |
| 14 | A-07/A-41 active semantics; DS-15 host portion |
| 15 | A-04..A-07, A-17, A-18; DS-14..DS-16 contract portion |
| 16 | A-40; DS-11 |
| 17 | A-14; DS-10 |
| 18 | A-42; DS-12 |
| 19 | A-43 and dense GPU extent/exception hazards; local DS-27 substeps “claim correction” and “bounded adapter safety”, with one DS-27 ledger disposition |
| 20 | A-15, A-16, A-39 underlying gap; DS-17 |
| 21 | canonical Python/ProblemIR/planner propagation for DS-02, DS-04, DS-19, DS-22 |
| 22 | runtime/API/artifact/capability propagation and evidence-backed status closure |
| 23 | complete A-01..A-43/DS-01..DS-27 ledger and final definition of done |

Obalonych tez A-34, A-36, A-38 i literalnej A-39 nie implementować jako
fałszywych zmian. Task 21 zapisuje ich regresję/evidence disposition.

---

### Task 1: Publish the canonical FEM dynamic-solver contract and freeze claims

**Files:**
- Create: `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`
- Modify: `docs/physics/0600-fem-eigenmodes-linearized-llg.md`
- Modify: `docs/physics/0700-frequency-domain-linearized-llg.md`
- Modify: `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
- Modify: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `scripts/test_frequency_domain_math_contract_docs.py`
- Modify: `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`
- Modify: `scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py`
- Include: plan 20 and this implementation plan in the task commit

- [ ] Add RED documentation/artifact tests requiring one `L/B/Aomega`
  dictionary, typed gamma/frequency/shift units, phase/eigenvalue mapping,
  left/right-vs-Petrov ROM rules, original-operator residual, BC-dependent
  gauge, phase-plus-frame Floquet transport and truthful GPU lane names.
- [ ] Add an otherwise production-labelled periodic K0 artifact with
  `assembly_kind=synthetic_algebraic_oracle`; confirm the verifier currently
  accepts it or fails for the wrong reason.
- [ ] Add a G5a artifact carrying the broad
  `gpu_device_resident_modal_eigensolver=true`; require rejection.
- [ ] Write the publication-style note with governing equations, symbols and
  SI units, assumptions, FEM interpretation, CPU/GPU ownership, Python/IR/
  planner/runtime/artifact impact, validation matrix and deferred capability.
- [ ] Remove stale statements that the native SLEPc implementation does not
  exist; state that real-axis targeting and real Poisson assembly remain open.
- [ ] Demote synthetic periodic-airbox and one-thread dense G5a claims without
  disabling their algebra-validation tests.
- [ ] Run:

```text
python3 -m pytest -q scripts/test_frequency_domain_math_contract_docs.py
python3 -m pytest -q scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
python3 -m pytest -q scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py
git diff --check
```

**Review checkpoint:** equations and status vocabulary agree with the approved
design; no executable capability is promoted.

### Task 2: Introduce checked extent arithmetic and migrate active allocations

**Files:**
- Create: `backends/fem/include/frequency_domain/checked_extent.hpp`
- Create: `backends/fem/tests/frequency_domain/checked_extent_test.cpp`
- Modify: `backends/fem/include/frequency_domain/gpu_device_krylov.hpp`
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp`
- Modify: `backends/fem/src/frequency_domain/tangent_frame.cpp`
- Modify: `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED boundary/property tests for checked add, multiply, byte count,
  offset-plus-extent, `2^63*2`, `restart+1`, V/Z/H layouts, node `2N/3N`,
  dense `n*n`, row `n+1`, CUDA grid conversion and policy caps.
- [ ] Reproduce `view.n=0`, `expected=2^63`, `count=2` through the public
  device-basis validator and confirm current acceptance.
- [ ] Implement non-throwing checked helpers and a reasoned distinction
  between arithmetic overflow and configured workspace limit.
- [ ] Validate every extent and byte count before vector allocation, pointer
  arithmetic, `cudaMalloc`, copy or integer launch cast in the listed owners.
- [ ] Add `just verify-fem-frequency-domain-checked-extents` and include its
  target in the main native contract.
- [ ] Run the new managed gate and
  `just verify-fem-frequency-domain-native-contract`.

**Review checkpoint:** no task-owned raw extent expression can wrap before a
validation error; valid small layouts are unchanged.

### Task 3: Add typed SI units and central eigenvalue kinematics

**Files:**
- Create: `backends/fem/include/frequency_domain/mode_kinematics.hpp`
- Create: `backends/fem/src/frequency_domain/mode_kinematics.cpp`
- Create: `backends/fem/tests/frequency_domain/mode_kinematics_test.cpp`
- Modify: `backends/fem/include/frequency_domain/operator_contract.hpp`
- Modify: `backends/fem/include/frequency_domain/modal_eigen_request.hpp`
- Modify: `backends/fem/include/frequency_domain/excitation.hpp`
- Modify: `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- Modify: `backends/fem/cpu/frequency_domain/contour_interval_solver.cpp`
- Modify: `backends/fem/cpu/frequency_domain/dense_poisson_airbox_eigen_oracle.cpp`
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED tests for gamma/mu0/gamma0 equivalence and conflict, Hz-to-rad/s
  round trip, plus/minus phasors, damped stable/unstable conjugate branches,
  zero mode and non-finite values.
- [ ] Implement typed `DynamicPencilMetadata`, `ComplexEigenvalue` and
  `ModeKinematics`; use unit-suffixed member names internally.
- [ ] Make one `map_eigenvalue()` own branch, frequency, decay and stability
  semantics; migrate positive-frequency filters and artifact writers.
- [ ] Keep legacy unsuffixed ABI fields behind adapters until Task 7.
- [ ] Record raw lambda and derived frequency/decay in artifacts.
- [ ] Run the focused managed contract and main native contract.

**Review checkpoint:** no migrated solver compares `lambda_imag>0` or divides
by `2*pi` locally.

### Task 4: Introduce the canonical linearized dynamic pencil

**Files:**
- Create: `backends/fem/include/frequency_domain/canonical_digest.hpp`
- Create: `backends/fem/src/frequency_domain/canonical_digest.cpp`
- Create: `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`
- Create: `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp`
- Create: `backends/fem/tests/frequency_domain/linearized_dynamic_pencil_test.cpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_linearized_operator.hpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_linearized_operator.cpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_modal_operator_payload.hpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_modal_operator_payload.cpp`
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_driven_response.hpp`
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp`
- Modify: `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- Modify: `backends/fem/src/frequency_domain/driven_response_solver.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED random-vector parity for reference and fused `Aomega` under both
  phasors, adjoint identities on a nonnormal matrix, macrospin eigen/driven
  consistency and digest sensitivity to every physical dependency.
- [ ] Implement one versioned, length-prefixed `CanonicalDigestBuilder` with
  normalized IEEE-754 encoding and SHA-256; every later frequency-domain
  digest consumes it.
- [ ] Implement immutable metadata, `apply_L`, `apply_B_alpha`, reference
  `apply_Aomega`, adjoint actions and canonical SHA-256 operator digest.
- [ ] Wrap the existing MFEM JVP first, then migrate modal materialization,
  host driven apply and true-residual paths without changing legal fixtures.
- [ ] Keep fused CPU/GPU apply only behind parity evidence.
- [ ] Run pencil/operator/driven/modal managed contracts and main native gate.

**Review checkpoint:** active eigen, driven and residual paths publish the same
operator digest and have no second top-level equation.

### Task 5: Canonicalize every dynamic solve request before routing

**Files:**
- Create: `backends/fem/include/frequency_domain/canonical_dynamic_request.hpp`
- Create: `backends/fem/src/frequency_domain/canonical_dynamic_request.cpp`
- Modify: `backends/fem/include/frequency_domain/modal_eigen_request.hpp`
- Modify: `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- Modify: `backends/fem/include/frequency_domain/driven_response_solver.hpp`
- Modify: `backends/fem/src/frequency_domain/driven_response_solver.cpp`
- Modify: `backends/fem/include/frequency_domain/frequency_domain_contract.hpp`
- Modify: `backends/fem/include/frequency_domain/excitation.hpp`
- Modify: `backends/fem/src/frequency_domain/excitation.cpp`
- Create: `backends/fem/tests/frequency_domain/canonical_dynamic_request_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/driven_response_contract_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED exact-one tests for every pair of tiny/MFEM/dense/CSR/Poisson/
  provider sources and assert no callback runs on conflict.
- [ ] Add RED tests for phase, duplicate k-vector, drive-kind, demag and
  boundary conflicts, including legacy-compatible equal duplicates.
- [ ] Implement tagged `CanonicalOperatorSource`, one excitation semantic and
  immutable canonical request/digest before planner or allocation.
- [ ] Eliminate precedence routing; zero and multiple active sources fail with
  a stable reason listing conflicting fields.
- [ ] Preserve requested intent and resolved source in provenance.
- [ ] Run modal, driven and main native managed contracts.

**Review checkpoint:** backends receive canonical requests and never interpret
raw enabled flags independently.

### Task 6: Make dense and CSR matrix views capacity-safe and canonical

**Files:**
- Modify: `backends/fem/include/frequency_domain/dense_poisson_airbox_eigen_oracle.hpp`
- Modify: `backends/fem/cpu/frequency_domain/dense_poisson_airbox_eigen_oracle.cpp`
- Modify: `backends/fem/include/frequency_domain/modal_eigen_request.hpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/engines/sparse_direct/assemble_real_split_csr.hpp`
- Modify: `backends/fem/cpu/frequency_domain/engines/sparse_direct/assemble_real_split_csr.cpp`
- Create: `backends/fem/tests/frequency_domain/matrix_view_contract_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/poisson_airbox_eigen_oracle_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED cases for short buffers, padded leading dimension, overflow,
  default-success result, unverifiable alpha/k flags and diagnostics truncation.
- [ ] Add RED CSR cases for empty rows, unsorted rows, duplicates, index base,
  `last!=nnz`, column bounds, `UINT32_MAX` and `PetscInt` conversion.
- [ ] Add dense `value_count`, `leading_dimension`, layout and element type;
  validate capacity before finite scan.
- [ ] Replace gauge strings with enums; pass actual alpha/k or remove
  unverifiable flags; default results to unavailable.
- [ ] Centralize canonical CSR policy: zero-based, sorted, duplicate handling,
  range checks and canonical digest.
- [ ] Run dense oracle, SLEPc and main native managed gates.

**Review checkpoint:** validation-only claim is unchanged; no buffer can be
read before its capacity/stride is proven.

### Task 7: Add prefix-first C ABI v13 and an exception-safe FFI boundary

**Files:**
- Modify: `native/include/fullmag_fem.h`
- Modify: `backends/fem/src/api.cpp`
- Create: `backends/fem/tests/frequency_domain/frequency_domain_abi_v13_contract.c`
- Create: `backends/fem/tests/frequency_domain/frequency_domain_abi_v13_fault_test.cpp`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Create: `crates/fullmag-fem-sys/tests/abi_layout.rs`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/native_fem/eigen.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED request/result size matrices ending before and after every field,
  smaller old prefixes, larger future tails, null/double release, C/C++/Rust
  layout goldens and allocator/callback exception injection.
- [ ] Add prefix-first `fullmag_fem_abi_header`, versioned request/result types,
  `fullmag_fem_fd_solve_v13(request, request_size, out, out_size)` and
  `fullmag_fem_fd_result_release_v13(out, out_size)`.
- [ ] Read/write/release each field only when its complete extent fits; accept
  permitted larger tails; use fixed-width integers.
- [ ] Freeze old symbols and move new Rust calls to v13.
- [ ] Put one outer `try/catch` on every C export; map allocation and internal
  exceptions without crossing ABI; preserve library-owned strings and cleanup.
- [ ] Add `just verify-fem-frequency-domain-abi-sanitizers` using the managed
  container with ASan/UBSan and Rust layout/FFI tests.

**Review checkpoint:** neither request nor result evolution can cause OOB, and
fault injection returns a stable status instead of terminate/leak.

### Task 8: Make tangent-frame and exchange-gauge contracts explicit

**Files:**
- Modify: `backends/fem/include/frequency_domain/tangent_frame.hpp`
- Modify: `backends/fem/src/frequency_domain/tangent_frame.cpp`
- Modify: `backends/fem/include/frequency_domain/operator_terms.hpp`
- Modify: `backends/fem/src/frequency_domain/operator_terms.cpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_exchange_operator.cpp`
- Modify: `backends/fem/tests/frequency_domain/operator_contract_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add deterministic random/near-pole right-handed frame tests and
  independent SO(2) gauge-rotation invariance of lifted exchange action.
- [ ] Add RED rejection for frameless/uncertified identical-gauge calls and
  DMI/surface-anisotropy edge kinds.
- [ ] Publish frame convention and handedness diagnostics.
- [ ] Remove the unsafe frameless public overload or rename it to explicit
  identical-gauge with a required certificate; production exchange stays
  frame-aware.
- [ ] Run operator and main native managed contracts.

**Review checkpoint:** arbitrary legal tangent gauge does not alter Cartesian
physics; DMI remains a dedicated typed element operator.

### Task 9: Build one Floquet tangent constraint and a full FE topology certificate

**Files:**
- Create: `backends/fem/include/frequency_domain/floquet_tangent_constraint.hpp`
- Create: `backends/fem/src/frequency_domain/floquet_tangent_constraint.cpp`
- Modify: `backends/fem/include/frequency_domain/frequency_domain_contract.hpp`
- Modify: `backends/fem/include/frequency_domain/modal_eigen_request.hpp`
- Modify: `backends/fem/include/frequency_domain/driven_response_solver.hpp`
- Modify: `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- Modify: `backends/fem/src/frequency_domain/driven_response_solver.cpp`
- Modify: `backends/fem/include/frequency_domain/mesh_symmetry_certificate.hpp`
- Modify: `backends/fem/src/frequency_domain/mesh_symmetry_certificate.cpp`
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`
- Modify: `native/include/fullmag_fem.h`, `backends/fem/src/api.cpp`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Create: `backends/fem/tests/frequency_domain/floquet_tangent_constraint_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/driven_response_contract_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`

- [ ] Add RED modal/driven mismatch, gauge-rotation, phase/frame cycle,
  k=0 parity, k↔-k, shared digest and topology-orientation tests.
- [ ] Implement `phase=exp(-i*k dot T)` plus `E_dst^T E_src` in one immutable
  constraint used by assembly, matrix-free apply, RHS, output lift and residual.
- [ ] Scalar phi uses phase only; magnetic tangent DOFs use phase and transport.
- [ ] Extend certificate input with element/face maps, permutations,
  orientation, FE family/order, true DOFs, Jacobians and material/region maps;
  node-only evidence has scope `node_pairs`, never `full_fe_topology`.
- [ ] Rename geometry residual to `max_airbox_translation_residual_m`; make
  arbitrary-gauge tolerance measure transport orthogonality.
- [ ] Add `just verify-fem-frequency-domain-floquet-tangent-contract`; update
  existing CPU/GPU Floquet gates to require the canonical constraint digest.

**Review checkpoint:** phase-only magnetic projection is gone; nonzero-k demag
and DMI remain gated unless their full operator is present.

### Task 10: Rebuild LinearizationState from explicit assembly dependencies

**Files:**
- Modify: `backends/fem/include/frequency_domain/linearization_state.hpp`
- Modify: `backends/fem/src/frequency_domain/linearization_state.cpp`
- Modify: `backends/fem/include/frequency_domain/equilibrium_state.hpp`
- Modify: `backends/fem/src/frequency_domain/equilibrium_state.cpp`
- Create: `backends/fem/tests/frequency_domain/linearization_state_contract_test.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED mismatch tests for mesh/material/physics/boundary, real P1 mass,
  recomputed per-term `H_eff0`, missing topology certificate, preserved
  Poisson phi/gauge/airbox identity, extent overflow and delimiter collision.
- [ ] Split import/validation from assembly using immutable
  `LinearizationAssemblyContext` with mesh, FE space, materials, enabled terms,
  mass, topology certificate and demag/Poisson context.
- [ ] Actually execute recompute and periodic options or fail closed; no true
  option may be ignored.
- [ ] Assemble real lumped mass; unit masses remain only in explicit synthetic
  fixtures.
- [ ] Persist all mesh/DOF/phi/gauge/frame/physics identities and encode the
  `linearization_state.v2` payload through Task 4's
  `CanonicalDigestBuilder`; delete the delimiter-concatenated pseudo-hash.
- [ ] Run focused and main native managed gates.

**Review checkpoint:** the immutable state contains everything required to
reproduce the same pencil with no hidden registry.

### Task 11: Unify exchange, PMA, DMI and demag linearized JVP semantics

**Files:**
- Create: `backends/fem/include/frequency_domain/linearized_interaction_jvp.hpp`
- Create: `backends/fem/src/frequency_domain/linearized_interaction_jvp.cpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_linearized_operator.hpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_linearized_operator.cpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_modal_operator_payload.hpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_modal_operator_payload.cpp`
- Modify: `backends/fem/include/frequency_domain/anisotropy_operator.hpp`
- Modify: `backends/fem/src/frequency_domain/anisotropy_operator.cpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_dmi_operator.hpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_dmi_operator.cpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_exchange_operator.cpp`
- Modify: `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`
- Create: `backends/fem/tests/frequency_domain/operator_term_linearization_contract_test.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED finite-difference derivative tests for exchange; volume PMA
  easy-axis/easy-plane; separate surface anisotropy; interfacial/bulk DMI with
  D and normal reversal/regions; static-vs-dynamic demag and `H=-grad(phi)`.
- [ ] Add gauge invariance and identical modal-materialization, driven CPU,
  GPU callback and true-residual actions per term and for their sum.
- [ ] Implement one typed JVP descriptor per term; CPU/GPU are realizations of
  the same units/signs/coefficients/boundary semantics.
- [ ] Preserve separate `VolumeUniaxialPma{Ku,Ms,axis}` and
  `SurfaceAnisotropy{Ks,axis,faces}`; preserve typed interfacial/bulk DMI.
- [ ] Separate static demag state, dynamic tangent action and Poisson potential
  provenance.
- [ ] Emit per-term enabled state, digest, action norm and parity error.
- [ ] Add/run `just verify-fem-frequency-domain-term-linearization-parity` and
  the main native gate.

**Review checkpoint:** eigen, driven, CPU and GPU cannot use different formulas
for exchange/PMA/DMI/demag.

### Task 12: Validate modal certificates and canonicalize basis/provenance digests

**Files:**
- Modify: `backends/fem/include/frequency_domain/modal_basis.hpp`
- Modify: `backends/fem/cpu/frequency_domain/contour_interval_solver.hpp`
- Modify: `backends/fem/cpu/frequency_domain/contour_interval_solver.cpp`
- Modify: `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- Modify: `backends/fem/include/frequency_domain/linearization_state.hpp`
- Modify: `backends/fem/src/frequency_domain/linearization_state.cpp`
- Create: `backends/fem/tests/frequency_domain/modal_basis_certificate_test.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED negative, unknown-enum, NaN/inf, count equality, array-length,
  fuzz, delimiter collision, long-value, locale, signed-zero and digest golden
  tests.
- [ ] Split structural `validate_modal_basis_certificate()` from response
  eligibility and return reasoned statuses.
- [ ] Implement `modal_basis_cache_key.v2` and
  `spectrum_certificate.v2` payload encoders through Task 4's
  `CanonicalDigestBuilder`, covering every pencil/mesh/equilibrium/term/
  boundary/frame dependency. Consume the `linearization_state.v2` digest from
  Task 10; do not recalculate or replace it.
- [ ] Define typed spectrum proof with operator/window/tolerance/backend/build/
  run identity, contour geometry/refinement/shifted-solve evidence and boundary
  ambiguity.
- [ ] Serialize the typed object directly; reject reuse on any identity or
  stricter-tolerance mismatch.
- [ ] Run contour, modal and main native managed contracts.

**Review checkpoint:** no caller-supplied count or text key can self-certify a
modal basis or collide silently.

### Task 13: Certify modal response on the original pencil and support nonnormal bases

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/modal_response.hpp`
- Modify: `backends/fem/cpu/frequency_domain/modal_response.cpp`
- Modify: `backends/fem/include/frequency_domain/planner/frequency_solve_planner.hpp`
- Modify: `backends/fem/include/frequency_domain/modal_eigen_result.hpp`
- Modify: `backends/fem/cpu/frequency_domain/slepc_modal_eigen.hpp`
- Modify: `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`
- Modify: `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`
- Modify: `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp`
- Create: `backends/fem/tests/frequency_domain/modal_response_contract_test.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED out-of-window mode and self-reconstructed-residual cases where
  count/right-only modal solve looks valid but original direct solve disagrees.
- [ ] Add RED nonnormal 2x2/4x4, damped macrospin, cluster rotation and
  near-defective rejection cases.
- [ ] Separate `SpectrumCountCertificate` from
  `ModalResponseEligibilityCertificate`; compute per-frequency true residual
  and backward error with the original canonical pencil.
- [ ] Implement enrichment/rational correction and explicit full-solver
  fallback with per-point provenance.
- [ ] For diagonal eigenmodal expansion, obtain right/left modes, normalize
  `W^H B V=I`, report both residuals/overlap/condition and reject defective
  bases. A rational/Petrov path may instead store explicit trial/test bases and
  reduced operators, but keeps the same original-pencil acceptance.
- [ ] Remove the raw `modal_basis_validated` planner boolean as an eligibility
  source.
- [ ] Add/run `just verify-fem-frequency-domain-modal-reduced-runtime`.

**Review checkpoint:** every accepted reduced point has independent full
operator evidence; diagonal damped response is biorthogonal.

### Task 14: Fix host FGMRES zero-RHS, early convergence and breakdown semantics

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_driven_response.hpp`
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp`
- Modify: `backends/fem/include/frequency_domain/driven_response_solver.hpp`
- Modify: `backends/fem/tests/frequency_domain/driven_response_contract_test.cpp`

- [ ] Add RED direct host-GMRES tests for allowed/forbidden zero RHS, exact
  initial guess, identity one-step, exact happy breakdown, tracked-vs-true
  mismatch, precision-floor stagnation and non-finite RHS.
- [ ] Return canonical zero response, zero iterations/residual and
  `stop_reason=zero_rhs` when allowed, before division or operator work.
- [ ] Accept early convergence and happy breakdown only after recomputed true
  residual/backward error; distinguish unhappy breakdown.
- [ ] Separate observed mismatch/CPU ratio from allowed thresholds; keep 64/256
  trend only as a qualification fixture.
- [ ] Run driven and main native managed contracts plus active CPU/GPU-host
  response fixtures.

**Review checkpoint:** all driven lanes share the same zero/early/breakdown
semantics; no Hessenberg residual alone certifies success.

### Task 15: Split device FGMRES config/run/certificate and make probes safe

**Files:**
- Modify: `backends/fem/include/frequency_domain/gpu_device_krylov.hpp`
- Create: `backends/fem/tests/frequency_domain/gpu_device_krylov_contract_test.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED tests proving fresh config currently needs fake history,
  one-iteration config inherits 256-run claims, inf/mismatched omega passes,
  probe mutates solution, no-op/partial/NaN callbacks pass, aliasing and async
  errors are missed.
- [ ] Split immutable static config, solve request, engine-generated run result
  and provenance-bound qualification certificate.
- [ ] Static validation must not inspect run counters/residuals; certificates
  bind operator/preconditioner/frequency/device/build/run identities.
- [ ] Use const input/mutable output views, checked layout, engine-owned probe
  buffers, exact frequency identity, pointer/alias/device checks, canaries,
  input checksum, finite output and stream-synchronized async status.
- [ ] Validate operator linearity/CPU parity on a nontrivial fixture; do not
  require a flexible preconditioner itself to be linear.
- [ ] Preserve `production_loop_available=false` until Task 20 qualifies the
  real engine.
- [ ] Run focused and main native managed contracts.

**Review checkpoint:** caller data cannot qualify itself and probes cannot
modify production state or accept unexecuted callbacks.

### Task 16: Correct imaginary-axis selected-spectrum targeting in all SLEPc adapters

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/spectral_transform.hpp`
- Modify: `backends/fem/cpu/frequency_domain/spectral_transform.cpp`
- Create: `backends/fem/cpu/frequency_domain/real_block_complex_shift.hpp`
- Create: `backends/fem/cpu/frequency_domain/real_block_complex_shift.cpp`
- Modify: `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- Create: `backends/fem/tests/frequency_domain/complex_shift_contract_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED separated `±i*omega1`, `±i*omega2` pencils for both phasors that
  expose the current real-axis target.
- [ ] Implement the selected architecture: `RealBlockComplexShiftShell` on the
  current real-scalar PETSc/SLEPc runtime. For `sigma=s*i*omega`, `s=+1` for
  the plus phasor and `s=-1` for the minus phasor, solve the doubled real system
  `[[L,s*omega*B],[-s*omega*B,L]] [x_r,x_i]^T = [B r_r,B r_i]^T` and expose
  its action as the `STShell` shift-invert operator. `apply()` and
  `apply_transpose()` are mandatory; no complex-PETSc alternative remains in
  this plan.
- [ ] Define `ComplexShiftSpec{sigma_real_per_s,
  sigma_imag_rad_per_s,phase}` and
  `RealBlockComplexShiftDiagnostics{linear_solve_status,iterations,
  relative_residual}` in `real_block_complex_shift.hpp`; all three SLEPc
  adapters consume these types.
- [ ] Change all three adapters together; sorting-only changes are forbidden.
- [ ] Record sigma real/imag, scalar build kind and transform kind; assert the
  requested axis at runtime.
- [ ] Add/run `just verify-fem-frequency-domain-complex-shift`, existing Poisson
  SLEPc/Schur gates and main native contract.

**Review checkpoint:** the target oracle selects the intended imaginary-axis
mode and artifacts expose the exact transform.

### Task 17: Solve only the finite Poisson-airbox dynamic pencil

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- Modify: `backends/fem/src/frequency_domain/dense_full_coupled_oracle.cpp`
- Create: `backends/fem/tests/frequency_domain/poisson_airbox_finite_pencil_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`
- Modify: `backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED full-descriptor-vs-Schur, injected algebraic/infinite mode,
  mean-zero-vs-pinned, Robin/Dirichlet-no-gauge and independent q/phi/gauge
  failure tests.
- [ ] Make BC-dependent Poisson inverse/augmented gauge solve own the algebraic
  elimination; solve `L_eff q=lambda B_qq q` only.
- [ ] Reconstruct phi/eta and certify separate scaled q/phi/gauge residuals;
  backend residual remains diagnostic and never caps the full residual.
- [ ] Record Poisson conditioning/iterations/nullspace/BC provenance.
- [ ] Run dense oracle, corrected SLEPc, Schur and main native managed gates.

**Review checkpoint:** infinite/gauge modes cannot enter the physical modal
Krylov space; full-state certification remains authoritative.

### Task 18: Assemble and route a real shared-domain P1 Poisson-airbox modal problem

**Files:**
- Create: `backends/fem/cpu/frequency_domain/mfem_poisson_airbox_modal_assembly.hpp`
- Create: `backends/fem/cpu/frequency_domain/mfem_poisson_airbox_modal_assembly.cpp`
- Create: `backends/fem/tests/frequency_domain/mfem_poisson_airbox_modal_assembly_test.cpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_modal_operator_payload.hpp`
- Modify: `backends/fem/cpu/frequency_domain/mfem_modal_operator_payload.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Modify: `crates/fullmag-runner/src/fem_eigen.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify: `examples/fem_eigen_k0_kittel_periodic_airbox.py`
- Modify: `scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py`
- Modify: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- Modify: `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Add RED manufactured Robin, Dirichlet and pure-Neumann P1 fixtures;
  magnetic source support, `H=-grad(phi)`, BC/gauge, full-vs-Schur,
  topology/material mismatch and “no expected Kittel frequency in input”.
- [ ] Assemble P, magnetic coupling, feedback, `A_qq` and `B_qq` on
  `Omega_m union Omega_air` from accepted LinearizationState and full periodic
  FE constraints.
- [ ] Retain the synthetic builder only as an explicitly named algebra oracle;
  route production K0 through real assembly and remove Kittel calibration from
  operator construction.
- [ ] Emit real assembly/mesh/BC/gauge/operator identities and fresh block
  residuals; reject stale/synthetic production artifacts.
- [ ] Require at least three mesh levels plus independent airbox-padding
  convergence; use Kittel only as external verification.
- [ ] Add/run `just verify-fem-frequency-domain-poisson-airbox-production`,
  existing K0 gates and main native contract.

**Review checkpoint:** production claim is earned only by real weak-form
assembly and convergence, not by a topology-shaped dense payload.

### Task 19: Make G5a a truthful, bounded dense GPU validation adapter

**Files:**
- Modify: `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`
- Modify: `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`
- Modify: `scripts/verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py`
- Modify: `scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py`
- Modify: `scripts/test_frequency_domain_runtime_targets.py`
- Modify: `docs/specs/capability-matrix-v0.md`

- [ ] Add RED schema tests rejecting the broad device-resident/scalable claim,
  production+validation contradiction and oversized dense problems.
- [ ] Publish explicit facts: prototype, validation-only, max 64 augmented DOF,
  single eigenpair, CUDA single-thread dense inverse iteration, one-shot
  allocation/transfers, no persistent context, no public production route.
- [ ] Check all `nq+np+1`, `n*n` and bytes before allocation; detect diagnostic
  truncation and clean partial CUDA allocation failures.
- [ ] Preserve full descriptor residual and CPU parity requirements.
- [ ] Run verifier tests and the managed G5a shift-invert/eigensolver gate.

**Review checkpoint:** passing G5a cannot promote general GPU modal support;
the separate cuSolverDN K0 macrospin scope remains unchanged.

### Task 20: Implement and qualify the persistent device-resident FGMRES lane

**Files:**
- Create: `backends/fem/gpu/cuda/frequency_domain/krylov/device_complex_blas.hpp`
- Create: `backends/fem/gpu/cuda/frequency_domain/krylov/device_complex_blas.cu`
- Create: `backends/fem/gpu/cuda/frequency_domain/krylov/device_fgmres.hpp`
- Create: `backends/fem/gpu/cuda/frequency_domain/krylov/device_fgmres.cu`
- Create: `backends/fem/tests/frequency_domain/device_fgmres_test.cu`
- Create: `scripts/verify_fem_frequency_domain_device_krylov_artifact.py`
- Create: `scripts/test_verify_fem_frequency_domain_device_krylov_artifact.py`
- Modify: `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`
- Modify: `backends/fem/src/frequency_domain/driven_response_solver.cpp`
- Modify: `backends/fem/include/frequency_domain/driven_response_solver.hpp`
- Modify: `native/include/fullmag_fem.h`
- Modify: `backends/fem/src/api.cpp`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify surgically: `backends/fem/CMakeLists.txt`, `justfile`

- [ ] Implement the selected architecture: a bounded repository-owned CUDA
  FGMRES engine. The decision is fixed because the managed PETSc build has no
  CUDA Vec/Mat support and hypre's available ParCSR FlexGMRES cannot consume
  the existing matrix-free `Aomega` without replacing the operator contract.
  Record this evidence and the exception to the library preference in
  `docs/adr/0017-frequency-domain-device-fgmres.md` before production code.
- [ ] Define in `device_fgmres.hpp` the exact entry point
  `FrequencyDomainStatus run_device_fgmres(const FGMRESDeviceStaticConfig&,
  const FGMRESDeviceSolveRequest&, FGMRESDeviceRunResult&) noexcept` and
  `DeviceFgmresWorkspaceLayout compute_device_fgmres_workspace_layout(
  uint64_t n,uint32_t restart,uint64_t byte_limit) noexcept`. The layout owns
  `V:n*(m+1)`, `Z:n*m`, `H:(m+1)*m`, rotations `m`, `g:m+1`, `y:m` and three
  n-vector work buffers; every offset comes from Task 2 checked arithmetic.
- [ ] Define device BLAS operations `copy`, `scal`, `axpy`, `dotc`, `nrm2`,
  double-MGS reduction and complex Givens in `device_complex_blas.hpp`; their
  stream is the static config stream and no operation performs host vector
  transfer.
- [ ] Add RED identity, nonsymmetric complex-block, restart `m=1`, multiple
  restarts, flexible right preconditioner, zero RHS, happy breakdown,
  nonconvergence/NaN/cancel/OOM and stale-signature tests.
- [ ] Implement persistent `V(n,m+1)`, `Z(n,m)`, `H(m+1,m)`, complex QR/Givens,
  double MGS or qualified library equivalent, restart, true-residual
  replacement and engine-generated telemetry.
- [ ] Keep vector/operator/preconditioner state on device. Bounded scalar
  control readbacks are recorded separately; no vector H2D/D2H per iteration
  and no hidden CPU fallback.
- [ ] Reuse the canonical pencil, term descriptors, frequency identity,
  checked workspace layout and safe callback contracts.
- [ ] Set `production_loop_available=true` only after Compute Sanitizer,
  CPU/PETSc parity, fresh artifact verification and the managed runtime gate.
- [ ] Add/run `just verify-fem-frequency-domain-device-krylov-runtime`, active
  GPU response gates and the broad runtime suite.

**Review checkpoint:** capability distinguishes host-Krylov/CUDA-operator from
qualified device FGMRES and publishes the exact validated scope.

### Task 21: Propagate the canonical request through Python, ProblemIR and planning

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `packages/fullmag-py/tests/test_api.py`
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/eigen_contract.rs`
- Modify: `crates/fullmag-ir/src/frequency_response_contract.rs`
- Modify: `crates/fullmag-ir/src/plan.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`

- [ ] Add Python round-trip tests named
  `test_dynamic_solver_roundtrip_preserves_single_phase_k_and_boundary()` and
  `test_dynamic_solver_rejects_conflicting_floquet_sources()`; RED is a lost
  or duplicated phase/k/boundary/drive field.
- [ ] Add Rust tests named
  `fem_dynamic_plan_preserves_requested_and_canonical_request()` and
  `fem_dynamic_plan_rejects_conflicting_operator_sources_before_backend()`;
  RED is precedence routing or missing requested intent.
- [ ] Keep physical authoring fields physics-first: one phase convention, one
  k-path/Floquet boundary reference, one drive, solver policy and execution
  intent. Operator/certificate digests are resolved plan/runtime fields, not
  user-authored knobs.
- [ ] Extend `FemEigenPlanIR` and `FemFrequencyResponsePlanIR` with the same
  canonical phase/k/boundary/source discriminants and requested/resolved
  fields; use versioned serde defaults and reject contradictory legacy input.
- [ ] Make `plan_fem_frequency_response()` and eigen planning fail before
  runtime when exact-one source or capability prerequisites are absent.
- [ ] Run:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_api.py
cargo test -p fullmag-ir
cargo test -p fullmag-plan fem_dynamic_plan -- --nocapture
git diff --check
```

**Review checkpoint:** Python export/import, ProblemIR and plan preserve one
canonical semantic request plus requested execution intent; no backend detail
leaks into public physics fields.

### Task 22: Propagate v13 runtime provenance, API resources and capabilities

**Files:**
- Modify: `crates/fullmag-runner/src/fem_eigen.rs`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/native_fem/eigen.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify: `crates/fullmag-runner/src/native_fem/tests/plan_contracts.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `frequency_domain/frequency_domain/manifest.v1.json`
- Modify: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- Modify: `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`
- Modify: `scripts/verify_fem_frequency_domain_runtime_artifacts.py`
- Modify: `scripts/test_verify_fem_frequency_domain_runtime_artifacts.py`

- [ ] Add runner tests named
  `frequency_artifact_preserves_requested_resolved_and_all_digests()` and
  `frequency_artifact_rejects_stale_certificate_or_fallback_mismatch()`; RED
  is missing identity or acceptance of stale/mislabelled evidence.
- [ ] Add API resource test
  `frequency_domain_manifest_exposes_versioned_provenance_without_status_bloat()`;
  RED is an unversioned field, reconstructed semantics or heavy payload in
  thin session status.
- [ ] Route new native calls only through ABI v13 and carry requested/resolved
  source, device, solver, fallback, operator/equilibrium/topology/constraint/
  certificate digests, residual kind, residency and validated scope into
  versioned artifacts.
- [ ] Keep API v2 resource-first: expose the versioned manifest/artifact
  fields from the central handler; do not add direct component endpoints or
  duplicate physics interpretation.
- [ ] Update both capability sources and runtime manifest cells only from the
  fresh managed artifacts produced by Tasks 18-20. Preserve explicit gated
  combinations and the narrow cuSolverDN macrospin exception.
- [ ] Run:

```text
cargo test -p fullmag-runner frequency_artifact -- --nocapture
cargo test -p fullmag-api frequency_domain -- --nocapture
python3 -m pytest -q scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
python3 -m pytest -q scripts/test_verify_fem_frequency_domain_runtime_artifacts.py
just resource-first-gates strict
git diff --check
```

**Review checkpoint:** runtime/API/capability state is derived from bounded
evidence and preserves requested versus resolved execution without widening a
narrow validation scope.

### Task 23: Close the A/DS ledger and run the complete managed evidence matrix

**Files:**
- Modify: `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`
- Modify: `docs/plans/active/fd_sovler_masterplan/documentation_manifest.json`
- Modify: `docs/plans/active/fd_sovler_masterplan/00_README_CANONICAL_FULL_READ.md`
- Create: `scripts/build_frequency_domain_masterplan_pack.py`
- Create: `scripts/test_build_frequency_domain_masterplan_pack.py`
- Regenerate: `docs/plans/active/fd_sovler_masterplan/fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md`
- Create: `docs/validation/2026-07-10-fem-dynamic-solver-remediation-evidence.md`
- Create: `docs/validation/2026-07-10-fem-dynamic-solver-remediation-ledger.json`
- Modify: `scripts/test_frequency_domain_math_contract_docs.py`

- [ ] Write the JSON ledger with exactly one row per `A-01..A-43` and one row
  per `DS-01..DS-27`. Required keys are `id`, `disposition`, `task`, `commit`,
  `regression_test`, `managed_gate`, `artifact`, `validated_scope` and
  `remaining_gate`. Allowed A dispositions are `fixed`, `partially_fixed`,
  `dormant_gated`, `refuted` and `not_applicable`; every non-`fixed` row must
  carry a precise remaining gate. DS-27 has one row referencing both local
  Task-19 substeps; suffixed DS identifiers are forbidden.
- [ ] Add a RED documentation test that fails on a missing/duplicate ID, empty
  evidence field for a fixed row, stale commit/artifact, capability scope wider
  than evidence or omission of plan 20 from the manifest/full pack.
- [ ] Rebuild the managed FEM runtime and run every new gate plus:

```text
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
just verify-fem-frequency-domain-cpu-floquet-runtime
just verify-fem-frequency-domain-gpu-floquet-runtime
just verify-fem-frequency-domain-static-periodic-runtime
just verify-fem-frequency-domain-free-demag-parity-runtime
just verify-fem-frequency-domain-gpu-static-periodic-parity-runtime
just verify-fem-frequency-domain-runtime-suite
```

- [ ] Reject stale artifacts and inspect every final artifact for build,
  operator, topology, constraint, certificate, solver and validated-scope
  provenance.
- [ ] Run `git diff --check`, task-wide sanitizer/Compute Sanitizer gates and
  the repository documentation contract tests.
- [ ] Dispatch one broad final scientific/code review over the complete task
  commit range; fix every Critical/Important finding and re-run its covering
  tests before final approval.

**Final definition of done:** all plan-20 conditions in section 13 hold; no
active public P0 remains; canonical pencil/request/units are the only semantic
source; ABI is size/exception safe; reduced response has original-operator
evidence; Poisson modal is real finite weak-form FEM; Floquet uses phase plus
frame transport and full topology; device FGMRES is genuinely qualified (or,
if Task 20 fails a qualification requirement after its implementation, the
public lane remains explicitly unavailable and the exact failed gate is stored
in the ledger rather than misrepresented); every
corresponding managed gate is green on fresh artifacts.
