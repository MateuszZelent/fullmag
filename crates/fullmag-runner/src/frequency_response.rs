use crate::eigen::solve_and_write_field_driven_response_sweep_bundle_with_interrupt;
#[cfg(any(feature = "fem-gpu", test))]
use crate::native_fem::NativeFrequencyDomainProgress;
#[cfg(any(feature = "fem-gpu", test))]
use crate::native_fem::NativeFrequencyDomainStatus;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{
    solve_native_driven_frequency_response, NativeDrivenFrequencyResponseDmiElement,
    NativeDrivenFrequencyResponseDmiKind, NativeDrivenFrequencyResponseExchangeEdge,
    NativeDrivenFrequencyResponseFloquetPeriodicPair,
    NativeDrivenFrequencyResponseMfemOperatorProblem,
    NativeDrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem,
    NativeDrivenFrequencyResponsePeriodicNodePair, NativeDrivenFrequencyResponseRequest,
    NativeFemBackend, NativeFrequencyDomainExecutionLane,
};
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{
    NativeFrequencyDomainCancelCallback, NativeFrequencyDomainProgressCallback,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, RunError, RunResult, RunStatus, StepAction, StepStats,
    StepUpdate,
};
#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;
use nalgebra::{DMatrix, DVector};
use num_complex::Complex64;
#[cfg(feature = "fem-gpu")]
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
#[cfg(feature = "fem-gpu")]
use std::ffi::{c_char, c_void};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "fem-gpu")]
use std::time::Instant;

#[cfg(feature = "fem-gpu")]
fn frequency_response_trace_enabled() -> bool {
    std::env::var("FULLMAG_FEM_FREQUENCY_RESPONSE_TRACE")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

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
                    let completed_frequency_count = completed_points as u64;
                    let action = on_step(dense_frequency_response_progress_update(
                        completed_frequency_count,
                        plan.frequencies_hz.values_hz.len() as u64,
                        plan.frequencies_hz.values_hz[completed_points - 1],
                        frequency_response_range_hz(&plan.frequencies_hz.values_hz),
                        drive_norm,
                        plan.enable_demag,
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
    total_frequency_count: u64,
    frequency_hz: f64,
    frequency_range_hz: Option<(f64, f64)>,
    drive_norm: f64,
    demag_enabled: bool,
) -> StepUpdate {
    let mut progress_scalars = std::collections::HashMap::new();
    progress_scalars.insert(
        "completed_frequency_count".to_string(),
        completed_frequency_count as f64,
    );
    progress_scalars.insert(
        "total_frequency_count".to_string(),
        total_frequency_count as f64,
    );
    progress_scalars.insert("frequency_hz".to_string(), frequency_hz);
    if let Some((min_hz, max_hz)) = frequency_range_hz {
        progress_scalars.insert("frequency_min_hz".to_string(), min_hz);
        progress_scalars.insert("frequency_max_hz".to_string(), max_hz);
    }
    progress_scalars.insert(
        "percent".to_string(),
        frequency_response_progress_percent(completed_frequency_count, total_frequency_count),
    );
    progress_scalars.insert("phase_solving_frequency_point".to_string(), 1.0);
    insert_frequency_response_demag_progress_scalars(
        &mut progress_scalars,
        demag_enabled,
        false,
        false,
    );
    let mut per_object_scalars = std::collections::HashMap::new();
    per_object_scalars.insert(
        "fem_frequency_response_progress".to_string(),
        progress_scalars,
    );

    StepUpdate {
        stats: StepStats {
            step: completed_frequency_count,
            time: 0.0,
            dt: 0.0,
            max_h_eff: drive_norm,
            per_object_scalars,
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
    frequency_range_hz: Option<(f64, f64)>,
    drive_norm: f64,
    demag_enabled: bool,
    periodic_airbox_demag: bool,
    floquet_airbox_demag: bool,
) -> StepUpdate {
    let mut progress_scalars = std::collections::HashMap::new();
    progress_scalars.insert(
        "frequency_index".to_string(),
        progress.frequency_index as f64,
    );
    progress_scalars.insert(
        "completed_frequency_count".to_string(),
        progress.completed_frequency_count as f64,
    );
    progress_scalars.insert(
        "total_frequency_count".to_string(),
        progress.total_frequency_count as f64,
    );
    progress_scalars.insert("iteration".to_string(), progress.iteration_count as f64);
    let max_iterations_for_frequency = native_frequency_response_max_iterations_for_progress();
    progress_scalars.insert(
        "max_iterations_for_frequency".to_string(),
        max_iterations_for_frequency as f64,
    );
    let current_frequency_solve_fraction = frequency_response_current_solve_fraction(
        progress.iteration_count,
        max_iterations_for_frequency,
        progress.converged,
    );
    progress_scalars.insert(
        "current_frequency_solve_fraction".to_string(),
        current_frequency_solve_fraction,
    );
    progress_scalars.insert("frequency_hz".to_string(), progress.frequency_hz);
    if let Some((min_hz, max_hz)) = frequency_range_hz {
        progress_scalars.insert("frequency_min_hz".to_string(), min_hz);
        progress_scalars.insert("frequency_max_hz".to_string(), max_hz);
    }
    progress_scalars.insert("residual_l2_norm".to_string(), progress.residual_l2_norm);
    progress_scalars.insert(
        "relative_residual_l2_norm".to_string(),
        progress.relative_residual_l2_norm,
    );
    progress_scalars.insert("converged".to_string(), progress.converged as u8 as f64);
    progress_scalars.insert(
        "percent".to_string(),
        native_frequency_response_progress_percent(
            progress.frequency_index,
            progress.completed_frequency_count,
            progress.total_frequency_count,
            current_frequency_solve_fraction,
        ),
    );
    progress_scalars.insert("phase_solving_frequency_point".to_string(), 1.0);
    insert_frequency_response_demag_progress_scalars(
        &mut progress_scalars,
        demag_enabled,
        periodic_airbox_demag,
        floquet_airbox_demag,
    );
    let mut per_object_scalars = std::collections::HashMap::new();
    per_object_scalars.insert(
        "fem_frequency_response_progress".to_string(),
        progress_scalars,
    );

    StepUpdate {
        stats: StepStats {
            step: progress.completed_frequency_count,
            time: 0.0,
            dt: 0.0,
            max_h_eff: drive_norm,
            per_object_scalars,
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

fn insert_frequency_response_demag_progress_scalars(
    progress_scalars: &mut std::collections::HashMap<String, f64>,
    demag_enabled: bool,
    periodic_airbox_demag: bool,
    floquet_airbox_demag: bool,
) {
    if demag_enabled {
        progress_scalars.insert("demag_enabled".to_string(), 1.0);
    }
    if periodic_airbox_demag {
        progress_scalars.insert("demag_periodic_airbox_k0".to_string(), 1.0);
    }
    if floquet_airbox_demag {
        progress_scalars.insert("demag_floquet_airbox".to_string(), 1.0);
    }
}

fn frequency_response_range_hz(frequencies_hz: &[f64]) -> Option<(f64, f64)> {
    let mut iter = frequencies_hz
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0);
    let first = iter.next()?;
    let (min_hz, max_hz) = iter.fold((first, first), |(min_hz, max_hz), value| {
        (min_hz.min(value), max_hz.max(value))
    });
    Some((min_hz, max_hz))
}

#[cfg(any(feature = "fem-gpu", test))]
fn first_frequency_response_hz(frequencies_hz: &[f64]) -> Option<f64> {
    frequencies_hz
        .iter()
        .copied()
        .find(|value| value.is_finite() && *value > 0.0)
}

#[cfg(feature = "fem-gpu")]
fn frequency_response_demag_mode(
    demag_enabled: bool,
    periodic_airbox_demag: bool,
    floquet_airbox_demag: bool,
) -> Option<&'static str> {
    if periodic_airbox_demag {
        Some("periodic_airbox_k0")
    } else if floquet_airbox_demag {
        Some("floquet_airbox")
    } else if demag_enabled {
        Some("enabled")
    } else {
        None
    }
}

fn frequency_response_progress_percent(
    completed_frequency_count: u64,
    total_frequency_count: u64,
) -> f64 {
    if total_frequency_count == 0 {
        0.0
    } else {
        ((completed_frequency_count as f64 / total_frequency_count as f64) * 100.0)
            .clamp(0.0, 100.0)
    }
}

#[cfg(any(feature = "fem-gpu", test))]
fn native_frequency_response_progress_percent(
    frequency_index: u64,
    completed_frequency_count: u64,
    total_frequency_count: u64,
    current_frequency_solve_fraction: f64,
) -> f64 {
    if total_frequency_count == 0 {
        return 0.0;
    }
    let completed_before_current = completed_frequency_count.min(frequency_index);
    let effective_completed =
        completed_before_current as f64 + current_frequency_solve_fraction.clamp(0.0, 1.0);
    ((effective_completed / total_frequency_count as f64) * 100.0).clamp(0.0, 100.0)
}

#[cfg(any(feature = "fem-gpu", test))]
fn frequency_response_current_solve_fraction(
    iteration_count: u64,
    max_iterations_for_frequency: u64,
    converged: bool,
) -> f64 {
    if converged {
        return 1.0;
    }
    if max_iterations_for_frequency == 0 {
        return 0.0;
    }
    (iteration_count as f64 / max_iterations_for_frequency as f64).clamp(0.0, 1.0)
}

#[cfg(any(feature = "fem-gpu", test))]
fn native_frequency_response_max_iterations_for_progress() -> u64 {
    env_positive_u64_alias(
        "FULLMAG_FEM_FREQUENCY_RESPONSE_MAX_ITERATIONS",
        "FULLMAG_FMR_RESPONSE_MAX_ITERATIONS",
        8192,
    )
}

#[cfg(any(feature = "fem-gpu", test))]
fn env_positive_u64_alias(primary: &str, alias: &str, fallback: u64) -> u64 {
    std::env::var(primary)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .or_else(|| {
            std::env::var(alias)
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
        })
        .unwrap_or(fallback)
}

#[cfg(any(feature = "fem-gpu", test))]
fn write_frequency_response_progress_artifact(
    output_dir: &Path,
    status: &str,
    state: &str,
    total_frequency_points: usize,
    completed_frequency_points: u64,
    written_frequency_point_artifacts: u64,
    current_frequency_hz: Option<f64>,
    frequency_range_hz: Option<(f64, f64)>,
    demag_mode: Option<&str>,
    latest_artifact_manifest_path: Option<&str>,
) -> std::io::Result<()> {
    let response_dir = output_dir.join("response");
    std::fs::create_dir_all(&response_dir)?;
    let partial_artifacts_available = written_frequency_point_artifacts > 0;
    let progress_json = serde_json::json!({
        "schema_version": "frequency_domain_sweep_progress.v1",
        "status": status,
        "state": state,
        "complete": false,
        "total_frequency_points": total_frequency_points,
        "completed_frequency_points": completed_frequency_points,
        "written_frequency_point_artifacts": written_frequency_point_artifacts,
        "current_frequency_hz": current_frequency_hz,
        "frequency_min_hz": frequency_range_hz.map(|range| range.0),
        "frequency_max_hz": frequency_range_hz.map(|range| range.1),
        "partial_artifacts_available": partial_artifacts_available,
        "latest_artifact_manifest_path": latest_artifact_manifest_path,
        "demag_mode": demag_mode,
    })
    .to_string();
    let progress_artifact = serde_json::json!({
        "schema_version": "frequency_domain_sweep_progress.v1",
        "status": status,
        "state": state,
        "complete": false,
        "total_frequency_points": total_frequency_points,
        "completed_frequency_points": completed_frequency_points,
        "written_frequency_point_artifacts": written_frequency_point_artifacts,
        "current_frequency_hz": current_frequency_hz,
        "frequency_min_hz": frequency_range_hz.map(|range| range.0),
        "frequency_max_hz": frequency_range_hz.map(|range| range.1),
        "partial_artifacts_available": partial_artifacts_available,
        "latest_artifact_manifest_path": latest_artifact_manifest_path,
        "missing_reason": null,
        "demag_mode": demag_mode,
        "progress_json": progress_json,
    });
    std::fs::write(
        response_dir.join("progress.v1.json"),
        serde_json::to_vec_pretty(&progress_artifact).expect("progress JSON should serialize"),
    )
}

#[cfg(any(feature = "fem-gpu", test))]
fn write_native_frequency_response_progress_artifact(
    output_dir: &Path,
    progress: NativeFrequencyDomainProgress,
    demag_mode: Option<&str>,
    frequency_range_hz: Option<(f64, f64)>,
) -> std::io::Result<()> {
    let response_dir = output_dir.join("response");
    std::fs::create_dir_all(&response_dir)?;
    let completed_frequency_points = progress.completed_frequency_count;
    let written_frequency_point_artifacts = 0;
    let partial_artifacts_available = written_frequency_point_artifacts > 0;
    let max_iterations_for_frequency = native_frequency_response_max_iterations_for_progress();
    let current_frequency_solve_fraction = frequency_response_current_solve_fraction(
        progress.iteration_count,
        max_iterations_for_frequency,
        progress.converged,
    );
    let progress_json_value = serde_json::json!({
        "schema_version": "frequency_domain_sweep_progress.v1",
        "status": "running",
        "state": "solving_frequency",
        "complete": false,
        "total_frequency_points": progress.total_frequency_count,
        "completed_frequency_points": completed_frequency_points,
        "written_frequency_point_artifacts": written_frequency_point_artifacts,
        "current_frequency_hz": progress.frequency_hz,
        "frequency_min_hz": frequency_range_hz.map(|range| range.0),
        "frequency_max_hz": frequency_range_hz.map(|range| range.1),
        "partial_artifacts_available": partial_artifacts_available,
        "latest_artifact_manifest_path": null,
        "native_frequency_index": progress.frequency_index,
        "native_iteration_count": progress.iteration_count,
        "native_max_iterations_for_frequency": max_iterations_for_frequency,
        "native_current_frequency_solve_fraction": current_frequency_solve_fraction,
        "native_residual_l2_norm": progress.residual_l2_norm,
        "native_relative_residual_l2_norm": progress.relative_residual_l2_norm,
        "native_converged": progress.converged,
        "demag_mode": demag_mode,
    });
    let progress_artifact = serde_json::json!({
        "schema_version": "frequency_domain_sweep_progress.v1",
        "status": "running",
        "state": "solving_frequency",
        "complete": false,
        "total_frequency_points": progress.total_frequency_count,
        "completed_frequency_points": completed_frequency_points,
        "written_frequency_point_artifacts": written_frequency_point_artifacts,
        "current_frequency_hz": progress.frequency_hz,
        "frequency_min_hz": frequency_range_hz.map(|range| range.0),
        "frequency_max_hz": frequency_range_hz.map(|range| range.1),
        "partial_artifacts_available": partial_artifacts_available,
        "latest_artifact_manifest_path": null,
        "missing_reason": null,
        "native_frequency_index": progress.frequency_index,
        "native_iteration_count": progress.iteration_count,
        "native_max_iterations_for_frequency": max_iterations_for_frequency,
        "native_current_frequency_solve_fraction": current_frequency_solve_fraction,
        "native_residual_l2_norm": progress.residual_l2_norm,
        "native_relative_residual_l2_norm": progress.relative_residual_l2_norm,
        "native_converged": progress.converged,
        "demag_mode": demag_mode,
        "progress_json": progress_json_value.to_string(),
    });
    std::fs::write(
        response_dir.join("progress.v1.json"),
        serde_json::to_vec_pretty(&progress_artifact)
            .expect("native progress JSON should serialize"),
    )
}

#[cfg(any(feature = "fem-gpu", test))]
fn frequency_response_artifact_manifest_progress_path(
    output_dir: &Path,
    manifest_path: &str,
) -> String {
    let manifest_path = Path::new(manifest_path);
    manifest_path
        .strip_prefix(output_dir)
        .unwrap_or(manifest_path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(any(feature = "fem-gpu", test))]
fn preserve_native_frequency_response_progress_artifact(
    output_dir: &Path,
    progress: NativeFrequencyDomainProgress,
    demag_mode: Option<&str>,
    frequency_range_hz: Option<(f64, f64)>,
    final_status: NativeFrequencyDomainStatus,
    written_frequency_point_artifacts: u64,
    latest_artifact_manifest_path: Option<&str>,
) -> std::io::Result<()> {
    let progress_path = output_dir.join("response/progress.v1.json");
    if !progress_path.is_file() {
        write_native_frequency_response_progress_artifact(
            output_dir,
            progress,
            demag_mode,
            frequency_range_hz,
        )?;
    }
    let mut progress_artifact: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&progress_path)?)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    let Some(progress_object) = progress_artifact.as_object_mut() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frequency-response progress artifact must be a JSON object",
        ));
    };
    let final_progress_status = native_frequency_domain_progress_status(final_status);
    let final_progress_state = native_frequency_domain_progress_state(final_status);
    let final_progress_complete = final_status == NativeFrequencyDomainStatus::Ok;
    progress_object.insert(
        "status".to_string(),
        serde_json::json!(final_progress_status),
    );
    progress_object.insert("state".to_string(), serde_json::json!(final_progress_state));
    progress_object.insert(
        "complete".to_string(),
        serde_json::json!(final_progress_complete),
    );
    progress_object.insert(
        "native_frequency_index".to_string(),
        serde_json::json!(progress.frequency_index),
    );
    progress_object.insert(
        "native_iteration_count".to_string(),
        serde_json::json!(progress.iteration_count),
    );
    let max_iterations_for_frequency = native_frequency_response_max_iterations_for_progress();
    let current_frequency_solve_fraction = frequency_response_current_solve_fraction(
        progress.iteration_count,
        max_iterations_for_frequency,
        progress.converged,
    );
    progress_object.insert(
        "native_max_iterations_for_frequency".to_string(),
        serde_json::json!(max_iterations_for_frequency),
    );
    progress_object.insert(
        "native_current_frequency_solve_fraction".to_string(),
        serde_json::json!(current_frequency_solve_fraction),
    );
    progress_object.insert(
        "native_residual_l2_norm".to_string(),
        serde_json::json!(progress.residual_l2_norm),
    );
    progress_object.insert(
        "native_relative_residual_l2_norm".to_string(),
        serde_json::json!(progress.relative_residual_l2_norm),
    );
    progress_object.insert(
        "native_converged".to_string(),
        serde_json::json!(progress.converged),
    );
    if let Some(demag_mode) = demag_mode {
        progress_object.insert("demag_mode".to_string(), serde_json::json!(demag_mode));
    }
    progress_object
        .entry("current_frequency_hz".to_string())
        .or_insert_with(|| serde_json::json!(progress.frequency_hz));
    if let Some((min_hz, max_hz)) = frequency_range_hz {
        progress_object.insert("frequency_min_hz".to_string(), serde_json::json!(min_hz));
        progress_object.insert("frequency_max_hz".to_string(), serde_json::json!(max_hz));
    }
    progress_object.insert(
        "written_frequency_point_artifacts".to_string(),
        serde_json::json!(written_frequency_point_artifacts),
    );
    let partial_artifacts_available =
        written_frequency_point_artifacts > 0 || latest_artifact_manifest_path.is_some();
    progress_object.insert(
        "partial_artifacts_available".to_string(),
        serde_json::json!(partial_artifacts_available),
    );
    let latest_artifact_manifest_progress_path = latest_artifact_manifest_path
        .map(|path| frequency_response_artifact_manifest_progress_path(output_dir, path));
    if let Some(path) = latest_artifact_manifest_path {
        progress_object.insert(
            "latest_artifact_manifest_path".to_string(),
            serde_json::json!(latest_artifact_manifest_progress_path
                .as_deref()
                .unwrap_or(path)),
        );
    }

    let mut progress_json_value = if let Some(raw_progress_json) = progress_object
        .get("progress_json")
        .and_then(|value| value.as_str())
    {
        serde_json::from_str(raw_progress_json).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let progress_json_object = progress_json_value.as_object_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frequency-response progress_json must be a JSON object string",
        )
    })?;
    progress_json_object.insert(
        "schema_version".to_string(),
        serde_json::json!("frequency_domain_sweep_progress.v1"),
    );
    progress_json_object.insert("state".to_string(), serde_json::json!(final_progress_state));
    progress_json_object.insert(
        "status".to_string(),
        serde_json::json!(final_progress_status),
    );
    progress_json_object.insert(
        "complete".to_string(),
        serde_json::json!(final_progress_complete),
    );
    progress_json_object.insert(
        "total_frequency_points".to_string(),
        progress_object
            .get("total_frequency_points")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(progress.total_frequency_count)),
    );
    progress_json_object.insert(
        "completed_frequency_points".to_string(),
        progress_object
            .get("completed_frequency_points")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(progress.completed_frequency_count)),
    );
    progress_json_object.insert(
        "written_frequency_point_artifacts".to_string(),
        progress_object
            .get("written_frequency_point_artifacts")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(progress.completed_frequency_count)),
    );
    progress_json_object.insert(
        "current_frequency_hz".to_string(),
        progress_object
            .get("current_frequency_hz")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(progress.frequency_hz)),
    );
    if let Some(frequency_min_hz) = progress_object.get("frequency_min_hz").cloned() {
        progress_json_object.insert("frequency_min_hz".to_string(), frequency_min_hz);
    }
    if let Some(frequency_max_hz) = progress_object.get("frequency_max_hz").cloned() {
        progress_json_object.insert("frequency_max_hz".to_string(), frequency_max_hz);
    }
    progress_json_object.insert(
        "partial_artifacts_available".to_string(),
        progress_object
            .get("partial_artifacts_available")
            .cloned()
            .unwrap_or_else(|| serde_json::json!(progress.completed_frequency_count > 0)),
    );
    progress_json_object.insert(
        "latest_artifact_manifest_path".to_string(),
        progress_object
            .get("latest_artifact_manifest_path")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    progress_json_object.insert(
        "native_frequency_index".to_string(),
        serde_json::json!(progress.frequency_index),
    );
    progress_json_object.insert(
        "native_iteration_count".to_string(),
        serde_json::json!(progress.iteration_count),
    );
    progress_json_object.insert(
        "native_max_iterations_for_frequency".to_string(),
        serde_json::json!(max_iterations_for_frequency),
    );
    progress_json_object.insert(
        "native_current_frequency_solve_fraction".to_string(),
        serde_json::json!(current_frequency_solve_fraction),
    );
    progress_json_object.insert(
        "native_residual_l2_norm".to_string(),
        serde_json::json!(progress.residual_l2_norm),
    );
    progress_json_object.insert(
        "native_relative_residual_l2_norm".to_string(),
        serde_json::json!(progress.relative_residual_l2_norm),
    );
    progress_json_object.insert(
        "native_converged".to_string(),
        serde_json::json!(progress.converged),
    );
    if let Some(demag_mode) = demag_mode {
        progress_json_object.insert("demag_mode".to_string(), serde_json::json!(demag_mode));
    } else if let Some(existing_demag_mode) = progress_object.get("demag_mode").cloned() {
        progress_json_object.insert("demag_mode".to_string(), existing_demag_mode);
    }
    progress_object.insert(
        "progress_json".to_string(),
        serde_json::json!(progress_json_value.to_string()),
    );
    std::fs::write(
        progress_path,
        serde_json::to_vec_pretty(&progress_artifact)
            .expect("preserved native progress JSON should serialize"),
    )
}

