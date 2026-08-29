use super::eigen_constants::{
    NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND, NATIVE_GPU_MODAL_SHARED_DOMAIN_SOLVER_KIND,
};
use super::eigen_digest::shared_domain_content_digest;
use super::eigen_equilibrium_contract::{
    AcceptedFemEigenEquilibriumHandoff, AcceptedFemRelaxStageHandoff, LoadedEquilibriumArtifactV7,
};
use super::eigen_execution_resolution::PlannedFemEigenExecution;
use super::eigen_native_artifacts::{
    native_gpu_modal_shared_domain_execution_provenance, native_modal_artifacts,
    native_modal_execution_provenance,
};
use super::eigen_native_result::{
    diagnostics_number, is_native_poisson_airbox_modal_adapter,
    merge_poisson_airbox_modal_result_diagnostics, native_bloch_floquet_modes_from_result_json,
    native_modal_modes_from_result_json, normalize_native_window_subwindows,
};
use super::eigen_operator::assemble_tangent_mass_matrix;
use super::eigen_output::{json_artifact, k_vector_json};
use super::eigen_policy::{
    native_cpu_modal_window_has_bloch_floquet_payload_path, native_modal_damping_policy,
    native_modal_equilibrium_source_kind, native_modal_floquet_periodic_pairs,
    native_modal_frequency_max_hz, native_modal_frequency_min_hz, native_modal_k_vector,
    native_modal_spin_wave_bc_kind, native_modal_target_frequency_hz, native_modal_target_kind,
    resolved_demag_realization, shared_domain_k0_modal_requested,
};
use super::eigen_progress::{
    emit_fem_eigen_progress, native_modal_progress_event, FemEigenProgress,
    FemEigenProgressCallback,
};
use super::eigen_reduction::ReductionMap;
use super::eigen_shared_domain::{
    build_native_shared_domain_modal_problem, build_shared_domain_linearization_state,
    full_physical_magnetic_reduction_map, reduced_shared_domain_tangent_mass,
};
use super::eigen_solve::{
    native_bloch_floquet_dense_payload_from_complex_pair, regularize_periodic_mass_if_needed,
};
use super::eigen_types::{NativeBlochFloquetDensePayload, SharedDomainModeContext};
use crate::native_fem;
use crate::types::ExecutedRun;
use crate::types::RunError;
use crate::types::RunResult;
use crate::types::RunStatus;
use crate::types::StepAction;
use crate::types::StepStats;
use fullmag_engine::fem::FemLlgProblem;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::EffectiveFieldObservables;
use fullmag_engine::Vector3;
use fullmag_engine::MU0;
use fullmag_ir::FemEigenPlanIR;
use fullmag_ir::OutputIR;
use nalgebra::DMatrix;
use nalgebra::SymmetricEigen;
use num_complex::Complex64;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

#[derive(Debug, Clone)]
pub(super) struct NativeModalMagneticPencilPayload {
    pub(super) dependency_digest: String,
    pub(super) gamma0_m_per_a_s: f64,
}

