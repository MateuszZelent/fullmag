# FEM K0 Dynamic-Demag CPU/GPU Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a real shared-domain FEM K0 dynamic-demagnetizing eigensolve on CPU and GPU, with certified residuals and managed runtime qualification.

**Architecture:** Native `backends/fem` owns weak-form block assembly, Schur reduction, selected-spectrum solve, and native mode vectors. The runner forwards only canonical requests and publishes results. CPU uses complex PETSc/SLEPc; GPU uses the same descriptor contract through persistent device-resident PETSc/hypre/SLEPc resources.

**Tech Stack:** C++20, MFEM, PETSc/SLEPc complex scalars, hypre, CUDA, Rust FFI/runner, Python fixtures, `just` managed containers.

## Global Constraints

- First qualified scope is P1, `alpha=0`, uniform fields, `k=0`, x/y periodic, open-z shared magnetic-plus-airbox domain.
- `delta_H_demag=-grad(delta_phi)` is the dynamic tangent; never reuse `H_demag0` as the tangent action.
- Robin/Dirichlet require no gauge; pure Neumann requires an explicit mean-zero augmented gauge.
- CPU/GPU share equations and residual certification, but not runtime state or hot loops.
- A forced GPU request never falls back to CPU.
- Dense and synthetic paths remain validation-only and cannot emit production claims.
- Native FEM proof uses repository-managed `just` recipes, not host-native commands.

---

### Task 1: Freeze the production request and artifact contract

**Files:**
- Modify: `backends/fem/include/frequency_domain/modal_eigen_request.hpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Test: `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp`
- Test: `crates/fullmag-fem-sys/src/lib.rs`

**Consumes:** Existing ABI v12 request and `PoissonAirboxEigenBlockProblem`.

**Produces:** A versioned native request with a real-assembly identity, accepted-equilibrium digest, boundary/gauge certificate, complex shift metadata, and explicit CPU/GPU execution target.

- [ ] **Step 1: Write failing ABI validation tests**

```cpp
request.poisson_airbox_assembly_kind = "mfem_weak_form_shared_domain";
request.poisson_airbox_equilibrium_digest = "accepted-equilibrium";
request.poisson_airbox_execution_target = "production_gpu";
expect_unavailable_without_required_shared_domain_payload(request);
expect_unavailable_for_gpu_without_device_modal_context(request);
```

- [ ] **Step 2: Run the focused contract target and verify RED**

Run: `just verify-fem-frequency-domain-native-contract`

Expected: the new tests fail because the ABI fields and rejection paths do not exist.

- [ ] **Step 3: Add append-only ABI fields and validation**

```cpp
const char *poisson_airbox_equilibrium_digest = nullptr;
const char *poisson_airbox_execution_target = nullptr;
double poisson_airbox_shift_sigma_real = 0.0;
double poisson_airbox_shift_sigma_imag = 0.0;
```

Require the exact assembly token `mfem_weak_form_shared_domain` for a production claim and reject an absent accepted-equilibrium digest.

- [ ] **Step 4: Mirror layout in the C ABI and Rust bindings**

Use the same append-only field order in `fullmag_fem_modal_eigen_request` and its `repr(C)` Rust counterpart. Extend the offset/size assertions for every new field.

- [ ] **Step 5: Run focused ABI and contract tests to GREEN**

Run: `just verify-fem-frequency-domain-native-contract`

Expected: all ABI layout and modal contract tests pass.

- [ ] **Step 6: Commit**

```bash
git add backends/fem/include/frequency_domain/modal_eigen_request.hpp backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp native/include/fullmag_fem.h crates/fullmag-fem-sys/src/lib.rs backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp
git commit -m "feat: define production K0 modal request contract"
```

### Task 2: Assemble real MFEM shared-domain Poisson and coupling blocks

**Files:**
- Create: `backends/fem/cpu/frequency_domain/mfem_poisson_airbox_modal_assembly.hpp`
- Create: `backends/fem/cpu/frequency_domain/mfem_poisson_airbox_modal_assembly.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Test: `backends/fem/tests/frequency_domain/mfem_poisson_airbox_modal_assembly_test.cpp`

**Consumes:** Accepted mesh, material, tangent frame, equilibrium, and boundary certificate from Task 1.

**Produces:** CSR views for `A_qq`, `A_qphi`, `A_phiq`, `P`, and `B_qq`, plus exact boundary/gauge metadata.