#[cfg(any(feature = "fem-gpu", test))]
fn write_initial_frequency_response_progress_artifact(
    output_dir: &Path,
    frequencies_hz: &[f64],
    demag_mode: Option<&str>,
) -> std::io::Result<()> {
    write_frequency_response_progress_artifact(
        output_dir,
        "running",
        "running",
        frequencies_hz.len(),
        0,
        0,
        first_frequency_response_hz(frequencies_hz),
        frequency_response_range_hz(frequencies_hz),
        demag_mode,
        None,
    )
}

#[cfg(any(feature = "fem-gpu", test))]
fn interrupted_frequency_response_point_artifact_count(output_dir: &Path) -> u64 {
    let frequency_points_dir = output_dir.join("response/frequency_points");
    let Ok(entries) = std::fs::read_dir(frequency_points_dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("frequency_") && name.ends_with(".json"))
        })
        .count() as u64
}

#[cfg(any(feature = "fem-gpu", test))]
fn write_interrupted_frequency_response_progress_artifact(
    output_dir: &Path,
    frequencies_hz: &[f64],
    demag_mode: Option<&str>,
) -> std::io::Result<()> {
    let written_frequency_point_artifacts =
        interrupted_frequency_response_point_artifact_count(output_dir);
    write_frequency_response_progress_artifact(
        output_dir,
        "interrupted",
        "interrupted",
        frequencies_hz.len(),
        written_frequency_point_artifacts,
        written_frequency_point_artifacts,
        first_frequency_response_hz(frequencies_hz),
        frequency_response_range_hz(frequencies_hz),
        demag_mode,
        None,
    )
}

#[cfg(any(feature = "fem-gpu", test))]
fn preserve_interrupted_frequency_response_progress_artifact_if_needed(
    output_dir: &Path,
    frequencies_hz: &[f64],
    demag_mode: Option<&str>,
    status: NativeFrequencyDomainStatus,
) -> std::io::Result<()> {
    let has_legacy_manifest = output_dir.join("response/artifact_manifest.json").is_file();
    let has_frequency_domain_manifest = output_dir
        .join("frequency_domain/manifest.v1.json")
        .is_file();
    if status == NativeFrequencyDomainStatus::Interrupted
        && !has_legacy_manifest
        && !has_frequency_domain_manifest
    {
        write_interrupted_frequency_response_progress_artifact(
            output_dir,
            frequencies_hz,
            demag_mode,
        )?;
    }
    Ok(())
}

