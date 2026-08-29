use super::eigen_capability::{
    native_cpu_modal_window_enabled, native_gpu_k0_kittel_modal_supported,
    native_gpu_shared_domain_modal_supported,
};
use super::eigen_certificate::{modal_participation_for_mode, modal_participation_mesh_context};
use super::eigen_constants::{FLOQUET_DYNAMIC_DEMAG_UNSUPPORTED, NATIVE_GPU_K0_KITTEL_SOLVER_KIND};
use super::eigen_equilibrium::{
    bind_stage_continuation_artifacts, materialize_equilibrium, prepare_single_k_stage_continuation,
};
use super::eigen_equilibrium_contract::{
    AcceptedFemEigenEquilibriumHandoff, AcceptedFemRelaxStageHandoff,
};
use super::eigen_execution_resolution::{FemEigenExecutionLane, PlannedFemEigenExecution};
use super::eigen_math::{
    angular_frequency_from_eigenvalue, angular_frequency_from_raw_eigenvalue, norm,
};
use super::eigen_native_artifacts::{
    execution_provenance, native_gpu_k0_kittel_execution_provenance, native_modal_artifacts,
};
use super::eigen_native_result::{
    complex_block_mass_norm, gyrotropic_pencil_residual_norms, normalize_complex_block_mode,
    validate_native_modal_lambda_frequency_mapping, NativeModalEigenpair,
};
use super::eigen_native_window::{
    execute_native_cpu_modal_window_from_bloch_floquet_complex, execute_native_modal_window,
    gyrotropic_matrix_row_major_from_tangent_mass, node_mass_weights_from_tangent_mass,
};
use super::eigen_operator::{
    assemble_full_2x2_operator_real, assemble_projected_full_2x2_operator_complex,
    assemble_projected_scalar_operator_complex, assemble_projected_scalar_operator_real,
};
use super::eigen_output::{
    classify_polarization, damping_imaginary_factor, damping_policy_label, dispersion_csv,
    dispersion_v2_csv, equilibrium_source_json, json_artifact, k_vector_json,
    merge_modal_transport_diagnostics, modal_tangent_transport_diagnostics, normalization_label,
    requested_mode_indices, solver_capabilities, solver_kind_label, solver_limitations,
    solver_notes, spin_wave_bc_json, spin_wave_bc_label, write_eigen_v2_bundle,
};
use super::eigen_policy::{
    native_modal_damping_policy, native_modal_equilibrium_source_kind,
    native_modal_frequency_max_hz, native_modal_frequency_min_hz, native_modal_k_vector,
    native_modal_spin_wave_bc_kind, native_modal_target_frequency_hz, native_modal_target_kind,
    resolved_demag_realization, shared_domain_k0_modal_requested,
};
use super::eigen_progress::{emit_fem_eigen_progress, FemEigenProgress, FemEigenProgressCallback};
use super::eigen_projection::{
    project_2x2_mode_to_tangent_basis, project_complex_2x2_mode_to_tangent_basis,
    project_complex_mode_to_tangent_basis, project_real_mode_to_tangent_basis, tangent_bases,
};
use super::eigen_reduction::build_reduction_map;
use super::eigen_shared_domain::{
    native_shared_domain_magnetic_assembly_available, native_shared_domain_magnetic_assembly_error,
    shared_domain_k0_runtime_unavailable_error, validate_eigen_equilibrium_certificate,
};
use super::eigen_solve::{
    gpu_solve_real_symmetric_eigenpairs, mode_tangent_leakage, orthogonality_rows_json,
    solve_complex_hermitian_eigenpairs, solve_real_symmetric_eigenpairs,
    solve_real_symmetric_eigenpairs_sparse, sparse_lobpcg_candidate_count, SPARSE_EIGEN_THRESHOLD,
};
use super::eigen_sweep::{
    bias_field_sweep_requested, execute_bias_field_sweep_with_executor,
    execute_bias_field_sweep_with_planned_execution,
};
use crate::native_fem;
use crate::types::AuxiliaryArtifact;
use crate::types::ExecutedRun;
use crate::types::RunError;
use crate::types::RunResult;
use crate::types::RunStatus;
use crate::types::StepStats;
use fullmag_engine::Vector3;
use fullmag_engine::MU0;
use fullmag_ir::EigenDampingPolicyIR;
use fullmag_ir::FemEigenPlanIR;
use fullmag_ir::OutputIR;
use fullmag_ir::SpinWaveBoundaryConditionIR;
use fullmag_ir::SpinWaveBoundaryKindIR;
use num_complex::Complex64;
use std::collections::BTreeSet;

pub(crate) fn reject_unsupported_floquet_dynamic_demag(
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
    include_demag: bool,
) -> Result<(), RunError> {
    if include_demag && matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        return Err(RunError {
            message: FLOQUET_DYNAMIC_DEMAG_UNSUPPORTED.to_string(),
        });
    }
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn execute_baseline_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(plan, outputs, false, false, None, 0, None, None, None, None)
}

#[allow(dead_code)]
pub(crate) fn execute_baseline_fem_eigen_with_progress(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(
        plan,
        outputs,
        false,
        false,
        Some(progress),
        0,
        None,
        None,
        None,
        None,
    )
}

/// Execute every declared physics-owned bias-field sample as an independent
/// solve. Kittel metadata is rejected by the sweep owner until a real
/// per-sample postsolve adapter can emit expected-vs-solved pass/fail artifacts.
fn execute_bias_field_sweep(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    try_gpu: bool,
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
) -> Result<ExecutedRun, RunError> {
    execute_bias_field_sweep_with_executor(plan, |sample_plan, sample_position| {
        execute_fem_eigen_inner(
            sample_plan,
            outputs,
            try_gpu,
            true,
            progress.as_deref_mut(),
            sample_position,
            Some(&sample_plan.equilibrium_magnetization),
            None,
            None,
            None,
        )
    })
}