- [ ] **Step 1: Write manufactured weak-form tests**

```cpp
const auto robin = assemble_fixture(OuterBoundary::robin, 1.0);
check(robin.gauge_policy == GaugePolicy::none, "Robin must not add a gauge");
check(robin.poisson_rhs_sign_matches_negative_grad_phi(), "demag sign");

const auto neumann = assemble_fixture(OuterBoundary::neumann, 0.0);
check(neumann.gauge_policy == GaugePolicy::mean_zero_augmented, "Neumann gauge");
```

- [ ] **Step 2: Run the new native target and verify RED**

Run: `just verify-fem-frequency-domain-native-contract`

Expected: compilation fails because the shared-domain assembler and test target are absent.

- [ ] **Step 3: Implement the MFEM block owner**

```cpp
P = assemble_scalar_laplacian(shared_domain) + robin_boundary_mass(beta);
A_phiq = assemble_ms_divergence_of_tangent_magnetization(m0, ms, tangent_frame);
A_qphi = assemble_negative_gradient_potential_torque(m0, gamma0, tangent_frame);
```

Assemble only from the actual shared-domain FE spaces. Eliminate Dirichlet DOFs, create mean-zero data only for pure Neumann, and attach mesh/material/boundary digests to the result.

- [ ] **Step 4: Register and run the assembly target to GREEN**

Run: `just verify-fem-frequency-domain-native-contract`

Expected: manufactured Robin, Dirichlet, and Neumann cases pass with independent sign assertions.

- [ ] **Step 5: Commit**

```bash
git add backends/fem/cpu/frequency_domain/mfem_poisson_airbox_modal_assembly.* backends/fem/tests/frequency_domain/mfem_poisson_airbox_modal_assembly_test.cpp backends/fem/CMakeLists.txt
git commit -m "feat: assemble shared-domain K0 modal demag blocks"
```

### Task 3: Certify Schur reduction and original descriptor residuals

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Test: `backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp`
- Test: `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`

**Consumes:** Real blocks from Task 2.

**Produces:** A finite-q Schur operator, reconstructed potential/gauge, and blockwise original residual certificate.

- [ ] **Step 1: Write a descriptor-versus-Schur failing test**

```cpp
const auto result = solve_real_shared_domain_fixture();
check(result.assembly_kind == "mfem_weak_form_shared_domain", "real assembly");
check(result.magnetic_block_backward_error < 1e-10, "q residual");
check(result.poisson_block_backward_error < 1e-10, "phi residual");
check(result.gauge_constraint_backward_error < 1e-10, "gauge residual");
```

- [ ] **Step 2: Verify RED**

Run: `just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell`

Expected: the production assembly is rejected or reports synthetic-only provenance.

- [ ] **Step 3: Implement finite descriptor reduction**

```cpp
phi = solve_poisson_or_augmented_gauge(P, -A_phiq * q);
L_eff_q = A_qq * q + A_qphi * phi;
```

Never insert algebraic modes into the eigenspace. Reconstruct `phi` after each accepted eigenvector and calculate residual norms from the original blocks, not `EPSComputeError`.

- [ ] **Step 4: Verify GREEN**

Run: `just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell`

Expected: descriptor/Schur parity and all block residual tests pass.

- [ ] **Step 5: Commit**

```bash
git add backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp backends/fem/tests/frequency_domain/poisson_airbox_*
git commit -m "feat: certify K0 modal Schur residuals"
```

### Task 4: Implement exact imaginary-axis selected-spectrum targeting on CPU

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Modify: managed PETSc/SLEPc image configuration discovered in `native/` or container build files
- Test: `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`
- Test: `scripts/test_frequency_domain_runtime_targets.py`

**Consumes:** Schur operator and certified real blocks.

**Produces:** Complex-scalar `sigma=i*omega_target`, explicit scalar-build diagnostics, and an unavailable result if the complex runtime is absent.

- [ ] **Step 1: Add the wrong-axis regression test**

```cpp
const auto result = solve_pair_spectrum({+i * omega1, +i * omega2}, omega2);
check_near(result.frequency_hz, omega2 / (2.0 * M_PI), 1e-10);
```

The test must fail against `EPSSetTarget(target_angular_frequency)` on a real scalar build.

- [ ] **Step 2: Verify RED**

Run: `just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc`

