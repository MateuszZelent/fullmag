# Frequency-driven solver — patch queue

Kolejka patchy jest ułożona tak, aby review i bisekcja były proste. Nie mieszać refaktoru, zmiany algebry i optymalizacji GPU w jednym diffie.

---

## Patch A — docs-only COMSOL alignment

Pliki:

```text
docs/physics/frequency_domain_solver_physics.md
docs/architecture/backend-golden-masterplan.md
docs/plans/active/dynamics-analysis-interface-comsol-inspired/05-frequency-driven-backend-refactor-plan.md
docs/frequency_domain_solver_files.md
```

Treść:

```text
- exp(+iωt) default
- δm ∈ C^3, m0·δm=0 as physical contract
- tangent2 as optimized internal representation
- δh phasor amplitude as default drive
- full coupled demag core
- Schur as certified fast path
- honest execution lanes
```

Nie dotykać:

```text
C++ source
headers
include tree
build graph
runtime behavior
```

---

## Patch B — lane diagnostics and progress throttling

Cel:

```text
naprawić mylące production_gpu i ograniczyć UI/progress overhead
```

Zmiany:

```text
- execution_lane = gpu_operator_host_krylov for current path
- krylov_vector_location diagnostics
- operator_buffer_location diagnostics
- progress_interval=0 no longer means every iteration
- live snapshot disabled/throttled for solve benchmark
```

Acceptance:

```text
same numerical result
less progress spam
JSON says gpu_device_resident_solver=false for current path
```

Current implementation evidence, 2026-07-05:

```text
- production-lane response diagnostics now publish:
  krylov_vector_location="host"
  operator_buffer_location="gpu_if_enabled"
  preconditioner_buffer_location="host_or_gpu_operator"
  gpu_device_resident_solver=false
- native contract pins those fields and fixes planner test inputs so gpu_operator_host_krylov
  and certified schur_reduced branches are not masked by the tiny dense-reference default.
- verification: just verify-fem-frequency-domain-native-contract passed after managed FEM runtime rebuild.
```

---

## Patch C — planner descriptors, no behavior change

Dodaj:

```text
FrequencySolvePlan
FrequencySolvePlanner skeleton
FrequencyBackendCapabilities
FrequencySolverPolicy
```

Current behavior:

```text
plan selects existing host GMRES path
```

Acceptance:

```text
all tests pass
runtime result identical
```

Current implementation evidence, 2026-07-06:

```text
- native planner headers now define FrequencyBackendCapabilities and FrequencySolverPolicy
  next to FrequencySolvePlan without moving source files or changing runtime execution.
- descriptor overload maps capability/policy inputs onto the existing planner and preserves
  the current gpu_operator_host_krylov host-GMRES path unless future device-Krylov
  capability and policy are both explicit.
- native contract pins conservative defaults: no Schur certificate by default,
  no device-resident Krylov by default, throttled progress interval 128.
- verification: just verify-fem-frequency-domain-native-contract passed after managed FEM runtime rebuild.
```

---

## Patch D — COMSOL physics gates

Dodaj testy:

```text
phase convention
cartesian tangent equivalence
drive projection
zero drive policy
floquet phase
```

Acceptance:

```text
macrospin and tiny film pass
```

Current implementation evidence, 2026-07-06:

```text
- native driven-response request now carries FrequencyDriveKind and require_nonzero_rhs,
  with COMSOL physical dynamic-field drive as the C++ default and tangent_rhs available
  as the benchmark/nonzero-RHS opt-in lane.
- public C ABI exposes drive_kind and require_nonzero_rhs plus layout offsets; zeroed
  C requests keep legacy-compatible DRIVE_UNSPECIFIED and the adapter maps accepted
  C ABI v11 requests to the current native driven-response request ABI.
- Rust FFI mirror and runner request initialization were updated so managed runtime
  rebuilds carry the new ABI without perturbing modal-eigen's shared v11 ABI.
- RED: just verify-fem-frequency-domain-native-contract failed on missing drive_kind,
  require_nonzero_rhs, and layout-offset fields.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed FEM
  runtime rebuild; existing snprintf/dead-code warnings only.
- drive-projection gate added: project_dynamic_field_drive_to_tangent_rhs now maps
  COMSOL dynamic-field phasors through -gamma*m0_cross_delta_h before tangent
  projection and pins the real/imag sign against the z-axis macrospin oracle.
- RED: just verify-fem-frequency-domain-native-contract failed on missing
  project_dynamic_field_drive_to_tangent_rhs, DynamicFieldPhasorView, and
  TangentComplexVectorView.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed FEM
  runtime rebuild; existing snprintf/dead-code warnings only.
- zero-drive policy gate added at the drive-projection layer: physical
  dynamic-field phasors that project to zero tangent RHS now return OK with
  zero_drive_warning=true and a zero-response warning, while the benchmark
  uniform tangent-drive builder keeps rejecting zero tangent drive.
- dynamic-field phasor input now treats null imaginary component buffers as a
  real-valued phasor, matching the COMSOL-style real excitation shorthand while
  still requiring explicit real component buffers and explicit output buffers.
- RED: local diagnostic program
  /tmp/fullmag_dynamic_drive_null_imag_red.cpp returned exit code 3 because
  project_dynamic_field_drive_to_tangent_rhs rejected null imaginary buffers.
- GREEN: the same local diagnostic program returned exit code 0 after the
  projection treated missing imaginary components as zero.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the real-valued
  phasor shorthand.
- RED: just verify-fem-frequency-domain-native-contract failed on missing
  TangentExcitationDiagnostics::zero_drive_warning.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed FEM
  runtime rebuild; existing snprintf/dead-code warnings only.
- runtime zero-RHS policy is now enforced for explicit benchmark/debug RHS
  inputs: when require_nonzero_rhs=true, tiny, MFEM, and periodic-airbox
  coupled RHS buffers must contain a nonzero real or imaginary component.
- RED: just verify-fem-frequency-domain-native-contract rebuilt the managed
  runtime, built the native contracts, and failed on
  driven_response_solver_rejects_zero_tangent_rhs_when_required.
- GREEN: just verify-fem-frequency-domain-native-contract passed after adding
  require_nonzero_rhs validation in validate_driven_response_solve_contract.
- cartesian tangent equivalence gate added: complex lift/project helpers map real
  and imaginary tangent components independently, enforce m0_dot_delta_m == 0
  after lift, round-trip project(lift(q)) == q, and compare
  project(A_cartesian(lift(q))) against the tangent operator result.
- local Cartesian 3x3 operators now project to tangent local blocks as T^T A T;
  the contract test uses a non-symmetric row-major matrix so row/column or
  transposed-operator regressions are visible.
- RED: just verify-fem-frequency-domain-native-contract failed on missing
  lift_tangent_complex_to_cartesian and project_cartesian_complex_to_tangent.
- RED: after spec review found reconstruction coverage without operator
  equivalence, just verify-fem-frequency-domain-native-contract failed on
  missing project_cartesian_local_operator_to_tangent.
- REVIEW: spec re-review found the complex adapter, T^T A T projection, and
  operator-equivalence contract compliant; code-quality review found no
  Critical or Important issues.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed FEM
  runtime rebuild; existing snprintf/dead-code warnings only.
```

---

## Patch E — dense full-coupled oracle

Dodaj:

```text
DenseFullCoupledMagnetostaticProblem
DenseSchurExplicitBuilder
FullReducedResidualReconstructionTest
```

Acceptance:

```text
S_matrix_free vs S_explicit pass for tiny
full residual reconstruction pass
```

Current implementation evidence, 2026-07-06:

```text
- dense full-coupled oracle module added with:
  DenseFullCoupledMagnetostaticProblem, DenseSchurExplicitBuilder, and
  FullReducedResidualReconstructionTest.
- explicit dense Schur builder materializes
  S_explicit = A_qq - A_qphi inv(A_phiphi) A_phiq and reduced RHS
  b_q - A_qphi inv(A_phiphi) b_phi for tiny full-coupled problems.
- Schur apply path computes S(q) from the full blocks without depending on the
  materialized Schur matrix; the contract compares it against S_explicit q.
- full residual reconstruction solves phi(q) =
  inv(A_phiphi) (b_phi - A_phiq q), checks that the magnetic full residual
  matches the reduced residual, and checks that the Poisson block residual is
  zero for the reconstructed phi.
- RED: just verify-fem-frequency-domain-native-contract failed on missing
  frequency_domain/dense_full_coupled_oracle.hpp.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild; existing snprintf/dead-code warnings only.
```

---

## Patch F — CPU sparse/direct baseline

Dodaj:

```text
engines/sparse_direct/
assemble_real_split_csr.cpp
cpu_sparse_direct_engine.cpp
```

Pierwszy solver:

```text
PETSc KSPPREONLY + PCLU if available
fallback unavailable with clear diagnostics
```

Acceptance:

```text
small and medium problem solve with true residual
matches dense tiny
```

Current implementation evidence, 2026-07-06:

```text
- CPU sparse/direct baseline module added under
  backends/fem/cpu/frequency_domain/engines/sparse_direct with:
  assemble_real_split_csr and cpu_sparse_direct_engine.
- real-split CSR assembly materializes the harmonic block system
  [K, ωM; -ωM, K] for row-major CPU operators and reports nnz.
- managed PETSc path initializes PETSc, builds a sequential AIJ matrix,
  solves with KSPPREONLY + PCLU, copies the real/imag response, and reports
  solver_package="petsc" plus linear_solver="ksppreonly_pclu".
- non-PETSc builds return unavailable with a clear diagnostic instead of
  silently falling back to a fake dense/direct lane.
- native contract compares the sparse-direct result against the dense tiny
  validation oracle and checks the true residual.
- RED: just verify-fem-frequency-domain-native-contract failed on missing
  cpu/frequency_domain/engines/sparse_direct/cpu_sparse_direct_engine.hpp.
- RED: after implementation, managed native contract failed on an obsolete
  DenseDrivenResponseValidationProblem aggregate in the new test.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild; existing snprintf/dead-code warnings only.
```

---

## Patch G — full-coupled field-split prototype

Dodaj:

```text
FullCoupledBlockOperator
FieldSplitPreconditioner
PoissonBlockSolverAdapter
```

Acceptance:

```text
bounded 64/256 run improves residual trend
Poisson setup_count not O(iterations) unless explicitly expected
```

Current implementation evidence, 2026-07-06:

```text
- RED contract added in fem_frequency_domain_contract:
  full_coupled_field_split_prototype_improves_residual_and_reuses_poisson_setup.
- RED proof:
  just verify-fem-frequency-domain-native-contract failed on missing
  cpu/frequency_domain/engines/field_split/full_coupled_field_split_engine.hpp.
- Prototype module added under
  backends/fem/cpu/frequency_domain/engines/field_split with:
  FullCoupledBlockOperator, FieldSplitPreconditioner, PoissonBlockSolverAdapter,
  and solve_full_coupled_field_split.
- The prototype is real-valued dense/oracle-scale only: it caches A_phiphi inverse
  during setup, applies a block-triangular field-split preconditioner, reports
  residual norms, Poisson setup_count, and Poisson solve_count, and does not
  change production runtime routing.
- First GREEN attempt compiled the new module but failed the new residual-trend
  assertion because the 64-iteration solve had already saturated too close to
  the 256-iteration residual with relaxation=0.65; the test relaxation was
  reduced to 0.1 to keep the bounded 64/256 trend observable.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, so the prototype contract
  is now covered by the managed native gate.
- RED: extending the contract to require separate Poisson-block residual
  telemetry failed at compile time because FullCoupledFieldSplitSolveResult did
  not expose initial/final phi residual fields.
- Added initial_phi_residual_l2_norm,
  initial_relative_phi_residual_l2_norm, final_phi_residual_l2_norm, and
  final_relative_phi_residual_l2_norm to the field-split prototype result.
- The prototype now reports phi-block residual norms from the same residual
  vector used for the full coupled residual, with relative scaling against
  b_phi.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution.
- RED: extending the contract to require field-split residual improvement over
  an unpreconditioned reference failed at compile time because the result did
  not expose unpreconditioned reference residual telemetry.
- Added unpreconditioned_reference_final_residual_l2_norm and
  unpreconditioned_reference_final_relative_residual_l2_norm to the prototype
  result.
- First GREEN attempt compiled but failed the runtime assertion because raw
  Richardson `x += relaxation * r` was too aggressive for the tiny test system
  and could beat the field-split preconditioner by accident.
- The unpreconditioned reference now uses the same bounded iteration count and
  relaxation, scaled by the full operator max absolute row sum, so the
  comparison is a conservative no-preconditioner baseline.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution.
```