pub(super) fn execute_native_modal_window(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    initial_magnetization: Vec<Vector3>,
    equilibrium: Vec<Vector3>,
    observables: EffectiveFieldObservables,
    relaxation_steps: u64,
    problem: &FemLlgProblem,
    source_artifact: Option<&LoadedEquilibriumArtifactV7>,
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    bases: &[(Vector3, Vector3)],
    runner_operator: Option<(&DMatrix<f64>, &DMatrix<f64>)>,
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
    active_nodes: usize,
    effective_dof: usize,
    artifact_sample_index: usize,
    execution_target: native_fem::NativeModalExecutionTarget,
    planned_execution: Option<PlannedFemEigenExecution<'_>>,
    expected_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
) -> Result<ExecutedRun, RunError> {
    let solver_kind = match execution_target {
        native_fem::NativeModalExecutionTarget::ProductionGpu => {
            NATIVE_GPU_MODAL_SHARED_DOMAIN_SOLVER_KIND
        }
        _ => NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
    };
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "solving_native_shift_invert",
            phase_index: 3,
            phase_count: 5,
            percent: 35.0,
            solver_kind,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: plan.count as usize,
            computed_modes: 0,
            iteration: Some(0),
            max_iterations: Some(300),
            residual: None,
            warning: None,
        },
    )?;

    let shared_domain_linearization_state = if shared_domain_k0_modal_requested(plan) {
        Some(build_shared_domain_linearization_state(
            plan,
            topology,
            problem,
            source_artifact,
            source_relax_handoff,
            &equilibrium,
            &observables,
        )?)
    } else {
        None
    };
    let relax_to_eigen_handoff =
        match (expected_handoff, shared_domain_linearization_state.as_ref()) {
            (Some(handoff), Some(state)) => {
                handoff.validate_consumed_linearization(plan, &equilibrium, state)?;
                Some(handoff.clone())
            }
            (Some(_), None) => {
                return Err(RunError {
                    message: "relax_to_eigen_handoff_requires_linearization_state".to_string(),
                });
            }
            (None, Some(state))
                if matches!(
                    plan.equilibrium,
                    fullmag_ir::EquilibriumSourceIR::RelaxedInitialState
                ) =>
            {
                Some(
                    AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
                        plan,
                        equilibrium.clone(),
                        state.equilibrium_artifact_digest.clone(),
                        state.linearization_state_digest.clone(),
                    )?,
                )
            }
            (None, _) => None,
        };
    let shared_domain_problem = if shared_domain_k0_modal_requested(plan) {
        Some(build_native_shared_domain_modal_problem(
            plan,
            topology,
            &equilibrium,
            &observables,
            shared_domain_linearization_state.as_ref(),
            artifact_sample_index,
        )?)
    } else {
        None
    };
    if shared_domain_problem.is_some() && runner_operator.is_some() {
        return Err(RunError {
            message: "native shared-domain modal production must not assemble or transport a runner operator"
                .to_string(),
        });
    }
    if shared_domain_problem.is_none() && runner_operator.is_none() {
        return Err(RunError {
            message: "native non-shared-domain modal production requires the explicit runner operator payload"
                .to_string(),
        });
    }
    let operator_diagnostics_json = if let Some((stiffness_field, mass)) = runner_operator {
        full_2x2_native_operator_diagnostics_json(plan, stiffness_field, mass, active_nodes)
            .to_string()
    } else {
        serde_json::json!({
            "schema_version": "frequency_domain_operator_diagnostics.v1",
            "payload_kind": "certified_shared_domain",
            "assembly_owner": "native_mfem",
            "runner_operator_transport": "disabled",
        })
        .to_string()
    };
    let shared_domain_identity = shared_domain_problem
        .as_ref()
        .map(|problem| -> Result<serde_json::Value, RunError> {
            let magnetic_reduced_node_sha256 = shared_domain_content_digest(
                "operator_input_magnetic_reduced_node_map",
                &problem.magnetic_reduced_node,
            )?;
            let scalar_reduced_node_sha256 = shared_domain_content_digest(
                "operator_input_scalar_reduced_node_map",
                &problem.scalar_reduced_node,
            )?;
            let saturation_magnetisation_sha256 = shared_domain_content_digest(
                "operator_input_saturation_magnetisation",
                &problem.saturation_magnetisation_a_per_m,
            )?;
            let phase_constraint = serde_json::json!({
                "phase_convention": format!("{:?}", plan.spin_wave_bc.phase_convention()),
                "k_vector": k_vector_json(plan.k_sampling.as_ref()),
                "periodic_node_pairs": plan.mesh.periodic_node_pairs,
                "periodic_boundary_pairs": plan.mesh.periodic_boundary_pairs,
                "magnetic_reduced_node": problem.magnetic_reduced_node,
                "scalar_reduced_node": problem.scalar_reduced_node,
                "tangent_bases": bases,
            });
            // This signature is deliberately independent of the lane-specific
            // floating-point equilibrium, tangent-frame and linearization
            // artifacts.  It identifies the physical/operator inputs that CPU
            // and GPU must receive for the same sample; those state artifacts
            // remain separate provenance identities below and are compared by
            // their accepted physical state, not by bitwise hash equality.
            let operator_input_signature = serde_json::json!({
                "schema_version": "frequency_domain_operator_input_signature.v1",
                "assembly_kind": "mfem_weak_form_shared_domain",
                "demag_kind": "periodic_airbox_k0",
                "matrix_equation": "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q",
                "physics_contract_version": "micromagnetics_frequency_domain_v5",
                "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
                "phasor_convention": "exp_plus_i_omega_t",
                "eigenvalue_mapping": "lambda_imag_positive_frequency",
                "phase_convention": format!("{:?}", plan.spin_wave_bc.phase_convention()),
                "k_vector": k_vector_json(plan.k_sampling.as_ref()),
                "periodic_mesh_certificate_sha256": problem.mesh_certificate_digest,
                "periodic_modal_equivalence_map_binding_sha256":
                    problem.mesh_certificate_map_binding_digest,
                "magnetic_reduced_node_sha256": magnetic_reduced_node_sha256,
                "scalar_reduced_node_sha256": scalar_reduced_node_sha256,
                "magnetic_reduced_node_count": problem.magnetic_reduced_node_count,
                "scalar_reduced_node_count": problem.scalar_reduced_node_count,
                "q_dof_count": problem.magnetic_reduced_node_count.saturating_mul(2),
                "phi_dof_count": problem.scalar_reduced_node_count,
                "magnetic_pair_count": problem.magnetic_pair_count,
                "airbox_pair_count": problem.airbox_pair_count,
                "boundary_kind": problem.boundary_kind,
                "boundary_marker": problem.boundary_marker,
                "robin_beta": problem.robin_beta,
                "mesh_snapshot_id": problem.mesh_snapshot_id,
                "material_snapshot_id": problem.material_snapshot_id,
                "physics_snapshot_id": problem.physics_snapshot_id,
                "boundary_snapshot_id": problem.boundary_snapshot_id,
                "demag_model": problem.demag_model,
                "saturation_magnetisation_sha256": saturation_magnetisation_sha256,
                "uniform_saturation_magnetisation_a_per_m":
                    problem.uniform_saturation_magnetisation_a_per_m,
                "gamma0_m_per_a_s": problem.gamma0_m_per_a_s,
            });
            let operator_input_signature_sha256 = shared_domain_content_digest(
                "operator_input_signature",
                &operator_input_signature,
            )?;
            let linearization_state =
                if let Some(state) = shared_domain_linearization_state.as_ref() {
                    serde_json::json!({
                        "linearization_state": state.linearization_state_digest,
                        "equilibrium_artifact": state.equilibrium_artifact_digest,
                        "periodic_mesh_certificate": state.periodic_mesh_certificate_digest,
                    })
                } else {
                    serde_json::json!({
                        "equilibrium": equilibrium,
                        "operator_diagnostics": operator_diagnostics_json,
                    })
                };
            Ok(serde_json::json!({
                "operator_input_signature_sha256": operator_input_signature_sha256,
                "phase_constraint_sha256": shared_domain_content_digest(
                    "phase_constraint",
                    &phase_constraint,
                )?,
                "equilibrium_artifact_sha256": problem.equilibrium_digest,
                "linearization_state_sha256": shared_domain_content_digest(
                    "linearization_state",
                    &linearization_state,
                )?,
                "periodic_mesh_certificate_sha256": problem.mesh_certificate_digest,
                "periodic_modal_equivalence_map_binding_sha256":
                    problem.mesh_certificate_map_binding_digest,
            }))
        })
        .transpose()?;
    let stop_requested = AtomicBool::new(false);
    // Managed qualification can exercise the same native cancellation path as
    // an interactive stop without introducing a second solver implementation.
    // The deadline is opt-in and is intentionally read only by the modal
    // production path used by the cancellation gate.
    let cancellation_deadline = std::env::var("FULLMAG_FEM_EIGEN_CANCEL_AFTER_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .map(|milliseconds| Instant::now() + Duration::from_millis(milliseconds));
    let live_progress_sink = RefCell::new(progress.take());
    let cancel_callback = || {
        stop_requested.load(Ordering::Relaxed)
            || cancellation_deadline.is_some_and(|deadline| Instant::now() >= deadline)
    };
    let progress_callback = |progress_json: &str| {
        let Some(event) = native_modal_progress_event(
            progress_json,
            solver_kind,
            active_nodes,
            effective_dof,
            plan.count as usize,
        ) else {
            return;
        };
        if let Some(callback) = live_progress_sink.borrow_mut().as_deref_mut() {
            if callback(event) != StepAction::Continue {
                stop_requested.store(true, Ordering::Relaxed);
            }
        }
    };
    let runner_stiffness_omega =
        runner_operator.map(|(stiffness_field, _)| stiffness_field * plan.gyromagnetic_ratio);
    let runner_stiffness_row_major = runner_stiffness_omega
        .as_ref()
        .map(dmatrix_to_row_major)
        .unwrap_or_default();
    let runner_gyrotropic_row_major = runner_operator
        .map(|(_, mass)| gyrotropic_matrix_row_major_from_tangent_mass(mass, active_nodes))
        .transpose()?
        .unwrap_or_default();
    let runner_tangent_mass_row_major = runner_operator
        .map(|(_, mass)| dmatrix_to_row_major(mass))
        .unwrap_or_default();
    let runner_native_modal_topology = runner_operator
        .map(|_| {
            MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
                message: format!("failed to build native modal Floquet pair topology: {error}"),
            })
        })
        .transpose()?;
    let runner_floquet_periodic_pairs = runner_native_modal_topology
        .as_ref()
        .map(|topology| native_modal_floquet_periodic_pairs(plan, topology))
        .transpose()?
        .unwrap_or_default();
    let runner_magnetic_pencil = runner_operator.map(|_| {
        native_modal_magnetic_pencil_payload(
            plan,
            &runner_stiffness_row_major,
            &runner_gyrotropic_row_major,
            &runner_tangent_mass_row_major,
            &runner_floquet_periodic_pairs,
        )
    });
    let runner_mfem_operator_problem = runner_stiffness_omega
        .as_ref()
        .zip(runner_magnetic_pencil.as_ref())
        .map(|(stiffness_omega, magnetic_pencil)| {
            native_modal_mfem_operator_problem(
                stiffness_omega.nrows() as u64,
                &runner_stiffness_row_major,
                &runner_gyrotropic_row_major,
                &runner_tangent_mass_row_major,
                magnetic_pencil,
                &runner_floquet_periodic_pairs,
            )
        });
    let shared_domain_mode = shared_domain_problem.is_some();
    let native_result = native_fem::solve_native_modal_eigen(native_fem::NativeModalEigenRequest {
        mesh_asset_id: &plan.mesh_name,
        equilibrium_source_kind: native_modal_equilibrium_source_kind(&plan.equilibrium),
        gamma_rad_s_t: plan.gyromagnetic_ratio / MU0,
        mu0_t_m_a: MU0,
        alpha: plan.material.damping,
        include_exchange: plan.enable_exchange,
        include_demag: plan.enable_demag,
        demag_realization: resolved_demag_realization(plan).map(|value| value.provenance_name()),
        damping_policy: native_modal_damping_policy(plan.damping_policy),
        spin_wave_bc_kind: native_modal_spin_wave_bc_kind(&plan.spin_wave_bc),
        k_vector_rad_m: native_modal_k_vector(plan.k_sampling.as_ref()),
        operator_diagnostics_json: Some(operator_diagnostics_json.as_str()),
        requested_mode_count: plan.count as i32,
        target_kind: native_modal_target_kind(&plan.target),
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        frequency_min_hz: native_modal_frequency_min_hz(&plan.target),
        frequency_max_hz: native_modal_frequency_max_hz(&plan.target),
        residual_tolerance: 1.0e-8,
        max_outer_iterations: 300,
        max_linear_iterations: 1000,
        output_directory: None,
        // The native production solver currently returns modal payloads to the
        // runner; its optional native diagnostic writer is reserved for the
        // explicit artifact-action contracts below.
        write_partial_artifacts: false,
        completeness_policy: 1,
        eigensolver_family: 1,
        spectral_transform_kind: 1,
        execution_target,
        cancel_requested: Some(&cancel_callback),
        progress_callback: Some(&progress_callback),
        tiny_validation_problem: None,
        mfem_operator_problem: runner_mfem_operator_problem,
        mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        shared_domain_problem,
    })
    .map_err(|message| RunError { message })?;
    progress = live_progress_sink.into_inner();

    let interrupted = native_result.status == native_fem::NativeFrequencyDomainStatus::Interrupted;
    if native_result.status != native_fem::NativeFrequencyDomainStatus::Ok && !interrupted {
        return Err(RunError {
            message: format!(
                "native FEM modal_eigen production {} solve failed: {} (diagnostics_json={})",
                if matches!(
                    execution_target,
                    native_fem::NativeModalExecutionTarget::ProductionGpu
                ) {
                    "GPU"
                } else {
                    "CPU"
                },
                native_result.error_message,
                native_result.diagnostics_json
            ),
        });
    }
    let native_execution_attestation = if let Some(execution) = planned_execution {
        let resolution = execution.resolution().ok_or_else(|| RunError {
            message: "planned_fem_eigen_resolution_missing_at_native_boundary".to_string(),
        })?;
        native_fem::validate_planned_modal_execution_attestation(
            resolution.resolved_engine,
            execution_target,
            native_result
                .modal_eigen
                .as_ref()
                .map(|result| result.resolved_execution_target),
            native_result.resolved_fallback_state,
            &native_result.resolved_engine_id,
        )
        .map_err(|message| RunError { message })?;
        Some(
            execution.native_attestation(
                native_result
                    .modal_eigen
                    .as_ref()
                    .map(|result| result.resolved_execution_target),
                &native_result.resolved_engine_id,
                native_result.resolved_fallback_state,
                &native_result.resolved_fallback_reason,
            ),
        )
    } else {
        None
    };
    let mut solver_diagnostics = native_solver_diagnostics_json(
        plan,
        &native_result.diagnostics_json,
        Some(&native_result.result_json),
        native_result.modal_gpu_attestation.as_ref(),
    )?;
    if let (Some(execution), Some(attestation)) =
        (planned_execution, native_execution_attestation.as_ref())
    {
        bind_planned_execution_diagnostics(&mut solver_diagnostics, plan, execution, attestation)?;
    }
    if let (Some(identity), Some(diagnostics)) = (
        shared_domain_identity.as_ref(),
        solver_diagnostics.as_object_mut(),
    ) {
        if let Some(identity_object) = identity.as_object() {
            for (key, value) in identity_object {
                diagnostics.insert(key.clone(), value.clone());
            }
        }
    }
    if interrupted {
        if let Some(object) = solver_diagnostics.as_object_mut() {
            object.insert("status".to_string(), serde_json::json!("interrupted"));
            object.insert("complete".to_string(), serde_json::json!(false));
            object.insert(
                "stop_reason".to_string(),
                serde_json::json!("cancel_requested"),
            );
            object.insert(
                "partial_artifacts_available".to_string(),
                serde_json::json!(true),
            );
        }
    }
    let shared_domain_full_reduction =
        shared_domain_mode.then(|| full_physical_magnetic_reduction_map(topology));
    let shared_domain_full_mass = shared_domain_full_reduction
        .as_ref()
        .map(|full_reduction| assemble_tangent_mass_matrix(topology, full_reduction));
    let shared_mode_context_data = if let Some(full_mass) = shared_domain_full_mass.as_ref() {
        Some(reduced_shared_domain_tangent_mass(topology, full_mass)?)
    } else {
        None
    };
    let shared_mode_context = shared_mode_context_data.as_ref().map(
        |(reduced_tangent_mass, active_nodes, magnetic_classes, magnetic_class_count)| {
            SharedDomainModeContext {
                reduced_tangent_mass,
                active_nodes,
                magnetic_classes,
                magnetic_class_count: *magnetic_class_count,
            }
        },
    );
    let result_value = serde_json::from_str::<serde_json::Value>(&native_result.result_json)
        .map_err(|error| RunError {
            message: format!("failed to parse native modal result JSON: {error}"),
        })?;
    let has_modes_payload = result_value
        .get("modes")
        .and_then(serde_json::Value::as_array)
        .is_some();
    let modes = if has_modes_payload {
        native_modal_modes_from_result_json(
            plan,
            &native_result.result_json,
            runner_stiffness_omega.as_ref().and_then(|stiffness_omega| {
                runner_operator.map(|(_, mass)| {
                    (
                        stiffness_omega,
                        runner_gyrotropic_row_major.as_slice(),
                        mass,
                    )
                })
            }),
            shared_mode_context.as_ref(),
        )?
    } else if interrupted {
        Vec::new()
    } else {
        return Err(RunError {
            message: "native modal result JSON is missing complete modes[] payload".to_string(),
        });
    };
    if modes.is_empty() && !interrupted {
        return Err(RunError {
            message: format!(
                "native FEM modal_eigen production {solver_kind} solve returned no modes"
            ),
        });
    }

    if !interrupted {
        emit_fem_eigen_progress(
            &mut progress,
            FemEigenProgress {
                phase: "writing_artifacts",
                phase_index: 4,
                phase_count: 5,
                percent: 85.0,
                solver_kind,
                active_nodes,
                effective_dof,
                requested_modes: plan.count as usize,
                candidate_modes: modes.len(),
                computed_modes: modes.len(),
                iteration: None,
                max_iterations: None,
                residual: modes
                    .iter()
                    .map(|mode| mode.residual_relative_l2)
                    .reduce(f64::max),
                warning: None,
            },
        )?;
    }

    let artifact_reduction = shared_domain_full_reduction.as_ref().unwrap_or(reduction);
    let artifact_node_mass_weights = shared_domain_full_mass
        .as_ref()
        .and_then(|full_mass| {
            shared_domain_full_reduction
                .as_ref()
                .and_then(|full_reduction| {
                    node_mass_weights_from_tangent_mass(
                        full_mass,
                        full_reduction.active_nodes.len(),
                    )
                })
        })
        .or_else(|| {
            runner_operator
                .and_then(|(_, mass)| node_mass_weights_from_tangent_mass(mass, active_nodes))
        });
    let mut auxiliary_artifacts = native_modal_artifacts(
        plan,
        outputs,
        &equilibrium,
        artifact_reduction,
        bases,
        &modes,
        artifact_node_mass_weights.as_deref(),
        solver_diagnostics,
        relaxation_steps,
        shared_domain_linearization_state.as_ref(),
        relax_to_eigen_handoff.as_ref(),
        artifact_sample_index,
    )?;
    if interrupted {
        auxiliary_artifacts.push(json_artifact(
            "eigen/partial.v1.json",
            &serde_json::json!({
                "schema_version": "fem_k0_modal_partial.v1",
                "complete": false,
                "stop_reason": "cancelled",
                "preserved_mode_count": modes.len(),
            }),
        )?);
    }

    let stats = StepStats {
        step: relaxation_steps,
        time: 0.0,
        dt: 0.0,
        e_ex: observables.exchange_energy_joules,
        e_demag: observables.demag_energy_joules,
        e_ext: observables.external_energy_joules,
        e_total: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        ..StepStats::default()
    };

    if !interrupted {
        emit_fem_eigen_progress(
            &mut progress,
            FemEigenProgress {
                phase: "completed",
                phase_index: 5,
                phase_count: 5,
                percent: 100.0,
                solver_kind,
                active_nodes,
                effective_dof,
                requested_modes: plan.count as usize,
                candidate_modes: modes.len(),
                computed_modes: modes.len(),
                iteration: None,
                max_iterations: None,
                residual: None,
                warning: None,
            },
        )?;
    }

    let status = if interrupted {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };

    let mut provenance = match execution_target {
        native_fem::NativeModalExecutionTarget::ProductionGpu => {
            native_gpu_modal_shared_domain_execution_provenance(
                plan,
                native_result.modal_gpu_attestation.as_ref(),
            )
        }
        _ => native_modal_execution_provenance(plan),
    };
    if let Some(execution) = planned_execution {
        execution.bind_execution_provenance(&mut provenance);
        provenance.fem_eigen_native_execution_attestation = native_execution_attestation;
    }

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps: vec![stats],
            final_magnetization: equilibrium,
            completion: Some(crate::relaxation::resolve_stage_completion(
                status,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization,
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance,
    })
}

