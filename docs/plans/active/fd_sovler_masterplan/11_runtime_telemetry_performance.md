---
title: Frequency-domain runtime telemetry and performance contract
date: 2026-07-10
status: implementation_status
runtime_revalidated_in_this_update: false
---

# Runtime telemetry and performance contract

This file defines the telemetry fields and threshold rules required before a
FEM frequency-domain readiness cell may move beyond executable source/runtime
availability. It is normative for artifact shape and interpretation. It is not
a chronology of managed runs.

No tests, builds, examples, runtimes or solvers were run for this update.

## 1. Placement and migration rule

The existing response-diagnostics root remains canonical. This chapter does
not introduce a competing root diagnostic schema. Frequency-domain runtime
telemetry is a named object directly under that existing response diagnostics
root:

```json
{
  "schema_version": "existing_response_diagnostics_schema",
  "runtime_telemetry": {
    "schema_version": "frequency_domain_runtime_telemetry.v1",
    "study_product": "modal_eigen|driven_response",
    "requested_execution": {},
    "resolved_execution": {},
    "implementation_state": "absent|contract_only|source_visible|executable",
    "validation_state": "unvalidated|algebra_validated|physics_validated|production_qualified",
    "validated_scope": null,
    "runtime_revalidated_in_this_update": false
  }
}
```

Migration rule:

1. Existing root diagnostic fields remain readable until their owning artifact
   schema is migrated.
2. New or rewritten frequency-domain diagnostics write the canonical values
   under root `runtime_telemetry`.
3. During migration, duplicate root fields are compatibility mirrors only.
   If a root mirror and `runtime_telemetry` disagree, `runtime_telemetry` is
   authoritative and the artifact is degraded.
4. No artifact may publish a second root `schema_version` named
   `frequency_domain_runtime_telemetry.v1`.
5. A response diagnostics artifact that is already the diagnostics root must
   not add a phantom `diagnostics` wrapper around `runtime_telemetry`.

For GPU, the nested object must distinguish:

```text
requested device = gpu
resolved device = gpu
resolved solver method = gpu_operator_host_krylov | gpu_device_krylov | gpu_modal_device_krylov | gpu_dense_k0_macrospin_modal_eigen | ...
demag provider residency = cpu | gpu | none
```

`resolved_execution.device=gpu` does not by itself prove device-resident Krylov
or strict GPU demag residency.

## 2. Acceptance residual contract

The only residual that may satisfy readiness or production acceptance is the
reconstructed original-unscaled block/full residual for the original operator
or descriptor. Scaled, transformed, preconditioned, normalized, shifted or
solver-reported residuals are diagnostics with distinct names; they cannot
satisfy acceptance and cannot be silently substituted.

### Driven response

Driven response must report:

```json
{
  "residual_acceptance_name": "driven_original_unscaled_full_relative_residual",
  "driven_original_unscaled_full_relative_residual": 0.0,
  "driven_original_unscaled_magnetic_block_relative_residual": 0.0,
  "driven_original_unscaled_scalar_block_relative_residual": 0.0,
  "driven_original_unscaled_residual_threshold": 0.0,
  "tracked_krylov_relative_residual_diagnostic": 0.0,
  "preconditioned_relative_residual_diagnostic": 0.0,
  "scaled_block_relative_residual_diagnostic": 0.0,
  "transformed_operator_relative_residual_diagnostic": 0.0,
  "residual_consistency_relative_gap": 0.0,
  "residual_consistency_relative_gap_threshold": 0.1,
  "residual_consistency_status": "ok|degraded|not_available",
  "coupled_residual_partition_status": "none|magnetic_only|scalar_only|coupled|provider_specific"
}
```

Acceptance rules:

- `status=ready` requires
  `driven_original_unscaled_full_relative_residual <= driven_original_unscaled_residual_threshold`.
- The magnetic and scalar block residuals must be reconstructed against the
  original unscaled block equations and must be reported even when the
  implementation also publishes scaled diagnostics.
- A tracked GMRES residual alone is diagnostic only.
- If `residual_consistency_relative_gap > residual_consistency_relative_gap_threshold`,
  the solve is degraded or failed even when the tracked residual is small.
