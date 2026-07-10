---
title: Frequency-domain readiness current status
date: 2026-07-10
status: implementation_status
source_of_truth: 25_frequency_domain_readiness_matrix.json
runtime_revalidated_in_this_update: false
scope:
  - FEM modal_eigen
  - FEM driven_response
  - CPU and GPU
  - k0 and nonzero_k
  - no-demag and dynamic-demag scopes
---

# Frequency-domain readiness current status

This chapter is the human-readable projection of
`25_frequency_domain_readiness_matrix.json`. The JSON file is the detailed
status source for the active masterplan. This file may summarize it, but it
must not carry a separate patch diary or promote a neighboring cell.

No tests, builds, examples, managed runtimes or solvers were run for this
update. Existing artifacts and source-visible behavior were inspected only as
static evidence, so every claim below keeps:

```text
runtime_revalidated_in_this_update = false
```

## Status axes

Every readiness claim uses three independent axes:

| Axis | Values | Meaning |
|---|---|---|
| `implementation_state` | `absent`, `contract_only`, `source_visible`, `executable` | What exists or can run. |
| `validation_state` | `unvalidated`, `algebra_validated`, `physics_validated`, `production_qualified` | What evidence actually validates. |
| `validated_scope` | exact bounded scope or `none` | The only workload the validation may be used to support. |

`executable` does not imply `production_qualified`. `physics_validated` for a
narrow macrospin or exchange-only cell does not promote Poisson-airbox,
nonzero-k demag, device Krylov, or broad production cells.

## JSON-derived readiness table

| Cell | Implemented | Executable | Validated | Blocked from production claim |
|---|---:|---:|---:|---|
| `modal_eigen/cpu/k0/none`, macrospin Larmor | yes | yes | `physics_validated`: K0-1 no-demag CPU field sweep | Dynamic demag, damping, shared-domain Poisson-airbox, production DoD. |
| `modal_eigen/gpu/k0/none`, macrospin Larmor | yes | yes | `physics_validated`: K0-1 no-demag GPU dense cuSolverDN field sweep | Broad GPU modal, nonzero-k, demag, sparse/matrix-free modal. |
| `modal_eigen/gpu/k0/none`, general modal | source visible | no broad path | no | The macrospin slice is not a general GPU modal eigensolver. |
| `modal_eigen/cpu/nonzero_k/none` | yes | yes, bounded | no production validation | Dynamic demag-k, DMI, broad production DoD. |
| `modal_eigen/gpu/nonzero_k/none` | no | no | no | Nonzero-k Floquet GPU modal operator/eigensolver is absent. |
| `modal_eigen/cpu/k0/periodic_airbox_k0`, synthetic oracle | yes | yes | `algebra_validated`: tiny descriptor/SLEPc fixtures | Not real shared-domain FEM assembly or K0-3 physics validation. |
| `modal_eigen/cpu/k0/periodic_airbox_k0`, real shared-domain | source visible | not qualified | no | Real MFEM weak-form assembly, imaginary-axis target, Kittel independence and convergence remain open. |
| `modal_eigen/gpu/k0/periodic_airbox_k0`, dense/apply probe | yes | yes, bounded | `algebra_validated`: one-shot dense/apply fixtures | Not scalable device-resident modal Krylov or production physics. |
| `modal_eigen/gpu/k0/periodic_airbox_k0`, scalable | no | no | no | Persistent modal GPU context and selected-spectrum solver are absent. |
| `modal_eigen/cpu/nonzero_k/floquet_airbox_nonzero_k` | contract only | no | no | `missing_numeric_fem_demag_k`; dynamic demag-k operator unavailable. |
| `modal_eigen/gpu/nonzero_k/floquet_airbox_nonzero_k` | no | no | no | Nonzero-k GPU modal dynamic-demag operator unavailable. |
| `driven_response/cpu/k0/none` | yes | yes, bounded | no production validation | Needs exact-scope DoD and validation record. |
| `driven_response/gpu/k0/none` | yes | yes, bounded | no production validation | `gpu_operator_host_krylov` is not `gpu_device_krylov`. |
| `driven_response/cpu/k0/periodic_airbox_k0` | yes | yes, bounded | existing runtime evidence only | Schur/provider slice is not full assembled coupled production qualification. |
| `driven_response/gpu/k0/periodic_airbox_k0`, host Krylov | yes | yes, bounded | existing runtime evidence only | Hybrid/host Poisson residency and operator-host Krylov do not satisfy strict GPU demag/device-Krylov claims. |
| `driven_response/gpu/k0/periodic_airbox_k0`, device Krylov | source visible | no | no | `production_loop_available=false`; no integrated device Krylov loop. |
| `driven_response/cpu/nonzero_k/none` | yes | yes, bounded | no production validation | Floquet phase projection only; no dynamic demag-k. |
| `driven_response/gpu/nonzero_k/none` | yes | yes, bounded | no production validation | Floquet phase projection only; no dynamic demag-k or device Krylov. |
| `driven_response/cpu/nonzero_k/floquet_airbox_nonzero_k` | contract only | no | no | `floquet_airbox_dynamic_demag_k_unimplemented`. |
| `driven_response/gpu/nonzero_k/floquet_airbox_nonzero_k` | no | no | no | No strict GPU fallback to CPU is allowed. |

