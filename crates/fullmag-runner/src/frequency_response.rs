use crate::eigen::solve_and_write_field_driven_response_sweep_bundle_with_interrupt;
#[cfg(any(feature = "fem-gpu", test))]
use crate::native_fem::NativeFrequencyDomainProgress;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{
    solve_native_driven_frequency_response, NativeDrivenFrequencyResponseDmiElement,
    NativeDrivenFrequencyResponseDmiKind, NativeDrivenFrequencyResponseExchangeEdge,
    NativeDrivenFrequencyResponseFloquetPeriodicPair,
    NativeDrivenFrequencyResponseMfemOperatorProblem,
    NativeDrivenFrequencyResponsePeriodicNodePair, NativeDrivenFrequencyResponseRequest,
    NativeFrequencyDomainExecutionLane, NativeFrequencyDomainStatus,
};
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{
    NativeFrequencyDomainCancelCallback, NativeFrequencyDomainProgressCallback,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, RunError, RunResult, RunStatus, StepAction, StepStats,
    StepUpdate,
};
use nalgebra::{DMatrix, DVector};
use num_complex::Complex64;
#[cfg(feature = "fem-gpu")]
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) fn execute_fem_frequency_response_validation(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
    output_dir: &Path,
    interrupt_requested: Option<&AtomicBool>,
    on_step: Option<&mut dyn FnMut(StepUpdate) -> StepAction>,
) -> Result<ExecutedRun, RunError> {
    let mut on_step = on_step;
    #[cfg(not(feature = "fem-gpu"))]
    let _ = &on_step;

    if plan.frequencies_hz.values_hz.is_empty() {
        return Err(RunError {
            message: "FEM frequency response requires at least one frequency point".to_string(),
        });
    }
    if plan
        .frequencies_hz
        .values_hz
        .iter()
        .any(|frequency| !frequency.is_finite() || *frequency <= 0.0)
    {
        return Err(RunError {
            message: "FEM frequency response frequencies must be finite and positive".to_string(),
        });
    }
    #[cfg(feature = "fem-gpu")]
    if let Some(executed) = try_execute_fem_frequency_response_native_production_cpu(
        plan,
        output_dir,
        interrupt_requested,
        &mut on_step,
    )? {
        return Ok(executed);
    }
    #[cfg(not(feature = "fem-gpu"))]
    if plan.magnetostatic_bc == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0 {
        return Err(RunError {
            message: "FEM frequency response magnetostatic_bc=periodic_airbox_k0 requires the native FEM production CPU frequency-domain solver; dense validation fallback is disabled because it would not solve the requested coupled delta_m/delta_phi operator.".to_string(),
        });
    }
    if let Some(reason) = production_cpu_frequency_response_rejection_reason(plan) {
        return Err(RunError {
            message: format!(
                "FEM frequency response requested physics is not executable by the current production CPU frequency-domain solver: {reason}. \
                 Dense validation fallback is disabled for this case because it would not solve the requested operator."
            ),
        });
    }

    let dimension = plan.equilibrium_magnetization.len().max(1);
    let stiffness_scale = validation_stiffness_scale(plan);
    let damping_scale = plan
        .material
        .damping
        .is_finite()
        .then_some(plan.material.damping.abs().max(1.0e-6))
        .unwrap_or(1.0e-3);
    let template = crate::eigen::BlockRealHarmonicTemplate {
        stiffness: DMatrix::identity(dimension, dimension) * stiffness_scale,
        mass: DMatrix::identity(dimension, dimension),
        damping: Some(DMatrix::identity(dimension, dimension) * damping_scale),
    };
    let drive_norm = plan
        .excitation
        .field_au_per_m
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt();
    if !drive_norm.is_finite() || drive_norm <= 0.0 {
        return Err(RunError {
            message: "FEM frequency response excitation field must be finite and non-zero"
                .to_string(),
        });
    }
    let excitation_phase = Complex64::new(
        plan.excitation.phase_rad.cos(),
        plan.excitation.phase_rad.sin(),
    );
    let field_excitation = DVector::from_element(dimension, excitation_phase * drive_norm);
    let frequencies_rad_per_s = plan
        .frequencies_hz
        .values_hz
        .iter()
        .map(|frequency_hz| frequency_hz * 2.0 * std::f64::consts::PI)
        .collect::<Vec<_>>();

    let mut stop_requested = false;
    let artifact = solve_and_write_field_driven_response_sweep_bundle_with_interrupt(
        output_dir,
        &template,
        &frequencies_rad_per_s,
        &field_excitation,
        |completed_points| {
            if completed_points > 0 {
                if let Some(on_step) = on_step.as_deref_mut() {
                    let action = on_step(dense_frequency_response_progress_update(
                        completed_points as u64,
                        drive_norm,
                    ));
                    if action != StepAction::Continue {
                        stop_requested = true;
                    }
                }
            }
            interrupt_requested.is_some_and(|flag| flag.load(Ordering::Relaxed)) || stop_requested
        },
        "runner.dense_block_real_validation",
        "dense_block_real_lu",
        "gilbert_linear_validation",
        "fem_frequency_response_validation",
    )
    .map_err(|message| RunError { message })?;
    let interrupted = artifact.points.len() < plan.frequencies_hz.values_hz.len();

    Ok(ExecutedRun {
        result: RunResult {
            status: if interrupted {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps: vec![StepStats {
                step: artifact.points.len() as u64,
                time: 0.0,
                dt: 0.0,
                max_h_eff: drive_norm,
                ..StepStats::default()
            }],
            final_magnetization: plan.equilibrium_magnetization.clone(),
            completion: Some(crate::relaxation::infer_stage_completion(
                if interrupted {
                    RunStatus::Cancelled
                } else {
                    RunStatus::Completed
                },
                None,
                &[],
                0.0,
                0.0,
                false,
            )),
        },
        initial_magnetization: plan.equilibrium_magnetization.clone(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts: Vec::new(),
        provenance: ExecutionProvenance {
            execution_engine: "runner.dense_block_real_validation".to_string(),
            precision: "double".to_string(),
            demag_operator_kind: plan
                .enable_demag
                .then(|| "frequency_domain_validation_demag_contract".to_string()),
            ..ExecutionProvenance::default()
        },
    })
}

fn dense_frequency_response_progress_update(
    completed_frequency_count: u64,
    drive_norm: f64,
) -> StepUpdate {
    StepUpdate {
        stats: StepStats {
            step: completed_frequency_count,
            time: 0.0,
            dt: 0.0,
            max_h_eff: drive_norm,
            ..StepStats::default()
        },
        grid: [0, 0, 0],
        fem_mesh: None,
        magnetization: None,
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: true,
        finished: false,
    }
}

#[cfg(any(feature = "fem-gpu", test))]
fn native_frequency_response_progress_update(
    progress: NativeFrequencyDomainProgress,
    drive_norm: f64,
) -> StepUpdate {
    StepUpdate {
        stats: StepStats {
            step: progress.completed_frequency_count,
            time: 0.0,
            dt: 0.0,
            max_h_eff: drive_norm,
            ..StepStats::default()
        },
        grid: [0, 0, 0],
        fem_mesh: None,
        magnetization: None,
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: true,
        finished: false,
    }
}

#[cfg(feature = "fem-gpu")]
fn try_execute_fem_frequency_response_native_production_cpu(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
    output_dir: &Path,
    interrupt_requested: Option<&AtomicBool>,
    on_step: &mut Option<&mut dyn FnMut(StepUpdate) -> StepAction>,
) -> Result<Option<ExecutedRun>, RunError> {
    let requested_gpu = plan.requested_device == fullmag_ir::ExecutionDevice::Gpu;
    if requested_gpu {
        if let Some(reason) = production_gpu_frequency_response_rejection_reason(plan) {
            return Err(RunError {
                message: format!(
                    "FEM frequency response requested production GPU execution, but the current native GPU frequency-domain slice is unavailable: {reason}. Dense validation and CPU fallback are disabled for forced GPU frequency response."
                ),
            });
        }
    }
    let Some(payload) = (if requested_gpu {
        build_native_production_gpu_payload(plan)
    } else {
        build_native_production_cpu_payload(plan)
    }) else {
        if has_requested_dmi(plan) {
            return Err(RunError {
                message: "FEM frequency response DMI requires a valid first-order tetrahedral magnetic mesh, finite DMI constants, and positive Ms for production CPU execution".to_string(),
            });
        }
        return Ok(None);
    };
    let execution_lane = if requested_gpu {
        NativeFrequencyDomainExecutionLane::ProductionGpu
    } else {
        NativeFrequencyDomainExecutionLane::ProductionCpu
    };
    let node_count = plan.equilibrium_magnetization.len() as u64;
    let tangent_dof_count = node_count * 2;
    let stop_requested = AtomicBool::new(false);
    let cancel_callback = || {
        interrupt_requested.is_some_and(|flag| flag.load(Ordering::Relaxed))
            || stop_requested.load(Ordering::Relaxed)
    };
    let live_progress_sink = RefCell::new(on_step.as_deref_mut());
    let progress_callback = |progress: NativeFrequencyDomainProgress| {
        if let Some(on_step) = live_progress_sink.borrow_mut().as_deref_mut() {
            let action = on_step(native_frequency_response_progress_update(
                progress,
                payload.drive_norm,
            ));
            if action != StepAction::Continue {
                stop_requested.store(true, Ordering::Relaxed);
            }
        }
    };
    let cancel_callback_ref: Option<&NativeFrequencyDomainCancelCallback<'_>> =
        Some(&cancel_callback);
    let progress_callback_ref: Option<&NativeFrequencyDomainProgressCallback<'_>> =
        if live_progress_sink.borrow().is_some() {
            Some(&progress_callback)
        } else {
            None
        };
    let floquet_periodic_pairs = payload
        .floquet_periodic_pairs
        .iter()
        .map(|pair| NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some(pair.pair_id.as_str()),
            node_a: pair.node_a,
            node_b: pair.node_b,
            translation_m: Some(pair.translation_m),
            phase_rad: Some(pair.phase_rad),
        })
        .collect::<Vec<_>>();
    let native_result =
        solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count,
            tangent_dof_count,
            alpha: payload.alpha_uniform,
            gamma0: plan.gyromagnetic_ratio,
            execution_lane,
            frequencies_hz: &plan.frequencies_hz.values_hz,
            output_directory: output_dir,
            write_response_fields: true,
            write_partial_artifacts: true,
            interrupt_requested: None,
            cancel_requested: cancel_callback_ref,
            progress_callback: progress_callback_ref,
            requires_periodic_airbox_dynamic_demag: payload.requires_periodic_airbox_dynamic_demag,
            magnetic_periodic_constraint_set_count: payload.magnetic_periodic_constraint_set_count,
            magnetostatic_periodic_constraint_set_count: payload
                .magnetostatic_periodic_constraint_set_count,
            periodic_airbox_delta_m_tangent_dof_count: payload
                .periodic_airbox_delta_m_tangent_dof_count,
            periodic_airbox_delta_phi_dof_count: payload.periodic_airbox_delta_phi_dof_count,
            periodic_airbox_magnetostatic_periodic_node_pairs: &payload
                .periodic_airbox_magnetostatic_periodic_node_pairs,
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &plan.equilibrium_magnetization,
                h_ext_a_per_m: &payload.h_ext_a_per_m,
                uniaxial_anisotropy_axis: payload.uniaxial_anisotropy_axis.as_ref(),
                uniaxial_anisotropy_field_a_per_m: payload.uniaxial_anisotropy_field_a_per_m,
                alpha_per_node: payload.alpha_per_node.as_deref(),
                drive_real: &payload.drive_tangent_real,
                drive_imag: Some(&payload.drive_tangent_imag),
                exchange_edges: &payload.exchange_edges,
                dmi_elements: &payload.dmi_elements,
                dmi_lumped_mass: payload.dmi_lumped_mass.as_deref(),
                dmi_ms_field: payload.dmi_ms_field.as_deref(),
                dmi_uniform_ms: payload.dmi_uniform_ms,
                include_zeeman: true,
                static_periodic_node_pairs: &payload.static_periodic_node_pairs,
                floquet_k_vector_rad_per_m: payload.floquet_k_vector_rad_per_m,
                phase_convention: crate::native_fem::FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &floquet_periodic_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        });
    let native_result = native_result.map_err(|message| RunError {
        message: format!(
            "native FEM production {} frequency response is required for this plan but could not be invoked: {message}",
            if requested_gpu { "GPU" } else { "CPU" }
        ),
    })?;
    match native_result.status {
        NativeFrequencyDomainStatus::Ok | NativeFrequencyDomainStatus::Interrupted => {
            let cancelled = native_result.status == NativeFrequencyDomainStatus::Interrupted;
            let status = if cancelled {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            };
            Ok(Some(ExecutedRun {
                result: RunResult {
                    status,
                    steps: vec![StepStats {
                        step: native_result.completed_frequency_count,
                        time: 0.0,
                        dt: 0.0,
                        max_h_eff: payload.drive_norm,
                        ..StepStats::default()
                    }],
                    final_magnetization: plan.equilibrium_magnetization.clone(),
                    completion: Some(crate::relaxation::infer_stage_completion(
                        status,
                        None,
                        &[],
                        0.0,
                        0.0,
                        false,
                    )),
                },
                initial_magnetization: plan.equilibrium_magnetization.clone(),
                field_snapshots: Vec::new(),
                field_snapshot_count: 0,
                auxiliary_artifacts: Vec::new(),
                provenance: ExecutionProvenance {
                    execution_engine: if requested_gpu {
                        "native_fem.frequency_domain.production_gpu".to_string()
                    } else {
                        "native_fem.frequency_domain.production_cpu".to_string()
                    },
                    precision: "double".to_string(),
                    demag_operator_kind: None,
                    ..ExecutionProvenance::default()
                },
            }))
        }
        NativeFrequencyDomainStatus::Unavailable => Err(RunError {
            message: native_frequency_response_failure_message(
                if requested_gpu {
                    "native FEM production GPU frequency response is unavailable for a supported production slice"
                } else {
                    "native FEM production CPU frequency response is unavailable for a supported production slice"
                },
                native_result.status,
                &native_result.error_message,
                &native_result.diagnostics_json,
                &native_result.result_json,
            ),
        }),
        NativeFrequencyDomainStatus::ValidationError
        | NativeFrequencyDomainStatus::OperatorError
        | NativeFrequencyDomainStatus::SolveError
        | NativeFrequencyDomainStatus::ArtifactError => Err(RunError {
            message: native_frequency_response_failure_message(
                if requested_gpu {
                    "native FEM production GPU frequency response failed"
                } else {
                    "native FEM production CPU frequency response failed"
                },
                native_result.status,
                &native_result.error_message,
                &native_result.diagnostics_json,
                &native_result.result_json,
            ),
        }),
    }
}

