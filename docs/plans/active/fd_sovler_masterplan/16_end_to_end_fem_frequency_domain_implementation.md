---
title: End-to-end FEM frequency-domain implementation contract
version: target v6 contract over current v5 runtime and native ABI v12
date: 2026-07-10
status: normative target with explicit current contract gaps
---

# End-to-end FEM frequency-domain implementation

## 1. Authority and status vocabulary

This chapter specifies the complete public-to-native data flow for FEM modal
eigen and driven response. Equations, signs, units, equilibrium acceptance and
periodic/Floquet semantics remain owned by:

- `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`,
- `03_relaxed_texture_linearization.md`,
- `04_mesh_periodic_floquet_airbox.md`,
- `docs/specs/frequency-domain-artifacts-v2.md`.

The tables below use exact current names where a field exists. `contract_gap`
means that no current field or propagation link exists at that layer. A target
name beside `contract_gap` is a requirement, not a claim of current support.
Implementation, execution and validation are independent states:

```text
implemented != executable != validated != production_qualified
```

## 2. Mandatory stage order

Every modal or driven solve follows this order. No later stage may recreate,
override or silently weaken an earlier decision.

```text
1  Python DSL / UI authoring
2  ProblemIR lowering
3  semantic validation
4  capability and requested/resolved execution planning
5  EquilibriumArtifact -> LinearizationState
6  periodic/Floquet certificate
7  native request materialization
8  MFEM operator/block assembly
9  FrequencySolvePlanner
10 one selected engine
11 full residual certification
12 artifact publication
13 OpenAPI/resource/UI inspection
```

The current runtime does not yet implement this complete chain. In particular,
`EquilibriumArtifact.v6`, `LinearizationState.v6`,
`periodic_mesh_certificate.v6`, target engine selection for modal solves, and
the hardened manifest envelope are `contract_gap`. Existing v5 structs,
pair-list metadata and artifacts remain evidence only for their exact scope.

## 3. Current lanes versus target engines

The current C ABI lane enum is not the target solver-engine vocabulary.

| Layer | Current exact names | Meaning | Target requirement |
|---|---|---|---|
| C ABI driven lane | `FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_VALIDATION`, `..._PRODUCTION_CPU`, `..._PRODUCTION_GPU` | broad request/routing class | retain as compatibility input only; diagnostics must resolve one engine |
| Rust native lane | `NativeFrequencyDomainExecutionLane::{Validation,ProductionCpu,ProductionGpu}` | maps one-to-one to the C ABI enum | do not expose as proof of algorithm or residency |
| C++ driven lane | `DrivenFrequencyResponseExecutionLane::{validation,production_cpu,production_gpu}` | current native routing | same compatibility role |
| Current planner engines | `dense_reference`, `cpu_sparse_direct`, `full_coupled_field_split`, `schur_reduced`, `modal_reduced`, `gpu_operator_host_krylov`, `gpu_device_krylov` | current `FrequencyExecutionLane` values | preserve exact names where implemented |
| Target-only engine split | `dense_cartesian_reference`, `dense_tangent_reference`, `gpu_modal_device_krylov` | target distinctions from the hardening plan | `contract_gap`; do not publish these as current engines |
| Current ad hoc runtime labels | `production_cpu_host_gmres`, `k0_poisson_airbox_cpu_full_coupled_slepc`, `gpu_operator_host_modal_eigen_compatibility` and solver-specific `solver_adapter` values | implementation diagnostics, not planner enums | map to a target engine plus `implementation_id`; do not silently rename them |

`requested_execution_lane` and `resolved_execution_lane` remain compatibility
fields while they exist. The target manifest additionally records
`requested_execution` and `resolved_execution`, where the resolved object names
the single engine, solver library, device, precision, assembly, residency and
fallback decision.

## 4. Modal eigen traceability

