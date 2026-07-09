# Real FEM Poisson-Airbox Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synthetic K0-3 periodic-airbox modal claim with a real,
shared-domain FEM Poisson-airbox eigensolve contract and correct all associated
physics, numerical certification and capability semantics.

**Architecture:** The existing synthetic PA-E1/PA-E4b payload stays an internal
algebra oracle. A new MFEM-owned assembler produces the existing block payload
from shared mesh, accepted equilibrium, BC policy and material fields. The
CPU selected-spectrum solver consumes those blocks through a real-split-aware
transform and reports blockwise full residuals. GPU remains explicitly gated
until it has a persistent device-resident selected-spectrum implementation.

**Tech Stack:** C++17, MFEM, PETSc/SLEPc, Rust runner/FFI, Python examples and
artifact verifiers, container-backed `just` managed FEM runtime.

## Global Constraints

- Preserve `exp_plus_i_omega_t`, `lambda=i omega`, fields in `A/m`, and
  public Cartesian complex mode artifacts.
- Never use Kittel reference data to construct a physical FEM operator.
- Assemble the scalar potential on `D=Omega_m union Omega_air`.
- Apply Robin only on open faces; periodic cuts are reduced constraints.
- Robin/Dirichlet use no gauge. Pure Neumann alone uses a mean-zero gauge.
- Reject fully periodic 3D k=0 and nonzero-k dynamic demag until real support
  exists.
- Native FEM builds and runtime proof use managed repository `just` recipes.
- A passing synthetic/algebraic test cannot set production capability or
  `production_periodic_airbox_claim=true`.
- Keep CPU/GPU lane names and capability artifacts honest.

---

### Task 1: Correct physics, documentation, and synthetic provenance

**Files:**
- Modify: `docs/physics/0700-frequency-domain-linearized-llg.md`
- Modify: `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
- Modify: `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/plans/active/fd_sovler_masterplan/19_eigensolve_frequency_driven_physics_numerics_audit.md`
- Test: `scripts/test_frequency_domain_math_contract_docs.py`

- [ ] Write RED assertions that reject a claim of real FEM assembly when
  `assembly_kind=synthetic_algebraic_oracle`, reject mean-zero gauge with Robin
  provenance, and require a fixed absorbed-power sign convention.
- [ ] Run the focused Python test and confirm failure on the old documentation.
- [ ] Add canonical Robin/Dirichlet/Neumann equations, `D` domain definition,
  synthetic provenance status and exact absorbed-power convention.
- [ ] Make the test green and run `git diff --check`.

### Task 2: Make gauge and provenance first-class in the internal block request

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify: FEM C ABI headers and Rust bindings that define
  `FullmagFemModalEigenRequest`
- Test: `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`
- Test: ABI layout tests under `crates/fullmag-fem-sys`

- [ ] Write RED tests for `robin -> gauge_policy=none`,
  `dirichlet -> gauge_policy=none`, and `pure_neumann -> mean_zero_augmented`.
- [ ] Extend the backend-only request with explicit outer BC, `robin_beta`,
  gauge policy/reason and `assembly_kind`; preserve ABI-version discipline.
- [ ] Reject unsupported combinations before SLEPc configuration.
- [ ] Run the native contract target through its managed `just` recipe.

### Task 3: Repair full descriptor residual certification

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`
- Test: `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`

- [ ] Write a RED fixture where a small SLEPc-reported residual and a bad
  reconstructed `phi` disagree; require certification failure.
- [ ] Replace `min(reconstructed, slepc)` with independent backend and full
  block residual fields.
- [ ] Implement `eps_q`, `eps_phi`, `eps_gauge`, and certify their maximum.
- [ ] Remove candidate-vector conjugation with unchanged eigenvalue.
- [ ] Run the focused contract target and assert the new fields in JSON.

### Task 4: Repair selected-spectrum targeting for real PETSc

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/spectral_transform.*`
- Test: `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`
- Test: `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp`

- [ ] Write a RED multi-mode pencil with two positive imaginary frequencies
  where real-axis `EPS_TARGET_MAGNITUDE(target_omega)` selects the wrong mode.
- [ ] Implement the chosen real-split representation of the complex shift
  `sigma=i omega_target`, or fail explicitly when the adapter cannot provide it.
- [ ] Record scalar mode and both shift coordinates in diagnostics.
- [ ] Run focused CPU modal contract tests through managed SLEPc runtime.

### Task 5: Add real shared-domain P1 modal block assembly

**Files:**
- Create: `backends/fem/cpu/frequency_domain/mfem_poisson_airbox_modal_assembly.hpp`
- Create: `backends/fem/cpu/frequency_domain/mfem_poisson_airbox_modal_assembly.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `backends/fem/cpu/frequency_domain/mfem_modal_operator_payload.*`
- Test: `backends/fem/tests/frequency_domain/mfem_poisson_airbox_modal_assembly_test.cpp`