#[cfg(feature = "fem-gpu")]
fn native_frequency_response_failure_message(
    prefix: &str,
    status: NativeFrequencyDomainStatus,
    error_message: &str,
    diagnostics_json: &str,
    result_json: &str,
) -> String {
    let native_status = native_frequency_domain_status_label(status);
    let diagnostics_status = frequency_domain_json_status(diagnostics_json);
    let result_status = frequency_domain_json_status(result_json);
    let mut details = format!("{prefix}: native_status={native_status}");
    if let Some(status) = diagnostics_status.as_deref() {
        details.push_str(", diagnostics_status=");
        details.push_str(status);
    }
    if let Some(status) = result_status.as_deref() {
        details.push_str(", result_status=");
        details.push_str(status);
    }
    if !error_message.is_empty() {
        details.push_str(": ");
        details.push_str(error_message);
    }
    details
}

#[cfg(feature = "fem-gpu")]
fn native_frequency_domain_status_label(status: NativeFrequencyDomainStatus) -> &'static str {
    match status {
        NativeFrequencyDomainStatus::Ok => "ok",
        NativeFrequencyDomainStatus::Unavailable => "unavailable",
        NativeFrequencyDomainStatus::ValidationError => "validation_error",
        NativeFrequencyDomainStatus::OperatorError => "operator_error",
        NativeFrequencyDomainStatus::SolveError => "solve_error",
        NativeFrequencyDomainStatus::ArtifactError => "artifact_error",
        NativeFrequencyDomainStatus::Interrupted => "interrupted",
    }
}

#[cfg(feature = "fem-gpu")]
fn frequency_domain_json_status(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|value| {
            value
                .get("status")
                .and_then(|status| status.as_str())
                .map(str::to_string)
        })
}

