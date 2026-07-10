use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use fullmag_ir::{BackendPlanIR, ProblemIR};
use serde_json::Value;
use std::collections::BTreeMap;

use fullmag_engine::fem::MeshTopology;
use fullmag_engine::fem_solution_transfer::{
    normalize_unit_vectors, transfer_fem_field_to_grid, transfer_vector_field, GridTransferResult,
};

use crate::formatting::unix_time_millis;
use crate::live_workspace::LocalLiveWorkspace;
use crate::types::{
    LiveStateManifest, LiveStepView, ResolvedScriptStage, ResolvedScriptStageAction, RunManifest,
    ScriptExecutionConfig, ScriptExecutionStageAction, StageTransitionKind,
    StageTransitionMetadata, StageTransitionReason, StateTransferOperatorKind,
    StudyPipelineDocument, StudyPipelineNode,
};

pub(crate) fn emit_initial_state_warnings(
    live_workspace: Option<&LocalLiveWorkspace>,
    backend_plan: &BackendPlanIR,
) -> Result<()> {
    let diagnostic = crate::diagnostics::diagnose_initial_backend_plan(backend_plan)?;
    for warning in diagnostic.warnings {
        eprintln!("fullmag diagnostic warning: {}", warning);
        if let Some(workspace) = live_workspace {
            workspace.push_log("warning", warning);
        }
    }
    Ok(())
}

pub(crate) fn offset_step_update(
    update: &fullmag_runner::StepUpdate,
    step_offset: u64,
    time_offset: f64,
    finished: bool,
) -> fullmag_runner::StepUpdate {
    let mut adjusted = update.clone();
    adjusted.stats.step += step_offset;
    adjusted.stats.time += time_offset;
    adjusted.finished = finished;
    adjusted
}

pub(crate) fn offset_step_stats(
    steps: &[fullmag_runner::StepStats],
    step_offset: u64,
    time_offset: f64,
) -> Vec<fullmag_runner::StepStats> {
    steps
        .iter()
        .cloned()
        .map(|mut step| {
            step.step += step_offset;
            step.time += time_offset;
            step
        })
        .collect()
}

pub(crate) fn stage_artifact_dir(
    workspace_dir: &Path,
    artifact_dir: &Path,
    stage_index: usize,
    total_stages: usize,
    entrypoint_kind: &str,
) -> PathBuf {
    if stage_index + 1 == total_stages {
        return artifact_dir.to_path_buf();
    }
    workspace_dir
        .join("stages")
        .join(format!("stage_{stage_index:02}_{entrypoint_kind}"))
}

pub(crate) fn flatten_magnetization(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|value| value.iter().copied())
        .collect()
}

pub(crate) fn live_state_manifest_from_update(
    update: &fullmag_runner::StepUpdate,
) -> LiveStateManifest {
    let status_str = if update.finished {
        "completed"
    } else {
        "running"
    };
    LiveStateManifest {
        status: status_str.to_string(),
        runtime_status: Some(fullmag_runner::RuntimeStatus::from_status_code(status_str)),
        updated_at_unix_ms: unix_time_millis().unwrap_or(0),
        latest_step: LiveStepView {
            step: update.stats.step,
            time: update.stats.time,
            dt: update.stats.dt,
            pseudo_time_s: update.stats.pseudo_time_s,
            e_ex: update.stats.e_ex,
            e_demag: update.stats.e_demag,
            e_ext: update.stats.e_ext,
            e_ani: update.stats.e_ani,
            e_dmi: update.stats.e_dmi,
            e_total: update.stats.e_total,
            max_dm_dt: update.stats.max_dm_dt,
            max_h_eff: update.stats.max_h_eff,
            max_h_demag: update.stats.max_h_demag,
            max_torque_Apm: update.stats.max_torque_Apm,
            max_torque_T: update.stats.max_torque_T,
            wall_time_ns: update.stats.wall_time_ns,
            grid: update.grid,
            fem_mesh: update.fem_mesh.clone(),
            magnetization: update.magnetization.clone(),
            per_object_scalars: update.stats.per_object_scalars.clone(),
            preview_field: update.preview_field.clone(),
            finished: update.finished,
        },
    }
}

pub(crate) fn running_run_manifest_from_update(
    run_id: &str,
    session_id: &str,
    artifact_dir: &Path,
    update: &fullmag_runner::StepUpdate,
) -> RunManifest {
    RunManifest {
        run_id: run_id.to_string(),
        session_id: session_id.to_string(),
        status: if update.finished {
            "completed".to_string()
        } else {
            "running".to_string()
        },
        total_steps: update.stats.step as usize,
        final_time: Some(update.stats.time),
        final_e_ex: Some(update.stats.e_ex),
        final_e_demag: Some(update.stats.e_demag),
        final_e_ext: Some(update.stats.e_ext),
        final_e_ani: Some(update.stats.e_ani),
        final_e_dmi: Some(update.stats.e_dmi),
        final_e_total: Some(update.stats.e_total),
        artifact_dir: artifact_dir.display().to_string(),
    }
}