pub(super) fn bind_planned_execution_diagnostics(
    diagnostics: &mut serde_json::Value,
    plan: &FemEigenPlanIR,
    execution: PlannedFemEigenExecution<'_>,
    native_attestation: &crate::types::FemEigenNativeExecutionAttestation,
) -> Result<(), RunError> {
    let resolution = execution.resolution().ok_or_else(|| RunError {
        message: "planned_fem_eigen_resolution_missing_at_diagnostics_boundary".to_string(),
    })?;
    let object = diagnostics.as_object_mut().ok_or_else(|| RunError {
        message: "native modal diagnostics JSON must be an object".to_string(),
    })?;
    let requested = object
        .entry("requested_execution".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let requested = requested.as_object_mut().ok_or_else(|| RunError {
        message: "native requested_execution diagnostics must be an object".to_string(),
    })?;
    requested.insert("backend".to_string(), serde_json::json!("fem"));
    requested.insert(
        "device".to_string(),
        serde_json::to_value(resolution.requested_device).map_err(|error| RunError {
            message: format!("failed to serialize requested FEM eigen device: {error}"),
        })?,
    );
    requested.insert(
        "precision".to_string(),
        serde_json::to_value(resolution.requested_precision).map_err(|error| RunError {
            message: format!("failed to serialize requested FEM eigen precision: {error}"),
        })?,
    );
    requested.insert(
        "engine".to_string(),
        serde_json::to_value(resolution.requested_engine).map_err(|error| RunError {
            message: format!("failed to serialize requested FEM eigen engine: {error}"),
        })?,
    );
    requested.insert(
        "include_demag".to_string(),
        serde_json::json!(plan.operator.include_demag),
    );
    requested.insert(
        "magnetostatic_bc".to_string(),
        serde_json::json!("periodic_airbox_k0"),
    );

    let resolved = object
        .entry("resolved_execution".to_string())
        .or_insert_with(|| serde_json::json!({}));
    let resolved = resolved.as_object_mut().ok_or_else(|| RunError {
        message: "native resolved_execution diagnostics must be an object".to_string(),
    })?;
    resolved.insert("backend".to_string(), serde_json::json!("fem"));
    resolved.insert(
        "device".to_string(),
        serde_json::to_value(resolution.resolved_device).map_err(|error| RunError {
            message: format!("failed to serialize resolved FEM eigen device: {error}"),
        })?,
    );
    resolved.insert(
        "precision".to_string(),
        serde_json::to_value(resolution.resolved_precision).map_err(|error| RunError {
            message: format!("failed to serialize resolved FEM eigen precision: {error}"),
        })?,
    );
    resolved.insert(
        "engine".to_string(),
        serde_json::to_value(resolution.resolved_engine).map_err(|error| RunError {
            message: format!("failed to serialize resolved FEM eigen engine: {error}"),
        })?,
    );
    resolved.insert(
        "fallback_used".to_string(),
        serde_json::json!(resolution.fallback_used),
    );
    resolved.insert(
        "fallback_reason".to_string(),
        serde_json::to_value(&resolution.fallback_reason).map_err(|error| RunError {
            message: format!("failed to serialize FEM eigen fallback reason: {error}"),
        })?,
    );
    resolved.insert(
        "fallback_from_engine".to_string(),
        serde_json::to_value(resolution.requested_engine).map_err(|error| RunError {
            message: format!("failed to serialize FEM eigen fallback source: {error}"),
        })?,
    );
    resolved.insert(
        "fallback_to_engine".to_string(),
        serde_json::to_value(resolution.resolved_engine).map_err(|error| RunError {
            message: format!("failed to serialize FEM eigen fallback target: {error}"),
        })?,
    );
    resolved.insert(
        "selection_reason".to_string(),
        serde_json::json!(resolution.selection_reason),
    );
    object.insert(
        "fem_eigen_execution_resolution".to_string(),
        serde_json::to_value(resolution).map_err(|error| RunError {
            message: format!("failed to serialize FEM eigen execution resolution: {error}"),
        })?,
    );
    object.insert(
        "native_execution_attestation".to_string(),
        serde_json::to_value(native_attestation).map_err(|error| RunError {
            message: format!("failed to serialize native execution attestation: {error}"),
        })?,
    );
    Ok(())
}

pub(super) fn execute_native_cpu_modal_window_from_bloch_floquet_complex(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    initial_magnetization: Vec<Vector3>,
    equilibrium: Vec<Vector3>,
    observables: EffectiveFieldObservables,
    relaxation_steps: u64,
    reduction: &ReductionMap,
    bases: &[(Vector3, Vector3)],
    stiffness: &[Vec<Complex64>],
    mass: &[Vec<Complex64>],
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
    active_nodes: usize,
    effective_dof: usize,
) -> Result<ExecutedRun, RunError> {
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "solving_native_shift_invert",
            phase_index: 3,
            phase_count: 5,
            percent: 35.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: plan.count as usize,
            computed_modes: 0,
            iteration: Some(0),
            max_iterations: Some(300),
            residual: None,
            warning: None,
        },
    )?;

    let payload = native_bloch_floquet_dense_payload_from_complex_pair(stiffness, mass)?;
    let payload = NativeBlochFloquetDensePayload {
        physical_complex_dof: payload.physical_complex_dof,
        stiffness: payload.stiffness * plan.gyromagnetic_ratio,
        gyrotropic_row_major: payload.gyrotropic_row_major,
        tangent_mass: payload.tangent_mass,
        physical_mass: payload.physical_mass,
    };
    let stiffness_row_major = dmatrix_to_row_major(&payload.stiffness);
    let tangent_mass_row_major = dmatrix_to_row_major(&payload.tangent_mass);
    let native_modal_topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("failed to build native modal Bloch/Floquet pair topology: {error}"),
    })?;
    let native_floquet_periodic_pairs =
        native_modal_floquet_periodic_pairs(plan, &native_modal_topology)?;
    let magnetic_pencil = native_modal_magnetic_pencil_payload(
        plan,
        &stiffness_row_major,
        &payload.gyrotropic_row_major,
        &tangent_mass_row_major,
        &native_floquet_periodic_pairs,
    );
    let native_result = native_fem::solve_native_modal_eigen(native_fem::NativeModalEigenRequest {
        mesh_asset_id: &plan.mesh_name,
        equilibrium_source_kind: native_modal_equilibrium_source_kind(&plan.equilibrium),
        gamma_rad_s_t: plan.gyromagnetic_ratio / MU0,
        mu0_t_m_a: MU0,
        alpha: plan.material.damping,
        include_exchange: plan.enable_exchange,
        include_demag: plan.enable_demag,
        demag_realization: resolved_demag_realization(plan).map(|value| value.provenance_name()),
        damping_policy: native_modal_damping_policy(plan.damping_policy),
        spin_wave_bc_kind: native_modal_spin_wave_bc_kind(&plan.spin_wave_bc),
        k_vector_rad_m: native_modal_k_vector(plan.k_sampling.as_ref()),
        operator_diagnostics_json: Some(
            "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\
             \"payload_kind\":\"bloch_floquet_tangent_operator\",\
             \"stiffness_units\":\"rad_s_inv\",\
             \"gyrotropic_form\":\"pencil_B=-G=[[0,-M],[M,0]]\",\
             \"operator_embedding\":\"complex_bloch_floquet_to_real_gyrotropic_pencil\"}",
        ),
        requested_mode_count: plan.count as i32,
        target_kind: native_modal_target_kind(&plan.target),
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        frequency_min_hz: native_modal_frequency_min_hz(&plan.target),
        frequency_max_hz: native_modal_frequency_max_hz(&plan.target),
        residual_tolerance: 1.0e-8,
        max_outer_iterations: 300,
        max_linear_iterations: 1000,
        output_directory: None,
        write_partial_artifacts: false,
        completeness_policy: 1,
        eigensolver_family: 1,
        spectral_transform_kind: 1,
        execution_target: native_fem::NativeModalExecutionTarget::ProductionCpu,
        cancel_requested: None,
        progress_callback: None,
        tiny_validation_problem: None,
        mfem_operator_problem: Some(native_modal_mfem_operator_problem(
            payload.stiffness.nrows() as u64,
            &stiffness_row_major,
            &payload.gyrotropic_row_major,
            &tangent_mass_row_major,
            &magnetic_pencil,
            &native_floquet_periodic_pairs,
        )),
        mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        shared_domain_problem: None,
    })
    .map_err(|message| RunError { message })?;

    if native_result.status != native_fem::NativeFrequencyDomainStatus::Ok {
        return Err(RunError {
            message: format!(
                "native FEM modal_eigen Bloch/Floquet production CPU solve failed: {} (diagnostics_json={})",
                native_result.error_message, native_result.diagnostics_json
            ),
        });
    }
    let solver_diagnostics = native_solver_diagnostics_json(
        plan,
        &native_result.diagnostics_json,
        Some(&native_result.result_json),
        None,
    )?;
    let modes =
        native_bloch_floquet_modes_from_result_json(plan, &native_result.result_json, &payload)?;
    if modes.is_empty() {
        return Err(RunError {
            message: "native FEM modal_eigen Bloch/Floquet production CPU solve returned no modes"
                .to_string(),
        });
    }

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "writing_artifacts",
            phase_index: 4,
            phase_count: 5,
            percent: 85.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: modes.len(),
            computed_modes: modes.len(),
            iteration: None,
            max_iterations: None,
            residual: modes
                .iter()
                .map(|mode| mode.residual_relative_l2)
                .reduce(f64::max),
            warning: None,
        },
    )?;

    let auxiliary_artifacts = native_modal_artifacts(
        plan,
        outputs,
        &equilibrium,
        reduction,
        bases,
        &modes,
        None,
        solver_diagnostics,
        relaxation_steps,
        None,
        None,
        0,
    )?;

    let stats = StepStats {
        step: relaxation_steps,
        time: 0.0,
        dt: 0.0,
        e_ex: observables.exchange_energy_joules,
        e_demag: observables.demag_energy_joules,
        e_ext: observables.external_energy_joules,
        e_total: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        ..StepStats::default()
    };

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "completed",
            phase_index: 5,
            phase_count: 5,
            percent: 100.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: modes.len(),
            computed_modes: modes.len(),
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: vec![stats],
            final_magnetization: equilibrium,
            completion: Some(crate::relaxation::resolve_stage_completion(
                RunStatus::Completed,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization,
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: native_modal_execution_provenance(plan),
    })
}

