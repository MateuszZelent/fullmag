use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use fullmag_ir::{BackendPlanIR, ProblemIR};
#[cfg(test)]
use fullmag_ir::{
    OutputDataFormatIR, OutputIR, OutputStorageIR, RegionalFieldDriveIR, TableAutosaveIR,
};
#[cfg(test)]
use serde_json::Value;
#[cfg(test)]
use std::collections::BTreeMap;

use fullmag_engine::fem::MeshTopology;
use fullmag_engine::fem_solution_transfer::{
    normalize_unit_vectors, transfer_fem_field_to_grid, GridTransferResult,
};

#[cfg(test)]
use fullmag_application::script_stage_materialization::{
    materialize_pipeline_eigenmodes, materialize_pipeline_relax,
    propagate_disabled_transport_pipeline, requested_device, set_runtime_selection_device,
};
use fullmag_application::script_stage_materialization::{
    materialize_script_stages_with_output_policy, required_study_dynamics,
    resolve_relaxation_until_seconds,
};

use crate::formatting::unix_time_millis;
use crate::live_workspace::LocalLiveWorkspace;
use crate::types::{
    LiveStateManifest, LiveStepView, ResolvedScriptStage, RunManifest, ScriptExecutionConfig,
};
#[cfg(test)]
use crate::types::{
    ResolvedScriptStageAction, ScriptExecutionStageAction, StageTransitionKind,
    StageTransitionMetadata, StageTransitionReason, StateTransferOperatorKind,
    StudyPipelineDocument, StudyPipelineNode,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScriptOutputPaths {
    pub(crate) workspace_dir: PathBuf,
    pub(crate) artifact_dir: PathBuf,
    pub(crate) is_sibling_zarr_bundle: bool,
}

pub(crate) fn resolve_script_output_paths(
    script_path: &Path,
    explicit_output_dir: Option<&Path>,
    session_root: &Path,
    session_id: &str,
) -> ScriptOutputPaths {
    if let Some(artifact_dir) = explicit_output_dir {
        return ScriptOutputPaths {
            workspace_dir: session_root.join(session_id),
            artifact_dir: artifact_dir.to_path_buf(),
            is_sibling_zarr_bundle: false,
        };
    }

    let workspace_dir = script_path.with_extension("zarr");
    ScriptOutputPaths {
        artifact_dir: workspace_dir.join("artifacts"),
        workspace_dir,
        is_sibling_zarr_bundle: true,
    }
}

pub(crate) fn initialize_zarr_group(path: &Path, attributes: serde_json::Value) -> Result<()> {
    fs::create_dir_all(path)
        .with_context(|| format!("failed to create Zarr group {}", path.display()))?;
    fs::write(
        path.join(".zgroup"),
        serde_json::to_vec_pretty(&serde_json::json!({"zarr_format": 2}))?,
    )
    .with_context(|| format!("failed to write Zarr group metadata in {}", path.display()))?;
    fs::write(
        path.join(".zattrs"),
        serde_json::to_vec_pretty(&attributes)?,
    )
    .with_context(|| format!("failed to write Zarr attributes in {}", path.display()))?;
    Ok(())
}

pub(crate) fn initialize_script_result_bundle(
    paths: &ScriptOutputPaths,
    script_path: &Path,
    session_id: &str,
) -> Result<()> {
    initialize_zarr_group(
        &paths.workspace_dir,
        serde_json::json!({
            "fullmag_schema": "fullmag.script_results.v1",
            "script_path": script_path,
            "session_id": session_id,
            "artifacts_group": "artifacts",
            "stages_group": "stages",
        }),
    )?;
    initialize_zarr_group(
        &paths.artifact_dir,
        serde_json::json!({"fullmag_role": "final_stage_artifacts"}),
    )?;
    initialize_zarr_group(
        &paths.workspace_dir.join("stages"),
        serde_json::json!({"fullmag_role": "stage_artifacts"}),
    )?;
    Ok(())
}

pub(crate) fn replace_and_initialize_script_result_bundle(
    paths: &ScriptOutputPaths,
    script_path: &Path,
    session_id: &str,
) -> Result<()> {
    if !paths.is_sibling_zarr_bundle {
        bail!("refusing to replace a non-default result directory");
    }

    if paths.workspace_dir.exists() {
        let metadata = fs::symlink_metadata(&paths.workspace_dir).with_context(|| {
            format!(
                "failed to inspect existing default result bundle {}",
                paths.workspace_dir.display()
            )
        })?;
        if !metadata.file_type().is_dir() {
            bail!(
                "default result bundle path is not a directory: {}",
                paths.workspace_dir.display()
            );
        }
        fs::remove_dir_all(&paths.workspace_dir).with_context(|| {
            format!(
                "failed to replace existing default result bundle {}",
                paths.workspace_dir.display()
            )
        })?;
    }

    initialize_script_result_bundle(paths, script_path, session_id)
}

pub(crate) fn emit_initial_state_warnings(
    live_workspace: Option<&LocalLiveWorkspace>,
    problem: &fullmag_ir::ProblemIR,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<()> {
    let resolved_runtime = fullmag_runner::resolve_planned_runtime_engine(problem, execution_plan)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let diagnostic = crate::diagnostics::diagnose_initial_backend_plan(
        &execution_plan.backend_plan,
        &resolved_runtime,
    )?;
    for warning in diagnostic.warnings {
        eprintln!("fullmag diagnostic warning: {}", warning);
        if let Some(workspace) = live_workspace {
            workspace.push_log("warning", warning);
        }
    }
    Ok(())
}

pub(crate) fn offset_step_update(
    mut update: fullmag_runner::StepUpdate,
    step_offset: u64,
    time_offset: f64,
    finished: bool,
) -> fullmag_runner::StepUpdate {
    update.stats.step = update.stats.step.saturating_add(step_offset);
    update.stats.time += time_offset;
    for status in &mut update.stats.field_materialization_states {
        status.source_step = status.source_step.saturating_add(step_offset);
    }
    for field in update.preview_field.iter_mut().chain(
        update
            .cached_preview_fields
            .iter_mut()
            .flat_map(|fields| fields.iter_mut()),
    ) {
        // Explicit capture coordinates are stage-local, just like StepStats.
        // Legacy unstamped fields inherit the adjusted stats at ingestion.
        if field.source_time_seconds.is_some() || field.source_step > 0 {
            field.source_step = field.source_step.saturating_add(step_offset);
        }
        if let Some(time) = &mut field.source_time_seconds {
            *time += time_offset;
        }
    }
    update.finished = finished;
    update
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

#[cfg(test)]
mod output_path_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn default_script_output_is_one_sibling_zarr_bundle() {
        let paths = resolve_script_output_paths(
            Path::new("/work/scenarios/case_a_rk4_fixed.py"),
            None,
            Path::new("/work/.fullmag/local-live/history"),
            "session-123",
        );

        assert_eq!(
            paths.workspace_dir,
            PathBuf::from("/work/scenarios/case_a_rk4_fixed.zarr")
        );
        assert_eq!(
            paths.artifact_dir,
            PathBuf::from("/work/scenarios/case_a_rk4_fixed.zarr/artifacts")
        );
        assert_eq!(
            stage_artifact_dir(
                &paths.workspace_dir,
                &paths.artifact_dir,
                0,
                3,
                "flat_relax",
            ),
            PathBuf::from("/work/scenarios/case_a_rk4_fixed.zarr/stages/stage_00_flat_relax")
        );
    }

    #[test]
    fn explicit_output_dir_preserves_existing_session_workspace_contract() {
        let paths = resolve_script_output_paths(
            Path::new("/work/scenarios/case_a_rk4_fixed.py"),
            Some(Path::new("/reports/sp4/artifacts")),
            Path::new("/work/.fullmag/local-live/history"),
            "session-123",
        );

        assert_eq!(
            paths.workspace_dir,
            PathBuf::from("/work/.fullmag/local-live/history/session-123")
        );
        assert_eq!(paths.artifact_dir, PathBuf::from("/reports/sp4/artifacts"));
    }

    #[test]
    fn sibling_result_bundle_is_a_zarr_group_with_artifact_and_stage_groups() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "fullmag-script-result-bundle-{}-{nonce}",
            std::process::id()
        ));
        let paths = ScriptOutputPaths {
            workspace_dir: root.join("case_a.zarr"),
            artifact_dir: root.join("case_a.zarr/artifacts"),
            is_sibling_zarr_bundle: true,
        };

        initialize_script_result_bundle(&paths, Path::new("/work/case_a.py"), "session-123")
            .expect("bundle metadata should be writable");

        for group in [
            paths.workspace_dir.clone(),
            paths.artifact_dir.clone(),
            paths.workspace_dir.join("stages"),
        ] {
            let zgroup: serde_json::Value = serde_json::from_slice(
                &fs::read(group.join(".zgroup")).expect("Zarr group metadata should exist"),
            )
            .expect("Zarr group metadata should be JSON");
            assert_eq!(zgroup["zarr_format"], 2);
            assert!(group.join(".zattrs").is_file());
        }
        let attrs: serde_json::Value = serde_json::from_slice(
            &fs::read(paths.workspace_dir.join(".zattrs")).expect("bundle attributes should exist"),
        )
        .expect("bundle attributes should be JSON");
        assert_eq!(attrs["fullmag_schema"], "fullmag.script_results.v1");
        assert_eq!(attrs["script_path"], "/work/case_a.py");

        fs::remove_dir_all(root).expect("owned temporary bundle should be removable");
    }

    #[test]
    fn default_sibling_bundle_replaces_the_previous_attempt() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "fullmag-script-result-replace-{}-{nonce}",
            std::process::id()
        ));
        let paths = ScriptOutputPaths {
            workspace_dir: root.join("case_a.zarr"),
            artifact_dir: root.join("case_a.zarr/artifacts"),
            is_sibling_zarr_bundle: true,
        };
        fs::create_dir_all(&paths.workspace_dir).expect("old result bundle should be creatable");
        let stale = paths.workspace_dir.join("stale-attempt.txt");
        fs::write(&stale, b"old attempt").expect("old result marker should be writable");

        replace_and_initialize_script_result_bundle(
            &paths,
            Path::new("/work/case_a.py"),
            "session-456",
        )
        .expect("default result bundle should be replaceable");

        assert!(!stale.exists());
        assert!(paths.workspace_dir.join(".zgroup").is_file());
        assert!(paths.artifact_dir.join(".zgroup").is_file());
        assert!(paths.workspace_dir.join("stages/.zgroup").is_file());

        fs::remove_dir_all(root).expect("owned temporary bundle should be removable");
    }

    #[test]
    fn default_sibling_bundle_does_not_replace_a_file() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "fullmag-script-result-file-collision-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root should be creatable");
        let paths = ScriptOutputPaths {
            workspace_dir: root.join("case_a.zarr"),
            artifact_dir: root.join("case_a.zarr/artifacts"),
            is_sibling_zarr_bundle: true,
        };
        fs::write(&paths.workspace_dir, b"keep me").expect("collision file should be writable");

        let error = replace_and_initialize_script_result_bundle(
            &paths,
            Path::new("/work/case_a.py"),
            "session-456",
        )
        .expect_err("a non-directory collision must fail closed");

        assert!(error.to_string().contains("is not a directory"));
        assert_eq!(fs::read(&paths.workspace_dir).unwrap(), b"keep me");
        fs::remove_dir_all(root).expect("owned temporary root should be removable");
    }
}

pub(crate) fn flatten_magnetization(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|value| value.iter().copied())
        .collect()
}

pub(crate) fn live_state_manifest_from_update(
    mut update: fullmag_runner::StepUpdate,
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
            e_rotated_dmi: update.stats.e_rotated_dmi,
            e_total: update.stats.e_total,
            max_dm_dt: update.stats.max_dm_dt,
            max_h_eff: update.stats.max_h_eff,
            max_h_demag: update.stats.max_h_demag,
            max_torque_Apm: update.stats.max_torque_Apm,
            max_torque_T: update.stats.max_torque_T,
            wall_time_ns: update.stats.wall_time_ns,
            grid: update.grid,
            fem_mesh_generation_id: update.fem_mesh_generation_id.take(),
            magnetization: update.magnetization.take(),
            per_object_scalars: update.stats.per_object_scalars.clone(),
            field_materialization_states: update.stats.field_materialization_states.clone(),
            preview_field: update.preview_field.take(),
            finished: update.finished,
        },
        coupled_checkpoint: update.coupled_checkpoint.clone(),
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
        final_e_rotated_dmi: Some(update.stats.e_rotated_dmi),
        final_e_total: Some(update.stats.e_total),
        artifact_dir: artifact_dir.display().to_string(),
    }
}

