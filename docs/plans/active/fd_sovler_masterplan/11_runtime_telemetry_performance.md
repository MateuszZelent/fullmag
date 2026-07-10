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

## 1. Required envelope

Every modal or driven artifact family must carry:

```json
{
  "schema_version": "frequency_domain_runtime_telemetry.v1",
  "study_product": "modal_eigen|driven_response",
  "requested_execution": {},
  "resolved_execution": {},
  "implementation_state": "absent|contract_only|source_visible|executable",
  "validation_state": "unvalidated|algebra_validated|physics_validated|production_qualified",
  "validated_scope": "exact bounded scope or none",
  "runtime_revalidated_in_this_update": false
}
```

The telemetry must preserve requested intent and resolved reality separately.
For GPU, this means the artifact distinguishes:

```text
requested device = gpu
resolved device = gpu
resolved solver method = gpu_operator_host_krylov | gpu_device_krylov | gpu_modal_device_krylov | ...
demag provider residency = cpu | gpu | none
```

`resolved_execution.device=gpu` does not by itself prove device-resident Krylov
or strict GPU demag residency.

## 2. Residual contract

### Driven response

Driven response must report both tracked and true residuals:

```json
{
  "tracked_krylov_relative_residual": 0.0,
  "true_unpreconditioned_block_residual": 0.0,
  "last_tracked_relative_residual_l2_norm": 0.0,
  "last_recomputed_relative_residual_l2_norm": 0.0,
  "residual_consistency_relative_gap": 0.0,
  "residual_consistency_relative_gap_threshold": 0.1,
  "residual_consistency_status": "ok|degraded|not_available",
  "q_block_residual": 0.0,
  "phi_block_residual": 0.0,
  "coupled_residual_partition_status": "none|magnetic_only|scalar_only|coupled|provider_specific"
}
```

Acceptance rules:

- `status=ready` requires the true unpreconditioned residual to satisfy the
  requested solver tolerance for the exact published operator.
- A tracked GMRES residual alone is diagnostic only.
- If `residual_consistency_relative_gap > 0.1`, the solve is degraded or
  failed even when the tracked residual is small.
- Block residuals must be computed after the same nondimensional block scaling
  used for modal descriptor certification.

### Modal eigensolve

Modal artifacts must report:

```json
{
  "slepc_reported_backward_error": 0.0,
  "reconstructed_full_descriptor_backward_error": 0.0,
  "reconstruction_vs_slepc_ratio": 0.0,
  "magnetic_block_backward_error": 0.0,
  "poisson_block_backward_error": 0.0,
  "gauge_constraint_backward_error": 0.0,
  "eps_full": 0.0,
  "finite_mode_filter_status": "passed|failed|not_applicable"
}
```

Acceptance rules:

- `eps_full = max(eps_q, eps_phi, eps_gauge)`.
- `eps_full` is derived from the reconstructed original descriptor, never from
  the smaller of the SLEPc residual and reconstruction residual.
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
  "right_preconditioner_probe_relative_residual_l2_norm": 0.0,
  "schur_preconditioner_quality_available": false,
  "schur_preconditioner_quality_status": "helpful|neutral|harmful|not_available",
  "schur_preconditioner_initial_relative_residual_l2_norm": 0.0,
  "schur_preconditioner_last_observed_relative_residual_l2_norm": 0.0,
  "schur_preconditioner_quality_apply_count": 0
}
```

Normative interpretation:

- A preconditioner is `helpful` only when its application lowers the true
  unpreconditioned residual under the same block scaling.
- `harmful` or auto-disabled preconditioners are useful diagnostics but not
  production qualification evidence.
- A Schur/provider response can be executable while still unqualified if it
  lacks full coupled block assembly, original residual proof, or validation
  gates for the exact physics scope.

## 5. Poisson setup and solve counts

Dynamic-demag or Poisson-airbox paths must publish:

```json
{
  "poisson_setup_count": 0,
  "poisson_solve_count": 0,
  "poisson_operator_mode": "none|host_mfem_poisson_provider|hybrid_cpu_poisson|device_hypre_poisson|mfem_weak_form_shared_domain",
  "phi_gauge_policy": "none|mean_zero|mean_zero_augmented|matrix_free_provider_responsibility",
  "phi_gauge_constraint_applied": false,
  "delta_phi_seam_validation_status": "ok|mismatch|not_run",
  "delta_phi_flux_validation_status": "ok|mismatch|not_run",
  "h_demag_seam_validation_status": "ok|mismatch|not_run"
}
```

Rules:

- `hybrid_cpu_poisson` and `host_mfem_poisson_provider` are compatibility or
  CPU-resident demag provider modes. They do not satisfy strict GPU demag
  residency.
- For `poisson_robin` and `poisson_dirichlet`, modal descriptor artifacts must
  use `gauge_policy=none`; pure Neumann may use mean-zero gauge.
- Seam and flux checks are necessary observability fields, but they do not
  replace residual, convergence, energy or independent physical validation.

## 6. CPU/GPU residency and transfer audit

GPU artifacts must publish these counters and locations:

```json
{
  "krylov_vector_location": "host|device|not_applicable",
  "operator_input_location": "host|device|mixed",
  "operator_output_location": "host|device|mixed",
  "preconditioner_input_location": "host|device|mixed|not_applicable",
  "preconditioner_output_location": "host|device|mixed|not_applicable",
  "gpu_device_resident_solver": false,
  "gpu_device_resident_operator_apply": false,
  "gpu_device_resident_modal_eigensolver": false,
  "cuda_h2d_count": 0,
  "cuda_d2h_count": 0,
  "cuda_sync_count": 0,
  "per_iteration_h2d_count": 0,
  "per_iteration_d2h_count": 0,
  "per_iteration_allocation_count": 0,
  "scalar_reduction_count": 0
}
```

`gpu_device_krylov` or `gpu_modal_device_krylov` may be claimed only when all
of the following are true:

1. Krylov vectors, modal basis vectors, operator buffers and preconditioner
   buffers remain device resident through the loop.
2. `per_iteration_h2d_count == 0` and `per_iteration_d2h_count == 0`.
3. Per-iteration allocation is zero except for explicitly bounded library
   workspace initialization outside the loop.
4. Orthogonalization, recurrence, residual update and preconditioner application
   are device side, with only bounded scalar/progress reductions.
5. The true residual trend matches a CPU oracle for the exact validated scope.

One-shot descriptor apply, dense inverse iteration, or GPU operator callbacks
inside a host Krylov loop must report the narrower label, for example
`gpu_operator_host_krylov`, `gpu_dense_contract_eigensolver`, or
`gpu_dense_k0_macrospin_modal_eigen`.

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
  "latest_residual_status": "ok|degraded|not_available",
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
2. original unscaled modal or driven residuals under the cell tolerance;
3. finite-mode, branch, tangent and seam checks where applicable;
4. preconditioner quality that is not harmful for the selected solver;
5. Poisson/gauge policy that matches the boundary condition;
6. CPU/GPU residency and transfer counters matching any GPU claim;
7. complete immutable artifacts for the exact `validated_scope`;
8. validation gates from chapter 09 and production DoD from chapter 24.

No current broad periodic-airbox, nonzero-k dynamic-demag, or device-Krylov
cell satisfies this full list.
