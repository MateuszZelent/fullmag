use super::*;
use crate::interactive_runtime_host::PreparedInteractiveBase;
use fullmag_session::mesh_operation::{
    record_mesh_command_outcome, MeshCommandOutcome, MeshCommandStatus, MESH_STATE_POLICY,
};

pub(super) struct PreparedRemeshPublication {
    pub(super) state: LocalLiveWorkspaceState,
    pub(super) plan_summary: fullmag_ir::ExecutionPlanSummary,
    pub(super) runtime: Option<PreparedInteractiveBase>,
}

fn manual_remesh_intent(command: &SessionCommand) -> serde_json::Value {
    let options = command
        .mesh_options
        .clone()
        .unwrap_or(serde_json::json!({}));
    let mut intent = command
        .mesh_target
        .as_ref()
        .map(|target| {
            mesh_build_intent_json(
                target,
                command
                    .mesh_reason
                    .as_deref()
                    .unwrap_or("manual_ui_rebuild"),
                &options,
            )
        })
        .unwrap_or(serde_json::json!({}));
    intent["command_id"] = serde_json::json!(command.command_id);
    intent["build_id"] = serde_json::json!(format!("mesh:{}", command.command_id));
    intent["state_policy"] = serde_json::json!(MESH_STATE_POLICY);
    intent["canonical_policy_snapshot"] = options
        .get("canonical_policy_snapshot")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    intent["mesh_options"] = options.clone();
    intent["source_scene_revision"] = serde_json::json!(mesh_source_scene_revision(&options));
    intent["mesh_reason"] = serde_json::json!(command.mesh_reason);
    intent
}