- [ ] Write RED manufactured Robin and Dirichlet tests on a tiny shared-domain
  tetrahedral mesh; assert correct `P`, no gauge for Robin/Dirichlet, source
  support only on magnetic elements and feedback sign through `H=-grad(phi)`.
- [ ] Assemble `P`, `C`, feedback, `A_qq`, and `B_qq` from real mesh element
  geometry, material fields and accepted `LinearizationState`.
- [ ] Apply periodic reduction to magnetic and airbox scalar DOFs; exclude
  open-boundary mass from periodic faces.
- [ ] Add a Schur-vs-full descriptor equality test for assembled blocks.
- [ ] Run the new native test through a managed FEM target.

### Task 6: Route K0-3 to real assembly and demote PA-E4b

**Files:**
- Modify: `crates/fullmag-runner/src/fem_eigen.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- Test: Rust K0 tests in `crates/fullmag-runner/src/fem_eigen.rs`
- Test: `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`

- [ ] Write RED tests that reject K0-3 artifacts with
  `assembly_kind=synthetic_algebraic_oracle` or `production_periodic_airbox_claim=true`.
- [ ] Rename the synthetic builder and retain it only for explicit oracle tests.
- [ ] Build real K0-3 native payload from Task 5; do not pass expected Kittel
  frequency into the assembler or native solver.
- [ ] Emit `assembly_kind`, BC/gauge provenance, mesh/airbox DOFs and block
  residuals.
- [ ] Run Rust and Python focused tests.

### Task 7: Fix K0-3 fixture, equilibrium handoff and convergence verifier

**Files:**
- Modify: `examples/fem_eigen_k0_kittel_periodic_airbox.py`
- Modify: `scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py`
- Modify: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- Test: Python verifier tests

- [ ] Write RED tests requiring x/y periodic pairs, open-z BC provenance,
  accepted per-field equilibrium torque/norm metrics, at least three mesh
  levels, and independent z-padding data.
- [ ] Configure the ideal-film fixture with x/y PBC and use real Kittel only
  in the verifier.
- [ ] Require mode residual, uniformity, overlap, tangent leakage and seam
  mismatch thresholds instead of checking mere field presence.
- [ ] Run fixture-specific verifier tests, then the managed K0 CPU gate.

### Task 8: Correct driven-response mathematical observables

**Files:**
- Modify: `backends/fem/src/frequency_domain/driven_response_solver.cpp`
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp`
- Modify: `docs/physics/0700-frequency-domain-linearized-llg.md`
- Test: `backends/fem/tests/frequency_domain/driven_response_contract_test.cpp`

- [ ] Write RED macrospin tests for the `exp(+i omega t)` drive/RHS sign and
  positive absorbed power with positive Gilbert damping.
- [ ] Record true unpreconditioned residual and block-scaled residuals; do not
  publish tracked/preconditioned residual as convergence proof.
- [ ] Label susceptibility units as `delta_M / h_drive`.
- [ ] Run the driven-response contract target.

### Task 9: Keep non-k0 dynamic demag and GPU claims physically honest

**Files:**
- Modify: `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`
- Modify: GPU modal artifact verifiers under `scripts/`
- Modify: `docs/specs/capability-matrix-v0.md`
- Test: GPU descriptor/eigensolver artifact tests

- [ ] Write RED verifier tests that reject `gpu_device_resident_modal_eigensolver=true`
  for one-shot dense/host-assembled proof paths.
- [ ] Rename device one-shot labels to contract/apply provenance and preserve
  explicit GPU unavailability for real periodic-airbox modal solves.
- [ ] Require nonzero-k demag requests to fail with the dedicated
  `floquet_airbox` missing-operator reason.
- [ ] Run GPU artifact verifier tests; use a managed GPU gate only after CPU
  real assembly is green.

### Task 10: Promote only on real managed evidence

**Files:**
- Modify: active masterplan status files and capability matrix
- Modify: `docs/plans/active/fd_sovler_masterplan/19_eigensolve_frequency_driven_physics_numerics_audit.md`
- Test: documentation contract tests and managed `just` gates

- [ ] Run `just verify-fem-frequency-domain-native-contract`.
- [ ] Run the dedicated real K0-3 CPU managed gate and three-level convergence
  bundle once Task 7 provides it.
- [ ] Run the artifact verifiers against fresh outputs.
- [ ] Mark only evidence-backed items implemented/validated; retain all other
  work as explicit gated capability.