#[cfg(feature = "fem-gpu")]
struct NativeProductionCpuPayload {
    h_ext_a_per_m: [f64; 3],
    uniaxial_anisotropy_axis: Option<[f64; 3]>,
    uniaxial_anisotropy_field_a_per_m: f64,
    alpha_uniform: f64,
    alpha_per_node: Option<Vec<f64>>,
    drive_tangent_real: Vec<f64>,
    drive_tangent_imag: Vec<f64>,
    exchange_edges: Vec<NativeDrivenFrequencyResponseExchangeEdge>,
    dmi_elements: Vec<NativeDrivenFrequencyResponseDmiElement>,
    dmi_lumped_mass: Option<Vec<f64>>,
    dmi_ms_field: Option<Vec<f64>>,
    dmi_uniform_ms: f64,
    drive_norm: f64,
    static_periodic_node_pairs: Vec<NativeDrivenFrequencyResponsePeriodicNodePair>,
    floquet_k_vector_rad_per_m: Option<[f64; 3]>,
    floquet_periodic_pairs: Vec<FloquetPeriodicPairMetadata>,
    periodic_airbox_magnetostatic_periodic_node_pairs:
        Vec<NativeDrivenFrequencyResponsePeriodicNodePair>,
    requires_periodic_airbox_dynamic_demag: bool,
    magnetic_periodic_constraint_set_count: u64,
    magnetostatic_periodic_constraint_set_count: u64,
    periodic_airbox_delta_m_tangent_dof_count: u64,
    periodic_airbox_delta_phi_dof_count: u64,
}

#[cfg(any(feature = "fem-gpu", test))]
#[derive(Debug, Clone, PartialEq)]
struct FloquetPeriodicPairMetadata {
    pair_id: String,
    node_a: u64,
    node_b: u64,
    translation_m: [f64; 3],
    phase_rad: f64,
}