fn execute_planned_bias_field_sweep(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
) -> Result<ExecutedRun, RunError> {
    let resolution = execution.resolution().ok_or_else(|| RunError {
        message: "planned_fem_eigen_resolution_missing_at_execution".to_string(),
    })?;
    execute_bias_field_sweep_with_planned_execution(
        plan,
        resolution,
        |sample_plan, sample_position| {
            execute_fem_eigen_inner(
                sample_plan,
                outputs,
                execution.lane() == FemEigenExecutionLane::Gpu,
                true,
                progress.as_deref_mut(),
                sample_position,
                Some(&sample_plan.equilibrium_magnetization),
                None,
                None,
                Some(execution),
            )
        },
    )
}

fn validate_planned_execution(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
) -> Result<(), RunError> {
    if execution.resolution().is_none() || execution.native_target().is_none() {
        return Err(RunError {
            message: "planned_fem_eigen_resolution_missing_at_execution".to_string(),
        });
    }
    if !shared_domain_k0_modal_requested(plan) {
        return Err(RunError {
            message: format!(
                "planned_fem_eigen_engine_scope_mismatch: engine={} requires bounded periodic_airbox_k0",
                execution.engine_id()
            ),
        });
    }
    if !native_shared_domain_magnetic_assembly_available(plan) {
        let mut error = shared_domain_k0_runtime_unavailable_error();
        if let Some(detail) = native_shared_domain_magnetic_assembly_error(plan) {
            error.message.push_str("; producer validation: ");
            error.message.push_str(&detail);
        }
        return Err(error);
    }
    Ok(())
}

pub(crate) fn execute_planned_fem_eigen(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    validate_planned_execution(execution, plan)?;
    if bias_field_sweep_requested(plan) {
        return execute_planned_bias_field_sweep(execution, plan, outputs, None);
    }
    execute_fem_eigen_inner(
        plan,
        outputs,
        execution.lane() == FemEigenExecutionLane::Gpu,
        true,
        None,
        0,
        None,
        None,
        None,
        Some(execution),
    )
}

pub(crate) fn execute_planned_fem_eigen_with_handoff(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
) -> Result<ExecutedRun, RunError> {
    validate_planned_execution(execution, plan)?;
    if bias_field_sweep_requested(plan) {
        if handoff.is_some() {
            return Err(RunError {
                message: "planned_fem_eigen_sweep_does_not_accept_path_handoff".to_string(),
            });
        }
        return execute_planned_bias_field_sweep(execution, plan, outputs, None);
    }
    execute_fem_eigen_inner(
        plan,
        outputs,
        execution.lane() == FemEigenExecutionLane::Gpu,
        true,
        None,
        0,
        None,
        handoff,
        None,
        Some(execution),
    )
}

pub(crate) fn execute_planned_fem_eigen_with_progress(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
) -> Result<ExecutedRun, RunError> {
    validate_planned_execution(execution, plan)?;
    if bias_field_sweep_requested(plan) {
        return execute_planned_bias_field_sweep(execution, plan, outputs, Some(progress));
    }
    execute_fem_eigen_inner(
        plan,
        outputs,
        execution.lane() == FemEigenExecutionLane::Gpu,
        true,
        Some(progress),
        0,
        None,
        None,
        None,
        Some(execution),
    )
}

pub(crate) fn execute_planned_fem_eigen_with_progress_and_stage_handoff(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
    handoff: &AcceptedFemRelaxStageHandoff,
) -> Result<ExecutedRun, RunError> {
    let prepared = prepare_single_k_stage_continuation(plan, handoff)?;
    validate_planned_execution(execution, &prepared)?;
    let mut run = execute_fem_eigen_inner(
        &prepared,
        outputs,
        execution.lane() == FemEigenExecutionLane::Gpu,
        true,
        Some(progress),
        0,
        None,
        None,
        Some(handoff),
        Some(execution),
    )?;
    bind_stage_continuation_artifacts(&mut run, handoff)?;
    Ok(run)
}

pub(crate) fn execute_cpu_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_cpu_fem_eigen_with_handoff(plan, outputs, None)
}

pub(crate) fn execute_cpu_fem_eigen_with_handoff(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
) -> Result<ExecutedRun, RunError> {
    if shared_domain_k0_modal_requested(plan)
        && !native_shared_domain_magnetic_assembly_available(plan)
    {
        let mut error = shared_domain_k0_runtime_unavailable_error();
        if let Some(detail) = native_shared_domain_magnetic_assembly_error(plan) {
            error.message.push_str("; producer validation: ");
            error.message.push_str(&detail);
        }
        return Err(error);
    }
    if bias_field_sweep_requested(plan) {
        return execute_bias_field_sweep(plan, outputs, false, None);
    }
    execute_fem_eigen_inner(
        plan,
        outputs,
        false,
        native_cpu_modal_window_enabled(plan),
        None,
        0,
        None,
        handoff,
        None,
        None,
    )
}

pub(crate) fn execute_cpu_fem_eigen_with_progress(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
) -> Result<ExecutedRun, RunError> {
    if shared_domain_k0_modal_requested(plan)
        && !native_shared_domain_magnetic_assembly_available(plan)
    {
        let mut error = shared_domain_k0_runtime_unavailable_error();
        if let Some(detail) = native_shared_domain_magnetic_assembly_error(plan) {
            error.message.push_str("; producer validation: ");
            error.message.push_str(&detail);
        }
        return Err(error);
    }
    if bias_field_sweep_requested(plan) {
        return execute_bias_field_sweep(plan, outputs, false, Some(progress));
    }
    execute_fem_eigen_inner(
        plan,
        outputs,
        false,
        native_cpu_modal_window_enabled(plan),
        Some(progress),
        0,
        None,
        None,
        None,
        None,
    )
}