| Concern | Python DSL / UI authoring | `StudyIR` | `ExecutionPlanIR` | Current native ABI/runtime | Artifact, OpenAPI and UI | Unit/default | Validation owner and unsupported behavior |
|---|---|---|---|---|---|---|---|
| Frequency window and count | `Eigenmodes.count` default `20`; `target` is `lowest`, `nearest` or `frequency_window`; `target_frequency`, `frequency_min`, `frequency_max`. UI: `StudyStageDraft.count`, `target`, `targetFrequency`, `frequencyMin`, `frequencyMax`. | `StudyIR::Eigenmodes { count, target: EigenTargetIR::{Lowest,Nearest { frequency_hz },FrequencyWindow { frequency_min_hz,frequency_max_hz }} }`. | `FemEigenPlanIR.count`, `.target`. | `FullmagFemModalEigenRequest.requested_mode_count`, `target_kind`, `target_frequency_hz`, `frequency_min_hz`, `frequency_max_hz`, `residual_tolerance`, `max_outer_iterations`, `max_linear_iterations`. | `eigen/diagnostics/solver.v1.json`: `requested_window_hz`, `resolved_search_window_hz`, `requested_mode_count`, `mode_count`, `window_completeness`, `subwindows[]`; spectrum through `/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2` and `useFrequencyDomainEigenSpectrumResource()`. | Hz; count `20`; native runner currently injects residual/iteration defaults rather than receiving public modal policy. | Python/IR validate positive ordered bounds and count. Certified window completeness is not current general support; false completeness is an artifact failure. |
| k sampling and phase convention | `k_sampling`, legacy `k_vector`; `KPoint`, `KPath(points,samples_per_segment,closed)`; `FloquetBC.phase_convention` default `exp_minus_i_k_dot_delta_r`. UI: `kSampling`, `kVector`, `kPath`, `bc`. | `KSamplingIR::{Single { k_vector },Path { points,samples_per_segment,closed }}`; `SpinWaveBoundaryConditionIR`; `PhaseConventionIR::ExpMinusIKDotDeltaR`. | `FemEigenPlanIR.k_sampling`, `.spin_wave_bc`; no independent target certificate ID: `contract_gap`. | `FullmagFemLinearizedOperatorRequest.k_vector_rad_m/k_vector_len`; `FullmagFemModalEigenRequest.has_floquet_k_vector`, `floquet_k_vector_rad_per_m[3]`, `phase_convention`, `mfem_floquet_periodic_pairs/count`. | `spectrum.v2.json.samples[].k_vector`, `dispersion.csv`, `eigen/dispersion/path.json`; API `eigen/dispersion`; UI hooks `useFrequencyDomainEigenDispersionResource()` and `useFrequencyDomainEigenBranchesResource()`. | k in rad/m; translation in m; phase exactly `exp(-i*k dot R)`. | Pair metadata alone is not an operator. Nonzero-k modal dynamic demag and target v6 magnetic/scalar equivalence-class consumption are `contract_gap`; reject rather than reuse K0 or post-project a phase. |
| Equilibrium source and artifact identity | `equilibrium_source` is `provided`, `relax` or `artifact`; `equilibrium_artifact` is required for `artifact`. UI fields have the same semantic names. | `EquilibriumSourceIR::{Provided,RelaxedInitialState,Artifact { path }}`. | `FemEigenPlanIR.equilibrium` and `.equilibrium_magnetization`; accepted artifact digest, five signatures and `LinearizationState.v6` ID are `contract_gap`. | `FullmagFemLinearizedOperatorRequest.equilibrium_source_kind`; modal runner passes equilibrium arrays through operator materialization. Native `EquilibriumArtifactDescriptor` and `build_linearization_state_from_equilibrium()` exist but are not connected to planner/runner: `contract_gap`. | Current modal manifest writes `requested_execution.equilibrium_source = "provided_or_planned"`, so exact source/artifact identity is `contract_gap`. Target: equilibrium and linearization hashes in the manifest and mode metadata. | `m0` dimensionless; `h_eff0` and `h_demag0` A/m; `phi0` A when required. | `03_relaxed_texture_linearization.md` owns acceptance and exact reject reasons. Solvers must not relax or reconstruct an artifact-selected equilibrium. |
| `include_demag` and magnetostatic BC | `Eigenmodes.include_demag`; no modal `magnetostatic_bc` field: `contract_gap`. The demag realization is authored outside the stage through the common physics/backend policy. | `EigenOperatorConfigIR.include_demag`; no modal `MagnetostaticBoundaryConditionIR`: `contract_gap`. | `FemEigenPlanIR.enable_demag`, `.demag_realization`, `.air_box_config`; no modal `magnetostatic_bc`: `contract_gap`. | `FullmagFemLinearizedOperatorRequest.include_demag`, `demag_realization`; Poisson block enabled by `poisson_airbox_block_enabled`. | Current manifest has `requested_execution.include_demag` and `resolved_execution.demag_realization`; target requires exact requested/resolved BC and demag tuples. | Boolean default Python `True`; demag fields A/m. | Floquet modal demag is rejected except explicitly labelled analytic/synthetic validation paths. Nonzero-k numerical FEM demag-k is `contract_gap`. |
| Outer boundary, Robin beta and gauge | No modal-stage field. Common airbox policy can resolve lower-layer `bc_kind`, `robin_beta_mode`, `robin_beta_factor`, but public stage-to-ABI traceability is `contract_gap`. | No fields in `StudyIR::Eigenmodes`: `contract_gap`. | `FemEigenPlanIR.air_box_config.{bc_kind,robin_beta_mode,robin_beta_factor}`. Exact target `outer_boundary_kind/gauge_policy/gauge_reason` tuple is not carried as one plan object: `contract_gap`. | `FullmagFemModalEigenRequest.poisson_airbox_outer_boundary_kind`, `poisson_airbox_robin_beta`, `poisson_airbox_gauge_policy`, `poisson_airbox_gauge_reason`, `poisson_airbox_assembly_kind`. Current runner Poisson payload is labelled `synthetic_algebraic_oracle`, commonly `pure_neumann/mean_zero_augmented`. | Current diagnostics expose some of these fields; target manifest requires `assembly_kind` and one BC/gauge tuple. | `robin_beta` in 1/m; valid target tuples are `poisson_robin(beta>0)/none`, `poisson_dirichlet/none`, `pure_neumann/mean_zero_augmented`. | `04_mesh_periodic_floquet_airbox.md` owns tuple validation. Coercive Robin/Dirichlet must not receive an eta row; pure Neumann must. Real shared-domain `mfem_weak_form_shared_domain` promotion is `contract_gap`. |
| Requested device and precision | `RuntimeSelection.device_target`, `execution_precision`, `execution_mode`; UI uses `change_device`/`StudyStageDraft.deviceTarget`. | Device is in backend/runtime policy, not `StudyIR::Eigenmodes`. | `FemEigenPlanIR.precision`; requested device is absent: `contract_gap`. `CommonPlanMeta` carries requested/resolved backend and execution mode only. | Modal `FullmagFemModalEigenRequest` has no requested lane/device/precision field: `contract_gap`. Dispatch chooses CPU/GPU outside the request. | Modal manifest currently hardcodes requested/resolved CPU/double in the common writer, so GPU/request intent traceability is `contract_gap`. | default double; current FEM modal rejects single. | Forced GPU must not silently run CPU. The narrow K0 no-demag Kittel GPU path does not imply general modal GPU or Poisson-airbox GPU eigensolve support. |
| Solver method and spectral transform | `Eigenmodes` has no solver policy or spectral transform field: `contract_gap`. UI has no modal solver-method control. | No modal solver-policy fields: `contract_gap`. | `FemEigenPlanIR` has no solver policy: `contract_gap`. | `FullmagFemModalEigenRequest.eigensolver_family`, `spectral_transform_kind`; Poisson shift action uses `poisson_airbox_shift_sigma_real/imag`. Runner currently supplies fixed numeric values. | Diagnostics currently use `solver_adapter`, `solver_family`, `spectral_transform`, `shift_frequency_hz` and related fields. Target adds `spectral_scalar_mode`, `sigma_real_per_s`, `sigma_imag_rad_per_s`. | sigma in rad/s; target `sigma = i*omega_target`; current defaults depend on runner path. | Real PETSc requires `spectral_scalar_mode=real_split`; a real-axis shift for an imaginary spectrum is invalid. Public round-trip and deterministic planner selection are `contract_gap`. |
| Normalization and output fields | `normalization` is `unit_l2` or `unit_max_amplitude`; outputs are `SaveSpectrum`, `SaveMode`, `SaveDispersion`, `SaveEigenDiagnostics`. | `EigenNormalizationIR`; `SamplingIR.outputs` with matching `OutputIR` variants. | `FemEigenPlanIR.normalization`; `OutputPlanIR.outputs`. | Native request controls partial artifacts and solver payloads, but does not carry the complete public output selection: `contract_gap`. | `spectrum.v2.json`, `branches.v2.json`, `dispersion.csv`, per-mode metadata and `mode_fields.zarr`; API mode metadata and binary field resources; UI spectrum/dispersion charts, mode tables and 3D mode overlay. | `delta_m` dimensionless; mode Zarr `[node,component,complex]`, XYZ, real/imag; production validation prefers float64. | Artifact writer/validator owns normalization identity, mode count, residual, tangent leakage and payload shape. Missing requested public output is an artifact failure, not permission to synthesize data. |