pub(crate) fn initial_step_update(
    backend_plan: &BackendPlanIR,
    fem_mesh_generation_id: Option<String>,
) -> fullmag_runner::StepUpdate {
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
            coupled_checkpoint: None,
            stats,
            grid: [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
            fem_mesh_generation_id: None,
            magnetization: Some(flatten_magnetization(&fdm.initial_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            terminal_field_snapshot: false,
            finished: false,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [
                fdm.common_cells[0],
                fdm.common_cells[1],
                fdm.common_cells[2],
            ],
            fem_mesh_generation_id: None,
            magnetization: None,
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            terminal_field_snapshot: false,
            finished: false,
        },
        BackendPlanIR::Fem(fem) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [0, 0, 0],
            fem_mesh_generation_id: fem_mesh_generation_id.clone(),
            magnetization: Some(flatten_magnetization(&fem.initial_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            terminal_field_snapshot: false,
            finished: false,
        },
        BackendPlanIR::FemEigen(fem) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [0, 0, 0],
            fem_mesh_generation_id: fem_mesh_generation_id.clone(),
            magnetization: Some(flatten_magnetization(&fem.equilibrium_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            terminal_field_snapshot: false,
            finished: false,
        },
        BackendPlanIR::FemFrequencyResponse(fem) => {
            let mut stats = stats;
            stats.per_object_scalars = initial_frequency_response_progress_scalars(fem);
            fullmag_runner::StepUpdate {
                coupled_checkpoint: None,
                stats,
                grid: [0, 0, 0],
                fem_mesh_generation_id,
                magnetization: Some(flatten_magnetization(&fem.equilibrium_magnetization)),
                preview_field: None,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: false,
                terminal_field_snapshot: false,
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
    fem_mesh_generation_id: Option<String>,
    steps: &[fullmag_runner::StepStats],
    final_magnetization: &[[f64; 3]],
    step_offset: u64,
    time_offset: f64,
    finished: bool,
    checkpoint: Option<serde_json::Value>,
) -> Option<fullmag_runner::StepUpdate> {
    let stats = steps.last()?.clone();
    let stats = offset_step_stats(std::slice::from_ref(&stats), step_offset, time_offset)
        .into_iter()
        .next()
        .expect("single step should offset");

    Some(match backend_plan {
        BackendPlanIR::Fdm(fdm) => fullmag_runner::StepUpdate {
            coupled_checkpoint: checkpoint,
            stats,
            grid: [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
            fem_mesh_generation_id: None,
            magnetization: Some(flatten_magnetization(final_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [
                fdm.common_cells[0],
                fdm.common_cells[1],
                fdm.common_cells[2],
            ],
            fem_mesh_generation_id: None,
            magnetization: None,
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
        BackendPlanIR::Fem(_fem) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [0, 0, 0],
            fem_mesh_generation_id: fem_mesh_generation_id.clone(),
            magnetization: Some(flatten_magnetization(final_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
        BackendPlanIR::FemEigen(_fem) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [0, 0, 0],
            fem_mesh_generation_id: fem_mesh_generation_id.clone(),
            magnetization: Some(flatten_magnetization(final_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
        BackendPlanIR::FemFrequencyResponse(_fem) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [0, 0, 0],
            fem_mesh_generation_id,
            magnetization: Some(flatten_magnetization(final_magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
    })
}

pub(crate) fn snapshot_step_update_from_stats(
    backend_plan: &BackendPlanIR,
    fem_mesh_generation_id: Option<String>,
    stats: fullmag_runner::StepStats,
    magnetization: &[[f64; 3]],
    finished: bool,
) -> fullmag_runner::StepUpdate {
    match backend_plan {
        BackendPlanIR::Fdm(fdm) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
            fem_mesh_generation_id: None,
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
        BackendPlanIR::FdmMultilayer(fdm) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [
                fdm.common_cells[0],
                fdm.common_cells[1],
                fdm.common_cells[2],
            ],
            fem_mesh_generation_id: None,
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
        BackendPlanIR::Fem(_fem) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [0, 0, 0],
            fem_mesh_generation_id: fem_mesh_generation_id.clone(),
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
        BackendPlanIR::FemEigen(_fem) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [0, 0, 0],
            fem_mesh_generation_id: fem_mesh_generation_id.clone(),
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
        BackendPlanIR::FemFrequencyResponse(_fem) => fullmag_runner::StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [0, 0, 0],
            fem_mesh_generation_id,
            magnetization: Some(flatten_magnetization(magnetization)),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: true,
            terminal_field_snapshot: false,
            finished,
        },
    }
}

pub(crate) fn materialize_script_stages(
    mut config: ScriptExecutionConfig,
) -> Result<Vec<ResolvedScriptStage>> {
    crate::python_bridge::bind_script_execution_profiles(&mut config, &[], None)?;
    materialize_script_stages_with_output_policy(
        config,
        fullmag_runner::project_storage::configure_project_autosave,
    )
}

fn reject_direct_minimizer_llg_command(
    algorithm: fullmag_ir::RelaxationAlgorithmIR,
    command: &crate::types::SessionCommand,
) -> Result<()> {
    if algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped {
        return Ok(());
    }
    let mut rejected = Vec::new();
    if command.integrator.is_some() {
        rejected.push("integrator");
    }
    if command.fixed_timestep.is_some() {
        rejected.push("fixed_timestep");
    }
    if command.max_error.is_some() {
        rejected.push("max_error");
    }
    if command.solver_policy.is_some() {
        rejected.push("solver_policy");
    }
    if command.relax_alpha.is_some() {
        rejected.push("relax_alpha");
    }
    if !rejected.is_empty() {
        bail!(
            "relaxation algorithm '{}' is a direct minimizer and rejects LLG-only controls: {}",
            algorithm.as_str(),
            rejected.join(", ")
        );
    }
    Ok(())
}

/// Validate a state import privately, without publishing or creating a runtime.
pub(crate) fn validate_imported_magnetization(
    base_problem: &ProblemIR,
    magnetization: &[[f64; 3]],
) -> Result<()> {
    let mut candidate = base_problem.clone();
    apply_continuation_initial_state(&mut candidate, magnetization)?;
    let plan = fullmag_plan::plan(&candidate)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let expected_vectors = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => fdm.initial_magnetization.len(),
        BackendPlanIR::FdmMultilayer(fdm) => fdm
            .layers
            .iter()
            .map(|layer| layer.initial_magnetization.len())
            .sum(),
        BackendPlanIR::Fem(fem) => fem.mesh.nodes.len(),
        BackendPlanIR::FemEigen(fem) => fem.mesh.nodes.len(),
        BackendPlanIR::FemFrequencyResponse(fem) => fem.mesh.nodes.len(),
    };
    if magnetization.len() != expected_vectors {
        bail!(
            "imported magnetization has {} vectors, but the resolved global flat carrier requires {} (length mismatch)",
            magnetization.len(),
            expected_vectors
        );
    }
    Ok(())
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

    // FDM multilayer snapshots are stored as one native-layer concatenation,
    // while ProblemIR keeps one initial field per authored magnet. Split the
    // payload before the next stage is planned so idle compute_fields observes
    // the actual final state instead of rebuilding every layer from its
    // original initial texture.
    let planned_backend = fullmag_plan::plan(problem)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .backend_plan;
    if let BackendPlanIR::FdmMultilayer(plan) = planned_backend {
        if plan.layers.len() != problem.magnets.len() {
            bail!(
                "FDM multilayer continuation has {} planned layers but {} authored magnets",
                plan.layers.len(),
                problem.magnets.len()
            );
        }
        let expected_vectors = plan
            .layers
            .iter()
            .map(|layer| {
                layer
                    .native_grid
                    .iter()
                    .map(|value| *value as usize)
                    .product::<usize>()
            })
            .sum::<usize>();
        if final_magnetization.len() != expected_vectors {
            bail!(
                "FDM multilayer continuation has {} vectors, but the native layer payload requires {}",
                final_magnetization.len(),
                expected_vectors
            );
        }

        let mut assigned = std::collections::HashSet::new();
        let mut offset = 0usize;
        for layer in &plan.layers {
            let count = layer
                .native_grid
                .iter()
                .map(|value| *value as usize)
                .product::<usize>();
            let magnet_index = problem
                .magnets
                .iter()
                .position(|magnet| magnet.name == layer.magnet_name)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "FDM multilayer continuation layer '{}' has no authored magnet",
                        layer.magnet_name
                    )
                })?;
            if !assigned.insert(magnet_index) {
                bail!(
                    "FDM multilayer continuation maps layer '{}' to an authored magnet more than once",
                    layer.magnet_name
                );
            }
            problem.magnets[magnet_index].initial_magnetization =
                Some(fullmag_ir::InitialMagnetizationIR::SampledField {
                    values: final_magnetization[offset..offset + count].to_vec(),
                });
            offset += count;
        }
        return Ok(());
    }

    let has_shared_domain = problem
        .geometry_assets
        .as_ref()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
        .is_some();
    let shared_domain_node_count = problem
        .geometry_assets
        .as_ref()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
        .and_then(|asset| asset.mesh.as_ref())
        .map(|mesh| mesh.nodes.len());
    let planned_fem_node_count = if has_shared_domain {
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
    Fdm(FdmContinuationIdentity),
    /// Magnetization came from a FEM stage — node-based on a tet mesh.
    /// Carries the mesh IR needed for resampling to a different backend.
    Fem(fullmag_ir::MeshIR),
    /// The producing backend has no qualified continuation contract.
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FdmContinuationIdentity {
    origin_m: [f64; 3],
    cells: [u32; 3],
    cell_size: [f64; 3],
    active_mask: Option<Vec<bool>>,
    region_mask: Vec<u32>,
    grid_fingerprint: String,
}

fn fdm_continuation_identity(plan: &fullmag_ir::FdmPlanIR) -> Result<FdmContinuationIdentity> {
    let certificate = plan
        .grid_certificate
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("FDM continuation requires a validated grid certificate"))?;
    certificate
        .validate_against_masks(plan.active_mask.as_deref(), &plan.region_mask)
        .map_err(|error| {
            anyhow::anyhow!("FDM continuation grid certificate is invalid: {error}")
        })?;
    if certificate.origin_m != plan.origin_m
        || certificate.counts != plan.grid.cells
        || certificate.cell_m != plan.cell_size
    {
        bail!("FDM continuation grid certificate disagrees with the resolved plan grid");
    }
    Ok(FdmContinuationIdentity {
        origin_m: plan.origin_m,
        cells: plan.grid.cells,
        cell_size: plan.cell_size,
        active_mask: plan.active_mask.clone(),
        region_mask: plan.region_mask.clone(),
        grid_fingerprint: certificate.grid_fingerprint.clone(),
    })
}

pub(crate) fn continuation_source_from_backend_plan(
    backend_plan: &BackendPlanIR,
) -> ContinuationSource {
    match backend_plan {
        BackendPlanIR::Fdm(plan) => match fdm_continuation_identity(plan) {
            Ok(identity) => ContinuationSource::Fdm(identity),
            Err(error) => ContinuationSource::Unsupported(error.to_string()),
        },
        BackendPlanIR::FdmMultilayer(_) => ContinuationSource::Unsupported(
            "FDM-multilayer continuation is not supported".to_string(),
        ),
        BackendPlanIR::Fem(plan) => ContinuationSource::Fem(plan.mesh.clone()),
        BackendPlanIR::FemEigen(plan) => ContinuationSource::Fem(plan.mesh.clone()),
        BackendPlanIR::FemFrequencyResponse(plan) => ContinuationSource::Fem(plan.mesh.clone()),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FdmContinuationGrid {
    pub cells: [u32; 3],
    pub origin_m: [f64; 3],
    pub cell_size_m: [f64; 3],
    pub active_mask: Option<Vec<bool>>,
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

fn transfer_fem_to_fem_state(
    continuation_m: &[[f64; 3]],
    source_mesh: &fullmag_ir::MeshIR,
    target_mesh: &fullmag_ir::MeshIR,
) -> Result<Option<CrossBackendTransferResult>> {
    if source_mesh.nodes.len() != continuation_m.len() {
        bail!(
            "FEM → FEM continuation has {} vectors, but source FEM mesh has {} nodes",
            continuation_m.len(),
            source_mesh.nodes.len()
        );
    }
    if target_mesh.topology_fingerprint_v6() == source_mesh.topology_fingerprint_v6() {
        return Ok(None);
    }
    bail!(
        "FEM → FEM continuation requires identical mesh topology; dedicated remeshing must own interpolation"
    )
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
    if let ContinuationSource::Unsupported(reason) = source {
        bail!("unsupported continuation source: {reason}");
    }

    // Pre-plan the next stage before selecting a transfer. Cross-discretization
    // continuation must fail closed instead of being mistaken for same-backend reuse.
    let next_plan = fullmag_plan::plan(next_stage_ir)
        .map_err(|e| anyhow::anyhow!("pre-plan for cross-backend transfer failed: {}", e))?;

    match (source, &next_plan.backend_plan) {
        (ContinuationSource::Fdm(_), BackendPlanIR::Fem(_))
        | (ContinuationSource::Fdm(_), BackendPlanIR::FemEigen(_))
        | (ContinuationSource::Fdm(_), BackendPlanIR::FemFrequencyResponse(_)) => {
            bail!("FDM → FEM continuation is not supported without an explicit transfer implementation")
        }
        (ContinuationSource::Fdm(source_identity), BackendPlanIR::Fdm(target_plan)) => {
            let target_identity = fdm_continuation_identity(target_plan)?;
            let source_vectors = source_identity
                .cells
                .iter()
                .try_fold(1usize, |product, count| {
                    product.checked_mul(*count as usize)
                })
                .ok_or_else(|| anyhow::anyhow!("FDM continuation grid size overflows usize"))?;
            if continuation_m.len() != source_vectors {
                bail!(
                    "FDM → FDM continuation has {} vectors, but the source grid requires {} cells",
                    continuation_m.len(),
                    source_vectors
                );
            }
            if source_identity == &target_identity {
                return Ok(None);
            }
            let source_grid = FdmContinuationGrid {
                cells: source_identity.cells,
                origin_m: source_identity.origin_m,
                cell_size_m: source_identity.cell_size,
                active_mask: source_identity.active_mask.clone(),
            };
            let target_grid = FdmContinuationGrid {
                cells: target_identity.cells,
                origin_m: target_identity.origin_m,
                cell_size_m: target_identity.cell_size,
                active_mask: target_identity.active_mask.clone(),
            };
            transfer_fdm_field_to_grid(continuation_m, &source_grid, &target_grid).map(Some)
        }
        (ContinuationSource::Fdm(_), BackendPlanIR::FdmMultilayer(_)) => {
            bail!("FDM → FDM-multilayer continuation is not supported")
        }
        (ContinuationSource::Fem(fem_mesh_ir), BackendPlanIR::Fem(fem)) => {
            transfer_fem_to_fem_state(continuation_m, fem_mesh_ir, &fem.mesh)
        }
        (ContinuationSource::Fem(fem_mesh_ir), BackendPlanIR::FemEigen(fem)) => {
            transfer_fem_to_fem_state(continuation_m, fem_mesh_ir, &fem.mesh)
        }
        (ContinuationSource::Fem(fem_mesh_ir), BackendPlanIR::FemFrequencyResponse(fem)) => {
            transfer_fem_to_fem_state(continuation_m, fem_mesh_ir, &fem.mesh)
        }
        (ContinuationSource::Fem(fem_mesh_ir), BackendPlanIR::Fdm(fdm_plan)) => {
            // Extract FDM grid parameters.
            let grid_cells = fdm_plan.grid.cells;
            let cell_size = fdm_plan.cell_size;
            let grid_dims = [
                grid_cells[0] as usize,
                grid_cells[1] as usize,
                grid_cells[2] as usize,
            ];

            let grid_origin = fdm_plan.origin_m;

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
        (ContinuationSource::Fem(_), BackendPlanIR::FdmMultilayer(_)) => {
            // Multi-layer FDM continuation from FEM is not yet supported.
            bail!("FEM → FDM-multilayer cross-backend continuation is not yet supported");
        }
        (ContinuationSource::Unsupported(_), _) => unreachable!(),
    }
}

fn transfer_fdm_field_to_grid(
    continuation_m: &[[f64; 3]],
    source: &FdmContinuationGrid,
    target: &FdmContinuationGrid,
) -> Result<CrossBackendTransferResult> {
    let source_count = source
        .cells
        .iter()
        .try_fold(1usize, |count, cells| count.checked_mul(*cells as usize))
        .ok_or_else(|| anyhow::anyhow!("source FDM grid cell count overflows usize"))?;
    if continuation_m.len() != source_count {
        bail!(
            "FDM continuation has {} vectors, but source grid requires {}",
            continuation_m.len(),
            source_count
        );
    }
    if source
        .active_mask
        .as_ref()
        .is_some_and(|mask| mask.len() != source_count)
    {
        bail!("source FDM continuation active mask length does not match its grid");
    }
    let target_count = target
        .cells
        .iter()
        .try_fold(1usize, |count, cells| count.checked_mul(*cells as usize))
        .ok_or_else(|| anyhow::anyhow!("target FDM grid cell count overflows usize"))?;
    if target
        .active_mask
        .as_ref()
        .is_some_and(|mask| mask.len() != target_count)
    {
        bail!("target FDM continuation active mask length does not match its grid");
    }
    for (axis, cell) in source.cell_size_m.iter().enumerate() {
        if !cell.is_finite() || *cell <= 0.0 {
            bail!("source FDM continuation cell size axis {axis} is not finite and positive");
        }
    }
    for (axis, cell) in target.cell_size_m.iter().enumerate() {
        if !cell.is_finite() || *cell <= 0.0 {
            bail!("target FDM continuation cell size axis {axis} is not finite and positive");
        }
    }
    if source.cell_size_m != target.cell_size_m {
        bail!(
            "FDM → FDM continuation requires identical grid identity or an aligned compatible union grid with identical cell size"
        );
    }
    for axis in 0..3 {
        let cell_offset =
            (target.origin_m[axis] - source.origin_m[axis]) / source.cell_size_m[axis];
        if !cell_offset.is_finite() || (cell_offset - cell_offset.round()).abs() > 1.0e-9 {
            bail!(
                "FDM → FDM continuation requires identical grid identity or an aligned compatible union grid"
            );
        }
    }

    let mut values = vec![[0.0; 3]; target_count];
    let mut n_located = 0usize;
    let mut n_outside = 0usize;
    for z in 0..target.cells[2] as usize {
        for y in 0..target.cells[1] as usize {
            for x in 0..target.cells[0] as usize {
                let target_index =
                    x + target.cells[0] as usize * (y + target.cells[1] as usize * z);
                if target
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask[target_index])
                {
                    n_outside += 1;
                    continue;
                }

                let target_center = [
                    target.origin_m[0] + (x as f64 + 0.5) * target.cell_size_m[0],
                    target.origin_m[1] + (y as f64 + 0.5) * target.cell_size_m[1],
                    target.origin_m[2] + (z as f64 + 0.5) * target.cell_size_m[2],
                ];
                let mut source_index = [0usize; 3];
                let mut outside = false;
                for axis in 0..3 {
                    let coordinate = (target_center[axis] - source.origin_m[axis])
                        / source.cell_size_m[axis]
                        - 0.5;
                    let nearest = coordinate.round();
                    if nearest < 0.0 || nearest >= source.cells[axis] as f64 {
                        outside = true;
                        break;
                    }
                    source_index[axis] = nearest as usize;
                }
                if outside {
                    n_outside += 1;
                    continue;
                }
                let source_flat = source_index[0]
                    + source.cells[0] as usize
                        * (source_index[1] + source.cells[1] as usize * source_index[2]);
                if source
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask[source_flat])
                {
                    n_outside += 1;
                    continue;
                }
                values[target_index] = continuation_m[source_flat];
                n_located += 1;
            }
        }
    }
    let target_active_count = target.active_mask.as_ref().map_or(target_count, |mask| {
        mask.iter().filter(|active| **active).count()
    });
    if n_located != target_active_count {
        bail!(
            "FDM continuation cannot map {} active target cells from the source grid (located {}, outside {})",
            target_active_count,
            n_located,
            n_outside
        );
    }
    normalize_unit_vectors(&mut values, 1e-12);
    Ok(CrossBackendTransferResult {
        values,
        n_located,
        n_outside,
        n_total: target_count,
        label: "FDM→FDM",
        unit_label: "cells",
    })
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
    let problem = serde_json::from_str(&content)?;
    fullmag_application::bind_declared_execution(&problem, vec![]).map_err(anyhow::Error::msg)
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

fn resolve_interactive_llg_policy(
    dynamics: &mut fullmag_ir::DynamicsIR,
    command: &crate::types::SessionCommand,
) -> Result<()> {
    let fullmag_ir::DynamicsIR::Llg {
        integrator,
        fixed_timestep,
        adaptive_timestep,
        ..
    } = dynamics;
    if let Some(policy) = command.solver_policy.as_ref() {
        if command.integrator.is_some()
            || command.fixed_timestep.is_some()
            || command.max_error.is_some()
        {
            bail!("canonical solver_policy cannot be mixed with legacy integrator/fixed_timestep/max_error controls");
        }
        match policy {
            crate::types::SolverPolicyRequest::Fixed {
                integrator: requested_integrator,
                fix_dt,
            } => {
                if let Some(requested_integrator) = requested_integrator {
                    *integrator = requested_integrator.as_str().to_string();
                }
                *fixed_timestep = Some(*fix_dt);
                *adaptive_timestep = None;
            }
            crate::types::SolverPolicyRequest::AdaptiveMaxError {
                integrator: requested_integrator,
                dt_initial,
                dt_min,
                dt_max,
                max_err,
            } => {
                *integrator = requested_integrator.as_str().to_string();
                *fixed_timestep = None;
                *adaptive_timestep = Some(fullmag_ir::AdaptiveTimeStepIR {
                    tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::MaxError,
                    atol: *max_err,
                    rtol: 0.0,
                    dt_initial: *dt_initial,
                    dt_min: *dt_min,
                    dt_max: Some(*dt_max),
                    safety: 0.9,
                    growth_limit: 2.0,
                    shrink_limit: 0.2,
                    max_spin_rotation: None,
                    norm_tolerance: None,
                });
            }
            crate::types::SolverPolicyRequest::AdaptiveAdvanced {
                integrator: requested_integrator,
                dt_initial,
                dt_min,
                dt_max,
                atol,
                rtol,
                safety,
                growth_limit,
                shrink_limit,
                max_spin_rotation,
                norm_tolerance,
            } => {
                *integrator = requested_integrator.as_str().to_string();
                *fixed_timestep = None;
                *adaptive_timestep = Some(fullmag_ir::AdaptiveTimeStepIR {
                    tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::Advanced,
                    atol: *atol,
                    rtol: *rtol,
                    dt_initial: *dt_initial,
                    dt_min: *dt_min,
                    dt_max: Some(*dt_max),
                    safety: *safety,
                    growth_limit: *growth_limit,
                    shrink_limit: *shrink_limit,
                    max_spin_rotation: *max_spin_rotation,
                    norm_tolerance: *norm_tolerance,
                });
            }
        }
        return Ok(());
    }
    if let Some(value) = command.integrator.as_ref() {
        *integrator = serde_json::from_value(serde_json::json!(value))
            .with_context(|| format!("invalid integrator '{value}'"))?;
    }
    if command.max_error.is_some() {
        bail!("legacy max_error command cannot preserve the required dt_max bound; use the canonical adaptive solver command with dt_min, dt_max, and max_err");
    }
    if let Some(dt) = command.fixed_timestep {
        *fixed_timestep = Some(dt);
        *adaptive_timestep = None;
    } else if matches!(command.integrator.as_deref(), Some("rk23" | "rk45")) {
        let policy = adaptive_timestep.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "selecting adaptive integrator '{}' requires a complete adaptive policy with dt_min and dt_max",
                integrator
            )
        })?;
        if policy.dt_max.is_none() {
            bail!(
                "selecting adaptive integrator '{}' requires a complete adaptive policy with dt_min and dt_max",
                integrator
            );
        }
        *fixed_timestep = None;
    }
    if fixed_timestep.is_some() == adaptive_timestep.is_some() {
        bail!("LLG solver requires exactly one of fixed_timestep or adaptive_timestep");
    }
    Ok(())
}

pub(crate) fn build_interactive_command_stage(
    base_problem: &ProblemIR,
    command: &crate::types::SessionCommand,
) -> Result<Option<ResolvedScriptStage>> {
    match command.kind.as_str() {
        "close" => Ok(None),
        "solve" if !matches!(&base_problem.study, fullmag_ir::StudyIR::Relaxation { .. }) => {
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
            let mut dynamics = required_study_dynamics(&ir.study, "interactive run command")?;
            resolve_interactive_llg_policy(&mut dynamics, command)?;
            let sampling = ir.study.sampling().clone();
            ir.problem_meta.entrypoint_kind = "interactive_run".to_string();
            ir.study = fullmag_ir::StudyIR::TimeEvolution { dynamics, sampling };

            Ok(Some(ResolvedScriptStage::solver(
                ir,
                until_seconds,
                "interactive_run",
            )))
        }
        "relax" | "solve" => {
            let mut ir = base_problem.clone();
            let preserve_authored = command.kind == "solve";
            let algorithm = match command.relax_algorithm.as_deref() {
                Some(value) => serde_json::from_value(serde_json::json!(value))
                    .context("invalid relax_algorithm in SessionCommand")?,
                None if preserve_authored => match &ir.study {
                    fullmag_ir::StudyIR::Relaxation { algorithm, .. } => *algorithm,
                    _ => unreachable!("non-relaxation solve is handled above"),
                },
                None => fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            };
            reject_direct_minimizer_llg_command(algorithm, command)?;
            let mut dynamics = if algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped {
                Some(required_study_dynamics(
                    &ir.study,
                    "interactive LLG relaxation command",
                )?)
            } else {
                None
            };
            if let Some(dynamics) = dynamics.as_mut() {
                resolve_interactive_llg_policy(dynamics, command)?;
            }
            let sampling = ir.study.sampling().clone();
            // Compute solves the authored study. Missing command fields are
            // not requests to reset its enabled criteria or execution budget.
            let mut stop = match &ir.study {
                fullmag_ir::StudyIR::Relaxation { stop, .. } if preserve_authored => stop.clone(),
                _ => fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-4),
                    energy_tolerance_j: None,
                    max_steps: Some(50_000),
                    max_relaxation_time_s: None,
                },
            };
            if let Some(tolerance) = command.torque_tolerance {
                stop.torque_tolerance_apm = Some(tolerance);
            }
            if let Some(tolerance) = command.energy_tolerance {
                stop.energy_tolerance_j = Some(tolerance);
            }
            if let Some(max_steps) = command.max_steps {
                stop.max_steps = Some(max_steps);
            }

            // Default relax_alpha = 1.0 for optimal overdamped convergence
            // (user can still override to any value via command.relax_alpha)
            if algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped {
                let effective_alpha = command
                    .relax_alpha
                    .or_else(|| (!preserve_authored).then_some(1.0));
                if let Some(effective_alpha) = effective_alpha {
                    for mat in &mut ir.materials {
                        mat.damping = effective_alpha;
                    }
                }
            }

            ir.problem_meta.entrypoint_kind = "interactive_relax".to_string();
            ir.study = fullmag_ir::StudyIR::Relaxation {
                algorithm,
                dynamics: dynamics.clone(),
                stop: stop.clone(),
                sampling,
            };

            let until_seconds = resolve_relaxation_until_seconds(&dynamics, &stop);

            Ok(Some(ResolvedScriptStage::solver(
                ir,
                until_seconds,
                "interactive_relax",
            )))
        }
        other => anyhow::bail!("unsupported interactive command kind '{other}'"),
    }
}

pub(crate) fn problem_with_frozen_spins_runtime_plan_binding(
    base_problem: &ProblemIR,
    command: &crate::types::SessionCommand,
    last_applied_scene_revision: Option<u64>,
) -> Result<Option<(ProblemIR, u64)>> {
    let Some(binding) = command.frozen_spins_runtime_plan_binding.as_ref() else {
        return Ok(None);
    };
    if !matches!(command.kind.as_str(), "run" | "relax" | "solve") {
        anyhow::bail!(
            "frozen spins runtime plan binding is not valid for '{}' command",
            command.kind
        );
    }
    if binding.schema_version != fullmag_ir::FROZEN_SPINS_RUNTIME_PLAN_BINDING_SCHEMA_VERSION {
        anyhow::bail!(
            "unsupported frozen spins runtime plan binding schema '{}'",
            binding.schema_version
        );
    }
    if binding.launch_command_id != command.command_id {
        anyhow::bail!(
            "frozen spins runtime plan binding command mismatch: expected {}, got {}",
            command.command_id,
            binding.launch_command_id
        );
    }
    if binding.source_state_revision == Some(0) {
        anyhow::bail!("frozen spins runtime plan binding source state revision must be positive");
    }
    let requires_source_state_revision = binding
        .magnetization_constraints
        .iter()
        .map(fullmag_ir::MagnetizationConstraintIR::frozen_spins)
        .any(|constraint| {
            constraint.enabled
                && matches!(
                    constraint.reference,
                    fullmag_ir::FrozenReferencePolicyIR::CaptureCurrentAtActivation {}
                )
        });
    if requires_source_state_revision && binding.source_state_revision.is_none() {
        anyhow::bail!(
            "frozen spins runtime plan binding is missing source state revision for capture_current_at_activation"
        );
    }
    let bound_precondition_revision = command
        .precondition
        .as_ref()
        .and_then(|precondition| precondition.scene_revision);
    if bound_precondition_revision != Some(binding.source_scene_revision) {
        anyhow::bail!(
            "frozen spins runtime plan binding revision mismatch: payload={}, precondition={}",
            binding.source_scene_revision,
            bound_precondition_revision
                .map(|revision| revision.to_string())
                .unwrap_or_else(|| "missing".to_string())
        );
    }
    if last_applied_scene_revision.is_some_and(|revision| binding.source_scene_revision < revision)
    {
        anyhow::bail!(
            "stale frozen spins runtime plan binding: revision {} is older than applied revision {}",
            binding.source_scene_revision,
            last_applied_scene_revision.unwrap_or_default()
        );
    }
    if last_applied_scene_revision == Some(binding.source_scene_revision) {
        if base_problem.selections != binding.selection_definitions
            || base_problem.magnetization_constraints != binding.magnetization_constraints
        {
            anyhow::bail!(
                "frozen spins runtime plan binding replay changed constraints for scene revision {}",
                binding.source_scene_revision
            );
        }
        let applied_source_state_revision = base_problem
            .problem_meta
            .runtime_metadata
            .get(fullmag_ir::FROZEN_SPINS_SOURCE_STATE_REVISION_METADATA_KEY)
            .and_then(serde_json::Value::as_u64);
        if applied_source_state_revision == binding.source_state_revision {
            return Ok(None);
        }
    }

    let mut candidate = base_problem.clone();
    candidate.selections = binding.selection_definitions.clone();
    candidate.magnetization_constraints = binding.magnetization_constraints.clone();
    if let Some(source_state_revision) = binding.source_state_revision {
        candidate.problem_meta.runtime_metadata.insert(
            fullmag_ir::FROZEN_SPINS_SOURCE_STATE_REVISION_METADATA_KEY.to_string(),
            serde_json::json!(source_state_revision),
        );
    } else {
        candidate
            .problem_meta
            .runtime_metadata
            .remove(fullmag_ir::FROZEN_SPINS_SOURCE_STATE_REVISION_METADATA_KEY);
    }
    Ok(Some((candidate, binding.source_scene_revision)))
}

pub(crate) fn bind_frozen_spins_replan_to_paused_command(
    mut resumed: crate::types::SessionCommand,
    application: &crate::types::SessionCommand,
) -> Result<crate::types::SessionCommand> {
    if application.kind != "apply_frozen_spins" {
        anyhow::bail!(
            "expected apply_frozen_spins command, got '{}'",
            application.kind
        );
    }
    if application.frozen_spins_runtime_plan_binding.is_none() {
        anyhow::bail!(
            "apply_frozen_spins command '{}' is missing its runtime plan binding",
            application.command_id
        );
    }
    if !matches!(resumed.kind.as_str(), "run" | "relax" | "solve") {
        anyhow::bail!(
            "cannot apply frozen spins replan to non-solver command '{}'",
            resumed.kind
        );
    }

    // Preserve the paused solver command's remaining time/step budget and solver
    // policy. The application command supplies only the new identity, revision
    // precondition, and canonical Frozen Spins payload that must be consumed at
    // this accepted-step boundary.
    resumed.command_id = application.command_id.clone();
    resumed.created_at_unix_ms = application.created_at_unix_ms;
    resumed.target = application.target.clone();
    resumed.reason = application.reason.clone();
    resumed.precondition = application.precondition.clone();
    resumed.client_intent_id = application.client_intent_id.clone();
    resumed.requested_at_unix_ms = application.requested_at_unix_ms;
    resumed.frozen_spins_runtime_plan_binding =
        application.frozen_spins_runtime_plan_binding.clone();
    Ok(resumed)
}

pub(crate) fn build_resumable_interactive_command(
    command: &crate::types::SessionCommand,
    stage_result: &fullmag_runner::RunResult,
    elapsed_seconds: f64,
) -> Option<crate::types::SessionCommand> {
    match command.kind.as_str() {
        "run" => {
            let requested_until_seconds = command.until_seconds?;
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
            solver_policy: None,
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
            frozen_spins_runtime_plan_binding: None,
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
            solver_policy: None,
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
            frozen_spins_runtime_plan_binding: None,
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

    fn solver_command(kind: &str) -> crate::types::SessionCommand {
        serde_json::from_value(json!({
            "command_id": format!("cmd-{kind}"),
            "kind": kind,
            "created_at_unix_ms": 0,
            "until_seconds": 1e-12
        }))
        .expect("minimal solver command")
    }

    #[test]
    fn antenna_field_solve_pipeline_uses_the_dedicated_planner_lane() {
        let mut problem = sample_problem_ir();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fdm;
        let payload = BTreeMap::from([
            ("stage_id".to_string(), json!("solve_antenna")),
            ("port_mode_ids".to_string(), json!(["drive"])),
        ]);
        let config = ScriptExecutionConfig {
            ir: problem,
            shared_geometry_assets: None,
            default_until_seconds: None,
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Primitive {
                    id: "solve_antenna".to_string(),
                    label: "Antenna field solve".to_string(),
                    enabled: true,
                    notes: None,
                    source: None,
                    stage_kind: "antenna_field_solve".to_string(),
                    payload,
                }],
            }),
            stages: vec![],
        };
        let error = materialize_script_stages(config)
            .expect_err("FDM antenna precomputation must fail closed");
        let message = format!("{error:#}");
        assert!(message
            .contains("antenna field precomputation requires requested_backend='fem'"));
        assert!(!message.contains("not yet executable by the runtime"));
    }

    fn frozen_spins_binding_command(source_scene_revision: u64) -> crate::types::SessionCommand {
        serde_json::from_value(json!({
            "command_id": "cmd-run-frozen",
            "kind": "run",
            "created_at_unix_ms": 0,
            "until_seconds": 1e-12,
            "precondition": {"scene_revision": source_scene_revision},
            "frozen_spins_runtime_plan_binding": {
                "schema_version": fullmag_ir::FROZEN_SPINS_RUNTIME_PLAN_BINDING_SCHEMA_VERSION,
                "launch_command_id": "cmd-run-frozen",
                "source_scene_revision": source_scene_revision,
                "source_state_revision": 23,
                "selection_definitions": [{
                    "schema_version": "selection_expr.v1",
                    "id": "left-side",
                    "expression": {"kind": "in_object", "object_id": "track"}
                }],
                "magnetization_constraints": [{
                    "kind": "frozen_spins",
                    "schema_version": "frozen_spins.v1",
                    "id": "pin-left",
                    "name": "Pin left",
                    "enabled": true,
                    "selector": {"kind": "ref", "selection_id": "left-side"},
                    "reference": {"kind": "capture_current_at_activation"},
                    "membership": {"kind": "static"},
                    "activation": {"kind": "all_stages"},
                    "empty_selection": "error",
                    "inactive_selection": "warn_and_intersect"
                }]
            }
        }))
        .expect("frozen spins binding command")
    }

    #[test]
    fn frozen_spins_binding_replaces_canonical_ir_at_next_plan_boundary() {
        let mut base = fdm_target_problem_ir();
        base.magnets[0].object_id = Some("track".to_string());
        let command = frozen_spins_binding_command(17);

        let (updated, revision) =
            problem_with_frozen_spins_runtime_plan_binding(&base, &command, None)
                .expect("valid binding")
                .expect("new revision must update the problem");

        assert_eq!(revision, 17);
        assert_eq!(updated.selections.len(), 1);
        assert_eq!(updated.magnetization_constraints.len(), 1);
        assert_eq!(
            updated.magnetization_constraints[0].frozen_spins().id,
            "pin-left"
        );
        assert_eq!(
            updated.problem_meta.runtime_metadata
                [fullmag_ir::FROZEN_SPINS_SOURCE_STATE_REVISION_METADATA_KEY],
            serde_json::json!(23)
        );
        let execution_plan = fullmag_plan::plan(&updated)
            .expect("interactive FDM problem with Frozen Spins should plan");
        let fullmag_ir::BackendPlanIR::Fdm(fdm_plan) = execution_plan.backend_plan else {
            panic!("sample interactive problem must produce an FDM execution plan");
        };
        let frozen = fdm_plan
            .frozen_spins
            .expect("Frozen Spins binding must survive into the FDM execution plan");
        assert_eq!(frozen.source_state_revision, Some(23));
        assert_eq!(frozen.certificate.source_state_revision, Some(23));
        assert!(base.magnetization_constraints.is_empty());
    }

    #[test]
    fn fem_interactive_solve_preserves_frozen_spins_binding_into_execution_plan() {
        let mut base = fem_target_problem_ir(small_fem_cube_mesh());
        base.magnets[0].object_id = Some("track".to_string());
        let mut command = frozen_spins_binding_command(17);
        command.kind = "solve".to_string();

        let (bound, revision) =
            problem_with_frozen_spins_runtime_plan_binding(&base, &command, None)
                .expect("valid FEM binding")
                .expect("new revision must update the FEM problem");
        let stage = build_interactive_command_stage(&bound, &command)
            .expect("interactive FEM solve should build")
            .expect("solve command should materialize a FEM stage");
        let execution_plan = fullmag_plan::plan(&stage.ir)
            .expect("interactive FEM stage with Frozen Spins should plan");

        let fullmag_ir::BackendPlanIR::Fem(fem_plan) = execution_plan.backend_plan else {
            panic!("interactive FEM solve must produce a FEM execution plan");
        };
        let frozen = fem_plan
            .frozen_spins
            .expect("Frozen Spins binding must survive into the FEM execution plan");
        assert_eq!(revision, 17);
        assert_eq!(frozen.certificate.constraint_ids, vec!["pin-left"]);
        assert_eq!(frozen.source_state_revision, Some(23));
        assert_eq!(frozen.certificate.source_state_revision, Some(23));
        assert!(frozen.certificate.frozen_dof_count > 0);
    }

    #[test]
    fn frozen_spins_binding_rebinds_same_scene_to_new_source_state_revision() {
        let mut base = fdm_target_problem_ir();
        base.magnets[0].object_id = Some("track".to_string());
        let command = frozen_spins_binding_command(17);
        let (first, _) = problem_with_frozen_spins_runtime_plan_binding(&base, &command, None)
            .expect("first binding must be valid")
            .expect("first binding must update the problem");
        assert!(
            problem_with_frozen_spins_runtime_plan_binding(&first, &command, Some(17))
                .expect("exact replay must be valid")
                .is_none(),
            "an exact scene/state replay must be idempotent"
        );

        let mut refreshed = command;
        refreshed
            .frozen_spins_runtime_plan_binding
            .as_mut()
            .expect("binding")
            .source_state_revision = Some(24);
        let (rebound, revision) =
            problem_with_frozen_spins_runtime_plan_binding(&first, &refreshed, Some(17))
                .expect("new source-state revision must be accepted")
                .expect("new source-state revision must force a rebind");
        assert_eq!(revision, 17);
        assert_eq!(
            rebound.problem_meta.runtime_metadata
                [fullmag_ir::FROZEN_SPINS_SOURCE_STATE_REVISION_METADATA_KEY],
            serde_json::json!(24)
        );
        let execution_plan = fullmag_plan::plan(&rebound).expect("rebound FDM problem should plan");
        let fullmag_ir::BackendPlanIR::Fdm(fdm_plan) = execution_plan.backend_plan else {
            panic!("rebound problem must remain FDM");
        };
        assert_eq!(
            fdm_plan
                .frozen_spins
                .expect("rebound plan must retain Frozen Spins")
                .source_state_revision,
            Some(24)
        );
    }

    #[test]
    fn frozen_spins_binding_is_fail_closed_for_mismatch_stale_and_mutating_replay() {
        let base = sample_problem_ir();
        let mut mismatched = frozen_spins_binding_command(17);
        mismatched
            .frozen_spins_runtime_plan_binding
            .as_mut()
            .expect("binding")
            .launch_command_id = "different-command".to_string();
        assert!(
            problem_with_frozen_spins_runtime_plan_binding(&base, &mismatched, None)
                .expect_err("command mismatch must fail")
                .to_string()
                .contains("command mismatch")
        );

        let stale = frozen_spins_binding_command(16);
        assert!(
            problem_with_frozen_spins_runtime_plan_binding(&base, &stale, Some(17))
                .expect_err("stale revision must fail")
                .to_string()
                .contains("stale")
        );

        let replay = frozen_spins_binding_command(17);
        assert!(
            problem_with_frozen_spins_runtime_plan_binding(&base, &replay, Some(17))
                .expect_err("same revision may not change constraints")
                .to_string()
                .contains("replay changed constraints")
        );

        let mut missing_source_revision = frozen_spins_binding_command(18);
        missing_source_revision
            .frozen_spins_runtime_plan_binding
            .as_mut()
            .expect("binding")
            .source_state_revision = None;
        assert!(problem_with_frozen_spins_runtime_plan_binding(
            &base,
            &missing_source_revision,
            None
        )
        .expect_err("capture-current binding without source revision must fail")
        .to_string()
        .contains("missing source state revision"));
    }

    #[test]
    fn frozen_spins_hot_apply_preserves_paused_solver_budget_and_rebinds_identity() {
        let mut paused = solver_command("relax");
        paused.command_id = "cmd-original-relax".to_string();
        paused.max_steps = Some(137);
        paused.torque_tolerance = Some(1.25e-4);
        paused.relax_alpha = Some(0.75);

        let mut application = frozen_spins_binding_command(23);
        application.kind = "apply_frozen_spins".to_string();
        application.command_id = "cmd-hot-apply".to_string();
        application.created_at_unix_ms = 1234;
        application.reason = Some("frozen_spins_authoring_commit".to_string());
        application
            .frozen_spins_runtime_plan_binding
            .as_mut()
            .expect("binding")
            .launch_command_id = application.command_id.clone();

        let resumed = bind_frozen_spins_replan_to_paused_command(paused, &application)
            .expect("valid hot apply command");

        assert_eq!(resumed.kind, "relax");
        assert_eq!(resumed.command_id, "cmd-hot-apply");
        assert_eq!(resumed.max_steps, Some(137));
        assert_eq!(resumed.torque_tolerance, Some(1.25e-4));
        assert_eq!(resumed.relax_alpha, Some(0.75));
        assert_eq!(
            resumed
                .frozen_spins_runtime_plan_binding
                .as_ref()
                .expect("binding")
                .source_scene_revision,
            23
        );
        assert_eq!(
            resumed.reason.as_deref(),
            Some("frozen_spins_authoring_commit")
        );
    }

    #[test]
    fn interactive_fixed_clears_adaptive_and_legacy_max_error_rejects() {
        let mut dynamics = required_study_dynamics(
            &sample_problem_ir_with_adaptive_relax_dt(1e-15).study,
            "test",
        )
        .unwrap();
        let mut fixed = solver_command("run");
        fixed.fixed_timestep = Some(2e-15);
        resolve_interactive_llg_policy(&mut dynamics, &fixed).unwrap();
        assert!(matches!(
            dynamics,
            fullmag_ir::DynamicsIR::Llg {
                fixed_timestep: Some(_),
                adaptive_timestep: None,
                ..
            }
        ));

        let mut legacy = solver_command("run");
        legacy.max_error = Some(1e-6);
        assert!(resolve_interactive_llg_policy(&mut dynamics, &legacy)
            .unwrap_err()
            .to_string()
            .contains("legacy max_error"));
    }

    #[test]
    fn interactive_adaptive_integrator_over_fixed_requires_complete_policy() {
        let mut dynamics = required_study_dynamics(&sample_problem_ir().study, "test").unwrap();
        let mut command = solver_command("run");
        command.integrator = Some("rk45".into());
        assert!(resolve_interactive_llg_policy(&mut dynamics, &command)
            .unwrap_err()
            .to_string()
            .contains("complete adaptive policy"));
    }

    #[test]
    fn interactive_command_resolves_canonical_adaptive_solver_policy() {
        let command: crate::types::SessionCommand = serde_json::from_value(json!({
            "command_id": "cmd-canonical-adaptive",
            "kind": "run",
            "created_at_unix_ms": 0,
            "until_seconds": 1e-12,
            "solver_policy": {
                "kind": "adaptive_max_error",
                "integrator": "rk45",
                "dt_min": 1e-16,
                "dt_max": 1e-13,
                "max_err": 1e-6
            }
        }))
        .expect("canonical solver policy command should deserialize");

        let stage = build_interactive_command_stage(&sample_problem_ir(), &command)
            .expect("canonical adaptive command should resolve")
            .expect("run command should materialize a stage");
        let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = stage.ir.study else {
            panic!("run command should materialize time evolution");
        };
        let fullmag_ir::DynamicsIR::Llg {
            integrator,
            fixed_timestep,
            adaptive_timestep,
            ..
        } = dynamics;
        let adaptive = adaptive_timestep.expect("canonical adaptive policy must reach execution");
        assert_eq!(integrator, "rk45");
        assert!(fixed_timestep.is_none());
        assert_eq!(adaptive.dt_initial, None);
        assert_eq!(adaptive.dt_min, 1e-16);
        assert_eq!(adaptive.dt_max, Some(1e-13));
        assert_eq!(adaptive.atol, 1e-6);
        assert_eq!(adaptive.rtol, 0.0);
    }

    #[test]
    fn direct_minimizer_rejects_canonical_solver_policy() {
        let command: crate::types::SessionCommand = serde_json::from_value(json!({
            "command_id": "cmd-direct-minimizer-policy",
            "kind": "relax",
            "created_at_unix_ms": 0,
            "relax_algorithm": "projected_gradient_bb",
            "solver_policy": {
                "kind": "fixed",
                "integrator": "heun",
                "fix_dt": 1e-15
            }
        }))
        .expect("canonical fixed policy should deserialize");
        let error = build_interactive_command_stage(&sample_problem_ir(), &command)
            .expect_err("direct minimizer must reject canonical LLG policy");
        assert!(error.to_string().contains("solver_policy"));
    }

    fn primitive_node(id: &str, stage_kind: &str, payload: Value) -> StudyPipelineNode {
        serde_json::from_value(json!({
            "id": id,
            "label": id,
            "enabled": true,
            "source": "ui_authored",
            "node_kind": "primitive",
            "stage_kind": stage_kind,
            "payload": payload
        }))
        .expect("primitive pipeline node")
    }

    fn sample_regional_field_drive(id: &str) -> RegionalFieldDriveIR {
        serde_json::from_value(json!({
            "id": id,
            "name": id,
            "kind": "regional",
            "enabled": true,
            "target": {"kind": "global"},
            "amplitude_B_T": 0.001,
            "direction": [0.0, 1.0, 0.0],
            "spatial_profile": {"kind": "uniform"},
            "waveform": {"kind": "constant", "amplitude": 1.0},
            "time_origin": "stage_local",
            "activation": {"kind": "all_time_evolution"}
        }))
        .expect("regional field drive")
    }

    fn minimal_frequency_response_plan() -> fullmag_ir::FemFrequencyResponsePlanIR {
        fullmag_ir::FemFrequencyResponsePlanIR {
            mesh_name: "unit".to_string(),
            mesh_source: None,
            mesh: fullmag_ir::MeshIR {
                mesh_name: "unit".to_string(),
                nodes: vec![[0.0, 0.0, 0.0]],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(Vec::new()),
                element_markers: Vec::new(),
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
                boundary_markers: Vec::new(),
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            mesh_build_report: None,
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
        let backend_plan = BackendPlanIR::FemFrequencyResponse(plan);
        let asset = fullmag_runner::StageFemMeshAsset::build_from_backend_plan(&backend_plan)
            .expect("frequency-response FEM asset");
        let update = initial_step_update(
            &backend_plan,
            Some(asset.identity.generation_id().to_string()),
        );

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
    fn imported_magnetization_validation_rejects_wrong_size_without_mutating_problem() {
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let before = serde_json::to_value(&problem).expect("problem should serialize");
        let plan = fullmag_plan::plan(&problem).expect("bootstrap plan should resolve");
        let BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
            panic!("bootstrap import fixture requires FDM");
        };
        let expected = fdm.initial_magnetization.len();
        assert!(expected > 1);
        for count in [0, expected - 1, expected + 1] {
            let error = validate_imported_magnetization(&problem, &vec![[1.0, 0.0, 0.0]; count])
                .expect_err("mismatched carrier size must be rejected");
            assert!(error.to_string().contains("length mismatch"));
            assert_eq!(serde_json::to_value(&problem).unwrap(), before);
        }
        validate_imported_magnetization(&problem, &vec![[0.0, 1.0, 0.0]; expected])
            .expect("matching sampled state should be accepted privately");
        assert_eq!(serde_json::to_value(&problem).unwrap(), before);
    }

    #[test]
    fn imported_fem_state_requires_global_nodes_not_local_initializer() {
        let mut mesh: fullmag_ir::MeshIR = serde_json::from_str(include_str!(
            "../tests/fixtures/import_shared_domain.mesh.json"
        ))
        .expect("shared-domain fixture should parse");
        mesh.element_markers[1] = 0;
        let problem = fem_target_problem_ir(mesh);
        let before = serde_json::to_value(&problem).unwrap();
        let mut local = problem.clone();
        apply_continuation_initial_state(&mut local, &vec![[1.0, 0.0, 0.0]; 4]).unwrap();
        fullmag_plan::plan(&local).expect("local magnetic initializer is legal for authoring");
        let error = validate_imported_magnetization(&problem, &vec![[1.0, 0.0, 0.0]; 4])
            .expect_err("local initializer is not a global runtime carrier");
        assert!(error.to_string().contains("global flat carrier"));
        validate_imported_magnetization(&problem, &vec![[0.0, 1.0, 0.0]; 5])
            .expect("global carrier should be accepted");
        assert_eq!(serde_json::to_value(&problem).unwrap(), before);
    }

    #[test]
    fn imported_fem_state_supports_multi_magnet_source_only_mesh() {
        let mesh = serde_json::from_str(include_str!(
            "../tests/fixtures/import_shared_domain.mesh.json"
        ))
        .expect("shared-domain fixture should parse");
        let mut problem = fem_target_problem_ir(mesh);
        problem.geometry.entries.push(fullmag_ir::GeometryEntryIR::Box {
            name: "ring".to_string(),
            size: [1.0, 1.0, 1.0],
        });
        problem.regions.push(fullmag_ir::RegionIR {
            name: "ring".to_string(),
            geometry: "ring".to_string(),
        });
        let mut ring = problem.magnets[0].clone();
        ring.object_id = Some("ring".to_string());
        ring.name = "ring".to_string();
        ring.region = "ring".to_string();
        problem.magnets.push(ring);
        let asset = problem.geometry_assets.as_mut().unwrap()
            .fem_domain_mesh_asset.as_mut().unwrap();
        asset.region_markers.push(fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "ring".to_string(),
            marker: 2,
        });
        asset.mesh = None;
        asset.mesh_source = Some(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/import_shared_domain.mesh.json")
                .display().to_string(),
        );
        let before = serde_json::to_value(&problem).unwrap();
        let plan = fullmag_plan::plan(&problem).expect("source-only shared domain should resolve");
        let BackendPlanIR::Fem(fem) = plan.backend_plan else {
            panic!("source-only import fixture requires FEM");
        };
        let expected = fem.mesh.nodes.len();
        assert_eq!(expected, 8, "shared magnetic interface nodes are packed per object");
        validate_imported_magnetization(&problem, &vec![[0.0, 1.0, 0.0]; expected])
            .expect("source-only multi-magnet global carrier should be accepted");
        for count in [5, expected - 1] {
            validate_imported_magnetization(&problem, &vec![[0.0, 1.0, 0.0]; count])
                .expect_err("source mesh node count is not the resolved runtime carrier length");
        }
        assert_eq!(serde_json::to_value(&problem).unwrap(), before);
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
            object_id: Some("ring".to_string()),
            name: "ring".to_string(),
            region: "ring".to_string(),
            material: "Py".to_string(),
            absorbing_boundary: None,
            initial_magnetization: None,
        });
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "shared_domain".to_string(),
                    nodes: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(Vec::new()),
                    element_markers: Vec::new(),
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
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
    fn continuation_initial_state_splits_multilayer_native_payload_by_magnet() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.geometry.entries = vec![
            fullmag_ir::GeometryEntryIR::Translate {
                name: "free_geom".to_string(),
                base: Box::new(fullmag_ir::GeometryEntryIR::Box {
                    name: "free_base".to_string(),
                    size: [4e-9, 2e-9, 2e-9],
                }),
                by: [0.0, 0.0, 0.0],
            },
            fullmag_ir::GeometryEntryIR::Translate {
                name: "ref_geom".to_string(),
                base: Box::new(fullmag_ir::GeometryEntryIR::Box {
                    name: "ref_base".to_string(),
                    size: [4e-9, 2e-9, 2e-9],
                }),
                by: [0.0, 0.0, 4e-9],
            },
        ];
        problem.regions = vec![
            fullmag_ir::RegionIR {
                name: "free_region".to_string(),
                geometry: "free_geom".to_string(),
            },
            fullmag_ir::RegionIR {
                name: "ref_region".to_string(),
                geometry: "ref_geom".to_string(),
            },
        ];
        problem.magnets = vec![
            fullmag_ir::MagnetIR {
                object_id: Some("free".to_string()),
                name: "free".to_string(),
                region: "free_region".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(fullmag_ir::InitialMagnetizationIR::Uniform {
                    value: [1.0, 0.0, 0.0],
                }),
                absorbing_boundary: None,
            },
            fullmag_ir::MagnetIR {
                object_id: Some("ref".to_string()),
                name: "ref".to_string(),
                region: "ref_region".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(fullmag_ir::InitialMagnetizationIR::Uniform {
                    value: [0.0, 1.0, 0.0],
                }),
                absorbing_boundary: None,
            },
        ];
        problem.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::Demag {
                realization: fullmag_ir::RequestedFemDemagIR::Auto,
            },
        ];
        problem.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fdm: Some(fullmag_ir::FdmHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
                default_cell: Some([2e-9, 2e-9, 2e-9]),
                per_magnet: None,
                demag: Some(fullmag_ir::FdmDemagHintsIR {
                    strategy: "multilayer_convolution".to_string(),
                    mode: "two_d_stack".to_string(),
                    fft_backend: "auto".to_string(),
                    common_cells: None,
                    common_cells_xy: None,
                    common_cell_size: None,
                }),
                boundary_correction: None,
                boundary_phi_floor: None,
                boundary_delta_min: None,
                projection_policy: None,
            }),
            fem: None,
            hybrid: None,
        });
        let plan = fullmag_plan::plan(&problem).expect("multilayer fixture should plan");
        let BackendPlanIR::FdmMultilayer(multilayer) = plan.backend_plan else {
            panic!("fixture must resolve to FDM multilayer");
        };
        let counts = multilayer
            .layers
            .iter()
            .map(|layer| layer.initial_magnetization.len())
            .collect::<Vec<_>>();
        assert_eq!(counts.len(), 2);
        let continuation = (0..counts.iter().sum::<usize>())
            .map(|index| {
                if index < counts[0] {
                    [0.0, 0.0, 1.0]
                } else {
                    [0.0, 0.0, -1.0]
                }
            })
            .collect::<Vec<_>>();

        apply_continuation_initial_state(&mut problem, &continuation)
            .expect("multilayer continuation should split by authored magnet");

        for (index, magnet) in problem.magnets.iter().enumerate() {
            let start = counts.iter().take(index).sum::<usize>();
            let end = start + counts[index];
            assert!(matches!(
                magnet.initial_magnetization.as_ref(),
                Some(fullmag_ir::InitialMagnetizationIR::SampledField { values })
                    if values == &continuation[start..end]
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
            object_id: Some("second".to_string()),
            name: "second".to_string(),
            region: "second".to_string(),
            material: "Py".to_string(),
            absorbing_boundary: None,
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
                        [0, 1, 2, 3],
                        [0, 2, 1, 4],
                    ]),
                    element_markers: vec![1, 2],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                        [0, 1, 3],
                        [0, 1, 4],
                    ]),
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
    fn materialize_pipeline_eigenmodes_preserves_canonical_bias_field_sweep() {
        let mut base = sample_problem_ir();
        let dynamics = base.study.dynamics().clone();
        let sampling = base.study.sampling().clone();
        let sweep = fullmag_ir::BiasFieldSweepIR {
            samples_a_per_m: vec![[12_500.0, 0.0, 0.0], [25_000.0, 500.0, -250.0]],
            equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
            ordering: "declared".to_string(),
            continuation_seed:
                fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
        };
        base.study = fullmag_ir::StudyIR::Eigenmodes {
            dynamics,
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: true,
            },
            count: 4,
            target: fullmag_ir::EigenTargetIR::Lowest,
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            bias_field_sweep: Some(sweep.clone()),
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
            mode_tracking: None,
            sampling,
        };

        let stage = materialize_pipeline_eigenmodes(&base, &BTreeMap::new())
            .expect("pipeline eigenmodes stage should materialize");
        let fullmag_ir::StudyIR::Eigenmodes {
            bias_field_sweep, ..
        } = &stage.ir.study
        else {
            panic!("pipeline eigenmodes stage must retain eigenmode semantics");
        };

        assert_eq!(bias_field_sweep.as_ref(), Some(&sweep));
    }

    #[test]
    fn materialize_script_stages_does_not_synthesize_solver_for_empty_pipeline() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![],
            }),
            stages: vec![],
        };
        assert!(materialize_script_stages(config).expect("empty pipeline").is_empty());
    }

    #[test]
    fn materialize_script_stages_does_not_synthesize_solver_for_disabled_pipeline() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![StudyPipelineNode::Primitive {
                    id: "disabled_run".to_string(),
                    label: "Disabled run".to_string(),
                    enabled: false,
                    notes: None,
                    source: Some("script_imported".to_string()),
                    stage_kind: "run".to_string(),
                    payload: serde_json::from_value(json!({"until_seconds": "5e-12"}))
                        .expect("payload"),
                }],
            }),
            stages: vec![],
        };
        assert!(materialize_script_stages(config).expect("disabled pipeline").is_empty());
    }

    #[test]
    fn materialize_script_stages_skips_enabled_children_of_disabled_group() {
        let document = serde_json::from_value(json!({
            "version": "study_pipeline.v1",
            "nodes": [{
                "node_kind": "group", "id": "disabled_group", "label": "Disabled",
                "enabled": false,
                "children": [{
                    "node_kind": "primitive", "id": "child_run", "label": "Run",
                    "enabled": true, "stage_kind": "run",
                    "payload": {"until_seconds": "5e-12"}
                }]
            }]
        })).expect("group document");
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(document),
            stages: vec![],
        };
        assert!(materialize_script_stages(config).expect("disabled group").is_empty());
    }

    #[test]
    fn materialize_script_stages_retains_legacy_solver_without_pipeline() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: None,
            stages: vec![],
        };
        let stages = materialize_script_stages(config).expect("legacy solver");
        assert_eq!(stages.len(), 1);
        assert!(stages[0].action.is_none());
        assert!((stages[0].until_seconds - 5e-12).abs() < 1e-24);
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
            &stages[1].ir.study,
            fullmag_ir::StudyIR::Relaxation {
                stop: fullmag_ir::RelaxStopIR {
                    max_steps: Some(25),
                    ..
                },
                dynamics: Some(fullmag_ir::DynamicsIR::Llg {
                    integrator,
                    fixed_timestep: Some(fixed_timestep),
                    ..
                }),
                ..
            } if integrator == "rk45" && (*fixed_timestep - 2e-13).abs() < 1e-24
        ));
        assert!(stages[1].until_seconds.is_infinite());
    }

    #[test]
    fn stage_local_table_autosave_is_owned_by_relaxation_only() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "relax".to_string(),
                        label: "".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "relax".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "relax",
                            "entrypoint_kind": "pipeline_relax",
                            "relax_algorithm": "projected_gradient_bb",
                            "torque_tolerance": "1e-4",
                            "max_steps": "25",
                            "table_autosave": {
                                "kind": "table_autosave",
                                "table_id": "default",
                                "every_steps": 10,
                                "quantities": ["step", "mx"]
                            }
                        }))
                        .expect("relax payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "after".to_string(),
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
                        .expect("run payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 2);
        assert_eq!(
            stages[0]
                .ir
                .study
                .sampling()
                .table_autosave
                .as_ref()
                .and_then(fullmag_ir::TableAutosaveIR::accepted_step_cadence),
            Some(10),
        );
        assert!(stages[1].ir.study.sampling().table_autosave.is_none());
    }

    #[test]
    fn stage_local_autosave_materializes_without_leaking_to_following_stage() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    primitive_node(
                        "relax",
                        "relax",
                        json!({
                            "kind": "relax",
                            "relax_algorithm": "projected_gradient_bb",
                            "max_steps": "25",
                            "autosave": {
                                "kind": "stage_autosave",
                                "target": "main",
                                "layout": "continuous",
                                "format": "zarr",
                                "table": {"every_steps": 10, "quantities": ["step", "mx"]},
                                "fields": [{"quantity": "m", "every_steps": 20}]
                            }
                        }),
                    ),
                    primitive_node(
                        "run",
                        "run",
                        json!({
                            "kind": "run",
                            "until_seconds": "5e-12",
                            "autosave": {
                                "kind": "stage_autosave",
                                "target": "main",
                                "layout": "continuous",
                                "format": "zarr",
                                "table": {"sample_period_s": 1e-12, "quantities": ["step", "mx"]},
                                "fields": [{"quantity": "m", "every_seconds": 2e-12}]
                            }
                        }),
                    ),
                    primitive_node(
                        "after",
                        "run",
                        json!({"kind": "run", "until_seconds": "5e-12"}),
                    ),
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("stage autosave should materialize");
        assert_eq!(stages.len(), 3);
        assert_eq!(
            stages[0]
                .ir
                .study
                .sampling()
                .stage_autosave
                .as_ref()
                .unwrap()
                .fields[0]
                .every_steps,
            Some(20)
        );
        assert_eq!(
            stages[1]
                .ir
                .study
                .sampling()
                .stage_autosave
                .as_ref()
                .unwrap()
                .fields[0]
                .every_seconds,
            Some(2e-12)
        );
        assert!(stages[2].ir.study.sampling().stage_autosave.is_none());
    }

    #[test]
    fn stage_local_autosave_rejects_malformed_or_wrong_clock_payloads() {
        for (stage_kind, payload, expected) in [
            (
                "run",
                json!({
                    "kind": "run",
                    "until_seconds": "5e-12",
                    "autosave": {
                        "target": "main",
                        "layout": "continuous",
                        "format": "zarr",
                        "fields": [{"quantity": "m", "every_steps": 10}]
                    }
                }),
                "only valid for relaxation",
            ),
            (
                "relax",
                json!({
                    "kind": "relax",
                    "relax_algorithm": "projected_gradient_bb",
                    "max_steps": "25",
                    "autosave": {"target": "main", "layout": "not-a-layout"}
                }),
                "payload is invalid",
            ),
        ] {
            let config = ScriptExecutionConfig {
                ir: sample_problem_ir(),
                shared_geometry_assets: None,
                default_until_seconds: Some(5e-12),
                study_pipeline: Some(StudyPipelineDocument {
                    version: "study_pipeline.v1".to_string(),
                    nodes: vec![primitive_node("invalid", stage_kind, payload)],
                }),
                stages: vec![],
            };
            let error = materialize_script_stages(config).expect_err("invalid policy must fail");
            assert!(
                format!("{error:#}").contains(expected),
                "missing {expected:?} in {error:#}"
            );
        }
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
            bias_field_sweep: None,
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
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
                stage_autosave: None,
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
                stage_autosave: None,
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
    fn materialize_pipeline_direct_minimizer_does_not_require_base_dynamics() {
        let mut base = sample_problem_ir();
        let sampling = base.study.sampling().clone();
        base.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            dynamics: None,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-4),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
            sampling,
        };
        let payload = serde_json::from_value(json!({
            "relax_algorithm": "projected_gradient_bb",
            "max_steps": 25
        }))
        .expect("payload");

        let stage = materialize_pipeline_relax(&base, &payload)
            .expect("valid direct-minimizer pipeline stage must not panic");
        assert!(matches!(
            &stage.ir.study,
            fullmag_ir::StudyIR::Relaxation {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
                dynamics: None,
                ..
            }
        ));
        assert!(stage.until_seconds.is_infinite());
    }

    #[test]
    fn materialize_pipeline_direct_minimizer_rejects_llg_only_controls() {
        let base = sample_problem_ir();
        let payload = serde_json::from_value(json!({
            "relax_algorithm": "projected_gradient_bb",
            "integrator": "rk23",
            "fixed_timestep": 1e-13,
            "max_error": 1e-5,
            "relax_alpha": 0.5
        }))
        .expect("payload");

        let error = materialize_pipeline_relax(&base, &payload)
            .expect_err("direct minimizer must reject LLG-only controls");
        let message = error.to_string();
        for field in ["integrator", "fixed_timestep", "max_error", "relax_alpha"] {
            assert!(
                message.contains(field),
                "missing rejected field {field}: {message}"
            );
        }
    }

    #[test]
    fn session_command_direct_minimizer_rejects_llg_only_controls() {
        let base_problem = sample_problem_ir();
        let command = crate::types::SessionCommand {
            seq: 1,
            command_id: "cmd-direct-minimizer".to_string(),
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
            integrator: Some("rk23".to_string()),
            fixed_timestep: Some(1e-13),
            max_error: Some(1e-5),
            solver_policy: None,
            relax_algorithm: Some("projected_gradient_bb".to_string()),
            relax_alpha: Some(0.5),
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
            frozen_spins_runtime_plan_binding: None,
        };

        let error = build_interactive_command_stage(&base_problem, &command)
            .expect_err("direct minimizer SessionCommand must reject LLG-only controls");
        let message = error.to_string();
        for field in ["integrator", "fixed_timestep", "max_error", "relax_alpha"] {
            assert!(
                message.contains(field),
                "missing rejected field {field}: {message}"
            );
        }
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
            solver_policy: None,
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
            frozen_spins_runtime_plan_binding: None,
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
            solver_policy: None,
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
            frozen_spins_runtime_plan_binding: None,
        };

        let stage = build_interactive_command_stage(&base_problem, &command)
            .expect("interactive solve should build")
            .expect("solve command should materialize a stage");

        assert_eq!(stage.entrypoint_kind, "interactive_relax");
        assert!(stage.until_seconds.is_infinite());
    }

    #[test]
    fn build_interactive_solve_preserves_authored_relaxation() {
        for algorithm in [
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RelaxationAlgorithmIR::NonlinearCg,
            fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
        ] {
            let mut base = sample_problem_ir_with_adaptive_relax_dt(4e-16);
            if let fullmag_ir::StudyIR::Relaxation {
                algorithm: authored,
                dynamics,
                stop,
                ..
            } = &mut base.study
            {
                *authored = algorithm;
                if algorithm != fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped {
                    *dynamics = None;
                }
                stop.torque_tolerance_apm = None;
                stop.energy_tolerance_j = Some(3e-25);
                stop.max_steps = Some(1234);
                stop.max_relaxation_time_s = if dynamics.is_some() { Some(7e-9) } else { None };
            } else {
                panic!("fixture must be a relaxation study");
            }
            let expected_study = serde_json::to_value(&base.study).unwrap();
            let expected_materials = serde_json::to_value(&base.materials).unwrap();
            let mut command = solver_command("solve");
            command.until_seconds = None;
            let stage = build_interactive_command_stage(&base, &command)
                .expect("solve must retain the authored algorithm")
                .unwrap();
            assert_eq!(
                serde_json::to_value(&stage.ir.study).unwrap(),
                expected_study
            );
            assert_eq!(
                serde_json::to_value(&stage.ir.materials).unwrap(),
                expected_materials
            );

            command.max_steps = Some(4321);
            let overridden = build_interactive_command_stage(&base, &command)
                .unwrap()
                .unwrap();
            if let fullmag_ir::StudyIR::Relaxation { stop, .. } = &mut base.study {
                stop.max_steps = Some(4321);
            }
            assert_eq!(
                serde_json::to_value(&overridden.ir.study).unwrap(),
                serde_json::to_value(&base.study).unwrap()
            );
        }
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
            solver_policy: None,
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
            frozen_spins_runtime_plan_binding: None,
        };

        let stage = build_interactive_command_stage(&base_problem, &command)
            .expect("interactive relax should build")
            .expect("relax command should materialize a stage");

        assert_eq!(stage.entrypoint_kind, "interactive_relax");
        assert!(stage.until_seconds.is_infinite());
    }

    #[test]
    fn build_interactive_relax_fixed_timestep_does_not_synthesize_time_budget() {
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
            solver_policy: None,
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
            frozen_spins_runtime_plan_binding: None,
        };

        let stage = build_interactive_command_stage(&base_problem, &command)
            .expect("interactive relax should build")
            .expect("relax command should materialize a stage");

        assert_eq!(stage.entrypoint_kind, "interactive_relax");
        assert!(stage.until_seconds.is_infinite());
        assert!(matches!(
            &stage.ir.study,
            fullmag_ir::StudyIR::Relaxation {
                dynamics: Some(fullmag_ir::DynamicsIR::Llg {
                    fixed_timestep: Some(fixed_timestep),
                    ..
                }),
                ..
            } if (*fixed_timestep - 6e-13).abs() < 1e-24
        ));
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
    fn materialize_script_stages_preserves_explicit_stage_autosave() {
        let mut ir = sample_problem_ir();
        ir.study.sampling_mut().stage_autosave = Some(
            serde_json::from_value(json!({
                "kind": "stage_autosave",
                "target": "main",
                "layout": "continuous",
                "format": "zarr",
                "table": {"sample_period_s": 1e-12, "quantities": ["step", "mx"]},
                "fields": [{"quantity": "m", "every_seconds": 2e-12}]
            }))
            .expect("stage autosave"),
        );
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(5e-12),
            study_pipeline: None,
            stages: vec![crate::types::ScriptExecutionStage {
                ir,
                default_until_seconds: Some(5e-12),
                entrypoint_kind: "explicit_run".to_string(),
                action: None,
            }],
        };

        let stages = materialize_script_stages(config).expect("explicit stage should materialize");
        let autosave = stages[0]
            .ir
            .study
            .sampling()
            .stage_autosave
            .as_ref()
            .expect("stage-local autosave must survive sampling normalization");
        assert_eq!(autosave.target, "main");
        assert_eq!(autosave.fields[0].every_seconds, Some(2e-12));
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
    fn materialize_script_stages_supports_explicit_solved_current_action() {
        let mut ir = sample_problem_ir();
        ir.current_modules = serde_json::from_value(json!([{
            "kind": "current_transport",
            "name": "charge",
            "model": "ohmic_poisson",
            "coupling": "one_way",
            "domain": [{"object_id": "track", "region_id": "track:transport"}],
            "materials": [{
                "region": {"object_id": "track", "region_id": "track:transport"},
                "material": {"sigma_Spm": 5e6}
            }],
            "boundaries": [
                {
                    "kind": "normal_current_electrode",
                    "id": "left",
                    "surfaces": [{"object_id": "track", "surface_id": "x-", "orientation": [-1.0, 0.0, 0.0]}],
                    "outward_current_density_Apm2": 0.0
                },
                {
                    "kind": "normal_current_electrode",
                    "id": "right",
                    "surfaces": [{"object_id": "track", "surface_id": "x+", "orientation": [1.0, 0.0, 0.0]}],
                    "outward_current_density_Apm2": 0.0
                }
            ],
            "gauge": "zero_mean",
            "solver": {
                "engine": "cg",
                "linear": {"relative_tolerance": 1e-10, "absolute_tolerance": 0.0, "max_iterations": 10000},
                "physical_residual_version": "charge_balance_integrated_l2.v1",
                "operator_version": "fv_charge_harmonic_v1"
            }
        }]))
        .expect("transport fixture should deserialize");
        let config = ScriptExecutionConfig {
            ir: ir.clone(),
            shared_geometry_assets: None,
            default_until_seconds: Some(3e-12),
            study_pipeline: None,
            stages: vec![crate::types::ScriptExecutionStage {
                ir,
                default_until_seconds: None,
                entrypoint_kind: "flat_set_transport_current".to_string(),
                action: Some(
                    crate::types::ScriptExecutionStageAction::SetTransportCurrent {
                        module_id: "charge".to_string(),
                        terminal_outward_current_density_apm2: BTreeMap::from([
                            ("left".to_string(), -1.0e12),
                            ("right".to_string(), 1.0e12),
                        ]),
                    },
                ),
            }],
        };

        let stages = materialize_script_stages(config)
            .expect("explicit set_transport_current should materialize");
        assert!(matches!(
            &stages[0].action,
            Some(ResolvedScriptStageAction::SetTransportCurrent {
                module_id,
                terminal_outward_current_density_apm2,
            }) if module_id == "charge"
                && terminal_outward_current_density_apm2["left"] == -1.0e12
                && terminal_outward_current_density_apm2["right"] == 1.0e12
        ));
        let fullmag_ir::CurrentModuleIR::CurrentTransport {
            definition: Some(definition),
            ..
        } = &stages[0].ir.current_modules[0]
        else {
            panic!("expected complete current transport");
        };
        let values: Vec<_> = definition
            .boundaries
            .iter()
            .filter_map(|boundary| match boundary {
                fullmag_ir::ChargeBoundaryIR::NormalCurrentElectrode {
                    outward_current_density_apm2,
                    ..
                } => Some(*outward_current_density_apm2),
                _ => None,
            })
            .collect();
        assert_eq!(values, vec![-1.0e12, 1.0e12]);
    }

    #[test]
    fn torque_stage_action_disables_and_reenables_its_solved_pipeline() {
        let mut graph = serde_json::from_value::<Value>(json!({
            "schema_version": "physics_graph.v1",
            "modules": [
                {"id": "charge", "kind": "current_transport", "depends_on": [], "activation": "active"},
                {"id": "spin", "kind": "spin_transport", "depends_on": ["charge"], "activation": "active"},
                {"id": "hm_fm", "kind": "spin_interface", "depends_on": ["spin"], "activation": "active"},
                {"id": "transport_torque", "kind": "spin_torque", "depends_on": ["spin"], "activation": "active"}
            ],
            "edges": [
                {"kind": "current_to_spin_transport", "source_id": "charge", "target_id": "spin", "status": "active"},
                {"kind": "spin_transport_to_torque", "source_id": "spin", "target_id": "transport_torque", "status": "active"}
            ]
        }))
        .expect("transport physics graph");
        let object = graph.as_object_mut().expect("graph object");
        object
            .get_mut("modules")
            .and_then(Value::as_array_mut)
            .expect("modules")
            .iter_mut()
            .find(|module| module["id"] == "transport_torque")
            .expect("torque module")
            .as_object_mut()
            .expect("torque object")
            .insert("activation".into(), Value::String("inactive".into()));
        propagate_disabled_transport_pipeline(object, "transport_torque")
            .expect("disable propagation");
        let modules = object["modules"].as_array().expect("modules");
        assert!(modules
            .iter()
            .all(|module| module["activation"] == "inactive"));
        assert!(object["edges"]
            .as_array()
            .expect("edges")
            .iter()
            .all(|edge| { edge["status"] == "inactive" }));

        object
            .get_mut("modules")
            .and_then(Value::as_array_mut)
            .expect("modules")
            .iter_mut()
            .find(|module| module["id"] == "transport_torque")
            .expect("torque module")
            .as_object_mut()
            .expect("torque object")
            .insert("activation".into(), Value::String("active".into()));
        propagate_disabled_transport_pipeline(object, "transport_torque")
            .expect("enable propagation");
        let modules = object["modules"].as_array().expect("modules");
        assert!(modules
            .iter()
            .all(|module| module["activation"] == "active"));
        assert!(object["edges"]
            .as_array()
            .expect("edges")
            .iter()
            .all(|edge| { edge["status"] == "active" }));
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
    fn materialize_script_stages_sets_exact_solved_current_electrodes() {
        let mut ir = sample_problem_ir();
        ir.current_modules = serde_json::from_value(json!([{
            "kind": "current_transport",
            "name": "charge",
            "model": "ohmic_poisson",
            "coupling": "one_way",
            "domain": [{"object_id": "track", "region_id": "track:transport"}],
            "materials": [{
                "region": {"object_id": "track", "region_id": "track:transport"},
                "material": {"sigma_Spm": 5e6}
            }],
            "boundaries": [
                {
                    "kind": "normal_current_electrode",
                    "id": "left",
                    "surfaces": [{
                        "object_id": "track", "surface_id": "x-",
                        "orientation": [-1.0, 0.0, 0.0]
                    }],
                    "outward_current_density_Apm2": 0.0
                },
                {
                    "kind": "normal_current_electrode",
                    "id": "right",
                    "surfaces": [{
                        "object_id": "track", "surface_id": "x+",
                        "orientation": [1.0, 0.0, 0.0]
                    }],
                    "outward_current_density_Apm2": 0.0
                }
            ],
            "gauge": "zero_mean",
            "solver": {
                "engine": "cg",
                "linear": {
                    "relative_tolerance": 1e-10,
                    "absolute_tolerance": 0.0,
                    "max_iterations": 10000
                },
                "physical_residual_version": "charge_balance_integrated_l2.v1",
                "operator_version": "fv_charge_harmonic_v1"
            }
        }]))
        .expect("transport fixture should deserialize");
        let config = ScriptExecutionConfig {
            ir,
            shared_geometry_assets: None,
            default_until_seconds: Some(3e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "set-drive".to_string(),
                        label: "Set transport current".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "set_transport_current".to_string(),
                        payload: serde_json::from_value(json!({
                            "module_id": "charge",
                            "terminal_outward_current_density_Apm2": {
                                "left": -1e12,
                                "right": 1e12
                            }
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "run".to_string(),
                        label: "Run".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "run".to_string(),
                        payload: serde_json::from_value(json!({
                            "until_seconds": "3e-12"
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        let fullmag_ir::CurrentModuleIR::CurrentTransport {
            definition: Some(definition),
            ..
        } = &stages[0].ir.current_modules[0]
        else {
            panic!("expected complete current transport");
        };
        let values: Vec<_> = definition
            .boundaries
            .iter()
            .filter_map(|boundary| match boundary {
                fullmag_ir::ChargeBoundaryIR::NormalCurrentElectrode {
                    outward_current_density_apm2,
                    ..
                } => Some(*outward_current_density_apm2),
                _ => None,
            })
            .collect();
        assert_eq!(values, vec![-1e12, 1e12]);
    }

    #[test]
    fn materialize_script_stages_updates_spin_torque_graph_activation_and_edge() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json"
        ))
        .expect("racetrack fixture");
        let lowering = fixture
            .get("normalized_problem_ir_contract")
            .and_then(|value| value.get("expected_lowering"))
            .expect("fixture lowering");
        let mut ir: ProblemIR =
            serde_json::from_value(lowering.clone()).expect("typed racetrack lowering");
        let torque_payload = serde_json::to_value(&ir.spin_torque_modules[0])
            .expect("serialize typed torque payload");
        ir.physics_graph = Some(json!({
            "schema_version": "physics_graph.v1",
            "scene_revision": 0,
            "modules": [{
                "id": "transport_torque",
                "kind": "spin_torque",
                "applies_to": [],
                "solve_domain": [],
                "depends_on": ["spin"],
                "activation": "active",
                "authored_state": "authored",
                "capability": "semantic_only",
                "source_path": "/spin_torque_modules/0",
                "family_payload": torque_payload
            }],
            "edges": [{
                "kind": "spin_transport_to_torque",
                "source_id": "spin",
                "target_id": "transport_torque",
                "status": "active"
            }]
        }));
        let config = ScriptExecutionConfig {
            ir,
            shared_geometry_assets: None,
            default_until_seconds: Some(3e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "disable-torque".to_string(),
                        label: "Disable transport torque".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "set_spin_torque_enabled".to_string(),
                        payload: serde_json::from_value(json!({
                            "module_id": "transport_torque",
                            "enabled": false
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "run".to_string(),
                        label: "Run".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("script_imported".to_string()),
                        stage_kind: "run".to_string(),
                        payload: serde_json::from_value(json!({
                            "until_seconds": "3e-12"
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        let graph = stages[0].ir.physics_graph.as_ref().expect("physics graph");
        assert_eq!(graph["modules"][0]["activation"], "inactive");
        assert_eq!(graph["edges"][0]["status"], "inactive");
    }

    #[test]
    fn materialize_script_stages_adds_field_drive_only_after_explicit_action() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(2e-9),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    StudyPipelineNode::Primitive {
                        id: "relax".to_string(),
                        label: "Relax".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "relax".to_string(),
                        payload: serde_json::from_value(json!({"max_steps": 2})).expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "add-k0-antenna".to_string(),
                        label: "Add antenna".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "add_field_drive".to_string(),
                        payload: serde_json::from_value(json!({
                            "kind": "add_field_drive",
                            "entrypoint_kind": "flat_add_field_drive",
                            "drive": {
                                "id": "k0-sinc",
                                "name": "K0 sinc",
                                "kind": "regional",
                                "enabled": true,
                                "target": {"kind": "global"},
                                "amplitude_B_T": 0.001,
                                "direction": [0.0, 1.0, 0.0],
                                "spatial_profile": {"kind": "uniform"},
                                "waveform": {
                                    "kind": "sinc_pulse",
                                    "cutoff_hz": 40000000000.0,
                                    "t0": 5e-11,
                                    "amplitude": 1.0
                                },
                                "time_origin": "stage_local",
                                "activation": {"kind": "all_time_evolution"}
                            }
                        }))
                        .expect("payload"),
                    },
                    StudyPipelineNode::Primitive {
                        id: "excite".to_string(),
                        label: "Run".to_string(),
                        enabled: true,
                        notes: None,
                        source: Some("ui_authored".to_string()),
                        stage_kind: "run".to_string(),
                        payload: serde_json::from_value(json!({
                            "entrypoint_kind": "flat_run",
                            "until_seconds": 2e-9
                        }))
                        .expect("payload"),
                    },
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 3);
        assert!(stages[0].ir.field_drives.is_empty());
        assert_eq!(stages[1].entrypoint_kind, "flat_add_field_drive");
        assert_eq!(stages[1].until_seconds, 0.0);
        assert_eq!(stages[1].ir.field_drives[0].id, "k0-sinc");
        assert_eq!(stages[2].ir.field_drives[0].id, "k0-sinc");
        assert!(matches!(
            &stages[1].action,
            Some(ResolvedScriptStageAction::AddFieldDrive { drive })
                if drive.id == "k0-sinc"
        ));
        assert_eq!(
            stages[1]
                .incoming_transition
                .as_ref()
                .map(|transition| transition.kind),
            Some(StageTransitionKind::ContinueInPlace)
        );
        assert_eq!(
            stages[2]
                .incoming_transition
                .as_ref()
                .map(|transition| transition.kind),
            Some(StageTransitionKind::ContinueInPlace)
        );
    }

    #[test]
    fn materialize_script_stages_removes_only_selected_field_drive() {
        let drive = |id: &str, direction: [f64; 3]| {
            json!({
                "kind": "add_field_drive",
                "drive": {
                    "id": id,
                    "name": id,
                    "kind": "regional",
                    "enabled": true,
                    "target": {"kind": "global"},
                    "amplitude_B_T": 0.001,
                    "direction": direction,
                    "spatial_profile": {"kind": "uniform"},
                    "waveform": {"kind": "constant", "amplitude": 1.0},
                    "time_origin": "stage_local",
                    "activation": {"kind": "all_time_evolution"}
                }
            })
        };
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1.0e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    primitive_node(
                        "add-first",
                        "add_field_drive",
                        drive("first", [0.0, 1.0, 0.0]),
                    ),
                    primitive_node(
                        "add-second",
                        "add_field_drive",
                        drive("second", [0.0, 0.0, 1.0]),
                    ),
                    primitive_node(
                        "remove-first",
                        "remove_field_drive",
                        json!({
                            "kind": "remove_field_drive",
                            "entrypoint_kind": "flat_remove_field_drive",
                            "drive_id": "first"
                        }),
                    ),
                    primitive_node(
                        "run-second-only",
                        "run",
                        json!({"entrypoint_kind": "flat_run", "until_seconds": 1.0e-12}),
                    ),
                    primitive_node(
                        "readd-first",
                        "add_field_drive",
                        drive("first", [1.0, 0.0, 0.0]),
                    ),
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("remove pipeline should materialize");
        assert_eq!(stages.len(), 5);
        assert_eq!(
            stages[2]
                .ir
                .field_drives
                .iter()
                .map(|drive| drive.id.as_str())
                .collect::<Vec<_>>(),
            vec!["second"]
        );
        assert!(matches!(
            stages[2].action.as_ref(),
            Some(ResolvedScriptStageAction::RemoveFieldDrive { drive_id }) if drive_id == "first"
        ));
        assert_eq!(
            stages[2]
                .incoming_transition
                .as_ref()
                .map(|transition| transition.kind),
            Some(StageTransitionKind::ContinueInPlace)
        );
        assert_eq!(
            stages[3]
                .ir
                .field_drives
                .iter()
                .map(|drive| drive.id.as_str())
                .collect::<Vec<_>>(),
            vec!["second"]
        );
        assert_eq!(
            stages[4]
                .ir
                .field_drives
                .iter()
                .map(|drive| drive.id.as_str())
                .collect::<Vec<_>>(),
            vec!["second", "first"]
        );
    }

    #[test]
    fn materialize_script_stages_rejects_unknown_or_repeated_field_drive_removal() {
        for drive_id in ["missing", ""] {
            let config = ScriptExecutionConfig {
                ir: sample_problem_ir(),
                shared_geometry_assets: None,
                default_until_seconds: Some(1.0e-12),
                study_pipeline: Some(StudyPipelineDocument {
                    version: "study_pipeline.v1".to_string(),
                    nodes: vec![primitive_node(
                        "remove",
                        "remove_field_drive",
                        json!({"kind": "remove_field_drive", "drive_id": drive_id}),
                    )],
                }),
                stages: vec![],
            };
            let error = materialize_script_stages(config).expect_err("unknown removal must fail");
            let diagnostic = format!("{error:#}");
            assert!(
                diagnostic.contains(if drive_id.is_empty() {
                    "must be non-empty"
                } else {
                    "does not exist"
                }),
                "unexpected diagnostic: {diagnostic}"
            );
        }

        let drive = sample_regional_field_drive("pulse");
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1.0e-12),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    primitive_node(
                        "add",
                        "add_field_drive",
                        json!({"kind": "add_field_drive", "drive": drive}),
                    ),
                    primitive_node(
                        "remove-once",
                        "remove_field_drive",
                        json!({"kind": "remove_field_drive", "drive_id": "pulse"}),
                    ),
                    primitive_node(
                        "remove-twice",
                        "remove_field_drive",
                        json!({"kind": "remove_field_drive", "drive_id": "pulse"}),
                    ),
                ],
            }),
            stages: vec![],
        };
        let error = materialize_script_stages(config).expect_err("repeated removal must fail");
        assert!(
            format!("{error:#}").contains("field drive id 'pulse' does not exist"),
            "unexpected diagnostic: {error:#}"
        );
    }

    #[test]
    fn materialize_explicit_remove_field_drive_action_updates_following_state() {
        let mut ir = sample_problem_ir();
        ir.field_drives.push(sample_regional_field_drive("pulse"));
        let config = ScriptExecutionConfig {
            ir: ir.clone(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1.0e-12),
            study_pipeline: None,
            stages: vec![ScriptExecutionStage {
                ir,
                default_until_seconds: None,
                entrypoint_kind: "flat_remove_field_drive".to_string(),
                action: Some(ScriptExecutionStageAction::RemoveFieldDrive {
                    drive_id: "pulse".to_string(),
                }),
            }],
        };

        let stages =
            materialize_script_stages(config).expect("explicit removal should materialize");
        assert_eq!(stages.len(), 1);
        assert!(stages[0].ir.field_drives.is_empty());
        assert!(matches!(
            stages[0].action.as_ref(),
            Some(ResolvedScriptStageAction::RemoveFieldDrive { drive_id }) if drive_id == "pulse"
        ));
    }

    #[test]
    fn materialize_script_stages_applies_visible_autosave_and_fft_actions_in_order() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(2e-9),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    primitive_node(
                        "clear-initial",
                        "autosave",
                        json!({
                            "kind": "autosave", "enabled": false, "quantity": null, "output": null
                        }),
                    ),
                    primitive_node(
                        "table-on",
                        "table_autosave",
                        json!({
                            "kind": "table_autosave",
                            "enabled": true,
                            "table_autosave": {
                                "kind": "table_autosave",
                                "table_id": "default",
                                "sample_period_s": 5e-13,
                                "quantities": ["t", "mx", "my", "mz"]
                            }
                        }),
                    ),
                    primitive_node(
                        "autosave-m",
                        "autosave",
                        json!({
                            "kind": "autosave",
                            "enabled": true,
                            "quantity": "m",
                            "output": {"kind": "field", "name": "m", "every_seconds": 2e-12}
                        }),
                    ),
                    primitive_node(
                        "fft-on",
                        "fft_response",
                        json!({
                            "kind": "fft_response",
                            "enabled": true,
                            "request": {
                                "schema_version": "spin_wave_response.request.v1",
                                "analysis": "gamma",
                                "response_component": "my",
                                "weighting": "Ms_times_lumped_volume",
                                "detrend": "linear",
                                "window": "hann",
                                "susceptibility_floor_fraction": 1e-6
                            }
                        }),
                    ),
                    primitive_node(
                        "sampled",
                        "run",
                        json!({
                            "entrypoint_kind": "flat_run", "until_seconds": 2e-9
                        }),
                    ),
                    primitive_node(
                        "table-off",
                        "table_autosave",
                        json!({
                            "kind": "table_autosave", "enabled": false, "table_autosave": null
                        }),
                    ),
                    primitive_node(
                        "autosave-off",
                        "autosave",
                        json!({
                            "kind": "autosave", "enabled": false, "quantity": null, "output": null
                        }),
                    ),
                    primitive_node(
                        "fft-off",
                        "fft_response",
                        json!({
                            "kind": "fft_response", "enabled": false, "request": null
                        }),
                    ),
                    primitive_node(
                        "unsampled",
                        "run",
                        json!({
                            "entrypoint_kind": "flat_run", "until_seconds": 1e-9
                        }),
                    ),
                ],
            }),
            stages: vec![],
        };

        let stages = materialize_script_stages(config).expect("pipeline should materialize");
        assert_eq!(stages.len(), 9);
        assert!(matches!(
            &stages[1].action,
            Some(ResolvedScriptStageAction::TableAutosave { enabled: true, .. })
        ));
        assert!(matches!(
            &stages[2].action,
            Some(ResolvedScriptStageAction::Autosave { enabled: true, .. })
        ));
        assert!(matches!(
            &stages[3].action,
            Some(ResolvedScriptStageAction::FftResponse { enabled: true, .. })
        ));
        let sampled = stages[4].ir.study.sampling();
        assert_eq!(
            sampled
                .table_autosave
                .as_ref()
                .and_then(|table| table.sample_period_s),
            Some(5e-13)
        );
        assert_eq!(sampled.outputs.len(), 1);
        assert!(stages[4]
            .ir
            .problem_meta
            .runtime_metadata
            .contains_key("spin_wave_response"));
        let unsampled = stages[8].ir.study.sampling();
        assert!(unsampled.table_autosave.is_none());
        assert!(unsampled.outputs.is_empty());
        assert!(!stages[8]
            .ir
            .problem_meta
            .runtime_metadata
            .contains_key("spin_wave_response"));
        assert!(stages.iter().skip(1).all(|stage| {
            stage
                .incoming_transition
                .as_ref()
                .is_some_and(|transition| transition.kind == StageTransitionKind::ContinueInPlace)
        }));
    }

    #[test]
    fn materialize_pipeline_resolves_auto_sampling_independently_for_each_run() {
        let drive = |id: &str, cutoff_hz: f64, stage_id: &str| {
            json!({
                "kind": "add_field_drive",
                "drive": {
                    "id": id,
                    "name": id,
                    "kind": "regional",
                    "enabled": true,
                    "target": {"kind": "global"},
                    "amplitude_B_T": 0.001,
                    "direction": [0.0, 1.0, 0.0],
                    "spatial_profile": {"kind": "uniform"},
                    "waveform": {
                        "kind": "sinc_pulse",
                        "cutoff_hz": cutoff_hz,
                        "t0": 5e-11,
                        "amplitude": 1.0
                    },
                    "time_origin": "stage_local",
                    "activation": {"kind": "stage_ids", "stage_ids": [stage_id]}
                }
            })
        };
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(2e-9),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    primitive_node("add-3", "add_field_drive", drive("drive-3", 3e9, "run-3")),
                    primitive_node("add-5", "add_field_drive", drive("drive-5", 5e9, "run-5")),
                    primitive_node(
                        "table-auto",
                        "table_autosave",
                        json!({
                            "kind": "table_autosave",
                            "enabled": true,
                            "table_autosave": {
                                "kind": "table_autosave",
                                "table_id": "default",
                                "sample_period_policy": {
                                    "kind": "auto_sinc_cutoff",
                                    "nyquist_guard_factor": 1.3
                                },
                                "quantities": ["t", "my"]
                            }
                        }),
                    ),
                    primitive_node(
                        "m-auto",
                        "autosave",
                        json!({
                            "kind": "autosave",
                            "enabled": true,
                            "quantity": "m",
                            "output": {
                                "kind": "field_auto",
                                "name": "m",
                                "sample_period_policy": {
                                    "kind": "auto_sinc_cutoff",
                                    "nyquist_guard_factor": 1.3
                                }
                            }
                        }),
                    ),
                    primitive_node("run-3", "run", json!({"until_seconds": 1e-9})),
                    primitive_node("run-5", "run", json!({"until_seconds": 1e-9})),
                ],
            }),
            stages: vec![],
        };

        let stages =
            materialize_script_stages(config).expect("pipeline should resolve auto sampling");
        let run_3 = &stages[4].ir;
        let run_5 = &stages[5].ir;
        run_3.validate().expect("first resolved Run must be valid");
        run_5.validate().expect("second resolved Run must be valid");
        assert_eq!(
            run_3.problem_meta.runtime_metadata["sampling_resolution"]["sample_period_s"],
            json!(1.0 / (2.0 * 1.3 * 3e9))
        );
        assert_eq!(
            run_5.problem_meta.runtime_metadata["sampling_resolution"]["sample_period_s"],
            json!(1.0 / (2.0 * 1.3 * 5e9))
        );
        assert!(matches!(
            run_3.study.sampling().outputs.as_slice(),
            [fullmag_ir::OutputIR::FieldResolvedAuto { .. }]
        ));
        assert!(matches!(
            run_5.study.sampling().outputs.as_slice(),
            [fullmag_ir::OutputIR::FieldResolvedAuto { .. }]
        ));
    }

    #[test]
    fn materialize_pipeline_auto_sampling_fails_after_sinc_drive_removal() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1.0e-9),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![
                    primitive_node(
                        "add-sinc",
                        "add_field_drive",
                        json!({
                            "kind": "add_field_drive",
                            "drive": {
                                "id": "sinc", "name": "sinc", "kind": "regional",
                                "enabled": true, "target": {"kind": "global"},
                                "amplitude_B_T": 0.001, "direction": [0.0, 1.0, 0.0],
                                "spatial_profile": {"kind": "uniform"},
                                "waveform": {"kind": "sinc_pulse", "cutoff_hz": 5e9, "t0": 5e-11},
                                "time_origin": "stage_local",
                                "activation": {"kind": "all_time_evolution"}
                            }
                        }),
                    ),
                    primitive_node(
                        "table-auto",
                        "table_autosave",
                        json!({
                            "kind": "table_autosave", "enabled": true,
                            "table_autosave": {
                                "kind": "table_autosave", "table_id": "default",
                                "sample_period_policy": {
                                    "kind": "auto_sinc_cutoff", "nyquist_guard_factor": 1.3
                                },
                                "quantities": ["t", "my"]
                            }
                        }),
                    ),
                    primitive_node(
                        "remove-sinc",
                        "remove_field_drive",
                        json!({"kind": "remove_field_drive", "drive_id": "sinc"}),
                    ),
                    primitive_node("run-after-removal", "run", json!({"until_seconds": 1e-9})),
                ],
            }),
            stages: vec![],
        };

        let error = materialize_script_stages(config)
            .expect_err("automatic sampling without an active sinc drive must fail");
        let diagnostic = format!("{error:#}");
        assert!(
            diagnostic.contains(
                "automatic sampling for Run stage 'run-after-removal' requires at least one enabled active sinc drive"
            ),
            "unexpected diagnostic: {diagnostic}"
        );
    }

    #[test]
    fn materialize_flat_stage_resolves_auto_sampling_from_its_active_stage_id() {
        let mut ir = sample_problem_ir();
        ir.problem_meta
            .runtime_metadata
            .insert("active_stage_id".into(), json!("excite"));
        ir.study.sampling_mut().outputs = vec![fullmag_ir::OutputIR::ScalarAuto {
            name: "my".into(),
            sample_period_policy: fullmag_ir::SamplingPeriodPolicyIR::AutoSincCutoff {
                nyquist_guard_factor: 1.3,
            },
        }];
        ir.field_drives.push(
            serde_json::from_value(json!({
                "id": "pulse", "name": "Pulse", "kind": "regional", "enabled": true,
                "target": {"kind": "global"}, "amplitude_B_T": 0.001,
                "direction": [0.0, 1.0, 0.0], "spatial_profile": {"kind": "uniform"},
                "waveform": {"kind": "sinc_pulse", "cutoff_hz": 5e9, "t0": 5e-11},
                "time_origin": "stage_local",
                "activation": {"kind": "stage_ids", "stage_ids": ["excite"]}
            }))
            .expect("drive"),
        );
        let stages = materialize_script_stages(ScriptExecutionConfig {
            ir: ir.clone(),
            shared_geometry_assets: None,
            default_until_seconds: Some(1e-9),
            study_pipeline: None,
            stages: vec![ScriptExecutionStage {
                ir,
                default_until_seconds: Some(1e-9),
                entrypoint_kind: "flat_run".into(),
                action: None,
            }],
        })
        .expect("flat stage should resolve auto sampling");
        assert!(matches!(
            stages[0].ir.study.sampling().outputs.as_slice(),
            [fullmag_ir::OutputIR::ScalarResolvedAuto { every_seconds, .. }]
                if *every_seconds == 1.0 / 13e9
        ));
    }

    #[test]
    fn standalone_auto_sampling_reports_missing_stage_context() {
        let mut ir = sample_problem_ir();
        ir.study.sampling_mut().outputs = vec![fullmag_ir::OutputIR::FieldAuto {
            name: "m".into(),
            sample_period_policy: fullmag_ir::SamplingPeriodPolicyIR::AutoSincCutoff {
                nyquist_guard_factor: 1.3,
            },
        }];
        let error = materialize_script_stages(ScriptExecutionConfig {
            ir,
            shared_geometry_assets: None,
            default_until_seconds: Some(1e-9),
            study_pipeline: None,
            stages: vec![],
        })
        .expect_err("standalone auto sampling must fail closed");
        assert!(error.to_string().contains("active_stage_id"));
    }

    #[test]
    fn materialize_script_stages_rejects_hidden_configuration_inside_plain_run() {
        let config = ScriptExecutionConfig {
            ir: sample_problem_ir(),
            shared_geometry_assets: None,
            default_until_seconds: Some(2e-9),
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes: vec![primitive_node(
                    "run",
                    "run",
                    json!({
                        "entrypoint_kind": "flat_run",
                        "until_seconds": 2e-9,
                        "fixed_timestep": 1e-13
                    }),
                )],
            }),
            stages: vec![],
        };

        let error = materialize_script_stages(config)
            .expect_err("plain Run must reject hidden solver/output configuration");
        let error = format!("{error:#}");
        assert!(error.contains("run pipeline stage accepts only until_seconds"));
        assert!(error.contains("fixed_timestep"));
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
            cells: fullmag_ir::FemConnectivityIR::from_tet4(elements),
            element_markers,
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(boundary_faces),
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
    fn test_resample_fem_to_fem_rejects_remeshed_target_without_dedicated_remesher() {
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

        let error = resample_continuation_if_cross_backend(&fem_m, &source, &target_ir)
            .expect_err("ordinary FEM continuation must reject a changed topology");

        assert!(error
            .to_string()
            .contains("FEM → FEM continuation requires identical mesh topology"));
    }

    #[test]
    fn test_resample_fem_to_fem_rejects_changed_topology_with_same_node_count() {
        let source_mesh = small_fem_cube_mesh();
        let target_ir = fem_target_problem_ir(small_fem_cube_mesh_same_count_shifted());
        let fem_m: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; source_mesh.nodes.len()];
        let source = ContinuationSource::Fem(source_mesh);

        let error = resample_continuation_if_cross_backend(&fem_m, &source, &target_ir)
            .expect_err("node count equality must not hide a topology change");

        assert!(error
            .to_string()
            .contains("FEM → FEM continuation requires identical mesh topology"));
    }

    #[test]
    fn test_resample_fem_to_fem_accepts_same_topology_with_different_metadata() {
        let source_mesh = small_fem_cube_mesh();
        let mut target_mesh = source_mesh.clone();
        target_mesh.mesh_name = "renamed_same_topology".to_string();
        let source_ir = fem_target_problem_ir(source_mesh);
        let source_plan = fullmag_plan::plan(&source_ir).expect("FEM source plan");
        let source = continuation_source_from_backend_plan(&source_plan.backend_plan);
        let target_ir = fem_target_problem_ir(target_mesh);
        let source_node_count = match &source {
            ContinuationSource::Fem(mesh) => mesh.nodes.len(),
            _ => panic!("expected FEM continuation source"),
        };
        let fem_m: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; source_node_count];

        let result = resample_continuation_if_cross_backend(&fem_m, &source, &target_ir)
            .expect("non-topological metadata must not invalidate FEM continuation");

        assert!(result.is_none());
    }

    #[test]
    fn test_resample_fem_to_fem_rejects_changed_eigen_target_topology() {
        let source_mesh = small_fem_cube_mesh();
        let mut target_ir = fem_target_problem_ir(small_fem_cube_mesh_with_center_node());
        let dynamics = target_ir.study.dynamics().clone();
        let mut sampling = target_ir.study.sampling().clone();
        sampling.outputs = vec![
            fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "spectrum".to_string(),
            },
            fullmag_ir::OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0, 1],
            },
        ];
        target_ir.study = fullmag_ir::StudyIR::Eigenmodes {
            dynamics,
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 2,
            target: fullmag_ir::EigenTargetIR::Lowest,
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            bias_field_sweep: None,
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
            mode_tracking: None,
            sampling,
        };
        let fem_m = vec![[1.0, 0.0, 0.0]; source_mesh.nodes.len()];
        let source = ContinuationSource::Fem(source_mesh);

        let error = resample_continuation_if_cross_backend(&fem_m, &source, &target_ir)
            .expect_err("ordinary FEM eigen continuation must reject a changed topology");

        assert!(error
            .to_string()
            .contains("FEM → FEM continuation requires identical mesh topology"));
    }

    #[test]
    fn test_resample_fdm_to_fem_fails_closed() {
        let source_ir = fdm_target_problem_ir();
        let source_plan = fullmag_plan::plan(&source_ir).expect("FDM source plan");
        let source = continuation_source_from_backend_plan(&source_plan.backend_plan);
        let target_ir = fem_target_problem_ir(small_fem_cube_mesh());
        let fdm_m: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; 64];

        let error = resample_continuation_if_cross_backend(&fdm_m, &source, &target_ir)
            .expect_err("FDM to FEM continuation requires an explicit transfer implementation");

        assert!(error
            .to_string()
            .contains("FDM → FEM continuation is not supported"));
    }

    #[test]
    fn test_resample_fdm_to_fdm_returns_none() {
        let target_ir = fdm_target_problem_ir();
        let source_plan = fullmag_plan::plan(&target_ir).expect("FDM source plan");
        let fdm_m: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; 64];
        let source = continuation_source_from_backend_plan(&source_plan.backend_plan);

        let result = resample_continuation_if_cross_backend(&fdm_m, &source, &target_ir)
            .expect("same-backend check should succeed");

        assert!(
            result.is_none(),
            "FDM→FDM should return None (no resampling)"
        );
    }

    #[test]
    fn test_fdm_union_grid_transfer_preserves_magnetic_layer() {
        let source = FdmContinuationGrid {
            cells: [2, 1, 1],
            origin_m: [0.0, 0.0, 1.0e-9],
            cell_size_m: [1.0e-9, 1.0e-9, 1.0e-9],
            active_mask: Some(vec![true, true]),
        };
        let target = FdmContinuationGrid {
            cells: [2, 1, 2],
            origin_m: [0.0, 0.0, 0.0],
            cell_size_m: [1.0e-9, 1.0e-9, 1.0e-9],
            active_mask: Some(vec![false, false, true, true]),
        };
        let transfer =
            transfer_fdm_field_to_grid(&[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], &source, &target)
                .expect("FM-only state should transfer to FM+HM union grid");
        assert_eq!(transfer.n_total, 4);
        assert_eq!(transfer.n_located, 2);
        assert_eq!(transfer.values[0], [0.0, 0.0, 0.0]);
        assert_eq!(transfer.values[1], [0.0, 0.0, 0.0]);
        assert_eq!(transfer.values[2], [1.0, 0.0, 0.0]);
        assert_eq!(transfer.values[3], [0.0, 1.0, 0.0]);
    }

    #[test]
    fn test_resample_fdm_to_fdm_rejects_changed_grid_identity() {
        let source_ir = fdm_target_problem_ir();
        let source_plan = fullmag_plan::plan(&source_ir).expect("FDM source plan");
        let fdm_m: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; 64];
        let source = continuation_source_from_backend_plan(&source_plan.backend_plan);
        let mut target_ir = fdm_target_problem_ir();
        target_ir
            .backend_policy
            .discretization_hints
            .as_mut()
            .and_then(|hints| hints.fdm.as_mut())
            .expect("FDM hints")
            .cell = [20e-9, 20e-9, 20e-9];

        let error = resample_continuation_if_cross_backend(&fdm_m, &source, &target_ir)
            .expect_err("FDM continuation must reject a changed resolved grid");

        assert!(error
            .to_string()
            .contains("FDM → FDM continuation requires identical grid identity"));
    }

    #[test]
    fn fdm_continuation_identity_includes_origin_cells_cell_size_masks_and_fingerprint() {
        let source_ir = fdm_target_problem_ir();
        let source_plan = fullmag_plan::plan(&source_ir).expect("FDM source plan");
        let BackendPlanIR::Fdm(plan) = source_plan.backend_plan else {
            panic!("expected FDM plan");
        };
        let identity = fdm_continuation_identity(&plan).expect("validated identity");

        let mut changed = identity.clone();
        changed.origin_m[0] += 1e-9;
        assert_ne!(changed, identity);
        let mut changed = identity.clone();
        changed.cells[0] += 1;
        assert_ne!(changed, identity);
        let mut changed = identity.clone();
        changed.cell_size[0] *= 2.0;
        assert_ne!(changed, identity);
        let mut changed = identity.clone();
        changed.active_mask = Some(vec![false]);
        assert_ne!(changed, identity);
        let mut changed = identity.clone();
        changed.region_mask.push(1);
        assert_ne!(changed, identity);
        let mut changed = identity.clone();
        changed.grid_fingerprint.replace_range(..1, "0");
        if changed.grid_fingerprint == identity.grid_fingerprint {
            changed.grid_fingerprint.replace_range(..1, "1");
        }
        assert_ne!(changed, identity);
    }

    #[test]
    fn missing_fdm_grid_certificate_classifies_as_unsupported() {
        let source_ir = fdm_target_problem_ir();
        let source_plan = fullmag_plan::plan(&source_ir).expect("FDM source plan");
        let BackendPlanIR::Fdm(mut plan) = source_plan.backend_plan else {
            panic!("expected FDM plan");
        };
        plan.grid_certificate = None;

        assert!(matches!(
            continuation_source_from_backend_plan(&BackendPlanIR::Fdm(plan)),
            ContinuationSource::Unsupported(reason)
                if reason.contains("validated grid certificate")
        ));
    }

    #[test]
    fn continuation_source_classifies_all_fem_plan_variants_as_fem() {
        let mesh = small_fem_cube_mesh();
        let fem_ir = fem_target_problem_ir(mesh.clone());
        let fem_plan = fullmag_plan::plan(&fem_ir).expect("FEM plan");
        let BackendPlanIR::Fem(expected_fem) = &fem_plan.backend_plan else {
            panic!("expected FEM plan");
        };
        assert!(matches!(
            continuation_source_from_backend_plan(&fem_plan.backend_plan),
            ContinuationSource::Fem(source_mesh) if source_mesh == expected_fem.mesh
        ));

        let mut eigen_ir = fem_target_problem_ir(mesh.clone());
        let dynamics = eigen_ir.study.dynamics().clone();
        let mut sampling = eigen_ir.study.sampling().clone();
        sampling.outputs = vec![fullmag_ir::OutputIR::EigenSpectrum {
            quantity: "spectrum".to_string(),
        }];
        eigen_ir.study = fullmag_ir::StudyIR::Eigenmodes {
            dynamics,
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 2,
            target: fullmag_ir::EigenTargetIR::Lowest,
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            bias_field_sweep: None,
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
            mode_tracking: None,
            sampling,
        };
        let eigen_plan = fullmag_plan::plan(&eigen_ir).expect("FEM eigen plan");
        let BackendPlanIR::FemEigen(expected_eigen) = &eigen_plan.backend_plan else {
            panic!("expected FEM eigen plan");
        };
        assert!(matches!(
            continuation_source_from_backend_plan(&eigen_plan.backend_plan),
            ContinuationSource::Fem(source_mesh) if source_mesh == expected_eigen.mesh
        ));

        let mut frequency_plan = minimal_frequency_response_plan();
        frequency_plan.mesh = mesh.clone();
        let frequency_plan = BackendPlanIR::FemFrequencyResponse(frequency_plan);
        assert!(matches!(
            continuation_source_from_backend_plan(&frequency_plan),
            ContinuationSource::Fem(source_mesh) if source_mesh == mesh
        ));
    }

    #[test]
    fn unsupported_continuation_source_fails_before_target_mutation() {
        let target_ir = fem_target_problem_ir(small_fem_cube_mesh());
        let original_target = target_ir.clone();
        let source = ContinuationSource::Unsupported("unqualified backend".to_string());

        let error = resample_continuation_if_cross_backend(&[], &source, &target_ir)
            .expect_err("unsupported continuation must fail closed");

        assert!(error
            .to_string()
            .contains("unsupported continuation source: unqualified backend"));
        assert_eq!(target_ir, original_target);
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
            bias_field_sweep: None,
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
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