pub(crate) fn initial_step_update(backend_plan: &BackendPlanIR) -> fullmag_runner::StepUpdate {
    let stats = fullmag_runner::StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
        ..fullmag_runner::StepStats::default()
    };

    match backend_plan {
        BackendPlanIR::Fdm(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
            fem_mesh: None,
            magnetization: Some(flatten_magnetization(&fdm.initial_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            finished: false,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [
                fdm.common_cells[0],
                fdm.common_cells[1],
                fdm.common_cells[2],
            ],
            fem_mesh: None,
            magnetization: None,
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            finished: false,
        },
        BackendPlanIR::Fem(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload::from(fem)),
            magnetization: Some(flatten_magnetization(&fem.initial_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            finished: false,
        },
        BackendPlanIR::FemEigen(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload::from(fem)),
            magnetization: Some(flatten_magnetization(&fem.equilibrium_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            finished: false,
        },
        BackendPlanIR::FemFrequencyResponse(fem) => {
            let mut stats = stats;
            stats.per_object_scalars = initial_frequency_response_progress_scalars(fem);
            fullmag_runner::StepUpdate {
                stats,
                grid: [0, 0, 0],
                fem_mesh: Some(fullmag_runner::FemMeshPayload::from(fem)),
                magnetization: Some(flatten_magnetization(&fem.equilibrium_magnetization)),
                preview_field: None,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: false,
                finished: false,
            }
        }
    }
}

fn initial_frequency_response_progress_scalars(
    fem: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> std::collections::HashMap<String, std::collections::HashMap<String, f64>> {
    let mut progress = std::collections::HashMap::new();
    let total = fem.frequencies_hz.values_hz.len() as f64;
    progress.insert("frequency_index".to_string(), 0.0);
    progress.insert("completed_frequency_count".to_string(), 0.0);
    progress.insert("total_frequency_count".to_string(), total);
    progress.insert("percent".to_string(), 0.0);
    progress.insert("phase_solving_frequency_point".to_string(), 1.0);
    if let Some(first_frequency_hz) = fem.frequencies_hz.values_hz.first().copied() {
        if first_frequency_hz.is_finite() && first_frequency_hz > 0.0 {
            progress.insert("frequency_hz".to_string(), first_frequency_hz);
        }
    }
    if let Some((min_hz, max_hz)) = frequency_response_range_hz(&fem.frequencies_hz.values_hz) {
        progress.insert("frequency_min_hz".to_string(), min_hz);
        progress.insert("frequency_max_hz".to_string(), max_hz);
    }
    if fem.enable_demag {
        progress.insert("demag_enabled".to_string(), 1.0);
    }
    match fem.magnetostatic_bc {
        fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0 => {
            progress.insert("demag_periodic_airbox_k0".to_string(), 1.0);
        }
        fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox => {
            progress.insert("demag_floquet_airbox".to_string(), 1.0);
        }
        fullmag_ir::MagnetostaticBoundaryConditionIR::Open => {}
    }

    std::collections::HashMap::from([("fem_frequency_response_progress".to_string(), progress)])
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

pub(crate) fn final_stage_step_update(
    backend_plan: &BackendPlanIR,
    steps: &[fullmag_runner::StepStats],
    final_magnetization: &[[f64; 3]],
    step_offset: u64,
    time_offset: f64,
    finished: bool,
) -> Option<fullmag_runner::StepUpdate> {
    let stats = steps.last()?.clone();
    let stats = offset_step_stats(std::slice::from_ref(&stats), step_offset, time_offset)
        .into_iter()
        .next()
        .expect("single step should offset");

    Some(match backend_plan {
        BackendPlanIR::Fdm(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
            fem_mesh: None,
            magnetization: Some(flatten_magnetization(final_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            finished,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [
                fdm.common_cells[0],
                fdm.common_cells[1],
                fdm.common_cells[2],
            ],
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
            finished,
        },
        BackendPlanIR::Fem(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload::from(fem)),
            magnetization: Some(flatten_magnetization(final_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            finished,
        },
        BackendPlanIR::FemEigen(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload::from(fem)),
            magnetization: Some(flatten_magnetization(final_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            finished,
        },
        BackendPlanIR::FemFrequencyResponse(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload::from(fem)),
            magnetization: Some(flatten_magnetization(final_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            finished,
        },
    })
}

pub(crate) fn snapshot_step_update_from_stats(
    backend_plan: &BackendPlanIR,
    stats: fullmag_runner::StepStats,
    magnetization: &[[f64; 3]],
    finished: bool,
) -> fullmag_runner::StepUpdate {
    match backend_plan {
        BackendPlanIR::Fdm(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
            fem_mesh: None,
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            finished,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            stats,
            grid: [
                fdm.common_cells[0],
                fdm.common_cells[1],
                fdm.common_cells[2],
            ],
            fem_mesh: None,
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            finished,
        },
        BackendPlanIR::Fem(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload::from(fem)),
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            finished,
        },
        BackendPlanIR::FemEigen(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload::from(fem)),
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            finished,
        },
        BackendPlanIR::FemFrequencyResponse(fem) => fullmag_runner::StepUpdate {
            stats,
            grid: [0, 0, 0],
            fem_mesh: Some(fullmag_runner::FemMeshPayload::from(fem)),
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            finished,
        },
    }
}

pub(crate) fn resolve_script_until_seconds(
    ir: &ProblemIR,
    default_until_seconds: Option<f64>,
) -> Result<f64> {
    if let Some(until_seconds) = default_until_seconds {
        return Ok(until_seconds);
    }

    match &ir.study {
        fullmag_ir::StudyIR::Relaxation { dynamics, stop, .. } => {
            Ok(resolve_relaxation_until_seconds(dynamics, stop))
        }
        fullmag_ir::StudyIR::TimeEvolution { .. } => bail!(
            "no stop time provided. Define DEFAULT_UNTIL in the script for time-evolution runs"
        ),
        fullmag_ir::StudyIR::Eigenmodes { .. } => Ok(0.0),
        fullmag_ir::StudyIR::FrequencyResponse { .. } => Ok(0.0),
        fullmag_ir::StudyIR::Hysteresis { .. } => Ok(0.0),
    }
}

fn resolve_relaxation_until_seconds(
    dynamics: &Option<fullmag_ir::DynamicsIR>,
    stop: &fullmag_ir::RelaxStopIR,
) -> f64 {
    if let Some(until_seconds) = stop.max_relaxation_time_s {
        return until_seconds;
    }
    let Some(fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. }) = dynamics else {
        return f64::INFINITY;
    };
    match (stop.max_steps, fixed_timestep) {
        (Some(max_steps), Some(dt)) => max_steps as f64 * dt,
        _ => f64::INFINITY,
    }
}

pub(crate) fn materialize_script_stages(
    config: ScriptExecutionConfig,
) -> Result<Vec<ResolvedScriptStage>> {
    let ScriptExecutionConfig {
        mut ir,
        shared_geometry_assets,
        default_until_seconds,
        study_pipeline,
        stages,
    } = config;

    if ir.geometry_assets.is_none() {
        ir.geometry_assets = shared_geometry_assets.clone();
    }

    if stages.is_empty() {
        if let Some(document) = study_pipeline {
            let materialized = annotate_stage_transitions(materialize_study_pipeline(
                &document,
                &ir,
                default_until_seconds,
            )?);
            if !materialized.is_empty() {
                return Ok(materialized);
            }
        }
        let entrypoint_kind = ir.problem_meta.entrypoint_kind.clone();
        let entrypoint_kind = if entrypoint_kind.is_empty() {
            "direct_script".to_string()
        } else {
            entrypoint_kind
        };
        let until_seconds = if entrypoint_kind == "flat_workspace" {
            0.0
        } else {
            resolve_script_until_seconds(&ir, default_until_seconds)?
        };
        return Ok(vec![ResolvedScriptStage::solver(
            ir,
            until_seconds,
            entrypoint_kind,
        )]);
    }

    let mut materialized = Vec::with_capacity(stages.len());
    let mut device_override: Option<String> = None;
    for mut stage in stages {
        if stage.ir.geometry_assets.is_none() {
            stage.ir.geometry_assets = shared_geometry_assets.clone();
        }
        if let Some(device) = device_override.as_deref() {
            set_runtime_selection_device(&mut stage.ir, device);
        }
        normalize_stage_sampling(&mut stage.ir);
        if let Some(action) = stage.action {
            if let ScriptExecutionStageAction::ChangeDevice { device } = &action {
                set_runtime_selection_device(&mut stage.ir, device);
                device_override = Some(device.clone());
            }
            materialized.push(resolve_explicit_stage_action(
                stage.ir,
                stage.entrypoint_kind,
                action,
            ));
        } else {
            let until_seconds =
                resolve_script_until_seconds(&stage.ir, stage.default_until_seconds)?;
            materialized.push(ResolvedScriptStage::solver(
                stage.ir,
                until_seconds,
                stage.entrypoint_kind,
            ));
        }
    }
    Ok(annotate_stage_transitions(materialized))
}

fn annotate_stage_transitions(mut stages: Vec<ResolvedScriptStage>) -> Vec<ResolvedScriptStage> {
    let transitions = (0..stages.len())
        .map(|index| {
            if index == 0 {
                None
            } else {
                Some(classify_stage_transition(
                    &stages[index - 1],
                    &stages[index],
                ))
            }
        })
        .collect::<Vec<_>>();
    for (stage, transition) in stages.iter_mut().zip(transitions.into_iter()) {
        stage.incoming_transition = transition;
    }
    stages
}

fn classify_stage_transition(
    previous: &ResolvedScriptStage,
    current: &ResolvedScriptStage,
) -> StageTransitionMetadata {
    if let Some(action) = current.action.as_ref() {
        return classify_action_stage_transition(action);
    }
    if requested_device(&previous.ir) != requested_device(&current.ir) {
        return StageTransitionMetadata::boundary(
            StageTransitionKind::BackendTransfer,
            StageTransitionReason::DeviceChange,
            Some(StateTransferOperatorKind::IdentityCopy),
        );
    }
    if previous.ir.backend_policy.requested_backend != current.ir.backend_policy.requested_backend {
        return StageTransitionMetadata::boundary(
            StageTransitionKind::BackendTransfer,
            StageTransitionReason::BackendChange,
            None,
        );
    }
    if same_runtime_state_topology(&previous.ir, &current.ir) {
        return StageTransitionMetadata::continue_in_place();
    }
    StageTransitionMetadata::unsupported(StageTransitionReason::IncompatibleImplicitState)
}

fn classify_action_stage_transition(action: &ResolvedScriptStageAction) -> StageTransitionMetadata {
    match action {
        ResolvedScriptStageAction::SaveState { .. } => StageTransitionMetadata::boundary(
            StageTransitionKind::SaveCheckpoint,
            StageTransitionReason::UserExport,
            None,
        ),
        ResolvedScriptStageAction::LoadState { .. } => StageTransitionMetadata::boundary(
            StageTransitionKind::LoadState,
            StageTransitionReason::CheckpointLoad,
            Some(StateTransferOperatorKind::CheckpointLoad),
        ),
        ResolvedScriptStageAction::Export { .. } => StageTransitionMetadata::boundary(
            StageTransitionKind::ExportOnly,
            StageTransitionReason::UserExport,
            None,
        ),
        ResolvedScriptStageAction::ChangeDevice { .. } => StageTransitionMetadata::boundary(
            StageTransitionKind::BackendTransfer,
            StageTransitionReason::DeviceChange,
            Some(StateTransferOperatorKind::IdentityCopy),
        ),
    }
}

fn same_runtime_state_topology(previous: &ProblemIR, current: &ProblemIR) -> bool {
    previous.backend_policy.requested_backend == current.backend_policy.requested_backend
        && previous.backend_policy.execution_precision == current.backend_policy.execution_precision
        && previous.backend_policy.discretization_hints
            == current.backend_policy.discretization_hints
        && previous.geometry == current.geometry
        && previous.geometry_assets == current.geometry_assets
        && previous.regions == current.regions
        && same_material_topology(&previous.materials, &current.materials)
        && same_magnet_topology(&previous.magnets, &current.magnets)
        && previous.current_modules == current.current_modules
        && previous.spin_torque_modules == current.spin_torque_modules
        && previous.elastic_materials == current.elastic_materials
        && previous.elastic_bodies == current.elastic_bodies
        && previous.magnetostriction_laws == current.magnetostriction_laws
        && previous.mechanical_bcs == current.mechanical_bcs
        && previous.mechanical_loads == current.mechanical_loads
        && previous.air_box_policy == current.air_box_policy
        && previous.pbc == current.pbc
        && previous.mesh_semantics == current.mesh_semantics
}

fn requested_device(ir: &ProblemIR) -> String {
    ir.problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .and_then(|selection| selection.get("device"))
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .to_string()
}

fn same_material_topology(
    previous: &[fullmag_ir::MaterialIR],
    current: &[fullmag_ir::MaterialIR],
) -> bool {
    previous.len() == current.len()
        && previous
            .iter()
            .zip(current.iter())
            .all(|(p, c)| p.name == c.name)
}

fn same_magnet_topology(
    previous: &[fullmag_ir::MagnetIR],
    current: &[fullmag_ir::MagnetIR],
) -> bool {
    previous.len() == current.len()
        && previous
            .iter()
            .zip(current.iter())
            .all(|(previous, current)| {
                previous.name == current.name
                    && previous.region == current.region
                    && previous.material == current.material
            })
}

fn resolve_explicit_stage_action(
    ir: ProblemIR,
    entrypoint_kind: String,
    action: ScriptExecutionStageAction,
) -> ResolvedScriptStage {
    let (entrypoint_fallback, resolved_action) = match action {
        ScriptExecutionStageAction::SaveState {
            artifact_name,
            format,
            dataset,
        } => (
            "study_pipeline_save_state",
            ResolvedScriptStageAction::SaveState {
                artifact_name,
                format,
                dataset,
            },
        ),
        ScriptExecutionStageAction::LoadState {
            artifact_name,
            state_path,
            format,
            dataset,
            sample_index,
        } => (
            "study_pipeline_load_state",
            ResolvedScriptStageAction::LoadState {
                artifact_name,
                state_path,
                format,
                dataset,
                sample_index,
            },
        ),
        ScriptExecutionStageAction::Export {
            artifact_name,
            quantity,
            format,
            dataset,
        } => (
            "study_pipeline_export",
            ResolvedScriptStageAction::Export {
                artifact_name,
                quantity,
                format,
                dataset,
            },
        ),
        ScriptExecutionStageAction::ChangeDevice { device } => (
            "study_pipeline_change_device",
            ResolvedScriptStageAction::ChangeDevice { device },
        ),
    };
    let entrypoint = if entrypoint_kind.trim().is_empty() {
        entrypoint_fallback.to_string()
    } else {
        entrypoint_kind
    };
    ResolvedScriptStage::synthetic(ir, entrypoint, resolved_action)
}

fn materialize_study_pipeline(
    document: &StudyPipelineDocument,
    base_ir: &ProblemIR,
    default_until_seconds: Option<f64>,
) -> Result<Vec<ResolvedScriptStage>> {
    if document.version != "study_pipeline.v1" {
        bail!(
            "unsupported study pipeline version '{}' while materializing script stages",
            document.version
        );
    }
    let mut stages = Vec::new();
    let mut current_ir = base_ir.clone();
    walk_study_pipeline_nodes(
        &document.nodes,
        &mut current_ir,
        default_until_seconds,
        &mut stages,
    )?;
    Ok(stages)
}

fn walk_study_pipeline_nodes(
    nodes: &[StudyPipelineNode],
    current_ir: &mut ProblemIR,
    default_until_seconds: Option<f64>,
    out: &mut Vec<ResolvedScriptStage>,
) -> Result<()> {
    for node in nodes {
        match node {
            StudyPipelineNode::Primitive {
                enabled,
                stage_kind,
                payload,
                label,
                ..
            } => {
                if !enabled {
                    continue;
                }
                if let Some(stage) = materialize_pipeline_primitive(
                    current_ir,
                    stage_kind,
                    payload,
                    default_until_seconds,
                )
                .with_context(|| format!("failed to materialize study pipeline node '{label}'"))?
                {
                    out.push(stage);
                }
            }
            StudyPipelineNode::Macro {
                enabled,
                macro_kind,
                label,
                config,
                ..
            } => {
                if !enabled {
                    continue;
                }
                out.extend(
                    materialize_pipeline_macro(
                        current_ir,
                        macro_kind,
                        config,
                        default_until_seconds,
                    )
                    .with_context(|| {
                        format!("failed to materialize study pipeline node '{label}'")
                    })?,
                );
            }
            StudyPipelineNode::Group {
                enabled, children, ..
            } => {
                if !enabled {
                    continue;
                }
                walk_study_pipeline_nodes(children, current_ir, default_until_seconds, out)?;
            }
        }
    }
    Ok(())
}

fn materialize_pipeline_primitive(
    current_ir: &mut ProblemIR,
    stage_kind: &str,
    payload: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
) -> Result<Option<ResolvedScriptStage>> {
    let normalized_kind = stage_kind.trim().to_ascii_lowercase();
    match normalized_kind.as_str() {
        "run" => materialize_pipeline_run(current_ir, payload, default_until_seconds).map(Some),
        "relax" => materialize_pipeline_relax(current_ir, payload).map(Some),
        "eigenmodes" => materialize_pipeline_eigenmodes(current_ir, payload).map(Some),
        "frequency_response" => {
            materialize_pipeline_frequency_response(current_ir, payload).map(Some)
        }
        "set_field" => {
            apply_pipeline_set_field(current_ir, payload)?;
            Ok(None)
        }
        "set_current" => {
            apply_pipeline_set_current(current_ir, payload)?;
            Ok(None)
        }
        "save_state" => materialize_pipeline_save_state(current_ir, payload).map(Some),
        "load_state" => materialize_pipeline_load_state(current_ir, payload).map(Some),
        "export" => materialize_pipeline_export(current_ir, payload).map(Some),
        "change_device" => materialize_pipeline_change_device(current_ir, payload).map(Some),
        other => bail!(
            "study pipeline primitive stage '{}' is not yet executable by the runtime; materialize it into explicit stages first",
            other
        ),
    }
}

fn materialize_pipeline_macro(
    current_ir: &mut ProblemIR,
    macro_kind: &str,
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
) -> Result<Vec<ResolvedScriptStage>> {
    let normalized_kind = macro_kind.trim().to_ascii_lowercase();
    match normalized_kind.as_str() {
        "relax_run" => {
            let mut stages = Vec::with_capacity(2);
            let mut relax_payload = config.clone();
            relax_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String("study_pipeline_relax_run_relax".to_string()),
            );
            stages.push(materialize_pipeline_relax(current_ir, &relax_payload)?);

            let mut run_payload = config.clone();
            run_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String("study_pipeline_relax_run_run".to_string()),
            );
            if let Some(until_seconds) =
                payload_f64(config, "run_until_seconds")?.or(default_until_seconds)
            {
                run_payload.insert(
                    "until_seconds".to_string(),
                    Value::String(until_seconds.to_string()),
                );
            }
            stages.push(materialize_pipeline_run(
                current_ir,
                &run_payload,
                default_until_seconds,
            )?);
            Ok(stages)
        }
        "relax_eigenmodes" => {
            let mut stages = Vec::with_capacity(2);
            let mut relax_payload = config.clone();
            relax_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String("study_pipeline_relax_eigenmodes_relax".to_string()),
            );
            stages.push(materialize_pipeline_relax(current_ir, &relax_payload)?);

            let mut eigen_payload = config.clone();
            eigen_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String("study_pipeline_relax_eigenmodes_eigenmodes".to_string()),
            );
            stages.push(materialize_pipeline_eigenmodes(current_ir, &eigen_payload)?);
            Ok(stages)
        }
        "field_sweep_relax" | "field_sweep_relax_snapshot" => materialize_pipeline_field_sweep(
            current_ir,
            config,
            default_until_seconds,
            normalized_kind.as_str(),
        ),
        "hysteresis_loop" => {
            materialize_pipeline_hysteresis_branch(current_ir, config, default_until_seconds)
        }
        "parameter_sweep" => {
            materialize_pipeline_parameter_sweep(current_ir, config, default_until_seconds)
        }
        other => bail!(
            "study pipeline macro '{}' is not yet executable by the runtime fallback; materialize it into explicit stages first",
            other
        ),
    }
}

fn time_domain_sampling_from(base: &fullmag_ir::SamplingIR) -> fullmag_ir::SamplingIR {
    let mut outputs: Vec<fullmag_ir::OutputIR> = base
        .outputs
        .iter()
        .filter(|output| {
            matches!(
                output,
                fullmag_ir::OutputIR::Field { .. }
                    | fullmag_ir::OutputIR::Scalar { .. }
                    | fullmag_ir::OutputIR::Snapshot { .. }
            )
        })
        .cloned()
        .collect();
    if outputs.is_empty() {
        outputs.push(fullmag_ir::OutputIR::Field {
            name: "m".to_string(),
            every_seconds: 1e-12,
        });
        outputs.push(fullmag_ir::OutputIR::Scalar {
            name: "E_total".to_string(),
            every_seconds: 1e-12,
        });
    }
    fullmag_ir::SamplingIR {
        table_autosave: base.table_autosave.clone(),
        outputs,
    }
}

fn eigen_sampling_from(base: &fullmag_ir::SamplingIR, mode_count: u32) -> fullmag_ir::SamplingIR {
    let mut outputs: Vec<fullmag_ir::OutputIR> = base
        .outputs
        .iter()
        .filter(|output| {
            matches!(
                output,
                fullmag_ir::OutputIR::EigenSpectrum { .. }
                    | fullmag_ir::OutputIR::EigenMode { .. }
                    | fullmag_ir::OutputIR::DispersionCurve { .. }
            )
        })
        .cloned()
        .collect();
    for output in &mut outputs {
        if let fullmag_ir::OutputIR::EigenMode { indices, .. } = output {
            indices.retain(|index| *index < mode_count);
        }
    }
    outputs.retain(|output| {
        !matches!(
            output,
            fullmag_ir::OutputIR::EigenMode { indices, .. } if indices.is_empty()
        )
    });
    if !outputs.iter().any(|output| {
        matches!(
            output,
            fullmag_ir::OutputIR::EigenSpectrum { .. } | fullmag_ir::OutputIR::EigenMode { .. }
        )
    }) {
        outputs.push(fullmag_ir::OutputIR::EigenSpectrum {
            quantity: "spectrum".to_string(),
        });
    }
    fullmag_ir::SamplingIR {
        table_autosave: base.table_autosave.clone(),
        outputs,
    }
}

fn frequency_response_sampling_from(base: &fullmag_ir::SamplingIR) -> fullmag_ir::SamplingIR {
    fullmag_ir::SamplingIR {
        table_autosave: base.table_autosave.clone(),
        outputs: base
            .outputs
            .iter()
            .filter(|output| {
                matches!(
                    output,
                    fullmag_ir::OutputIR::FrequencyResponseOutput { .. }
                        | fullmag_ir::OutputIR::EigenSpectrum { .. }
                        | fullmag_ir::OutputIR::EigenMode { .. }
                        | fullmag_ir::OutputIR::DispersionCurve { .. }
                )
            })
            .cloned()
            .collect(),
    }
}

fn normalize_stage_sampling(ir: &mut ProblemIR) {
    match &mut ir.study {
        fullmag_ir::StudyIR::TimeEvolution { sampling, .. }
        | fullmag_ir::StudyIR::Relaxation { sampling, .. }
        | fullmag_ir::StudyIR::Hysteresis { sampling, .. } => {
            *sampling = time_domain_sampling_from(sampling);
        }
        fullmag_ir::StudyIR::Eigenmodes {
            sampling, count, ..
        } => {
            *sampling = eigen_sampling_from(sampling, *count);
        }
        fullmag_ir::StudyIR::FrequencyResponse { sampling, .. } => {
            *sampling = frequency_response_sampling_from(sampling);
        }
    }
}

fn materialize_pipeline_run(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let mut dynamics = ir.study.dynamics().clone();
    apply_dynamics_overrides(&mut dynamics, payload)?;
    let sampling = time_domain_sampling_from(ir.study.sampling());
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_run".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    ir.study = fullmag_ir::StudyIR::TimeEvolution { dynamics, sampling };
    let until_seconds = resolve_script_until_seconds(
        &ir,
        payload_f64(payload, "until_seconds")?.or(default_until_seconds),
    )?;
    if until_seconds <= 0.0 {
        bail!("run study pipeline stage requires a positive until_seconds value");
    }
    Ok(ResolvedScriptStage::solver(
        ir,
        until_seconds,
        entrypoint_kind,
    ))
}

fn materialize_pipeline_relax(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let mut dynamics = ir.study.dynamics().clone();
    apply_dynamics_overrides(&mut dynamics, payload)?;
    let sampling = time_domain_sampling_from(ir.study.sampling());
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_relax".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    let algorithm = payload_relaxation_algorithm(payload)?
        .unwrap_or(fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped);
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm,
        dynamics: (algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped)
            .then_some(dynamics),
        stop: payload_relax_stop(payload, true)?,
        sampling,
    };
    let until_seconds = resolve_script_until_seconds(&ir, None)?;
    Ok(ResolvedScriptStage::solver(
        ir,
        until_seconds,
        entrypoint_kind,
    ))
}

fn materialize_pipeline_eigenmodes(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let mut dynamics = ir.study.dynamics().clone();
    apply_dynamics_overrides(&mut dynamics, payload)?;
    let sampling = ir.study.sampling().clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_eigenmodes".to_string());
    let current_eigen = match &base_ir.study {
        fullmag_ir::StudyIR::Eigenmodes {
            operator,
            count,
            target,
            equilibrium,
            k_sampling,
            normalization,
            damping_policy,
            spin_wave_bc,
            ..
        } => Some((
            operator.clone(),
            *count,
            target.clone(),
            equilibrium.clone(),
            k_sampling.clone(),
            *normalization,
            *damping_policy,
            spin_wave_bc.clone(),
        )),
        _ => None,
    };
    let default_count = current_eigen
        .as_ref()
        .map(|current| current.1)
        .unwrap_or(10);
    let default_target = current_eigen
        .as_ref()
        .map(|current| current.2.clone())
        .unwrap_or(fullmag_ir::EigenTargetIR::Lowest);
    let default_equilibrium = current_eigen
        .as_ref()
        .map(|current| current.3.clone())
        .unwrap_or(fullmag_ir::EquilibriumSourceIR::RelaxedInitialState);
    let default_normalization = current_eigen
        .as_ref()
        .map(|current| current.5)
        .unwrap_or(fullmag_ir::EigenNormalizationIR::UnitL2);
    let default_damping_policy = current_eigen
        .as_ref()
        .map(|current| current.6)
        .unwrap_or(fullmag_ir::EigenDampingPolicyIR::Ignore);
    let default_spin_wave_bc = current_eigen
        .as_ref()
        .map(|current| current.7.clone())
        .unwrap_or_default();
    let count = payload_u32(payload, "eigen_count")?.unwrap_or(default_count);
    let include_demag = payload_bool(payload, "eigen_include_demag")?.unwrap_or_else(|| {
        current_eigen
            .as_ref()
            .map(|current| current.0.include_demag)
            .unwrap_or(true)
    });

    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics,
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag,
        },
        count,
        target: payload_eigen_target(payload, default_target)?,
        equilibrium: payload_equilibrium_source(payload, default_equilibrium)?,
        k_sampling: payload_k_sampling(
            payload,
            current_eigen.as_ref().and_then(|current| current.4.clone()),
        )?,
        normalization: payload_eigen_normalization(payload)?.unwrap_or(default_normalization),
        damping_policy: payload_eigen_damping_policy(payload)?.unwrap_or(default_damping_policy),
        spin_wave_bc: payload_spin_wave_bc(payload)?.unwrap_or(default_spin_wave_bc),
        sampling: eigen_sampling_from(&sampling, count),
        mode_tracking: None,
    };

    Ok(ResolvedScriptStage::solver(ir, 0.0, entrypoint_kind))
}

fn materialize_pipeline_frequency_response(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let mut dynamics = ir.study.dynamics().clone();
    apply_dynamics_overrides(&mut dynamics, payload)?;
    let sampling = ir.study.sampling().clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_frequency_response".to_string());
    let current_frequency = match &base_ir.study {
        fullmag_ir::StudyIR::FrequencyResponse {
            operator,
            equilibrium,
            k_sampling,
            normalization,
            damping_policy,
            spin_wave_bc,
            excitation,
            frequencies_hz,
            ..
        } => Some((
            operator.clone(),
            equilibrium.clone(),
            k_sampling.clone(),
            *normalization,
            *damping_policy,
            spin_wave_bc.clone(),
            excitation.clone(),
            frequencies_hz.clone(),
        )),
        _ => None,
    };
    let include_demag = payload_bool(payload, "frequency_include_demag")?.unwrap_or_else(|| {
        current_frequency
            .as_ref()
            .map(|current| current.0.include_demag)
            .unwrap_or(true)
    });
    let default_equilibrium = current_frequency
        .as_ref()
        .map(|current| current.1.clone())
        .unwrap_or(fullmag_ir::EquilibriumSourceIR::Provided);
    let default_k_sampling = current_frequency
        .as_ref()
        .and_then(|current| current.2.clone());
    let default_normalization = current_frequency
        .as_ref()
        .map(|current| current.3)
        .unwrap_or(fullmag_ir::FrequencyResponseNormalizationIR::UnitL2);
    let default_damping_policy = current_frequency
        .as_ref()
        .map(|current| current.4)
        .unwrap_or(fullmag_ir::EigenDampingPolicyIR::Ignore);
    let default_spin_wave_bc = current_frequency
        .as_ref()
        .map(|current| current.5.clone())
        .unwrap_or_default();
    let default_magnetostatic_bc = match &base_ir.study {
        fullmag_ir::StudyIR::FrequencyResponse {
            magnetostatic_bc, ..
        } => *magnetostatic_bc,
        _ => fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
    };
    let default_excitation = current_frequency
        .as_ref()
        .map(|current| current.6.field_au_per_m)
        .unwrap_or([0.0, 0.0, 1.0]);
    let default_excitation_phase_rad = current_frequency
        .as_ref()
        .map(|current| current.6.phase_rad)
        .unwrap_or(0.0);
    let default_frequencies = current_frequency
        .as_ref()
        .map(|current| current.7.values_hz.clone())
        .unwrap_or_else(|| vec![1.0e9]);
    let default_solver_policy = match &base_ir.study {
        fullmag_ir::StudyIR::FrequencyResponse { solver_policy, .. } => solver_policy.clone(),
        _ => None,
    };

    let frequencies_hz =
        payload_f64_array(payload, "frequency_values_hz")?.unwrap_or(default_frequencies);
    if frequencies_hz.is_empty()
        || frequencies_hz
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        bail!("study pipeline frequency_response stage requires positive frequency_values_hz");
    }
    let excitation_phase_rad = payload_f64(payload, "frequency_excitation_phase_rad")?
        .unwrap_or(default_excitation_phase_rad);
    if !excitation_phase_rad.is_finite() {
        bail!("study pipeline frequency_response stage requires finite frequency_excitation_phase_rad");
    }

    let frequency_payload = frequency_payload_as_eigen_payload(payload);
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    ir.study = fullmag_ir::StudyIR::FrequencyResponse {
        dynamics,
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag,
        },
        equilibrium: payload_equilibrium_source(&frequency_payload, default_equilibrium)?,
        k_sampling: payload_k_sampling(&frequency_payload, default_k_sampling)?,
        normalization: payload_frequency_normalization(payload)?.unwrap_or(default_normalization),
        damping_policy: payload_eigen_damping_policy(&frequency_payload)?
            .unwrap_or(default_damping_policy),
        spin_wave_bc: payload_spin_wave_bc(&frequency_payload)?.unwrap_or(default_spin_wave_bc),
        magnetostatic_bc: payload_frequency_magnetostatic_bc(payload)?
            .unwrap_or(default_magnetostatic_bc),
        excitation: fullmag_ir::FrequencyExcitationIR {
            field_au_per_m: payload_vec3(
                payload,
                "frequency_excitation_field_au_per_m",
                default_excitation,
            )?,
            phase_rad: excitation_phase_rad,
        },
        frequencies_hz: fullmag_ir::FrequencySweepIR {
            values_hz: frequencies_hz,
        },
        solver_policy: payload_frequency_solver_policy(payload, default_solver_policy)?,
        sampling: fullmag_ir::SamplingIR {
            table_autosave: sampling.table_autosave,
            outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                observable: payload_frequency_observable(payload)?,
            }],
        },
    };

    Ok(ResolvedScriptStage::solver(ir, 0.0, entrypoint_kind))
}