pub(crate) fn execute_cpu_fem_eigen_with_progress_and_stage_handoff(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
    handoff: &AcceptedFemRelaxStageHandoff,
) -> Result<ExecutedRun, RunError> {
    let prepared = prepare_single_k_stage_continuation(plan, handoff)?;
    let mut run = execute_fem_eigen_inner(
        &prepared,
        outputs,
        false,
        native_cpu_modal_window_enabled(&prepared),
        Some(progress),
        0,
        None,
        None,
        Some(handoff),
        None,
    )?;
    bind_stage_continuation_artifacts(&mut run, handoff)?;
    Ok(run)
}

/// GPU-accelerated FEM eigensolver.
///
/// Shared-domain K0 with dynamic demag is dispatched to the native
/// device-resident Krylov lane.  The legacy non-demag scalar path below still
/// uses the bounded dense cuSolverDN contract.
///
/// When `try_gpu` is true and the GPU is unavailable or fails, returns an
/// error — no silent fallback to CPU.
pub(crate) fn execute_gpu_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: Option<&mut FemEigenProgressCallback<'_>>,
) -> Result<ExecutedRun, RunError> {
    execute_gpu_fem_eigen_with_handoff(plan, outputs, progress, None)
}

pub(crate) fn execute_gpu_fem_eigen_with_handoff(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: Option<&mut FemEigenProgressCallback<'_>>,
    handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
) -> Result<ExecutedRun, RunError> {
    if shared_domain_k0_modal_requested(plan)
        && !native_shared_domain_magnetic_assembly_available(plan)
    {
        let mut error = shared_domain_k0_runtime_unavailable_error();
        if let Some(detail) = native_shared_domain_magnetic_assembly_error(plan) {
            error.message.push_str("; producer validation: ");
            error.message.push_str(&detail);
        }
        return Err(error);
    }
    if bias_field_sweep_requested(plan) {
        return execute_bias_field_sweep(plan, outputs, true, progress);
    }
    if native_gpu_k0_kittel_modal_supported(plan) {
        return execute_native_gpu_k0_kittel_modal(plan, outputs, handoff);
    }

    if native_gpu_shared_domain_modal_supported(plan) {
        return execute_fem_eigen_inner(
            plan, outputs, true, true, progress, 0, None, handoff, None, None,
        );
    }

    if handoff.is_some() {
        return Err(RunError {
            message: "relax_to_eigen_handoff_requires_shared_domain_modal_execution".to_string(),
        });
    }

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
        operator_diagnostics_json: None,
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
        completeness_policy: 0,
        eigensolver_family: 0,
        spectral_transform_kind: 0,
        execution_target: native_fem::NativeModalExecutionTarget::Auto,
        cancel_requested: None,
        progress_callback: None,
        tiny_validation_problem: None,
        mfem_operator_problem: None,
        mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        shared_domain_problem: None,
    })
    .map_err(|message| RunError { message })?;

    Err(RunError {
        message: format!(
            "native FEM modal_eigen production path is unavailable: {} (diagnostics_json={})",
            native_result.error_message, native_result.diagnostics_json
        ),
    })
}

pub(crate) fn execute_gpu_fem_eigen_with_progress_and_stage_handoff(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: Option<&mut FemEigenProgressCallback<'_>>,
    handoff: &AcceptedFemRelaxStageHandoff,
) -> Result<ExecutedRun, RunError> {
    let prepared = prepare_single_k_stage_continuation(plan, handoff)?;
    if !native_gpu_shared_domain_modal_supported(&prepared) {
        return Err(RunError {
            message: "relax_to_eigen_handoff_requires_shared_domain_modal_execution".to_string(),
        });
    }
    let mut run = execute_fem_eigen_inner(
        &prepared,
        outputs,
        true,
        true,
        progress,
        0,
        None,
        None,
        Some(handoff),
        None,
    )?;
    bind_stage_continuation_artifacts(&mut run, handoff)?;
    Ok(run)
}

fn execute_native_gpu_k0_kittel_modal(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    expected_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
) -> Result<ExecutedRun, RunError> {
    validate_eigen_equilibrium_certificate(plan, expected_handoff, None)?;
    let initial_magnetization = plan.equilibrium_magnetization.clone();
    let (problem, equilibrium, relaxation_steps, observables, _source_artifact) =
        materialize_equilibrium(plan, &initial_magnetization, None)?;
    let reduction = build_reduction_map(
        &problem.topology,
        &plan.spin_wave_bc,
        plan.k_sampling.as_ref(),
    )?;
    if reduction.active_nodes.is_empty() {
        return Err(RunError {
            message: "FEM GPU K0 Kittel modal solver found no magnetically active nodes"
                .to_string(),
        });
    }
    if reduction.complex_reduction {
        return Err(RunError {
            message: "FEM GPU K0 Kittel modal solver requires k=0 real periodic reduction"
                .to_string(),
        });
    }

    let bases = tangent_bases(&equilibrium);
    let active_nodes = reduction.active_nodes.len();
    let (stiffness_field, mass) = assemble_full_2x2_operator_real(
        plan,
        &problem.topology,
        &reduction,
        &observables,
        &equilibrium,
        &bases,
    );
    let gpu_result = native_fem::gpu_eigen_dense_solve(
        stiffness_field.as_slice(),
        mass.as_slice(),
        stiffness_field.nrows(),
        stiffness_field.nrows(),
    )
    .map_err(|message| RunError {
        message: format!("FEM GPU K0 Kittel modal dense solve failed: {message}"),
    })?;
    let field_eigenvalue = select_k0_kittel_gpu_field_eigenvalue(plan, &gpu_result.eigenvalues)?;
    let omega_rad_s = plan.gyromagnetic_ratio * field_eigenvalue;
    let frequency_hz = omega_rad_s / std::f64::consts::TAU;
    validate_native_modal_lambda_frequency_mapping(omega_rad_s, omega_rad_s, frequency_hz)?;

    let mut mode_vector = k0_macrospin_modal_vector(active_nodes);
    normalize_complex_block_mode(&mut mode_vector, &mass, plan.normalization);
    let tangent_dof = stiffness_field.nrows();
    let stiffness_omega = stiffness_field * plan.gyromagnetic_ratio;
    let gyrotropic_row_major = gyrotropic_matrix_row_major_from_tangent_mass(&mass, active_nodes)?;
    let lambda = Complex64::new(0.0, omega_rad_s);
    let (residual_absolute_l2, residual_relative_l2, residual_linf) =
        gyrotropic_pencil_residual_norms(
            &stiffness_omega,
            &gyrotropic_row_major,
            lambda,
            &mode_vector,
        );
    let modes = vec![NativeModalEigenpair {
        cluster_id: 0,
        frequency_hz,
        omega_rad_s,
        eigenvalue_real: 0.0,
        eigenvalue_imag: omega_rad_s,
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        mass_norm: complex_block_mass_norm(&mass, &mode_vector).re,
        block_residual_q: residual_relative_l2,
        block_residual_phi: 0.0,
        block_residual_gauge: 0.0,
        backend_reported_residual: residual_relative_l2,
        vector: mode_vector,
        q_vector: Vec::new(),
        phi_vector: Vec::new(),
    }];
    let solver_diagnostics = native_gpu_k0_kittel_solver_diagnostics(
        plan,
        active_nodes,
        tangent_dof,
        &gpu_result.eigenvalues,
        field_eigenvalue,
        residual_relative_l2,
    );
    let auxiliary_artifacts = native_modal_artifacts(
        plan,
        outputs,
        &equilibrium,
        &reduction,
        &bases,
        &modes,
        node_mass_weights_from_tangent_mass(&mass, active_nodes).as_deref(),
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
        provenance: native_gpu_k0_kittel_execution_provenance(plan),
    })
}