fn dmatrix_to_row_major(matrix: &DMatrix<f64>) -> Vec<f64> {
    let mut values = Vec::with_capacity(matrix.nrows() * matrix.ncols());
    for row in 0..matrix.nrows() {
        for col in 0..matrix.ncols() {
            values.push(matrix[(row, col)]);
        }
    }
    values
}

fn matrix_abs_max(matrix: &DMatrix<f64>) -> f64 {
    matrix
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()))
}

// Byte-for-byte Rust implementation of the native CanonicalDigestBuilder
// protocol. Keep field tags and normalized IEEE-754 encoding in lockstep with
// backends/fem/src/frequency_domain/canonical_digest.cpp.
pub(super) struct CanonicalDigestBuilder {
    pub(super) payload: Vec<u8>,
}

impl CanonicalDigestBuilder {
    pub(super) fn new(schema: &str) -> Self {
        let mut digest = Self {
            payload: Vec::new(),
        };
        digest.add_string("schema", schema);
        digest
    }

    pub(super) fn add_field(&mut self, name: &str, field_type: u8, value: &[u8]) {
        self.payload
            .extend_from_slice(&(name.len() as u64).to_be_bytes());
        self.payload.extend_from_slice(name.as_bytes());
        self.payload.push(field_type);
        self.payload
            .extend_from_slice(&(value.len() as u64).to_be_bytes());
        self.payload.extend_from_slice(value);
    }