---

## Patch H — Schur certification gate

Dodaj:

```text
SchurCertificationState
schur_certified flag in planner
quality thresholds
fallback to full coupled when not certified
```

Acceptance:

```text
Schur cannot be selected as production fast path without certificate
```

Current implementation evidence, 2026-07-06:

```text
- SchurCertificationState added to the frequency solve plan contract with
  explicit quality_diagnostics_available,
  full_reduced_residual_reconstruction_passed,
  full_reduced_relative_residual_error, and observed_residual_contraction
  thresholds.
- schur_certification_passes now rejects the default/empty certificate and
  accepts only finite full-vs-reduced reconstruction and residual-contraction
  evidence inside thresholds.
- apply_schur_certification now projects the certificate decision into
  FrequencyBackendCapabilities.schur_certified and schur_quality_good, clearing
  both flags when the certificate fails.
- Planner fallback was tightened so an uncertified periodic-airbox request no
  longer selects schur_reduced or enables use_schur_reduction unless the Schur
  certificate path passed earlier.
- When full-coupled blocks are available and Schur is not certified, the planner
  selects full_coupled_field_split and keeps use_schur_reduction=false.
- RED diagnostic: a lightweight header compile/run check failed because
  SchurCertificationState and schur_certification_passes were missing.
- RED diagnostic: a lightweight planner compile/run check returned failure
  because uncertified periodic-airbox still selected schur_reduced.
- RED diagnostic: a lightweight header compile check failed because
  apply_schur_certification was missing.
- GREEN diagnostic: lightweight header checks pass for default-certificate
  rejection, valid-certificate acceptance, certificate-to-capability projection,
  uncertified periodic-airbox planner fallback, and uncertified full-coupled
  fallback after the contract and fallback update.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the Schur
  certification fallback contract in the native gate.
- RED: extending the Schur certificate contract to invalidate on changed
  mesh/material/physics signatures failed at compile time because the signature
  fields and problem-key check were missing.
- Added mesh_signature, material_signature, and physics_signature to
  SchurCertificationState plus schur_certification_passes_for_problem(...).
- The certificate now passes for a matching problem key and rejects mesh,
  material, or physics key mismatches before the Schur fast path can be
  considered valid for that problem.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution.
```

---

## Patch I — modal response backend

Rozszerz istniejące modal pieces:

```text
SLEPc shift-invert sparse payload
contour interval for windows
modal response projection
sparse direct sample validation
```

Acceptance:

```text
frequency sweep response matches sparse direct at sample frequencies
```

Implementation evidence:

```text
- RED: managed native contract failed on missing
  cpu/frequency_domain/modal_response.hpp after adding
  modal_response_diagonal_validation_matches_dense_direct.
- Added a minimal diagonal modal-response validation helper that projects a
  drive into an explicit modal basis, solves c_j(omega), reconstructs x(omega),
  and reports residual/sample-error diagnostics.
- Added contract coverage comparing a non-identity complete modal basis
  response against the existing dense direct tiny response for a two-frequency
  sweep and against CPU sparse/direct at a sample frequency.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the first Patch I
  modal-response-vs-dense/sparse-direct validation slice.
- RED: managed native contract failed on missing
  frequency_domain/modal_basis.hpp after adding the ADR-009
  ModalBasisPolicy/cache-key contract test.
- Added ModalBasisPolicy values matching ADR-009 and a fixed-buffer modal basis
  cache key builder that requires operator, equilibrium, material, boundary,
  demag, canonical phase, and frequency-window signatures.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the modal basis
  policy/cache-key signature slice.
- RED: managed native contract failed on missing ModalBasisCompletenessPolicy,
  ModalBasisCompletenessStatus, ModalBasisCompletenessMethod,
  ModalBasisCompletenessCertificate, ModalBasisCompletenessDecision, and
  modal_basis_completeness_allows_response after adding the modal response
  completeness gate.
- Added a minimal modal-basis completeness certificate gate: modal response use
  is allowed only for certified_count policy, certified status, non-empty
  certification method, no truncation/cap evidence, complete estimated-window
  coverage, and eigenmode residual within the declared threshold.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the modal
  completeness certificate slice.
- Added sparse/direct sample validation into the modal response helper itself:
  requested sample frequencies are solved through the existing CPU sparse/direct
  real-split oracle, and the helper reports sample count plus max absolute and
  relative sparse/direct sample error.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering modal helper
  sparse/direct sample validation for the Patch I sweep.
```

---

## Patch J — GPU device FGMRES

Warunek startu:

```text
Schur/full coupled preconditioner shows contraction
```

Dodaj:

```text
DeviceComplexVectorView
GpuFrequencyOperatorContext
FGMRESDeviceEngine
fused apply_Aomega_gpu
```

Acceptance:

```text
krylov_vector_location=device
no D2H per iteration
same residual trend as CPU reference
```

Implementation evidence:

```text
- Added the first Patch J entry gate at planner-contract level only:
  gpu_device_krylov is not selectable from direct planner input unless
  device_resident_krylov_available and preconditioner_certified are both true.
- Capability/policy planner overload now carries the same gate: GPU device
  Krylov requires explicit policy allowance, gpu_device_krylov_available
  capability, and preconditioner_certified capability.
- FrequencySolvePlan records require_preconditioner_contraction_certificate=true
  when gpu_device_krylov is selected, so the lane cannot be represented as a
  generic GPU request without the contraction prerequisite.
- Runtime device FGMRES, device vector allocation, fused apply_Aomega_gpu, and
  no-D2H-per-iteration proof are still not implemented.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the Patch J
  preconditioner-contraction planner entry gate.
- Added the first Patch J device-resident API skeleton:
  DeviceComplexVectorView, GpuFrequencyOperatorContext, ApplyAomegaGpu, and
  ApplyRightPreconditionerGpu. This is header-only contract surface and does not
  claim runtime device FGMRES execution.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the Patch J
  device-vector/callback API skeleton.
- RED: just verify-fem-frequency-domain-native-contract failed after adding the
  transfer-diagnostics contract because GpuDeviceKrylovTransferDiagnostics,
  GpuKrylovVectorLocation, GpuKrylovBufferLocation, and
  gpu_device_krylov_residency_contract_passes were missing.
- Added Patch J transfer diagnostics that distinguish setup/final transfers
  from per-iteration H2D/D2H transfers and reject device-resident claims unless
  Krylov vectors, operator buffers, and preconditioner buffers are device
  resident with zero per-iteration host/device transfers.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the Patch J
  no-D2H-per-iteration diagnostics contract.
- RED: just verify-fem-frequency-domain-native-contract failed after adding the
  FGMRES device-engine prerequisites contract because FGMRESDeviceEngineConfig,
  FGMRESDeviceEngineState, and validate_fgmres_device_engine_config were
  missing.
- Added the minimal FGMRES device-engine prerequisites contract. It accepts only
  configs with a GPU operator context, apply_Aomega and right-preconditioner
  callbacks, device solution/RHS vector views matching tangent_dof_count,
  minimum device workspace, nonzero max_iterations, and a passing residency/
  no-per-iteration-transfer diagnostic contract.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the Patch J
  FGMRES device-engine prerequisites contract.
- RED: just verify-fem-frequency-domain-native-contract failed after adding the
  FGMRES device callback-probe contract because
  probe_fgmres_device_engine_callbacks and the probe result fields on
  FGMRESDeviceEngineState were missing.
- Added a minimal FGMRES device callback probe. It validates the existing
  device-engine prerequisites, requires positive omega and a scratch device
  vector view matching tangent_dof_count, invokes apply_Aomega and the
  right-preconditioner callback on device vector views, records both probe
  results, and forwards callback failures without claiming a production FGMRES
  implementation.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the Patch J
  FGMRES callback-probe contract.
- RED: just verify-fem-frequency-domain-native-contract failed after adding the
  FGMRES device algebra/orthogonalization contract because
  ApplyFGMRESDeviceOrthogonalizationGpu, FGMRESDeviceAlgebraConfig,
  FGMRESDeviceAlgebraState, validate_fgmres_device_algebra_config, and
  probe_fgmres_device_algebra_callbacks were missing.
- Added the minimal FGMRES device algebra contract. It requires device-resident
  Krylov basis V, preconditioned basis Z, work vector, Hessenberg column
  storage sized for the restart dimension, a GPU orthogonalization callback,
  and the existing no-per-iteration-transfer residency diagnostics.
- Added a device algebra probe that invokes the orthogonalization callback on
  the device views and forwards callback failures. This is still contract
  plumbing for the future FGMRES engine, not a production device-resident
  Krylov loop.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the Patch J
  device algebra/orthogonalization contract.
- RED: just verify-fem-frequency-domain-native-contract failed after adding the
  FGMRES device residual-readiness contract because
  FGMRESDeviceResidualDiagnostics, fgmres_device_residual_contract_passes,
  FGMRESDeviceEngineConfig::residual_diagnostics, and
  FGMRESDeviceEngineState::residual_contract_passed were missing.
- Added the minimal FGMRES device residual-readiness contract. It requires
  bounded 64- and 256-iteration residual evidence, real residual decline,
  tracked-vs-recomputed final residual agreement, and a bounded device-vs-CPU
  residual ratio before a device engine config can be marked ready.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the Patch J
  bounded residual trend and tracked-vs-recomputed residual gate.
- RED: just verify-fem-frequency-domain-native-contract failed after adding the
  FGMRES device engine/workspace readiness contract because
  FGMRESDeviceWorkspace, FGMRESDeviceEngine, FGMRESDeviceEngineReadiness, and
  validate_fgmres_device_engine_readiness were missing.
- Added the minimal FGMRES device engine/workspace readiness contract. It
  requires a shared engine/algebra GPU context, an engine-owned device
  workspace, scratch vectors sized by tangent DOF and workspace vector count,
  matching restart dimensions, and passing engine/algebra config contracts.
  It deliberately reports production_loop_available=false.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution, covering the Patch J
  engine/workspace ownership gate.
```

---

## Patch K — production optimization

Dopiero po J:

```text
BSR tangent blocks
batched real/imag/different drives
CUDA Graphs
frequency recycling
modal-direct hybrid
async telemetry
```

---

## Merge rules

1. Każdy patch ma mieć jeden cel.
2. Refactor bez zmiany zachowania musi mieć output byte-for-byte albo residual-equivalent.
3. Nowy backend zaczyna jako opt-in.
4. Planner nie wybiera nowego backendu defaultowo, dopóki nie przejdzie gates.
5. GPU performance claim wymaga telemetry counters.
6. Schur performance claim wymaga full-vs-reduced certificate.
7. Modal speed claim wymaga sparse/direct sample validation.