fn frequency_payload_as_eigen_payload(
    payload: &BTreeMap<String, Value>,
) -> BTreeMap<String, Value> {
    let mut mapped = payload.clone();
    for (frequency_key, eigen_key) in [
        ("frequency_equilibrium_source", "eigen_equilibrium_source"),
        (
            "frequency_equilibrium_artifact",
            "eigen_equilibrium_artifact",
        ),
        ("frequency_damping_policy", "eigen_damping_policy"),
        ("frequency_k_vector", "eigen_k_vector"),
        ("frequency_spin_wave_bc", "eigen_spin_wave_bc"),
        ("frequency_spin_wave_bc_config", "eigen_spin_wave_bc_config"),
    ] {
        if let Some(value) = payload.get(frequency_key) {
            mapped.insert(eigen_key.to_string(), value.clone());
        }
    }
    mapped
}

fn materialize_pipeline_save_state(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_save_state".to_string());
    let artifact_name =
        payload_string(payload, "artifact_name").unwrap_or_else(|| "state_snapshot".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        ir,
        entrypoint_kind,
        ResolvedScriptStageAction::SaveState {
            artifact_name,
            format: payload_string(payload, "format"),
            dataset: payload_string(payload, "dataset"),
        },
    ))
}

fn materialize_pipeline_load_state(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_load_state".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        ir,
        entrypoint_kind,
        ResolvedScriptStageAction::LoadState {
            artifact_name: payload_string(payload, "artifact_name"),
            state_path: payload_string(payload, "state_path"),
            format: payload_string(payload, "format"),
            dataset: payload_string(payload, "dataset"),
            sample_index: payload_i64(payload, "sample_index")?,
        },
    ))
}

fn materialize_pipeline_export(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_export".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        ir,
        entrypoint_kind,
        ResolvedScriptStageAction::Export {
            artifact_name: payload_string(payload, "artifact_name"),
            quantity: payload_string(payload, "quantity")
                .unwrap_or_else(|| "magnetization".to_string()),
            format: payload_string(payload, "format").unwrap_or_else(|| "json".to_string()),
            dataset: payload_string(payload, "dataset"),
        },
    ))
}

fn materialize_pipeline_change_device(
    current_ir: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let device = normalize_pipeline_device(
        payload_string(payload, "device")
            .unwrap_or_else(|| "auto".to_string())
            .as_str(),
    )?;
    set_runtime_selection_device(current_ir, &device);
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_change_device".to_string());
    current_ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        current_ir.clone(),
        entrypoint_kind,
        ResolvedScriptStageAction::ChangeDevice { device },
    ))
}

fn materialize_pipeline_field_sweep(
    current_ir: &mut ProblemIR,
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
    macro_kind: &str,
) -> Result<Vec<ResolvedScriptStage>> {
    let start_mt = payload_f64(config, "start_mT")?.unwrap_or(-100.0);
    let stop_mt = payload_f64(config, "stop_mT")?.unwrap_or(100.0);
    let steps = payload_u64(config, "steps")?.unwrap_or(if macro_kind == "hysteresis_loop" {
        21
    } else {
        11
    });
    let relax_each = payload_bool(config, "relax_each")?.unwrap_or(true);
    let save_point_state = payload_bool(config, "save_point_state")?
        .unwrap_or(macro_kind == "field_sweep_relax_snapshot");
    let save_format = payload_string(config, "save_format");
    let save_dataset = payload_string(config, "save_dataset");
    let axis = payload_axis(config, "axis", [0.0, 0.0, 1.0])?;
    let settle_until_seconds = payload_f64(config, "settle_until_seconds")?
        .or(default_until_seconds)
        .unwrap_or(1e-12);

    if steps == 0 {
        bail!("study pipeline {macro_kind} requires steps >= 1");
    }
    if settle_until_seconds <= 0.0 {
        bail!("study pipeline {macro_kind} requires a positive settle_until_seconds");
    }

    let sweep_values_mt = linear_sweep_values(start_mt, stop_mt, steps)?;
    let stage_multiplier = 1 + usize::from(relax_each) + usize::from(save_point_state);
    let mut stages = Vec::with_capacity(sweep_values_mt.len() * stage_multiplier);

    for (point_index, amplitude_mt) in sweep_values_mt.iter().enumerate() {
        let field_t = scaled_axis(axis, *amplitude_mt * 1e-3);
        apply_pipeline_external_field(current_ir, field_t);

        let mut point_ir = current_ir.clone();
        apply_pipeline_external_field(&mut point_ir, field_t);

        let mut run_payload = config.clone();
        run_payload.insert(
            "entrypoint_kind".to_string(),
            Value::String(format!(
                "study_pipeline_{}_point_{:03}_run",
                macro_kind,
                point_index + 1
            )),
        );
        run_payload.insert(
            "until_seconds".to_string(),
            Value::String(settle_until_seconds.to_string()),
        );
        stages.push(materialize_pipeline_run(
            &point_ir,
            &run_payload,
            Some(settle_until_seconds),
        )?);

        if relax_each {
            let mut relax_payload = config.clone();
            relax_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_{}_point_{:03}_relax",
                    macro_kind,
                    point_index + 1
                )),
            );
            stages.push(materialize_pipeline_relax(&point_ir, &relax_payload)?);
        }

        if save_point_state {
            let mut save_payload = BTreeMap::<String, Value>::new();
            save_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_{}_point_{:03}_save_state",
                    macro_kind,
                    point_index + 1
                )),
            );
            save_payload.insert(
                "artifact_name".to_string(),
                Value::String(format!("{}_point_{:03}", macro_kind, point_index + 1)),
            );
            if let Some(format) = save_format.as_ref() {
                save_payload.insert("format".to_string(), Value::String(format.clone()));
            }
            if let Some(dataset) = save_dataset.as_ref() {
                save_payload.insert("dataset".to_string(), Value::String(dataset.clone()));
            }
            stages.push(materialize_pipeline_save_state(&point_ir, &save_payload)?);
        }
    }

    Ok(stages)
}

fn hysteresis_settle_stop(
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
) -> Result<fullmag_ir::RelaxStopIR> {
    let mut settle_payload = match config.get("settle") {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>(),
        Some(Value::Null) | None => BTreeMap::new(),
        Some(_) => {
            bail!("study pipeline hysteresis_loop expects config.settle to be an object")
        }
    };

    for key in [
        "torque_tolerance_apm",
        "torque_tolerance",
        "energy_tolerance_j",
        "energy_tolerance",
        "max_steps",
        "max_relaxation_time_s",
        "max_pseudotime_s",
        "max_physical_time_s",
    ] {
        if !settle_payload.contains_key(key) {
            if let Some(value) = config.get(key) {
                settle_payload.insert(key.to_string(), value.clone());
            }
        }
    }
    if !settle_payload.contains_key("max_physical_time_s") {
        if let Some(settle_until_seconds) =
            payload_f64(config, "settle_until_seconds")?.or(default_until_seconds)
        {
            settle_payload.insert(
                "max_physical_time_s".to_string(),
                Value::String(settle_until_seconds.to_string()),
            );
        }
    }

    payload_relax_stop(&settle_payload, true)
}

fn inject_relax_stop_payload(
    payload: &mut BTreeMap<String, Value>,
    stop: &fullmag_ir::RelaxStopIR,
) {
    if let Some(value) = stop.torque_tolerance_apm {
        payload.insert(
            "torque_tolerance_apm".to_string(),
            Value::String(value.to_string()),
        );
    }
    if let Some(value) = stop.energy_tolerance_j {
        payload.insert(
            "energy_tolerance_j".to_string(),
            Value::String(value.to_string()),
        );
    }
    if let Some(value) = stop.max_steps {
        payload.insert("max_steps".to_string(), Value::String(value.to_string()));
    }
    if let Some(value) = stop.max_relaxation_time_s {
        payload.insert(
            "max_relaxation_time_s".to_string(),
            Value::String(value.to_string()),
        );
    }
}

fn materialize_pipeline_hysteresis_branch(
    current_ir: &mut ProblemIR,
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
) -> Result<Vec<ResolvedScriptStage>> {
    let quantity = payload_string(config, "quantity").unwrap_or_else(|| "b_ext".to_string());
    if quantity != "b_ext" && quantity != "external_field" {
        bail!(
            "study pipeline hysteresis_loop currently supports only quantity='b_ext', got '{}'",
            quantity
        );
    }

    let axis = if config.contains_key("direction") {
        payload_axis(config, "direction", [0.0, 0.0, 1.0])?
    } else {
        payload_axis(config, "axis", [0.0, 0.0, 1.0])?
    };
    let save_point_state = payload_bool(config, "save_state")?
        .or(payload_bool(config, "save_point_state")?)
        .unwrap_or(false);
    let save_format = payload_string(config, "save_format");
    let save_dataset = payload_string(config, "save_dataset");
    let settle_stop = hysteresis_settle_stop(config, default_until_seconds)?;

    let sweep_values_t =
        if let Some(explicit_values_t) = payload_f64_array(config, "field_values_t")? {
            if explicit_values_t.is_empty() {
                bail!("study pipeline hysteresis_loop requires field_values_t to be non-empty");
            }
            explicit_values_t
        } else {
            let start_mt = payload_f64(config, "start_mT")?.unwrap_or(-100.0);
            let stop_mt = payload_f64(config, "stop_mT")?.unwrap_or(100.0);
            let steps = payload_u64(config, "steps")?.unwrap_or(21);
            if steps == 0 {
                bail!("study pipeline hysteresis_loop requires steps >= 1");
            }
            linear_sweep_values(start_mt, stop_mt, steps)?
                .into_iter()
                .map(|value_mt| value_mt * 1e-3)
                .collect::<Vec<_>>()
        };

    let mut stages = Vec::with_capacity(sweep_values_t.len() * (1 + usize::from(save_point_state)));
    for (point_index, amplitude_t) in sweep_values_t.iter().enumerate() {
        let field_t = scaled_axis(axis, *amplitude_t);
        apply_pipeline_external_field(current_ir, field_t);

        let mut point_ir = current_ir.clone();
        apply_pipeline_external_field(&mut point_ir, field_t);

        let mut relax_payload = config.clone();
        relax_payload.insert(
            "entrypoint_kind".to_string(),
            Value::String(format!(
                "study_pipeline_hysteresis_branch_point_{:03}_relax",
                point_index + 1
            )),
        );
        inject_relax_stop_payload(&mut relax_payload, &settle_stop);
        stages.push(materialize_pipeline_relax(&point_ir, &relax_payload)?);

        if save_point_state {
            let mut save_payload = BTreeMap::<String, Value>::new();
            save_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_hysteresis_branch_point_{:03}_save_state",
                    point_index + 1
                )),
            );
            save_payload.insert(
                "artifact_name".to_string(),
                Value::String(format!("hysteresis_branch_point_{:03}", point_index + 1)),
            );
            if let Some(format) = save_format.as_ref() {
                save_payload.insert("format".to_string(), Value::String(format.clone()));
            }
            if let Some(dataset) = save_dataset.as_ref() {
                save_payload.insert("dataset".to_string(), Value::String(dataset.clone()));
            }
            stages.push(materialize_pipeline_save_state(&point_ir, &save_payload)?);
        }
    }

    Ok(stages)
}

#[derive(Debug, Clone, Copy)]
struct ParameterSweepSolvePattern {
    run_each: bool,
    relax_each: bool,
}

fn parameter_sweep_solve_pattern(
    config: &BTreeMap<String, Value>,
) -> Result<ParameterSweepSolvePattern> {
    let solve_kind = payload_string(config, "solve_kind")
        .unwrap_or_else(|| "run_relax".to_string())
        .trim()
        .to_ascii_lowercase();
    let pattern = match solve_kind.as_str() {
        "run" => ParameterSweepSolvePattern {
            run_each: true,
            relax_each: false,
        },
        "relax" => ParameterSweepSolvePattern {
            run_each: false,
            relax_each: true,
        },
        "run_relax" | "relax_run" => ParameterSweepSolvePattern {
            run_each: true,
            relax_each: true,
        },
        other => {
            bail!(
                "parameter_sweep solve_kind '{}' is not supported; use run, relax, or run_relax",
                other
            )
        }
    };
    Ok(pattern)
}

fn materialize_pipeline_parameter_sweep(
    current_ir: &mut ProblemIR,
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
) -> Result<Vec<ResolvedScriptStage>> {
    let parameter = payload_string(config, "parameter")
        .or_else(|| payload_string(config, "quantity"))
        .unwrap_or_else(|| "b_ext".to_string())
        .trim()
        .to_ascii_lowercase();
    let axis = payload_axis(config, "axis", [0.0, 0.0, 1.0])?;
    let steps = payload_u64(config, "steps")?.unwrap_or(11);
    if steps == 0 {
        bail!("parameter_sweep requires steps >= 1");
    }

    let is_field_parameter = matches!(
        parameter.as_str(),
        "b_ext" | "external_field" | "zeeman_b" | "field" | "field_mt"
    );
    let is_current_parameter = matches!(
        parameter.as_str(),
        "current_density" | "j" | "j_ext" | "current"
    );
    if !is_field_parameter && !is_current_parameter {
        bail!(
            "parameter_sweep parameter '{}' is not supported yet; supported parameters: b_ext, current_density",
            parameter
        );
    }

    let start_raw = payload_f64(config, "start_value")?
        .or(payload_f64(config, "start")?)
        .or(payload_f64(config, "start_mT")?)
        .unwrap_or(if is_field_parameter { -100.0 } else { 0.0 });
    let stop_raw = payload_f64(config, "stop_value")?
        .or(payload_f64(config, "stop")?)
        .or(payload_f64(config, "stop_mT")?)
        .unwrap_or(if is_field_parameter { 100.0 } else { 1e10 });
    let values_raw = linear_sweep_values(start_raw, stop_raw, steps)?;
    let values_si = if is_field_parameter {
        values_raw
            .iter()
            .map(|value| value * 1e-3)
            .collect::<Vec<_>>()
    } else {
        values_raw
    };
    let solve_pattern = parameter_sweep_solve_pattern(config)?;
    let save_point_state = payload_bool(config, "save_point_state")?.unwrap_or(false);
    let save_format = payload_string(config, "save_format");
    let save_dataset = payload_string(config, "save_dataset");

    let run_until_seconds = payload_f64(config, "run_until_seconds")?
        .or(payload_f64(config, "settle_until_seconds")?)
        .or(default_until_seconds)
        .unwrap_or(1e-12);
    if solve_pattern.run_each && run_until_seconds <= 0.0 {
        bail!("parameter_sweep requires positive run_until_seconds when solve_kind includes run");
    }

    let stage_multiplier = usize::from(solve_pattern.run_each)
        + usize::from(solve_pattern.relax_each)
        + usize::from(save_point_state);
    let mut stages = Vec::with_capacity(values_si.len() * stage_multiplier.max(1));
    for (point_index, value_si) in values_si.iter().enumerate() {
        if is_field_parameter {
            apply_pipeline_external_field(current_ir, scaled_axis(axis, *value_si));
        } else {
            current_ir.current_density = Some(scaled_axis(axis, *value_si));
        }

        let mut point_ir = current_ir.clone();
        if is_field_parameter {
            apply_pipeline_external_field(&mut point_ir, scaled_axis(axis, *value_si));
        } else {
            point_ir.current_density = Some(scaled_axis(axis, *value_si));
        }

        if solve_pattern.run_each {
            let mut run_payload = config.clone();
            run_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_parameter_sweep_point_{:03}_run",
                    point_index + 1
                )),
            );
            run_payload.insert(
                "until_seconds".to_string(),
                Value::String(run_until_seconds.to_string()),
            );
            stages.push(materialize_pipeline_run(
                &point_ir,
                &run_payload,
                Some(run_until_seconds),
            )?);
        }

        if solve_pattern.relax_each {
            let mut relax_payload = config.clone();
            relax_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_parameter_sweep_point_{:03}_relax",
                    point_index + 1
                )),
            );
            stages.push(materialize_pipeline_relax(&point_ir, &relax_payload)?);
        }

        if save_point_state {
            let mut save_payload = BTreeMap::<String, Value>::new();
            save_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_parameter_sweep_point_{:03}_save_state",
                    point_index + 1
                )),
            );
            save_payload.insert(
                "artifact_name".to_string(),
                Value::String(format!("parameter_sweep_point_{:03}", point_index + 1)),
            );
            if let Some(format) = save_format.as_ref() {
                save_payload.insert("format".to_string(), Value::String(format.clone()));
            }
            if let Some(dataset) = save_dataset.as_ref() {
                save_payload.insert("dataset".to_string(), Value::String(dataset.clone()));
            }
            stages.push(materialize_pipeline_save_state(&point_ir, &save_payload)?);
        }
    }
    Ok(stages)
}

fn apply_dynamics_overrides(
    dynamics: &mut fullmag_ir::DynamicsIR,
    payload: &BTreeMap<String, Value>,
) -> Result<()> {
    match dynamics {
        fullmag_ir::DynamicsIR::Llg {
            integrator,
            fixed_timestep,
            ..
        } => {
            let integrator_override = payload_string(payload, "integrator");
            if let Some(value) = integrator_override.as_ref() {
                *integrator = value.clone();
            }
            if payload.contains_key("fixed_timestep") {
                *fixed_timestep = payload_f64(payload, "fixed_timestep")?;
            } else if matches!(integrator_override.as_deref(), Some("rk45" | "rk23")) {
                *fixed_timestep = None;
            }
        }
    }
    Ok(())
}

fn payload_string(payload: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    match payload.get(key) {
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn normalize_pipeline_device(device: &str) -> Result<String> {
    let normalized = device.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "auto" | "cpu" | "gpu" | "cuda") {
        return Ok(normalized);
    }
    if let Some(index) = normalized.strip_prefix("cuda:") {
        if !index.is_empty() && index.chars().all(|ch| ch.is_ascii_digit()) {
            return Ok(normalized);
        }
    }
    bail!("change_device requires device 'auto', 'cpu', 'gpu', 'cuda', or 'cuda:<index>'");
}

fn set_runtime_selection_device(ir: &mut ProblemIR, device: &str) {
    let mut runtime_selection = ir
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let (device_label, device_index) = if let Some(index) = device.strip_prefix("cuda:") {
        (
            "cuda".to_string(),
            index.parse::<i64>().ok().map(Value::from),
        )
    } else {
        (device.to_string(), None)
    };

    runtime_selection.insert("device".to_string(), Value::String(device_label.clone()));
    runtime_selection.insert("explicit_selection".to_string(), Value::Bool(true));

    if device_label == "cpu" || device_label == "auto" {
        runtime_selection.insert("gpu_count".to_string(), Value::from(0));
        runtime_selection.remove("device_index");
    } else {
        runtime_selection.insert("gpu_count".to_string(), Value::from(1));
        if let Some(index) = device_index {
            runtime_selection.insert("device_index".to_string(), index);
        } else {
            runtime_selection.remove("device_index");
        }
    }

    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        Value::Object(runtime_selection),
    );
}