## 5. Driven-response traceability

| Concern | Python DSL / UI authoring | `StudyIR` | `ExecutionPlanIR` | Current native ABI/runtime | Artifact, OpenAPI and UI | Unit/default | Validation owner and unsupported behavior |
|---|---|---|---|---|---|---|---|
| Frequency sweep | `FrequencyResponse.frequencies_hz`; UI `StudyStageDraft.frequenciesHz`. | `FrequencySweepIR.values_hz`. | `FemFrequencyResponsePlanIR.frequencies_hz`. | `fullmag_fem_frequency_domain_driven_response_request.frequencies_hz/frequency_count`. | `magnetic_response_sweep.v2.json.points[]`, per-frequency artifacts, progress resource; API `response/magnetic-sweep`; `useFrequencyDomainResponseSweepResource()`. | finite positive Hz; no empty default is accepted. | Python, IR/planner, runner and native request validation reject empty, nonfinite or nonpositive values. A native path currently accepts only a single k sample even when frequency count is many. |
| Dynamic field phasor real/imag | Current public field is misspelled but exact: `excitation_field_au_per_m` plus `excitation_phase_rad`; it represents one real vector with one global phase. UI fields: `excitationField`, `excitationPhaseRad`. Independent per-component real/imag authoring is `contract_gap`. | `FrequencyExcitationIR.field_au_per_m`, `.phase_rad`; independent complex vectors are `contract_gap`. | `FemFrequencyResponsePlanIR.excitation`; runner projects the physical Cartesian field into `drive_tangent_real`/`drive_tangent_imag`. | C ABI consumes `mfem_drive_real/imag` with value counts and internal order `[u0,v0,u1,v1,...]`. Current buffers are tangent-coordinate physical-field components in A/m, while the solver consumes them as `b`; `project_dynamic_field_drive_to_tangent_rhs` exists but is not integrated into a production caller. The target conversion is the explicit LLG torque projection `T^T[-gamma0(m0 x delta_h_drive)]`. This is a `contract_gap`, not current RHS support. | Point/sweep `excitation_provenance`; target manifest records physical phasor representation, projection identity, and whether buffers represent `dynamic_field` or `tangent_rhs`. | Physical `h_drive` A/m; phase rad. Internal tangent RHS has operator-dictionary units only after explicit LLG conversion. | Runner/native must own exactly one conversion from physical field to internal RHS. Arbitrary complex XYZ phasors and production use of the existing conversion helper are `contract_gap`. |
| `drive_kind` and zero-drive policy | No public `drive_kind` or zero-drive policy: `contract_gap`. Current runner rejects zero physical field before native production execution. | No fields: `contract_gap`. | No fields: `contract_gap`. | ABI enum includes `DYNAMIC_FIELD_PHASOR_A_PER_M`, `TANGENT_RHS`, `CARTESIAN_TORQUE_PHASOR`, `STT_CURRENT_PHASOR`, `COUPLED_EXTERNAL_PROVIDER`; `require_nonzero_rhs` exists. Rust materialization currently sends `DRIVE_UNSPECIFIED` and `0`, which normalizes to dynamic field and zero-response-allowed in native code: incomplete propagation. | Native diagnostics may emit `zero_drive_warning` and `zero_drive_policy="zero_response_allowed"`; target manifest must publish requested and resolved drive policy. | default public drive `(0,0,1)` A/m, phase `0`; target physical zero drive yields a valid zero response only when explicitly allowed. | Physical-drive semantics must be separated from internal `tangent_rhs`. Current public rejection versus native zero-response allowance is a `contract_gap` that must be closed before claiming one policy. |
| k sampling and BC | `k_sampling`/legacy `k_vector`, `spin_wave_bc`, `magnetostatic_bc` default `open`. | `KSamplingIR`, `SpinWaveBoundaryConditionIR`, `MagnetostaticBoundaryConditionIR::{Open,PeriodicAirboxK0,FloquetAirbox}`. | Same fields plus `periodic_constraint_sets`. | ABI uses static pairs, Floquet pair records, `has_floquet_k_vector`, `phase_convention`, `requires_periodic_airbox_dynamic_demag`, `requires_floquet_airbox_dynamic_demag`, and magnetic/magnetostatic constraint counts. | Manifest physics/diagnostics, periodic-pair artifacts, point fields and API/UI resources. | k rad/m; `exp(-i*k dot R)`; default open/free and no k sample. | `periodic_airbox_k0` requires k=0 and periodic magnetic BC. `floquet_airbox` requires nonzero k, Floquet magnetic BC and dynamic scalar constraints. K0 substitution, open-boundary substitution and postsolve phase projection are forbidden. |
| Normalization and observables | `normalization`; outputs may include `SaveResponse(observable)` with current IDs `m_complex`, `u_complex`, `strain_complex`, `stress_complex`, `susceptibility_tensor`, `absorbed_power_density`, `response_amplitude`, `response_phase`, `mode_hybridization_index`. UI currently authors one `observable`. | `FrequencyResponseNormalizationIR`; `OutputIR::FrequencyResponseOutput { observable }` through sampling. | `FemFrequencyResponsePlanIR.normalization`; `OutputPlanIR.outputs`. | ABI writes response fields under `write_response_fields`; complete observable selection is not carried to native: `contract_gap`. | sweep/point observables, `field_payloads.zarr`, metadata and binary data plane; Analysis Plots response chart, frequency-point inspector and 3D response field. | `delta_m` dimensionless; `delta_M=Ms*delta_m`; SI chi dimensionless; normalized `delta_m/h_drive` m/A; physical power W/m3 only with volume weighting. | Artifact contract owns units/provenance. Unsupported mechanics/magnetoelastic observables must be rejected or marked unavailable, not emitted as magnetic proxies. |
| Solver method, preconditioner, rtol, max and restart | `FrequencyResponseSolverPolicy.{method,preconditioner,rtol,max_iterations,restart_iterations}`. UI only persists `solverMethod`; preconditioner/tolerances/iteration controls are `contract_gap`. | `FrequencyResponseSolverPolicyIR` with the same exact fields. | `FemFrequencyResponsePlanIR.solver_policy`. | ABI fields: `solver_relative_tolerance`, `solver_absolute_tolerance`, `solver_max_iterations`, `solver_restart_iterations`, `solver_progress_interval_iterations`. Runner currently threads public policy through temporary environment variables; `method` is not an ABI field. | `response/diagnostics/solver.v1.json`: requested/resolved solver method, Krylov/preconditioner fields, tolerances, iterations and residual history. | rtol positive dimensionless; iteration counts positive; zero ABI values select native defaults. | Implemented method subset is checked in runner. `cpu_sparse_direct`, `full_coupled_field_split`, `modal_reduced`, `gpu_device_krylov` public enum values are currently rejected by runtime. Forced concrete preconditioners must not auto-resolve to `none`. |
| Requested device and precision | Common `RuntimeSelection.device_target`, `execution_precision`, `execution_mode`; UI `change_device` and `deviceTarget`. | Backend/runtime policy outside the stage. | `FemFrequencyResponsePlanIR.requested_device`, `.precision`; `CommonPlanMeta` requested/resolved backend and execution mode. | Compatibility lane enum is `validation/production_cpu/production_gpu`; no ABI precision field because current native response is double-only. | Native diagnostics publish `requested_execution_lane`, `resolved_execution_lane`, `validation_fallback_used`; target manifest publishes full requested/resolved objects and device residency. | current FEM response double only. | Forced GPU unavailability writes/resolves `unavailable`, never CPU. Single precision rejects in planner. A GPU operator with host Krylov must not be labelled device-resident. |
| Progress and snapshot policy | No public response progress/snapshot policy object: `contract_gap`; outputs choose result artifacts only. | No progress policy: `contract_gap`. | No progress policy; runner/native defaults apply. | ABI callbacks plus `solver_progress_interval_iterations`; cancellation callback; `write_response_fields`, `write_partial_artifacts`. | `response/progress.v1.json`, `cancel_requested.v1.json`, `frequency_points[]`, field payloads; live source `/simulation/stages/execution`; durable hooks `useFrequencyDomainResponseProgressResource()` and cancel resource hook. | progress `[0,1]` or percent; current interval default comes from native runtime when ABI value is zero. | Live stage progress is authoritative while running; durable progress is authoritative after interruption/completion. Progress is not convergence evidence. Missing partial artifacts must not be presented as a completed sweep. |

