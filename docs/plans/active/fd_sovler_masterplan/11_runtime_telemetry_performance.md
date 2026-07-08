---
title: Frequency-driven solver - runtime telemetry and performance
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Runtime telemetry and performance

## 1. Required solver telemetry

```json
{
  "krylov_vector_location": "host|device",
  "operator_input_location": "host|device",
  "operator_output_location": "host|device",
  "preconditioner_input_location": "host|device",
  "preconditioner_output_location": "host|device",
  "gpu_device_resident_solver": false,
  "operator_apply_count": 0,
  "preconditioner_apply_count": 0,
  "poisson_setup_count": 0,
  "poisson_solve_count": 0,
  "cuda_h2d_count": 0,
  "cuda_d2h_count": 0,
  "cuda_sync_count": 0,
  "progress_callback_count": 0,
  "snapshot_sync_count": 0
}
```

## 2. Progress policy

```text
progress_interval_iterations = 0 must not mean every iteration.
```

Benchmark mode:

```text
progress_callback = null
live_snapshot = false
write_partial_artifacts = false
```

UI mode:

```text
progress interval >= 128 iterations or >= 250 ms
snapshot interval >= 2000 ms
no blocking GPU sync for snapshot
```

## 3. Residual policy

Report both tracked and recomputed residuals:

```json
{
  "tracked_relative_residual_l2_norm": 0.0,
  "last_recomputed_relative_residual_l2_norm": 0.0,
  "true_residual_verified": true,
  "residual_norm_contract": "l2_rhs_scaled_real_split"
}
```

## 4. Schur quality

```text
z = P^-1 r
eta = ||r - A z|| / ||r||
```

Report on actual residuals, not only initial RHS.

## 5. GPU device-residency claim

`gpu_device_krylov` can be emitted only if:

```text
Krylov vectors are device-resident
operator buffers are device-resident
preconditioner buffers are device-resident
no per-iteration H2D/D2H
orthogonalization is device-side
residual trend matches CPU reference
```

Patch queue says diagnostics and callback probe exist; it does not say runtime FGMRES exists.

## 6. Current periodic-antidot stress evidence

`examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py`
is a useful stress gate for the current GPU operator-host Krylov path.

Managed run evidence from 2026-07-08:

```text
target: just run-fem-periodic-antidot-frequency-driven-managed-headless
stage 1 relaxation: completed by torque tolerance
stage 3 frequency response: production_gpu, periodic_airbox_k0
input_preflight.status: ok
max_iterations_for_frequency: 8192
restart_iterations_for_frequency: 512
total_iteration_count: 8192
relative_residual_l2_norm: 8.430517903883425
status: solve_error
validation_fallback_used: false
partial_artifacts_available: true
```

Important diagnostics:

```text
right_preconditioner_auto_disabled: true
right_preconditioner_auto_disable_reason: pilot_selected_unpreconditioned_after_probe
right_preconditioner_probe_relative_residual_l2_norm: 6.584202879742948
schur_preconditioner_initial_relative_residual_l2_norm: 7.4190907245080915
schur_preconditioner_sweep_relative_residual_l2_norm: 7.419..7.527..7.405
residual_consistency_status: degraded
```

This confirms that the current GPU path is observability-capable but not a
validated production solver for the full periodic-antidot dynamic-demag case.
The input-preflight artifact now carries a `periodic_mesh_certificate.v5`
candidate section with canonical `sha256:` magnetic and airbox pair-map hashes,
so periodic-airbox stress runs can be traced to the exact solver-lane pair maps.
The required next work is still certified full-coupled/Schur contraction and
native `G_pair` consumption, not only a larger GMRES restart.

Managed GPU periodic-airbox smoke evidence from 2026-07-08 confirms the same
boundary. `just verify-fem-frequency-domain-periodic-airbox-gpu-runtime`
rebuilt the managed FEM runtime and wrote the new preflight certificate
candidate hashes, but the solve ended with `status=validation_error` after
`GMRES=8192/8192`, `relative_residual_l2_norm=9.2642276718065e24`,
`residual_consistency_status=degraded`, and
`delta_phi_phase_validation_status=failed`. The native error was:

```text
periodic-airbox k=0 solved delta_phi response violates periodic seam constraints
```