fn payload_f64(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<f64>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .parse::<f64>()
                .with_context(|| format!("invalid floating-point value for payload field '{key}'"))
                .map(Some)
        }
        Value::Number(value) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("invalid numeric value for payload field '{key}'")),
        _ => bail!("payload field '{key}' must be a number or numeric string"),
    }
}

fn payload_u64(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<u64>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .parse::<u64>()
                .with_context(|| format!("invalid integer value for payload field '{key}'"))
                .map(Some)
        }
        Value::Number(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("invalid integer value for payload field '{key}'")),
        _ => bail!("payload field '{key}' must be an integer or integer string"),
    }
}

fn payload_u32(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<u32>> {
    payload_u64(payload, key)?.map_or(Ok(None), |value| {
        u32::try_from(value)
            .with_context(|| format!("payload field '{key}' does not fit into u32"))
            .map(Some)
    })
}

fn payload_i64(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<i64>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .parse::<i64>()
                .with_context(|| format!("invalid integer value for payload field '{key}'"))
                .map(Some)
        }
        Value::Number(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("invalid integer value for payload field '{key}'")),
        _ => bail!("payload field '{key}' must be an integer or integer string"),
    }
}

fn payload_bool(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<bool>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::Bool(value) => Ok(Some(*value)),
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            match trimmed {
                "true" => Ok(Some(true)),
                "false" => Ok(Some(false)),
                _ => bail!("payload field '{key}' must be a boolean or 'true'/'false' string"),
            }
        }
        _ => bail!("payload field '{key}' must be a boolean"),
    }
}

fn payload_f64_array(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<Vec<f64>>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::Array(values) => {
            let mut parsed = Vec::with_capacity(values.len());
            for (index, value) in values.iter().enumerate() {
                let component = match value {
                    Value::Number(number) => number.as_f64().ok_or_else(|| {
                        anyhow::anyhow!(
                            "invalid numeric component at payload field '{key}[{index}]'"
                        )
                    })?,
                    Value::String(text) => text.trim().parse::<f64>().with_context(|| {
                        format!(
                            "invalid floating-point component at payload field '{key}[{index}]'"
                        )
                    })?,
                    _ => {
                        bail!(
                            "payload field '{key}' must contain numeric values (array index {index})"
                        )
                    }
                };
                parsed.push(component);
            }
            Ok(Some(parsed))
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .split(',')
                .map(|component| {
                    component.trim().parse::<f64>().with_context(|| {
                        format!(
                            "invalid floating-point component in comma-separated payload field '{key}'"
                        )
                    })
                })
                .collect::<Result<Vec<_>>>()
                .map(Some)
        }
        _ => bail!("payload field '{key}' must be an array or comma-separated string"),
    }
}

fn payload_vec3(
    payload: &BTreeMap<String, Value>,
    key: &str,
    default: [f64; 3],
) -> Result<[f64; 3]> {
    let Some(values) = payload_f64_array(payload, key)? else {
        return Ok(default);
    };
    if values.len() != 3 {
        bail!("payload field '{key}' must contain exactly 3 vector components");
    }
    if values.iter().any(|value| !value.is_finite()) {
        bail!("payload field '{key}' must contain finite vector components");
    }
    Ok([values[0], values[1], values[2]])
}

fn payload_relaxation_algorithm(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::RelaxationAlgorithmIR>> {
    match payload_string(payload, "relax_algorithm") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid relax_algorithm in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_relax_stop(
    payload: &BTreeMap<String, Value>,
    apply_legacy_defaults: bool,
) -> Result<fullmag_ir::RelaxStopIR> {
    let torque_tolerance_apm =
        payload_f64(payload, "torque_tolerance_apm")?.or(payload_f64(payload, "torque_tolerance")?);
    let energy_tolerance_j =
        payload_f64(payload, "energy_tolerance_j")?.or(payload_f64(payload, "energy_tolerance")?);
    let max_steps = payload_u64(payload, "max_steps")?;
    let max_relaxation_time_s = payload_f64(payload, "max_relaxation_time_s")?;
    let max_pseudotime_s = payload_f64(payload, "max_pseudotime_s")?;
    let max_physical_time_s = payload_f64(payload, "max_physical_time_s")?;
    if max_relaxation_time_s.is_some()
        && (max_pseudotime_s.is_some() || max_physical_time_s.is_some())
    {
        bail!("max_relaxation_time_s conflicts with legacy max_pseudotime_s/max_physical_time_s");
    }
    if max_pseudotime_s.is_some()
        && max_physical_time_s.is_some()
        && max_pseudotime_s != max_physical_time_s
    {
        bail!("legacy max_pseudotime_s and max_physical_time_s conflict");
    }

    let any_explicit = torque_tolerance_apm.is_some()
        || energy_tolerance_j.is_some()
        || max_steps.is_some()
        || max_relaxation_time_s.is_some()
        || max_pseudotime_s.is_some()
        || max_physical_time_s.is_some();

    Ok(fullmag_ir::RelaxStopIR {
        torque_tolerance_apm: if apply_legacy_defaults && !any_explicit {
            Some(1e-4)
        } else {
            torque_tolerance_apm
        },
        energy_tolerance_j,
        max_steps: if apply_legacy_defaults && !any_explicit {
            Some(50_000)
        } else {
            max_steps
        },
        max_relaxation_time_s: max_relaxation_time_s
            .or(max_physical_time_s)
            .or(max_pseudotime_s),
    })
}

fn payload_eigen_target(
    payload: &BTreeMap<String, Value>,
    default_target: fullmag_ir::EigenTargetIR,
) -> Result<fullmag_ir::EigenTargetIR> {
    let target_kind =
        payload_string(payload, "eigen_target").unwrap_or_else(|| match default_target {
            fullmag_ir::EigenTargetIR::Lowest => "lowest".to_string(),
            fullmag_ir::EigenTargetIR::Nearest { .. } => "nearest".to_string(),
            fullmag_ir::EigenTargetIR::FrequencyWindow { .. } => "frequency_window".to_string(),
        });
    match target_kind.as_str() {
        "lowest" => Ok(fullmag_ir::EigenTargetIR::Lowest),
        "nearest" => {
            let default_frequency = match default_target {
                fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => Some(frequency_hz),
                fullmag_ir::EigenTargetIR::Lowest
                | fullmag_ir::EigenTargetIR::FrequencyWindow { .. } => None,
            };
            let frequency_hz = payload_f64(payload, "eigen_target_frequency")?
                .or(default_frequency)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "study pipeline eigenmodes stage with eigen_target='nearest' requires eigen_target_frequency"
                    )
                })?;
            Ok(fullmag_ir::EigenTargetIR::Nearest { frequency_hz })
        }
        "frequency_window" => {
            let (default_min, default_max) = match default_target {
                fullmag_ir::EigenTargetIR::FrequencyWindow {
                    frequency_min_hz,
                    frequency_max_hz,
                } => (Some(frequency_min_hz), Some(frequency_max_hz)),
                _ => (None, None),
            };
            let frequency_min_hz = payload_f64(payload, "eigen_frequency_min")?
                .or(payload_f64(payload, "frequency_min")?)
                .or(default_min)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "study pipeline eigenmodes stage with eigen_target='frequency_window' requires eigen_frequency_min"
                    )
                })?;
            let frequency_max_hz = payload_f64(payload, "eigen_frequency_max")?
                .or(payload_f64(payload, "frequency_max")?)
                .or(default_max)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "study pipeline eigenmodes stage with eigen_target='frequency_window' requires eigen_frequency_max"
                    )
                })?;
            Ok(fullmag_ir::EigenTargetIR::FrequencyWindow {
                frequency_min_hz,
                frequency_max_hz,
            })
        }
        other => bail!("unsupported eigen_target value '{other}'"),
    }
}

fn payload_equilibrium_source(
    payload: &BTreeMap<String, Value>,
    default_equilibrium: fullmag_ir::EquilibriumSourceIR,
) -> Result<fullmag_ir::EquilibriumSourceIR> {
    let default_label = match &default_equilibrium {
        fullmag_ir::EquilibriumSourceIR::Provided => "provided",
        fullmag_ir::EquilibriumSourceIR::RelaxedInitialState => "relax",
        fullmag_ir::EquilibriumSourceIR::Artifact { .. } => "artifact",
    };
    let source = payload_string(payload, "eigen_equilibrium_source")
        .unwrap_or_else(|| default_label.to_string());
    match source.as_str() {
        "provided" => Ok(fullmag_ir::EquilibriumSourceIR::Provided),
        "relax" => Ok(fullmag_ir::EquilibriumSourceIR::RelaxedInitialState),
        "artifact" => {
            let path = payload_string(payload, "eigen_equilibrium_artifact").or_else(|| {
                match default_equilibrium {
                    fullmag_ir::EquilibriumSourceIR::Artifact { path } => Some(path),
                    _ => None,
                }
            });
            let path = path.ok_or_else(|| {
                anyhow::anyhow!(
                    "study pipeline eigenmodes stage with equilibrium_source='artifact' requires eigen_equilibrium_artifact"
                )
            })?;
            Ok(fullmag_ir::EquilibriumSourceIR::Artifact { path })
        }
        other => bail!("unsupported eigen_equilibrium_source value '{other}'"),
    }
}