    pub(super) fn add_string(&mut self, name: &str, value: &str) {
        self.add_field(name, 1, value.as_bytes());
    }

    pub(super) fn add_u64(&mut self, name: &str, value: u64) {
        self.add_field(name, 2, &value.to_be_bytes());
    }

    pub(super) fn add_bytes(&mut self, name: &str, value: &[u8]) {
        self.add_field(name, 3, value);
    }

    pub(super) fn add_double(&mut self, name: &str, value: f64) {
        let normalized_bits = if value == 0.0 {
            0
        } else if value.is_nan() {
            0x7ff8_0000_0000_0000
        } else {
            value.to_bits()
        };
        self.add_field(name, 4, &normalized_bits.to_be_bytes());
    }

    pub(super) fn add_double_slice(&mut self, name: &str, values: &[f64]) {
        self.add_u64(&format!("{name}.count"), values.len() as u64);
        for (index, value) in values.iter().enumerate() {
            self.add_double(&format!("{name}[{index}]"), *value);
        }
    }

    pub(super) fn sha256_hex(self) -> String {
        format!("{:x}", Sha256::digest(self.payload))
    }
}

pub(super) fn native_modal_magnetic_pencil_payload(
    plan: &FemEigenPlanIR,
    stiffness_matrix_row_major: &[f64],
    gyrotropic_matrix_row_major: &[f64],
    mass_matrix_row_major: &[f64],
    floquet_periodic_pairs: &[native_fem::NativeModalEigenFloquetPeriodicPair<'_>],
) -> NativeModalMagneticPencilPayload {
    let mut digest =
        CanonicalDigestBuilder::new("fullmag:native-modal-magnetic-payload-dependency:v1");
    digest.add_double_slice("stiffness_matrix_row_major", stiffness_matrix_row_major);
    digest.add_double_slice("gyrotropic_matrix_row_major", gyrotropic_matrix_row_major);
    digest.add_double_slice("mass_matrix_row_major", mass_matrix_row_major);
    digest.add_double_slice("gamma0_m_per_a_s", &[plan.gyromagnetic_ratio]);
    digest.add_double_slice("alpha", &[plan.material.damping]);
    digest.add_u64("include_exchange", u64::from(plan.enable_exchange));
    digest.add_u64("include_demag", u64::from(plan.enable_demag));
    digest.add_string(
        "demag_realization",
        resolved_demag_realization(plan)
            .map(|value| value.provenance_name())
            .unwrap_or("none"),
    );
    digest.add_bytes(
        "spin_wave_bc",
        &serde_json::to_vec(&plan.spin_wave_bc)
            .expect("spin-wave boundary condition must serialize for native modal digest"),
    );
    digest.add_bytes(
        "k_sampling",
        &serde_json::to_vec(&plan.k_sampling)
            .expect("k sampling must serialize for native modal digest"),
    );
    for (index, pair) in floquet_periodic_pairs.iter().enumerate() {
        let prefix = format!("floquet_pair[{index}]");
        digest.add_string(&format!("{prefix}.id"), pair.pair_id.unwrap_or(""));
        digest.add_u64(&format!("{prefix}.node_a"), pair.node_a);
        digest.add_u64(&format!("{prefix}.node_b"), pair.node_b);
        let translation_m: &[f64] = match &pair.translation_m {
            Some(value) => value,
            None => &[],
        };
        digest.add_double_slice(&format!("{prefix}.translation_m"), translation_m);
        let phase_rad = pair.phase_rad.map_or_else(Vec::new, |value| vec![value]);
        digest.add_double_slice(&format!("{prefix}.phase_rad"), &phase_rad);
    }

    NativeModalMagneticPencilPayload {
        dependency_digest: digest.sha256_hex(),
        gamma0_m_per_a_s: plan.gyromagnetic_ratio,
    }
}

pub(super) fn native_modal_mfem_operator_problem<'a>(
    tangent_dof_count: u64,
    stiffness_matrix_row_major: &'a [f64],
    gyrotropic_matrix_row_major: &'a [f64],
    mass_matrix_row_major: &'a [f64],
    pencil: &'a NativeModalMagneticPencilPayload,
    floquet_periodic_pairs: &'a [native_fem::NativeModalEigenFloquetPeriodicPair<'a>],
) -> native_fem::NativeModalEigenMfemOperatorProblem<'a> {
    native_fem::NativeModalEigenMfemOperatorProblem {
        tangent_dof_count,
        stiffness_matrix_row_major: Some(stiffness_matrix_row_major),
        gyrotropic_matrix_row_major: Some(gyrotropic_matrix_row_major),
        mass_matrix_row_major: Some(mass_matrix_row_major),
        linearized_pencil_dependency_digest: Some(pencil.dependency_digest.as_str()),
        linearized_pencil_gamma0_m_per_a_s: pencil.gamma0_m_per_a_s,
        phase_convention: native_fem::FrequencyDomainPhaseConvention::ExpIOmegaT,
        floquet_periodic_pairs,
    }
}