## 6. Product and k-domain legality

| Product/scope | Current executable boundary | Required hardening behavior |
|---|---|---|
| Modal, k0, no demag | CPU production selected-spectrum paths and a narrow Kittel GPU exception exist in separate implementations. | Preserve exact lane and validation scope; never infer general GPU modal support. |
| Modal, k0, Poisson airbox | Current ABI and CPU SLEPc adapter accept Poisson block payloads; current runner evidence includes synthetic/algebraic payloads and v5 certificates. | Require real `mfem_weak_form_shared_domain`, exact BC/gauge tuple, v6 equilibrium/certificate hashes and block residual certification before production qualification. |
| Modal, nonzero-k, no demag | Narrow Bloch/Floquet pair/operator paths exist; artifact acceptance remains scope-specific. | Require per-sample operator materialization and exact requested/resolved provenance. |
| Modal, nonzero-k, dynamic demag | `contract_gap`. | Reject with the documented missing dynamic-demag-k/operator reason; no K0 or analytic fallback may be relabelled numerical FEM. |
| Driven, k0, open/free | Native CPU and GPU routing exists for supported magnetic terms. | Publish selected engine and host/device residency independently from ABI lane. |
| Driven, k0, `periodic_airbox_k0` | Native provider/Schur response path exists with explicit no-dense-fallback behavior. | Require accepted equilibrium provenance, scalar/magnetic constraint counts, seam/flux diagnostics and exact assembly/BC/gauge provenance. |
| Driven, nonzero-k, no demag | Narrow single-k Floquet projection/operator slices exist. | Keep single-k limitation explicit; `KSamplingIR::Path` native materialization is `contract_gap`. |
| Driven, nonzero-k, `floquet_airbox` dynamic demag | Planner/native metadata exists, but the production numeric coupled demag-k implementation/qualification is `contract_gap`. | Reject without CPU/K0/open fallback and publish the exact unavailable reason. |