- `scaled_block_relative_residual_diagnostic` and
  `transformed_operator_relative_residual_diagnostic` are never acceptance
  residuals.

### Modal eigensolve

Modal artifacts must report:

```json
{
  "residual_acceptance_name": "modal_original_unscaled_full_descriptor_backward_error",
  "modal_original_unscaled_full_descriptor_backward_error": 0.0,
  "modal_original_unscaled_magnetic_block_backward_error": 0.0,
  "modal_original_unscaled_poisson_block_backward_error": 0.0,
  "modal_original_unscaled_gauge_constraint_backward_error": 0.0,
  "modal_original_unscaled_full_descriptor_threshold": 0.0,
  "slepc_reported_backward_error_diagnostic": 0.0,
  "scaled_descriptor_backward_error_diagnostic": 0.0,
  "transformed_pencil_backward_error_diagnostic": 0.0,
  "reconstruction_vs_slepc_ratio": 0.0,
  "eps_full_original_unscaled": 0.0,
  "finite_mode_filter_status": "passed|failed|not_applicable"
}
```

Acceptance rules:

- `eps_full_original_unscaled = max(eps_q, eps_phi, eps_gauge)`, with all
  components reconstructed against the original unscaled descriptor blocks.
- `modal_original_unscaled_full_descriptor_backward_error` is derived from the
  reconstructed original descriptor, never from the smaller of the SLEPc
  residual and reconstruction residual.
- SLEPc-reported, shifted, scaled or transformed residuals remain diagnostics.
- Candidate conjugates are evaluated only as the mathematically paired
  `(conj(lambda), conj(x))` mode and cannot hide a wrong positive branch.
- A monolithic descriptor solve must identify and reject algebraic or infinite
  modes before reporting modal readiness.

## 3. Iteration and stop telemetry

Every solver result and progress/partial artifact must include:

```json
{
  "outer_iteration_count": 0,
  "inner_iteration_count": 0,
  "total_iteration_count": 0,
  "restart_iterations": 0,
  "max_iterations": 0,
  "stop_reason": "converged|stagnated|max_iterations|residual_consistency_degraded|cancelled|interrupted|validation_error|operator_error",
  "stagnation_detected": false,
  "stagnation_iteration": 0,
  "stagnation_relative_residual_ratio": 0.0
}
```

Rules:

- Long runs must publish enough progress telemetry that an interrupted solve
  still identifies the solver method, preconditioner, residual status and
  requested/resolved execution.
- A stagnation stop is a failed or degraded solve unless the readiness cell
  explicitly describes a failure-observability gate.
- `max_iterations` exhaustion cannot be reinterpreted as validation.

## 4. Schur and preconditioner quality

Right-preconditioner and Schur-provider diagnostics must include:

```json
{
  "krylov_preconditioner_requested_variant": "auto|graph_demag_coarse|demag_coarse|block_jacobi|none",
  "krylov_preconditioner_variant": "auto|graph_demag_coarse|demag_coarse|block_jacobi|none",
  "right_preconditioner_auto_disabled": false,
  "right_preconditioner_auto_disable_reason": "",
  "right_preconditioner_probe_original_unscaled_relative_residual": 0.0,
  "schur_preconditioner_quality_available": false,
  "schur_preconditioner_quality_status": "helpful|neutral|harmful|not_available|not_applicable",
  "schur_preconditioner_initial_original_unscaled_relative_residual": null,
  "schur_preconditioner_last_original_unscaled_relative_residual": null,
  "schur_preconditioner_contraction_ratio": null,
  "schur_preconditioner_contraction_ratio_threshold": 1.0,
  "schur_preconditioner_quality_apply_count": 0
}
```

Normative interpretation:

- `schur_preconditioner_contraction_ratio` is
  `last_original_unscaled / initial_original_unscaled`; values greater than
  `schur_preconditioner_contraction_ratio_threshold` are not helpful.
- If no Schur/preconditioner path applies to the selected lane, publish
  `schur_preconditioner_quality_status=not_applicable` and set the Schur
  residuals and contraction ratio to `null`.
- If a Schur/preconditioner path applies but the quality probe was not emitted,
  publish `schur_preconditioner_quality_status=not_available` and set the
  Schur residuals and contraction ratio to `null`.