#[cfg(any(feature = "fem-gpu", test))]
fn patch_frequency_response_manifest_equilibrium_provenance(
    output_dir: &Path,
    provenance: Option<&fullmag_ir::FemFrequencyDomainEquilibriumProvenanceIR>,
) -> std::io::Result<()> {
    let Some(provenance) = provenance else {
        return Ok(());
    };
    let manifest_path = output_dir.join("frequency_domain/manifest.v1.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path)?)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let manifest_object = manifest.as_object_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frequency-domain manifest must be a JSON object",
        )
    })?;
    manifest_object.insert(
        "equilibrium_provenance".to_string(),
        serde_json::to_value(provenance)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?,
    );
    std::fs::write(
        manifest_path,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?,
    )
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
    let trace_enabled = frequency_response_trace_enabled();
    let payload_start = Instant::now();
    if trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response payload: building requested_gpu={} nodes={} elements={} magnetic_bc={:?} magnetostatic_bc={:?}",
            requested_gpu,
            plan.mesh.nodes.len(),
            plan.mesh.elements.len(),
            frequency_response_effective_spin_wave_bc_kind(plan),
            plan.magnetostatic_bc
        );
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
    if trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response payload: built in {:.3}s compact_nodes={} exchange_edges={} static_pairs={} airbox_phi_pairs={} floquet_pairs={} demag_provider={}",
            payload_start.elapsed().as_secs_f64(),
            payload.equilibrium_magnetization.len(),
            payload.exchange_edges.len(),
            payload.static_periodic_node_pairs.len(),
            payload.periodic_airbox_magnetostatic_periodic_node_pairs.len(),
            payload.floquet_periodic_pairs.len(),
            payload.requires_native_backend_demag_tangent_provider
        );
    }
    let execution_lane = if requested_gpu {
        NativeFrequencyDomainExecutionLane::ProductionGpu
    } else {
        NativeFrequencyDomainExecutionLane::ProductionCpu
    };
    let node_count = payload.equilibrium_magnetization.len() as u64;
    let tangent_dof_count = node_count * 2;
    let stop_requested = AtomicBool::new(false);
    let cancel_callback = || {
        interrupt_requested.is_some_and(|flag| flag.load(Ordering::Relaxed))
            || stop_requested.load(Ordering::Relaxed)
    };
    let live_progress_sink = RefCell::new(on_step.as_deref_mut());
    let last_native_progress: RefCell<Option<NativeFrequencyDomainProgress>> = RefCell::new(None);
    let demag_mode = frequency_response_demag_mode(
        plan.enable_demag,
        payload.requires_periodic_airbox_dynamic_demag,
        payload.requires_floquet_airbox_dynamic_demag,
    );
    let response_frequency_range_hz = frequency_response_range_hz(&plan.frequencies_hz.values_hz);
    let progress_callback = |progress: NativeFrequencyDomainProgress| {
        *last_native_progress.borrow_mut() = Some(progress);
        if let Err(err) = write_native_frequency_response_progress_artifact(
            output_dir,
            progress,
            demag_mode,
            response_frequency_range_hz,
        ) {
            eprintln!(
                "[fullmag-runner] failed to write native FEM frequency-response progress artifact: {err}"
            );
        }
        if let Some(on_step) = live_progress_sink.borrow_mut().as_deref_mut() {
            let action = on_step(native_frequency_response_progress_update(
                progress,
                response_frequency_range_hz,
                payload.drive_norm,
                plan.enable_demag,
                payload.requires_periodic_airbox_dynamic_demag,
                payload.requires_floquet_airbox_dynamic_demag,
            ));
            if action != StepAction::Continue {
                stop_requested.store(true, Ordering::Relaxed);
            }
        }
    };
    let cancel_callback_ref: Option<&NativeFrequencyDomainCancelCallback<'_>> =
        Some(&cancel_callback);
    let progress_callback_ref: Option<&NativeFrequencyDomainProgressCallback<'_>> =
        Some(&progress_callback);
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
    let periodic_airbox_coupled_block_problem = periodic_airbox_coupled_block_problem(&payload);
    let mut demag_tangent_provider = if payload.requires_native_backend_demag_tangent_provider
        && periodic_airbox_coupled_block_problem.is_none()
        && !(requested_gpu && payload.requires_periodic_airbox_dynamic_demag)
    {
        Some(NativeBackendDemagTangentProvider::create(plan, &payload)?)
    } else {
        None
    };
    let demag_tangent_provider_user_data = demag_tangent_provider
        .as_mut()
        .map_or(std::ptr::null_mut(), |provider| {
            provider as *mut NativeBackendDemagTangentProvider as *mut c_void
        });
    let demag_tangent_provider_callback = demag_tangent_provider
        .as_ref()
        .map(|_| apply_native_backend_demag_tangent as _);
    let demag_tangent_provider_with_potential_callback = demag_tangent_provider
        .as_ref()
        .map(|_| apply_native_backend_demag_tangent_with_potential as _);
    let operator_diagnostics_json = plan.domain_mesh_workflow_mode.as_ref().map(|mode| {
        serde_json::json!({
            "schema_version": "frequency_domain_operator_diagnostics.v1",
            "domain_mesh_mode": mode,
        })
        .to_string()
    });
    write_initial_frequency_response_progress_artifact(
        output_dir,
        &plan.frequencies_hz.values_hz,
        demag_mode,
    )
    .map_err(|err| RunError {
        message: format!("failed to write initial FEM frequency-response progress artifact: {err}"),
    })?;
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
            operator_diagnostics_json: operator_diagnostics_json.as_deref(),
            interrupt_requested: None,
            cancel_requested: cancel_callback_ref,
            progress_callback: progress_callback_ref,
            requires_periodic_airbox_dynamic_demag: payload.requires_periodic_airbox_dynamic_demag,
            requires_floquet_airbox_dynamic_demag: payload.requires_floquet_airbox_dynamic_demag,
            magnetic_periodic_constraint_set_count: payload.magnetic_periodic_constraint_set_count,
            magnetostatic_periodic_constraint_set_count: payload
                .magnetostatic_periodic_constraint_set_count,
            periodic_airbox_delta_m_tangent_dof_count: payload
                .periodic_airbox_delta_m_tangent_dof_count,
            periodic_airbox_delta_phi_dof_count: payload.periodic_airbox_delta_phi_dof_count,
            periodic_airbox_magnetostatic_periodic_node_pairs: &payload
                .periodic_airbox_magnetostatic_periodic_node_pairs,
            periodic_airbox_coupled_block_problem,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &payload.equilibrium_magnetization,
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
                observable_ms_field: payload.observable_ms_field.as_deref(),
                observable_uniform_ms: payload.observable_uniform_ms,
                include_zeeman: true,
                static_periodic_node_pairs: &payload.static_periodic_node_pairs,
                floquet_k_vector_rad_per_m: payload.floquet_k_vector_rad_per_m,
                phase_convention: crate::native_fem::FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &floquet_periodic_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: demag_tangent_provider_callback,
                apply_demag_tangent_with_potential: demag_tangent_provider_with_potential_callback,
                demag_tangent_user_data: demag_tangent_provider_user_data,
                demag_tangent_matrix_row_major: None,
            }),
        });
    let native_result = native_result.map_err(|message| RunError {
        message: format!(
            "native FEM production {} frequency response is required for this plan but could not be invoked: {message}",
            if requested_gpu { "GPU" } else { "CPU" }
        ),
    })?;
    let final_native_progress = *last_native_progress.borrow();
    if let Some(progress) = final_native_progress {
        let final_written_frequency_point_artifacts =
            if native_result.written_frequency_point_artifacts > 0 {
                native_result.written_frequency_point_artifacts
            } else {
                interrupted_frequency_response_point_artifact_count(output_dir)
            };
        let final_artifact_manifest_path = if native_result.artifact_manifest_path.is_empty() {
            None
        } else {
            Some(native_result.artifact_manifest_path.as_str())
        };
        preserve_native_frequency_response_progress_artifact(
            output_dir,
            progress,
            demag_mode,
            response_frequency_range_hz,
            native_result.status,
            final_written_frequency_point_artifacts,
            final_artifact_manifest_path,
        )
        .map_err(|err| RunError {
                message: format!(
                    "native FEM frequency response finished, but the runner failed to preserve native progress telemetry: {err}"
                ),
            })?;
    }
    preserve_interrupted_frequency_response_progress_artifact_if_needed(
        output_dir,
        &plan.frequencies_hz.values_hz,
        demag_mode,
        native_result.status,
    )
    .map_err(|err| RunError {
        message: format!(
            "native FEM frequency response was interrupted, but the runner failed to preserve interrupted progress state: {err}"
        ),
    })?;
    patch_frequency_response_manifest_equilibrium_provenance(
        output_dir,
        plan.equilibrium_provenance.as_ref(),
    )
    .map_err(|err| RunError {
        message: format!(
            "native FEM frequency response finished, but the runner failed to preserve equilibrium provenance: {err}"
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
                } else if payload.requires_native_backend_demag_tangent_provider {
                    "native FEM production CPU periodic-airbox frequency response is unavailable until the native backend demag tangent provider is wired into the runner"
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
    if let Some(total_iteration_count) =
        frequency_domain_json_u64(diagnostics_json, "total_iteration_count")
    {
        details.push_str(", total_iteration_count=");
        details.push_str(&total_iteration_count.to_string());
    }
    if let Some(max_iterations_for_frequency) =
        frequency_domain_json_u64(diagnostics_json, "max_iterations_for_frequency")
    {
        details.push_str(", max_iterations_for_frequency=");
        details.push_str(&max_iterations_for_frequency.to_string());
    }
    if let Some(relative_residual_l2_norm) =
        frequency_domain_json_f64(diagnostics_json, "relative_residual_l2_norm")
    {
        details.push_str(", relative_residual_l2_norm=");
        details.push_str(&relative_residual_l2_norm.to_string());
    }
    if !error_message.is_empty() {
        details.push_str(": ");
        details.push_str(error_message);
    }
    details
}

#[cfg(any(feature = "fem-gpu", test))]
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

#[cfg(any(feature = "fem-gpu", test))]
fn native_frequency_domain_progress_status(status: NativeFrequencyDomainStatus) -> &'static str {
    match status {
        NativeFrequencyDomainStatus::Ok => "ready",
        other => native_frequency_domain_status_label(other),
    }
}

#[cfg(any(feature = "fem-gpu", test))]
fn native_frequency_domain_progress_state(status: NativeFrequencyDomainStatus) -> &'static str {
    match status {
        NativeFrequencyDomainStatus::Ok => "completed",
        other => native_frequency_domain_status_label(other),
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
fn frequency_domain_json_u64(json: &str, key: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|value| value.get(key).and_then(|number| number.as_u64()))
}

#[cfg(feature = "fem-gpu")]
fn frequency_domain_json_f64(json: &str, key: &str) -> Option<f64> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|value| value.get(key).and_then(|number| number.as_f64()))
}

#[cfg(feature = "fem-gpu")]
struct NativeProductionCpuPayload {
    equilibrium_magnetization: Vec<[f64; 3]>,
    magnetic_node_indices: Vec<usize>,
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
    observable_ms_field: Option<Vec<f64>>,
    observable_uniform_ms: f64,
    drive_norm: f64,
    static_periodic_node_pairs: Vec<NativeDrivenFrequencyResponsePeriodicNodePair>,
    floquet_k_vector_rad_per_m: Option<[f64; 3]>,
    floquet_periodic_pairs: Vec<FloquetPeriodicPairMetadata>,
    periodic_airbox_magnetostatic_periodic_node_pairs:
        Vec<NativeDrivenFrequencyResponsePeriodicNodePair>,
    requires_periodic_airbox_dynamic_demag: bool,
    requires_floquet_airbox_dynamic_demag: bool,
    requires_native_backend_demag_tangent_provider: bool,
    magnetic_periodic_constraint_set_count: u64,
    magnetostatic_periodic_constraint_set_count: u64,
    periodic_airbox_delta_m_tangent_dof_count: u64,
    periodic_airbox_delta_phi_dof_count: u64,
}

#[cfg(feature = "fem-gpu")]
fn periodic_airbox_coupled_block_problem(
    _payload: &NativeProductionCpuPayload,
) -> Option<NativeDrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem<'_>> {
    None
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
struct NativeBackendDemagTangentProvider {
    backend: NativeFemBackend,
    tangent_basis: Vec<([f64; 3], [f64; 3])>,
    magnetic_node_indices: Vec<usize>,
    full_node_count: usize,
    trace_enabled: bool,
}

