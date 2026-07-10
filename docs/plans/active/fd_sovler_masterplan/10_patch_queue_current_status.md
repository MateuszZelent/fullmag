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

This chapter is a strict human-readable projection of
`25_frequency_domain_readiness_matrix.json`. The JSON file is the detailed
status source for the active masterplan. This file must not carry a separate
patch diary, alternate scope schema or promotion claim.

No tests, builds, examples, managed runtimes or solvers were run for this
update:

```text
runtime_revalidated_in_this_update = false
```

## Status axes

Every readiness claim uses independent implementation and validation axes:

| Axis | Values | Meaning |
|---|---|---|
| `implementation_state` | `absent`, `contract_only`, `source_visible`, `executable` | What exists or can run. |
| `validation_state` | `unvalidated`, `algebra_validated`, `physics_validated`, `production_qualified` | What evidence validates. |
| `validated_scope` | `null` or Task8-shaped `validation_scope_binding.v1` direct reference | `null` for unvalidated cells; otherwise contains `scope_id`, `scope_catalog_uri` and `scope_catalog_sha256`. |
| `executable_scope` | object or omitted | Present only when a narrow executable slice exists while `validated_scope=null`. |

The cited legacy artifacts do not yet emit `scope_catalog.v1`. Non-null
`validated_scope` references are readiness projection bindings that future
runtime artifacts must carry before production promotion. They are not fresh
runtime revalidation.

All non-null scope references in this matrix use:

```text
scope_catalog_uri = urn:fullmag:frequency-domain:readiness-scope-catalog:78df796d6956f9b25856b7cf6639d683b2175281fe7291ee80d270e031039b64
scope_catalog_sha256 = sha256:78df796d6956f9b25856b7cf6639d683b2175281fe7291ee80d270e031039b64
scope_catalog_status = readiness_projection_pending_runtime_scope_catalog_v1_emission
```

## JSON-derived readiness table