## Current high-signal truths

1. GPU K0 no-demag macrospin modal is a real narrow validated slice.
   Evidence lives in
   `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts`
   and the CPU/GPU comparison summary. Its `validated_scope` is only
   `macrospin_larmor_field_sweep`.
2. GPU K0 Poisson-airbox modal is not production qualified. Existing dense or
   apply probes are algebra-contract evidence, not a scalable modal GPU
   eigensolver and not real shared-domain Poisson-airbox physics.
3. CPU K0 real shared-domain Poisson-airbox modal is not production qualified.
   Current source still shows the topology-shaped Kittel payload and the real
   PETSc target issue. The owned docs now mark that as a blocker, not a closed
   production path.
4. Nonzero-k dynamic demag is not production qualified on CPU or GPU. No
   modal or driven cell may replace it with K0 demag, open-boundary demag,
   no-demag phase projection, or a CPU fallback for strict GPU.
5. Driven `periodic_airbox_k0` CPU/GPU paths are partial executable slices.
   Existing artifacts show useful Schur/provider and phi-consistency telemetry,
   but they are not blanket `production_qualified` status and do not promote
   modal eigensolve.
6. `gpu_device_krylov` is not executable as a production loop without the full
   device-resident Krylov implementation, transfer audit, and true residual
   proof. Current executable GPU driven response is `gpu_operator_host_krylov`
   or a compatibility lane unless a future cell proves otherwise.

## Capability matrix integration

`docs/specs/capability-matrix-v0.md` and `.json` are consumed here but remain
owned by the parallel dynamic-solver remediation plan. This task does not edit
them.

External ownership for the parallel plan:

- correct any stale heading or downstream copy that calls the seven
  product-facing statuses a "four-state status vocabulary";
- add links from capability-matrix frequency-domain rows to
  `25_frequency_domain_readiness_matrix.json`;
- keep the product-facing status summary separate from
  `implementation_state`, `validation_state`, and `validated_scope`;
- preserve broad runtime booleans such as `supports_frequency_response=false`
  as coarse capability gates, while using `frequency_domain_capabilities.v1`
  and this JSON matrix for the narrow executable slices.

When those broad booleans coexist with a narrow executable FEM
`driven_response` slice, the boolean is not a contradiction: it says the broad
solver family is not generally supported, while the readiness cell says a
bounded slice can execute under explicit prerequisites.

## Evidence read for this update

Static evidence used:

- `docs/specs/capability-matrix-v0.md`
- `docs/specs/capability-matrix-v0.json`
- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
- `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`
- `.superpowers/sdd/fd-masterplan-task-4-report.md`
- `.superpowers/sdd/fd-masterplan-task-5-report.md`
- `.superpowers/sdd/fd-masterplan-task-6-report.md`
- `.superpowers/sdd/fd-masterplan-task-7-report.md`
- `.superpowers/sdd/fd-masterplan-task-8-report.md`
- `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json`
- `.fullmag/reports/frequency-domain-eigen-k0-kittel-cpu-gpu-comparison-summary.v1.json`
- `.fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts/response/diagnostics/solver.v1.json`
- `.fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts/response/diagnostics/solver.v1.json`
- `.fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts/response/diagnostics/solver.v1.json`

The requested report path `.superpowers/sdd/fd-masterplan-task-9-report.md`
does not exist in this checkout at the time of this update.