pub(super) fn full_2x2_native_operator_diagnostics_json(
    plan: &FemEigenPlanIR,
    stiffness_field: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    active_nodes: usize,
) -> serde_json::Value {
    let payload_kind = if native_cpu_modal_window_has_bloch_floquet_payload_path(plan) {
        "bloch_floquet_tangent_operator"
    } else {
        "rust_full_2x2_dense_operator"
    };
    let mut diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_operator_diagnostics.v1",
        "payload_kind": payload_kind,
        "active_node_count": active_nodes,
        "tangent_dof_count": stiffness_field.nrows(),
        "stiffness_units": "A_per_m_mass_weighted",
        "gyrotropic_form": "pencil_B=-G=[[0,M],[-M,0]]",
        "stiffness_field_abs_max": matrix_abs_max(stiffness_field),
        "tangent_mass_abs_max": matrix_abs_max(mass),
    });

    let Some(object) = diagnostics.as_object_mut() else {
        return diagnostics;
    };
    let regularized_mass = regularize_periodic_mass_if_needed(mass.clone(), &plan.spin_wave_bc);
    let Some(cholesky) = regularized_mass.cholesky() else {
        object.insert(
            "generalized_field_spectrum_status".to_string(),
            serde_json::json!("mass_cholesky_failed"),
        );
        return diagnostics;
    };
    let l = cholesky.l();
    let Some(l_inv) = l.try_inverse() else {
        object.insert(
            "generalized_field_spectrum_status".to_string(),
            serde_json::json!("mass_cholesky_inverse_failed"),
        );
        return diagnostics;
    };
    let transformed = &l_inv * stiffness_field * l_inv.transpose();
    let spectrum = SymmetricEigen::new(transformed);
    let mut min_field = f64::INFINITY;
    let mut max_field = f64::NEG_INFINITY;
    let mut min_positive_frequency = f64::INFINITY;
    let mut max_positive_frequency = f64::NEG_INFINITY;
    let mut finite_count = 0_u64;
    let mut positive_count = 0_u64;
    for value in spectrum.eigenvalues.iter().copied() {
        if !value.is_finite() {
            continue;
        }
        finite_count += 1;
        min_field = min_field.min(value);
        max_field = max_field.max(value);
        if value > 0.0 {
            positive_count += 1;
            let frequency_hz = plan.gyromagnetic_ratio * value / std::f64::consts::TAU;
            min_positive_frequency = min_positive_frequency.min(frequency_hz);
            max_positive_frequency = max_positive_frequency.max(frequency_hz);
        }
    }
    object.insert(
        "generalized_field_spectrum_status".to_string(),
        serde_json::json!("available"),
    );
    object.insert(
        "generalized_field_eigenvalue_count".to_string(),
        serde_json::json!(finite_count),
    );
    object.insert(
        "generalized_field_positive_eigenvalue_count".to_string(),
        serde_json::json!(positive_count),
    );
    if finite_count > 0 {
        object.insert(
            "generalized_field_min_a_per_m".to_string(),
            serde_json::json!(min_field),
        );
        object.insert(
            "generalized_field_max_a_per_m".to_string(),
            serde_json::json!(max_field),
        );
    }
    if positive_count > 0 {
        object.insert(
            "generalized_positive_frequency_min_hz".to_string(),
            serde_json::json!(min_positive_frequency),
        );
        object.insert(
            "generalized_positive_frequency_max_hz".to_string(),
            serde_json::json!(max_positive_frequency),
        );
    }
    diagnostics
}

pub(super) fn gyrotropic_matrix_row_major_from_tangent_mass(
    mass: &DMatrix<f64>,
    active_nodes: usize,
) -> Result<Vec<f64>, RunError> {
    let dim = active_nodes.checked_mul(2).ok_or_else(|| RunError {
        message: "native modal gyrotropic matrix dimension overflow".to_string(),
    })?;
    if mass.nrows() != dim || mass.ncols() != dim {
        return Err(RunError {
            message: format!(
                "native modal full_2x2 mass matrix has shape {}x{}, expected {}x{}",
                mass.nrows(),
                mass.ncols(),
                dim,
                dim
            ),
        });
    }
    let mut gyrotropic = vec![0.0; dim * dim];
    for row in 0..active_nodes {
        for col in 0..active_nodes {
            let tangent_mass = mass[(row, col)];
            gyrotropic[row * dim + col + active_nodes] = tangent_mass;
            gyrotropic[(row + active_nodes) * dim + col] = -tangent_mass;
        }
    }
    Ok(gyrotropic)
}

pub(super) fn node_mass_weights_from_tangent_mass(
    mass: &DMatrix<f64>,
    active_nodes: usize,
) -> Option<Vec<f64>> {
    let dim = active_nodes.checked_mul(2)?;
    if active_nodes == 0 || mass.nrows() != dim || mass.ncols() != dim {
        return None;
    }
    let mut weights = Vec::with_capacity(active_nodes);
    for node in 0..active_nodes {
        let u = mass[(node, node)];
        let v = mass[(node + active_nodes, node + active_nodes)];
        if !(u.is_finite() && v.is_finite() && u > 0.0 && v > 0.0) {
            return None;
        }
        weights.push(0.5 * (u + v));
    }
    Some(weights)
}