#[cfg(feature = "fem-gpu")]
impl NativeBackendDemagTangentProvider {
    fn create(
        plan: &fullmag_ir::FemFrequencyResponsePlanIR,
        payload: &NativeProductionCpuPayload,
    ) -> Result<Self, RunError> {
        let backend_plan = frequency_response_demag_backend_plan(plan);
        let trace_enabled = frequency_response_trace_enabled();
        let create_start = Instant::now();
        if trace_enabled {
            eprintln!(
                "[fullmag-runner] frequency-response demag tangent provider: creating backend nodes={} elements={} demag={} exchange={} periodic_node_pairs={} source_exchange={} source_periodic_node_pairs={}",
                plan.mesh.nodes.len(),
                plan.mesh.elements.len(),
                plan.enable_demag,
                backend_plan.enable_exchange,
                backend_plan.mesh.periodic_node_pairs.len(),
                plan.enable_exchange,
                plan.mesh.periodic_node_pairs.len()
            );
        }
        let mut backend =
            NativeFemBackend::create_with_initial_effective_field(&backend_plan, false)?;
        if trace_enabled {
            eprintln!(
                "[fullmag-runner] frequency-response demag tangent provider: backend created in {:.3}s",
                create_start.elapsed().as_secs_f64()
            );
        }
        let upload_start = Instant::now();
        backend.upload_magnetization(&plan.equilibrium_magnetization)?;
        if trace_enabled {
            eprintln!(
                "[fullmag-runner] frequency-response demag tangent provider: equilibrium uploaded in {:.3}s",
                upload_start.elapsed().as_secs_f64()
            );
        }
        let basis_start = Instant::now();
        let tangent_basis = payload
            .equilibrium_magnetization
            .iter()
            .map(|m| {
                tangent_basis(*m).ok_or_else(|| RunError {
                    message:
                        "FEM frequency response equilibrium magnetization must define tangent bases"
                            .to_string(),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if trace_enabled {
            eprintln!(
                "[fullmag-runner] frequency-response demag tangent provider: tangent basis built in {:.3}s",
                basis_start.elapsed().as_secs_f64()
            );
        }
        Ok(Self {
            backend,
            tangent_basis,
            magnetic_node_indices: payload.magnetic_node_indices.clone(),
            full_node_count: plan.equilibrium_magnetization.len(),
            trace_enabled,
        })
    }
}

#[cfg(feature = "fem-gpu")]
fn frequency_response_demag_backend_plan(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> fullmag_ir::FemPlanIR {
    fullmag_ir::FemPlanIR {
        mesh_name: plan.mesh_name.clone(),
        mesh_source: plan.mesh_source.clone(),
        mesh: plan.mesh.clone(),
        object_segments: plan.object_segments.clone(),
        mesh_parts: plan.mesh_parts.clone(),
        domain_mesh_mode: plan.domain_mesh_mode,
        domain_frame: plan.domain_frame.clone(),
        fe_order: plan.fe_order,
        hmax: plan.hmax,
        initial_magnetization: plan.equilibrium_magnetization.clone(),
        material: plan.material.clone(),
        anisotropy_axis_field: None,
        ms_element_field: None,
        a_element_field: None,
        region_materials: Vec::new(),
        enable_exchange: plan.enable_exchange || !plan.mesh.periodic_node_pairs.is_empty(),
        enable_demag: plan.enable_demag,
        external_field: plan.external_field,
        antenna_zeeman_masks: Vec::new(),
        current_modules: Vec::new(),
        gyromagnetic_ratio: plan.gyromagnetic_ratio,
        precision: plan.precision,
        exchange_bc: plan.exchange_bc,
        integrator: fullmag_ir::IntegratorChoice::Heun,
        fixed_timestep: Some(1.0e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: None,
        demag_realization: plan.demag_realization,
        air_box_config: None,
        interfacial_dmi: None,
        dmi_interface_normal: None,
        bulk_dmi: None,
        dind_field: None,
        dbulk_field: None,
        temperature: None,
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        magnetoelastic: None,
        mechanics: None,
        demag_solver_policy: plan.demag_solver_policy.clone(),
        thermal_seed_config: None,
        oersted_realization: None,
        gpu_device_index: None,
        mfem_device_string: Some("cpu".to_string()),
        use_consistent_mass: None,
    }
}

#[cfg(feature = "fem-gpu")]
unsafe fn write_native_callback_error(error_message: *mut c_char, message: &str) {
    if error_message.is_null() {
        return;
    }
    let bytes = message.as_bytes();
    let len = bytes.len().min(127);
    for (index, byte) in bytes.iter().take(len).enumerate() {
        unsafe {
            *error_message.add(index) = *byte as c_char;
        }
    }
    unsafe {
        *error_message.add(len) = 0;
    }
}

#[cfg(feature = "fem-gpu")]
unsafe extern "C" fn apply_native_backend_demag_tangent(
    user_data: *mut c_void,
    in_: *const f64,
    out: *mut f64,
    error_message: *mut c_char,
) -> ffi::fullmag_fem_frequency_domain_status {
    if user_data.is_null() || in_.is_null() || out.is_null() {
        unsafe {
            write_native_callback_error(
                error_message,
                "native demag tangent callback received null buffer",
            );
        }
        return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
    }
    let provider = unsafe { &mut *user_data.cast::<NativeBackendDemagTangentProvider>() };
    let node_count = provider.tangent_basis.len();
    let tangent_dof_count = node_count * 2;
    if provider.magnetic_node_indices.len() != node_count {
        unsafe {
            write_native_callback_error(
                error_message,
                "native demag tangent callback has inconsistent magnetic node mapping",
            );
        }
        return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
    }
    let tangent_in = unsafe { std::slice::from_raw_parts(in_, tangent_dof_count) };
    let tangent_out = unsafe { std::slice::from_raw_parts_mut(out, tangent_dof_count) };
    if tangent_in.iter().all(|value| *value == 0.0) {
        tangent_out.fill(0.0);
        return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK;
    }
    let mut delta_m = vec![[0.0; 3]; provider.full_node_count];
    for (node_index, (e1, e2)) in provider.tangent_basis.iter().enumerate() {
        let c1 = tangent_in[node_index * 2];
        let c2 = tangent_in[node_index * 2 + 1];
        let full_node_index = provider.magnetic_node_indices[node_index];
        if full_node_index >= provider.full_node_count {
            unsafe {
                write_native_callback_error(
                    error_message,
                    "native demag tangent callback magnetic node index is out of range",
                );
            }
            return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
        }
        delta_m[full_node_index] = [
            c1 * e1[0] + c2 * e2[0],
            c1 * e1[1] + c2 * e2[1],
            c1 * e1[2] + c2 * e2[2],
        ];
    }
    let apply_start = Instant::now();
    if provider.trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response demag tangent provider: applying demag tangent nodes={}",
            node_count
        );
    }
    let delta_h = match provider.backend.apply_demag_tangent(&delta_m) {
        Ok(delta_h) => delta_h,
        Err(err) => {
            unsafe {
                write_native_callback_error(error_message, &err.message);
            }
            return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
        }
    };
    if provider.trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response demag tangent provider: demag tangent applied in {:.3}s",
            apply_start.elapsed().as_secs_f64()
        );
    }
    if delta_h.len() != provider.full_node_count {
        unsafe {
            write_native_callback_error(
                error_message,
                "native demag tangent callback returned inconsistent node count",
            );
        }
        return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
    }
    for (node_index, (e1, e2)) in provider.tangent_basis.iter().enumerate() {
        let full_node_index = provider.magnetic_node_indices[node_index];
        tangent_out[node_index * 2] = dot3(delta_h[full_node_index], *e1);
        tangent_out[node_index * 2 + 1] = dot3(delta_h[full_node_index], *e2);
    }
    ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK
}

#[cfg(feature = "fem-gpu")]
unsafe extern "C" fn apply_native_backend_demag_tangent_with_potential(
    user_data: *mut c_void,
    in_: *const f64,
    out: *mut f64,
    out_phi: *mut f64,
    out_phi_len: u64,
    error_message: *mut c_char,
) -> ffi::fullmag_fem_frequency_domain_status {
    if user_data.is_null() || in_.is_null() || out.is_null() || out_phi.is_null() {
        unsafe {
            write_native_callback_error(
                error_message,
                "native demag tangent-with-potential callback received null buffer",
            );
        }
        return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
    }
    let provider = unsafe { &mut *user_data.cast::<NativeBackendDemagTangentProvider>() };
    let node_count = provider.tangent_basis.len();
    let tangent_dof_count = node_count * 2;
    if provider.magnetic_node_indices.len() != node_count {
        unsafe {
            write_native_callback_error(
                error_message,
                "native demag tangent-with-potential callback has inconsistent magnetic node mapping",
            );
        }
        return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
    }
    let tangent_in = unsafe { std::slice::from_raw_parts(in_, tangent_dof_count) };
    let tangent_out = unsafe { std::slice::from_raw_parts_mut(out, tangent_dof_count) };
    let phi_out = unsafe { std::slice::from_raw_parts_mut(out_phi, out_phi_len as usize) };
    if tangent_in.iter().all(|value| *value == 0.0) {
        tangent_out.fill(0.0);
        phi_out.fill(0.0);
        return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK;
    }
    let mut delta_m = vec![[0.0; 3]; provider.full_node_count];
    for (node_index, (e1, e2)) in provider.tangent_basis.iter().enumerate() {
        let c1 = tangent_in[node_index * 2];
        let c2 = tangent_in[node_index * 2 + 1];
        let full_node_index = provider.magnetic_node_indices[node_index];
        if full_node_index >= provider.full_node_count {
            unsafe {
                write_native_callback_error(
                    error_message,
                    "native demag tangent-with-potential callback magnetic node index is out of range",
                );
            }
            return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
        }
        delta_m[full_node_index] = [
            c1 * e1[0] + c2 * e2[0],
            c1 * e1[1] + c2 * e2[1],
            c1 * e1[2] + c2 * e2[2],
        ];
    }
    let apply_start = Instant::now();
    if provider.trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response demag tangent provider: applying demag tangent with potential nodes={}",
            node_count
        );
    }
    let (delta_h, delta_phi) = match provider
        .backend
        .apply_demag_tangent_with_potential(&delta_m)
    {
        Ok(values) => values,
        Err(err) => {
            unsafe {
                write_native_callback_error(error_message, &err.message);
            }
            return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
        }
    };
    if provider.trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response demag tangent provider: demag tangent with potential applied in {:.3}s",
            apply_start.elapsed().as_secs_f64()
        );
    }
    if delta_h.len() != provider.full_node_count || delta_phi.len() != phi_out.len() {
        unsafe {
            write_native_callback_error(
                error_message,
                "native demag tangent-with-potential callback returned inconsistent node count",
            );
        }
        return ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR;
    }
    for (node_index, (e1, e2)) in provider.tangent_basis.iter().enumerate() {
        let full_node_index = provider.magnetic_node_indices[node_index];
        tangent_out[node_index * 2] = dot3(delta_h[full_node_index], *e1);
        tangent_out[node_index * 2 + 1] = dot3(delta_h[full_node_index], *e2);
    }
    phi_out.copy_from_slice(&delta_phi);
    ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK
}