## 7. Error and fallback contract

Native statuses remain exact and product-independent:

```text
ok
unavailable
validation_error
operator_error
solve_error
artifact_error
interrupted
```

Every failure or unavailable result that has an artifact directory publishes:

```text
status
complete=false
requested_execution
resolved_execution or resolved_execution.status=unavailable
unsupported_reason or rejection_reason
fallback_used
partial_artifacts_available
diagnostics resource identity
```

Rules:

1. Strict CPU/GPU/precision/method intent cannot migrate silently.
2. Validation/reference execution is never a fallback for a missing production
   operator.
3. K0, open boundary, no demag, synthetic assembly, analytic demag or postsolve
   projection cannot replace requested nonzero-k coupled demag.
4. A fallback is legal only when the public execution mode permits it, the
   replacement solves the same physical contract, and requested/resolved plus
   `fallback_used=true` and `fallback_reason` are published.
5. Missing optional API resources return diagnostic `404`; malformed or
   contradictory artifacts fail resource publication rather than appearing as
   empty successful charts.

## 8. Artifact, API and UI inspection chain

The artifact manifest is the discovery root, not a screen-shaped payload. The
resource-first inspection chain is:

```text
frequency_domain/manifest.v1.json
  -> named modal or response artifact
  -> /v2/sessions/current/analysis/frequency-domain/... metadata resource
  -> /v2/sessions/current/data/fields/{field_id}/samples/vector for heavy fields
  -> ControlRoomApi.analysis.frequencyDomain
  -> useFrequencyDomain*Resource hooks
  -> Analysis Plots / dedicated inspectors / unified 3D viewport
```