| Cell ID | Implementation | Validation | `validated_scope` | Evidence or executable scope | Production blocker |
|---|---|---|---|---|---|
| `modal_cpu_k0_none_macrospin_larmor` | `executable` | `physics_validated` | `sha256:aa92858e9eab88f10e989bf98cf2e6478a2a810d6b8f17a256d714be77a6ce62` | K0-1 no-demag macrospin/Larmor field sweep, CPU dense SLEPc path; precision=`double`. | No K0 dynamic-demag coverage; no production DoD closure for broader modal eigensolve. |
| `modal_gpu_k0_none_macrospin_larmor` | `executable` | `physics_validated` | `sha256:2a87bce1656c74fe82782b37ce229e6c4af43ef183f7ff6e228a1cac308df372` | K0-1 no-demag macrospin/Larmor field sweep using `gpu_dense_k0_macrospin_modal_eigen`; precision=`double`. | Does not qualify nonzero-k, demag, sparse, matrix-free or persistent GPU modal eigensolve. |
| `modal_gpu_k0_none_general_modal` | `source_visible` | `unvalidated` | `null` | Source evidence only. | The macrospin slice is not a general GPU modal eigensolver. |
| `modal_cpu_nonzero_k_none_selected_spectrum` | `executable` | `unvalidated` | `null` | Executable scope: managed native CPU selected-spectrum no-demag Floquet k-path slice with labelled Bloch/Floquet tangent payload and analytic/reciprocal exchange-only gates. | Dynamic demag-k and broad production DoD remain open. |
| `modal_gpu_nonzero_k_none` | `absent` | `unvalidated` | `null` | None. | No nonzero-k Floquet GPU modal operator/eigensolver exists. |
| `modal_cpu_k0_periodic_airbox_synthetic_oracle` | `executable` | `algebra_validated` | `sha256:2926fade63296f455313334ae6bb7643655d15973cf99c1b323d137641aef3d6` | Tiny synthetic full-descriptor Poisson-airbox fixtures and SLEPc algebra/oracle coverage only; precision=`double`. | Not real shared-domain FEM assembly or K0-3 physics validation. |
| `modal_cpu_k0_periodic_airbox_real_shared_domain` | `source_visible` | `unvalidated` | `null` | Source evidence only. | Real MFEM weak-form assembly, imaginary-axis target, Kittel independence and convergence remain open. |
| `modal_gpu_k0_periodic_airbox_dense_probe` | `source_visible` | `unvalidated` | `null` | Target label: `gpu_dense_contract_eigensolver`; current emitted GPU modal validation lane remains `gpu_dense_k0_macrospin_modal_eigen` for the no-demag macrospin cell only. | Target label is not emitted as a production modal artifact; no scalable GPU selected-spectrum eigensolver; no real shared-domain physics qualification. |
| `modal_gpu_k0_periodic_airbox_scalable` | `absent` | `unvalidated` | `null` | None. | Persistent GPU modal context, Ritz extraction, restart, convergence and transfer audit are missing. |
| `modal_cpu_nonzero_k_floquet_airbox` | `contract_only` | `unvalidated` | `null` | Contract evidence only. | `missing_numeric_fem_demag_k`; production CPU modal dynamic-demag-k operator unavailable. |
| `modal_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | Nonzero-k GPU modal dynamic-demag operator unavailable. |
| `driven_cpu_k0_none` | `executable` | `unvalidated` | `null` | Executable scope: bounded gamma/free-boundary and k0 static-periodic no-demag slices. | Needs exact-scope DoD and validation record. |
| `driven_gpu_k0_none` | `executable` | `unvalidated` | `null` | Executable scope: bounded gamma/free-boundary and k0 static-periodic GPU operator-host Krylov slices; not `gpu_device_krylov`. | No full device-resident Krylov loop; no production qualification record. |
| `driven_cpu_k0_periodic_airbox` | `executable` | `unvalidated` | `null` | Executable scope: partial periodic_airbox_k0 Schur/provider response artifacts, not full assembled coupled `[delta_m, delta_phi]` production qualification. | Production validation gates are not closed; no fresh runtime revalidation. |
| `driven_gpu_k0_periodic_airbox_gpu_operator_host_krylov` | `executable` | `unvalidated` | `null` | Executable scope: partial periodic_airbox_k0 GPU operator-host Krylov artifacts with hybrid or host Poisson demag provider. | Hybrid/host Poisson residency and operator-host Krylov do not satisfy strict GPU demag or device-Krylov claims. |
| `driven_gpu_k0_periodic_airbox_gpu_device_krylov` | `source_visible` | `unvalidated` | `null` | Source evidence only. | `production_loop_available=false`; no integrated device Krylov loop; no zero-per-iteration-transfer proof. |
| `driven_cpu_nonzero_k_none_phase_projection` | `executable` | `unvalidated` | `null` | Executable scope: no-demag/non-DMI Floquet phase-projection response slice with complete pair metadata and Bloch-phased tangent drive. | Not full nonzero-k Floquet assembly; no dynamic demag-k. |
| `driven_gpu_nonzero_k_none_phase_projection` | `executable` | `unvalidated` | `null` | Executable scope: no-demag/non-DMI Floquet phase-projection response slice; local/exchange CUDA operator support only. | Not full nonzero-k Floquet assembly; no GPU dynamic demag-k; no `gpu_device_krylov` proof. |
| `driven_cpu_nonzero_k_floquet_airbox` | `contract_only` | `unvalidated` | `null` | Contract evidence only. | `floquet_airbox_dynamic_demag_k_unimplemented`; `missing_numeric_fem_demag_k`. |
| `driven_gpu_nonzero_k_floquet_airbox` | `absent` | `unvalidated` | `null` | None. | No strict GPU fallback to CPU is allowed. |

## Current high-signal truths

1. GPU K0 no-demag macrospin modal is a real narrow legacy-evidenced slice
   through `gpu_dense_k0_macrospin_modal_eigen`. The readiness projection
   scopes that evidence to precision=`double` and to the no-demag macrospin
   field sweep only.
2. GPU K0 Poisson-airbox modal is not production qualified. The target
   `gpu_dense_contract_eigensolver` label is retained as a target/source-visible
   contract, not as an emitted production modal artifact.
3. CPU K0 real shared-domain Poisson-airbox modal is not production qualified.
   Current source still shows the topology-shaped Kittel payload and the real
   PETSc target issue. The owned docs mark that as a blocker, not a closed
   production path.
4. Nonzero-k dynamic demag is not production qualified on CPU or GPU. No
   modal or driven cell may replace it with K0 demag, open-boundary demag,
   no-demag phase projection or a CPU fallback for strict GPU.
5. Driven `periodic_airbox_k0` CPU/GPU paths are partial executable slices.
   Existing artifacts show useful Schur/provider and phi-consistency telemetry,
   but they are not blanket `production_qualified` status and do not promote
   modal eigensolve.
6. `gpu_device_krylov` is not executable as a production loop without the full
   device-resident Krylov implementation, transfer audit and true residual
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
  `implementation_state`, `validation_state` and `validated_scope`;
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
