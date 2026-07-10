# Eigen K0 GPU readiness audit

- Date: 2026-07-10
- Status: implementation_status
- Source of truth: `25_frequency_domain_readiness_matrix.json`
- Runtime revalidated in this update: `false`
- Historical audit: `old/17_eigen_k0_gpu_readiness_audit_legacy_2026-07-10.md`

This file is a strict GPU-focused projection of
`25_frequency_domain_readiness_matrix.json`. The old before/after audit is
archived under `old/` and must not be used as current status when it conflicts
with the readiness matrix.

## Current GPU status

All non-null `validated_scope` references use the readiness projection catalog:

```text
scope_catalog_uri = urn:fullmag:frequency-domain:readiness-scope-catalog:78df796d6956f9b25856b7cf6639d683b2175281fe7291ee80d270e031039b64
scope_catalog_sha256 = sha256:78df796d6956f9b25856b7cf6639d683b2175281fe7291ee80d270e031039b64
```

| Cell ID | Implementation state | Validation state | `validated_scope` | Evidence or executable scope | Current conclusion |
|---|---|---|---|---|---|
| `modal_gpu_k0_none_macrospin_larmor` | `executable` | `physics_validated` | `sha256:2a87bce1656c74fe82782b37ce229e6c4af43ef183f7ff6e228a1cac308df372` | K0-1 no-demag macrospin/Larmor field sweep using `gpu_dense_k0_macrospin_modal_eigen`; precision=`double`. | Real narrow GPU modal slice exists through the current emitted GPU modal validation lane. |
| `modal_gpu_k0_none_general_modal` | `source_visible` | `unvalidated` | `null` | Source evidence only. | The macrospin slice does not promote a general GPU modal eigensolver. |
| `modal_gpu_k0_periodic_airbox_dense_probe` | `source_visible` | `unvalidated` | `null` | Target label: `gpu_dense_contract_eigensolver`; current emitted GPU modal validation lane remains `gpu_dense_k0_macrospin_modal_eigen` for the no-demag macrospin cell only. | The target dense-contract label is not emitted as a production modal artifact and does not validate Poisson-airbox modal physics. |
| `modal_gpu_k0_periodic_airbox_scalable` | `absent` | `unvalidated` | `null` | None. | No persistent GPU modal selected-spectrum solver exists. |
| `modal_gpu_nonzero_k_none` | `absent` | `unvalidated` | `null` | None. | Nonzero-k Floquet GPU modal remains unavailable. |
| `modal_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | Dynamic demag-k GPU modal remains unavailable. |
| `driven_gpu_k0_periodic_airbox_gpu_operator_host_krylov` | `executable` | `unvalidated` | `null` | Executable scope: partial periodic_airbox_k0 GPU operator-host Krylov artifacts with hybrid or host Poisson demag provider. | This is driven response, not modal eigensolve; current reliable lane is `gpu_operator_host_krylov` with host or hybrid Poisson provider. |
| `driven_gpu_k0_periodic_airbox_gpu_device_krylov` | `source_visible` | `unvalidated` | `null` | Source evidence only. | `production_loop_available=false`; no full device Krylov loop. |

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
validated_scope.scope_id = sha256:2a87bce1656c74fe82782b37ce229e6c4af43ef183f7ff6e228a1cac308df372
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