#[cfg(feature = "fem-gpu")]
fn build_native_production_cpu_payload(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<NativeProductionCpuPayload> {
    if production_cpu_frequency_response_rejection_reason(plan).is_some() {
        return None;
    }
    build_native_production_payload(plan)
}

#[cfg(feature = "fem-gpu")]
fn build_native_production_gpu_payload(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<NativeProductionCpuPayload> {
    if production_gpu_frequency_response_rejection_reason(plan).is_some() {
        return None;
    }
    build_native_production_payload(plan)
}

#[cfg(feature = "fem-gpu")]
fn build_native_production_payload(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<NativeProductionCpuPayload> {
    let trace_enabled = frequency_response_trace_enabled();
    let build_start = Instant::now();
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
    if trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response payload: material terms built in {:.3}s",
            build_start.elapsed().as_secs_f64()
        );
    }
    let excitation = plan.excitation.field_au_per_m;
    if !plan.excitation.phase_rad.is_finite() {
        return None;
    }
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
    let compact_start = Instant::now();
    let magnetic_node_indices = frequency_response_magnetic_node_indices(plan)?;
    let node_index_map =
        compact_node_index_map(plan.equilibrium_magnetization.len(), &magnetic_node_indices)?;
    let equilibrium_magnetization = magnetic_node_indices
        .iter()
        .map(|node_index| plan.equilibrium_magnetization[*node_index])
        .collect::<Vec<_>>();
    let observable_ms_field =
        build_frequency_response_observable_ms_field(plan, &magnetic_node_indices)?;
    let alpha_per_node = alpha_per_node.map(|values| {
        magnetic_node_indices
            .iter()
            .map(|node_index| values[*node_index])
            .collect::<Vec<_>>()
    });
    if trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response payload: compacted magnetic nodes in {:.3}s compact_nodes={} full_nodes={}",
            compact_start.elapsed().as_secs_f64(),
            equilibrium_magnetization.len(),
            plan.equilibrium_magnetization.len()
        );
    }
    let exchange_start = Instant::now();
    let exchange_edges = if plan.enable_exchange {
        build_exchange_edges(plan, &node_index_map)?
    } else {
        Vec::new()
    };
    if trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response payload: exchange edges built in {:.3}s count={}",
            exchange_start.elapsed().as_secs_f64(),
            exchange_edges.len()
        );
    }
    let periodic_start = Instant::now();
    let static_periodic_node_pairs = build_static_periodic_node_pairs(plan, &node_index_map)?;
    let floquet_periodic_pairs = build_floquet_periodic_pairs(plan, &node_index_map)?;
    let periodic_airbox_magnetostatic_periodic_node_pairs =
        build_periodic_airbox_magnetostatic_periodic_node_pairs(plan)?;
    if trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response payload: periodic metadata built in {:.3}s static_pairs={} floquet_pairs={} airbox_phi_pairs={}",
            periodic_start.elapsed().as_secs_f64(),
            static_periodic_node_pairs.len(),
            floquet_periodic_pairs.len(),
            periodic_airbox_magnetostatic_periodic_node_pairs.len()
        );
    }
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
    if trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response payload: dmi payload built in {:.3}s elements={}",
            build_start.elapsed().as_secs_f64(),
            dmi_payload.elements.len()
        );
    }
    let floquet_node_phases = if frequency_response_effective_spin_wave_bc_kind(plan)
        == fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    {
        Some(build_floquet_node_phases(
            equilibrium_magnetization.len(),
            &floquet_periodic_pairs,
        )?)
    } else {
        None
    };
    let mut drive_tangent_real = Vec::with_capacity(equilibrium_magnetization.len() * 2);
    let mut drive_tangent_imag = Vec::with_capacity(equilibrium_magnetization.len() * 2);
    for (node_index, m) in equilibrium_magnetization.iter().enumerate() {
        let (e1, e2) = tangent_basis(*m)?;
        let tangent_e1 = dot3(excitation, e1);
        let tangent_e2 = dot3(excitation, e2);
        let node_phase = plan.excitation.phase_rad
            + floquet_node_phases
                .as_ref()
                .map(|phases| phases[node_index])
                .unwrap_or(0.0);
        let node_phase_cos = node_phase.cos();
        let node_phase_sin = node_phase.sin();
        drive_tangent_real.push(tangent_e1 * node_phase_cos);
        drive_tangent_real.push(tangent_e2 * node_phase_cos);
        drive_tangent_imag.push(tangent_e1 * node_phase_sin);
        drive_tangent_imag.push(tangent_e2 * node_phase_sin);
    }
    if trace_enabled {
        eprintln!(
            "[fullmag-runner] frequency-response payload: tangent drive built in {:.3}s dofs={}",
            build_start.elapsed().as_secs_f64(),
            drive_tangent_real.len()
        );
    }
    let periodic_airbox_delta_m_tangent_dof_count = drive_tangent_real.len() as u64;
    Some(NativeProductionCpuPayload {
        equilibrium_magnetization,
        magnetic_node_indices,
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
        observable_ms_field,
        observable_uniform_ms: plan.material.saturation_magnetisation,
        drive_norm,
        static_periodic_node_pairs,
        floquet_k_vector_rad_per_m,
        floquet_periodic_pairs,
        periodic_airbox_magnetostatic_periodic_node_pairs,
        requires_periodic_airbox_dynamic_demag: plan.magnetostatic_bc
            == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0,
        requires_floquet_airbox_dynamic_demag: plan.magnetostatic_bc
            == fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox,
        requires_native_backend_demag_tangent_provider: plan.enable_demag
            && plan.demag_realization.is_some()
            && !matches!(
                plan.magnetostatic_bc,
                fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox
            ),
        periodic_airbox_delta_m_tangent_dof_count,
        periodic_airbox_delta_phi_dof_count: if matches!(
            plan.magnetostatic_bc,
            fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0
                | fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox
        ) {
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
fn build_frequency_response_observable_ms_field(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
    magnetic_node_indices: &[usize],
) -> Option<Option<Vec<f64>>> {
    if !plan.material.saturation_magnetisation.is_finite()
        || plan.material.saturation_magnetisation <= 0.0
    {
        return None;
    }
    let Some(values) = plan.material.ms_field.as_ref() else {
        return Some(None);
    };
    if values.len() != plan.equilibrium_magnetization.len()
        || values
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return None;
    }
    Some(Some(
        magnetic_node_indices
            .iter()
            .map(|node_index| values[*node_index])
            .collect::<Vec<_>>(),
    ))
}

fn production_cpu_frequency_response_rejection_reason(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<&'static str> {
    if plan.fe_order != 1 {
        return Some(
            "production CPU frequency response currently supports only first-order P1 tetrahedral FEM meshes",
        );
    }
    let has_nonzero_k = plan
        .k_sampling
        .as_ref()
        .is_some_and(|k_sampling| !k_sampling.is_single_gamma());
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
        if plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh
            && plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
        {
            return Some(
                "production CPU frequency response currently supports only magnetic-body meshes or compacted shared-domain magnetic slices",
            );
        }
        if plan.enable_demag != plan.demag_realization.is_some() {
            return Some(
                "dynamic demag requires include_demag=true and a resolved Demag energy term",
            );
        }
    }
    #[cfg(not(feature = "fem-gpu"))]
    if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
        return Some(
            "DMI frequency response requires the native FEM production CPU solver to be enabled",
        );
    }
    if has_nonzero_k && plan.spin_wave_bc.kind() != fullmag_ir::SpinWaveBoundaryKindIR::Floquet {
        return Some(
            "nonzero-k Floquet/Bloch response is not implemented for production CPU frequency response",
        );
    }
    if has_nonzero_k && has_requested_dmi(plan) {
        return Some(
            "DMI is not implemented for nonzero-k Floquet production CPU frequency response",
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
            if let Some(reason) = static_periodic_frequency_response_rejection_reason(plan) {
                return Some(reason);
            }
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
    let has_nonzero_k = plan
        .k_sampling
        .as_ref()
        .is_some_and(|k_sampling| !k_sampling.is_single_gamma());
    if plan.magnetostatic_bc == fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox {
        if plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir {
            return Some("magnetostatic_bc=floquet_airbox requires a shared-domain airbox mesh");
        }
        if !plan.enable_demag || plan.demag_realization.is_none() {
            return Some(
                "magnetostatic_bc=floquet_airbox requires include_demag=true and a Demag energy term",
            );
        }
        if has_requested_dmi(plan) {
            return Some("DMI is not implemented for production GPU frequency response");
        }
        if !has_nonzero_k {
            return Some("magnetostatic_bc=floquet_airbox requires nonzero k");
        }
        if frequency_response_effective_spin_wave_bc_kind(plan)
            != fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        {
            return Some(
                "magnetostatic_bc=floquet_airbox requires spin_wave_bc=floquet for the dynamic magnetization",
            );
        }
        if !plan.periodic_constraint_sets.iter().any(|constraint| {
            constraint.unknown_family == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                && constraint.domain_scope == fullmag_ir::PeriodicDomainScopeIR::MagneticDomain
                && matches!(
                    constraint.phase_policy,
                    fullmag_ir::PeriodicPhasePolicyIR::BlochPhase { .. }
                )
        }) {
            return Some("magnetostatic_bc=floquet_airbox requires a delta_m Bloch constraint set");
        }
        if !plan.periodic_constraint_sets.iter().any(|constraint| {
            constraint.unknown_family
                == fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic
                && constraint.domain_scope
                    == fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir
                && matches!(
                    constraint.phase_policy,
                    fullmag_ir::PeriodicPhasePolicyIR::BlochPhase { .. }
                )
        }) {
            return Some(
                "magnetostatic_bc=floquet_airbox requires a delta_phi Bloch constraint set",
            );
        }
        return None;
    }
    if plan.magnetostatic_bc == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0 {
        return Some(
            "magnetostatic_bc=periodic_airbox_k0 is not implemented for production GPU frequency response; use CPU for periodic-airbox dynamic demag or magnetostatic_bc=open for the current GPU static-periodic magnetic slice",
        );
    }
    let gpu_shared_domain_supported = plan.requested_device == fullmag_ir::ExecutionDevice::Gpu
        && plan.domain_mesh_mode == fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir;
    if plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh
        && !gpu_shared_domain_supported
    {
        return Some(
            "production GPU frequency response currently supports only magnetic-body meshes or compacted shared-domain magnetic slices",
        );
    }
    if plan.enable_demag != plan.demag_realization.is_some() {
        return Some("dynamic demag requires include_demag=true and a resolved Demag energy term");
    }
    if has_requested_dmi(plan) {
        return Some("DMI is not implemented for production GPU frequency response");
    }
    if has_nonzero_k && plan.spin_wave_bc.kind() != fullmag_ir::SpinWaveBoundaryKindIR::Floquet {
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
            if let Some(reason) = static_periodic_frequency_response_rejection_reason(plan) {
                return Some(reason);
            }
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

    let mut boundary_pair_metadata = BTreeMap::<&str, ([f64; 3], f64)>::new();
    for boundary_pair in &plan.mesh.periodic_boundary_pairs {
        let pair_id = boundary_pair.pair_id.as_str();
        if pair_id.is_empty() {
            return Some(
                "static periodic frequency response requires non-empty periodic boundary pair ids",
            );
        }
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
        let tolerance = boundary_pair.tolerance.unwrap_or(1.0e-9).max(0.0);
        if let Some((reference_translation, reference_tolerance)) =
            boundary_pair_metadata.get_mut(pair_id)
        {
            let delta = [
                translation[0] - reference_translation[0],
                translation[1] - reference_translation[1],
                translation[2] - reference_translation[2],
            ];
            let delta_norm =
                (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]).sqrt();
            let allowed = tolerance.max(*reference_tolerance);
            if !delta_norm.is_finite() || delta_norm > allowed {
                return Some(
                    "static periodic frequency response requires consistent periodic boundary pair translations per pair id",
                );
            }
            *reference_tolerance = reference_tolerance.max(tolerance);
        } else {
            boundary_pair_metadata.insert(pair_id, (translation, tolerance));
        }
    }
    for pair_id in &selected_boundary_pair_ids {
        if !boundary_pair_metadata.contains_key(pair_id) {
            return Some(
                "static periodic frequency response requested an unknown periodic boundary pair",
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
        let Some((translation, tolerance)) =
            boundary_pair_metadata.get(pair.pair_id.as_str()).copied()
        else {
            return Some(
                "static periodic frequency response requires periodic node pairs to reference known boundary pair ids",
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

#[cfg(any(feature = "fem-gpu", test))]
fn frequency_response_magnetic_node_indices(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> Option<Vec<usize>> {
    if plan.mesh.nodes.len() != plan.equilibrium_magnetization.len() {
        return None;
    }
    let indices =
        if plan.domain_mesh_mode == fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir {
            plan.equilibrium_magnetization
                .iter()
                .enumerate()
                .filter_map(|(node_index, m)| {
                    let norm = dot3(*m, *m).sqrt();
                    (norm > 1.0e-12).then_some(node_index)
                })
                .collect::<Vec<_>>()
        } else {
            (0..plan.equilibrium_magnetization.len()).collect::<Vec<_>>()
        };
    if indices.is_empty() {
        return None;
    }
    Some(indices)
}

#[cfg(any(feature = "fem-gpu", test))]
fn compact_node_index_map(
    full_node_count: usize,
    magnetic_node_indices: &[usize],
) -> Option<Vec<Option<u64>>> {
    let mut map = vec![None; full_node_count];
    for (compact_index, full_index) in magnetic_node_indices.iter().copied().enumerate() {
        if full_index >= full_node_count || map[full_index].is_some() {
            return None;
        }
        map[full_index] = Some(compact_index as u64);
    }
    Some(map)
}

#[cfg(feature = "fem-gpu")]
fn build_static_periodic_node_pairs(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
    node_index_map: &[Option<u64>],
) -> Option<Vec<NativeDrivenFrequencyResponsePeriodicNodePair>> {
    if frequency_response_effective_spin_wave_bc_kind(plan)
        != fullmag_ir::SpinWaveBoundaryKindIR::Periodic
    {
        return Some(Vec::new());
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let mut pairs = Vec::new();
    for pair in &plan.mesh.periodic_node_pairs {
        if !requested_pair_ids.is_empty() && !requested_pair_ids.contains(&pair.pair_id.as_str()) {
            continue;
        }
        let node_a = node_index_map.get(pair.node_a as usize).copied().flatten();
        let node_b = node_index_map.get(pair.node_b as usize).copied().flatten();
        let (Some(node_a), Some(node_b)) = (node_a, node_b) else {
            continue;
        };
        if node_a == node_b {
            return None;
        }
        pairs.push(NativeDrivenFrequencyResponsePeriodicNodePair { node_a, node_b });
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
    if !matches!(
        plan.magnetostatic_bc,
        fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0
            | fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox
    ) {
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
    node_index_map: &[Option<u64>],
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

    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let mut pairs = Vec::new();
    for pair in &plan.mesh.periodic_node_pairs {
        if !requested_pair_ids.is_empty() && !requested_pair_ids.contains(&pair.pair_id.as_str()) {
            continue;
        }
        let node_a = node_index_map.get(pair.node_a as usize).copied().flatten();
        let node_b = node_index_map.get(pair.node_b as usize).copied().flatten();
        let (Some(node_a), Some(node_b)) = (node_a, node_b) else {
            continue;
        };
        if node_a == node_b {
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
            node_a,
            node_b,
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
fn build_floquet_node_phases(
    node_count: usize,
    pairs: &[FloquetPeriodicPairMetadata],
) -> Option<Vec<f64>> {
    let mut phases = vec![None::<f64>; node_count];
    for seed in 0..node_count {
        if phases[seed].is_some() {
            continue;
        }
        phases[seed] = Some(0.0);
        let mut changed = true;
        while changed {
            changed = false;
            for pair in pairs {
                let node_a = pair.node_a as usize;
                let node_b = pair.node_b as usize;
                if node_a >= node_count || node_b >= node_count {
                    return None;
                }
                match (phases[node_a], phases[node_b]) {
                    (Some(phase_a), Some(phase_b)) => {
                        if wrapped_phase_residual(phase_b - phase_a - pair.phase_rad).abs() > 1.0e-9
                        {
                            return None;
                        }
                    }
                    (Some(phase_a), None) => {
                        phases[node_b] = Some(phase_a + pair.phase_rad);
                        changed = true;
                    }
                    (None, Some(phase_b)) => {
                        phases[node_a] = Some(phase_b - pair.phase_rad);
                        changed = true;
                    }
                    (None, None) => {}
                }
            }
        }
    }
    phases.into_iter().collect()
}

#[cfg(feature = "fem-gpu")]
fn wrapped_phase_residual(phase_rad: f64) -> f64 {
    let two_pi = 2.0 * std::f64::consts::PI;
    let mut value = (phase_rad + std::f64::consts::PI).rem_euclid(two_pi) - std::f64::consts::PI;
    if value <= -std::f64::consts::PI {
        value += two_pi;
    }
    value
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
    node_index_map: &[Option<u64>],
) -> Option<Vec<NativeDrivenFrequencyResponseExchangeEdge>> {
    if !plan.material.exchange_stiffness.is_finite() || plan.material.exchange_stiffness <= 0.0 {
        return None;
    }
    if plan.mesh.nodes.len() != node_index_map.len() {
        return None;
    }
    if !plan.mesh.element_markers.is_empty()
        && plan.mesh.element_markers.len() != plan.mesh.elements.len()
    {
        return None;
    }
    let mut pairs = std::collections::BTreeSet::<(usize, usize)>::new();
    for (element_index, element) in plan.mesh.elements.iter().enumerate() {
        if plan
            .mesh
            .element_markers
            .get(element_index)
            .is_some_and(|marker| *marker == 0)
        {
            continue;
        }
        let mut compact_element = Vec::with_capacity(element.len());
        let mut has_airbox_node = false;
        for node in element {
            let Some(node) = node_index_map.get(*node as usize).copied().flatten() else {
                has_airbox_node = true;
                break;
            };
            compact_element.push(node as usize);
        }
        if has_airbox_node {
            continue;
        }
        for left in 0..element.len() {
            for right in (left + 1)..element.len() {
                let i = compact_element[left];
                let j = compact_element[right];
                if i == j {
                    return None;
                }
                pairs.insert(if i < j { (i, j) } else { (j, i) });
            }
        }
    }
    match frequency_response_effective_spin_wave_bc_kind(plan) {
        fullmag_ir::SpinWaveBoundaryKindIR::Periodic
        | fullmag_ir::SpinWaveBoundaryKindIR::Floquet => {
            let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
            for pair in &plan.mesh.periodic_node_pairs {
                if !requested_pair_ids.is_empty()
                    && !requested_pair_ids.contains(&pair.pair_id.as_str())
                {
                    continue;
                }
                let i = node_index_map.get(pair.node_a as usize).copied().flatten();
                let j = node_index_map.get(pair.node_b as usize).copied().flatten();
                let (Some(i), Some(j)) = (i, j) else {
                    continue;
                };
                let i = i as usize;
                let j = j as usize;
                if i == j {
                    return None;
                }
                pairs.insert(if i < j { (i, j) } else { (j, i) });
            }
        }
        _ => {}
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

#[cfg(any(feature = "fem-gpu", test))]
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

    fn source_block<'a>(source: &'a str, start_marker: &str, end_marker: &str) -> &'a str {
        let start = source.find(start_marker).expect(start_marker);
        let rest = &source[start..];
        let end = rest.find(end_marker).expect(end_marker);
        &rest[..end]
    }

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

        let update = native_frequency_response_progress_update(
            progress,
            Some((1.0e9, 4.0e9)),
            3.5,
            true,
            true,
            false,
        );

        assert_eq!(update.stats.step, 2);
        assert_eq!(update.stats.max_h_eff, 3.5);
        assert_eq!(update.grid, [0, 0, 0]);
        assert!(!update.finished);
        let live_progress = update
            .stats
            .per_object_scalars
            .get("fem_frequency_response_progress")
            .expect("frequency response progress should be published for live telemetry");
        assert_eq!(live_progress["frequency_index"], 1.0);
        assert_eq!(live_progress["completed_frequency_count"], 2.0);
        assert_eq!(live_progress["total_frequency_count"], 4.0);
        assert_eq!(live_progress["iteration"], 17.0);
        assert_eq!(
            live_progress["max_iterations_for_frequency"],
            native_frequency_response_max_iterations_for_progress() as f64
        );
        assert_eq!(live_progress["current_frequency_solve_fraction"], 1.0);
        assert_eq!(live_progress["frequency_hz"], 2.0e9);
        assert_eq!(live_progress["frequency_min_hz"], 1.0e9);
        assert_eq!(live_progress["frequency_max_hz"], 4.0e9);
        assert_eq!(live_progress["relative_residual_l2_norm"], 2.0e-9);
        assert_eq!(live_progress["percent"], 50.0);
        assert_eq!(live_progress["demag_enabled"], 1.0);
        assert_eq!(live_progress["demag_periodic_airbox_k0"], 1.0);
    }

    #[test]
    fn native_frequency_response_progress_percent_advances_inside_current_solve() {
        let max_iterations = native_frequency_response_max_iterations_for_progress();
        let iteration_count = max_iterations.saturating_div(2).max(1);
        let expected_fraction = (iteration_count as f64 / max_iterations as f64).clamp(0.0, 1.0);
        let progress = NativeFrequencyDomainProgress {
            frequency_index: 0,
            completed_frequency_count: 0,
            total_frequency_count: 4,
            iteration_count,
            frequency_hz: 2.0e9,
            residual_l2_norm: 1.0e-4,
            relative_residual_l2_norm: 5.0e-1,
            converged: false,
        };

        let update = native_frequency_response_progress_update(
            progress,
            Some((2.0e9, 5.0e9)),
            1.0,
            true,
            true,
            false,
        );

        let live_progress = update
            .stats
            .per_object_scalars
            .get("fem_frequency_response_progress")
            .expect("frequency response progress should be published for live telemetry");
        assert_eq!(
            live_progress["max_iterations_for_frequency"],
            max_iterations as f64
        );
        assert_eq!(
            live_progress["current_frequency_solve_fraction"],
            expected_fraction
        );
        assert_eq!(live_progress["percent"], expected_fraction * 25.0);
    }

    #[test]
    fn initial_frequency_response_progress_artifact_is_written_before_first_point() {
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-initial-progress-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_initial_frequency_response_progress_artifact(
            &output_dir,
            &[2.0e9, 3.5e9, 5.0e9],
            Some("periodic_airbox_k0"),
        )
        .expect("initial frequency-response progress should be written");

        let progress_path = output_dir.join("response/progress.v1.json");
        let progress: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&progress_path).expect("progress artifact should exist"),
        )
        .expect("progress artifact should parse");
        assert_eq!(
            progress["schema_version"],
            "frequency_domain_sweep_progress.v1"
        );
        assert_eq!(progress["status"], "running");
        assert_eq!(progress["state"], "running");
        assert_eq!(progress["complete"], false);
        assert_eq!(progress["total_frequency_points"], 3);
        assert_eq!(progress["completed_frequency_points"], 0);
        assert_eq!(progress["written_frequency_point_artifacts"], 0);
        assert_eq!(progress["partial_artifacts_available"], false);
        assert_eq!(
            progress["latest_artifact_manifest_path"],
            serde_json::Value::Null
        );
        assert_eq!(progress["current_frequency_hz"], 2.0e9);
        assert_eq!(progress["frequency_min_hz"], 2.0e9);
        assert_eq!(progress["frequency_max_hz"], 5.0e9);
        assert_eq!(progress["demag_mode"], "periodic_airbox_k0");
        let progress_json = progress["progress_json"]
            .as_str()
            .expect("progress_json should be a string");
        let progress_json_value: serde_json::Value =
            serde_json::from_str(progress_json).expect("progress_json should parse");
        assert_eq!(progress_json_value["status"], "running");
        assert_eq!(progress_json_value["complete"], false);
        assert!(progress_json.contains("\"state\":\"running\""));
        assert!(progress_json.contains("\"current_frequency_hz\":2000000000.0"));
        assert!(progress_json.contains("\"frequency_min_hz\":2000000000.0"));
        assert!(progress_json.contains("\"frequency_max_hz\":5000000000.0"));
        assert!(progress_json.contains("\"demag_mode\":\"periodic_airbox_k0\""));

        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[test]
    fn native_frequency_response_progress_artifact_records_solver_iteration() {
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-native-progress-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_native_frequency_response_progress_artifact(
            &output_dir,
            NativeFrequencyDomainProgress {
                frequency_index: 0,
                completed_frequency_count: 0,
                total_frequency_count: 3,
                iteration_count: 2807,
                frequency_hz: 2.75e9,
                residual_l2_norm: 4.5e-6,
                relative_residual_l2_norm: 9.9e-4,
                converged: false,
            },
            Some("periodic_airbox_k0"),
            Some((2.0e9, 5.0e9)),
        )
        .expect("native frequency-response progress should be written");

        let progress_path = output_dir.join("response/progress.v1.json");
        let progress: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&progress_path).expect("progress artifact should exist"),
        )
        .expect("progress artifact should parse");
        assert_eq!(progress["status"], "running");
        assert_eq!(progress["state"], "solving_frequency");
        assert_eq!(progress["total_frequency_points"], 3);
        assert_eq!(progress["completed_frequency_points"], 0);
        assert_eq!(progress["written_frequency_point_artifacts"], 0);
        assert_eq!(progress["current_frequency_hz"], 2.75e9);
        assert_eq!(progress["frequency_min_hz"], 2.0e9);
        assert_eq!(progress["frequency_max_hz"], 5.0e9);
        assert_eq!(progress["native_frequency_index"], 0);
        assert_eq!(progress["native_iteration_count"], 2807);
        assert_eq!(
            progress["native_max_iterations_for_frequency"],
            native_frequency_response_max_iterations_for_progress()
        );
        assert_eq!(progress["native_residual_l2_norm"], 4.5e-6);
        assert_eq!(progress["native_relative_residual_l2_norm"], 9.9e-4);
        assert_eq!(progress["native_converged"], false);
        assert_eq!(progress["demag_mode"], "periodic_airbox_k0");
        let progress_json = progress["progress_json"]
            .as_str()
            .expect("progress_json should be a string");
        let progress_json_value: serde_json::Value =
            serde_json::from_str(progress_json).expect("progress_json should parse");
        assert_eq!(progress_json_value["status"], "running");
        assert_eq!(progress_json_value["complete"], false);
        assert!(progress_json.contains("\"state\":\"solving_frequency\""));
        assert!(progress_json.contains("\"demag_mode\":\"periodic_airbox_k0\""));
        assert!(progress_json.contains("\"native_iteration_count\":2807"));
        assert!(progress_json.contains("\"native_max_iterations_for_frequency\""));
        assert!(progress_json.contains("\"native_current_frequency_solve_fraction\""));
        assert!(progress_json.contains("\"native_relative_residual_l2_norm\":0.00099"));

        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[test]
    fn native_frequency_response_final_progress_artifact_preserves_solver_iteration() {
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-final-native-progress-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        write_native_frequency_response_progress_artifact(
            &output_dir,
            NativeFrequencyDomainProgress {
                frequency_index: 0,
                completed_frequency_count: 0,
                total_frequency_count: 1,
                iteration_count: 8,
                frequency_hz: 2.75e9,
                residual_l2_norm: 1.25e-5,
                relative_residual_l2_norm: 0.967,
                converged: false,
            },
            Some("periodic_airbox_k0"),
            Some((2.0e9, 5.0e9)),
        )
        .expect("live running progress should be written");
        let native_manifest_path = output_dir
            .join("frequency_domain/manifest.v1.json")
            .to_string_lossy()
            .into_owned();

        preserve_native_frequency_response_progress_artifact(
            &output_dir,
            NativeFrequencyDomainProgress {
                frequency_index: 0,
                completed_frequency_count: 0,
                total_frequency_count: 1,
                iteration_count: 8,
                frequency_hz: 2.75e9,
                residual_l2_norm: 1.25e-5,
                relative_residual_l2_norm: 0.967,
                converged: false,
            },
            None,
            Some((2.0e9, 5.0e9)),
            NativeFrequencyDomainStatus::SolveError,
            0,
            Some(native_manifest_path.as_str()),
        )
        .expect("native frequency-response progress should be preserved");

        let progress: serde_json::Value = serde_json::from_slice(
            &std::fs::read(output_dir.join("response/progress.v1.json"))
                .expect("progress artifact should exist"),
        )
        .expect("progress artifact should parse");
        assert_eq!(progress["status"], "solve_error");
        assert_eq!(progress["state"], "solve_error");
        assert_eq!(progress["complete"], false);
        assert_eq!(
            progress["latest_artifact_manifest_path"],
            "frequency_domain/manifest.v1.json"
        );
        assert_eq!(progress["partial_artifacts_available"], true);
        assert_eq!(progress["demag_mode"], "periodic_airbox_k0");
        assert_eq!(progress["frequency_min_hz"], 2.0e9);
        assert_eq!(progress["frequency_max_hz"], 5.0e9);
        assert_eq!(progress["native_frequency_index"], 0);
        assert_eq!(progress["native_iteration_count"], 8);
        assert_eq!(progress["native_residual_l2_norm"], 1.25e-5);
        assert_eq!(progress["native_relative_residual_l2_norm"], 0.967);
        assert_eq!(progress["native_converged"], false);
        let progress_json = progress["progress_json"]
            .as_str()
            .expect("progress_json should be a string");
        assert!(progress_json.contains("\"status\":\"solve_error\""));
        assert!(progress_json.contains("\"state\":\"solve_error\""));
        assert!(progress_json.contains("\"complete\":false"));
        assert!(progress_json.contains("\"demag_mode\":\"periodic_airbox_k0\""));
        assert!(progress_json.contains("\"partial_artifacts_available\":true"));
        assert!(progress_json.contains("\"native_iteration_count\":8"));
        assert!(progress_json.contains("\"native_relative_residual_l2_norm\":0.967"));

        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[test]
    fn native_frequency_response_final_progress_patches_manifest_and_written_count() {
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-final-native-progress-manifest-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_native_frequency_response_progress_artifact(
            &output_dir,
            NativeFrequencyDomainProgress {
                frequency_index: 0,
                completed_frequency_count: 1,
                total_frequency_count: 2,
                iteration_count: 13,
                frequency_hz: 2.5e9,
                residual_l2_norm: 2.0e-6,
                relative_residual_l2_norm: 8.0e-4,
                converged: true,
            },
            None,
            Some((2.0e9, 3.0e9)),
        )
        .expect("native live progress should be written");

        preserve_native_frequency_response_progress_artifact(
            &output_dir,
            NativeFrequencyDomainProgress {
                frequency_index: 0,
                completed_frequency_count: 1,
                total_frequency_count: 2,
                iteration_count: 13,
                frequency_hz: 2.5e9,
                residual_l2_norm: 2.0e-6,
                relative_residual_l2_norm: 8.0e-4,
                converged: true,
            },
            None,
            Some((2.0e9, 3.0e9)),
            NativeFrequencyDomainStatus::Ok,
            1,
            Some("frequency_domain/manifest.v1.json"),
        )
        .expect("native final progress should patch manifest and point artifact count");

        let progress: serde_json::Value = serde_json::from_slice(
            &std::fs::read(output_dir.join("response/progress.v1.json"))
                .expect("progress artifact should exist"),
        )
        .expect("progress artifact should parse");
        assert_eq!(progress["status"], "ready");
        assert_eq!(progress["state"], "completed");
        assert_eq!(progress["complete"], true);
        assert_eq!(progress["written_frequency_point_artifacts"], 1);
        assert_eq!(progress["partial_artifacts_available"], true);
        assert_eq!(
            progress["latest_artifact_manifest_path"],
            "frequency_domain/manifest.v1.json"
        );
        let progress_json = progress["progress_json"]
            .as_str()
            .expect("progress_json should be a string");
        assert!(progress_json.contains("\"status\":\"ready\""));
        assert!(progress_json.contains("\"state\":\"completed\""));
        assert!(progress_json.contains("\"complete\":true"));
        assert!(progress_json.contains("\"written_frequency_point_artifacts\":1"));
        assert!(progress_json.contains("\"partial_artifacts_available\":true"));
        assert!(progress_json
            .contains("\"latest_artifact_manifest_path\":\"frequency_domain/manifest.v1.json\""));

        let _ = std::fs::remove_dir_all(output_dir);
    }

    fn m5_equilibrium_provenance_fixture() -> fullmag_ir::FemFrequencyDomainEquilibriumProvenanceIR
    {
        fullmag_ir::FemFrequencyDomainEquilibriumProvenanceIR {
            schema_version: "fem_frequency_domain_equilibrium_provenance.v1".to_string(),
            acceptance_gate: "M5_static_pbc_demag_equilibrium".to_string(),
            accepted: true,
            source_kind: "m5_static_pbc_demag_equilibrium".to_string(),
            source_artifact_root:
                ".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/artifacts".to_string(),
            equilibrium_field_path: "m_final.json".to_string(),
            seam_diagnostics_path: "diagnostics/fem_static_pbc_demag_seams.v1.json".to_string(),
            z_padding_report_path: "reports/z_padding_validation.v1.json".to_string(),
            supercell_report_path: "reports/supercell_validation.v1.json".to_string(),
            magnetostatic_bc: "periodic_airbox_k0".to_string(),
            pbc_axes: vec!["x".to_string(), "y".to_string()],
        }
    }

    #[test]
    fn frequency_response_manifest_preserves_m5_equilibrium_provenance() {
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-m5-provenance-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        let manifest_dir = output_dir.join("frequency_domain");
        std::fs::create_dir_all(&manifest_dir).expect("manifest dir should be created");
        std::fs::write(
            manifest_dir.join("manifest.v1.json"),
            br#"{"schema_version":"frequency_domain_manifest.v1","study_product":"driven_response"}"#,
        )
        .expect("manifest should be written");

        patch_frequency_response_manifest_equilibrium_provenance(
            &output_dir,
            Some(&m5_equilibrium_provenance_fixture()),
        )
        .expect("M5 equilibrium provenance should patch manifest");

        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(output_dir.join("frequency_domain/manifest.v1.json"))
                .expect("manifest should exist"),
        )
        .expect("manifest should parse");
        let provenance = &manifest["equilibrium_provenance"];
        assert_eq!(
            provenance["schema_version"],
            "fem_frequency_domain_equilibrium_provenance.v1"
        );
        assert_eq!(
            provenance["acceptance_gate"],
            "M5_static_pbc_demag_equilibrium"
        );
        assert_eq!(provenance["accepted"], true);
        assert_eq!(provenance["source_kind"], "m5_static_pbc_demag_equilibrium");
        assert_eq!(provenance["magnetostatic_bc"], "periodic_airbox_k0");
        assert_eq!(provenance["pbc_axes"][0], "x");
        assert_eq!(provenance["pbc_axes"][1], "y");

        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[test]
    fn interrupted_frequency_response_progress_artifact_preserves_pre_first_point_cancel() {
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-interrupted-progress-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_initial_frequency_response_progress_artifact(
            &output_dir,
            &[2.0e9, 3.0e9, 4.0e9, 5.0e9, 6.0e9],
            Some("periodic_airbox_k0"),
        )
        .expect("initial frequency-response progress should be written");
        preserve_interrupted_frequency_response_progress_artifact_if_needed(
            &output_dir,
            &[2.0e9, 3.0e9, 4.0e9, 5.0e9, 6.0e9],
            Some("periodic_airbox_k0"),
            NativeFrequencyDomainStatus::Interrupted,
        )
        .expect("interrupted frequency-response progress should be preserved");

        let progress_path = output_dir.join("response/progress.v1.json");
        let progress: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&progress_path).expect("progress artifact should exist"),
        )
        .expect("progress artifact should parse");
        assert_eq!(
            progress["schema_version"],
            "frequency_domain_sweep_progress.v1"
        );
        assert_eq!(progress["status"], "interrupted");
        assert_eq!(progress["state"], "interrupted");
        assert_eq!(progress["complete"], false);
        assert_eq!(progress["total_frequency_points"], 5);
        assert_eq!(progress["completed_frequency_points"], 0);
        assert_eq!(progress["written_frequency_point_artifacts"], 0);
        assert_eq!(progress["partial_artifacts_available"], false);
        assert_eq!(
            progress["latest_artifact_manifest_path"],
            serde_json::Value::Null
        );
        assert_eq!(progress["current_frequency_hz"], 2.0e9);
        assert_eq!(progress["frequency_min_hz"], 2.0e9);
        assert_eq!(progress["frequency_max_hz"], 6.0e9);
        assert_eq!(progress["demag_mode"], "periodic_airbox_k0");
        let progress_json = progress["progress_json"]
            .as_str()
            .expect("progress_json should be a string");
        assert!(progress_json.contains("\"state\":\"interrupted\""));
        assert!(progress_json.contains("\"current_frequency_hz\":2000000000.0"));
        assert!(progress_json.contains("\"frequency_min_hz\":2000000000.0"));
        assert!(progress_json.contains("\"frequency_max_hz\":6000000000.0"));
        assert!(progress_json.contains("\"demag_mode\":\"periodic_airbox_k0\""));

        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[test]
    fn interrupted_frequency_response_progress_artifact_keeps_native_manifest_progress() {
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-interrupted-manifest-progress-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        let response_dir = output_dir.join("response");
        let manifest_dir = output_dir.join("frequency_domain");
        std::fs::create_dir_all(&response_dir).expect("response dir should be created");
        std::fs::create_dir_all(&manifest_dir).expect("manifest dir should be created");
        std::fs::write(
            manifest_dir.join("manifest.v1.json"),
            br#"{"schema_version":"frequency_domain_manifest.v1","status":"interrupted"}"#,
        )
        .expect("manifest should be written");
        std::fs::write(
            response_dir.join("progress.v1.json"),
            br#"{"schema_version":"frequency_domain_sweep_progress.v1","status":"interrupted","state":"cancel_requested","complete":false,"total_frequency_points":5,"completed_frequency_points":1,"written_frequency_point_artifacts":1,"current_frequency_hz":3000000000.0,"partial_artifacts_available":true,"latest_artifact_manifest_path":"frequency_domain/manifest.v1.json","progress_json":"{\"state\":\"cancel_requested\"}"}"#,
        )
        .expect("progress should be written");

        preserve_interrupted_frequency_response_progress_artifact_if_needed(
            &output_dir,
            &[1.0e9, 2.0e9, 3.0e9, 4.0e9, 5.0e9],
            None,
            NativeFrequencyDomainStatus::Interrupted,
        )
        .expect("interrupted frequency-response progress should be preserved");

        let progress: serde_json::Value = serde_json::from_slice(
            &std::fs::read(response_dir.join("progress.v1.json"))
                .expect("progress artifact should exist"),
        )
        .expect("progress artifact should parse");
        assert_eq!(progress["state"], "cancel_requested");
        assert_eq!(progress["completed_frequency_points"], 1);
        assert_eq!(progress["written_frequency_point_artifacts"], 1);
        assert_eq!(progress["current_frequency_hz"], 3_000_000_000.0);
        assert_eq!(
            progress["latest_artifact_manifest_path"],
            "frequency_domain/manifest.v1.json"
        );

        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[test]
    fn periodic_airbox_response_wires_native_backend_demag_tangent_provider_source_contract() {
        let source = include_str!("frequency_response.rs");
        assert!(
            source.contains("struct NativeBackendDemagTangentProvider"),
            "PeriodicAirboxK0 runner path must allocate a native backend demag tangent provider"
        );
        assert!(
            source.contains("unsafe extern \"C\" fn apply_native_backend_demag_tangent"),
            "PeriodicAirboxK0 runner path must expose a C ABI demag tangent callback"
        );
        let request_block = source_block(
            source,
            "mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem",
            "demag_tangent_matrix_row_major:",
        );
        assert!(
            request_block.contains("demag_tangent_provider_callback"),
            "MFEM operator payload must pass the native backend demag tangent callback"
        );
        assert!(
            request_block.contains("demag_tangent_provider_with_potential_callback"),
            "MFEM operator payload must pass the native backend demag tangent-with-potential callback for provider phi diagnostics"
        );
        assert!(
            request_block.contains("demag_tangent_provider_user_data"),
            "MFEM operator payload must pass demag tangent provider user data"
        );
    }

    #[test]
    fn periodic_airbox_response_does_not_hardcode_absent_coupled_block_source_contract() {
        let source = include_str!("frequency_response.rs");
        let request_block = source_block(
            source,
            "let native_result =",
            "tiny_validation_problem: None",
        );
        assert!(
            source.contains(
                "let periodic_airbox_coupled_block_problem = periodic_airbox_coupled_block_problem(&payload);"
            ),
            "PeriodicAirboxK0 request must compute an explicit coupled-block provider decision"
        );
        assert!(
            request_block.contains("periodic_airbox_coupled_block_problem,"),
            "PeriodicAirboxK0 request must pass the explicit coupled-block provider decision instead of hard-coding None"
        );
    }

    #[test]
    fn periodic_airbox_coupled_block_disables_magnetic_only_demag_provider_source_contract() {
        let source = include_str!("frequency_response.rs");
        let provider_block = source_block(
            source,
            "let periodic_airbox_coupled_block_problem = periodic_airbox_coupled_block_problem(&payload);",
            "let operator_diagnostics_json",
        );
        assert!(
            provider_block.contains("payload.requires_native_backend_demag_tangent_provider")
                && provider_block.contains("&& periodic_airbox_coupled_block_problem.is_none()"),
            "When a real coupled-block provider is available, the runner must not also attach the magnetic-only demag tangent provider"
        );
        let request_block = source_block(
            source,
            "let native_result =",
            "tiny_validation_problem: None",
        );
        assert!(
            request_block.contains("periodic_airbox_coupled_block_problem,"),
            "The native request must consume the precomputed coupled-block provider decision"
        );
    }

    #[test]
    fn periodic_airbox_demag_provider_preserves_frequency_response_demag_solver_policy_source_contract(
    ) {
        let source = include_str!("frequency_response.rs");
        let backend_plan_block = source_block(
            source,
            "fn frequency_response_demag_backend_plan",
            "thermal_seed_config:",
        );
        assert!(
            backend_plan_block.contains("demag_solver_policy: plan.demag_solver_policy.clone()"),
            "PeriodicAirboxK0 demag tangent provider must reuse the frequency-response FEM demag solver policy"
        );
    }

    #[test]
    fn native_frequency_response_progress_callback_is_registered_without_live_step_sink_source_contract(
    ) {
        let source = include_str!("frequency_response.rs");
        let progress_block = source_block(
            source,
            "let progress_callback = |progress: NativeFrequencyDomainProgress|",
            "let floquet_periodic_pairs = payload",
        );
        assert!(
            progress_block.contains(
                "write_native_frequency_response_progress_artifact(\n            output_dir,"
            ),
            "native progress callback must persist solver iteration and demag telemetry"
        );
        assert!(
            progress_block.contains("Some(&progress_callback)"),
            "native progress callback must be registered even without a live StepUpdate sink"
        );
        assert!(
            !progress_block.contains("if live_progress_sink.borrow().is_some()"),
            "native progress callback must not depend on the frontend live progress sink"
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn periodic_airbox_demag_provider_backend_plan_keeps_exchange_for_periodic_metadata() {
        let plan = qualified_periodic_airbox_frequency_response_plan();
        let backend_plan = super::frequency_response_demag_backend_plan(&plan);

        assert!(
            backend_plan.enable_exchange,
            "native FEM backend validates periodic_node_pairs only when exchange is enabled"
        );
        assert!(!backend_plan.mesh.periodic_node_pairs.is_empty());
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn periodic_airbox_demag_provider_backend_plan_forces_cpu_mfem_device() {
        let plan = qualified_periodic_airbox_frequency_response_plan();
        let backend_plan = super::frequency_response_demag_backend_plan(&plan);

        assert_eq!(backend_plan.mfem_device_string.as_deref(), Some("cpu"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn periodic_airbox_payload_filters_magnetic_pairs_from_shared_domain_pairs() {
        let mut plan = qualified_periodic_airbox_frequency_response_plan();
        plan.mesh.nodes.push([2.0, 0.0, 0.0]);
        plan.mesh.nodes.push([3.0, 0.0, 0.0]);
        plan.equilibrium_magnetization.push([0.0, 0.0, 0.0]);
        plan.equilibrium_magnetization.push([0.0, 0.0, 0.0]);
        plan.mesh
            .periodic_node_pairs
            .push(fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 3,
                node_b: 4,
            });

        let payload = super::build_native_production_cpu_payload(&plan)
            .expect("shared-domain airbox pairs must not disable native production payload");

        assert_eq!(payload.static_periodic_node_pairs.len(), 2);
        assert_eq!(
            payload
                .periodic_airbox_magnetostatic_periodic_node_pairs
                .len(),
            3
        );
        assert!(payload
            .static_periodic_node_pairs
            .iter()
            .all(|pair| pair.node_a < 3 && pair.node_b < 3));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn periodic_airbox_payload_compacts_magnetic_dofs_when_airbox_nodes_have_zero_m() {
        let mut plan = qualified_periodic_airbox_frequency_response_plan();
        plan.enable_exchange = true;
        plan.mesh.nodes.push([1.0, 1.0, 0.0]);
        plan.mesh.nodes.push([2.0, 1.0, 0.0]);
        plan.mesh.elements = vec![[0, 1, 2, 3]];
        plan.equilibrium_magnetization.push([1.0, 0.0, 0.0]);
        plan.equilibrium_magnetization.push([0.0, 0.0, 0.0]);
        plan.object_segments = vec![
            fullmag_ir::FemObjectSegmentIR {
                object_id: "magnetic".to_string(),
                geometry_id: None,
                node_start: 0,
                node_count: 4,
                element_start: 0,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
            },
            fullmag_ir::FemObjectSegmentIR {
                object_id: "__air__".to_string(),
                geometry_id: None,
                node_start: 4,
                node_count: 1,
                element_start: 1,
                element_count: 0,
                boundary_face_start: 0,
                boundary_face_count: 0,
            },
        ];

        let payload = super::build_native_production_cpu_payload(&plan)
            .expect("periodic-airbox response should ignore zero-m airbox nodes for delta_m");

        assert_eq!(payload.drive_tangent_real.len(), 8);
        assert_eq!(payload.drive_tangent_imag.len(), 8);
        assert_eq!(payload.periodic_airbox_delta_m_tangent_dof_count, 8);
        assert_eq!(payload.periodic_airbox_delta_phi_dof_count, 5);
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
            domain_mesh_workflow_mode: None,
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
            demag_solver_policy: None,
            periodic_constraint_sets: Vec::new(),
            equilibrium_provenance: None,
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
        plan.enable_exchange = false;
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
            super::production_cpu_frequency_response_rejection_reason(&shared_domain).is_none(),
            "shared-domain no-demag response should compact to the magnetic-node CPU slice"
        );

        let mut demag = minimal_frequency_response_plan();
        demag.enable_demag = true;
        demag.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&demag).is_none(),
            "CPU frequency response should accept demag when a tangent provider can be built"
        );
        #[cfg(feature = "fem-gpu")]
        {
            let payload = super::build_native_production_cpu_payload(&demag)
                .expect("CPU demag response should build a native payload");
            assert!(
                payload.requires_native_backend_demag_tangent_provider,
                "CPU demag response must provide a backend demag tangent operator"
            );
            assert!(!payload.requires_periodic_airbox_dynamic_demag);
            assert_eq!(payload.periodic_airbox_delta_phi_dof_count, 0);
        }

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

        let mut split_surface_pair = multi_pair.clone();
        split_surface_pair.mesh.periodic_boundary_pairs.push(
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 5,
                marker_b: 6,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            },
        );
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&split_surface_pair)
                .is_none(),
            "split shared-domain periodic surfaces may publish multiple marker pairs for one logical pair id"
        );

        let mut inconsistent_split_surface_pair = split_surface_pair.clone();
        inconsistent_split_surface_pair.mesh.periodic_boundary_pairs[2].translation =
            Some([0.5, 0.0, 0.0]);
        assert!(super::production_cpu_frequency_response_rejection_reason(
            &inconsistent_split_surface_pair
        )
        .expect("inconsistent split-surface translation should reject")
        .contains("consistent periodic boundary pair translations"));

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
            assert!(
                payload.requires_native_backend_demag_tangent_provider,
                "periodic-airbox CPU response must create a native backend demag tangent provider"
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
            k_vector: [1.0, 0.0, 0.0],
        });
        floquet.equilibrium_magnetization = vec![[0.0, 0.0, 1.0]; 2];
        floquet.excitation.field_au_per_m = [1.0, 0.0, 0.0];
        assert!(
            super::production_cpu_frequency_response_rejection_reason(&floquet).is_none(),
            "qualified nonzero-k Floquet no-demag response should reach the narrow production CPU projection slice"
        );
        #[cfg(feature = "fem-gpu")]
        {
            let payload = super::build_native_production_cpu_payload(&floquet)
                .expect("qualified nonzero-k Floquet CPU response should build a native payload");
            assert!(payload.static_periodic_node_pairs.is_empty());
            assert_eq!(payload.floquet_periodic_pairs.len(), 1);
            assert_eq!(payload.drive_tangent_real[0], 1.0);
            assert_eq!(payload.drive_tangent_imag[0], 0.0);
            assert!((payload.drive_tangent_real[2] - 1.0_f64.cos()).abs() < 1.0e-12);
            assert!((payload.drive_tangent_imag[2] + 1.0_f64.sin()).abs() < 1.0e-12);
        }

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

        let magnetic_node_indices = super::frequency_response_magnetic_node_indices(&plan)
            .expect("magnetic node indices should be buildable");
        let node_index_map = super::compact_node_index_map(
            plan.equilibrium_magnetization.len(),
            &magnetic_node_indices,
        )
        .expect("compact node map should be buildable");
        let pairs = super::build_floquet_periodic_pairs(&plan, &node_index_map)
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

        let mut shared_domain_static_periodic = supported.clone();
        shared_domain_static_periodic.domain_mesh_mode =
            fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir;
        shared_domain_static_periodic.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
            [1.0, 0.0, -1.0],
        ];
        shared_domain_static_periodic.mesh.elements = vec![[0, 1, 2, 3], [0, 1, 4, 5]];
        shared_domain_static_periodic.mesh.element_markers = vec![1, 0];
        shared_domain_static_periodic.equilibrium_magnetization = vec![
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ];
        shared_domain_static_periodic.mesh.periodic_boundary_pairs =
            vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
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
        shared_domain_static_periodic.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ];
        shared_domain_static_periodic.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        assert!(
            super::production_gpu_frequency_response_rejection_reason(
                &shared_domain_static_periodic
            )
            .is_none(),
            "explicit GPU shared-domain no-demag static-periodic response should reach the native magnetic slice"
        );
        let magnetic_node_indices =
            super::frequency_response_magnetic_node_indices(&shared_domain_static_periodic)
                .expect("shared-domain response should identify magnetic nodes");
        assert_eq!(magnetic_node_indices, vec![0, 1, 2, 3]);
        #[cfg(feature = "fem-gpu")]
        {
            let cpu_payload =
                super::build_native_production_cpu_payload(&shared_domain_static_periodic)
                    .expect("shared-domain no-demag CPU response should build a compact payload");
            assert_eq!(cpu_payload.equilibrium_magnetization.len(), 4);
            assert_eq!(cpu_payload.static_periodic_node_pairs.len(), 1);
            assert!(cpu_payload
                .periodic_airbox_magnetostatic_periodic_node_pairs
                .is_empty());
            assert!(!cpu_payload.requires_periodic_airbox_dynamic_demag);
            assert_eq!(cpu_payload.periodic_airbox_delta_phi_dof_count, 0);

            let payload =
                super::build_native_production_gpu_payload(&shared_domain_static_periodic)
                    .expect("shared-domain no-demag GPU response should build a compact payload");
            assert_eq!(payload.equilibrium_magnetization.len(), 4);
            assert_eq!(payload.static_periodic_node_pairs.len(), 1);
            assert!(payload
                .periodic_airbox_magnetostatic_periodic_node_pairs
                .is_empty());
            assert!(!payload.requires_periodic_airbox_dynamic_demag);
            assert_eq!(payload.periodic_airbox_delta_phi_dof_count, 0);
        }

        let mut demag = supported.clone();
        demag.enable_demag = true;
        demag.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        assert!(
            super::production_gpu_frequency_response_rejection_reason(&demag).is_none(),
            "GPU frequency response should accept magnetic k=0 demag through the backend demag tangent provider"
        );
        #[cfg(feature = "fem-gpu")]
        {
            let payload = super::build_native_production_gpu_payload(&demag)
                .expect("GPU demag response should build a native payload");
            assert!(
                payload.requires_native_backend_demag_tangent_provider,
                "GPU demag response must provide a backend demag tangent operator"
            );
            assert!(!payload.requires_periodic_airbox_dynamic_demag);
            assert_eq!(payload.periodic_airbox_delta_phi_dof_count, 0);
        }

        let mut dmi = supported.clone();
        dmi.bulk_dmi = Some(2.5e-3);
        assert!(
            super::production_gpu_frequency_response_rejection_reason(&dmi)
                .expect("DMI must reject on GPU until device weak residual exists")
                .contains("DMI")
        );

        let mut periodic_airbox = qualified_periodic_airbox_frequency_response_plan();
        periodic_airbox.requested_device = fullmag_ir::ExecutionDevice::Gpu;
        assert!(
            super::production_gpu_frequency_response_rejection_reason(&periodic_airbox)
                .expect(
                    "forced GPU periodic-airbox dynamic demag should reject before native solve"
                )
                .contains("periodic_airbox_k0 is not implemented for production GPU")
        );
        #[cfg(feature = "fem-gpu")]
        {
            assert!(
                super::build_native_production_gpu_payload(&periodic_airbox).is_none(),
                "forced GPU periodic-airbox request must not build a native GPU payload"
            );
        }

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

        let mut floquet = periodic.clone();
        floquet.equilibrium_magnetization = vec![[0.0, 0.0, 1.0]; 4];
        floquet.excitation.field_au_per_m = [1.0, 0.0, 0.0];
        floquet.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        floquet.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
        });
        assert!(
            super::production_gpu_frequency_response_rejection_reason(&floquet).is_none(),
            "valid nonzero-k Floquet no-demag response should be executable on the narrow GPU projection slice"
        );
        #[cfg(feature = "fem-gpu")]
        {
            let payload = super::build_native_production_gpu_payload(&floquet)
                .expect("valid nonzero-k Floquet GPU response should build a native payload");
            assert!(payload.static_periodic_node_pairs.is_empty());
            assert_eq!(payload.floquet_periodic_pairs.len(), 1);
            assert_eq!(payload.drive_tangent_real[0], 1.0);
            assert_eq!(payload.drive_tangent_imag[0], 0.0);
            assert!(payload.drive_tangent_real[2].abs() < 1.0e-12);
            assert!((payload.drive_tangent_imag[2] + 1.0).abs() < 1.0e-12);
        }

        #[cfg(feature = "fem-gpu")]
        {
            let mut floquet_airbox = qualified_periodic_airbox_frequency_response_plan();
            floquet_airbox.requested_device = fullmag_ir::ExecutionDevice::Gpu;
            floquet_airbox.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                    boundary_pair_id: Some("x_faces".to_string()),
                    pair_ids: Vec::new(),
                    phase_convention: fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR,
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            );
            floquet_airbox.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
            });
            floquet_airbox.magnetostatic_bc =
                fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox;
            floquet_airbox.periodic_constraint_sets = vec![
                fullmag_ir::PeriodicConstraintSetIR {
                    unknown_family: fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic,
                    domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagneticDomain,
                    pair_ids: vec!["x_faces".to_string()],
                    phase_policy: fullmag_ir::PeriodicPhasePolicyIR::BlochPhase {
                        phase_convention: fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR,
                        k_vector_rad_per_m: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
                        real_imag_mixing: true,
                    },
                    phase_loop_diagnostics: None,
                },
                fullmag_ir::PeriodicConstraintSetIR {
                    unknown_family:
                        fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic,
                    domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir,
                    pair_ids: vec!["x_faces".to_string()],
                    phase_policy: fullmag_ir::PeriodicPhasePolicyIR::BlochPhase {
                        phase_convention: fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR,
                        k_vector_rad_per_m: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
                        real_imag_mixing: true,
                    },
                    phase_loop_diagnostics: None,
                },
            ];

            let payload = super::build_native_production_payload(&floquet_airbox)
                .expect("Floquet-airbox request should build a native metadata payload");
            assert!(payload.requires_floquet_airbox_dynamic_demag);
            assert_eq!(payload.magnetostatic_periodic_constraint_set_count, 1);
            assert_eq!(payload.periodic_airbox_delta_phi_dof_count, 3);
            assert_eq!(
                payload
                    .periodic_airbox_magnetostatic_periodic_node_pairs
                    .len(),
                1
            );
        }

        #[cfg(feature = "fem-gpu")]
        {
            let mut floquet_boundary_exchange = floquet.clone();
            floquet_boundary_exchange.mesh.nodes = vec![
                [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 1.0, 1.0],
                [1.0, 0.0, 0.0],
                [1.0, 1.0, 0.0],
                [1.0, 0.0, 1.0],
                [1.0, 1.0, 1.0],
            ];
            floquet_boundary_exchange.mesh.elements = vec![[0, 1, 2, 3], [4, 5, 6, 7]];
            floquet_boundary_exchange.equilibrium_magnetization = vec![[0.0, 0.0, 1.0]; 8];
            floquet_boundary_exchange.mesh.periodic_node_pairs =
                vec![fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 0,
                    node_b: 4,
                }];

            let payload = super::build_native_production_gpu_payload(&floquet_boundary_exchange)
                .expect(
                    "Floquet GPU response with boundary exchange should build a native payload",
                );

            assert!(
                payload
                    .exchange_edges
                    .iter()
                    .any(|edge| edge.node_i == 0 && edge.node_j == 4),
                "Floquet GPU exchange payload must include the selected periodic boundary edge"
            );
        }

        #[cfg(feature = "fem-gpu")]
        {
            let mut periodic_airbox_exchange = qualified_periodic_airbox_frequency_response_plan();
            periodic_airbox_exchange.enable_exchange = true;
            periodic_airbox_exchange.mesh.nodes = vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 1.0, 0.0],
            ];
            periodic_airbox_exchange.equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; 5];
            periodic_airbox_exchange.mesh.elements = vec![[0, 1, 2, 3], [0, 1, 2, 4]];
            periodic_airbox_exchange.mesh.element_markers = vec![1, 0];

            let payload = super::build_native_production_cpu_payload(&periodic_airbox_exchange)
                .expect("periodic-airbox response should build exchange payload");

            assert_eq!(
                payload.exchange_edges.len(),
                6,
                "exchange graph must ignore air-volume elements even when all element nodes are magnetic interface nodes"
            );
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
            r#"{"schema_version":"frequency_domain_response_diagnostics.v1","status":"solve_error","total_iteration_count":256,"max_iterations_for_frequency":256,"relative_residual_l2_norm":0.75}"#,
            r#"{"schema_version":"frequency_domain_response_summary.v1","status":"solve_error"}"#,
        );

        assert!(message.contains("native_status=solve_error"));
        assert!(message.contains("diagnostics_status=solve_error"));
        assert!(message.contains("result_status=solve_error"));
        assert!(message.contains("total_iteration_count=256"));
        assert!(message.contains("max_iterations_for_frequency=256"));
        assert!(message.contains("relative_residual_l2_norm=0.75"));
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