#[allow(clippy::too_many_arguments)]
fn prepare_fdm_grid_refresh(
    command: &SessionCommand,
    stages: &mut [ResolvedScriptStage],
    stage_execution_plans: &mut [ExecutionPlanIR],
    workspace_status: &str,
    live_workspace: &LocalLiveWorkspace,
    current_mesh_history: &mut Vec<serde_json::Value>,
    current_fem_mesh_override: &mut Option<fullmag_ir::MeshIR>,
    current_fem_hmax_override: &mut Option<f64>,
    backend_override: Option<BackendTarget>,
    prepare_runtime: bool,
) -> Result<PreparedRemeshPublication> {
    let opts = command
        .mesh_options
        .clone()
        .unwrap_or_else(|| serde_json::json!({}));
    let scene_problem_patch = scene_problem_patch_from_mesh_options(&opts)?
        .ok_or_else(|| anyhow!("fdm_grid_refresh command is missing scene_problem_patch"))?;
    let mut candidate_stages = stages.to_vec();
    for stage in &mut candidate_stages {
        apply_scene_discretization_patch(&mut stage.ir, &scene_problem_patch)?;
        if let Some(source_scene_revision) = opts
            .get("source_scene_revision")
            .and_then(serde_json::Value::as_u64)
        {
            stage.ir.problem_meta.runtime_metadata.insert(
                "mesh_source_scene_revision".to_string(),
                serde_json::json!(source_scene_revision),
            );
        }
        validate_ir(&stage.ir)?;
    }
    if candidate_stages.is_empty() {
        bail!("fdm_grid_refresh requires at least one materialized stage");
    }
    let first_plan =
        fullmag_plan::plan(&candidate_stages[0].ir).map_err(|error| anyhow!(error.to_string()))?;
    if !matches!(
        &first_plan.backend_plan,
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_)
    ) {
        bail!("fdm_grid_refresh replanning produced a non-FDM execution plan");
    }
    let mut candidate_plans = stage_execution_plans.to_vec();
    refresh_materialized_stage_execution_plans(
        &candidate_stages,
        &mut candidate_plans,
        Some(first_plan.clone()),
    )?;
    let plan_summary = candidate_stages[0]
        .ir
        .plan_for(backend_override)
        .map_err(join_errors)?;
    let metadata = current_live_metadata(&candidate_stages[0].ir, &first_plan, workspace_status);
    let resolved_runtime = fullmag_runner::resolve_session_runtime_for_plan_and_preview(
        &candidate_stages[0].ir,
        &first_plan,
        u64::MAX,
    )
    .map_err(|error| anyhow!(error.to_string()))?;
    let requested_device = requested_device_from_problem(&candidate_stages[0].ir);
    if is_gpu_device_label(&requested_device) && resolved_runtime.resolved_device != "gpu" {
        bail!(
            "fdm_gpu_replan_resolved_cpu: requested device gpu, resolved device {}",
            resolved_runtime.resolved_device
        );
    }
    let runtime = if prepare_runtime {
        Some(InteractiveRuntimeHost::prepare_base_problem(
            candidate_stages[0].ir.clone(),
            &candidate_plans[0].backend_plan,
        )?)
    } else {
        None
    };

    let mut candidate_state = live_workspace.snapshot();
    let mut initial_update = initial_step_update(&first_plan.backend_plan, None);
    initial_update.magnetization = Some(flatten_magnetization(
        &current_stage_magnetization_vectors(None, &first_plan.backend_plan),
    ));
    let mut live_state = live_state_manifest_from_update(initial_update);
    set_live_state_status(&mut live_state, workspace_status, Some(false));
    candidate_state.live_state = live_state;
    candidate_state.metadata = Some(metadata.clone());
    candidate_state.fem_mesh = None;
    clear_cached_preview_fields(&mut candidate_state);
    candidate_state.latest_scalar_row = None;
    candidate_state.latest_fields = CurrentLiveLatestFields::default();
    candidate_state.replace_latest_fields = true;
    candidate_state.field_generation = None;
    candidate_state.mesh_workspace = current_mesh_workspace(
        &candidate_stages[0].ir,
        &first_plan,
        workspace_status,
        None,
        current_mesh_history,
    );

    let mesh_summary = candidate_state
        .mesh_workspace
        .as_ref()
        .and_then(|workspace| workspace.get("mesh_summary"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let grid_certificate = match &first_plan.backend_plan {
        BackendPlanIR::Fdm(plan) => plan.grid_certificate.clone(),
        BackendPlanIR::FdmMultilayer(plan) => plan.grid_certificate.clone(),
        _ => None,
    };
    current_mesh_history.push(serde_json::json!({
        "id": format!("mesh:{}", command.command_id),
        "command_id": command.command_id,
        "build_id": format!("mesh:{}", command.command_id),
        "state_policy": MESH_STATE_POLICY,
        "canonical_policy_snapshot": opts.get("canonical_policy_snapshot"),
        "requested_execution": candidate_stages[0].ir.problem_meta.runtime_metadata.get("runtime_selection"),
        "resolved_execution": metadata.get("resolved_execution"),
        "source_scene_revision": opts.get("source_scene_revision"),
        "mesh_target": "study_domain",
        "mesh_reason": command.reason.as_deref().unwrap_or("fdm_grid_refresh"),
        "status": "completed",
        "mesh_generation_id": mesh_summary.get("generation_id"),
        "mesh_revision": mesh_summary.get("grid_fingerprint"),
        "grid_certificate": grid_certificate,
        "grid_fingerprint": mesh_summary.get("grid_fingerprint"),
        "total_cells": mesh_summary.get("total_cells"),
        "active_cells": mesh_summary.get("active_cells"),
        "membership_mask": {"status": "materialized", "source": "planner_resolved_mask"},
    }));
    if let Some(workspace) = candidate_state.mesh_workspace.as_mut() {
        workspace["mesh_history"] = serde_json::json!(current_mesh_history);
        workspace["last_build_summary"] = serde_json::json!({
            "kind": "mesh_build_summary",
            "command_id": command.command_id,
            "build_id": format!("mesh:{}", command.command_id),
            "status": "completed",
            "mesh_target": "study_domain",
            "mesh_reason": command.reason.as_deref().unwrap_or("fdm_grid_refresh"),
            "canonical_policy_snapshot": opts.get("canonical_policy_snapshot"),
            "requested_execution": candidate_stages[0].ir.problem_meta.runtime_metadata.get("runtime_selection"),
            "resolved_execution": metadata.get("resolved_execution"),
            "mesh_summary": mesh_summary,
            "grid_certificate": grid_certificate,
        });
        workspace["active_build"] = serde_json::Value::Null;
        workspace["last_build_error"] = serde_json::Value::Null;
        workspace["mesh_pipeline_status"] = serde_json::json!([
            {"id": "grid", "status": "done"},
            {"id": "membership", "status": "done"},
            {"id": "runtime", "status": "done"},
            {"id": "readiness", "status": "done"},
        ]);
    }
    stages.clone_from_slice(&candidate_stages);
    stage_execution_plans.clone_from_slice(&candidate_plans);
    *current_fem_mesh_override = None;
    *current_fem_hmax_override = None;
    live_workspace.push_log(
        "info",
        format!(
            "FDM grid replan prepared — {} cells, {} active magnetic cells, resolved device {}",
            mesh_summary
                .get("total_cells")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            mesh_summary
                .get("active_cells")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            resolved_runtime.resolved_device
        ),
    );
    Ok(PreparedRemeshPublication {
        state: candidate_state,
        plan_summary,
        runtime,
    })
}

/// Commit only after mesher, certificates, all plans and the retained runtime succeed.
#[allow(clippy::too_many_arguments)]
pub(super) fn execute_manual_interactive_remesh(
    command: &SessionCommand,
    stages: &mut [ResolvedScriptStage],
    plans: &mut Vec<ExecutionPlanIR>,
    workspace_status: &str,
    live_workspace: &LocalLiveWorkspace,
    current_quality: &mut Option<RemeshQualitySummary>,
    current_history: &mut Vec<serde_json::Value>,
    current_mesh: &mut Option<fullmag_ir::MeshIR>,
    current_hmax: &mut Option<f64>,
    adaptive_state: &Option<serde_json::Value>,
    continuation: &mut Option<Vec<[f64; 3]>>,
    continuation_source: &mut Option<ContinuationSource>,
    continuation_completion: &mut Option<fullmag_ir::StageCompletionIR>,
    runtime_host: Option<&mut InteractiveRuntimeHost>,
    backend_override: Option<BackendTarget>,
) -> Option<fullmag_ir::ExecutionPlanSummary> {
    let started = Instant::now();
    let mut candidate_stages = stages.to_vec();
    let mut candidate_plans = plans.to_vec();
    let mut candidate_quality = current_quality.clone();
    let mut candidate_history = current_history.clone();
    let mut candidate_mesh = current_mesh.clone();
    let mut candidate_hmax = *current_hmax;
    let snapshot = live_workspace.snapshot();
    let status = snapshot.live_state.status.as_str();
    let paused_or_running = snapshot
        .stage_execution
        .as_ref()
        .is_some_and(|stage| matches!(stage.runtime_state.as_str(), "paused" | "running"));
    let admitted =
        matches!(status, "awaiting_command" | "waiting_for_compute") && !paused_or_running;
    let attempt = (|| {
        if !admitted {
            bail!("remesh requires an idle runtime; stop the running or paused stage before rebuilding (state={status})");
        }
        if candidate_plans.is_empty() {
            let stage = candidate_stages
                .first()
                .ok_or_else(|| anyhow!("remesh requires a stage"))?;
            candidate_plans
                .push(fullmag_plan::plan(&stage.ir).map_err(|error| anyhow!(error.to_string()))?);
        }
        prepare_manual_interactive_remesh(
            command,
            &mut candidate_stages,
            &mut candidate_plans,
            workspace_status,
            live_workspace,
            &mut candidate_quality,
            &mut candidate_history,
            &mut candidate_mesh,
            &mut candidate_hmax,
            adaptive_state,
            backend_override,
            runtime_host.is_some(),
        )
    })();
    let mut outcome = MeshCommandOutcome {
        command_id: command.command_id.clone(),
        build_id: format!("mesh:{}", command.command_id),
        status: if admitted {
            MeshCommandStatus::Failed
        } else {
            MeshCommandStatus::Rejected
        },
        state_policy: MESH_STATE_POLICY.to_string(),
        completed_at_unix_ms: unix_time_millis().unwrap_or(0),
        mesh_generation_id: None,
        error: None,
    };
    match attempt {
        Ok(mut candidate) => {
            outcome.status = MeshCommandStatus::Completed;
            outcome.mesh_generation_id = candidate
                .state
                .live_state
                .latest_step
                .fem_mesh_generation_id
                .clone()
                .or_else(|| {
                    candidate
                        .state
                        .mesh_workspace
                        .as_ref()
                        .and_then(|workspace| workspace.get("mesh_summary"))
                        .and_then(|summary| summary.get("generation_id"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                });
            let duration = saturating_duration_millis_u64(started.elapsed());
            if let Some(entry) = candidate_history.last_mut() {
                entry["completed_at_unix_ms"] = serde_json::json!(outcome.completed_at_unix_ms);
                entry["duration_ms"] = serde_json::json!(duration);
            }
            let workspace = candidate
                .state
                .mesh_workspace
                .as_mut()
                .expect("prepared mesh workspace");
            workspace["mesh_history"] = serde_json::json!(candidate_history);
            workspace["last_build_summary"]["completed_at_unix_ms"] =
                serde_json::json!(outcome.completed_at_unix_ms);
            workspace["last_build_summary"]["duration_ms"] = serde_json::json!(duration);

            // This boundary contains no fallible mesher, planner, native allocation or transfer.
            if let (Some(host), Some(runtime)) = (runtime_host, candidate.runtime.take()) {
                host.commit_base_problem(runtime);
            }
            stages.clone_from_slice(&candidate_stages);
            plans.clone_from(&candidate_plans);
            *current_quality = candidate_quality;
            *current_mesh = candidate_mesh;
            *current_hmax = candidate_hmax;
            *current_history = candidate_history;
            *continuation = None;
            *continuation_source = None;
            *continuation_completion = None;
            live_workspace.update(|state| {
                if let Some(receipts) = state
                    .mesh_workspace
                    .as_ref()
                    .and_then(|workspace| workspace.get("command_outcomes"))
                {
                    workspace["command_outcomes"] = receipts.clone();
                }
                record_mesh_command_outcome(workspace, &outcome);
                clear_cached_preview_fields(state);
                state.field_generation = None;
                state.latest_fields = CurrentLiveLatestFields::default();
                state.replace_latest_fields = true;
                state.latest_scalar_row = None;
                state.live_state.latest_step = candidate.state.live_state.latest_step;
                state.live_state.coupled_checkpoint = None;
                state.metadata = candidate.state.metadata;
                state.fem_mesh = candidate.state.fem_mesh;
                state.mesh_workspace = Some(workspace.clone());
            });
            live_workspace.push_log("success", format!("Remesh complete — command {} committed; magnetization reinitialized from the authored model", command.command_id));
            Some(candidate.plan_summary)
        }
        Err(error) => {
            outcome.error = Some(error.to_string());
            live_workspace.update(|state| {
                let workspace = state
                    .mesh_workspace
                    .get_or_insert_with(|| serde_json::json!({}));
                let phase = workspace.get("mesh_pipeline_status").cloned();
                let mut summary = manual_remesh_intent(command);
                summary["kind"] = serde_json::json!("mesh_build_failed");
                summary["status"] =
                    serde_json::to_value(outcome.status).expect("status serializes");
                summary["error"] = serde_json::json!(error.to_string());
                summary["phase"] = serde_json::json!(phase);
                summary["completed_at_unix_ms"] = serde_json::json!(outcome.completed_at_unix_ms);
                summary["duration_ms"] =
                    serde_json::json!(saturating_duration_millis_u64(started.elapsed()));
                workspace["active_build"] = serde_json::Value::Null;
                workspace["last_build_summary"] = summary;
                workspace["last_build_error"] = serde_json::json!(error.to_string());
                workspace["mesh_pipeline_status"] = serde_json::json!("failed");
                record_mesh_command_outcome(workspace, &outcome);
            });
            live_workspace.push_log(
                "error",
                format!(
                    "Remesh failed — command {}: {error}; previous mesh and continuation retained",
                    command.command_id
                ),
            );
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_manual_interactive_remesh(
    command: &SessionCommand,
    stages: &mut [ResolvedScriptStage],
    stage_execution_plans: &mut [ExecutionPlanIR],
    workspace_status: &str,
    live_workspace: &LocalLiveWorkspace,
    current_mesh_quality: &mut Option<crate::python_bridge::RemeshQualitySummary>,
    current_mesh_history: &mut Vec<serde_json::Value>,
    current_fem_mesh_override: &mut Option<fullmag_ir::MeshIR>,
    current_fem_hmax_override: &mut Option<f64>,
    current_adaptive_runtime_state: &Option<serde_json::Value>,
    backend_override: Option<BackendTarget>,
    prepare_runtime: bool,
) -> Result<PreparedRemeshPublication> {
    if command.kind == "fdm_grid_refresh" {
        return prepare_fdm_grid_refresh(
            command,
            stages,
            stage_execution_plans,
            workspace_status,
            live_workspace,
            current_mesh_history,
            current_fem_mesh_override,
            current_fem_hmax_override,
            backend_override,
            prepare_runtime,
        );
    }
    let mesh_target = command
        .mesh_target
        .as_ref()
        .ok_or_else(|| anyhow!("remesh command is missing mesh_target"))?;
    if matches!(mesh_target, MeshCommandTarget::AdaptiveFollowup) {
        bail!(
            "interactive remesh does not accept mesh_target=adaptive_followup, got {:?}",
            mesh_target
        );
    }
    let opts = command
        .mesh_options
        .clone()
        .unwrap_or(serde_json::json!({}));
    if opts
        .get("state_policy")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|policy| policy != MESH_STATE_POLICY)
    {
        bail!("manual remesh supports only state_policy={MESH_STATE_POLICY}");
    }
    let scene_problem_patch = scene_problem_patch_from_mesh_options(&opts)?;
    let base_problem = stages
        .first()
        .map(|stage| stage.ir.clone())
        .ok_or_else(|| anyhow!("interactive remesh requires at least one materialized stage"))?;
    let base_execution_plan = stage_execution_plans
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("interactive remesh requires at least one materialized plan"))?;
    let mut remesh_problem_source = base_problem;
    if let Some(patch) = scene_problem_patch.as_ref() {
        apply_scene_problem_patch(&mut remesh_problem_source, patch)?;
    }
    if let Some(source_scene_revision) = mesh_source_scene_revision(&opts) {
        remesh_problem_source.problem_meta.runtime_metadata.insert(
            "mesh_source_scene_revision".to_string(),
            serde_json::json!(source_scene_revision),
        );
    }
    let mesh_reason = command
        .mesh_reason
        .as_deref()
        .unwrap_or("manual_ui_rebuild");
    let mesh_target_label = match mesh_target {
        MeshCommandTarget::StudyDomain => "study_domain".to_string(),
        MeshCommandTarget::AdaptiveFollowup => "adaptive_followup".to_string(),
        MeshCommandTarget::Airbox => "airbox".to_string(),
        MeshCommandTarget::ObjectMesh { object_id } => format!("object_mesh:{object_id}"),
    };
    eprintln!(
        "[fullmag] remesh requested with target={} reason={} options: {}",
        mesh_target_label, mesh_reason, opts
    );
    live_workspace.push_log(
        "info",
        format!(
            "Remesh requested — target={} · reason={} · options: {}",
            mesh_target_label, mesh_reason, opts
        ),
    );
    if mesh_reason == "airbox_parameter_changed" {
        eprintln!(
            "[fullmag] remesh note — airbox change requires full shared-domain remesh (ferromagnet geometry included)"
        );
        live_workspace.push_log(
            "info",
            "Airbox change requires full shared-domain remesh; ferromagnet mesh will also be regenerated",
        );
    }

    let adaptive_mesh_runtime = remesh_problem_source
        .problem_meta
        .runtime_metadata
        .get("adaptive_mesh")
        .cloned();
    let fem_plan = match &base_execution_plan.backend_plan {
        BackendPlanIR::Fem(plan) => Some(plan),
        _ => None,
    };
    let previous_periodic_mesh = remesh_problem_source
        .geometry_assets
        .as_ref()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
        .and_then(|asset| asset.mesh.clone());

    if let Some(plan) = fem_plan {
        let shared_domain_remesh = matches!(
            plan.domain_mesh_mode,
            fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
        );
        let declared_universe = fem_declared_universe(&remesh_problem_source);
        let geometry_entry = remesh_problem_source.geometry.entries.first().cloned();
        let hmax = opts
            .get("hmax")
            .and_then(|v| v.as_f64())
            .unwrap_or(plan.hmax);
        if shared_domain_remesh && mesh_reason == "airbox_parameter_changed" {
            let airbox_hmax = declared_universe
                .as_ref()
                .and_then(|value| value.airbox_hmax);
            match airbox_hmax {
                Some(airbox_hmax) if airbox_hmax > 0.0 => {
                    eprintln!(
                        "[fullmag] shared-domain remesh scope — updating airbox grading only (airbox_hmax={:.3e} m, magnetic body hmax remains {:.3e} m)",
                        airbox_hmax, hmax
                    );
                    live_workspace.push_log(
                        "info",
                        format!(
                            "Shared-domain remesh scope — airbox grading update only (airbox_hmax={:.3e}, body_hmax={:.3e})",
                            airbox_hmax, hmax
                        ),
                    );
                }
                _ => {
                    eprintln!(
                        "[fullmag] shared-domain remesh scope — rebuilding study mesh after airbox parameter change (magnetic body hmax remains {:.3e} m)",
                        hmax
                    );
                    live_workspace.push_log(
                        "info",
                        format!(
                            "Shared-domain remesh scope — airbox parameter change detected; body_hmax remains {:.3e}",
                            hmax
                        ),
                    );
                }
            }
        } else if shared_domain_remesh && mesh_reason.starts_with("object_mesh_override_changed") {
            let object_id = mesh_reason
                .strip_prefix("object_mesh_override_changed:")
                .unwrap_or("selected_object");
            let custom_override_count = opts
                .get("per_geometry")
                .and_then(|value| value.as_array())
                .map(|entries| {
                    entries
                        .iter()
                        .filter(|entry| {
                            entry
                                .get("mode")
                                .and_then(|value| value.as_str())
                                .map(|mode| mode == "custom")
                                .unwrap_or(false)
                        })
                        .count()
                })
                .unwrap_or(0);
            eprintln!(
                "[fullmag] shared-domain remesh scope — applying local object sizing for {} (custom object overrides={}, default body hmax={:.3e} m)",
                object_id, custom_override_count, hmax
            );
            live_workspace.push_log(
                "info",
                format!(
                    "Shared-domain remesh scope — local object sizing for {} (custom overrides={}, default body hmax={:.3e})",
                    object_id,
                    custom_override_count,
                    hmax
                ),
            );
        }
        eprintln!(
            "[fullmag] meshing in progress — hmax={:.3e} m, order=P{} ...",
            hmax, plan.fe_order
        );
        live_workspace.push_log(
            "info",
            format!(
                "Meshing in progress — hmax={:.3e}, order=P{}",
                hmax, plan.fe_order
            ),
        );
        let build_overlay = Arc::new(Mutex::new(CurrentMeshBuildOverlay {
            active_build: Some(manual_remesh_intent(command)),
            effective_airbox_target: None,
            effective_per_object_targets: None,
            last_build_summary: None,
            last_build_error: None,
            active_phase: Some("queued".to_string()),
            progress_percent: None,
            progress_label: None,
            attempt_index: None,
            algorithm_3d: None,
            attempt_status: None,
            attempt_failure_reason: None,
            next_algorithm_3d: None,
            progress_kind: None,
            last_recoverable_attempt: None,
            phase_started_at: Instant::now(),
            phase_durations_ms: Vec::new(),
            failed: false,
        }));
        live_workspace.update(|state| {
            let mut workspace = state
                .mesh_workspace
                .clone()
                .unwrap_or_else(|| serde_json::json!({}));
            let overlay = build_overlay
                .lock()
                .expect("mesh build overlay mutex poisoned")
                .clone();
            overlay_mesh_workspace(&mut workspace, &overlay);
            state.mesh_workspace = Some(workspace);
        });
        let remesh_progress_stage = Arc::new(Mutex::new(None::<RemeshTerminalProgress>));
        let remesh_progress_callback = Some({
            let live_workspace = live_workspace.clone();
            let remesh_progress_stage = Arc::clone(&remesh_progress_stage);
            let build_overlay = Arc::clone(&build_overlay);
            Arc::new(move |event: PythonProgressEvent| {
                let terminal_update = match &event {
                    PythonProgressEvent::Message(message) => {
                        if message.trim_start().starts_with("json:") {
                            None
                        } else {
                            match map_remesh_progress_message(message) {
                                Some(stage) => {
                                    let mut guard = remesh_progress_stage
                                        .lock()
                                        .expect("remesh progress mutex poisoned");
                                    if guard.as_ref() == Some(&stage)
                                        && !gmsh_indeterminate_heartbeat(message)
                                    {
                                        None
                                    } else {
                                        *guard = Some(stage);
                                        if let Ok(mut overlay) = build_overlay.lock() {
                                            update_mesh_overlay_from_terminal_progress(
                                                &mut overlay,
                                                stage,
                                            );
                                            let overlay_snapshot = overlay.clone();
                                            live_workspace.update(|state| {
                                                let mut workspace = state
                                                    .mesh_workspace
                                                    .clone()
                                                    .unwrap_or_else(|| serde_json::json!({}));
                                                overlay_mesh_workspace(
                                                    &mut workspace,
                                                    &overlay_snapshot,
                                                );
                                                state.mesh_workspace = Some(workspace);
                                            });
                                        }
                                        Some(match stage.percent {
                                            Some(percent) => format!(
                                                "[fullmag] remesh {percent:02}% - {}",
                                                stage.label
                                            ),
                                            None => format!(
                                                "[fullmag] remesh active (indeterminate) - {}",
                                                stage.label
                                            ),
                                        })
                                    }
                                }
                                None => Some(format!("[fullmag] remesh info - {}", message)),
                            }
                        }
                    }
                    PythonProgressEvent::FemSurfacePreview { .. } => None,
                    PythonProgressEvent::Structured { kind, payload } => {
                        if let Ok(mut overlay) = build_overlay.lock() {
                            if update_mesh_attempt_overlay_from_payload(&mut overlay, kind, payload)
                            {
                                let overlay_snapshot = overlay.clone();
                                live_workspace.update(|state| {
                                    let mut workspace = state
                                        .mesh_workspace
                                        .clone()
                                        .unwrap_or_else(|| serde_json::json!({}));
                                    overlay_mesh_workspace(&mut workspace, &overlay_snapshot);
                                    state.mesh_workspace = Some(workspace);
                                });
                            }
                        }
                        payload
                            .get("message")
                            .and_then(|value| value.as_str())
                            .map(|message| format!("[fullmag] remesh info - {}", message))
                    }
                };
                if !matches!(event, PythonProgressEvent::FemSurfacePreview { .. }) {
                    apply_python_progress_event(&live_workspace, event);
                }
                if let Some(line) = terminal_update {
                    eprintln!("{}", line);
                }
            }) as PythonProgressCallback
        });

        let remesh_attempt = if shared_domain_remesh {
            let declared_universe = declared_universe.ok_or_else(|| {
                anyhow!(
                    "shared-domain remesh requires a declared universe in domain_frame or study_universe metadata"
                )
            })?;
            let declared_universe_value = serde_json::to_value(&declared_universe)
                .context("failed to serialize declared universe for shared-domain remesh")?;
            let object_region_mesh_specs =
                shared_domain_object_region_mesh_specs(&remesh_problem_source)?;
            invoke_shared_domain_remesh_full(
                &remesh_problem_source.geometry.entries,
                &object_region_mesh_specs,
                &declared_universe_value,
                hmax,
                plan.fe_order,
                &opts,
                remesh_progress_callback,
            )
        } else {
            let geom = geometry_entry
                .as_ref()
                .ok_or_else(|| anyhow!("no geometry entry available"))?;
            invoke_remesh_full(geom, hmax, plan.fe_order, &opts, remesh_progress_callback)
        };

        match remesh_attempt {
            Ok(remesh_result) => {
                let new_mesh = remesh_result.clone().into_mesh_ir();
                if let Some(previous_mesh) = previous_periodic_mesh.as_ref() {
                    validate_periodic_remesh_candidate(previous_mesh, &new_mesh)?;
                }
                let node_count = new_mesh.nodes.len();
                let elem_count = new_mesh.cell_count();
                let face_count = new_mesh.facet_count();
                let remeshed_mesh_source = if shared_domain_remesh {
                    None
                } else {
                    plan.mesh_source.clone()
                };
                let (live_mesh_payload, remeshed_magnetization, remeshed_plan) = {
                    let mut remeshed_problem = remesh_problem_source.clone();
                    apply_current_fem_overrides(
                        &mut remeshed_problem,
                        Some(&new_mesh),
                        Some(hmax),
                        current_adaptive_runtime_state.as_ref(),
                    );
                    if shared_domain_remesh {
                        let region_markers = if remesh_result.region_markers.is_empty() {
                            default_domain_region_markers(&remeshed_problem.geometry.entries)
                        } else {
                            remesh_result.region_markers.clone()
                        };
                        let object_region_markers = resolved_shared_domain_object_region_markers(
                            &remeshed_problem,
                            &remesh_result.object_region_markers,
                        )?;
                        let domain_asset = remeshed_problem
                            .geometry_assets
                            .as_mut()
                            .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
                            .ok_or_else(|| {
                                anyhow!(
                                    "shared-domain remesh produced a domain mesh but no fem_domain_mesh_asset is attached"
                                )
                            })?;
                        domain_asset.region_markers = region_markers;
                        domain_asset.object_region_markers = object_region_markers;
                    }
                    let remeshed_plan = fullmag_plan::plan(&remeshed_problem)
                        .map_err(|error| anyhow!(error.to_string()))?;
                    let magnetization =
                        current_stage_magnetization_vectors(None, &remeshed_plan.backend_plan);
                    let mesh_payload =
                        fem_mesh_payload_from_backend_plan(&remeshed_plan.backend_plan)
                            .ok_or_else(|| {
                                anyhow!("updated backend plan did not produce a FEM mesh payload")
                            })?;
                    (mesh_payload, magnetization, remeshed_plan)
                };
                let prepared_remesh = prepare_remesh_stage_transaction(
                    stages,
                    stage_execution_plans,
                    scene_problem_patch.as_ref(),
                    &new_mesh,
                    hmax,
                    shared_domain_remesh,
                    &remesh_result.region_markers,
                    &remesh_result.object_region_markers,
                    current_adaptive_runtime_state.as_ref(),
                    Some(remeshed_plan.clone()),
                )?;
                let plan_summary = prepared_remesh.stages[0]
                    .ir
                    .plan_for(backend_override)
                    .map_err(join_errors)?;
                let runtime = if prepare_runtime {
                    Some(InteractiveRuntimeHost::prepare_base_problem(
                        prepared_remesh.stages[0].ir.clone(),
                        &prepared_remesh.stage_execution_plans[0].backend_plan,
                    )?)
                } else {
                    None
                };
                *current_mesh_quality = remesh_result.quality.clone();
                *current_fem_mesh_override = Some(new_mesh.clone());
                *current_fem_hmax_override = Some(hmax);
                stages.clone_from_slice(&prepared_remesh.stages);
                stage_execution_plans.clone_from_slice(&prepared_remesh.stage_execution_plans);
                current_mesh_history.push(serde_json::json!({
                    "command_id": command.command_id,
                    "build_id": format!("mesh:{}", command.command_id),
                    "state_policy": MESH_STATE_POLICY,
                    "canonical_policy_snapshot": opts.get("canonical_policy_snapshot"),
                    "mesh_options": opts,
                    "status": "completed",
                    "mesh_generation_id": live_mesh_payload.generation_id,
                    "mesh_name": new_mesh.mesh_name,
                    "generation_mode": remesh_result.generation_mode,
                    "node_count": node_count,
                    "element_count": elem_count,
                    "boundary_face_count": face_count,
                    "quality": remesh_result.quality.as_ref().map(|quality| serde_json::json!({
                        "sicn_p5": quality.sicn_p5,
                        "gamma_min": quality.gamma_min,
                        "avg_quality": quality.avg_quality,
                    })),
                    "mesh_target": mesh_target_label.clone(),
                    "mesh_reason": mesh_reason,
                    "mesh_provenance": remesh_result.mesh_provenance.clone(),
                    "mesh_statistics": remesh_result.mesh_statistics.clone(),
                    "size_field_stats": remesh_result.size_field_stats.clone(),
                    "quality_data_artifact": remesh_result.quality_data_artifact.clone(),
                }));
                let mut candidate_state = live_workspace.snapshot();
                {
                    let state = &mut candidate_state;
                    state.live_state.latest_step.fem_mesh_generation_id =
                        live_mesh_payload.generation_id.clone();
                    state.fem_mesh = Some(live_mesh_payload);
                    state.live_state.latest_step.magnetization =
                        Some(flatten_magnetization(&remeshed_magnetization));
                    let mut workspace = current_fem_mesh_workspace(
                        &remesh_problem_source,
                        &new_mesh,
                        remeshed_mesh_source.as_deref(),
                        plan.fe_order,
                        hmax,
                        workspace_status,
                        adaptive_mesh_runtime.as_ref(),
                        current_adaptive_runtime_state.as_ref(),
                        current_mesh_quality.as_ref(),
                        remesh_result.quality_data_artifact.as_ref(),
                        remesh_result.mesh_statistics.as_ref(),
                        current_mesh_history,
                    );
                    let provenance = remesh_result
                        .mesh_provenance
                        .as_ref()
                        .and_then(|value| value.as_object());
                    let summary = serde_json::json!({
                        "kind": "mesh_build_summary",
                        "command_id": command.command_id,
                        "build_id": format!("mesh:{}", command.command_id),
                        "state_policy": MESH_STATE_POLICY,
                        "canonical_policy_snapshot": opts.get("canonical_policy_snapshot"),
                        "mesh_options": opts,
                        "status": "completed",
                        "mesh_generation_id": state.live_state.latest_step.fem_mesh_generation_id,
                        "mesh_target": mesh_target_label.clone(),
                        "mesh_reason": mesh_reason,
                        "geometry_realization": mesh_geometry_realization_json(&opts),
                        "source_scene_revision": opts
                            .get("geometry_realization")
                            .and_then(|value| value.get("source_scene_revision"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "realization_revision": opts
                            .get("geometry_realization")
                            .and_then(|value| value.get("realization_revision"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "shared_domain_build_mode": provenance
                            .and_then(|value| value.get("shared_domain_build_mode"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "effective_airbox_target": provenance
                            .and_then(|value| value.get("effective_airbox_target"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "effective_per_object_targets": provenance
                            .and_then(|value| value.get("effective_per_object_targets"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "used_size_field_kinds": provenance
                            .and_then(|value| value.get("used_size_field_kinds"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!([])),
                        "fallbacks_triggered": provenance
                            .and_then(|value| value.get("fallbacks_triggered"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!([])),
                        "operation_statuses": provenance
                            .and_then(|value| value.get("operation_statuses"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!([])),
                        "thin_film_diagnostics": provenance
                            .and_then(|value| value.get("thin_film_diagnostics"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!([])),
                        "shared_domain_build_report": provenance
                            .and_then(|value| value.get("shared_domain_build_report"))
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                        "mesh_statistics": remesh_result
                            .mesh_statistics
                            .clone()
                            .unwrap_or(serde_json::Value::Null),
                        "n_nodes": node_count,
                        "n_elements": elem_count,
                        "n_boundary_faces": face_count,
                    });
                    if let Ok(mut overlay) = build_overlay.lock() {
                        overlay.active_build = None;
                        overlay.effective_airbox_target = provenance
                            .and_then(|value| value.get("effective_airbox_target"))
                            .cloned();
                        overlay.effective_per_object_targets = provenance
                            .and_then(|value| value.get("effective_per_object_targets"))
                            .cloned();
                        overlay.last_build_summary = Some(summary);
                        overlay.last_build_error = None;
                        transition_mesh_build_phase(&mut overlay, "ready");
                        overlay.progress_percent = Some(100);
                        overlay.progress_label = Some("mesh ready".to_string());
                        overlay.failed = false;
                        let overlay_snapshot = overlay.clone();
                        overlay_mesh_workspace(&mut workspace, &overlay_snapshot);
                    }
                    state.mesh_workspace = Some(workspace);
                }
                Ok(PreparedRemeshPublication {
                    state: candidate_state,
                    plan_summary,
                    runtime,
                })
            }
            Err(error) => Err(error),
        }
    } else {
        bail!("FDM grid changes require a separate runtime replan")
    }
}