Current named resources include:

```text
eigen/spectrum.v2
eigen/branches.v2
eigen/dispersion
eigen/diagnostics.v2
eigen/mode-field/{sample_index}/{mode_index}/meta
response/magnetic-sweep
response/progress.v1
response/cancel-requested.v1
response/diagnostics/solver.v1
response/frequency-points/{frequency_index}
response/field/{frequency_index}/meta
```

The target manifest fields defined in the artifact specification must be
inspectable in the run, solver, operator, periodic-certificate and field
provenance views. UI must show requested versus resolved execution, exact
validation scope, fallback, assembly, phase, equilibrium/certificate identity,
BC/gauge and residual blocks without reconstructing them from labels.

## 9. Implementation gates

The end-to-end contract is complete only when all applicable gates pass for an
exact `(product,k-domain,demag,device,precision,engine)` scope:

1. Python and UI author the same canonical fields and round-trip.
2. `StudyIR` validates units, discriminators and unsupported combinations.
3. The planner preserves requested intent and emits one resolved engine.
4. `EquilibriumArtifact.v6 -> LinearizationState.v6` is materialized and
   consumed, not merely implemented as an isolated helper.
5. `periodic_mesh_certificate.v6` is materialized and consumed when required.
6. Native ABI version/size, pointer, ownership and release rules satisfy
   `07_api_abi_artifacts.md`.
7. MFEM assembly publishes `assembly_kind` and exact operator dictionary.
8. Modal and driven solvers certify the original full operator residual.
9. Artifacts publish the hardened manifest envelope and heavy-field metadata.
10. OpenAPI resources expose the same fields and return explicit errors.
11. Control Room consumes resources through the central facade/hooks and shows
    all requested/resolved and validation boundaries.
12. Independent validation promotes only the exact `validated_scope`.

Until every applicable gate is evidenced, the missing link remains
`contract_gap` and production qualification is forbidden.