- A contraction ratio is defined only when both residuals are finite and the
  initial original-unscaled residual is positive. Otherwise the ratio is
  `null` and cannot be used as helpfulness evidence.
- A preconditioner is `helpful` only when its application lowers the true
  original-unscaled residual under the same original operator.
- `harmful` or auto-disabled preconditioners are useful diagnostics but not
  production qualification evidence.
- A Schur/provider response can be executable while still unqualified if it
  lacks full coupled block assembly, original-unscaled residual proof or
  validation gates for the exact physics scope.

## 5. Poisson setup and solve-count invariants

Dynamic-demag or Poisson-airbox paths must publish:

```json
{
  "poisson_setup_count": 0,
  "poisson_solve_count": 0,
  "poisson_operator_apply_count": 0,
  "poisson_operator_signature": null,
  "poisson_operator_signature_status": "available|not_applicable",
  "poisson_setup_signature_count": 0,
  "poisson_setup_reuse_count": 0,
  "poisson_operator_mode": "none|host_mfem_poisson_provider|hybrid_cpu_poisson|device_hypre_poisson|mfem_weak_form_shared_domain",
  "phi_gauge_policy": "none|mean_zero|mean_zero_augmented|matrix_free_provider_responsibility",
  "phi_gauge_constraint_applied": false,
  "delta_phi_seam_validation_status": "ok|mismatch|not_run",
  "delta_phi_flux_validation_status": "ok|mismatch|not_run",
  "h_demag_seam_validation_status": "ok|mismatch|not_run"
}
```

Invariants:

- `poisson_operator_mode=none` requires setup, solve, apply, signature and
  reuse counts to be zero, `poisson_operator_signature=null` and
  `poisson_operator_signature_status=not_applicable`.
- `poisson_operator_signature` is a content signature only when a Poisson or
  dynamic-demag operator exists. The string `"none"` is not a valid
  no-Poisson signature.
- For a frequency-invariant operator signature, setup count is exactly one per
  unique `poisson_operator_signature`; additional right-hand sides increase
  solve/apply counts, not setup count.
- `poisson_setup_reuse_count` must account for every solve/apply that reused a
  previously built operator or preconditioner.
- `poisson_solve_count` and `poisson_operator_apply_count` must not decrease
  across progress snapshots for one run.
- `hybrid_cpu_poisson` and `host_mfem_poisson_provider` are compatibility or
  CPU-resident demag provider modes. They do not satisfy strict GPU demag
  residency.
- For `poisson_robin` and `poisson_dirichlet`, modal descriptor artifacts must
  use `gauge_policy=none`; pure Neumann may use mean-zero gauge.
- Seam and flux checks are necessary observability fields, but they do not
  replace residual, convergence, energy or independent physical validation.

## 6. CPU/GPU memory, workspace and transfer audit

Every artifact must publish CPU memory counters. GPU artifacts must publish
both CPU and GPU counters. Counter units are bytes unless the field name says
otherwise.

```json
{
  "cpu_allocated_bytes": 0,
  "cpu_peak_bytes": 0,
  "cpu_setup_allocated_bytes": 0,
  "gpu_allocated_bytes": 0,
  "gpu_peak_bytes": 0,
  "gpu_setup_allocated_bytes": 0,
  "workspace_reuse_count": 0,
  "workspace_rebuild_count": 0,
  "workspace_reuse_required": false,
  "hot_loop_host_allocated_bytes": 0,
  "hot_loop_device_allocated_bytes": 0,
  "hot_loop_h2d_bytes": 0,
  "hot_loop_d2h_bytes": 0,
  "hot_loop_allocation_count": 0,
  "scalar_reduction_count": 0,
  "scalar_reduction_bytes": 0,
  "scalar_reduction_bytes_threshold": 0,
  "krylov_vector_location": "host|device|not_applicable",
  "operator_input_location": "host|device|mixed",
  "operator_output_location": "host|device|mixed",
  "preconditioner_input_location": "host|device|mixed|not_applicable",
  "preconditioner_output_location": "host|device|mixed|not_applicable",
  "gpu_device_resident_solver": false,
  "gpu_device_resident_operator_apply": false,
  "gpu_device_resident_modal_eigensolver": false
}
```

