# Eigen K0 GPU readiness audit

- Date: 2026-08-01
- Status: implementation_status
- Source of truth: `25_frequency_domain_readiness_matrix.json`
- Managed runtime bundle identity revalidated in this update: `true`
- Executed GPU-device solver revalidated in this update: `false`
- Historical audit: `old/17_eigen_k0_gpu_readiness_audit_legacy_2026-07-10.md`

This file is a strict GPU-focused projection of
`25_frequency_domain_readiness_matrix.json`. The old before/after audit is
archived under `old/` and must not be used as current status when it conflicts
with the readiness matrix.

## Current GPU status

All non-null `validated_scope` and `executable_scope` references use the
readiness projection catalog:

```text
scope_catalog_uri = urn:fullmag:frequency-domain:readiness-scope-catalog:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
scope_catalog_sha256 = sha256:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
scope_catalog_path = docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json
```

| Cell ID | Implementation state | Validation state | `validated_scope` | Evidence or executable scope | Current conclusion |
|---|---|---|---|---|---|
| `modal_gpu_k0_none_macrospin_larmor` | `executable` | `physics_validated` | `modal_gpu_k0_none_macrospin_larmor.validation` | K0-1 no-demag macrospin/Larmor field sweep using `gpu_dense_k0_macrospin_modal_eigen`; precision=`double`. | Real narrow GPU modal slice exists through the current emitted GPU modal validation lane. |
| `modal_gpu_k0_none_general_modal` | `source_visible` | `unvalidated` | `null` | Source evidence only. | The macrospin slice does not promote a general GPU modal eigensolver. |
| `modal_gpu_k0_periodic_airbox_dense_probe` | `source_visible` | `unvalidated` | `null` | Target label: `gpu_dense_contract_eigensolver`; current emitted GPU modal validation lane remains `gpu_dense_k0_macrospin_modal_eigen` for the no-demag macrospin cell only. | The target dense-contract label is not emitted as a production modal artifact and does not validate Poisson-airbox modal physics. |
| `modal_gpu_k0_periodic_airbox_scalable` | `absent` | `unvalidated` | `null` | None. | No persistent GPU modal selected-spectrum solver exists. |
| `modal_gpu_nonzero_k_none` | `absent` | `unvalidated` | `null` | None. | Nonzero-k Floquet GPU modal remains unavailable. |
| `modal_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | Dynamic demag-k GPU modal remains unavailable. |
| `driven_gpu_k0_none` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_k0_none.executable`: bounded gamma/free-boundary and k0 static-periodic GPU operator-host Krylov slices; not `gpu_device_krylov`. | This is driven response, not modal eigensolve; no full device-resident Krylov loop is proven. |
| `driven_gpu_k0_periodic_airbox_gpu_operator_host_krylov` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_k0_periodic_airbox_operator_host_krylov.executable`: partial periodic_airbox_k0 GPU operator-host Krylov artifacts with hybrid or host Poisson demag provider. | This is driven response, not modal eigensolve; current reliable lane is `gpu_operator_host_krylov` with host or hybrid Poisson provider. |
| `driven_gpu_k0_periodic_airbox_gpu_device_krylov` | `source_visible` | `unvalidated` | `null` | Source evidence only. | `production_loop_available=false`; no full device Krylov loop. |
| `driven_gpu_nonzero_k_none_phase_projection` | `executable` | `unvalidated` | `null` | Executable scope `driven_gpu_nonzero_k_none_phase_projection.executable`: no-demag/non-DMI Floquet phase-projection response slice with local/exchange CUDA operator support only. | This is driven response, not modal eigensolve; it does not prove nonzero-k GPU modal or GPU dynamic demag-k. |
| `driven_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | Nonzero-k GPU driven dynamic-demag-k is unavailable; strict GPU fallback to CPU is forbidden. |

## What is validated

The only GPU modal cell with `validation_state=physics_validated` is:

```text
cell_id = modal_gpu_k0_none_macrospin_larmor
study_product = modal_eigen
device = gpu
precision = double
wavevector_scope = k0
demag_scope = none
solver_lane = gpu_dense_k0_macrospin_modal_eigen
validated_scope.scope_id = modal_gpu_k0_none_macrospin_larmor.validation
validated_scope.scope_catalog_uri = urn:fullmag:frequency-domain:readiness-scope-catalog:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
validated_scope.scope_catalog_sha256 = sha256:6bd14fb083db6474c1e33ccc5b67081ad68ee5bed6cb22db7d93df0aabdc9993
```

Existing static evidence:

- `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/eigen/diagnostics/solver.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-cpu-gpu-comparison-summary.v1.json`

Those artifacts report GPU execution and roundoff-level CPU/GPU agreement for
the no-demag macrospin field sweep. They do not prove:

- K0 Poisson-airbox demag;
- real shared-domain FEM assembly;
- nonzero-k Floquet modal dispersion on GPU;
- dynamic demag-k;
- DMI or damping modal qualification;
- broad sparse/matrix-free selected-spectrum GPU modal execution;
- Task8 runtime `scope_catalog.v1` emission.

## What is not production qualified

### GPU K0 Poisson-airbox modal

`modal_gpu_k0_periodic_airbox_dense_probe` is source-visible and unvalidated in
the current matrix. The target label remains:

```text
target_solver_label = gpu_dense_contract_eigensolver
implementation_state = source_visible
validation_state = unvalidated
validated_scope = null
```

That target must not be described as emitted until a runtime artifact actually
publishes the label with Task8 scope binding and the telemetry required by
chapter 11. The current emitted GPU modal validation lane is
`gpu_dense_k0_macrospin_modal_eigen`, and it is scoped only to the no-demag
macrospin cell.

GPU K0 Poisson-airbox production qualification still requires:

- persistent GPU modal context;
- full selected-spectrum Krylov-Schur or Arnoldi loop;
- shifted preconditioner;
- Ritz extraction, restart and convergence;
- real shared-domain `mfem_weak_form_shared_domain` assembly;
- CPU/GPU parity for real Poisson-airbox blocks;
- mesh and airbox convergence;
- K0-3 Kittel independence.

### GPU nonzero-k modal

No GPU modal nonzero-k Floquet operator/eigensolver is production available.
The driven-response no-demag phase-projection slice is not modal proof. A
strict GPU request for nonzero-k modal dynamic demag must fail explicitly.

### GPU device Krylov

`gpu_device_krylov` and `gpu_modal_device_krylov` may be claimed only after
the telemetry contract in chapter 11 proves a full device-resident loop with
zero per-iteration host transfers. Current status remains:

```text
implementation_state = source_visible
validation_state = unvalidated
validated_scope = null
```

## Required promotion gates

A future broad GPU modal promotion must add all of the following for the exact
cell being promoted:

1. backend-owned GPU modal source under the GPU frequency-domain owner, not a
   modal proof hidden inside driven-response source;
2. persistent device context for blocks, vectors, basis and preconditioner;
3. scalable selected-spectrum solver with restart, convergence and Ritz
   extraction;
4. reconstructed original-unscaled descriptor residual and finite-mode
   certification;
5. transfer audit showing no per-iteration H2D/D2H;
6. CPU/GPU parity on real assembled blocks;
7. validation matrix gates for the exact `validated_scope`;
8. artifact fields with requested/resolved execution, implementation state,
   validation state, Task8 scope binding and evidence scope.

Until those gates pass, only the narrow K0 no-demag macrospin GPU modal cell is
`physics_validated`, and only for precision=`double`.

## Revalidation after the master branch update (2026-08-01)

The working branch was first brought up to the current `origin/master` before
this audit. The merge commit is `d5f63b35a4f4a57798089915b312c4695caea917`;
`origin/master` is `eee245ac200bf138d880b793791848106b7386ba`, and
`git rev-list --left-right --count HEAD...origin/master` reports `25 0`.
This is branch-integration evidence, not solver qualification.

The managed FEM bundle was rebuilt and validated against the exact source
snapshot. Its manifest reports commit `d5f63b35a4f4a57798089915b312c4695caea917`,
`source_identity_compatibility=exact-schema-3`, `worktree_state=clean`, and
`compute_capability=8.9`. The container reported that no NVIDIA driver was
available, so no executed-device GPU result was produced.

The aggregate native-contract recipe was attempted after the rebuild but
stopped before compilation because the fresh worktree did not contain
`native/build`; this is a recipe/bootstrap failure, not evidence that the
frequency-domain contracts passed or failed. The explicit K0 CPU recipe then
configured its own managed CMake build and produced the contract binary, but
the small SLEPc fixture did not emit a result after approximately 19 minutes.
The recipe was terminated with exit code 130; this is a timeout/non-convergence
boundary, not a pass.

The source-level boundary is unchanged and is anchored by:

| Source anchor | Revalidated conclusion |
|---|---|
| `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu::fullmag_fem_frequency_domain_apply_modal_shift_invert_gpu_action` | A device dense shifted action exists, but its diagnostics explicitly set `gpu_device_resident_modal_eigensolver=false`; it is not a modal Krylov loop. |
| `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu::fullmag_fem_frequency_domain_solve_modal_poisson_airbox_gpu_dense_eigensolver` | The bounded dense Poisson-airbox lane remains `validation_only=true`, `production_modal_claim=false`, and `persistent_solver_context=false`. |
| `backends/fem/include/frequency_domain/gpu_device_krylov.hpp::validate_fgmres_device_engine` | Device workspace validation is present, but `production_loop_available=false`; no promotion follows from the contract structure alone. |

Therefore `modal_gpu_k0_periodic_airbox_scalable` remains `absent/unvalidated`
and the only physics-validated GPU modal cell remains the double-precision,
no-demag macrospin/Larmor slice.