Expected: target selection returns the real-axis-nearest or wrong mode.

- [ ] **Step 3: Configure complex scalar SLEPc and set the typed shift**

```cpp
const PetscScalar sigma = PetscCMPLX(0.0, omega_rad_s_from_frequency_hz(target_hz));
STSetType(st, STSINVERT);
EPSSetTarget(eps, sigma);
```

Record `sigma_real`, `sigma_imag`, `scalar_build_kind="complex"`, and `spectral_transform="shift_invert"` in diagnostics and artifacts.

- [ ] **Step 4: Verify GREEN through the managed container**

Run: `just rebuild-fem-runtime && just ensure-managed-fem-runtime && just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc`

Expected: the target-pair regression and existing SLEPc tests pass in the managed complex runtime.

- [ ] **Step 5: Commit**

```bash
git add backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp native scripts/test_frequency_domain_runtime_targets.py
git commit -m "feat: target K0 modes on the imaginary axis"
```

### Task 5: Route real K0 production through native FEM and remove false artifacts

**Files:**
- Modify: `crates/fullmag-runner/src/fem_eigen.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- Test: `crates/fullmag-runner/src/fem_eigen.rs`
- Test: `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`

**Consumes:** Native real assembler and CPU solver.

**Produces:** A runner that forwards canonical K0 inputs, persists only native modes, and reports CPU production provenance truthfully.

- [ ] **Step 1: Add failing runner/artifact tests**

```rust
assert_eq!(artifact.assembly_kind, "mfem_weak_form_shared_domain");
assert!(artifact.mode_vector_origin == "native_modal_solver");
assert_ne!(artifact.mode_vector_origin, "runner_synthetic_fallback");
```

- [ ] **Step 2: Verify RED**

Run: `cargo test -p fullmag-runner fem_eigen -- --nocapture`

Expected: the existing K0-3 route reports `synthetic_algebraic_oracle` or synthesizes a mode vector.

- [ ] **Step 3: Replace runner assembly with forwarding**

```rust
let native = native_fem::solve_modal_eigen(NativeModalRequest::from(plan, equilibrium, mesh)?);
let modes = native.require_certified_modes()?;
```

Delete the production-path fallback that makes a uniform complex vector when native output is absent. Preserve the standalone synthetic oracle only under explicit validation-only routing.

- [ ] **Step 4: Verify GREEN**

Run: `cargo test -p fullmag-runner fem_eigen -- --nocapture && python3 -m unittest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`

Expected: a real production artifact is required to contain native mode payloads and complete residual provenance.

- [ ] **Step 5: Commit**

```bash
git add crates/fullmag-runner/src/fem_eigen.rs crates/fullmag-runner/src/native_fem/frequency_domain.rs crates/fullmag-plan/src/fem.rs scripts/verify_fem_frequency_domain_eigen_artifacts.py scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
git commit -m "feat: route K0 demag modes through native FEM"
```

### Task 6: Build the persistent GPU K0 modal owner

**Files:**
- Create: `backends/fem/gpu/cuda/frequency_domain/modal_krylov.hpp`
- Create: `backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu`
- Modify: `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`
- Modify: `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Test: `backends/fem/tests/frequency_domain/gpu_modal_krylov_test.cpp`

**Consumes:** The canonical Schur operator, GPU demag backend, and Task 1 execution target.

**Produces:** A dedicated persistent GPU modal solve that never reuses the one-shot dense driven-response oracle.

- [ ] **Step 1: Write residency and parity tests**

```cpp
const auto gpu = solve_gpu_k0_real_demag(fixture);
check(gpu.persistent_solver_context, "persistent context");
check(gpu.full_vector_transfers_per_iteration == 0, "no iterative H2D/D2H");
check_near(gpu.frequency_hz, cpu.frequency_hz, 1e-7 * cpu.frequency_hz);
check(gpu.full_residual_certified, "GPU full residual");
```

- [ ] **Step 2: Verify RED**

Run: `just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu-gated`

Expected: the current strict GPU K0 demag rejection proves no production GPU solver exists.

- [ ] **Step 3: Implement a dedicated modal context**

```cpp
struct GpuK0ModalContext {
  PetscObjectState mesh_and_operator_signature;
  DeviceVectors krylov_basis;
  DevicePoissonSchurApply demag_apply;
  PetscEPS eps;
};
```