fn select_k0_kittel_gpu_field_eigenvalue(
    plan: &FemEigenPlanIR,
    eigenvalues: &[f64],
) -> Result<f64, RunError> {
    let target_field = plan
        .external_field
        .map(norm)
        .filter(|value| value.is_finite() && *value > 0.0);
    let selected = eigenvalues
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0)
        .min_by(|left, right| {
            let lhs = target_field
                .map(|target| (*left - target).abs())
                .unwrap_or(*left);
            let rhs = target_field
                .map(|target| (*right - target).abs())
                .unwrap_or(*right);
            lhs.partial_cmp(&rhs).unwrap_or(std::cmp::Ordering::Equal)
        })
        .ok_or_else(|| RunError {
            message:
                "FEM GPU K0 Kittel modal dense solve returned no positive finite field eigenvalue"
                    .to_string(),
        })?;
    Ok(selected)
}

fn k0_macrospin_modal_vector(active_nodes: usize) -> Vec<Complex64> {
    let mut vector = Vec::with_capacity(2 * active_nodes);
    vector.extend((0..active_nodes).map(|_| Complex64::new(1.0, 0.0)));
    vector.extend((0..active_nodes).map(|_| Complex64::new(0.0, -1.0)));
    vector
}

fn native_gpu_k0_kittel_solver_diagnostics(
    plan: &FemEigenPlanIR,
    active_nodes: usize,
    tangent_dof: usize,
    eigenvalues: &[f64],
    selected_field_eigenvalue: f64,
    residual_relative_l2: f64,
) -> serde_json::Value {
    serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": true,
        "solver_backend": "native_fem_modal_eigen",
        "solver_model": NATIVE_GPU_K0_KITTEL_SOLVER_KIND,
        "solver_kind": NATIVE_GPU_K0_KITTEL_SOLVER_KIND,
        "solver_library": "cusolverdn",
        "resolved_solver_family": "gpu_dense_k0_macrospin",
        "spectral_transform": "dense_generalized",
        "solver_adapter": "cusolverdn_dense_k0_macrospin_modal",
        "execution_lane": "production_gpu",
        "production_solver_available": true,
        "device_residency": "gpu_device_resident",
        "algebraic_form": "k0_macrospin_field_generalized_to_gyrotropic_modal",
        "matrix_equation": "K u = lambda_field M u; lambda_modal = i gamma0 lambda_field",
        "phasor_convention": "exp_i_omega_t",
        "eigenvalue_mapping": "lambda_eq_i_omega",
        "frequency_mapping": "frequency_hz = imag(lambda)/(2*pi)",
        "production_gyrotropic_mapping": true,
        "active_node_count": active_nodes,
        "tangent_dof_count": tangent_dof,
        "requested_mode_count": plan.count,
        "candidate_modes": eigenvalues.len(),
        "selected_field_eigenvalue_A_per_m": selected_field_eigenvalue,
        "selected_frequency_hz": plan.gyromagnetic_ratio * selected_field_eigenvalue / std::f64::consts::TAU,
        "residual_relative_l2": residual_relative_l2,
        "limitations": [
            "k0_only",
            "no_demag",
            "macrospin_larmor_validation_slice",
            "not_nonzero_k_floquet_modal_gpu",
        ],
    })
}