pub(super) fn native_solver_diagnostics_json(
    plan: &FemEigenPlanIR,
    raw: &str,
    result_raw: Option<&str>,
    gpu_attestation: Option<&native_fem::NativeModalGpuAttestation>,
) -> Result<serde_json::Value, RunError> {
    let mut diagnostics =
        serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
            message: format!("failed to parse native modal diagnostics JSON: {error}"),
        })?;
    let Some(object) = diagnostics.as_object_mut() else {
        return Err(RunError {
            message: "native modal diagnostics JSON must be an object".to_string(),
        });
    };
    object.insert(
        "schema_version".to_string(),
        serde_json::json!("frequency_domain_modal_solver_diagnostics.v1"),
    );
    object
        .entry("solver_model".to_string())
        .or_insert_with(|| serde_json::json!("contour_interval_production_cpu_dense"));
    object
        .entry("resolved_solver_family".to_string())
        .or_insert_with(|| serde_json::json!("contour_interval"));
    object
        .entry("spectral_transform".to_string())
        .or_insert_with(|| serde_json::json!("contour_integral"));
    object
        .entry("algebraic_form".to_string())
        .or_insert_with(|| serde_json::json!("linearized_llg_generalized"));
    object
        .entry("matrix_equation".to_string())
        .or_insert_with(|| serde_json::json!("L phi = lambda B phi"));
    object
        .entry("phasor_convention".to_string())
        .or_insert_with(|| serde_json::json!("exp_i_omega_t"));
    object
        .entry("eigenvalue_mapping".to_string())
        .or_insert_with(|| serde_json::json!("lambda_eq_i_omega"));
    object
        .entry("frequency_mapping".to_string())
        .or_insert_with(|| {
            serde_json::json!(
                "frequency_hz = Im(lambda)/(2*pi) for the accepted positive-frequency branch"
            )
        });
    object
        .entry("production_gyrotropic_mapping".to_string())
        .or_insert_with(|| serde_json::json!(true));
    object
        .entry("dense_reference_oracle".to_string())
        .or_insert_with(|| serde_json::json!(false));
    object
        .entry("residual_definition".to_string())
        .or_insert_with(|| {
            serde_json::json!(
                "relative_residual = ||K phi - lambda B phi||_2 / (||K phi||_2 + |lambda| * ||B phi||_2), B=-G"
            )
        });
    object
        .entry("tangent_leakage_definition".to_string())
        .or_insert_with(|| {
            serde_json::json!(
                "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors"
            )
        });
    object.entry("constants".to_string()).or_insert_with(|| {
        serde_json::json!({
            "gamma_rad_s_T": plan.gyromagnetic_ratio / MU0,
            "gamma0_rad_s_per_A_m": plan.gyromagnetic_ratio,
            "mu0_T_m_per_A": MU0,
        })
    });
    if matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) && object
        .get("floquet_periodic_pair_count")
        .and_then(|value| value.as_u64())
        .is_some_and(|count| count > 0)
    {
        object.insert(
            "modal_periodic_pair_contract_available".to_string(),
            serde_json::json!(true),
        );
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        let requested_window_hz = serde_json::json!([
            native_modal_frequency_min_hz(&plan.target),
            native_modal_frequency_max_hz(&plan.target),
        ]);
        object
            .entry("requested_window_hz".to_string())
            .or_insert_with(|| requested_window_hz.clone());
        object
            .entry("resolved_search_window_hz".to_string())
            .or_insert(requested_window_hz);
        normalize_native_window_subwindows(object);
        object
            .entry("requested_mode_count".to_string())
            .or_insert_with(|| serde_json::json!(plan.count));
        let accepted_modes = object
            .get("accepted_mode_count_after_dedup")
            .or_else(|| object.get("accepted_mode_count"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        object
            .entry("mode_count".to_string())
            .or_insert_with(|| serde_json::json!(accepted_modes));
        object
            .entry("window_completeness".to_string())
            .or_insert_with(|| {
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": accepted_modes,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                })
            });
    }
    if let Some(result_raw) = result_raw {
        merge_poisson_airbox_modal_result_diagnostics(object, result_raw)?;
    }
    insert_native_poisson_airbox_hardened_contract(object, plan, gpu_attestation)?;
    // The hardened contract normalizes the lane-specific execution object;
    // enrich it last so native provenance fields cannot be discarded by that
    // normalization step.
    insert_native_poisson_airbox_execution_provenance(object, plan, gpu_attestation)?;
    Ok(diagnostics)
}

fn insert_native_poisson_airbox_execution_provenance(
    diagnostics: &mut serde_json::Map<String, serde_json::Value>,
    plan: &FemEigenPlanIR,
    gpu_attestation: Option<&native_fem::NativeModalGpuAttestation>,
) -> Result<(), RunError> {
    let Some(adapter) = diagnostics
        .get("solver_adapter")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
    else {
        return Ok(());
    };
    if !is_native_poisson_airbox_modal_adapter(Some(adapter.as_str())) {
        return Ok(());
    }
    let gpu = matches!(
        adapter.as_str(),
        "k0_poisson_airbox_gpu_petsc_slepc" | "k0_poisson_airbox_gpu_modal_device_krylov"
    );
    if gpu && gpu_attestation.is_none() {
        return Err(RunError {
            message: "k0_poisson_airbox_gpu_attestation_missing".to_string(),
        });
    }

    let mut requested = diagnostics
        .get("requested_execution")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(requested_object) = requested.as_object_mut() {
        requested_object
            .entry("backend".to_string())
            .or_insert_with(|| serde_json::json!("fem"));
        requested_object
            .entry("device".to_string())
            .or_insert_with(|| serde_json::json!(if gpu { "gpu" } else { "cpu" }));
        requested_object
            .entry("precision".to_string())
            .or_insert_with(|| serde_json::json!("double"));
        requested_object
            .entry("include_demag".to_string())
            .or_insert_with(|| serde_json::json!(plan.operator.include_demag));
        requested_object
            .entry("solver_family".to_string())
            .or_insert_with(|| serde_json::json!("modal_eigen"));
        requested_object
            .entry("magnetostatic_bc".to_string())
            .or_insert_with(|| serde_json::json!("periodic_airbox_k0"));
    }
    diagnostics.insert("requested_execution".to_string(), requested);

    let mut resolved = diagnostics
        .get("resolved_execution")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(resolved_object) = resolved.as_object_mut() {
        resolved_object
            .entry("backend".to_string())
            .or_insert_with(|| serde_json::json!("fem"));
        resolved_object
            .entry("device".to_string())
            .or_insert_with(|| serde_json::json!(if gpu { "gpu" } else { "cpu" }));
        resolved_object
            .entry("precision".to_string())
            .or_insert_with(|| serde_json::json!("double"));
        resolved_object
            .entry("engine".to_string())
            .or_insert_with(|| {
                serde_json::json!(if gpu {
                    "gpu_petsc_slepc_cuda"
                } else {
                    "cpu_slepc_schur_targeted"
                })
            });
        resolved_object
            .entry("native_backend".to_string())
            .or_insert_with(|| serde_json::json!(if gpu { "native_gpu" } else { "native_cpu" }));
        resolved_object
            .entry("reference_or_production".to_string())
            .or_insert_with(|| serde_json::json!("production"));
        resolved_object
            .entry("demag_realization".to_string())
            .or_insert_with(|| {
                serde_json::json!(resolved_demag_realization(plan)
                    .map(|value| value.provenance_name())
                    .unwrap_or("none"))
            });
        resolved_object
            .entry("solver_algorithm".to_string())
            .or_insert_with(|| serde_json::json!(adapter));
        resolved_object
            .entry("solve_kind".to_string())
            .or_insert_with(|| serde_json::json!("modal_eigen"));
        resolved_object
            .entry("device_residency".to_string())
            .or_insert_with(|| serde_json::json!(if gpu { "gpu_device_resident" } else { "host" }));
        resolved_object
            .entry("fallback_used".to_string())
            .or_insert_with(|| serde_json::json!(false));
    }
    diagnostics.insert("resolved_execution".to_string(), resolved);
    if let Some(attestation) = gpu_attestation {
        diagnostics.insert(
            "gpu_execution_attestation".to_string(),
            attestation.artifact_json(),
        );
    }
    Ok(())
}

fn insert_native_poisson_airbox_hardened_contract(
    diagnostics: &mut serde_json::Map<String, serde_json::Value>,
    plan: &FemEigenPlanIR,
    gpu_attestation: Option<&native_fem::NativeModalGpuAttestation>,
) -> Result<(), RunError> {
    let Some(adapter) = diagnostics
        .get("solver_adapter")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
    else {
        return Ok(());
    };
    if !is_native_poisson_airbox_modal_adapter(Some(adapter.as_str())) {
        return Ok(());
    }
    let production_implication = diagnostics
        .get("production_implication")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if production_implication {
        let required_string_fields = [
            "assembly_kind",
            "outer_boundary_kind",
            "gauge_policy",
            "gauge_reason",
        ];
        for field in required_string_fields {
            let valid = diagnostics
                .get(field)
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.is_empty() && value != "unknown");
            if !valid {
                return Err(RunError {
                    message: format!(
                        "native production Poisson-airbox diagnostics missing {field}"
                    ),
                });
            }
        }
        let assembly_kind = diagnostics
            .get("assembly_kind")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if assembly_kind != "mfem_weak_form_shared_domain" {
            return Err(RunError {
                message: format!(
                    "native production Poisson-airbox diagnostics have unsupported assembly_kind={assembly_kind:?}"
                ),
            });
        }
        let outer_boundary_kind = diagnostics
            .get("outer_boundary_kind")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if outer_boundary_kind == "poisson_robin" {
            let robin_beta = diagnostics
                .get("robin_beta")
                .and_then(|value| value.as_f64())
                .unwrap_or(f64::NAN);
            if !robin_beta.is_finite() || robin_beta <= 0.0 {
                return Err(RunError {
                    message: format!(
                        "native production Poisson-airbox diagnostics have invalid robin_beta={robin_beta:?}"
                    ),
                });
            }
        }
        for field in [
            "magnetic_block_backward_error",
            "poisson_block_backward_error",
            "gauge_constraint_backward_error",
        ] {
            let value = diagnostics_number(diagnostics, field).unwrap_or(f64::NAN);
            if !value.is_finite() || value < 0.0 {
                return Err(RunError {
                    message: format!(
                        "native production Poisson-airbox diagnostics missing finite {field}"
                    ),
                });
            }
        }
        if diagnostics
            .get("full_residual_certified")
            .and_then(|value| value.as_bool())
            != Some(true)
        {
            return Err(RunError {
                message: "native production Poisson-airbox diagnostics missing full_residual_certified=true"
                    .to_string(),
            });
        }
    }
    let gpu = matches!(
        adapter.as_str(),
        "k0_poisson_airbox_gpu_petsc_slepc" | "k0_poisson_airbox_gpu_modal_device_krylov"
    );
    if gpu && gpu_attestation.is_none() {
        return Err(RunError {
            message: "k0_poisson_airbox_gpu_attestation_missing".to_string(),
        });
    }
    let cpu_schur = adapter == "k0_poisson_airbox_cpu_schur_slepc";
    let eps_q = diagnostics_number(diagnostics, "magnetic_block_backward_error").unwrap_or(0.0);
    let eps_phi = diagnostics_number(diagnostics, "poisson_block_backward_error").unwrap_or(0.0);
    let eps_gauge =
        diagnostics_number(diagnostics, "gauge_constraint_backward_error").unwrap_or(0.0);
    let eps_full = eps_q.max(eps_phi).max(eps_gauge);
    let certification_tolerance = diagnostics_number(diagnostics, "residual_tolerance")
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0e-8_f64);
    let outer_boundary_kind = diagnostics
        .get("outer_boundary_kind")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let gauge_policy = diagnostics
        .get("gauge_policy")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let gauge_reason = diagnostics
        .get("gauge_reason")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let target_omega = diagnostics_number(diagnostics, "target_omega_rad_s")
        .unwrap_or_else(|| native_modal_target_frequency_hz(&plan.target) * std::f64::consts::TAU);
    let requested_device = if gpu { "gpu" } else { "cpu" };
    let engine = if gpu {
        "gpu_petsc_slepc_cuda"
    } else if cpu_schur {
        "cpu_slepc_schur_targeted"
    } else {
        "cpu_slepc_shift_invert"
    };
    let solver_library = if gpu {
        "SLEPc/PETSc/hypre CUDA"
    } else {
        "SLEPc/PETSc"
    };
    let status = diagnostics
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();
    let fallback_used = diagnostics
        .get("fallback_used")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let fallback_reason = diagnostics
        .get("fallback_reason")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let robin_beta = diagnostics
        .get("robin_beta")
        .cloned()
        .unwrap_or(serde_json::json!(0.0));
    let spectral_transform = diagnostics
        .get("spectral_transform")
        .cloned()
        .unwrap_or_else(|| {
            serde_json::json!(if gpu {
                "shift_invert"
            } else if cpu_schur {
                "shift_invert"
            } else {
                "shift_invert"
            })
        });
    let spectral_pencil_kind = diagnostics
        .get("spectral_pencil_kind")
        .cloned()
        .unwrap_or_else(|| serde_json::json!("real_frequency_rotated"));
    let target_representation = diagnostics
        .get("target_representation")
        .cloned()
        .unwrap_or_else(|| serde_json::json!("tau=omega_target"));
    let target_tau_rad_s = diagnostics
        .get("target_tau_rad_s")
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(target_omega);
    let linear_control_d2h_transfer_count = gpu_attestation
        .map(|value| value.hot_loop_scalar_telemetry_syncs)
        .or_else(|| {
            diagnostics_number(diagnostics, "linear_control_d2h_transfer_count")
                .map(|value| value.max(0.0) as u64)
        })
        .unwrap_or(0);
    let setup_h2d_transfer_count = gpu_attestation
        .map(|value| value.setup_h2d_count)
        .or_else(|| {
            diagnostics_number(diagnostics, "setup_h2d_transfer_count")
                .or_else(|| diagnostics_number(diagnostics, "setup_h2d_block_transfers"))
                .map(|value| value.max(0.0) as u64)
        })
        .unwrap_or(0);
    let final_d2h_transfer_count = gpu_attestation
        .map(|value| value.export_d2h_count)
        .or_else(|| {
            diagnostics_number(diagnostics, "final_d2h_transfer_count")
                .or_else(|| diagnostics_number(diagnostics, "final_d2h_vector_transfers"))
                .map(|value| value.max(0.0) as u64)
        })
        .unwrap_or(0);
    diagnostics.insert(
        "physics_contract_version".to_string(),
        serde_json::json!("micromagnetics_frequency_domain_v5"),
    );
    diagnostics.insert(
        "operator_dictionary_version".to_string(),
        serde_json::json!("FrequencyOperatorDictionary.v1"),
    );
    diagnostics.insert(
        "implementation_state".to_string(),
        serde_json::json!("executable"),
    );
    diagnostics.insert(
        "validation_state".to_string(),
        serde_json::json!("unvalidated"),
    );
    diagnostics.insert(
        "execution_lane".to_string(),
        serde_json::json!(if gpu {
            "production_gpu"
        } else {
            "production_cpu"
        }),
    );
    diagnostics.insert(
        "production_periodic_airbox_claim".to_string(),
        serde_json::json!(true),
    );
    diagnostics.insert(
        "validated_scope".to_string(),
        serde_json::json!(if gpu {
            serde_json::Value::Null
        } else {
            serde_json::json!("fem_k0_periodic_airbox_p1_double_cpu_slepc")
        }),
    );
    diagnostics.insert(
        "requested_execution".to_string(),
        serde_json::json!({
            "backend": "fem",
            "device": requested_device,
            "precision": "double",
            "execution_mode": "strict",
            "study_product": "modal_eigen",
            "solver_method": if gpu || !cpu_schur {
                "shift_invert"
            } else {
                "targeted_spectrum"
            },
            "preconditioner": if gpu { "shifted_schur_device" } else { "lu" },
            "include_demag": true,
            "magnetostatic_bc": "periodic_airbox_k0",
        }),
    );
    diagnostics.insert(
        "resolved_execution".to_string(),
        serde_json::json!({
            "backend": "fem",
            "device": requested_device,
            "precision": "double",
            "engine": engine,
            "implementation_id": adapter,
            "solver_library": solver_library,
            "operator_residency": if gpu { "device" } else { "host" },
            "vector_residency": if gpu { "device" } else { "host" },
            "krylov_residency": if gpu { "device" } else { "host" },
            "preconditioner_residency": if gpu { "device" } else { "host" },
            "fallback_used": fallback_used,
            "fallback_reason": fallback_reason,
            "status": status,
        }),
    );
    diagnostics.insert(
        "boundary_gauge".to_string(),
        serde_json::json!({
            "magnetostatic_bc": "periodic_airbox_k0",
            "outer_boundary_kind": outer_boundary_kind,
            "robin_beta": robin_beta,
            "robin_beta_unit": "1/m",
            "gauge_policy": gauge_policy,
            "gauge_reason": gauge_reason,
            "eta_row_present": gauge_policy == "mean_zero_augmented",
        }),
    );
    diagnostics.insert(
        "spectral".to_string(),
        serde_json::json!({
            "spectral_transform": spectral_transform,
            "spectral_pencil_kind": spectral_pencil_kind,
            "spectral_scalar_mode": "real_split",
            "target_representation": target_representation,
            "tau_rad_per_s": target_tau_rad_s,
        }),
    );
    diagnostics.insert(
        "block_residuals".to_string(),
        serde_json::json!({
            "eps_q": eps_q,
            "eps_phi": eps_phi,
            "eps_gauge": eps_gauge,
            "eps_full": eps_full,
            "backend_reported_residual": diagnostics_number(diagnostics, "slepc_reported_backward_error").unwrap_or_else(|| diagnostics_number(diagnostics, "last_residual_relative").unwrap_or(eps_full)),
            "certification_tolerance": certification_tolerance,
            "certified": eps_full <= certification_tolerance,
        }),
    );
    diagnostics.insert(
        "device_transfer_audit".to_string(),
        serde_json::json!({
            "setup_h2d_transfer_count": setup_h2d_transfer_count,
            "final_d2h_transfer_count": final_d2h_transfer_count,
            "hot_loop_h2d_bytes": gpu_attestation.map(|value| value.hot_loop_computational_h2d_bytes),
            "hot_loop_d2h_bytes": gpu_attestation.map(|value| value.hot_loop_computational_d2h_bytes),
            "hot_loop_host_sync_count": linear_control_d2h_transfer_count,
            "control_scalar_d2h_bytes": gpu_attestation.map(|value| value.hot_loop_scalar_telemetry_d2h_bytes),
            "device_resident_claim": gpu_attestation.map(|value| value.device_residency_verified).unwrap_or(false),
        }),
    );
    Ok(())
}