Own device vectors, operator/preconditioner, Krylov basis, restart/locking state, cancellation, and transfer telemetry here. Remove modal code from `driven_response_gpu.cu`; retain only driven-response ownership there.

- [ ] **Step 4: Implement GPU spectral solve and certification**

Use device-capable PETSc `MatShell`/`MatNest`, hypre device preconditioning, and SLEPc EPS with the same complex shift as CPU. Reconstruct and certify the descriptor residual using device data, copying only bounded scalar diagnostics.

- [ ] **Step 5: Verify GREEN**

Run: `just rebuild-fem-runtime && just ensure-managed-fem-runtime && just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu`

Expected: GPU K0 demag succeeds with CPU parity, a persistent context, and no CPU fallback.

- [ ] **Step 6: Commit**

```bash
git add backends/fem/gpu/cuda/frequency_domain/modal_krylov.* backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu backends/fem/src/frequency_domain/modal_eigen_solver.cpp backends/fem/tests/frequency_domain/gpu_modal_krylov_test.cpp backends/fem/CMakeLists.txt
git commit -m "feat: add persistent GPU K0 modal eigensolve"
```

### Task 7: Promote planner, capability, diagnostics, and managed runtime gates

**Files:**
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `docs/specs/frequency-domain-artifacts-v2.md`
- Modify: `justfile`
- Create: `examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py`
- Create: `scripts/verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py`
- Modify: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- Test: `scripts/test_frequency_domain_runtime_targets.py`

**Consumes:** Certified CPU and GPU results.

**Produces:** Honest `production_qualified` capability only for the verified K0 scope and focused managed evidence gates.

- [ ] **Step 1: Write failing promotion tests**

```python
assert artifact["assembly_kind"] == "mfem_weak_form_shared_domain"
assert artifact["residency"]["persistent_solver_context"] is True
assert artifact["requested_execution"] == artifact["resolved_execution"] == "production_gpu"
```

- [ ] **Step 2: Verify RED**

Run: `python3 -m unittest scripts/test_frequency_domain_runtime_targets.py scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`

Expected: existing recipes require GPU rejection and capability matrix still names K0 CPU/GPU as unvalidated.

- [ ] **Step 3: Add focused managed recipes**

```just
verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu:
    just rebuild-fem-runtime
    just ensure-managed-fem-runtime
    # run K0-3 at three mesh/airbox levels and verify fresh artifacts

verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu:
    just rebuild-fem-runtime
    just ensure-managed-fem-runtime
    # run the same fixture and verify CPU/GPU parity plus residency telemetry
```

Replace the previous GPU-gated-rejection recipe with a success proof only when its negative control remains available as a separate forced-missing-prerequisite test.

- [ ] **Step 4: Verify GREEN**

Run: `just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu && just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu`

Expected: independent Kittel/convergence, CPU/GPU parity, and residency verifiers pass on fresh artifacts.

- [ ] **Step 5: Commit**

```bash
git add docs/specs/capability-matrix-v0.* docs/specs/frequency-domain-artifacts-v2.md justfile examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py scripts
git commit -m "feat: qualify K0 modal demag CPU and GPU"
```

### Task 8: Perform final managed evidence audit

**Files:**
- Modify: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- Modify: `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`
- Modify: `docs/physics/0600-fem-eigenmodes-linearized-llg.md`
- Modify: `docs/architecture/backend-golden-masterplan.md`
- Test: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`

**Consumes:** Passing Task 1–7 gates.

**Produces:** Documentation, capabilities, planner, artifacts, and runtime claims with identical qualified scope.

- [ ] **Step 1: Run the complete evidence sequence**

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just inspect-managed-fem-frequency-domain-deps
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu
```

- [ ] **Step 2: Check the production claims directly**

```bash
rg -n "synthetic_algebraic_oracle|production_qualified|gpu_device_resident" docs/specs docs/physics crates/fullmag-plan crates/fullmag-runner backends/fem
```

Expected: synthetic wording remains only under explicit validation-only paths; qualified K0 CPU/GPU claims name the exact P1/alpha-zero/boundary scope.

- [ ] **Step 3: Commit**

```bash
git add docs/physics/0830-fem-poisson-airbox-modal-eigen.md docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md docs/physics/0600-fem-eigenmodes-linearized-llg.md docs/architecture/backend-golden-masterplan.md
git commit -m "docs: record qualified K0 modal demag lanes"
```