pub(super) fn execute_fem_eigen_inner(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    try_gpu: bool,
    use_native_modal_production: bool,
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
    artifact_sample_index: usize,
    initial_magnetization_override: Option<&[Vector3]>,
    expected_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
    planned_execution: Option<PlannedFemEigenExecution<'_>>,
) -> Result<ExecutedRun, RunError> {
    validate_eigen_equilibrium_certificate(plan, expected_handoff, source_relax_handoff)?;
    if plan.precision != fullmag_ir::ExecutionPrecision::Double {
        return Err(RunError {
            message: if try_gpu {
                "execution_precision='single' is not executable in the FEM eigen GPU path; single-precision GPU eigensolve is not yet implemented"
            } else {
                "execution_precision='single' is not executable in the FEM eigen CPU path; use 'double'"
            }
            .to_string(),
        });
    }
    if use_native_modal_production
        && shared_domain_k0_modal_requested(plan)
        && !native_shared_domain_magnetic_assembly_available(plan)
    {
        let mut error = shared_domain_k0_runtime_unavailable_error();
        if let Some(detail) = native_shared_domain_magnetic_assembly_error(plan) {
            error.message.push_str("; producer validation: ");
            error.message.push_str(&detail);
        }
        return Err(error);
    }
    reject_unsupported_floquet_dynamic_demag(&plan.spin_wave_bc, plan.operator.include_demag)?;
    let num_modes = plan.count as usize;

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "materializing_equilibrium",
            phase_index: 1,
            phase_count: 5,
            percent: 5.0,
            solver_kind: solver_kind_label(plan),
            active_nodes: 0,
            effective_dof: 0,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: 0,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    let initial_magnetization = initial_magnetization_override
        .map(<[Vector3]>::to_vec)
        .unwrap_or_else(|| plan.equilibrium_magnetization.clone());
    let (problem, equilibrium, relaxation_steps, observables, source_artifact) =
        materialize_equilibrium(plan, &initial_magnetization, source_relax_handoff)?;
    let topology = &problem.topology;
    let mut solver_kind = solver_kind_label(plan);
    let reduction = build_reduction_map(topology, &plan.spin_wave_bc, plan.k_sampling.as_ref())?;
    if reduction.active_nodes.is_empty() {
        return Err(RunError {
            message: "FEM eigen solver found no magnetically active nodes".to_string(),
        });
    }
    let complex_reduction = reduction.complex_reduction;

    // Warn about dense O(n³) scaling for large problems (transitional path).
    let active_n = reduction.active_nodes.len();
    let is_full_2x2 = matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2);
    let effective_dof = if is_full_2x2 { 2 * active_n } else { active_n };
    let use_sparse = effective_dof > SPARSE_EIGEN_THRESHOLD && !try_gpu && !complex_reduction;
    if effective_dof > 3000 && !use_sparse {
        eprintln!(
            "warning: FEM eigen dense solver has {} effective DOF ({} active nodes, {}) — O(n³) scaling; \
             consider reducing mesh size or awaiting future sparse/Krylov eigensolver",
            effective_dof,
            active_n,
            if is_full_2x2 { "full 2×2" } else { "scalar" }
        );
    }
    if use_sparse {
        eprintln!(
            "info: FEM eigen using sparse LOBPCG solver for {} effective DOF ({} active nodes, {})",
            effective_dof,
            active_n,
            if is_full_2x2 { "full 2×2" } else { "scalar" }
        );
    }

    let progress_solver_kind = if use_sparse {
        "cpu_sparse_lobpcg"
    } else {
        solver_kind_label(plan)
    };
    let dense_warning = (effective_dof > 3000 && !use_sparse)
        .then_some("dense_o_n3_eigensolve_without_iteration_progress");
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "assembling_operator",
            phase_index: 2,
            phase_count: 5,
            percent: 20.0,
            solver_kind: progress_solver_kind,
            active_nodes: active_n,
            effective_dof,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: 0,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: dense_warning,
        },
    )?;

    let bases = tangent_bases(&equilibrium);
    let mut dense_orthogonality = None;

    let real_eigenpairs = if complex_reduction {
        Vec::new()
    } else if is_full_2x2 {
        if use_native_modal_production && shared_domain_k0_modal_requested(plan) {
            return execute_native_modal_window(
                plan,
                outputs,
                initial_magnetization,
                equilibrium,
                observables,
                relaxation_steps,
                &problem,
                source_artifact.as_ref(),
                source_relax_handoff,
                topology,
                &reduction,
                &bases,
                None,
                progress,
                active_n,
                effective_dof,
                artifact_sample_index,
                planned_execution
                    .and_then(PlannedFemEigenExecution::native_target)
                    .unwrap_or(if try_gpu {
                        native_fem::NativeModalExecutionTarget::ProductionGpu
                    } else {
                        native_fem::NativeModalExecutionTarget::ProductionCpu
                    }),
                planned_execution,
                expected_handoff,
            );
        }
        let (stiffness, mass) = assemble_full_2x2_operator_real(
            plan,
            topology,
            &reduction,
            &observables,
            &equilibrium,
            &bases,
        );
        if use_native_modal_production {
            return execute_native_modal_window(
                plan,
                outputs,
                initial_magnetization,
                equilibrium,
                observables,
                relaxation_steps,
                &problem,
                source_artifact.as_ref(),
                source_relax_handoff,
                topology,
                &reduction,
                &bases,
                Some((&stiffness, &mass)),
                progress,
                active_n,
                effective_dof,
                artifact_sample_index,
                planned_execution
                    .and_then(PlannedFemEigenExecution::native_target)
                    .unwrap_or(if try_gpu {
                        native_fem::NativeModalExecutionTarget::ProductionGpu
                    } else {
                        native_fem::NativeModalExecutionTarget::ProductionCpu
                    }),
                planned_execution,
                expected_handoff,
            );
        }
        if use_sparse {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_sparse_lobpcg",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: sparse_lobpcg_candidate_count(
                        &plan.target,
                        num_modes,
                        effective_dof,
                    ),
                    computed_modes: 0,
                    iteration: Some(0),
                    max_iterations: None,
                    residual: None,
                    warning: None,
                },
            )?;
            solve_real_symmetric_eigenpairs_sparse(
                plan,
                &stiffness,
                &mass,
                num_modes,
                progress.as_deref_mut(),
                active_n,
                effective_dof,
            )?
        } else {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_dense",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: num_modes,
                    computed_modes: 0,
                    iteration: None,
                    max_iterations: None,
                    residual: None,
                    warning: dense_warning,
                },
            )?;
            let eigenpairs = solve_real_symmetric_eigenpairs(plan, &stiffness, &mass)?;
            dense_orthogonality = Some(orthogonality_rows_json(&mass, &eigenpairs));
            eigenpairs
        }
    } else {
        let operator = assemble_projected_scalar_operator_real(
            plan,
            topology,
            &reduction,
            &observables,
            &equilibrium,
        );
        operator
            .validate_petsc_slepc_binding()
            .map_err(|message| RunError {
                message: format!("FEM eigen scalar operator is not bindable: {message}"),
            })?;
        if try_gpu {
            // Attempt GPU dense generalized solve; return error if GPU was
            // explicitly requested but is unavailable or fails.
            match gpu_solve_real_symmetric_eigenpairs(plan, &operator.stiffness, &operator.mass) {
                Ok(pairs) => {
                    eprintln!(
                        "info: FEM eigen GPU solve succeeded ({} modes)",
                        pairs.len()
                    );
                    dense_orthogonality = Some(orthogonality_rows_json(&operator.mass, &pairs));
                    pairs
                }
                Err(reason) => {
                    if reason.contains("UNAVAILABLE") {
                        return Err(RunError {
                            message: format!(
                                "FEM eigen GPU was explicitly requested but is unavailable: {reason}"
                            ),
                        });
                    } else {
                        return Err(RunError {
                            message: format!("FEM eigen GPU solve failed: {reason}"),
                        });
                    }
                }
            }
        } else if use_sparse {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_sparse_lobpcg",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: sparse_lobpcg_candidate_count(
                        &plan.target,
                        num_modes,
                        effective_dof,
                    ),
                    computed_modes: 0,
                    iteration: Some(0),
                    max_iterations: None,
                    residual: None,
                    warning: None,
                },
            )?;
            solve_real_symmetric_eigenpairs_sparse(
                plan,
                &operator.stiffness,
                &operator.mass,
                num_modes,
                progress.as_deref_mut(),
                active_n,
                effective_dof,
            )?
        } else {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_dense",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: num_modes,
                    computed_modes: 0,
                    iteration: None,
                    max_iterations: None,
                    residual: None,
                    warning: dense_warning,
                },
            )?;
            let eigenpairs =
                solve_real_symmetric_eigenpairs(plan, &operator.stiffness, &operator.mass)?;
            dense_orthogonality = Some(orthogonality_rows_json(&operator.mass, &eigenpairs));
            eigenpairs
        }
    };
    if use_sparse {
        solver_kind = "cpu_sparse_lobpcg";
    }
    let complex_eigenpairs = if complex_reduction {
        let (stiffness, mass) = if is_full_2x2 {
            assemble_projected_full_2x2_operator_complex(
                plan,
                topology,
                &reduction,
                &observables,
                &equilibrium,
                &bases,
            )
        } else {
            assemble_projected_scalar_operator_complex(
                plan,
                topology,
                &reduction,
                &observables,
                &equilibrium,
            )
        };
        if is_full_2x2 && use_native_modal_production {
            return execute_native_cpu_modal_window_from_bloch_floquet_complex(
                plan,
                outputs,
                initial_magnetization,
                equilibrium,
                observables,
                relaxation_steps,
                &reduction,
                &bases,
                &stiffness,
                &mass,
                progress,
                active_n,
                effective_dof,
            );
        }
        solve_complex_hermitian_eigenpairs(plan, stiffness, mass)?
    } else {
        Vec::new()
    };

    let requested_modes = requested_mode_indices(outputs);
    let wants_spectrum = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }));
    let wants_dispersion = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::DispersionCurve { .. }));

    let mut auxiliary_artifacts = Vec::new();
    let total_modes = if complex_reduction {
        complex_eigenpairs.len()
    } else {
        real_eigenpairs.len()
    };
    let mut modes_summary = Vec::with_capacity(total_modes);
    let participation_context = modal_participation_mesh_context(plan);
    let tangent_leakage_mass_weights = reduction
        .active_nodes
        .iter()
        .map(|&node| topology.magnetic_node_volumes[node])
        .collect::<Vec<_>>();
    let participation_solver_device = if try_gpu { "gpu" } else { "cpu" };
    let damping_factor = damping_imaginary_factor(plan.material.damping, plan.damping_policy);
    let gamma_rad_s_t = plan.gyromagnetic_ratio / MU0;
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let mu0_t_m_per_a = MU0;
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "writing_artifacts",
            phase_index: 4,
            phase_count: 5,
            percent: 85.0,
            solver_kind: progress_solver_kind,
            active_nodes: active_n,
            effective_dof,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: total_modes,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    for mode_index in 0..total_modes {
        let (
            eigenvalue_real,
            eigenvalue_imag,
            residual_absolute_l2,
            residual_relative_l2,
            residual_linf,
            mass_norm,
            real,
            imag,
            amplitude,
            phase,
            max_amplitude,
            norm,
        ) = if complex_reduction {
            let pair = &complex_eigenpairs[mode_index];
            let (real, imag, amplitude, phase, max_amplitude) = if is_full_2x2 {
                project_complex_2x2_mode_to_tangent_basis(
                    topology.n_nodes,
                    &reduction.active_nodes,
                    &pair.vector,
                    &bases,
                )
            } else {
                project_complex_mode_to_tangent_basis(
                    topology.n_nodes,
                    &reduction.active_nodes,
                    &pair.vector,
                    &bases,
                )
            };
            let norm = pair
                .vector
                .iter()
                .map(|value| value.norm_sqr())
                .sum::<f64>()
                .sqrt();
            (
                pair.eigenvalue_real,
                pair.eigenvalue_imag,
                pair.residual_absolute_l2,
                pair.residual_relative_l2,
                pair.residual_linf,
                pair.mass_norm,
                real,
                imag,
                amplitude,
                phase,
                max_amplitude,
                norm,
            )
        } else if is_full_2x2 {
            let pair = &real_eigenpairs[mode_index];
            let (real, imag, amplitude, phase, max_amplitude) = project_2x2_mode_to_tangent_basis(
                topology.n_nodes,
                &reduction.active_nodes,
                &pair.vector,
                &bases,
            );
            let norm = pair.vector.norm();
            (
                pair.eigenvalue_real,
                pair.eigenvalue_imag,
                pair.residual_absolute_l2,
                pair.residual_relative_l2,
                pair.residual_linf,
                pair.mass_norm,
                real,
                imag,
                amplitude,
                phase,
                max_amplitude,
                norm,
            )
        } else {
            let pair = &real_eigenpairs[mode_index];
            let (real, imag, amplitude, phase, max_amplitude) = project_real_mode_to_tangent_basis(
                topology.n_nodes,
                &reduction.active_nodes,
                &pair.vector,
                &bases,
            );
            let norm = pair.vector.norm();
            (
                pair.eigenvalue_real,
                pair.eigenvalue_imag,
                pair.residual_absolute_l2,
                pair.residual_relative_l2,
                pair.residual_linf,
                pair.mass_norm,
                real,
                imag,
                amplitude,
                phase,
                max_amplitude,
                norm,
            )
        };
        let angular_frequency_real =
            angular_frequency_from_eigenvalue(plan.gyromagnetic_ratio, eigenvalue_real);
        let angular_frequency_imag = if eigenvalue_imag.abs() > 0.0 {
            angular_frequency_from_raw_eigenvalue(plan.gyromagnetic_ratio, eigenvalue_imag)
        } else {
            angular_frequency_real * damping_factor
        };
        let frequency_hz = angular_frequency_real / (2.0 * std::f64::consts::PI);
        let frequency_imag_hz = angular_frequency_imag / (2.0 * std::f64::consts::PI);
        let damping_included = matches!(plan.damping_policy, EigenDampingPolicyIR::Include);
        let phasor_convention = if damping_included {
            "exp_i_omega_t"
        } else {
            "not_applicable_real_reference"
        };
        let linewidth_fwhm_hz = 2.0 * frequency_imag_hz;
        let dominant_polarization = classify_polarization(
            &amplitude,
            &reduction.active_nodes,
            &equilibrium,
            max_amplitude,
        );
        let (
            tangent_leakage_mean_abs,
            tangent_leakage_max_abs,
            tangent_leakage_weighted_relative_l2,
        ) = mode_tangent_leakage(
            &equilibrium,
            &real,
            &imag,
            &reduction.active_nodes,
            Some(&tangent_leakage_mass_weights),
        );
        let component_participation = modal_participation_for_mode(
            &participation_context,
            plan,
            &real,
            &imag,
            participation_solver_device,
        );
        let mut mode_summary = serde_json::json!({
            "index": mode_index,
            "frequency_hz": frequency_hz,
            "frequency_real_hz": frequency_hz,
            "frequency_imag_hz": frequency_imag_hz,
            "angular_frequency_rad_per_s": angular_frequency_real,
            "omega_rad_s": angular_frequency_real,
            "angular_frequency_imag_rad_per_s": angular_frequency_imag,
            "eigenvalue_field_au_per_m": eigenvalue_real.max(0.0),
            "eigenvalue_real": eigenvalue_real,
            "eigenvalue_imag": eigenvalue_imag,
            "phasor_convention": phasor_convention,
            "eigenvalue_mapping": "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
            "norm": norm,
            "max_amplitude": max_amplitude,
            "residual_norm": residual_absolute_l2,
            "residual_absolute_l2": residual_absolute_l2,
            "residual_relative_l2": residual_relative_l2,
            "residual_linf": residual_linf,
            "mass_norm": mass_norm,
            "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
            "tangent_leakage_max_abs": tangent_leakage_max_abs,
            "tangent_leakage_weighted_relative_l2": tangent_leakage_weighted_relative_l2,
            "gamma_rad_s_T": gamma_rad_s_t,
            "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
            "mu0_T_m_per_A": mu0_t_m_per_a,
            "dominant_polarization": dominant_polarization,
            "k_vector": k_vector_json(plan.k_sampling.as_ref()),
            "component_participation": component_participation.clone(),
        });
        if damping_included {
            if let Some(object) = mode_summary.as_object_mut() {
                object.insert(
                    "complex_frequency_convention".to_string(),
                    serde_json::json!("omega_complex = omega_r + i Gamma for exp(i omega t)"),
                );
                object.insert(
                    "damping_rate_hz".to_string(),
                    serde_json::json!(frequency_imag_hz),
                );
                object.insert(
                    "linewidth_fwhm_hz".to_string(),
                    serde_json::json!(linewidth_fwhm_hz),
                );
            }
        }
        modes_summary.push(mode_summary.clone());

        if requested_modes.contains(&(mode_index as u32)) {
            let mut payload = serde_json::json!({
                "index": mode_index,
                "frequency_hz": frequency_hz,
                "frequency_real_hz": frequency_hz,
                "frequency_imag_hz": frequency_imag_hz,
                "angular_frequency_rad_per_s": angular_frequency_real,
                "omega_rad_s": angular_frequency_real,
                "angular_frequency_imag_rad_per_s": angular_frequency_imag,
                "eigenvalue_real": eigenvalue_real,
                "eigenvalue_imag": eigenvalue_imag,
                "phasor_convention": phasor_convention,
                "eigenvalue_mapping": "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
                "max_amplitude": max_amplitude,
                "residual_norm": residual_absolute_l2,
                "residual_absolute_l2": residual_absolute_l2,
                "residual_relative_l2": residual_relative_l2,
                "residual_linf": residual_linf,
                "mass_norm": mass_norm,
                "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
                "tangent_leakage_max_abs": tangent_leakage_max_abs,
                "tangent_leakage_weighted_relative_l2": tangent_leakage_weighted_relative_l2,
                "gamma_rad_s_T": gamma_rad_s_t,
                "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
                "mu0_T_m_per_A": mu0_t_m_per_a,
                "normalization": normalization_label(plan.normalization),
                "damping_policy": damping_policy_label(plan.damping_policy),
                "solver_backend": "cpu_baseline_fem_eigen",
                "solver_kind": solver_kind,
                "solver_notes": solver_notes(plan, complex_reduction, use_sparse),
                "solver_capabilities": solver_capabilities(plan, complex_reduction, use_sparse),
                "solver_limitations": solver_limitations(plan, complex_reduction, use_sparse),
                "dominant_polarization": dominant_polarization,
                "k_vector": k_vector_json(plan.k_sampling.as_ref()),
                "real": real,
                "imag": imag,
                "amplitude": amplitude,
                "phase": phase,
                "component_participation": component_participation,
            });
            if damping_included {
                if let Some(object) = payload.as_object_mut() {
                    object.insert(
                        "complex_frequency_convention".to_string(),
                        serde_json::json!("omega_complex = omega_r + i Gamma for exp(i omega t)"),
                    );
                    object.insert(
                        "damping_rate_hz".to_string(),
                        serde_json::json!(frequency_imag_hz),
                    );
                    object.insert(
                        "linewidth_fwhm_hz".to_string(),
                        serde_json::json!(linewidth_fwhm_hz),
                    );
                }
            }
            auxiliary_artifacts.push(json_artifact(
                format!("eigen/modes/mode_{mode_index:04}.json"),
                &payload,
            )?);
        }
    }

    let mut summary_payload = serde_json::json!({
        "study_kind": "eigenmodes",
        "solver_backend": "cpu_baseline_fem_eigen",
        "solver_kind": solver_kind,
        "solver_notes": solver_notes(plan, complex_reduction, use_sparse),
        "solver_capabilities": solver_capabilities(plan, complex_reduction, use_sparse),
        "solver_limitations": solver_limitations(plan, complex_reduction, use_sparse),
        "mesh_name": plan.mesh_name,
        "mode_count": modes_summary.len(),
        "normalization": normalization_label(plan.normalization),
        "damping_policy": damping_policy_label(plan.damping_policy),
        "spin_wave_bc": spin_wave_bc_label(plan.spin_wave_bc.clone()),
        "boundary_config": spin_wave_bc_json(&plan.spin_wave_bc),
        "equilibrium_source": equilibrium_source_json(&plan.equilibrium),
        "included_terms": {
            "exchange": plan.enable_exchange,
            "demag": plan.enable_demag,
            "zeeman": plan.external_field.is_some(),
            "interfacial_dmi": plan.interfacial_dmi.is_some(),
            "bulk_dmi": plan.bulk_dmi.is_some(),
            "surface_anisotropy": plan.spin_wave_bc.surface_anisotropy_ks().is_some(),
        },
        "operator": {
            "kind": format!("{:?}", plan.operator.kind).to_lowercase(),
            "include_demag": plan.operator.include_demag,
        },
        "solver_diagnostics": {
            "dense_reference_oracle": !use_sparse && !complex_reduction,
            "algebraic_form": "reference_effective_field_generalized",
            "matrix_equation": "K u = lambda M u",
            "phasor_convention": "not_applicable_real_reference",
            "eigenvalue_mapping": "omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)",
            "frequency_mapping": "frequency_hz = omega_rad_s / (2*pi)",
            "production_gyrotropic_mapping": false,
            "residual_definition": "relative_residual = ||K u - lambda M u||_2 / (||K u||_2 + |lambda| * ||M u||_2)",
            "tangent_leakage_definition": "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors",
            "constants": {
                "gamma_rad_s_T": gamma_rad_s_t,
                "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
                "mu0_T_m_per_A": mu0_t_m_per_a,
            },
            "orthogonality": dense_orthogonality,
        },
        "k_sampling": k_vector_json(plan.k_sampling.as_ref()),
        "relaxation_steps": relaxation_steps,
        "modes": modes_summary,
    });
    merge_modal_transport_diagnostics(
        &mut summary_payload["solver_diagnostics"],
        modal_tangent_transport_diagnostics(plan),
    );

    if wants_spectrum {
        auxiliary_artifacts.push(json_artifact("eigen/spectrum.json", &summary_payload)?);
    }
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/eigen_summary.json",
        &summary_payload,
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/normalization.json",
        &serde_json::json!({
            "normalization": normalization_label(plan.normalization),
            "mode_count": summary_payload["mode_count"],
        }),
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/equilibrium_source.json",
        &equilibrium_source_json(&plan.equilibrium),
    )?);

    if wants_dispersion {
        let visualizable_mode_indices = requested_modes
            .iter()
            .copied()
            .map(u64::from)
            .collect::<BTreeSet<_>>();
        let k_vector = k_vector_json(plan.k_sampling.as_ref());
        auxiliary_artifacts.push(json_artifact(
            "eigen/dispersion/path.json",
            &serde_json::json!({
                "sampling": plan.k_sampling,
                "k_vector": k_vector,
            }),
        )?);
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion/branch_table.csv".to_string(),
            bytes: dispersion_csv(plan.k_sampling.as_ref(), &summary_payload["modes"]).into_bytes(),
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(
                plan.k_sampling.as_ref(),
                &summary_payload["modes"],
                &visualizable_mode_indices,
            )
            .into_bytes(),
        });
    }
    write_eigen_v2_bundle(
        plan,
        &summary_payload,
        &requested_modes,
        &mut auxiliary_artifacts,
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
            solver_kind: progress_solver_kind,
            active_nodes: active_n,
            effective_dof,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: total_modes,
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
            final_magnetization: equilibrium.clone(),
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
        provenance: execution_provenance(plan, try_gpu),
    })
}