Interpretation:

- `allocated_bytes` is current live allocation at artifact close; `peak_bytes`
  is the maximum observed live allocation during the run.
- `setup_allocated_bytes` is the portion allocated before the hot solve loop.
- `hot_loop_host_allocated_bytes` and `hot_loop_device_allocated_bytes` count
  allocations made after the hot loop begins; production GPU loop claims
  require `hot_loop_allocation_count == 0`.
- `workspace_reuse_required=true` requires `workspace_reuse_count > 0` and
  `workspace_rebuild_count == 0` inside the hot loop.
- `scalar_reduction_bytes` must stay at or below
  `scalar_reduction_bytes_threshold`; scalar reductions are diagnostics and
  progress signals, not hidden vector readback.

`gpu_device_krylov` or `gpu_modal_device_krylov` may be claimed only when all
of the following are true:

1. Krylov vectors, modal basis vectors, operator buffers and preconditioner
   buffers remain device resident through the loop.
2. `hot_loop_h2d_bytes == 0` and `hot_loop_d2h_bytes == 0`.
3. `hot_loop_host_allocated_bytes == 0` and `hot_loop_allocation_count == 0`.
4. Per-run setup bytes and library workspace creation are outside the hot loop
   and are identified by setup counters.
5. Orthogonalization, recurrence, residual update and preconditioner
   application are device side, with only bounded scalar/progress reductions.
6. The reconstructed original-unscaled residual trend matches a CPU oracle for
   the exact validated scope.

One-shot descriptor apply, dense inverse iteration or GPU operator callbacks
inside a host Krylov loop must report a narrower label such as
`gpu_operator_host_krylov` or `gpu_dense_k0_macrospin_modal_eigen`. The target
label `gpu_dense_contract_eigensolver` is not emitted until a modal artifact
publishes that label with the fields above.

## 7. Progress throttling

Progress policy is mode-dependent:

| Mode | Required behavior |
|---|---|
| Benchmark or validation batch | `progress_callback=null`, no live snapshots, no blocking GPU sync, partial artifacts only at controlled checkpoints. |
| UI | progress interval at least 128 iterations or 250 ms, snapshot interval at least 2000 ms, no synchronous GPU readback solely for display. |
| Debug | may emit more detail, but artifacts must mark debug mode and must not be used for performance/residency promotion. |

`progress_interval_iterations=0` never means "every iteration". It means the
solver uses the default throttled policy for the selected mode.

## 8. Partial and interrupted artifacts

Partial artifacts are first-class diagnostics. They must include:

```json
{
  "partial_artifacts_available": true,
  "partial_artifact_reason": "cancelled|interrupted|solve_error|validation_error|operator_error|progress_checkpoint",
  "complete": false,
  "solver_method": "string",
  "solver_preconditioner": "string",
  "requested_execution": {},
  "resolved_execution": {},
  "latest_residual_acceptance_name": "string",
  "latest_original_unscaled_residual_status": "ok|degraded|not_available",
  "latest_stop_reason": "string"
}
```

Rules:

- Partial artifacts may prove observability and failure classification.
- Partial artifacts do not prove production validation unless the readiness
  cell explicitly defines a failure-observability validation scope.
- Cancelled or interrupted runs must preserve enough provenance to avoid being
  mistaken for unsupported or successfully converged results.

## 9. Promotion requirements

A readiness cell may move to `production_qualified` only when telemetry shows:

1. exact requested/resolved execution for the cell;
2. reconstructed original-unscaled modal or driven residuals under the cell
   tolerance;
3. finite-mode, branch, tangent and seam checks where applicable;
4. preconditioner quality that is not harmful for the selected solver and has
   a Schur contraction ratio at or below its threshold when Schur is used;
5. Poisson/gauge policy and setup/solve-count invariants that match the
   boundary condition;
6. CPU/GPU allocated, peak, setup, workspace-reuse, hot-loop transfer and
   scalar-reduction counters matching any GPU claim;
7. complete immutable artifacts for the exact Task8 `validated_scope`;
8. validation gates from chapter 09 and production DoD from chapter 24.

No current broad periodic-airbox, nonzero-k dynamic-demag or device-Krylov
cell satisfies this full list.