Follow-up native contract evidence from 2026-07-08: `just
verify-fem-frequency-domain-native-contract` passes after preserving postsolve
`delta_phi` mismatch residuals and best constant seam offsets in both direct
result diagnostics and response artifacts. This changes the next failing
periodic-airbox run from an opaque `failed` status toward actionable
`mismatch` diagnostics; it does not change the underlying Schur/GMRES
convergence result.

Second follow-up native/runtime evidence from 2026-07-08: `just
verify-fem-frequency-domain-native-contract` passes after adding generic
GMRES residual-consistency degradation detection. The managed periodic-airbox
GPU runtime now stops after 132 iterations with:

```text
status: solve_error
native error: production frequency-response GMRES residual consistency degraded
relative_residual_l2_norm: 4.341950078029695
last_tracked_relative_residual_l2_norm: 0.0008480034623546483
last_recomputed_relative_residual_l2_norm: 4.341950078029695
residual_consistency_status: degraded
krylov_preconditioner_kind: none
right_preconditioner_auto_disabled: true
right_preconditioner_auto_disable_reason: probe_relative_residual_above_threshold
right_preconditioner_probe_relative_residual_l2_norm: 422769.88891747926
right_preconditioner_fallback_probe_relative_residual_l2_norm: 13.40885193418363
schur_preconditioner_sweep_relative_residual_l2_norm:
  [13.408851934183692, 169.52680596072662, 2281.1021626273337, 30975.195238984375]
```

This is the desired telemetry behavior for the current incomplete solver: the
runtime rejects false tracked GMRES convergence early. It remains blocked as a
production periodic-airbox dynamic-demag solver until the certified/full-coupled
Schur path contracts the true recomputed residual.

Third follow-up native/runtime evidence from 2026-07-08: Schur quality
diagnostics now publish the v5 threshold classification field
`schur_preconditioner_quality_status`. The native contract gate passes, and the
managed periodic-airbox GPU smoke reports:

```text
status: solve_error
native error: production frequency-response GMRES residual consistency degraded
total_iteration_count: 130
relative_residual_l2_norm: 1.1116736446120163
last_tracked_relative_residual_l2_norm: 0.0009325591415167876
last_recomputed_relative_residual_l2_norm: 1.1116736446120163
residual_consistency_status: degraded
residual_consistency_recomputed_to_tracked_ratio: 1192.0677146587216
krylov_preconditioner_kind: none
right_preconditioner_auto_disabled: true
right_preconditioner_auto_disable_reason: probe_relative_residual_above_threshold
schur_preconditioner_quality_available: true
schur_preconditioner_quality_status: harmful
schur_preconditioner_sweep_relative_residual_l2_norm:
  [13.43191494483227, 170.31635815858712, 2310.2844332372265, 31544.245991230284]
```

This makes the documented threshold policy observable directly in runtime
artifacts. It does not change the solver selection outcome: this workload must
not select the current Schur/preconditioner path by default.

Fourth follow-up native evidence from 2026-07-08: production GMRES now enforces
the v5 stagnation guard from this document. The native contract gate passes
with a bounded no-contraction operator:

```text
contract: production_cpu_matrix_free_solver_stops_stagnated_run_at_256_iterations
status: solve_error
total_iteration_count: 256
stagnation_detected: true
stagnation_iteration: 256
stagnation_relative_residual_ratio: >0.9
relative_residual_l2_norm: >1e-2
error_message: production frequency-response GMRES stagnated
```

This prevents long 8192-iteration runs when the 256-iteration residual evidence
already satisfies the documented stagnation condition. It is a runtime
stop-policy improvement, not a replacement for certified/full-coupled Schur.

Fifth follow-up native evidence from 2026-07-08: the stop-policy telemetry is
now visible in returned diagnostics and `response/diagnostics/solver.v1.json`.
The focused contract
`production_cpu_lane_writes_failure_artifacts_for_nonconverged_gmres` verifies:

```text
stop_reason: max_iterations
stagnation_detected: false
stagnation_iteration: 0
stagnation_relative_residual_ratio: 0
```

Together with the native 256-iteration stagnation contract, this makes the
stop-policy machine-readable both at the solver-result layer and the artifact
layer.

Sixth follow-up native/runtime evidence from 2026-07-08: the managed
periodic-airbox GPU smoke now reaches the residual-consistency fail-fast
boundary:

```text
target: just verify-fem-frequency-domain-periodic-airbox-gpu-runtime
status: solve_error
total_iteration_count: 134
last_tracked_relative_residual_l2_norm: 5.47212062306515e-4
last_recomputed_relative_residual_l2_norm: 7.6763392511713855
residual_consistency_recomputed_to_tracked_ratio: 14028.088523515707
residual_consistency_status: degraded
schur_preconditioner_quality_status: harmful
delta_phi_seam_validation_status: ok
delta_phi_flux_validation_status: ok
stop_reason: residual_consistency_degraded
stagnation_detected: false
```

This confirms that the current blocking runtime issue is a false tracked
GMRES residual / harmful Schur-preconditioner path, not a latest-run
delta_phi seam mismatch. The periodic-airbox phi-consistency solve-error
artifact path now surfaces this as machine-readable stop telemetry.

Seventh follow-up native evidence from 2026-07-08: provider-side
periodic-airbox phi-consistency artifacts now report the concrete k=0
scalar-potential gauge policy. The no-exchange
`matrix_free_mfem_demag_phi_consistency_schur_provider` happy path requires
`phi_gauge_policy="mean_zero"` and `phi_gauge_constraint_applied=true` in
`frequency_domain/manifest.v1.json`,
`response/diagnostics/solver.v1.json`, and
`response/frequency_points/frequency_0000.json`. The RED contract failed on the
missing manifest policy; GREEN passed through
`just verify-fem-frequency-domain-native-contract` after managed runtime
rebuild.

This closes a runtime provenance gap required by the v5 gauge/nullspace
contract. It does not change the Schur/preconditioner mathematics and therefore
does not alter the current large periodic-airbox residual-consistency failure.
artifact path now has a native contract for `stop_reason` and stagnation
fields, so this failure class is expected to become directly machine-readable
as `stop_reason=residual_consistency_degraded` after managed runtime rebuild.

Eighth follow-up implementation evidence from 2026-07-08: frequency-response
solver policy plumbing now includes explicit preconditioner selection. The
Python DSL, script rewrite, stage draft payload, ProblemIR/Rust IR, and runner
env guard carry `solver_preconditioner` / `solver_policy.preconditioner`; the
runner sets `FULLMAG_FEM_FREQUENCY_RESPONSE_PRECONDITIONER_VARIANT` for the
native frequency-response runtime. Supported public values are `auto`,
`graph_demag_coarse`, `demag_coarse`, `block_jacobi`, and `none`.

The periodic antidot driven example now requests `auto` explicitly for the
transitional `gpu_operator_host_krylov` lane. This keeps the workload on an
honest user-visible solver lane while allowing runtime probes to disable
harmful right-preconditioner variants. It does not reclassify the Schur path as
validated.

Ninth follow-up runner evidence from 2026-07-08: running and interrupted
`response/progress.v1.json` artifacts now include the requested
`solver_method` and `solver_preconditioner` both as top-level fields and inside
the embedded `progress_json` string. This closes the observability gap seen in
long periodic-antidot runs where the solve could be interrupted before
`response/diagnostics/solver.v1.json` existed. The focused runner test
`native_frequency_response_progress_artifact_records_solver_iteration` covers
the `gpu_operator_host_krylov` plus explicit preconditioner progress artifact
path, and the full runner `--features fem-gpu --no-run` compile check passes.

Tenth follow-up native telemetry evidence from 2026-07-08: the
periodic-airbox phi-consistency `solve_error` direct `diagnostics_json` now
contains `coupled_residual_partition_status` and `coupled_block_norms` for the
`magnetic_schur_phi_consistency_provider` path, matching
`response/diagnostics/solver.v1.json`. The added contract first failed on the
missing direct diagnostics field and then passed with
`just verify-fem-frequency-domain-native-contract`. This makes a failing run
immediately show whether the recomputed residual is dominated by magnetic
delta_m or scalar-potential delta_phi components, without waiting for a
completed frequency-point artifact. It remains an observability fix only; the
large periodic-airbox Schur/GMRES residual-consistency failure is still open.

Eleventh follow-up runtime evidence from 2026-07-08: the managed periodic-airbox
GPU smoke was rerun after the split-residual diagnostics patch. With the default
`auto` preconditioner policy, runtime auto-disabled the harmful right
preconditioner and failed at `stop_reason=residual_consistency_degraded` with
`last_tracked_relative_residual_l2_norm=8.524008946930797e-4`,
`last_recomputed_relative_residual_l2_norm=6.09485709510772`,
`residual_consistency_recomputed_to_tracked_ratio=7150.2237187377295`, and
`coupled_block_norms.relative_residual_delta_m_l2_norm=6.094857095107722` while
`relative_residual_delta_phi_l2_norm=0`. Forcing `block_jacobi` was worse on
the same smoke: `last_recomputed_relative_residual_l2_norm=8.810998387778028`
and `residual_consistency_recomputed_to_tracked_ratio=12249.534331532765`.
Therefore the periodic-antidot driven example and its managed target now use
`solver_preconditioner="auto"` / preconditioner env default `auto`, not
`block_jacobi`. This is still a failing production workload; the evidence only
narrows the blocker to magnetic Schur/reduced-operator residual consistency
rather than scalar-potential phi residual.