fn payload_eigen_normalization(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::EigenNormalizationIR>> {
    match payload_string(payload, "eigen_normalization") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid eigen_normalization in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_eigen_damping_policy(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::EigenDampingPolicyIR>> {
    match payload_string(payload, "eigen_damping_policy") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid eigen_damping_policy in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_frequency_normalization(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::FrequencyResponseNormalizationIR>> {
    match payload_string(payload, "frequency_normalization") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid frequency_normalization in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_frequency_observable(
    payload: &BTreeMap<String, Value>,
) -> Result<fullmag_ir::FrequencyResponseOutputIR> {
    let value = payload_string(payload, "frequency_observable")
        .unwrap_or_else(|| "susceptibility_tensor".to_string());
    serde_json::from_value(Value::String(value))
        .context("invalid frequency_observable in study pipeline payload")
}

fn payload_k_sampling(
    payload: &BTreeMap<String, Value>,
    default_sampling: Option<fullmag_ir::KSamplingIR>,
) -> Result<Option<fullmag_ir::KSamplingIR>> {
    let parsed = match payload.get("eigen_k_vector") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                let values: Vec<f64> = trimmed
                    .split(',')
                    .map(|component| {
                        component.trim().parse::<f64>().with_context(|| {
                            "invalid eigen_k_vector component in study pipeline payload"
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                if values.len() != 3 {
                    bail!("eigen_k_vector must contain exactly 3 comma-separated values");
                }
                Some([values[0], values[1], values[2]])
            }
        }
        Some(Value::Array(values)) => {
            if values.len() != 3 {
                bail!("eigen_k_vector array must contain exactly 3 entries");
            }
            Some([
                values[0]
                    .as_f64()
                    .ok_or_else(|| anyhow::anyhow!("invalid eigen_k_vector[0] value"))?,
                values[1]
                    .as_f64()
                    .ok_or_else(|| anyhow::anyhow!("invalid eigen_k_vector[1] value"))?,
                values[2]
                    .as_f64()
                    .ok_or_else(|| anyhow::anyhow!("invalid eigen_k_vector[2] value"))?,
            ])
        }
        _ => bail!("eigen_k_vector must be a comma-separated string or 3-element array"),
    };
    Ok(match parsed {
        Some(k_vector) => Some(fullmag_ir::KSamplingIR::Single { k_vector }),
        None => default_sampling,
    })
}

fn payload_spin_wave_bc(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::SpinWaveBoundaryConditionIR>> {
    if let Some(config) = payload.get("eigen_spin_wave_bc_config") {
        if matches!(config, Value::Null) {
            return Ok(None);
        }
        return serde_json::from_value(config.clone())
            .context("invalid eigen_spin_wave_bc_config in study pipeline payload")
            .map(Some);
    }
    match payload_string(payload, "eigen_spin_wave_bc") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid eigen_spin_wave_bc in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_frequency_magnetostatic_bc(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::MagnetostaticBoundaryConditionIR>> {
    match payload_string(payload, "frequency_magnetostatic_bc") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid frequency_magnetostatic_bc in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_frequency_solver_policy(
    payload: &BTreeMap<String, Value>,
    default: Option<fullmag_ir::FrequencyResponseSolverPolicyIR>,
) -> Result<Option<fullmag_ir::FrequencyResponseSolverPolicyIR>> {
    let method = match payload_string(payload, "frequency_solver_method") {
        Some(value) => Some(
            serde_json::from_value(Value::String(value))
                .context("invalid frequency_solver_method in study pipeline payload")?,
        ),
        None => None,
    };
    let preconditioner = match payload_string(payload, "frequency_solver_preconditioner") {
        Some(value) => Some(
            serde_json::from_value(Value::String(value))
                .context("invalid frequency_solver_preconditioner in study pipeline payload")?,
        ),
        None => None,
    };
    let rtol = payload_f64(payload, "frequency_solver_rtol")?;
    let max_iterations = payload_u64(payload, "frequency_solver_max_iterations")?;
    let restart_iterations = payload_u64(payload, "frequency_solver_restart_iterations")?;
    if method.is_none()
        && preconditioner.is_none()
        && rtol.is_none()
        && max_iterations.is_none()
        && restart_iterations.is_none()
    {
        return Ok(default);
    }
    if let Some(rtol) = rtol {
        if !rtol.is_finite() || rtol <= 0.0 {
            bail!("frequency_solver_rtol must be finite and positive");
        }
    }
    if matches!(max_iterations, Some(0)) {
        bail!("frequency_solver_max_iterations must be positive");
    }
    if matches!(restart_iterations, Some(0)) {
        bail!("frequency_solver_restart_iterations must be positive");
    }
    if let (Some(restart), Some(max)) = (restart_iterations, max_iterations) {
        if restart > max {
            bail!("frequency_solver_restart_iterations must be <= frequency_solver_max_iterations");
        }
    }
    Ok(Some(fullmag_ir::FrequencyResponseSolverPolicyIR {
        method,
        preconditioner,
        rtol,
        max_iterations,
        restart_iterations,
    }))
}

fn apply_pipeline_set_field(
    problem: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<()> {
    let axis = payload_axis(payload, "axis", [0.0, 0.0, 1.0])?;
    let field_mt = payload_f64(payload, "field_mT")?.unwrap_or(50.0);
    apply_pipeline_external_field(problem, scaled_axis(axis, field_mt * 1e-3));
    Ok(())
}

fn apply_pipeline_set_current(
    problem: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<()> {
    let axis = payload_axis(payload, "direction", [1.0, 0.0, 0.0])?;
    let current_density = payload_f64(payload, "current_density")?.unwrap_or(1e10);
    problem.current_density = Some(scaled_axis(axis, current_density));
    Ok(())
}

fn apply_pipeline_external_field(problem: &mut ProblemIR, field_t: [f64; 3]) {
    for term in &mut problem.energy_terms {
        if let fullmag_ir::EnergyTermIR::Zeeman { b } = term {
            *b = field_t;
            return;
        }
    }
    problem
        .energy_terms
        .push(fullmag_ir::EnergyTermIR::Zeeman { b: field_t });
}

fn payload_axis(
    payload: &BTreeMap<String, Value>,
    key: &str,
    default_axis: [f64; 3],
) -> Result<[f64; 3]> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(default_axis);
    };
    match raw_value {
        Value::Null => Ok(default_axis),
        Value::String(value) => {
            if value.trim().is_empty() {
                Ok(default_axis)
            } else {
                parse_axis_spec(value, key)
            }
        }
        Value::Array(values) => {
            if values.len() != 3 {
                bail!("payload field '{key}' must contain exactly 3 axis components");
            }
            let axis = [
                values[0].as_f64().ok_or_else(|| {
                    anyhow::anyhow!("invalid axis component for payload field '{key}'")
                })?,
                values[1].as_f64().ok_or_else(|| {
                    anyhow::anyhow!("invalid axis component for payload field '{key}'")
                })?,
                values[2].as_f64().ok_or_else(|| {
                    anyhow::anyhow!("invalid axis component for payload field '{key}'")
                })?,
            ];
            normalize_axis(axis, key)
        }
        _ => bail!("payload field '{key}' must be an axis string or 3-element array"),
    }
}

fn parse_axis_spec(raw: &str, key: &str) -> Result<[f64; 3]> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let axis = match lower.as_str() {
        "x" | "+x" => Some([1.0, 0.0, 0.0]),
        "-x" => Some([-1.0, 0.0, 0.0]),
        "y" | "+y" => Some([0.0, 1.0, 0.0]),
        "-y" => Some([0.0, -1.0, 0.0]),
        "z" | "+z" => Some([0.0, 0.0, 1.0]),
        "-z" => Some([0.0, 0.0, -1.0]),
        _ => None,
    };
    if let Some(axis) = axis {
        return Ok(axis);
    }
    let values: Vec<f64> = trimmed
        .split(',')
        .map(|component| {
            component
                .trim()
                .parse::<f64>()
                .with_context(|| format!("invalid axis component in payload field '{key}'"))
        })
        .collect::<Result<Vec<_>>>()?;
    if values.len() != 3 {
        bail!("payload field '{key}' must be a named axis or 3 comma-separated values");
    }
    normalize_axis([values[0], values[1], values[2]], key)
}

fn normalize_axis(axis: [f64; 3], key: &str) -> Result<[f64; 3]> {
    let norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if norm <= f64::EPSILON {
        bail!("payload field '{key}' must not be the zero vector");
    }
    Ok([axis[0] / norm, axis[1] / norm, axis[2] / norm])
}

fn scaled_axis(axis: [f64; 3], magnitude: f64) -> [f64; 3] {
    [
        axis[0] * magnitude,
        axis[1] * magnitude,
        axis[2] * magnitude,
    ]
}

fn linear_sweep_values(start: f64, stop: f64, steps: u64) -> Result<Vec<f64>> {
    if steps == 0 {
        bail!("linear sweep requires at least one point");
    }
    if steps == 1 {
        return Ok(vec![start]);
    }
    let denominator = (steps - 1) as f64;
    Ok((0..steps)
        .map(|index| {
            let t = index as f64 / denominator;
            start + (stop - start) * t
        })
        .collect())
}

pub(crate) fn apply_continuation_initial_state(
    problem: &mut ProblemIR,
    final_magnetization: &[[f64; 3]],
) -> Result<()> {
    if problem.magnets.len() == 1 {
        problem.magnets[0].initial_magnetization =
            Some(fullmag_ir::InitialMagnetizationIR::SampledField {
                values: final_magnetization.to_vec(),
            });
        return Ok(());
    }

    let shared_domain_node_count = problem
        .geometry_assets
        .as_ref()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
        .and_then(|asset| asset.mesh.as_ref())
        .map(|mesh| mesh.nodes.len());
    let planned_fem_node_count = if shared_domain_node_count.is_some() {
        match planned_fem_mesh_node_count(problem) {
            Ok(node_count) => node_count,
            Err(_error) if shared_domain_node_count == Some(final_magnetization.len()) => None,
            Err(error) => return Err(error),
        }
    } else {
        None
    };

    if planned_fem_node_count == Some(final_magnetization.len()) {
        let sampled = fullmag_ir::InitialMagnetizationIR::SampledField {
            values: final_magnetization.to_vec(),
        };
        for magnet in &mut problem.magnets {
            magnet.initial_magnetization = Some(sampled.clone());
        }
        return Ok(());
    }

    if let Some(node_count) = planned_fem_node_count {
        bail!(
            "multi-stage shared-domain continuation has {} vectors, but the planned FEM mesh has {} nodes",
            final_magnetization.len(),
            node_count
        );
    }

    if shared_domain_node_count == Some(final_magnetization.len()) {
        let sampled = fullmag_ir::InitialMagnetizationIR::SampledField {
            values: final_magnetization.to_vec(),
        };
        for magnet in &mut problem.magnets {
            magnet.initial_magnetization = Some(sampled.clone());
        }
        return Ok(());
    }

    if let Some(node_count) = shared_domain_node_count {
        bail!(
            "multi-stage shared-domain continuation has {} vectors, but the FEM domain mesh has {} nodes",
            final_magnetization.len(),
            node_count
        );
    } else {
        bail!(
            "multi-stage flat scripts currently require exactly one magnet; found {}",
            problem.magnets.len()
        );
    }
}

fn planned_fem_mesh_node_count(problem: &ProblemIR) -> Result<Option<usize>> {
    let plan = fullmag_plan::plan(problem).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(match plan.backend_plan {
        BackendPlanIR::Fem(fem) => Some(fem.mesh.nodes.len()),
        BackendPlanIR::FemEigen(fem) => Some(fem.mesh.nodes.len()),
        BackendPlanIR::FemFrequencyResponse(fem) => Some(fem.mesh.nodes.len()),
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
    })
}

// ---------------------------------------------------------------------------
// Cross-backend magnetization state transfer (FEM → FDM)
// ---------------------------------------------------------------------------

/// Metadata about which backend produced the continuation magnetization.
#[derive(Debug, Clone)]
pub(crate) enum ContinuationSource {
    /// Magnetization came from an FDM stage — cell-centered on a regular grid.
    Fdm,
    /// Magnetization came from a FEM stage — node-based on a tet mesh.
    /// Carries the mesh IR needed for resampling to a different backend.
    Fem(fullmag_ir::MeshIR),
}

/// Result of cross-backend resampling with transfer statistics.
#[derive(Debug)]
pub(crate) struct CrossBackendTransferResult {
    pub values: Vec<[f64; 3]>,
    pub n_located: usize,
    pub n_outside: usize,
    pub n_total: usize,
    pub label: &'static str,
    pub unit_label: &'static str,
}

/// If the previous stage was FEM and the next stage will be FDM,
/// resample the continuation magnetization from FEM nodes to the target mesh
/// or grid.
///
/// Returns `Ok(Some(resampled))` if resampling was performed,
/// `Ok(None)` if no cross-backend transfer is needed (same backend type),
/// or `Err` if the transfer fails.
pub(crate) fn resample_continuation_if_cross_backend(
    continuation_m: &[[f64; 3]],
    source: &ContinuationSource,
    next_stage_ir: &ProblemIR,
) -> Result<Option<CrossBackendTransferResult>> {
    let fem_mesh_ir = match source {
        ContinuationSource::Fem(mesh_ir) => mesh_ir,
        ContinuationSource::Fdm => return Ok(None), // same-backend, no resampling
    };

    // Pre-plan the next stage to discover if it's FDM and get grid parameters.
    let next_plan = fullmag_plan::plan(next_stage_ir)
        .map_err(|e| anyhow::anyhow!("pre-plan for cross-backend transfer failed: {}", e))?;

    match &next_plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            if fem_mesh_ir.nodes.len() != continuation_m.len() {
                bail!(
                    "FEM → FEM continuation has {} vectors, but source FEM mesh has {} nodes",
                    continuation_m.len(),
                    fem_mesh_ir.nodes.len()
                );
            }
            if fem.mesh == *fem_mesh_ir {
                return Ok(None);
            }
            let old_topo = MeshTopology::from_ir(fem_mesh_ir).map_err(|e| {
                anyhow::anyhow!(
                    "failed to build source mesh topology for FEM state transfer: {}",
                    e
                )
            })?;
            let new_topo = MeshTopology::from_ir(&fem.mesh).map_err(|e| {
                anyhow::anyhow!(
                    "failed to build target mesh topology for FEM state transfer: {}",
                    e
                )
            })?;
            let transfer = transfer_vector_field(&old_topo, continuation_m, &new_topo);
            let mut values = transfer.values;
            normalize_unit_vectors(&mut values, 1e-12);
            Ok(Some(CrossBackendTransferResult {
                values,
                n_located: transfer.n_located,
                n_outside: transfer.n_nearest_fallback,
                n_total: transfer.n_total,
                label: "FEM→FEM",
                unit_label: "nodes",
            }))
        }
        BackendPlanIR::Fdm(fdm_plan) => {
            // Extract FDM grid parameters.
            let grid_cells = fdm_plan.grid.cells;
            let cell_size = fdm_plan.cell_size;
            let grid_dims = [
                grid_cells[0] as usize,
                grid_cells[1] as usize,
                grid_cells[2] as usize,
            ];

            // For single-body FDM, the grid is centered at the origin.
            let grid_origin = [
                -(grid_cells[0] as f64 * cell_size[0]) * 0.5,
                -(grid_cells[1] as f64 * cell_size[1]) * 0.5,
                -(grid_cells[2] as f64 * cell_size[2]) * 0.5,
            ];

            // Build MeshTopology from the FEM plan's MeshIR.
            let topo = MeshTopology::from_ir(fem_mesh_ir).map_err(|e| {
                anyhow::anyhow!("failed to build mesh topology for state transfer: {}", e)
            })?;

            // Resample FEM node-based magnetization to FDM cell centers.
            let GridTransferResult {
                mut values,
                n_located,
                n_outside,
                n_total,
            } = transfer_fem_field_to_grid(
                &topo,
                continuation_m,
                grid_origin,
                cell_size,
                grid_dims,
            );

            // Post-transfer normalization: P1 interpolation of unit vectors does not
            // preserve |m| = 1, so we re-normalize.  Zero vectors (cells outside the
            // magnetic body) are left at zero.
            normalize_unit_vectors(&mut values, 1e-12);

            Ok(Some(CrossBackendTransferResult {
                values,
                n_located,
                n_outside,
                n_total,
                label: "FEM→FDM",
                unit_label: "cells",
            }))
        }
        BackendPlanIR::FdmMultilayer(_) => {
            // Multi-layer FDM continuation from FEM is not yet supported.
            bail!("FEM → FDM-multilayer cross-backend continuation is not yet supported");
        }
        _ => Ok(None),
    }
}

/// Estimate available system RAM in bytes.
///
/// Reads `/proc/meminfo` (Linux). Falls back to 16 GB if unavailable.
pub(crate) fn available_system_ram_bytes() -> u64 {
    if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix("MemAvailable:") {
                let kb_str = rest.trim().trim_end_matches("kB").trim();
                if let Ok(kb) = kb_str.parse::<u64>() {
                    return kb * 1024;
                }
            }
        }
    }
    16 * 1024 * 1024 * 1024 // fallback: 16 GB
}

/// Estimate RAM required for dense FEM demag solver.
///
/// The CPU reference solver allocates 3 dense N×N matrices of f64 (8 bytes each).
pub(crate) fn estimate_fem_dense_ram(node_count: usize) -> u64 {
    let n = node_count as u64;
    n * n * 24 // 3 × N × N × 8 bytes
}

pub(crate) fn read_ir(path: &Path) -> Result<ProblemIR> {
    let content = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

pub(crate) fn validate_ir(ir: &ProblemIR) -> Result<()> {
    ir.validate().map_err(join_errors)?;
    if ir.problem_meta.script_language != "python" {
        anyhow::bail!("Only Python-authored ProblemIR is supported in bootstrap mode")
    }
    Ok(())
}

pub(crate) fn join_errors(errors: Vec<String>) -> anyhow::Error {
    anyhow::anyhow!(errors.join("; "))
}

pub(crate) fn build_interactive_command_stage(
    base_problem: &ProblemIR,
    command: &crate::types::SessionCommand,
) -> Result<Option<ResolvedScriptStage>> {
    match command.kind.as_str() {
        "close" => Ok(None),
        "solve" => {
            let mut solve_command = command.clone();
            solve_command.kind = match &base_problem.study {
                fullmag_ir::StudyIR::Relaxation { .. } => "relax".to_string(),
                fullmag_ir::StudyIR::TimeEvolution { .. } => "run".to_string(),
                fullmag_ir::StudyIR::Eigenmodes { .. }
                | fullmag_ir::StudyIR::FrequencyResponse { .. }
                | fullmag_ir::StudyIR::Hysteresis { .. } => {
                    anyhow::bail!("interactive 'solve' is not supported for this study kind")
                }
            };
            build_interactive_command_stage(base_problem, &solve_command)
        }
        "stop" | "break" | "pause" | "resume" => anyhow::bail!(
            "interactive control command '{}' must be handled before stage materialization",
            command.kind
        ),
        "run" => {
            let until_seconds = command.until_seconds.ok_or_else(|| {
                anyhow::anyhow!("interactive 'run' command requires until_seconds")
            })?;
            if until_seconds <= 0.0 {
                anyhow::bail!("interactive 'run' command requires positive until_seconds");
            }

            let mut ir = base_problem.clone();
            let mut dynamics = ir.study.dynamics().clone();
            let fullmag_ir::DynamicsIR::Llg {
                ref mut integrator,
                ref mut fixed_timestep,
                ..
            } = dynamics;
            if let Some(ref int_str) = command.integrator {
                if let Ok(parsed_integrator) = serde_json::from_value(serde_json::json!(int_str)) {
                    *integrator = parsed_integrator;
                } else {
                    eprintln!(
                        "[fullmag] warning: failed to parse integrator '{}'",
                        int_str
                    );
                }
            }
            if let Some(ft) = command.fixed_timestep {
                *fixed_timestep = Some(ft);
            } else if command.integrator.as_deref() == Some("rk45")
                || command.integrator.as_deref() == Some("rk23")
            {
                *fixed_timestep = None;
            }
            let sampling = ir.study.sampling().clone();
            ir.problem_meta.entrypoint_kind = "interactive_run".to_string();
            ir.study = fullmag_ir::StudyIR::TimeEvolution { dynamics, sampling };

            Ok(Some(ResolvedScriptStage::solver(
                ir,
                until_seconds,
                "interactive_run",
            )))
        }
        "relax" => {
            let mut ir = base_problem.clone();
            let mut dynamics = ir.study.dynamics().clone();
            let fullmag_ir::DynamicsIR::Llg {
                ref mut integrator,
                ref mut fixed_timestep,
                ref mut adaptive_timestep,
                ..
            } = dynamics;
            if let Some(ref int_str) = command.integrator {
                if let Ok(parsed_integrator) = serde_json::from_value(serde_json::json!(int_str)) {
                    *integrator = parsed_integrator;
                } else {
                    eprintln!(
                        "[fullmag] warning: failed to parse integrator '{}'",
                        int_str
                    );
                }
            }
            if let Some(ft) = command.fixed_timestep {
                *fixed_timestep = Some(ft);
                *adaptive_timestep = None;
            } else if let Some(atol) = command.max_error {
                *fixed_timestep = None;
                *adaptive_timestep = Some(fullmag_ir::AdaptiveTimeStepIR {
                    atol,
                    rtol: 1e-3,
                    dt_initial: None,
                    dt_min: 1e-15,
                    dt_max: None,
                    safety: 0.9,
                    growth_limit: 2.0,
                    shrink_limit: 0.2,
                    max_spin_rotation: None,
                    norm_tolerance: None,
                });
            } else if command.integrator.as_deref() == Some("rk45")
                || command.integrator.as_deref() == Some("rk23")
            {
                *fixed_timestep = None;
            }
            // Ensure that adaptive integrators always have a valid adaptive_timestep
            // (either from command.max_error above or inherited from base_problem).
            // If neither fixed_timestep nor adaptive_timestep is set, use defaults.
            let is_adaptive_integrator = matches!(integrator.as_str(), "rk23" | "rk45");
            if fixed_timestep.is_none() && adaptive_timestep.is_none() && is_adaptive_integrator {
                *adaptive_timestep = Some(fullmag_ir::AdaptiveTimeStepIR {
                    atol: 1e-6,
                    rtol: 1e-3,
                    dt_initial: None,
                    dt_min: 1e-15,
                    dt_max: None,
                    safety: 0.9,
                    growth_limit: 2.0,
                    shrink_limit: 0.2,
                    max_spin_rotation: None,
                    norm_tolerance: None,
                });
            }
            let sampling = ir.study.sampling().clone();
            let stop = fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(command.torque_tolerance.unwrap_or(1e-4)),
                energy_tolerance_j: command.energy_tolerance,
                max_steps: Some(command.max_steps.unwrap_or(50_000)),
                max_relaxation_time_s: None,
            };

            // Default relax_alpha = 1.0 for optimal overdamped convergence
            // (user can still override to any value via command.relax_alpha)
            let effective_alpha = command.relax_alpha.unwrap_or(1.0);
            for mat in &mut ir.materials {
                mat.damping = effective_alpha;
            }

            let algorithm = command
                .relax_algorithm
                .as_deref()
                .and_then(|s| serde_json::from_value(serde_json::json!(s)).ok())
                .unwrap_or(fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped);

            ir.problem_meta.entrypoint_kind = "interactive_relax".to_string();
            ir.study = fullmag_ir::StudyIR::Relaxation {
                algorithm,
                dynamics: (algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped)
                    .then(|| dynamics.clone()),
                stop: stop.clone(),
                sampling,
            };

            let until_seconds = resolve_relaxation_until_seconds(
                &(algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped)
                    .then_some(dynamics),
                &stop,
            );

            Ok(Some(ResolvedScriptStage::solver(
                ir,
                until_seconds,
                "interactive_relax",
            )))
        }
        other => anyhow::bail!("unsupported interactive command kind '{other}'"),
    }
}

pub(crate) fn build_resumable_interactive_command(
    command: &crate::types::SessionCommand,
    stage_result: &fullmag_runner::RunResult,
) -> Option<crate::types::SessionCommand> {
    match command.kind.as_str() {
        "run" => {
            let requested_until_seconds = command.until_seconds?;
            let elapsed_seconds = stage_result
                .steps
                .last()
                .map(|step| step.time)
                .unwrap_or(0.0);
            let remaining_until_seconds = (requested_until_seconds - elapsed_seconds).max(0.0);
            if remaining_until_seconds <= 0.0 {
                return None;
            }
            let mut resumed = command.clone();
            resumed.until_seconds = Some(remaining_until_seconds);
            Some(resumed)
        }
        "relax" | "solve" => {
            let requested_max_steps = command.max_steps.unwrap_or(50_000);
            let executed_steps = stage_result.steps.last().map(|step| step.step).unwrap_or(0);
            let remaining_max_steps = requested_max_steps.saturating_sub(executed_steps);
            if remaining_max_steps == 0 {
                return None;
            }
            let mut resumed = command.clone();
            resumed.max_steps = Some(remaining_max_steps);
            Some(resumed)
        }
        _ => None,
    }
}

pub(crate) fn supports_dynamic_live_preview(backend_plan: &BackendPlanIR) -> bool {
    matches!(backend_plan, BackendPlanIR::Fdm(_) | BackendPlanIR::Fem(_))
}

/// Convert a [`SequenceStage`] into a [`SessionCommand`] suitable for
/// `build_interactive_command_stage`.
pub(crate) fn sequence_stage_to_session_command(
    stage: &fullmag_runner::SequenceStage,
    sequence_id: &str,
    stage_index: usize,
) -> crate::types::SessionCommand {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    match stage {
        fullmag_runner::SequenceStage::Run {
            until_seconds,
            max_steps,
        } => crate::types::SessionCommand {
            seq: 0,
            command_id: format!("{}_stage_{}", sequence_id, stage_index),
            kind: "run".to_string(),
            created_at_unix_ms: now_ms,
            target: Some(crate::types::RuntimeCommandTarget::StageIndex {
                stage_index: stage_index as u32,
            }),
            reason: Some("sequence_stage".to_string()),
            precondition: None,
            client_intent_id: Some(format!("{}_stage_{}", sequence_id, stage_index)),
            requested_at_unix_ms: Some(now_ms as u64),
            until_seconds: Some(*until_seconds),
            max_steps: *max_steps,
            torque_tolerance: None,
            energy_tolerance: None,
            integrator: None,
            fixed_timestep: None,
            max_error: None,
            relax_algorithm: None,
            relax_alpha: None,
            mesh_options: None,
            mesh_target: None,
            mesh_reason: None,
            state_path: None,
            state_format: None,
            state_dataset: None,
            state_sample_index: None,
            display_selection: None,
            preview_config: None,
            stages: None,
            profile: None,
        },
        fullmag_runner::SequenceStage::Relax {
            until_seconds,
            max_steps,
            torque_tolerance,
            energy_tolerance,
        } => crate::types::SessionCommand {
            seq: 0,
            command_id: format!("{}_stage_{}", sequence_id, stage_index),
            kind: "relax".to_string(),
            created_at_unix_ms: now_ms,
            target: Some(crate::types::RuntimeCommandTarget::StageIndex {
                stage_index: stage_index as u32,
            }),
            reason: Some("sequence_stage".to_string()),
            precondition: None,
            client_intent_id: Some(format!("{}_stage_{}", sequence_id, stage_index)),
            requested_at_unix_ms: Some(now_ms as u64),
            until_seconds: *until_seconds,
            max_steps: *max_steps,
            torque_tolerance: *torque_tolerance,
            energy_tolerance: *energy_tolerance,
            integrator: None,
            fixed_timestep: None,
            max_error: None,
            relax_algorithm: None,
            relax_alpha: None,
            mesh_options: None,
            mesh_target: None,
            mesh_reason: None,
            state_path: None,
            state_format: None,
            state_dataset: None,
            state_sample_index: None,
            display_selection: None,
            preview_config: None,
            stages: None,
            profile: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ScriptExecutionStage;
    use fullmag_ir::ProblemIR;
    use serde_json::json;

    fn sample_problem_ir() -> ProblemIR {
        serde_json::from_value(json!({
            "ir_version": "0.2.0",
            "problem_meta": {
                "name": "pipeline_test",
                "description": null,
                "script_language": "python",
                "script_source": null,
                "script_api_version": "0.2.0",
                "serializer_version": "0.2.0",
                "entrypoint_kind": "direct_script",
                "source_hash": null,
                "runtime_metadata": {},
                "backend_revision": null,
                "seeds": []
            },
            "geometry": {
                "entries": [
                    {
                        "kind": "box",
                        "name": "track",
                        "size": [1.0, 1.0, 1.0]
                    }
                ]
            },
            "regions": [
                {
                    "name": "track",
                    "geometry": "track"
                }
            ],
            "materials": [
                {
                    "name": "Py",
                    "saturation_magnetisation": 800000.0,
                    "exchange_stiffness": 1.3e-11,
                    "damping": 0.01,
                    "uniaxial_anisotropy": null,
                    "anisotropy_axis": null
                }
            ],
            "magnets": [
                {
                    "name": "track",
                    "region": "track",
                    "material": "Py",
                    "initial_magnetization": {
                        "kind": "uniform",
                        "value": [1.0, 0.0, 0.0]
                    }
                }
            ],
            "energy_terms": [
                {
                    "kind": "exchange"
                }
            ],
            "study": {
                "kind": "time_evolution",
                "dynamics": {
                    "kind": "llg",
                    "gyromagnetic_ratio": 221000.0,
                    "integrator": "rk45",
                    "fixed_timestep": 1e-13
                },
                "sampling": {
                    "outputs": []
                }
            },
            "backend_policy": {
                "requested_backend": "fdm",
                "execution_precision": "double",
                "discretization_hints": null
            },
            "validation_profile": {
                "execution_mode": "strict"
            }
        }))
        .expect("sample ProblemIR should deserialize")
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
            solver_policy: None,
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
            air_box_config: None,
            demag_solver_policy: None,
            periodic_constraint_sets: Vec::new(),
            equilibrium_provenance: None,
        }
    }

    #[test]
    fn initial_frequency_response_step_publishes_sweep_progress() {
        let mut plan = minimal_frequency_response_plan();
        plan.frequencies_hz.values_hz = vec![2.0e9, 3.5e9, 5.0e9];
        plan.enable_demag = true;
        plan.magnetostatic_bc = fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0;
        let update = initial_step_update(&BackendPlanIR::FemFrequencyResponse(plan));

        let progress = update
            .stats
            .per_object_scalars
            .get("fem_frequency_response_progress")
            .expect("frequency response initial live update should publish sweep progress");

        assert_eq!(progress["frequency_index"], 0.0);
        assert_eq!(progress["completed_frequency_count"], 0.0);
        assert_eq!(progress["total_frequency_count"], 3.0);
        assert_eq!(progress["frequency_hz"], 2.0e9);
        assert_eq!(progress["frequency_min_hz"], 2.0e9);
        assert_eq!(progress["frequency_max_hz"], 5.0e9);
        assert_eq!(progress["percent"], 0.0);
        assert_eq!(progress["demag_enabled"], 1.0);
        assert_eq!(progress["demag_periodic_airbox_k0"], 1.0);
    }

    #[test]
    fn continuation_initial_state_supports_multi_magnet_shared_domain() {
        let mut problem = sample_problem_ir();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        problem
            .geometry
            .entries
            .push(fullmag_ir::GeometryEntryIR::Box {
                name: "ring".to_string(),
                size: [0.5, 0.5, 0.5],
            });
        problem.regions.push(fullmag_ir::RegionIR {
            name: "ring".to_string(),
            geometry: "ring".to_string(),
        });
        problem.magnets.push(fullmag_ir::MagnetIR {
            name: "ring".to_string(),
            region: "ring".to_string(),
            material: "Py".to_string(),
            initial_magnetization: None,
        });
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "shared_domain".to_string(),
                    nodes: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                    elements: Vec::new(),
                    element_markers: Vec::new(),
                    boundary_faces: Vec::new(),
                    boundary_markers: Vec::new(),
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
                region_markers: Vec::new(),
                object_region_markers: Vec::new(),
                build_report: None,
            }),
            ..Default::default()
        });
        let continuation = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

        apply_continuation_initial_state(&mut problem, &continuation)
            .expect("shared-domain continuation should support multiple magnets");

        for magnet in &problem.magnets {
            assert!(matches!(
                magnet.initial_magnetization.as_ref(),
                Some(fullmag_ir::InitialMagnetizationIR::SampledField { values })
                    if values == &continuation
            ));
        }
    }

    #[test]
    fn continuation_initial_state_uses_planned_shared_domain_node_count() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            json!({"device": "cuda", "device_index": 0}),
        );
        problem
            .geometry
            .entries
            .push(fullmag_ir::GeometryEntryIR::Box {
                name: "second".to_string(),
                size: [1.0, 1.0, 1.0],
            });
        problem.regions.push(fullmag_ir::RegionIR {
            name: "second".to_string(),
            geometry: "second".to_string(),
        });
        problem.magnets.push(fullmag_ir::MagnetIR {
            name: "second".to_string(),
            region: "second".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(fullmag_ir::InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
        });
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: vec![],
            fem_mesh_assets: vec![],
            fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "touching".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                        [0.0, 0.0, -1.0],
                    ],
                    elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
                    element_markers: vec![1, 2],
                    boundary_faces: vec![[0, 1, 3], [0, 1, 4]],
                    boundary_markers: vec![10, 20],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
                region_markers: vec![
                    fullmag_ir::FemDomainRegionMarkerIR {
                        geometry_name: "strip".to_string(),
                        marker: 1,
                    },
                    fullmag_ir::FemDomainRegionMarkerIR {
                        geometry_name: "second".to_string(),
                        marker: 2,
                    },
                ],
                object_region_markers: Vec::new(),
                build_report: None,
            }),
        });
        problem.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
        let plan = fullmag_plan::plan(&problem).expect("shared-domain problem should plan");
        let BackendPlanIR::Fem(fem) = plan.backend_plan else {
            panic!("expected FEM plan");
        };
        assert_ne!(fem.mesh.nodes.len(), 5);
        let continuation = vec![[1.0, 0.0, 0.0]; fem.mesh.nodes.len()];

        apply_continuation_initial_state(&mut problem, &continuation)
            .expect("continuation should match the planned FEM mesh node count");
        fullmag_plan::plan(&problem).expect("planned-mesh continuation should replan");

        for magnet in &problem.magnets {
            assert!(matches!(
                magnet.initial_magnetization.as_ref(),
                Some(fullmag_ir::InitialMagnetizationIR::SampledField { values })
                    if values == &continuation
            ));
        }
    }

    fn sample_problem_ir_with_adaptive_relax_dt(dt_initial: f64) -> ProblemIR {
        sample_problem_ir_with_adaptive_relax_dt_limits(dt_initial, 1e-18)
    }

    fn sample_problem_ir_with_adaptive_relax_dt_limits(dt_initial: f64, dt_min: f64) -> ProblemIR {
        serde_json::from_value(json!({
            "ir_version": "0.2.0",
            "problem_meta": {
                "name": "pipeline_test_adaptive_relax",
                "description": null,
                "script_language": "python",
                "script_source": null,
                "script_api_version": "0.2.0",
                "serializer_version": "0.2.0",
                "entrypoint_kind": "direct_script",
                "source_hash": null,
                "runtime_metadata": {},
                "backend_revision": null,
                "seeds": []
            },
            "geometry": {
                "entries": [
                    {
                        "kind": "box",
                        "name": "track",
                        "size": [1.0, 1.0, 1.0]
                    }
                ]
            },
            "regions": [
                {
                    "name": "track",
                    "geometry": "track"
                }
            ],
            "materials": [
                {
                    "name": "Py",
                    "saturation_magnetisation": 800000.0,
                    "exchange_stiffness": 1.3e-11,
                    "damping": 0.01,
                    "uniaxial_anisotropy": null,
                    "anisotropy_axis": null
                }
            ],
            "magnets": [
                {
                    "name": "track",
                    "region": "track",
                    "material": "Py",
                    "initial_magnetization": {
                        "kind": "uniform",
                        "value": [1.0, 0.0, 0.0]
                    }
                }
            ],
            "energy_terms": [
                {
                    "kind": "exchange"
                }
            ],
            "study": {
                "kind": "relaxation",
                "algorithm": "llg_overdamped",
                "stop": {
                    "torque_tolerance_apm": 1e-4,
                    "energy_tolerance_j": null,
                    "max_steps": 50,
                    "max_pseudotime_s": null,
                    "max_physical_time_s": null
                },
                "dynamics": {
                    "kind": "llg",
                    "gyromagnetic_ratio": 221000.0,
                    "integrator": "rk23",
                    "fixed_timestep": null,
                    "adaptive_timestep": {
                        "atol": 1e-6,
                        "rtol": 1e-3,
                        "dt_initial": dt_initial,
                        "dt_min": dt_min,
                        "dt_max": 1e-12,
                        "safety": 0.9,
                        "growth_limit": 2.0,
                        "shrink_limit": 0.25,
                        "max_spin_rotation": null,
                        "norm_tolerance": null
                    }
                },
                "sampling": {
                    "outputs": []
                }
            },
            "backend_policy": {
                "requested_backend": "fdm",
                "execution_precision": "double",
                "discretization_hints": null
            },
            "validation_profile": {
                "execution_mode": "strict"
            }
        }))
        .expect("adaptive relax ProblemIR should deserialize")
    }

    fn zeeman_field(problem: &ProblemIR) -> Option<[f64; 3]> {
        problem.energy_terms.iter().find_map(|term| match term {
            fullmag_ir::EnergyTermIR::Zeeman { b } => Some(*b),
            _ => None,
        })
    }

    #[test]
    fn materialize_script_stages_uses_study_pipeline_when_explicit_stages_are_absent() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "stage_1_run".to_string(),
                        label: "".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "run".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "run",
                            "entrypoint_kind": "pipeline_run",
                            "integrator": "rk45",
                            "fixed_timestep": "",
                            "until_seconds": "5e-12"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_2_relax".to_string(),
                        label: "".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "relax".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "relax",
                            "entrypoint_kind": "pipeline_relax",
                            "integrator": "rk45",
                            "fixed_timestep": "2e-13",
                            "relax_algorithm": "llg_overdamped",
                            "torque_tolerance": "1e-4",
                            "max_steps": "25"
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 2);
        assert_eq!(stages[0].entrypoint_kind, "pipeline_run");
        assert!((stages[0].until_seconds - 5e-12).abs() < 1e-24);
        assert_eq!(stages[1].entrypoint_kind, "pipeline_relax");
        assert!(matches!(
            stages[1].ir.study,
            fullmag_ir::StudyIR::Relaxation {
                stop: fullmag_ir::RelaxStopIR {
                    max_steps: Some(25),
                    ..
                },
                ..
            }
        ));
        assert!((stages[1].until_seconds - (25.0 * 2e-13)).abs() < 1e-24);
    }

    #[test]
    fn materialized_compatible_solver_stages_are_marked_continue_in_place() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "stage_1_run".to_string(),
                        label: "".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "run".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "run",
                            "entrypoint_kind": "pipeline_run",
                            "integrator": "rk45",
                            "fixed_timestep": "",
                            "until_seconds": "5e-12"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_2_relax".to_string(),
                        label: "".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "relax".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "relax",
                            "entrypoint_kind": "pipeline_relax",
                            "integrator": "rk45",
                            "fixed_timestep": "2e-13",
                            "relax_algorithm": "llg_overdamped",
                            "torque_tolerance": "1e-4",
                            "max_steps": "25"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_3_eigen".to_string(),
                        label: "".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "eigenmodes".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "eigenmodes",
                            "entrypoint_kind": "pipeline_eigen",
                            "eigen_count": "4"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_4_frequency".to_string(),
                        label: "".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "frequency_response".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "frequency_response",
                            "entrypoint_kind": "pipeline_frequency_response",
                            "frequency_values_hz": "1e9,2e9",
                            "frequency_excitation_field_au_per_m": "0,0,1",
                            "frequency_excitation_phase_rad": "0.375"
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 4);
        assert!(matches!(
            &stages[3].ir.study,
            fullmag_ir::StudyIR::FrequencyResponse { excitation, .. }
                if (excitation.phase_rad - 0.375).abs() < 1e-15
        ));
        assert!(stages[0].incoming_transition.is_none());
        for stage in stages.iter().skip(1) {
            let transition = stage
                .incoming_transition
                .as_ref()
                .expect("compatible stage should have transition metadata");
            assert_eq!(
                transition.kind,
                crate::types::StageTransitionKind::ContinueInPlace
            );
            assert_eq!(
                transition.reason,
                crate::types::StageTransitionReason::SameRuntimeContext
            );
            assert_eq!(
                transition.ui_presentation,
                crate::types::StageTransitionUiPresentation::SmoothArrow
            );
        }
    }

    #[test]
    fn explicit_dynamics_and_linear_analysis_stages_continue_in_place() {
        let base = sample_problem_ir();
        let dynamics = base.study.dynamics().clone();
        let sampling = base.study.sampling().clone();
        let mut relax_ir = base.clone();
        relax_ir.materials[0].damping = 1.0;
        relax_ir.problem_meta.entrypoint_kind = "flat_relax".to_string();
        relax_ir.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            dynamics: Some(dynamics.clone()),
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_relaxation_time_s: None,
            },
            sampling: sampling.clone(),
        };
        let mut eigen_ir = base.clone();
        eigen_ir.problem_meta.entrypoint_kind = "flat_eigenmodes".to_string();
        eigen_ir.study = fullmag_ir::StudyIR::Eigenmodes {
            dynamics: dynamics.clone(),
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: true,
            },
            count: 4,
            target: fullmag_ir::EigenTargetIR::Lowest,
            equilibrium: fullmag_ir::EquilibriumSourceIR::RelaxedInitialState,
            k_sampling: None,
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            mode_tracking: None,
            sampling: sampling.clone(),
        };
        let mut frequency_ir = base.clone();
        frequency_ir.problem_meta.entrypoint_kind = "flat_frequency_response".to_string();
        frequency_ir.study = fullmag_ir::StudyIR::FrequencyResponse {
            dynamics,
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: true,
            },
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling: None,
            normalization: fullmag_ir::FrequencyResponseNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
            excitation: fullmag_ir::FrequencyExcitationIR {
                field_au_per_m: [0.0, 0.0, 1.0],
                phase_rad: 0.0,
            },
            frequencies_hz: fullmag_ir::FrequencySweepIR {
                values_hz: vec![1.0e9, 2.0e9],
            },
            solver_policy: None,
            sampling: fullmag_ir::SamplingIR {
                table_autosave: None,
                outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                    observable: fullmag_ir::FrequencyResponseOutputIR::SusceptibilityTensor,
                }],
            },
        };

        let stages = materialize_script_stages(ScriptExecutionConfig {
            ir: base.clone(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1e-12),
            study_pipeline: None,
            stages: vec![
                ScriptExecutionStage {
                    ir: base,
                    default_until_seconds: Some(1e-12),
                    entrypoint_kind: "flat_run".to_string(),
                    action: None,
                },
                ScriptExecutionStage {
                    ir: relax_ir,
                    default_until_seconds: None,
                    entrypoint_kind: "flat_relax".to_string(),
                    action: None,
                },
                ScriptExecutionStage {
                    ir: eigen_ir,
                    default_until_seconds: None,
                    entrypoint_kind: "flat_eigenmodes".to_string(),
                    action: None,
                },
                ScriptExecutionStage {
                    ir: frequency_ir,
                    default_until_seconds: None,
                    entrypoint_kind: "flat_frequency_response".to_string(),
                    action: None,
                },
            ],
        })
        .expect("explicit compatible stages should materialize");

        assert_eq!(stages.len(), 4);
        assert!(stages[0].incoming_transition.is_none());
        for stage in stages.iter().skip(1) {
            let transition = stage
                .incoming_transition
                .as_ref()
                .expect("compatible explicit stage should have transition metadata");
            assert_eq!(
                transition.kind,
                crate::types::StageTransitionKind::ContinueInPlace
            );
            assert_eq!(
                transition.reason,
                crate::types::StageTransitionReason::SameRuntimeContext
            );
        }
    }

    #[test]
    fn explicit_change_device_stage_propagates_to_following_frequency_response() {
        let mut base = sample_problem_ir();
        base.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        set_runtime_selection_device(&mut base, "gpu");
        let dynamics = base.study.dynamics().clone();
        let sampling = base.study.sampling().clone();

        let mut relax_ir = base.clone();
        relax_ir.problem_meta.entrypoint_kind = "flat_relax".to_string();
        relax_ir.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            dynamics: None,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(5.0e3),
                energy_tolerance_j: None,
                max_steps: Some(25),
                max_relaxation_time_s: None,
            },
            sampling: sampling.clone(),
        };

        let mut change_device_ir = base.clone();
        change_device_ir.problem_meta.entrypoint_kind = "flat_change_device".to_string();

        let mut frequency_ir = base.clone();
        frequency_ir.problem_meta.entrypoint_kind = "flat_frequency_response".to_string();
        frequency_ir.study = fullmag_ir::StudyIR::FrequencyResponse {
            dynamics,
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: true,
            },
            equilibrium: fullmag_ir::EquilibriumSourceIR::RelaxedInitialState,
            k_sampling: None,
            normalization: fullmag_ir::FrequencyResponseNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Include,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                    boundary_pair_id: None,
                    pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                    phase_convention: fullmag_ir::PhaseConventionIR::default(),
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            ),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0,
            excitation: fullmag_ir::FrequencyExcitationIR {
                field_au_per_m: [0.0, 0.0, 1.0],
                phase_rad: 0.0,
            },
            frequencies_hz: fullmag_ir::FrequencySweepIR {
                values_hz: vec![2.0e9, 2.5e9],
            },
            solver_policy: None,
            sampling: fullmag_ir::SamplingIR {
                table_autosave: None,
                outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                    observable: fullmag_ir::FrequencyResponseOutputIR::SusceptibilityTensor,
                }],
            },
        };

        let stages = materialize_script_stages(ScriptExecutionConfig {
            ir: base,
            shared_geometry_assets: None,
            default_until_seconds: Some(1e-12),
            study_pipeline: None,
            stages: vec![
                ScriptExecutionStage {
                    ir: relax_ir,
                    default_until_seconds: None,
                    entrypoint_kind: "flat_relax".to_string(),
                    action: None,
                },
                ScriptExecutionStage {
                    ir: change_device_ir,
                    default_until_seconds: None,
                    entrypoint_kind: "flat_change_device".to_string(),
                    action: Some(crate::types::ScriptExecutionStageAction::ChangeDevice {
                        device: "cpu".to_string(),
                    }),
                },
                ScriptExecutionStage {
                    ir: frequency_ir,
                    default_until_seconds: None,
                    entrypoint_kind: "flat_frequency_response".to_string(),
                    action: None,
                },
            ],
        })
        .expect("explicit stages should materialize");

        assert_eq!(stages.len(), 3);
        assert_eq!(requested_device(&stages[0].ir), "gpu");
        assert!(matches!(
            &stages[1].action,
            Some(ResolvedScriptStageAction::ChangeDevice { device }) if device == "cpu"
        ));
        assert_eq!(requested_device(&stages[1].ir), "cpu");
        assert_eq!(requested_device(&stages[2].ir), "cpu");
        assert!(matches!(
            &stages[2].ir.study,
            fullmag_ir::StudyIR::FrequencyResponse { magnetostatic_bc, .. }
                if *magnetostatic_bc
                    == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0
        ));
    }

    #[test]
    fn materialized_hysteresis_points_continue_same_branch_state() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Macro {
                    id: "hysteresis".to_string(),
                    label: "".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("script_imported".to_string()),
                    macro_kind: "hysteresis_loop".to_string(),
                    config: serde_json::from_value(json!({
                        "kind": "hysteresis_loop",
                        "direction": [0.0, 1.0, 0.0],
                        "field_values_t": [-0.01, 0.0, 0.01],
                        "settle": {
                            "max_steps": 12,
                            "fixed_timestep": "2e-13"
                        }
                    }))
                    .expect("config"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("hysteresis should materialize");
        assert_eq!(stages.len(), 3);
        assert!(stages[0].incoming_transition.is_none());
        for stage in stages.iter().skip(1) {
            let transition = stage
                .incoming_transition
                .as_ref()
                .expect("hysteresis branch point should continue from previous point");
            assert_eq!(
                transition.kind,
                crate::types::StageTransitionKind::ContinueInPlace
            );
            assert_eq!(
                transition.reason,
                crate::types::StageTransitionReason::SameRuntimeContext
            );
        }
    }

    #[test]
    fn materialize_pipeline_relax_without_time_budget_is_unbounded() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir_with_adaptive_relax_dt(3e-16),
            shared_geometry_assets: None,
            default_until_seconds: None,
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Primitive {
                    id: "stage_1_relax".to_string(),
                    label: "".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("script_imported".to_string()),
                    stage_kind: "relax".to_string(),
                    payload: serde_json::from_value(json!({
                        "kind": "relax",
                        "entrypoint_kind": "pipeline_relax",
                        "integrator": "rk23",
                        "fixed_timestep": "",
                        "relax_algorithm": "llg_overdamped",
                        "torque_tolerance": "1e-4",
                        "max_steps": "25"
                    }))
                    .expect("payload"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].entrypoint_kind, "pipeline_relax");
        assert!(stages[0].until_seconds.is_infinite());
    }

    #[test]
    fn materialize_pipeline_relax_without_time_budget_ignores_dt_seed_fallback() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir_with_adaptive_relax_dt_limits(3e-16, 3e-16),
            shared_geometry_assets: None,
            default_until_seconds: None,
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Primitive {
                    id: "stage_1_relax".to_string(),
                    label: "".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("script_imported".to_string()),
                    stage_kind: "relax".to_string(),
                    payload: serde_json::from_value(json!({
                        "kind": "relax",
                        "entrypoint_kind": "pipeline_relax",
                        "integrator": "rk23",
                        "fixed_timestep": "",
                        "relax_algorithm": "llg_overdamped",
                        "torque_tolerance": "1e-4",
                        "max_steps": "25"
                    }))
                    .expect("payload"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].entrypoint_kind, "pipeline_relax");
        assert!(stages[0].until_seconds.is_infinite());
    }

    #[test]
    fn build_interactive_relax_without_time_budget_is_unbounded() {
        let base_problem = sample_problem_ir_with_adaptive_relax_dt(4e-16);
        let command = crate::types::SessionCommand {
            seq: 1,
            command_id: "cmd-relax".to_string(),
            kind: "relax".to_string(),
            created_at_unix_ms: 0,
            target: None,
            reason: None,
            precondition: None,
            client_intent_id: None,
            requested_at_unix_ms: None,
            until_seconds: None,
            max_steps: Some(20),
            torque_tolerance: Some(1e-4),
            energy_tolerance: None,
            integrator: None,
            fixed_timestep: None,
            max_error: None,
            relax_algorithm: Some("llg_overdamped".to_string()),
            relax_alpha: None,
            mesh_options: None,
            mesh_target: None,
            mesh_reason: None,
            state_path: None,
            state_format: None,
            state_dataset: None,
            state_sample_index: None,
            display_selection: None,
            preview_config: None,
            stages: None,
            profile: None,
        };

        let stage = build_interactive_command_stage(&base_problem, &command)
            .expect("interactive relax should build")
            .expect("relax command should materialize a stage");

        assert_eq!(stage.entrypoint_kind, "interactive_relax");
        assert!(stage.until_seconds.is_infinite());
    }

    #[test]
    fn build_interactive_solve_restarts_relaxation_study() {
        let base_problem = sample_problem_ir_with_adaptive_relax_dt(4e-16);
        let command = crate::types::SessionCommand {
            seq: 1,
            command_id: "cmd-solve".to_string(),
            kind: "solve".to_string(),
            created_at_unix_ms: 0,
            target: None,
            reason: None,
            precondition: None,
            client_intent_id: None,
            requested_at_unix_ms: None,
            until_seconds: None,
            max_steps: Some(20),
            torque_tolerance: Some(1e-4),
            energy_tolerance: None,
            integrator: None,
            fixed_timestep: None,
            max_error: None,
            relax_algorithm: Some("llg_overdamped".to_string()),
            relax_alpha: None,
            mesh_options: None,
            mesh_target: None,
            mesh_reason: None,
            state_path: None,
            state_format: None,
            state_dataset: None,
            state_sample_index: None,
            display_selection: None,
            preview_config: None,
            stages: None,
            profile: None,
        };

        let stage = build_interactive_command_stage(&base_problem, &command)
            .expect("interactive solve should build")
            .expect("solve command should materialize a stage");

        assert_eq!(stage.entrypoint_kind, "interactive_relax");
        assert!(stage.until_seconds.is_infinite());
    }

    #[test]
    fn build_interactive_relax_without_time_budget_ignores_dt_seed_fallback() {
        let base_problem = sample_problem_ir_with_adaptive_relax_dt_limits(4e-16, 4e-16);
        let command = crate::types::SessionCommand {
            seq: 1,
            command_id: "cmd-relax".to_string(),
            kind: "relax".to_string(),
            created_at_unix_ms: 0,
            target: None,
            reason: None,
            precondition: None,
            client_intent_id: None,
            requested_at_unix_ms: None,
            until_seconds: None,
            max_steps: Some(20),
            torque_tolerance: Some(1e-4),
            energy_tolerance: None,
            integrator: None,
            fixed_timestep: None,
            max_error: None,
            relax_algorithm: Some("llg_overdamped".to_string()),
            relax_alpha: None,
            mesh_options: None,
            mesh_target: None,
            mesh_reason: None,
            state_path: None,
            state_format: None,
            state_dataset: None,
            state_sample_index: None,
            display_selection: None,
            preview_config: None,
            stages: None,
            profile: None,
        };

        let stage = build_interactive_command_stage(&base_problem, &command)
            .expect("interactive relax should build")
            .expect("relax command should materialize a stage");

        assert_eq!(stage.entrypoint_kind, "interactive_relax");
        assert!(stage.until_seconds.is_infinite());
    }

    #[test]
    fn build_interactive_relax_prefers_fixed_timestep_over_adaptive_seed() {
        let base_problem = sample_problem_ir_with_adaptive_relax_dt(4e-16);
        let command = crate::types::SessionCommand {
            seq: 1,
            command_id: "cmd-relax".to_string(),
            kind: "relax".to_string(),
            created_at_unix_ms: 0,
            target: None,
            reason: None,
            precondition: None,
            client_intent_id: None,
            requested_at_unix_ms: None,
            until_seconds: None,
            max_steps: Some(20),
            torque_tolerance: Some(1e-4),
            energy_tolerance: None,
            integrator: None,
            fixed_timestep: Some(6e-13),
            max_error: None,
            relax_algorithm: Some("llg_overdamped".to_string()),
            relax_alpha: None,
            mesh_options: None,
            mesh_target: None,
            mesh_reason: None,
            state_path: None,
            state_format: None,
            state_dataset: None,
            state_sample_index: None,
            display_selection: None,
            preview_config: None,
            stages: None,
            profile: None,
        };

        let stage = build_interactive_command_stage(&base_problem, &command)
            .expect("interactive relax should build")
            .expect("relax command should materialize a stage");

        assert_eq!(stage.entrypoint_kind, "interactive_relax");
        assert!((stage.until_seconds - (20.0 * 6e-13)).abs() < 1e-24);
    }

    #[test]
    fn materialize_script_stages_prefers_explicit_stages_over_study_pipeline() {
        let explicit_stage = crate::types::ScriptExecutionStage {
            ir: sample_problem_ir(),
            default_until_seconds: Some(7e-12),
            entrypoint_kind: "explicit_run".to_string(),
            action: None,
        };
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Primitive {
                    id: "stage_1_run".to_string(),
                    label: "".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("script_imported".to_string()),
                    stage_kind: "run".to_string(),
                    payload: serde_json::from_value(json!({
                        "kind": "run",
                        "entrypoint_kind": "pipeline_run",
                        "until_seconds": "5e-12"
                    }))
                    .expect("payload"),
                }],
            }),
            stages: vec![explicit_stage],
        };

        let stages = materialize_script_stages(config).expect("explicit stages should win");
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].entrypoint_kind, "explicit_run");
        assert!((stages[0].until_seconds - 7e-12).abs() < 1e-24);
    }

    #[test]
    fn materialize_script_stages_supports_explicit_synthetic_save_state_action() {
        let explicit_stage = crate::types::ScriptExecutionStage {
            ir: sample_problem_ir(),
            default_until_seconds: None,
            entrypoint_kind: "explicit_save_state".to_string(),
            action: Some(crate::types::ScriptExecutionStageAction::SaveState {
                artifact_name: "snapshot_point_001".to_string(),
                format: Some("json".to_string()),
                dataset: Some("values".to_string()),
            }),
        };
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: None,
            stages: vec![explicit_stage],
        };

        let stages =
            materialize_script_stages(config).expect("explicit save_state should materialize");
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].entrypoint_kind, "explicit_save_state");
        assert_eq!(stages[0].until_seconds, 0.0);
        assert!(matches!(
            &stages[0].action,
            Some(ResolvedScriptStageAction::SaveState {
                artifact_name,
                format,
                dataset,
            }) if artifact_name == "snapshot_point_001"
                && format.as_deref() == Some("json")
                && dataset.as_deref() == Some("values")
        ));
    }

    #[test]
    fn materialize_script_stages_supports_contextual_set_field_and_set_current_nodes() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(3e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "stage_1_field".to_string(),
                        label: "Set Field".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "set_field".to_string(),
                        payload: serde_json::from_value(json!({
                            "axis": "z",
                            "field_mT": "25"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_2_current".to_string(),
                        label: "Set Current".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "set_current".to_string(),
                        payload: serde_json::from_value(json!({
                            "direction": "y",
                            "current_density": "2.5e10"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_3_run".to_string(),
                        label: "Run".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "run".to_string(),
                        payload: serde_json::from_value(json!({
                            "entrypoint_kind": "pipeline_run_after_context",
                            "until_seconds": "3e-12"
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].entrypoint_kind, "pipeline_run_after_context");
        assert_eq!(zeeman_field(&stages[0].ir), Some([0.0, 0.0, 0.025]));
        assert_eq!(stages[0].ir.current_density, Some([0.0, 2.5e10, 0.0]));
    }

    #[test]
    fn materialize_script_stages_supports_synthetic_state_actions() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(3e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "stage_save".to_string(),
                        label: "Save".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "save_state".to_string(),
                        payload: serde_json::from_value(json!({
                            "artifact_name": "state_snapshot",
                            "format": "json"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_load".to_string(),
                        label: "Load".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "load_state".to_string(),
                        payload: serde_json::from_value(json!({
                            "artifact_name": "state_snapshot"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_export".to_string(),
                        label: "Export".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "export".to_string(),
                        payload: serde_json::from_value(json!({
                            "artifact_name": "m_export",
                            "quantity": "magnetization",
                            "format": "json"
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 3);
        assert!(matches!(
            &stages[0].action,
            Some(ResolvedScriptStageAction::SaveState { artifact_name, format, .. })
                if artifact_name == "state_snapshot" && format.as_deref() == Some("json")
        ));
        assert!(matches!(
            &stages[1].action,
            Some(ResolvedScriptStageAction::LoadState { artifact_name, .. })
                if artifact_name.as_deref() == Some("state_snapshot")
        ));
        assert!(matches!(
            &stages[2].action,
            Some(ResolvedScriptStageAction::Export {
                artifact_name,
                quantity,
                format,
                ..
            }) if artifact_name.as_deref() == Some("m_export")
                && quantity == "magnetization"
                && format == "json"
        ));
    }

    #[test]
    fn materialize_script_stages_supports_change_device_action() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(3e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "stage_relax".to_string(),
                        label: "Relax".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "relax".to_string(),
                        payload: serde_json::from_value(json!({
                            "max_steps": 25
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_change_device".to_string(),
                        label: "Change device".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "change_device".to_string(),
                        payload: serde_json::from_value(json!({
                            "device": "cpu"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_run".to_string(),
                        label: "Run".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "run".to_string(),
                        payload: serde_json::from_value(json!({
                            "until_seconds": 2e-12
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 3);
        assert!(matches!(
            &stages[1].action,
            Some(ResolvedScriptStageAction::ChangeDevice { device }) if device == "cpu"
        ));
        assert_eq!(requested_device(&stages[1].ir), "cpu");
        assert_eq!(requested_device(&stages[2].ir), "cpu");
        assert_eq!(
            stages[1]
                .incoming_transition
                .as_ref()
                .map(|transition| transition.reason),
            Some(StageTransitionReason::DeviceChange)
        );
        assert_eq!(
            stages[1]
                .incoming_transition
                .as_ref()
                .and_then(|transition| transition.transfer_operator),
            Some(StateTransferOperatorKind::IdentityCopy)
        );
    }

    #[test]
    fn materialize_pipeline_change_device_preserves_frequency_response_magnetostatic_bc() {
        let mut base = sample_problem_ir();
        base.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        set_runtime_selection_device(&mut base, "gpu");
        let config = ScriptExecutionConfig {
            ir: base,
            shared_geometry_assets: None,
            default_until_seconds: Some(3e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "stage_change_device".to_string(),
                        label: "Change device".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "change_device".to_string(),
                        payload: serde_json::from_value(json!({
                            "device": "cpu"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_frequency_response".to_string(),
                        label: "Frequency response".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "frequency_response".to_string(),
                        payload: serde_json::from_value(json!({
                            "frequency_values_hz": [2.0e9, 2.5e9],
                            "frequency_spin_wave_bc": "periodic",
                            "frequency_magnetostatic_bc": "periodic_airbox_k0",
                            "frequency_solver_method": "gpu_operator_host_krylov",
                            "frequency_solver_preconditioner": "block_jacobi",
                            "frequency_solver_max_iterations": "128",
                            "frequency_solver_restart_iterations": "32",
                            "frequency_solver_rtol": "0.01"
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");

        assert_eq!(stages.len(), 2);
        assert_eq!(requested_device(&stages[0].ir), "cpu");
        assert_eq!(requested_device(&stages[1].ir), "cpu");
        assert!(matches!(
            &stages[1].ir.study,
            fullmag_ir::StudyIR::FrequencyResponse { magnetostatic_bc, .. }
                if *magnetostatic_bc
                    == fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0
        ));
        match &stages[1].ir.study {
            fullmag_ir::StudyIR::FrequencyResponse { solver_policy, .. } => {
                let policy = solver_policy
                    .as_ref()
                    .expect("frequency response solver policy should materialize");
                assert_eq!(
                    policy.method,
                    Some(fullmag_ir::FrequencyResponseSolverMethodIR::GpuOperatorHostKrylov)
                );
                assert_eq!(
                    policy.preconditioner,
                    Some(fullmag_ir::FrequencyResponsePreconditionerIR::BlockJacobi)
                );
                assert_eq!(policy.rtol, Some(1.0e-2));
                assert_eq!(policy.max_iterations, Some(128));
                assert_eq!(policy.restart_iterations, Some(32));
            }
            other => panic!("expected frequency response study, got {other:?}"),
        }
    }

    #[test]
    fn materialize_script_stages_supports_relax_run_macro() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Macro {
                    id: "macro_1".to_string(),
                    label: "Relax -> Run".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("ui_authored".to_string()),
                    macro_kind: "relax_run".to_string(),
                    config: serde_json::from_value(json!({
                        "run_until_seconds": "9e-12",
                        "max_steps": "40",
                        "torque_tolerance": "5e-7"
                    }))
                    .expect("config"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("macro should materialize");
        assert_eq!(stages.len(), 2);
        assert_eq!(stages[0].entrypoint_kind, "study_pipeline_relax_run_relax");
        assert!(matches!(
            stages[0].ir.study,
            fullmag_ir::StudyIR::Relaxation {
                stop: fullmag_ir::RelaxStopIR {
                    max_steps: Some(40),
                    torque_tolerance_apm: Some(torque_tolerance),
                    ..
                },
                ..
            } if (torque_tolerance - 5e-7).abs() < 1e-24
        ));
        assert_eq!(stages[1].entrypoint_kind, "study_pipeline_relax_run_run");
        assert!((stages[1].until_seconds - 9e-12).abs() < 1e-24);
    }

    #[test]
    fn materialize_script_stages_supports_field_sweep_relax_macro() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(2e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Macro {
                    id: "macro_1".to_string(),
                    label: "Field Sweep + Relax".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("ui_authored".to_string()),
                    macro_kind: "field_sweep_relax".to_string(),
                    config: serde_json::from_value(json!({
                        "axis": "z",
                        "start_mT": -50,
                        "stop_mT": 50,
                        "steps": 3,
                        "relax_each": true
                    }))
                    .expect("config"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("field sweep should materialize");
        assert_eq!(stages.len(), 6);
        assert_eq!(zeeman_field(&stages[0].ir), Some([0.0, 0.0, -0.05]));
        assert_eq!(zeeman_field(&stages[5].ir), Some([0.0, 0.0, 0.05]));
        assert_eq!(
            stages[0].entrypoint_kind,
            "study_pipeline_field_sweep_relax_point_001_run"
        );
        assert_eq!(
            stages[1].entrypoint_kind,
            "study_pipeline_field_sweep_relax_point_001_relax"
        );
        assert_eq!(
            stages[5].entrypoint_kind,
            "study_pipeline_field_sweep_relax_point_003_relax"
        );
    }

    #[test]
    fn materialize_script_stages_supports_hysteresis_loop_macro() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Macro {
                    id: "macro_1".to_string(),
                    label: "Hysteresis Loop".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("ui_authored".to_string()),
                    macro_kind: "hysteresis_loop".to_string(),
                    config: serde_json::from_value(json!({
                        "quantity": "b_ext",
                        "direction": [1.0, 0.0, 0.0],
                        "field_values_t": [-0.02, 0.02],
                        "settle": {
                            "torque_tolerance_apm": 5e-7,
                            "max_steps": 40,
                            "max_physical_time_s": 2e-12
                        }
                    }))
                    .expect("config"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("hysteresis loop should materialize");
        assert_eq!(stages.len(), 2);
        assert_eq!(zeeman_field(&stages[0].ir), Some([-0.02, 0.0, 0.0]));
        assert_eq!(zeeman_field(&stages[1].ir), Some([0.02, 0.0, 0.0]));
        assert_eq!(
            stages[0].entrypoint_kind,
            "study_pipeline_hysteresis_branch_point_001_relax"
        );
        assert_eq!(
            stages[1].entrypoint_kind,
            "study_pipeline_hysteresis_branch_point_002_relax"
        );
        assert!(matches!(
            stages[0].ir.study,
            fullmag_ir::StudyIR::Relaxation {
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(torque_tolerance_apm),
                    max_steps: Some(40),
                    max_relaxation_time_s: Some(max_physical_time_s),
                    ..
                },
                ..
            } if (torque_tolerance_apm - 5e-7).abs() < 1e-24
                && (max_physical_time_s - 2e-12).abs() < 1e-24
        ));
    }

    #[test]
    fn materialize_script_stages_supports_field_sweep_relax_snapshot_macro() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Macro {
                    id: "macro_1".to_string(),
                    label: "Field Sweep + Relax + Snapshot".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("ui_authored".to_string()),
                    macro_kind: "field_sweep_relax_snapshot".to_string(),
                    config: serde_json::from_value(json!({
                        "axis": "y",
                        "start_mT": -10,
                        "stop_mT": 10,
                        "steps": 2,
                        "relax_each": true,
                        "save_format": "json"
                    }))
                    .expect("config"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("snapshot sweep should materialize");
        assert_eq!(stages.len(), 6);
        assert!(matches!(
            &stages[2].action,
            Some(ResolvedScriptStageAction::SaveState { .. })
        ));
        assert!(matches!(
            &stages[5].action,
            Some(ResolvedScriptStageAction::SaveState { .. })
        ));
    }

    #[test]
    fn materialize_script_stages_supports_hysteresis_loop_save_point_state() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Macro {
                    id: "macro_1".to_string(),
                    label: "Hysteresis Loop".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("ui_authored".to_string()),
                    macro_kind: "hysteresis_loop".to_string(),
                    config: serde_json::from_value(json!({
                        "quantity": "b_ext",
                        "axis": "z",
                        "start_mT": -5,
                        "stop_mT": 5,
                        "steps": 2,
                        "save_point_state": true
                    }))
                    .expect("config"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("hysteresis should materialize");
        assert_eq!(stages.len(), 4);
        assert_eq!(
            stages[0].entrypoint_kind,
            "study_pipeline_hysteresis_branch_point_001_relax"
        );
        assert_eq!(
            stages[2].entrypoint_kind,
            "study_pipeline_hysteresis_branch_point_002_relax"
        );
        assert!(matches!(
            &stages[1].action,
            Some(ResolvedScriptStageAction::SaveState { .. })
        ));
        assert!(matches!(
            &stages[3].action,
            Some(ResolvedScriptStageAction::SaveState { .. })
        ));
    }

    #[test]
    fn materialize_script_stages_supports_parameter_sweep_b_ext() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Macro {
                    id: "macro_1".to_string(),
                    label: "Parameter Sweep".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("ui_authored".to_string()),
                    macro_kind: "parameter_sweep".to_string(),
                    config: serde_json::from_value(json!({
                        "parameter": "b_ext",
                        "axis": "x",
                        "start_mT": -10,
                        "stop_mT": 10,
                        "steps": 2,
                        "solve_kind": "run_relax",
                        "run_until_seconds": "2e-12"
                    }))
                    .expect("config"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("parameter sweep should materialize");
        assert_eq!(stages.len(), 4);
        assert_eq!(zeeman_field(&stages[0].ir), Some([-0.01, 0.0, 0.0]));
        assert_eq!(zeeman_field(&stages[3].ir), Some([0.01, 0.0, 0.0]));
        assert_eq!(
            stages[0].entrypoint_kind,
            "study_pipeline_parameter_sweep_point_001_run"
        );
        assert_eq!(
            stages[1].entrypoint_kind,
            "study_pipeline_parameter_sweep_point_001_relax"
        );
        assert!((stages[0].until_seconds - 2e-12).abs() < 1e-24);
    }

    #[test]
    fn materialize_script_stages_supports_parameter_sweep_current_density_with_snapshots() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Macro {
                    id: "macro_1".to_string(),
                    label: "Parameter Sweep".to_string(),
                    enabled: true,
                    notes: None,
                    source: Some("ui_authored".to_string()),
                    macro_kind: "parameter_sweep".to_string(),
                    config: serde_json::from_value(json!({
                        "parameter": "current_density",
                        "axis": "z",
                        "start_value": 1e10,
                        "stop_value": 2e10,
                        "steps": 2,
                        "solve_kind": "relax",
                        "save_point_state": true,
                        "save_format": "json"
                    }))
                    .expect("config"),
                }],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("parameter sweep should materialize");
        assert_eq!(stages.len(), 4);
        assert_eq!(stages[0].ir.current_density, Some([0.0, 0.0, 1e10]));
        assert_eq!(stages[2].ir.current_density, Some([0.0, 0.0, 2e10]));
        assert!(matches!(
            &stages[1].action,
            Some(ResolvedScriptStageAction::SaveState { .. })
        ));
        assert!(matches!(
            &stages[3].action,
            Some(ResolvedScriptStageAction::SaveState { .. })
        ));
    }

    // ------------------------------------------------------------------
    // Cross-backend resampling (FEM → FDM)
    // ------------------------------------------------------------------

    /// Build a small FEM MeshIR: a cube [0, 100e-9]³ split into 6 tets.
    fn small_fem_cube_mesh() -> fullmag_ir::MeshIR {
        let s = 100e-9_f64;
        // 8 corners of the cube
        let nodes = vec![
            [0.0, 0.0, 0.0],
            [s, 0.0, 0.0],
            [s, s, 0.0],
            [0.0, s, 0.0],
            [0.0, 0.0, s],
            [s, 0.0, s],
            [s, s, s],
            [0.0, s, s],
        ];
        // 5 tets that tile the cube (standard non-degenerate decomposition)
        let elements: Vec<[u32; 4]> = vec![
            [0, 1, 3, 4],
            [1, 2, 3, 6],
            [1, 4, 5, 6],
            [3, 4, 6, 7],
            [1, 3, 4, 6],
        ];
        let element_markers = vec![1u32; 5];
        // Boundary faces (not critical for resampling, but required by IR)
        let boundary_faces: Vec<[u32; 3]> = vec![
            [0, 1, 3],
            [1, 2, 3],
            [4, 5, 7],
            [5, 6, 7],
            [0, 1, 4],
            [1, 4, 5],
            [2, 3, 6],
            [3, 6, 7],
            [0, 3, 4],
            [3, 4, 7],
            [1, 2, 5],
            [2, 5, 6],
        ];
        let boundary_markers = vec![1u32; 12];

        fullmag_ir::MeshIR {
            mesh_name: "test_cube".to_string(),
            nodes,
            elements,
            element_markers,
            boundary_faces,
            boundary_markers,
            periodic_boundary_pairs: vec![],
            periodic_node_pairs: vec![],
            per_domain_quality: Default::default(),
        }
    }

    /// Build a ProblemIR requesting FDM backend for a Box that covers the same
    /// 100 nm cube as the test FEM mesh.
    fn fdm_target_problem_ir() -> ProblemIR {
        serde_json::from_value(json!({
            "ir_version": "0.2.0",
            "problem_meta": {
                "name": "cross_backend_test",
                "description": null,
                "script_language": "python",
                "script_source": null,
                "script_api_version": "0.2.0",
                "serializer_version": "0.2.0",
                "entrypoint_kind": "direct_script",
                "source_hash": null,
                "runtime_metadata": {},
                "backend_revision": null,
                "seeds": []
            },
            "geometry": {
                "entries": [{
                    "kind": "box",
                    "name": "cube",
                    "size": [100e-9, 100e-9, 100e-9]
                }]
            },
            "regions": [{
                "name": "cube",
                "geometry": "cube"
            }],
            "materials": [{
                "name": "Py",
                "saturation_magnetisation": 800000.0,
                "exchange_stiffness": 1.3e-11,
                "damping": 0.5,
                "uniaxial_anisotropy": null,
                "anisotropy_axis": null
            }],
            "magnets": [{
                "name": "cube",
                "region": "cube",
                "material": "Py",
                "initial_magnetization": {
                    "kind": "uniform",
                    "value": [1.0, 0.0, 0.0]
                }
            }],
            "energy_terms": [{ "kind": "exchange" }],
            "study": {
                "kind": "time_evolution",
                "dynamics": {
                    "kind": "llg",
                    "gyromagnetic_ratio": 221000.0,
                    "integrator": "rk45",
                    "fixed_timestep": 1e-13
                },
                "sampling": {
                    "outputs": [{
                        "kind": "scalar",
                        "name": "E_ex",
                        "every_seconds": 1e-13
                    }]
                }
            },
            "backend_policy": {
                "requested_backend": "fdm",
                "execution_precision": "double",
                "discretization_hints": {
                    "fdm": { "cell": [25e-9, 25e-9, 25e-9] }
                }
            },
            "validation_profile": {
                "execution_mode": "strict"
            }
        }))
        .expect("FDM target ProblemIR should parse")
    }

    fn fem_target_problem_ir(mesh: fullmag_ir::MeshIR) -> ProblemIR {
        let mut problem = sample_problem_ir();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        problem.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fdm: None,
            fem: Some(fullmag_ir::FemHintsIR {
                order: 1,
                hmax: 25e-9,
                mesh: None,
                demag_solver_policy: None,
            }),
            hybrid: None,
        });
        if let fullmag_ir::StudyIR::TimeEvolution { sampling, .. } = &mut problem.study {
            sampling.outputs = vec![fullmag_ir::OutputIR::Scalar {
                name: "E_ex".to_string(),
                every_seconds: 1e-13,
            }];
        }
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: vec![],
            fem_mesh_assets: vec![],
            fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
                mesh_source: None,
                mesh: Some(mesh),
                region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "track".to_string(),
                    marker: 1,
                }],
                object_region_markers: Vec::new(),
                build_report: None,
            }),
        });
        problem
    }

    fn small_fem_cube_mesh_with_center_node() -> fullmag_ir::MeshIR {
        let mut mesh = small_fem_cube_mesh();
        let s = 100e-9_f64;
        mesh.nodes.push([0.5 * s, 0.5 * s, 0.5 * s]);
        mesh.mesh_name = "test_cube_with_center".to_string();
        mesh
    }

    fn small_fem_cube_mesh_same_count_shifted() -> fullmag_ir::MeshIR {
        let mut mesh = small_fem_cube_mesh();
        let s = 100e-9_f64;
        mesh.nodes[6] = [0.9 * s, 0.9 * s, 0.9 * s];
        mesh.mesh_name = "test_cube_shifted".to_string();
        mesh
    }

    #[test]
    fn test_resample_fem_to_fdm_returns_some_for_cross_backend() {
        let mesh_ir = small_fem_cube_mesh();
        // Uniform +x magnetization at 8 FEM nodes
        let fem_m: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; 8];
        let source = ContinuationSource::Fem(mesh_ir);
        let target_ir = fdm_target_problem_ir();

        let result = resample_continuation_if_cross_backend(&fem_m, &source, &target_ir)
            .expect("resampling should succeed");

        let transfer = result.expect("should return Some for FEM→FDM");
        // A 100 nm cube with 25 nm cells → 4×4×4 = 64 cells
        assert_eq!(transfer.n_total, 64, "grid total should be 4×4×4 = 64");
        assert!(
            transfer.n_located > 0,
            "should have some cells inside the mesh"
        );
        // All located cells should have roughly +x magnetization
        for v in &transfer.values {
            let mag = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if mag > 0.5 {
                // This is a located cell — should be ~[1, 0, 0]
                assert!(v[0] > 0.8, "x component should be ~1.0, got {}", v[0]);
            }
        }
    }

    #[test]
    fn test_resample_fem_to_fem_returns_transfer_for_remeshed_target() {
        let source_mesh = small_fem_cube_mesh();
        let target_ir = fem_target_problem_ir(small_fem_cube_mesh_with_center_node());
        let fem_m: Vec<[f64; 3]> = source_mesh
            .nodes
            .iter()
            .enumerate()
            .map(|(index, _)| {
                if index % 2 == 0 {
                    [1.0, 0.0, 0.0]
                } else {
                    [0.0, 1.0, 0.0]
                }
            })
            .collect();
        let source = ContinuationSource::Fem(source_mesh);

        let result = resample_continuation_if_cross_backend(&fem_m, &source, &target_ir)
            .expect("FEM to FEM remesh transfer should succeed");

        let transfer = result.expect("FEM→FEM remesh should transfer to target nodes");
        assert_eq!(transfer.n_total, 9);
        assert_eq!(transfer.values.len(), 9);
        assert!(transfer.n_located > 0);
        for value in transfer.values {
            let norm = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
            assert!(
                (norm - 1.0).abs() < 1e-12,
                "transferred magnetization should be normalized, got {norm}"
            );
        }
    }

    #[test]
    fn test_resample_fem_to_fem_transfers_when_mesh_changes_without_node_count_change() {
        let source_mesh = small_fem_cube_mesh();
        let target_ir = fem_target_problem_ir(small_fem_cube_mesh_same_count_shifted());
        let fem_m: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; source_mesh.nodes.len()];
        let source = ContinuationSource::Fem(source_mesh);

        let result = resample_continuation_if_cross_backend(&fem_m, &source, &target_ir)
            .expect("FEM to FEM same-count remesh transfer should succeed");

        let transfer =
            result.expect("changed FEM mesh should transfer even when node count matches");
        assert_eq!(transfer.n_total, 8);
        assert_eq!(transfer.values.len(), 8);
        assert!(transfer.n_located > 0);
    }

    #[test]
    fn test_resample_fdm_to_fdm_returns_none() {
        let fdm_m: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; 64];
        let source = ContinuationSource::Fdm;
        let target_ir = fdm_target_problem_ir();

        let result = resample_continuation_if_cross_backend(&fdm_m, &source, &target_ir)
            .expect("same-backend check should succeed");

        assert!(
            result.is_none(),
            "FDM→FDM should return None (no resampling)"
        );
    }

    #[test]
    fn materialize_pipeline_partitions_time_and_eigen_outputs() {
        let mut ir = sample_problem_ir();
        if let fullmag_ir::StudyIR::TimeEvolution { sampling, .. } = &mut ir.study {
            sampling.outputs = vec![
                fullmag_ir::OutputIR::Field {
                    name: "m".to_string(),
                    every_seconds: 1e-12,
                },
                fullmag_ir::OutputIR::EigenSpectrum {
                    quantity: "spectrum".to_string(),
                },
                fullmag_ir::OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![0, 1, 7],
                },
            ];
        }
        let config = ScriptExecutionConfig {
            ir,
            shared_geometry_assets: None,
            default_until_seconds: Some(3e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "stage_relax".to_string(),
                        label: "Relax".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "relax".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "relax",
                            "max_steps": "25"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_change_device".to_string(),
                        label: "Change device".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "change_device".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "change_device",
                            "device": "cpu"
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "stage_eigenmodes".to_string(),
                        label: "Eigenmodes".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "eigenmodes".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "eigenmodes",
                            "eigen_count": "4"
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 3);
        stages[0]
            .ir
            .validate()
            .expect("relax stage outputs should validate");
        stages[2]
            .ir
            .validate()
            .expect("eigen stage outputs should validate");
        assert!(matches!(
            &stages[0].ir.study,
            fullmag_ir::StudyIR::Relaxation { sampling, .. }
                if sampling.outputs.iter().all(|output| matches!(output, fullmag_ir::OutputIR::Field { .. }))
        ));
        assert!(matches!(
            &stages[2].ir.study,
            fullmag_ir::StudyIR::Eigenmodes { sampling, .. }
                if sampling.outputs.iter().all(|output| matches!(
                    output,
                    fullmag_ir::OutputIR::EigenSpectrum { .. }
                        | fullmag_ir::OutputIR::EigenMode { .. }
                ))
        ));
        let fullmag_ir::StudyIR::Eigenmodes { sampling, .. } = &stages[2].ir.study else {
            panic!("expected eigenmodes stage");
        };
        let mode_indices = sampling.outputs.iter().find_map(|output| match output {
            fullmag_ir::OutputIR::EigenMode { indices, .. } => Some(indices),
            _ => None,
        });
        assert_eq!(mode_indices, Some(&vec![0, 1]));
    }

    #[test]
    fn materialize_explicit_stages_partitions_time_and_eigen_outputs() {
        let mut base = sample_problem_ir();
        let dynamics = base.study.dynamics().clone();
        let mut sampling = base.study.sampling().clone();
        sampling.outputs = vec![
            fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "spectrum".to_string(),
            },
            fullmag_ir::OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0, 1, 7],
            },
        ];
        base.study = fullmag_ir::StudyIR::TimeEvolution {
            dynamics: dynamics.clone(),
            sampling: sampling.clone(),
        };
        let mut relax_ir = base.clone();
        relax_ir.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            dynamics: None,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: Some(25),
                max_relaxation_time_s: None,
            },
            sampling: sampling.clone(),
        };
        let mut eigen_ir = base.clone();
        eigen_ir.study = fullmag_ir::StudyIR::Eigenmodes {
            dynamics,
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: true,
            },
            count: 4,
            target: fullmag_ir::EigenTargetIR::Lowest,
            equilibrium: fullmag_ir::EquilibriumSourceIR::RelaxedInitialState,
            k_sampling: None,
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            sampling,
            mode_tracking: None,
        };
        let stages = materialize_script_stages(ScriptExecutionConfig {
            ir: base,
            shared_geometry_assets: None,
            default_until_seconds: Some(3e-12),
            study_pipeline: None,
            stages: vec![
                ScriptExecutionStage {
                    ir: relax_ir,
                    default_until_seconds: None,
                    entrypoint_kind: "flat_relax".to_string(),
                    action: None,
                },
                ScriptExecutionStage {
                    ir: eigen_ir,
                    default_until_seconds: None,
                    entrypoint_kind: "flat_eigenmodes".to_string(),
                    action: None,
                },
            ],
        })
        .expect("explicit stages should materialize");

        assert_eq!(stages.len(), 2);
        stages[0]
            .ir
            .validate()
            .expect("explicit relax outputs should validate");
        stages[1]
            .ir
            .validate()
            .expect("explicit eigen outputs should validate");
    }
}
