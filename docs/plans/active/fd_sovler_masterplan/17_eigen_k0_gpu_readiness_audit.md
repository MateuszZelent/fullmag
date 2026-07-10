# Eigen K0 GPU readiness audit

- Date: 2026-07-10
- Status: implementation_status
- Source of truth: `25_frequency_domain_readiness_matrix.json`
- Runtime revalidated in this update: `false`
- Historical audit: `old/17_eigen_k0_gpu_readiness_audit_legacy_2026-07-10.md`

This file records current GPU modal truth only. The old before/after audit is
archived under `old/` and must not be used as current status when it conflicts
with the readiness matrix.

## Current GPU status

| Scope | Implementation state | Validation state | Validated scope | Current conclusion |
|---|---|---|---|---|
| `modal_eigen/gpu/k0/none`, macrospin | `executable` | `physics_validated` | K0-1 no-demag macrospin/Larmor field sweep | Real narrow GPU modal slice exists through `gpu_dense_k0_macrospin_modal_eigen`. |
| `modal_eigen/gpu/k0/none`, general | `source_visible` | `unvalidated` | none | The macrospin slice does not promote a general GPU modal eigensolver. |
| `modal_eigen/gpu/k0/periodic_airbox_k0`, dense/apply probe | `executable` | `algebra_validated` | bounded one-shot dense/apply fixtures | Useful contract evidence, not production physics. |
| `modal_eigen/gpu/k0/periodic_airbox_k0`, scalable modal | `absent` | `unvalidated` | none | No persistent GPU modal selected-spectrum solver exists. |
| `modal_eigen/gpu/nonzero_k/none` | `absent` | `unvalidated` | none | Nonzero-k Floquet GPU modal remains unavailable. |
| `modal_eigen/gpu/nonzero_k/floquet_airbox_nonzero_k` | `absent` | `unvalidated` | none | Dynamic demag-k GPU modal remains unavailable. |
| `driven_response/gpu/k0/periodic_airbox_k0` | `executable` | `unvalidated` | existing partial executable Schur/provider artifacts only | This is driven response, not modal eigensolve; current reliable lane is `gpu_operator_host_krylov` with host or hybrid Poisson provider. |
| `driven_response/gpu/*/gpu_device_krylov` | `source_visible` | `unvalidated` | none | `production_loop_available=false`; no full device Krylov loop. |

## What is validated

The validated GPU modal slice is:

```text
study_product = modal_eigen
device = gpu
wavevector_scope = k0
demag_scope = none
solver = gpu_dense_k0_macrospin_modal_eigen
validated_scope = macrospin_larmor_field_sweep
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
- broad sparse/matrix-free selected-spectrum GPU modal execution.

## What is not production qualified

### GPU K0 Poisson-airbox modal

Current GPU Poisson-airbox modal evidence is limited to dense/apply contract
fixtures and one-shot algebraic probes. It does not include:

- persistent GPU modal context;
- full selected-spectrum Krylov-Schur or Arnoldi loop;
- shifted preconditioner;
- Ritz extraction, restart and convergence;
- real shared-domain `mfem_weak_form_shared_domain` assembly;
- CPU/GPU parity for real Poisson-airbox blocks;
- mesh and airbox convergence;
- K0-3 Kittel independence.

The correct status is therefore:

```text
implementation_state = executable only for dense/apply algebra probes
validation_state = algebra_validated
validated_scope = bounded one-shot GPU fixture
production_qualified = false
```

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
validated_scope = none
```

## Required promotion gates

A future broad GPU modal promotion must add all of the following for the exact
cell being promoted:

1. backend-owned GPU modal source under the GPU frequency-domain owner, not a
   modal proof hidden inside driven-response source;
2. persistent device context for blocks, vectors, basis and preconditioner;
3. scalable selected-spectrum solver with restart, convergence and Ritz
   extraction;
4. original descriptor residual and finite-mode certification;
5. transfer audit showing no per-iteration H2D/D2H;
6. CPU/GPU parity on real assembled blocks;
7. validation matrix gates for the exact `validated_scope`;
8. artifact fields with requested/resolved execution, implementation state,
   validation state and validated scope.

Until those gates pass, only the narrow K0 no-demag macrospin GPU modal cell is
`physics_validated`.