Twelfth follow-up implementation/runtime evidence from 2026-07-08: host GMRES
now performs residual replacement for unpreconditioned true/tracked residual
gaps instead of terminating immediately. The right-preconditioned path still
returns `solve_error` on residual-consistency degradation so `auto` can
disable/retry harmful preconditioners. Verified by the new native contract
`production_cpu_matrix_free_solver_restarts_after_unpreconditioned_residual_gap`
and the full managed
`just verify-fem-frequency-domain-native-contract` gate.

With this policy, the managed periodic-airbox GPU smoke advances past the old
`GMRES=128` residual-consistency abort and now fails at
`stop_reason=stagnated`, `total_iteration_count=260`,
`stagnation_iteration=260`, and
`last_recomputed_relative_residual_l2_norm=13.195808726437836`. The split
residual remains magnetic-only:
`coupled_block_norms.relative_residual_delta_m_l2_norm=13.195808726437836` and
`relative_residual_delta_phi_l2_norm=0`. This is progress in failure mode
classification, not a production-ready solve.

Thirteenth follow-up runtime evidence from 2026-07-08: the default
periodic-airbox GPU frequency-response runtime target now uses
`FULLMAG_FEM_GPU_DEMAG_MODE=hybrid_cpu_poisson`, and the artifact telemetry
reports that resolved policy instead of hardcoding `device_hypre_poisson`.
The end-to-end managed smoke
`just verify-fem-frequency-domain-periodic-airbox-gpu-runtime` passes with:

```text
solver_status=ready
total_iteration_count=2
relative_residual_l2_norm=2.3535067523302147e-16
static_periodic_reduced_magnetic_solve=true
uses_gpu_poisson=false
demag_operator_mode=hybrid_cpu_poisson
hypre_execution_policy=host
demag_provider_residency=cpu
```

This makes the periodic-antidot frequency-driven example executable through the
documented GPU operator / host Krylov compatibility lane. It also narrows the
remaining red path: `FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson` still
fails on magnetic reduced-operator residual consistency and must remain
unqualified until device-Hypre dynamic demag is made stationary/contracting.

Fourteenth follow-up runtime evidence from 2026-07-08: the full managed
periodic-antidot frequency-driven target now passes end-to-end in the hybrid
compatibility lane:

```text
target: just run-fem-periodic-antidot-frequency-driven-managed-headless
demag mode env: FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE=hybrid_cpu_poisson
relaxation: completed by torque tolerance in 49 steps
response status: ready
response complete: true
completed_frequency_points: 1
written_frequency_point_artifacts: 1
total_iteration_count: 2006
relative_residual_l2_norm: 0.0009994399206910052
residual_consistency_status: ok
delta_phi_seam_validation_status: ok
delta_phi_flux_validation_status: ok
h_demag_seam_validation_status: ok
demag_operator_mode: hybrid_cpu_poisson
hypre_execution_policy: host
demag_provider_residency: cpu
uses_gpu_poisson: false
right_preconditioner_auto_disabled: true
right_preconditioner_auto_disable_reason: pilot_selected_unpreconditioned_after_probe
schur_preconditioner_quality_status: harmful
```

The verifier passes with the target's compatibility-mode contract:

```text
FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE=hybrid_cpu_poisson
FULLMAG_FEM_FREQUENCY_RESPONSE_DELTA_PHI_FLUX_MAX_TOLERANCE_T=2e-2
python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py \
  --require-production-gpu \
  --require-periodic-airbox-gpu-demag-solved \
  .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts
```

This is executable and verified for the example's current managed target, but
it is not a device-residency or strict GPU-demag performance closure. The
current fastest reliable method for this example is therefore
`solver_method="gpu_operator_host_krylov"` with `solver_preconditioner="auto"`
and hybrid CPU Poisson demag; strict `device_hypre_poisson` and
`gpu_device_krylov` remain separate unqualified gates.