#[cfg(feature = "fem-gpu")]
fn build_native_production_cpu_payload(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<NativeProductionCpuPayload> {
    if production_cpu_frequency_response_rejection_reason(plan).is_some() {
        return None;
    }
    let h_ext_a_per_m = plan.external_field.unwrap_or([0.0, 0.0, 0.0]);
    if !h_ext_a_per_m.iter().all(|value| value.is_finite()) {
        return None;
    }
    if !plan.gyromagnetic_ratio.is_finite() || plan.gyromagnetic_ratio <= 0.0 {
        return None;
    }
    let (uniaxial_anisotropy_axis, uniaxial_anisotropy_field_a_per_m) =
        build_uniaxial_anisotropy_payload(plan)?;
    let (alpha_uniform, alpha_per_node) = build_damping_payload(plan)?;
    let excitation = plan.excitation.field_au_per_m;
    if !plan.excitation.phase_rad.is_finite() {
        return None;
    }
    let phase_cos = plan.excitation.phase_rad.cos();
    let phase_sin = plan.excitation.phase_rad.sin();
    let drive_norm = excitation
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt();
    if !drive_norm.is_finite() || drive_norm <= 0.0 {
        return None;
    }
    if plan.equilibrium_magnetization.is_empty() {
        return None;
    }
    let exchange_edges = if plan.enable_exchange {
        build_exchange_edges(plan)?
    } else {
        Vec::new()
    };
    let static_periodic_node_pairs = build_static_periodic_node_pairs(plan)?;
    let floquet_periodic_pairs = build_floquet_periodic_pairs(plan)?;
    let periodic_airbox_magnetostatic_periodic_node_pairs =
        build_periodic_airbox_magnetostatic_periodic_node_pairs(plan)?;
    let floquet_k_vector_rad_per_m = if frequency_response_effective_spin_wave_bc_kind(plan)
        == fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    {
        match plan.k_sampling.as_ref()? {
            fullmag_ir::KSamplingIR::Single { k_vector } => Some(*k_vector),
            fullmag_ir::KSamplingIR::Path { .. } => return None,
        }
    } else {
        None
    };
    let dmi_payload = build_dmi_payload(plan)?;
    let mut drive_tangent_real = Vec::with_capacity(plan.equilibrium_magnetization.len() * 2);
    let mut drive_tangent_imag = Vec::with_capacity(plan.equilibrium_magnetization.len() * 2);
    for m in &plan.equilibrium_magnetization {
        let (e1, e2) = tangent_basis(*m)?;
        let tangent_e1 = dot3(excitation, e1);
        let tangent_e2 = dot3(excitation, e2);
        drive_tangent_real.push(tangent_e1 * phase_cos);
        drive_tangent_real.push(tangent_e2 * phase_cos);
        drive_tangent_imag.push(tangent_e1 * phase_sin);
        drive_tangent_imag.push(tangent_e2 * phase_sin);
    }
    Some(NativeProductionCpuPayload {
        h_ext_a_per_m,
        uniaxial_anisotropy_axis,
        uniaxial_anisotropy_field_a_per_m,
        alpha_uniform,
        alpha_per_node,
        drive_tangent_real,
        drive_tangent_imag,
        exchange_edges,
        dmi_elements: dmi_payload.elements,
        dmi_lumped_mass: dmi_payload.lumped_mass,
        dmi_ms_field: dmi_payload.ms_field,
        dmi_uniform_ms: dmi_payload.uniform_ms,
        drive_norm,
        static_periodic_node_pairs,
        floquet_k_vector_rad_per_m,
        floquet_periodic_pairs,
        periodic_airbox_magnetostatic_periodic_node_pairs,
        requires_periodic_airbox_dynamic_demag: plan.magnetostatic_bc
            == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0,
        periodic_airbox_delta_m_tangent_dof_count: (plan.equilibrium_magnetization.len() * 2)
            as u64,
        periodic_airbox_delta_phi_dof_count: if plan.magnetostatic_bc
            == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0
        {
            plan.mesh.nodes.len() as u64
        } else {
            0
        },
        magnetic_periodic_constraint_set_count: plan
            .periodic_constraint_sets
            .iter()
            .filter(|constraint| {
                constraint.unknown_family
                    == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
            })
            .count() as u64,
        magnetostatic_periodic_constraint_set_count: plan
            .periodic_constraint_sets
            .iter()
            .filter(|constraint| {
                constraint.unknown_family
                    == fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic
            })
            .count() as u64,
    })
}

#[cfg(feature = "fem-gpu")]
fn build_native_production_gpu_payload(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<NativeProductionCpuPayload> {
    if production_gpu_frequency_response_rejection_reason(plan).is_some() {
        return None;
    }
    build_native_production_cpu_payload(plan)
}

fn production_cpu_frequency_response_rejection_reason(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<&'static str> {
    if plan.fe_order != 1 {
        return Some(
            "production CPU frequency response currently supports only first-order P1 tetrahedral FEM meshes",
        );
    }
    if plan.magnetostatic_bc == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0 {
        if plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir {
            return Some(
                "magnetostatic_bc=periodic_airbox_k0 requires a shared-domain airbox mesh",
            );
        }
        if !plan.enable_demag || plan.demag_realization.is_none() {
            return Some(
                "magnetostatic_bc=periodic_airbox_k0 requires include_demag=true and a Demag energy term",
            );
        }
        if !plan.periodic_constraint_sets.iter().any(|constraint| {
            constraint.unknown_family == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                && constraint.domain_scope == fullmag_ir::PeriodicDomainScopeIR::MagneticDomain
        }) {
            return Some(
                "magnetostatic_bc=periodic_airbox_k0 requires a delta_m periodic constraint set",
            );
        }
        if !plan.periodic_constraint_sets.iter().any(|constraint| {
            constraint.unknown_family
                == fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic
                && constraint.domain_scope
                    == fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir
        }) {
            return Some(
                "magnetostatic_bc=periodic_airbox_k0 requires a delta_phi periodic constraint set",
            );
        }
    } else {
        if plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh {
            return Some(
                "production CPU frequency response currently supports only magnetic-body meshes without shared-domain airbox elements",
            );
        }
        if plan.enable_demag || plan.demag_realization.is_some() {
            return Some("dynamic demag is not implemented for production CPU frequency response");
        }
    }
    #[cfg(not(feature = "fem-gpu"))]
    if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
        return Some(
            "DMI frequency response requires the native FEM production CPU solver to be enabled",
        );
    }
    if !plan
        .k_sampling
        .as_ref()
        .is_none_or(fullmag_ir::KSamplingIR::is_single_gamma)
    {
        return Some(
            "nonzero-k Floquet/Bloch response is not implemented for production CPU frequency response",
        );
    }
    match frequency_response_effective_spin_wave_bc_kind(plan) {
        fullmag_ir::SpinWaveBoundaryKindIR::Free => {}
        fullmag_ir::SpinWaveBoundaryKindIR::Periodic => {
            if let Some(reason) = static_periodic_frequency_response_rejection_reason(plan) {
                return Some(reason);
            }
        }
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet => {
            return Some(
                "nonzero-k Floquet/Bloch response is not implemented for production CPU frequency response",
            );
        }
        _ => {
            return Some(
                "the requested spin-wave boundary condition is not enforced by the production CPU frequency response operator",
            );
        }
    }
    None
}

#[cfg(any(feature = "fem-gpu", test))]
fn production_gpu_frequency_response_rejection_reason(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<&'static str> {
    if plan.fe_order != 1 {
        return Some(
            "production GPU frequency response currently supports only first-order P1 tetrahedral FEM meshes",
        );
    }
    if plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh {
        return Some(
            "production GPU frequency response currently supports only magnetic-body meshes without shared-domain airbox elements",
        );
    }
    if plan.enable_demag || plan.demag_realization.is_some() {
        return Some("dynamic demag is not implemented for production GPU frequency response");
    }
    if has_requested_dmi(plan) {
        return Some("DMI is not implemented for production GPU frequency response");
    }
    if !plan
        .k_sampling
        .as_ref()
        .is_none_or(fullmag_ir::KSamplingIR::is_single_gamma)
    {
        return Some(
            "nonzero-k Floquet/Bloch response is not implemented for production GPU frequency response",
        );
    }
    match frequency_response_effective_spin_wave_bc_kind(plan) {
        fullmag_ir::SpinWaveBoundaryKindIR::Free => {}
        fullmag_ir::SpinWaveBoundaryKindIR::Periodic => {
            if let Some(reason) = static_periodic_frequency_response_rejection_reason(plan) {
                return Some(reason);
            }
        }
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet => {
            return Some(
                "nonzero-k Floquet/Bloch response is not implemented for production GPU frequency response",
            );
        }
        _ => {
            return Some(
                "the requested spin-wave boundary condition is not enforced by the production GPU frequency response operator",
            );
        }
    }
    None
}

fn static_periodic_frequency_response_rejection_reason(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<&'static str> {
    if plan.mesh.periodic_boundary_pairs.is_empty() {
        return Some(
            "static periodic frequency response requires mesh.periodic_boundary_pairs metadata with translations",
        );
    }
    if plan.mesh.periodic_node_pairs.is_empty() {
        return Some(
            "static periodic frequency response requires mesh.periodic_node_pairs metadata",
        );
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let selected_boundary_pair_ids = if requested_pair_ids.is_empty() {
        plan.mesh
            .periodic_boundary_pairs
            .iter()
            .map(|pair| pair.pair_id.as_str())
            .collect::<Vec<_>>()
    } else {
        requested_pair_ids
    };
    if selected_boundary_pair_ids.is_empty() {
        return Some("static periodic frequency response did not select any boundary pairs");
    }

    let boundary_pair_ids = plan
        .mesh
        .periodic_boundary_pairs
        .iter()
        .map(|pair| pair.pair_id.as_str())
        .collect::<BTreeSet<_>>();
    if boundary_pair_ids.len() != plan.mesh.periodic_boundary_pairs.len()
        || boundary_pair_ids.contains("")
    {
        return Some(
            "static periodic frequency response requires unique non-empty periodic boundary pair ids",
        );
    }
    for pair_id in &selected_boundary_pair_ids {
        if !boundary_pair_ids.contains(pair_id) {
            return Some(
                "static periodic frequency response requested an unknown periodic boundary pair",
            );
        }
        let Some(boundary_pair) = plan
            .mesh
            .periodic_boundary_pairs
            .iter()
            .find(|pair| pair.pair_id == *pair_id)
        else {
            return Some(
                "static periodic frequency response requested an unknown periodic boundary pair",
            );
        };
        let Some(translation) = boundary_pair.translation else {
            return Some(
                "static periodic frequency response requires periodic boundary pair translations",
            );
        };
        if !translation.iter().all(|value| value.is_finite()) {
            return Some(
                "static periodic frequency response requires finite periodic boundary pair translations",
            );
        }
    }

    let selected_pair_ids = selected_boundary_pair_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let mut source_nodes = BTreeSet::new();
    let mut destination_nodes = BTreeSet::new();
    let mut selected_node_pair_count = 0usize;
    for pair in &plan.mesh.periodic_node_pairs {
        if !selected_pair_ids.contains(pair.pair_id.as_str()) {
            continue;
        }
        selected_node_pair_count += 1;
        if pair.node_a as usize >= plan.mesh.nodes.len()
            || pair.node_b as usize >= plan.mesh.nodes.len()
            || pair.node_a == pair.node_b
        {
            return Some(
                "static periodic frequency response requires valid periodic node pair indices",
            );
        }
        let Some(boundary_pair) = plan
            .mesh
            .periodic_boundary_pairs
            .iter()
            .find(|boundary_pair| boundary_pair.pair_id == pair.pair_id)
        else {
            return Some(
                "static periodic frequency response requires periodic node pairs to reference known boundary pair ids",
            );
        };
        let Some(translation) = boundary_pair.translation else {
            return Some(
                "static periodic frequency response requires periodic boundary pair translations",
            );
        };
        let src = plan.mesh.nodes[pair.node_a as usize];
        let dst = plan.mesh.nodes[pair.node_b as usize];
        let residual = [
            dst[0] - src[0] - translation[0],
            dst[1] - src[1] - translation[1],
            dst[2] - src[2] - translation[2],
        ];
        let residual_norm =
            (residual[0] * residual[0] + residual[1] * residual[1] + residual[2] * residual[2])
                .sqrt();
        let tolerance = boundary_pair.tolerance.unwrap_or(1.0e-9).max(0.0);
        if !residual_norm.is_finite() || residual_norm > tolerance {
            return Some(
                "static periodic frequency response requires node-pair translations within tolerance",
            );
        }
        if !source_nodes.insert((pair.pair_id.as_str(), pair.node_a)) {
            return Some(
                "static periodic frequency response rejects duplicate periodic source nodes",
            );
        }
        if !destination_nodes.insert((pair.pair_id.as_str(), pair.node_b)) {
            return Some(
                "static periodic frequency response rejects duplicate periodic destination nodes",
            );
        }
    }
    if selected_node_pair_count == 0 {
        return Some(
            "static periodic frequency response did not match any mesh.periodic_node_pairs pair_id",
        );
    }
    None
}

fn frequency_response_effective_spin_wave_bc_kind(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> fullmag_ir::SpinWaveBoundaryKindIR {
    if plan.spin_wave_bc.kind() == fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        && plan
            .k_sampling
            .as_ref()
            .is_none_or(fullmag_ir::KSamplingIR::is_single_gamma)
    {
        fullmag_ir::SpinWaveBoundaryKindIR::Periodic
    } else {
        plan.spin_wave_bc.kind()
    }
}

#[cfg(feature = "fem-gpu")]
fn build_static_periodic_node_pairs(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<Vec<NativeDrivenFrequencyResponsePeriodicNodePair>> {
    if frequency_response_effective_spin_wave_bc_kind(plan)
        != fullmag_ir::SpinWaveBoundaryKindIR::Periodic
    {
        return Some(Vec::new());
    }
    let node_count = plan.equilibrium_magnetization.len();
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let mut pairs = Vec::new();
    for pair in &plan.mesh.periodic_node_pairs {
        if !requested_pair_ids.is_empty() && !requested_pair_ids.contains(&pair.pair_id.as_str()) {
            continue;
        }
        if pair.node_a as usize >= node_count
            || pair.node_b as usize >= node_count
            || pair.node_a == pair.node_b
        {
            return None;
        }
        pairs.push(NativeDrivenFrequencyResponsePeriodicNodePair {
            node_a: pair.node_a as u64,
            node_b: pair.node_b as u64,
        });
    }
    if pairs.is_empty() {
        return None;
    }
    Some(pairs)
}

#[cfg(feature = "fem-gpu")]
fn build_periodic_airbox_magnetostatic_periodic_node_pairs(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<Vec<NativeDrivenFrequencyResponsePeriodicNodePair>> {
    if plan.magnetostatic_bc != fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0 {
        return Some(Vec::new());
    }
    let constraint_set = plan.periodic_constraint_sets.iter().find(|constraint| {
        constraint.unknown_family
            == fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic
            && constraint.domain_scope
                == fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir
    })?;
    let node_count = plan.mesh.nodes.len();
    let mut pairs = Vec::new();
    for pair in &plan.mesh.periodic_node_pairs {
        if !constraint_set.pair_ids.is_empty() && !constraint_set.pair_ids.contains(&pair.pair_id) {
            continue;
        }
        if pair.node_a as usize >= node_count
            || pair.node_b as usize >= node_count
            || pair.node_a == pair.node_b
        {
            return None;
        }
        pairs.push(NativeDrivenFrequencyResponsePeriodicNodePair {
            node_a: pair.node_a as u64,
            node_b: pair.node_b as u64,
        });
    }
    if pairs.is_empty() {
        return None;
    }
    Some(pairs)
}

#[cfg(any(feature = "fem-gpu", test))]
fn build_floquet_periodic_pairs(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<Vec<FloquetPeriodicPairMetadata>> {
    if frequency_response_effective_spin_wave_bc_kind(plan)
        != fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    {
        return Some(Vec::new());
    }
    let k_vector = match plan.k_sampling.as_ref()? {
        fullmag_ir::KSamplingIR::Single { k_vector } => *k_vector,
        fullmag_ir::KSamplingIR::Path { .. } => return None,
    };
    if !k_vector.iter().all(|value| value.is_finite()) {
        return None;
    }

    let node_count = plan.equilibrium_magnetization.len();
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let mut pairs = Vec::new();
    for pair in &plan.mesh.periodic_node_pairs {
        if !requested_pair_ids.is_empty() && !requested_pair_ids.contains(&pair.pair_id.as_str()) {
            continue;
        }
        if pair.node_a as usize >= node_count
            || pair.node_b as usize >= node_count
            || pair.node_a == pair.node_b
        {
            return None;
        }
        let boundary_pair = plan
            .mesh
            .periodic_boundary_pairs
            .iter()
            .find(|boundary_pair| boundary_pair.pair_id == pair.pair_id)?;
        let translation_m = boundary_pair.translation?;
        if !translation_m.iter().all(|value| value.is_finite()) {
            return None;
        }
        let phase_rad = match plan.spin_wave_bc.phase_convention() {
            fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR => {
                -(k_vector[0] * translation_m[0]
                    + k_vector[1] * translation_m[1]
                    + k_vector[2] * translation_m[2])
            }
        };
        pairs.push(FloquetPeriodicPairMetadata {
            pair_id: pair.pair_id.clone(),
            node_a: pair.node_a as u64,
            node_b: pair.node_b as u64,
            translation_m,
            phase_rad,
        });
    }
    if pairs.is_empty() {
        return None;
    }
    Some(pairs)
}

#[cfg(feature = "fem-gpu")]
fn build_damping_payload(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<(f64, Option<Vec<f64>>)> {
    if plan.damping_policy == fullmag_ir::EigenDampingPolicyIR::Ignore {
        return Some((0.0, None));
    }
    let alpha = plan.material.damping;
    if !(alpha >= 0.0) || !alpha.is_finite() {
        return None;
    }
    let Some(alpha_field) = plan.material.alpha_field.as_ref() else {
        return Some((alpha, None));
    };
    if alpha_field.len() != plan.equilibrium_magnetization.len() {
        return None;
    }
    if alpha_field
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        return None;
    }
    Some((0.0, Some(alpha_field.clone())))
}

#[cfg(feature = "fem-gpu")]
fn build_uniaxial_anisotropy_payload(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<(Option<[f64; 3]>, f64)> {
    let material = &plan.material;
    if material
        .uniaxial_anisotropy_k2
        .is_some_and(|value| value.abs() > 1.0e-30)
        || material
            .cubic_anisotropy_kc1
            .is_some_and(|value| value.abs() > 1.0e-30)
        || material
            .cubic_anisotropy_kc2
            .is_some_and(|value| value.abs() > 1.0e-30)
        || material
            .cubic_anisotropy_kc3
            .is_some_and(|value| value.abs() > 1.0e-30)
        || material.ku_field.is_some()
        || material.ku2_field.is_some()
        || material.kc1_field.is_some()
        || material.kc2_field.is_some()
        || material.kc3_field.is_some()
    {
        return None;
    }
    let ku1 = material.uniaxial_anisotropy.unwrap_or(0.0);
    if ku1.abs() <= 1.0e-30 {
        return Some((None, 0.0));
    }
    if !ku1.is_finite() || !material.saturation_magnetisation.is_finite() {
        return None;
    }
    if material.saturation_magnetisation <= 0.0 {
        return None;
    }
    let axis = normalize3(material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]))?;
    let field_a_per_m =
        2.0 * ku1 / (4.0 * std::f64::consts::PI * 1.0e-7) / material.saturation_magnetisation;
    if !field_a_per_m.is_finite() {
        return None;
    }
    Some((Some(axis), field_a_per_m))
}

#[cfg(feature = "fem-gpu")]
struct DmiPayload {
    elements: Vec<NativeDrivenFrequencyResponseDmiElement>,
    lumped_mass: Option<Vec<f64>>,
    ms_field: Option<Vec<f64>>,
    uniform_ms: f64,
}

#[cfg(feature = "fem-gpu")]
fn build_dmi_payload(plan: &fullmag_ir::FemFrequencyResponsePlanIR) -> Option<DmiPayload> {
    if plan.interfacial_dmi.is_some_and(|value| !value.is_finite())
        || plan.bulk_dmi.is_some_and(|value| !value.is_finite())
    {
        return None;
    }
    if !has_active_dmi(plan) {
        return Some(DmiPayload {
            elements: Vec::new(),
            lumped_mass: None,
            ms_field: None,
            uniform_ms: 0.0,
        });
    }
    if plan.mesh.nodes.len() != plan.equilibrium_magnetization.len()
        || plan.mesh.elements.is_empty()
    {
        return None;
    }
    if !plan.material.saturation_magnetisation.is_finite()
        || plan.material.saturation_magnetisation <= 0.0
    {
        return None;
    }
    let ms_field = match plan.material.ms_field.as_ref() {
        Some(values) => {
            if values.len() != plan.equilibrium_magnetization.len()
                || values
                    .iter()
                    .any(|value| !value.is_finite() || *value <= 0.0)
            {
                return None;
            }
            Some(values.clone())
        }
        None => None,
    };
    if !plan.mesh.element_markers.is_empty()
        && plan.mesh.element_markers.len() != plan.mesh.elements.len()
    {
        return None;
    }

    let interfacial_dmi = finite_nonzero(plan.interfacial_dmi);
    let bulk_dmi = finite_nonzero(plan.bulk_dmi);
    let interfacial_normal = if interfacial_dmi.is_some() {
        normalize3(plan.dmi_interface_normal.unwrap_or([0.0, 0.0, 1.0]))?
    } else {
        [0.0, 0.0, 1.0]
    };
    let node_count = plan.equilibrium_magnetization.len();
    let mut lumped_mass = vec![0.0; node_count];
    let mut elements = Vec::new();

    for (element_index, element) in plan.mesh.elements.iter().enumerate() {
        if plan
            .mesh
            .element_markers
            .get(element_index)
            .is_some_and(|marker| *marker == 0)
        {
            continue;
        }
        let geometry = tetra_p1_geometry(&plan.mesh.nodes, *element)?;
        for node in element {
            let node_index = *node as usize;
            if node_index >= node_count {
                return None;
            }
            lumped_mass[node_index] += geometry.volume * 0.25;
        }
        if let Some(d) = interfacial_dmi {
            elements.push(NativeDrivenFrequencyResponseDmiElement {
                kind: NativeDrivenFrequencyResponseDmiKind::Interfacial,
                node_indices: *element,
                shape: [0.25, 0.25, 0.25, 0.25],
                grad_shape: geometry.grad_shape,
                weight: geometry.volume,
                d,
                normal: interfacial_normal,
            });
        }
        if let Some(d) = bulk_dmi {
            elements.push(NativeDrivenFrequencyResponseDmiElement {
                kind: NativeDrivenFrequencyResponseDmiKind::Bulk,
                node_indices: *element,
                shape: [0.25, 0.25, 0.25, 0.25],
                grad_shape: geometry.grad_shape,
                weight: geometry.volume,
                d,
                normal: [0.0, 0.0, 1.0],
            });
        }
    }
    if elements.is_empty()
        || lumped_mass
            .iter()
            .any(|mass| !mass.is_finite() || *mass <= 0.0)
    {
        return None;
    }
    Some(DmiPayload {
        elements,
        lumped_mass: Some(lumped_mass),
        ms_field,
        uniform_ms: plan.material.saturation_magnetisation,
    })
}

#[cfg(feature = "fem-gpu")]
fn has_active_dmi(plan: &fullmag_ir::FemFrequencyResponsePlanIR) -> bool {
    finite_nonzero(plan.interfacial_dmi).is_some() || finite_nonzero(plan.bulk_dmi).is_some()
}

#[cfg(any(feature = "fem-gpu", test))]
fn has_requested_dmi(plan: &fullmag_ir::FemFrequencyResponsePlanIR) -> bool {
    plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some()
}

#[cfg(feature = "fem-gpu")]
fn finite_nonzero(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && value.abs() > 1.0e-30)
}

#[cfg(feature = "fem-gpu")]
struct TetraP1Geometry {
    volume: f64,
    grad_shape: [f64; 12],
}

#[cfg(feature = "fem-gpu")]
fn tetra_p1_geometry(nodes: &[[f64; 3]], element: [u32; 4]) -> Option<TetraP1Geometry> {
    let p0 = *nodes.get(element[0] as usize)?;
    let p1 = *nodes.get(element[1] as usize)?;
    let p2 = *nodes.get(element[2] as usize)?;
    let p3 = *nodes.get(element[3] as usize)?;
    let j = [
        [p1[0] - p0[0], p2[0] - p0[0], p3[0] - p0[0]],
        [p1[1] - p0[1], p2[1] - p0[1], p3[1] - p0[1]],
        [p1[2] - p0[2], p2[2] - p0[2], p3[2] - p0[2]],
    ];
    let det = det3(j);
    if !det.is_finite() || det.abs() <= 1.0e-30 {
        return None;
    }
    let inv = invert3(j, det)?;
    let grad1 = [inv[0][0], inv[0][1], inv[0][2]];
    let grad2 = [inv[1][0], inv[1][1], inv[1][2]];
    let grad3 = [inv[2][0], inv[2][1], inv[2][2]];
    let grad0 = [
        -grad1[0] - grad2[0] - grad3[0],
        -grad1[1] - grad2[1] - grad3[1],
        -grad1[2] - grad2[2] - grad3[2],
    ];
    Some(TetraP1Geometry {
        volume: det.abs() / 6.0,
        grad_shape: [
            grad0[0], grad0[1], grad0[2], grad1[0], grad1[1], grad1[2], grad2[0], grad2[1],
            grad2[2], grad3[0], grad3[1], grad3[2],
        ],
    })
}

#[cfg(feature = "fem-gpu")]
fn det3(m: [[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

#[cfg(feature = "fem-gpu")]
fn invert3(m: [[f64; 3]; 3], det: f64) -> Option<[[f64; 3]; 3]> {
    if !det.is_finite() || det.abs() <= 1.0e-30 {
        return None;
    }
    let inv_det = 1.0 / det;
    Some([
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ])
}

#[cfg(feature = "fem-gpu")]
fn build_exchange_edges(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<Vec<NativeDrivenFrequencyResponseExchangeEdge>> {
    if !plan.material.exchange_stiffness.is_finite() || plan.material.exchange_stiffness <= 0.0 {
        return None;
    }
    let node_count = plan.equilibrium_magnetization.len();
    if plan.mesh.nodes.len() != node_count {
        return None;
    }
    let mut pairs = std::collections::BTreeSet::<(usize, usize)>::new();
    for element in &plan.mesh.elements {
        for left in 0..element.len() {
            for right in (left + 1)..element.len() {
                let i = element[left] as usize;
                let j = element[right] as usize;
                if i >= node_count || j >= node_count || i == j {
                    return None;
                }
                pairs.insert(if i < j { (i, j) } else { (j, i) });
            }
        }
    }
    if pairs.is_empty() {
        return None;
    }
    Some(
        pairs
            .into_iter()
            .map(
                |(node_i, node_j)| NativeDrivenFrequencyResponseExchangeEdge {
                    node_i: node_i as u64,
                    node_j: node_j as u64,
                    stiffness: plan.material.exchange_stiffness,
                },
            )
            .collect(),
    )
}

#[cfg(feature = "fem-gpu")]
fn tangent_basis(m: [f64; 3]) -> Option<([f64; 3], [f64; 3])> {
    let norm = dot3(m, m).sqrt();
    if !norm.is_finite() || norm <= 0.0 || (norm - 1.0).abs() > 1.0e-8 {
        return None;
    }
    let m = [m[0] / norm, m[1] / norm, m[2] / norm];
    let reference = if m[2].abs() < 0.9 {
        [0.0, 0.0, 1.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let e1 = normalize3(cross3(reference, m))?;
    let e2 = normalize3(cross3(m, e1))?;
    Some((e1, e2))
}

#[cfg(feature = "fem-gpu")]
fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[cfg(feature = "fem-gpu")]
fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[cfg(feature = "fem-gpu")]
fn normalize3(v: [f64; 3]) -> Option<[f64; 3]> {
    let norm = dot3(v, v).sqrt();
    if !norm.is_finite() || norm <= 0.0 {
        None
    } else {
        Some([v[0] / norm, v[1] / norm, v[2] / norm])
    }
}

fn validation_stiffness_scale(plan: &fullmag_ir::FemFrequencyResponsePlanIR) -> f64 {
    let mut scale = 1.0;
    if plan.enable_exchange {
        scale += 1.0;
    }
    if plan.enable_demag {
        scale += 0.5;
    }
    if plan.external_field.is_some() {
        scale += 0.25;
    }
    if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
        scale += 0.25;
    }
    scale
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_frequency_response_progress_update_reports_completed_frequency_count() {
        let progress = NativeFrequencyDomainProgress {
            frequency_index: 1,
            completed_frequency_count: 2,
            total_frequency_count: 4,
            iteration_count: 17,
            frequency_hz: 2.0e9,
            residual_l2_norm: 1.0e-8,
            relative_residual_l2_norm: 2.0e-9,
            converged: true,
        };

        let update = native_frequency_response_progress_update(progress, 3.5);

        assert_eq!(update.stats.step, 2);
        assert_eq!(update.stats.max_h_eff, 3.5);
        assert_eq!(update.grid, [0, 0, 0]);
        assert!(!update.finished);
    }

    #[test]
    fn dense_validation_frequency_response_emits_live_progress_updates() {
        let mut plan = minimal_frequency_response_plan();
        plan.frequencies_hz.values_hz = vec![1.0e9, 2.0e9];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-dense-frequency-response-live-progress-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        let mut seen_steps = Vec::new();

        let executed = execute_fem_frequency_response_validation(
            &plan,
            &output_dir,
            None,
            Some(&mut |update| {
                seen_steps.push(update.stats.step);
                StepAction::Continue
            }),
        )
        .expect("dense validation response should run");

        assert_eq!(executed.result.status, RunStatus::Completed);
        assert_eq!(seen_steps, vec![1, 2]);
        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[test]
    fn dense_validation_frequency_response_live_stop_cancels_after_first_point() {
        let mut plan = minimal_frequency_response_plan();
        plan.frequencies_hz.values_hz = vec![1.0e9, 2.0e9, 3.0e9];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-dense-frequency-response-live-stop-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        let mut seen_steps = Vec::new();

        let executed = execute_fem_frequency_response_validation(
            &plan,
            &output_dir,
            None,
            Some(&mut |update| {
                seen_steps.push(update.stats.step);
                StepAction::Stop
            }),
        )
        .expect("dense validation response should cancel cleanly");

        assert_eq!(executed.result.status, RunStatus::Cancelled);
        assert_eq!(executed.result.steps[0].step, 1);
        assert_eq!(seen_steps, vec![1]);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(output_dir.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain manifest should be written"),
        )
        .expect("frequency-domain manifest should be valid JSON");
        let progress: serde_json::Value = serde_json::from_slice(
            &std::fs::read(output_dir.join("response/progress.v1.json"))
                .expect("response progress should be written"),
        )
        .expect("response progress should be valid JSON");
        let cancel_requested: serde_json::Value = serde_json::from_slice(
            &std::fs::read(output_dir.join("response/cancel_requested.v1.json"))
                .expect("cancel-requested progress should be written"),
        )
        .expect("cancel-requested progress should be valid JSON");

        assert_eq!(manifest["diagnostics"]["status"], "interrupted");
        assert_eq!(manifest["diagnostics"]["complete"], false);
        assert_eq!(
            manifest["diagnostics"]["completed_frequency_point_count"],
            1
        );
        assert_eq!(
            manifest["diagnostics"]["written_frequency_point_artifacts"],
            1
        );
        assert_eq!(progress["status"], "interrupted");
        assert_eq!(progress["complete"], false);
        assert_eq!(progress["completed_frequency_points"], 1);
        assert_eq!(progress["written_frequency_point_artifacts"], 1);
        assert_eq!(progress["partial_artifacts_available"], true);
        assert_eq!(cancel_requested["status"], "cancel_requested");
        assert_eq!(cancel_requested["complete"], false);
        assert_eq!(cancel_requested["completed_frequency_points"], 1);
        assert_eq!(cancel_requested["written_frequency_point_artifacts"], 1);
        assert_eq!(cancel_requested["partial_artifacts_available"], true);
        let _ = std::fs::remove_dir_all(output_dir);
    }

    fn minimal_frequency_response_plan() -> fullmag_ir::FemFrequencyResponsePlanIR {
        fullmag_ir::FemFrequencyResponsePlanIR {
            mesh_name: "unit".to_string(),
            mesh_source: None,
            mesh: fullmag_ir::MeshIR {
                mesh_name: "unit".to_string(),
                nodes: vec![[0.0, 0.0, 0.0]],
                elements: Vec::new(),
                element_markers: Vec::new(),
                boundary_faces: Vec::new(),
                boundary_markers: Vec::new(),
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]],
            material: fullmag_ir::MaterialIR {
                name: "mat".to_string(),
                saturation_magnetisation: 8.0e5,
                exchange_stiffness: 1.3e-11,
                damping: 0.01,
                uniaxial_anisotropy: None,
                uniaxial_anisotropy_k2: None,
                anisotropy_axis: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            normalization: fullmag_ir::FrequencyResponseNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Include,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
            excitation: fullmag_ir::FrequencyExcitationIR {
                field_au_per_m: [1.0, 0.0, 0.0],
                phase_rad: 0.0,
            },
            frequencies_hz: fullmag_ir::FrequencySweepIR {
                values_hz: vec![1.0e9],
            },
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            dmi_interface_normal: None,
            bulk_dmi: None,
            external_field: Some([1.0, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: fullmag_ir::ExecutionPrecision::Double,
            requested_device: fullmag_ir::ExecutionDevice::Cpu,
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            demag_realization: None,
            periodic_constraint_sets: Vec::new(),
        }
    }

    fn qualified_periodic_airbox_frequency_response_plan() -> fullmag_ir::FemFrequencyResponsePlanIR
    {
        let mut plan = minimal_frequency_response_plan();
        plan.mesh.nodes = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        plan.equilibrium_magnetization = vec![[1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
        plan.mesh.periodic_boundary_pairs = vec![
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 1,
                marker_b: 2,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            },
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "y_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 3,
                marker_b: 4,
                translation: Some([0.0, 1.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("y".to_string()),
                orientation: None,
                pairing_policy: None,
            },
        ];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y_faces".to_string(),
                node_a: 0,
                node_b: 2,
            },
        ];
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir;
        plan.enable_demag = true;
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        plan.magnetostatic_bc = fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0;
        plan.periodic_constraint_sets = vec![
            fullmag_ir::PeriodicConstraintSetIR {
                unknown_family: fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic,
                domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagneticDomain,
                pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                phase_policy: fullmag_ir::PeriodicPhasePolicyIR::ZeroPhase,
                phase_loop_diagnostics: None,
            },
            fullmag_ir::PeriodicConstraintSetIR {
                unknown_family: fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic,
                domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir,
                pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                phase_policy: fullmag_ir::PeriodicPhasePolicyIR::ZeroPhase,
                phase_loop_diagnostics: None,
            },
        ];
        plan
    }

    #[test]
    fn production_cpu_frequency_response_rejects_unimplemented_physics_without_dense_fallback() {
        let mut high_order = minimal_frequency_response_plan();
        high_order.fe_order = 2;
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&high_order)
                .expect("higher-order FEM should reject")
                .contains("first-order P1")
        );

        let mut shared_domain = minimal_frequency_response_plan();
        shared_domain.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir;
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&shared_domain)
                .expect("shared-domain mesh should reject")
                .contains("without shared-domain airbox")
        );

        let mut demag = minimal_frequency_response_plan();
        demag.enable_demag = true;
        demag.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&demag)
                .expect("demag should reject")
                .contains("dynamic demag")
        );

        let mut nonzero_k = minimal_frequency_response_plan();
        nonzero_k.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&nonzero_k)
                .expect("nonzero-k should reject")
                .contains("nonzero-k")
        );

        let mut periodic = minimal_frequency_response_plan();
        periodic.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&periodic)
                .expect("periodic BC without mesh pairs should reject")
                .contains("periodic_boundary_pairs")
        );
        periodic.mesh.nodes.push([1.0, 0.0, 0.0]);
        periodic.equilibrium_magnetization.push([1.0, 0.0, 0.0]);
        periodic.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&periodic)
                .expect("periodic BC without boundary-pair metadata should reject")
                .contains("periodic_boundary_pairs")
        );
        periodic.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 2,
            translation: None,
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&periodic)
                .expect("periodic BC without translation should reject")
                .contains("translations")
        );
        periodic.mesh.periodic_boundary_pairs[0].translation = Some([1.0, 0.0, 0.0]);
        assert!(super::production_cpu_frequency_response_rejection_reason(&periodic).is_none());

        let mut multi_pair = minimal_frequency_response_plan();
        multi_pair.mesh.nodes = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        multi_pair.equilibrium_magnetization =
            vec![[1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
        multi_pair.mesh.periodic_boundary_pairs = vec![
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 1,
                marker_b: 2,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            },
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "y_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 3,
                marker_b: 4,
                translation: Some([0.0, 1.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("y".to_string()),
                orientation: None,
                pairing_policy: None,
            },
        ];
        multi_pair.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y_faces".to_string(),
                node_a: 0,
                node_b: 2,
            },
        ];
        multi_pair.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        assert!(super::production_cpu_frequency_response_rejection_reason(&multi_pair).is_none());

        let periodic_airbox = qualified_periodic_airbox_frequency_response_plan();
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&periodic_airbox).is_none()
        );
        #[cfg(feature = "fem-gpu")]
        {
            let mut periodic_airbox_payload_plan = periodic_airbox.clone();
            periodic_airbox_payload_plan.enable_exchange = false;
            let payload = super::build_native_production_cpu_payload(&periodic_airbox_payload_plan)
                .expect("periodic-airbox response should build a native payload");
            assert_eq!(payload.static_periodic_node_pairs.len(), 2);
            assert_eq!(
                payload
                    .periodic_airbox_magnetostatic_periodic_node_pairs
                    .len(),
                2
            );
        }

        multi_pair.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".to_string(), "z_faces".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&multi_pair)
                .expect("unknown selected periodic pair id should reject")
                .contains("unknown periodic boundary pair")
        );

        let mut bad_translation = periodic.clone();
        bad_translation.mesh.periodic_boundary_pairs[0].translation = Some([0.5, 0.0, 0.0]);
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&bad_translation)
                .expect("periodic BC with invalid translation residual should reject")
                .contains("within tolerance")
        );

        let mut floquet = periodic.clone();
        floquet.enable_exchange = false;
        floquet.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&floquet).is_none(),
            "gamma Floquet response should alias to static-periodic production CPU support"
        );
        #[cfg(feature = "fem-gpu")]
        {
            let payload = super::build_native_production_cpu_payload(&floquet)
                .expect("gamma Floquet response should build a native CPU payload");
            assert_eq!(payload.static_periodic_node_pairs.len(), 1);
            assert!(payload.floquet_k_vector_rad_per_m.is_none());
            assert!(payload.floquet_periodic_pairs.is_empty());
        }
        floquet.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&floquet)
                .expect("nonzero-k Floquet response should reject")
                .contains("Floquet/Bloch")
        );

        let supported = minimal_frequency_response_plan();
        assert!(super::production_cpu_frequency_response_rejection_reason(&supported).is_none());

        let mut dmi = minimal_frequency_response_plan();
        dmi.bulk_dmi = Some(2.5e-3);
        #[cfg(feature = "fem-gpu")]
        assert!(super::production_cpu_frequency_response_rejection_reason(&dmi).is_none());
        #[cfg(not(feature = "fem-gpu"))]
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&dmi)
                .expect("DMI should require native FEM production CPU")
                .contains("requires the native FEM production CPU solver")
        );
    }

    #[test]
    fn floquet_periodic_pairs_carry_selected_pair_phase_metadata() {
        let mut plan = minimal_frequency_response_plan();
        plan.mesh.nodes = vec![[0.0, 0.0, 0.0], [1.0e-6, 0.0, 0.0], [0.0, 2.0e-6, 0.0]];
        plan.equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; 3];
        plan.mesh.periodic_boundary_pairs = vec![
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 1,
                marker_b: 2,
                translation: Some([1.0e-6, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            },
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "y_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 3,
                marker_b: 4,
                translation: Some([0.0, 2.0e-6, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("y".to_string()),
                orientation: None,
                pairing_policy: None,
            },
        ];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y_faces".to_string(),
                node_a: 0,
                node_b: 2,
            },
        ];
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR,
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 2.0e6, 0.0],
        });

        let pairs = super::build_floquet_periodic_pairs(&plan)
            .expect("Floquet periodic-pair metadata should be buildable");

        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0].pair_id, "x_faces");
        assert_eq!(pairs[0].node_a, 0);
        assert_eq!(pairs[0].node_b, 1);
        assert_eq!(pairs[0].translation_m, [1.0e-6, 0.0, 0.0]);
        assert_eq!(pairs[0].phase_rad, -1.0);
        assert_eq!(pairs[1].pair_id, "y_faces");
        assert_eq!(pairs[1].node_a, 0);
        assert_eq!(pairs[1].node_b, 2);
        assert_eq!(pairs[1].translation_m, [0.0, 2.0e-6, 0.0]);
        assert_eq!(pairs[1].phase_rad, -4.0);
    }

    #[test]
    fn production_gpu_frequency_response_is_narrower_than_cpu_and_never_falls_back() {
        let mut supported = minimal_frequency_response_plan();
        supported.requested_device = fullmag_ir::ExecutionDevice::Gpu;
        supported.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        supported.mesh.elements = vec![[0, 1, 2, 3]];
        supported.equilibrium_magnetization = vec![[0.0, 0.0, 1.0]; 4];
        assert!(super::production_gpu_frequency_response_rejection_reason(&supported).is_none());
        #[cfg(feature = "fem-gpu")]
        assert!(
            super::build_native_production_gpu_payload(&supported).is_some(),
            "supported GPU slice should build a native production payload"
        );

        let mut demag = supported.clone();
        demag.enable_demag = true;
        demag.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        assert!(
            super::production_gpu_frequency_response_rejection_reason(&demag)
                .expect("demag must reject on GPU")
                .contains("dynamic demag")
        );

        let mut dmi = supported.clone();
        dmi.bulk_dmi = Some(2.5e-3);
        assert!(
            super::production_gpu_frequency_response_rejection_reason(&dmi)
                .expect("DMI must reject on GPU until device weak residual exists")
                .contains("DMI")
        );

        let mut periodic_without_pairs = supported.clone();
        periodic_without_pairs.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        assert!(
            super::production_gpu_frequency_response_rejection_reason(&periodic_without_pairs)
                .expect("periodic GPU response without mesh pairs should reject")
                .contains("periodic_boundary_pairs")
        );

        let mut periodic = periodic_without_pairs.clone();
        periodic.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];
        periodic.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        assert!(
            super::production_gpu_frequency_response_rejection_reason(&periodic).is_none(),
            "valid k=0 static-periodic no-demag response should be executable on GPU"
        );
        #[cfg(feature = "fem-gpu")]
        {
            let payload = super::build_native_production_gpu_payload(&periodic)
                .expect("valid static-periodic GPU response should build a native payload");
            assert_eq!(payload.static_periodic_node_pairs.len(), 1);
            assert!(payload.floquet_periodic_pairs.is_empty());
        }

        let mut nonzero_k = supported.clone();
        nonzero_k.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
        assert!(
            super::production_gpu_frequency_response_rejection_reason(&nonzero_k)
                .expect("nonzero-k must reject on GPU")
                .contains("nonzero-k")
        );
    }

    #[cfg(not(feature = "fem-gpu"))]
    #[test]
    fn periodic_airbox_response_without_native_solver_does_not_use_dense_validation() {
        let plan = qualified_periodic_airbox_frequency_response_plan();
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-periodic-airbox-no-native-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let err = super::execute_fem_frequency_response_validation(&plan, &output_dir, None, None)
            .expect_err("periodic-airbox response must not use dense validation fallback");

        assert!(
            err.message.contains("periodic_airbox_k0"),
            "{}",
            err.message
        );
        assert!(err.message.contains("native"), "{}", err.message);
        assert!(!output_dir
            .join("response/magnetic_response_sweep.v1.json")
            .exists());
        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_failure_message_preserves_native_and_json_statuses() {
        let message = super::native_frequency_response_failure_message(
            "native FEM production CPU frequency response failed",
            super::NativeFrequencyDomainStatus::SolveError,
            "singular block system",
            r#"{"schema_version":"frequency_domain_response_diagnostics.v1","status":"solve_error"}"#,
            r#"{"schema_version":"frequency_domain_response_summary.v1","status":"solve_error"}"#,
        );

        assert!(message.contains("native_status=solve_error"));
        assert!(message.contains("diagnostics_status=solve_error"));
        assert!(message.contains("result_status=solve_error"));
        assert!(message.contains("singular block system"));
        assert!(!message.contains("artifact_error"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_production_cpu_payload_accepts_absent_static_zeeman_field() {
        let mut plan = minimal_frequency_response_plan();
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        plan.mesh.elements = vec![[0, 1, 2, 3]];
        plan.equilibrium_magnetization = vec![[0.0, 0.0, 1.0]; 4];
        plan.external_field = None;

        let payload = super::build_native_production_cpu_payload(&plan)
            .expect("zero-Zeeman production CPU payload should build");
        assert_eq!(payload.h_ext_a_per_m, [0.0, 0.0, 0.0]);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_production_cpu_payload_builds_tetra_dmi_elements() {
        let mut plan = minimal_frequency_response_plan();
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        plan.mesh.elements = vec![[0, 1, 2, 3]];
        plan.mesh.element_markers = vec![1];
        plan.equilibrium_magnetization = vec![[0.0, 0.0, 1.0]; 4];
        plan.excitation.field_au_per_m = [1.0, 0.5, 0.0];
        plan.interfacial_dmi = Some(1.0e-3);
        plan.dmi_interface_normal = Some([0.0, 0.0, 2.0]);
        plan.bulk_dmi = Some(-2.0e-3);

        let payload =
            super::build_native_production_cpu_payload(&plan).expect("DMI payload should build");
        assert_eq!(payload.dmi_elements.len(), 2);
        assert_eq!(
            payload.dmi_elements[0].kind,
            super::NativeDrivenFrequencyResponseDmiKind::Interfacial
        );
        assert_eq!(
            payload.dmi_elements[1].kind,
            super::NativeDrivenFrequencyResponseDmiKind::Bulk
        );
        assert_eq!(payload.dmi_elements[0].node_indices, [0, 1, 2, 3]);
        assert_eq!(payload.dmi_elements[0].shape, [0.25; 4]);
        assert_eq!(
            payload.dmi_elements[0].grad_shape,
            [-1.0, -1.0, -1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        );
        assert!((payload.dmi_elements[0].weight - 1.0 / 6.0).abs() < 1.0e-15);
        assert_eq!(payload.dmi_elements[0].normal, [0.0, 0.0, 1.0]);
        assert_eq!(
            payload.dmi_lumped_mass.as_deref(),
            Some([1.0 / 24.0; 4].as_slice())
        );
        assert!(payload.dmi_ms_field.is_none());
        assert_eq!(payload.dmi_uniform_ms, 8.0e5);
    }
}
