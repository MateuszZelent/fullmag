//! POST /v2/sessions/current/simulation/commands — submit a command.

use std::path::Path;
use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

use crate::error::ApiError;
use crate::router_v2::handlers::sessions::status::domain_generation_id;
use crate::schemas::commands::{
    CommandResponse, RuntimeCommandIntent, RuntimeCommandPrecondition, RuntimeCommandTarget,
    SolverPolicyRequest, StructuredCommandRequest, FDM_GRID_REFRESH_DEFERRED_REASON,
};
use crate::schemas::runtime::FieldMaterializationRequirement;
use crate::session::effective_runtime_status_code;
use crate::types::{
    AppState, CommandLifecycleState, SessionCommand, SessionStateResponse, TrackedCommandRecord,
};
use fullmag_authoring::{
    geometry_blocks_solver_run, realize_geometry_scene, GeometryBackendTarget,
    GeometryRealizationSnapshot, SceneDocument, SceneGeometry, SceneObject,
};
use fullmag_ir::{
    GeometryEntryIR, InitialMagnetizationIR, MagnetIR, MaterialIR, ObjectRegionIR, RegionIR,
};
use fullmag_quantities::quantity_spec;

use crate::schemas::relaxation::MU0_T_PER_APM;

#[utoipa::path(
    post,
    path = "/v2/sessions/current/simulation/commands",
    request_body = StructuredCommandRequest,
    responses(
        (status = 200, description = "Command accepted", body = CommandResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "simulation"
)]
pub async fn submit_command(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<StructuredCommandRequest>,
) -> Result<Json<CommandResponse>, ApiError> {
    let response = submit_structured_command_impl(state, &headers, req).await?;
    Ok(Json(response))
}

pub(crate) async fn submit_structured_command_impl(
    state: Arc<AppState>,
    headers: &HeaderMap,
    mut req: StructuredCommandRequest,
) -> Result<CommandResponse, ApiError> {
    enforce_session_command_admission(&state).await?;
    validate_relax_command_controls(&req)?;
    validate_solver_policy_controls(&req)?;
    if request_has_adaptive_solver_policy(&req) {
        if let Some(scene) = current_authoring_gate_scene(&state).await? {
            validate_solver_policy_lane(
                &req,
                &scene.study.requested_backend,
                &scene.study.requested_device,
                &scene.study.requested_precision,
            )?;
        }
    }
    if let Some((scene, realization)) = validate_authoring_gate_for_command(&state, &req).await? {
        attach_geometry_realization_to_mesh_request(&mut req, &scene, &realization)?;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let command_id = format!("fm-{}", uuid::Uuid::new_v4());
    let mut command = command_from_structured(req, command_id, now);
    attach_frozen_spins_runtime_plan_binding(&state, &mut command).await?;
    if command.kind == "fdm_grid_refresh" {
        let reason = fdm_grid_refresh_rejection_reason(&state).await?;
        return reject_session_command_impl(state, headers, command, reason).await;
    }
    validate_runtime_command_contract(&state, &command).await?;
    enqueue_session_command_impl(state, headers, command).await
}

async fn enforce_session_command_admission(state: &Arc<AppState>) -> Result<(), ApiError> {
    let terminal_status = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let effective = effective_runtime_status_code(snapshot);
        let terminal_status = [effective.as_str(), snapshot.session.status.as_str()]
            .into_iter()
            .find(|status| matches!(*status, "completed" | "failed" | "cancelled" | "closed"))
            .map(str::to_string);
        terminal_status
    };
    if let Some(status) = terminal_status {
        return Err(ApiError::conflict(format!(
            "session_{status}_read_only: terminal sessions reject all mutating commands"
        )));
    }

    let connectivity =
        crate::router_v2::handlers::sessions::status::refresh_current_live_connectivity(state)
            .await;
    let connectivity_code = match connectivity {
        crate::schemas::status::SessionConnectivity::Connected => None,
        crate::schemas::status::SessionConnectivity::Degraded => Some("degraded"),
        crate::schemas::status::SessionConnectivity::Disconnected => Some("disconnected"),
    };
    if let Some(connectivity_code) = connectivity_code {
        return Err(ApiError::conflict(format!(
            "session_connectivity_{connectivity_code}: mutating commands require a connected runner publication path"
        )));
    }
    Ok(())
}

async fn fdm_grid_refresh_rejection_reason(state: &Arc<AppState>) -> Result<String, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    if !crate::router_v2::handlers::data::field_resolution::is_fdm_snapshot(snapshot) {
        return Ok("FDM grid refresh is only applicable to an FDM structured-grid session.".into());
    }
    Ok(FDM_GRID_REFRESH_DEFERRED_REASON.into())
}

fn request_has_adaptive_solver_policy(req: &StructuredCommandRequest) -> bool {
    matches!(
        req,
        StructuredCommandRequest::Run {
            solver_policy: Some(
                SolverPolicyRequest::AdaptiveMaxError { .. }
                    | SolverPolicyRequest::AdaptiveAdvanced { .. }
            ),
            ..
        } | StructuredCommandRequest::Relax {
            solver_policy: Some(
                SolverPolicyRequest::AdaptiveMaxError { .. }
                    | SolverPolicyRequest::AdaptiveAdvanced { .. }
            ),
            ..
        }
    )
}

fn validate_solver_policy_lane(
    req: &StructuredCommandRequest,
    requested_backend: &str,
    requested_device: &str,
    requested_precision: &str,
) -> Result<(), ApiError> {
    if request_has_adaptive_solver_policy(req) && requested_precision != "double" {
        return Err(ApiError::bad_request(
            "Adaptive execution is qualified only for double precision",
        ));
    }
    if request_has_adaptive_solver_policy(req)
        && requested_backend != "fem"
        && requested_device != "cpu"
    {
        return Err(ApiError::bad_request(
            "Adaptive FDM execution requires an explicit CPU device; auto/gpu may select the non-lossless CUDA ABI",
        ));
    }
    Ok(())
}

fn validate_solver_policy_controls(req: &StructuredCommandRequest) -> Result<(), ApiError> {
    let (solver_policy, legacy_integrator, legacy_fixed, legacy_max_error) = match req {
        StructuredCommandRequest::Run {
            solver_policy,
            integrator,
            fixed_timestep,
            ..
        } => (solver_policy, integrator, fixed_timestep, &None),
        StructuredCommandRequest::Relax {
            solver_policy,
            fixed_timestep,
            max_error,
            ..
        } => (solver_policy, &None, fixed_timestep, max_error),
        _ => return Ok(()),
    };
    let Some(policy) = solver_policy else {
        return Ok(());
    };
    if legacy_integrator.is_some() || legacy_fixed.is_some() || legacy_max_error.is_some() {
        return Err(ApiError::bad_request(
            "legacy integrator/fixed_timestep/max_error controls cannot be mixed with solver_policy",
        ));
    }

    match policy {
        SolverPolicyRequest::Fixed { fix_dt, .. } => {
            require_positive_finite("solver_policy.fix_dt", *fix_dt)?;
        }
        SolverPolicyRequest::AdaptiveMaxError {
            dt_initial,
            dt_min,
            dt_max,
            max_err,
            ..
        } => {
            validate_adaptive_bounds(*dt_initial, *dt_min, *dt_max)?;
            require_positive_finite("solver_policy.max_err", *max_err)?;
        }
        SolverPolicyRequest::AdaptiveAdvanced {
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
            ..
        } => {
            validate_adaptive_bounds(*dt_initial, *dt_min, *dt_max)?;
            if !atol.is_finite()
                || !rtol.is_finite()
                || *atol < 0.0
                || *rtol < 0.0
                || (*atol == 0.0 && *rtol == 0.0)
            {
                return Err(ApiError::bad_request(
                    "advanced solver_policy requires finite nonnegative atol/rtol with at least one positive tolerance",
                ));
            }
            if !safety.is_finite() || *safety <= 0.0 || *safety > 1.0 {
                return Err(ApiError::bad_request(
                    "solver_policy.safety must be finite and in (0, 1]",
                ));
            }
            if !growth_limit.is_finite() || *growth_limit <= 1.0 {
                return Err(ApiError::bad_request(
                    "solver_policy.growth_limit must be finite and greater than one",
                ));
            }
            if !shrink_limit.is_finite() || *shrink_limit <= 0.0 || *shrink_limit >= 1.0 {
                return Err(ApiError::bad_request(
                    "solver_policy.shrink_limit must be finite and in (0, 1)",
                ));
            }
            for (name, value) in [
                ("solver_policy.max_spin_rotation", max_spin_rotation),
                ("solver_policy.norm_tolerance", norm_tolerance),
            ] {
                if let Some(value) = value {
                    require_positive_finite(name, *value)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_adaptive_bounds(
    dt_initial: Option<f64>,
    dt_min: f64,
    dt_max: f64,
) -> Result<(), ApiError> {
    require_positive_finite("solver_policy.dt_min", dt_min)?;
    require_positive_finite("solver_policy.dt_max", dt_max)?;
    if dt_max < dt_min {
        return Err(ApiError::bad_request(
            "solver_policy.dt_max must be greater than or equal to dt_min",
        ));
    }
    if let Some(value) = dt_initial {
        require_positive_finite("solver_policy.dt_initial", value)?;
        if value < dt_min || value > dt_max {
            return Err(ApiError::bad_request(
                "solver_policy.dt_initial must lie within [dt_min, dt_max]",
            ));
        }
    }
    Ok(())
}

fn require_positive_finite(name: &str, value: f64) -> Result<(), ApiError> {
    if !value.is_finite() || value <= 0.0 {
        return Err(ApiError::bad_request(format!(
            "{name} must be finite and greater than zero"
        )));
    }
    Ok(())
}

fn validate_relax_command_controls(req: &StructuredCommandRequest) -> Result<(), ApiError> {
    let StructuredCommandRequest::Relax {
        until_seconds,
        max_relaxation_time_s,
        max_steps,
        torque_tolerance_apm,
        torque_tolerance_t,
        torque_tolerance,
        energy_tolerance,
        energy_tolerance_j,
        relax_algorithm,
        relax_alpha,
        fixed_timestep,
        max_error,
        solver_policy,
        ..
    } = req
    else {
        return Ok(());
    };

    for (name, value) in [
        ("torque_tolerance_apm", *torque_tolerance_apm),
        ("torque_tolerance_T", *torque_tolerance_t),
        ("torque_tolerance", *torque_tolerance),
        ("energy_tolerance_j", *energy_tolerance_j),
        ("energy_tolerance", *energy_tolerance),
        ("max_relaxation_time_s", *max_relaxation_time_s),
        ("until_seconds", *until_seconds),
        ("relax_alpha", *relax_alpha),
        ("fixed_timestep", *fixed_timestep),
        ("max_error", *max_error),
    ] {
        if value.is_some_and(|value| !value.is_finite() || value <= 0.0) {
            return Err(ApiError::bad_request(format!(
                "{name} must be finite and greater than zero"
            )));
        }
    }
    if max_steps.is_some_and(|value| value == 0) {
        return Err(ApiError::bad_request("max_steps must be greater than zero"));
    }

    let torque_tolerance_t_apm = torque_tolerance_t.map(|value| value / MU0_T_PER_APM);
    if torque_tolerance_t_apm.is_some_and(|value| !value.is_finite()) {
        return Err(ApiError::bad_request(
            "torque_tolerance_T does not convert to a finite A/m value",
        ));
    }
    let torque_values_apm = [
        *torque_tolerance_apm,
        *torque_tolerance,
        torque_tolerance_t_apm,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if torque_values_apm
        .windows(2)
        .any(|pair| !physically_equal(pair[0], pair[1]))
    {
        return Err(ApiError::bad_request(
            "torque_tolerance_apm, torque_tolerance_T, and deprecated torque_tolerance conflict",
        ));
    }

    if until_seconds.is_some()
        && max_relaxation_time_s.is_some()
        && !physically_equal(
            until_seconds.unwrap_or_default(),
            max_relaxation_time_s.unwrap_or_default(),
        )
    {
        return Err(ApiError::bad_request(
            "max_relaxation_time_s conflicts with deprecated until_seconds",
        ));
    }
    if energy_tolerance.is_some()
        && energy_tolerance_j.is_some()
        && !physically_equal(
            energy_tolerance.unwrap_or_default(),
            energy_tolerance_j.unwrap_or_default(),
        )
    {
        return Err(ApiError::bad_request(
            "energy_tolerance_j conflicts with deprecated energy_tolerance",
        ));
    }

    let is_llg = relax_algorithm.as_ref().is_none_or(|algorithm| {
        matches!(
            algorithm,
            crate::schemas::relaxation::RelaxationAlgorithm::LlgOverdamped
        )
    });
    if !is_llg
        && (until_seconds.is_some()
            || max_relaxation_time_s.is_some()
            || relax_alpha.is_some()
            || fixed_timestep.is_some()
            || max_error.is_some()
            || solver_policy.is_some())
    {
        return Err(ApiError::bad_request(
            "max_relaxation_time_s, relax_alpha, fixed_timestep, max_error, and solver_policy are valid only for llg_overdamped relaxation",
        ));
    }
    Ok(())
}

fn physically_equal(left: f64, right: f64) -> bool {
    let scale = left.abs().max(right.abs()).max(f64::MIN_POSITIVE);
    (left - right).abs() <= 16.0 * f64::EPSILON * scale
}

async fn validate_runtime_command_contract(
    state: &Arc<AppState>,
    command: &SessionCommand,
) -> Result<(), ApiError> {
    let snapshot = {
        let guard = state.current_live_state.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?
    };

    if let Some(precondition) = command.precondition.as_ref() {
        let runtime_state = runtime_state_for_command_validation(&snapshot);
        if precondition
            .runtime_state
            .as_deref()
            .is_some_and(|expected| expected != runtime_state.as_str())
        {
            return Err(ApiError::conflict(format!(
                "runtime_state precondition failed: expected {}, got {}",
                precondition.runtime_state.as_deref().unwrap_or_default(),
                runtime_state
            )));
        }

        if let Some(expected) = precondition.stage_execution_revision {
            if snapshot.stage_execution.is_none() || snapshot.state_version != expected {
                return Err(ApiError::conflict(format!(
                    "stage_execution_revision precondition failed: expected {}, got {}",
                    expected,
                    if snapshot.stage_execution.is_some() {
                        snapshot.state_version
                    } else {
                        0
                    }
                )));
            }
        }

        if let Some(expected) = precondition.mesh_revision {
            if snapshot.mesh_revision != expected {
                return Err(ApiError::conflict(format!(
                    "mesh_revision precondition failed: expected {}, got {}",
                    expected, snapshot.mesh_revision
                )));
            }
        }

        let region_revisions = snapshot.region_realization_revisions;
        for (name, expected, actual) in [
            (
                "region_topology_revision",
                precondition.region_topology_revision,
                region_revisions.topology,
            ),
            (
                "region_membership_revision",
                precondition.region_membership_revision,
                region_revisions.membership,
            ),
            (
                "region_coefficients_revision",
                precondition.region_coefficients_revision,
                region_revisions.coefficients,
            ),
            (
                "region_initial_state_revision",
                precondition.region_initial_state_revision,
                region_revisions.initial_state,
            ),
        ] {
            if let Some(expected) = expected {
                if actual != expected {
                    return Err(ApiError::conflict(format!(
                        "{name} precondition failed: expected {expected}, got {actual}"
                    )));
                }
            }
        }

        if let Some(expected) = precondition.scene_revision {
            let actual = snapshot.scene_document.as_ref().map(|scene| scene.revision);
            if actual != Some(expected) {
                return Err(ApiError::conflict(format!(
                    "scene_revision precondition failed: expected {}, got {}",
                    expected,
                    actual
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "missing".to_string())
                )));
            }
        }

        if let Some(expected) = precondition.command_revision {
            let actual = state.current_command_ledger.lock().await.len() as u64;
            if actual != expected {
                return Err(ApiError::conflict(format!(
                    "command_revision precondition failed: expected {}, got {}",
                    expected, actual
                )));
            }
        }
    }

    if is_stage_control_command(command.kind.as_str()) {
        validate_stage_control_state(&snapshot, command)?;
        validate_stage_control_target(&snapshot, command)?;
    }

    Ok(())
}

async fn attach_frozen_spins_runtime_plan_binding(
    state: &Arc<AppState>,
    command: &mut SessionCommand,
) -> Result<(), ApiError> {
    if !matches!(
        command.kind.as_str(),
        "run" | "relax" | "solve" | "apply_frozen_spins"
    ) {
        return Ok(());
    }

    let scene = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .and_then(|snapshot| snapshot.scene_document.clone());
    let Some(scene) = scene else {
        return Ok(());
    };

    let precondition = command.precondition.get_or_insert_with(Default::default);
    if let Some(expected) = precondition.scene_revision {
        if expected != scene.revision {
            return Err(ApiError::conflict(format!(
                "scene_revision precondition failed while binding frozen spins: expected {expected}, got {}",
                scene.revision
            )));
        }
    } else {
        precondition.scene_revision = Some(scene.revision);
    }

    command.frozen_spins_runtime_plan_binding = Some(fullmag_ir::FrozenSpinsRuntimePlanBindingIR {
        schema_version: fullmag_ir::FROZEN_SPINS_RUNTIME_PLAN_BINDING_SCHEMA_VERSION.to_string(),
        launch_command_id: command.command_id.clone(),
        source_scene_revision: scene.revision,
        selection_definitions: scene.selections,
        magnetization_constraints: scene.magnetization_constraints,
    });
    Ok(())
}

pub(crate) async fn enqueue_frozen_spins_runtime_replan_if_running(
    state: &Arc<AppState>,
    source_scene_revision: u64,
) -> Option<String> {
    let is_running = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .is_some_and(|snapshot| runtime_state_for_command_validation(snapshot) == "running");
    if !is_running {
        return None;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let command_id = format!("fm-frozen-replan-{}", uuid::Uuid::new_v4());
    let mut command = new_session_command(command_id.clone(), "apply_frozen_spins", now);
    command.target = Some(RuntimeCommandTarget::CurrentStage { stage_id: None });
    command.reason = Some("frozen_spins_authoring_commit".to_string());
    command.precondition = Some(RuntimeCommandPrecondition {
        scene_revision: Some(source_scene_revision),
        runtime_state: Some("running".to_string()),
        ..Default::default()
    });

    if let Err(error) = attach_frozen_spins_runtime_plan_binding(state, &mut command).await {
        eprintln!(
            "[fullmag-api] frozen spins runtime replan was not queued: {}",
            error.message
        );
        return None;
    }
    if let Err(error) = validate_runtime_command_contract(state, &command).await {
        eprintln!(
            "[fullmag-api] frozen spins runtime replan validation failed: {}",
            error.message
        );
        return None;
    }

    let headers = HeaderMap::new();
    match enqueue_session_command_impl(Arc::clone(state), &headers, command).await {
        Ok(response) => Some(response.command_id),
        Err(error) => {
            let was_queued = state
                .current_command_ledger
                .lock()
                .await
                .iter()
                .any(|record| record.command.command_id == command_id);
            eprintln!(
                "[fullmag-api] frozen spins runtime replan publication warning: {}",
                error.message
            );
            was_queued.then_some(command_id)
        }
    }
}

fn is_stage_control_command(kind: &str) -> bool {
    matches!(kind, "pause" | "resume" | "stop" | "skip")
}

fn validate_stage_control_state(
    snapshot: &crate::types::SessionStateResponse,
    command: &SessionCommand,
) -> Result<(), ApiError> {
    let runtime_state = runtime_state_for_command_validation(snapshot);
    let allowed = match command.kind.as_str() {
        "pause" => runtime_state == "running",
        "resume" => runtime_state == "paused",
        "stop" => runtime_state == "running" || runtime_state == "paused",
        "skip" => runtime_state == "running" || runtime_state == "paused",
        _ => true,
    };
    if !allowed {
        return Err(ApiError::conflict(format!(
            "{} command requires a compatible runtime state; got {}",
            command.kind, runtime_state
        )));
    }

    if command.kind == "skip" && active_stage_index(snapshot).is_none() {
        return Err(ApiError::conflict(
            "skip command requires an active stage target",
        ));
    }

    Ok(())
}

fn validate_stage_control_target(
    snapshot: &crate::types::SessionStateResponse,
    command: &SessionCommand,
) -> Result<(), ApiError> {
    let active_index = active_stage_index(snapshot);
    let Some(target) = command.target.as_ref() else {
        return Ok(());
    };

    match target {
        RuntimeCommandTarget::CurrentStage { stage_id } => {
            validate_current_stage_target(active_index, stage_id.as_deref())
        }
        RuntimeCommandTarget::StageIndex { stage_index } => {
            validate_stage_index_target(active_index, *stage_index)
        }
        RuntimeCommandTarget::StageId { stage_id } => {
            validate_current_stage_target(active_index, Some(stage_id.as_str()))
        }
        RuntimeCommandTarget::Study
        | RuntimeCommandTarget::Run { .. }
        | RuntimeCommandTarget::CommandId { .. } => Err(ApiError::conflict(format!(
            "{} command target must reference the active stage",
            command.kind
        ))),
    }
}

fn validate_current_stage_target(
    active_index: Option<usize>,
    stage_id: Option<&str>,
) -> Result<(), ApiError> {
    let Some(active_index) = active_index else {
        return Err(ApiError::conflict(
            "stage control command requires an active stage",
        ));
    };
    if let Some(stage_id) = stage_id {
        let expected = stage_id_for_command_validation(active_index);
        if stage_id != expected {
            return Err(ApiError::conflict(format!(
                "stage target mismatch: expected {}, got {}",
                expected, stage_id
            )));
        }
    }
    Ok(())
}

fn validate_stage_index_target(
    active_index: Option<usize>,
    requested_index: u32,
) -> Result<(), ApiError> {
    let Some(active_index) = active_index else {
        return Err(ApiError::conflict(
            "stage control command requires an active stage",
        ));
    };
    if active_index as u32 != requested_index {
        return Err(ApiError::conflict(format!(
            "stage target mismatch: expected stage_index {}, got {}",
            active_index, requested_index
        )));
    }
    Ok(())
}

fn active_stage_index(snapshot: &crate::types::SessionStateResponse) -> Option<usize> {
    snapshot
        .stage_execution
        .as_ref()
        .and_then(|stage| stage.active_stage_index)
}

fn runtime_state_for_command_validation(snapshot: &crate::types::SessionStateResponse) -> String {
    effective_runtime_status_code(snapshot)
}

fn stage_id_for_command_validation(index: usize) -> String {
    format!("stage-{index:03}")
}

async fn validate_authoring_gate_for_command(
    state: &Arc<AppState>,
    req: &StructuredCommandRequest,
) -> Result<Option<(SceneDocument, GeometryRealizationSnapshot)>, ApiError> {
    let should_check_mesh = matches!(req, StructuredCommandRequest::MeshBuild { .. });
    let should_check_run = matches!(
        req,
        StructuredCommandRequest::Run { .. }
            | StructuredCommandRequest::Relax { .. }
            | StructuredCommandRequest::Solve { .. }
            | StructuredCommandRequest::ComputeFields { .. }
            | StructuredCommandRequest::ComputeEnergies { .. }
    );
    if !should_check_mesh && !should_check_run {
        return Ok(None);
    }
    let Some(scene) = current_authoring_gate_scene(state).await? else {
        return Ok(None);
    };
    let backend_target = GeometryBackendTarget::from_scene(&scene);
    if should_check_mesh {
        let realization = realize_geometry_scene(&scene, backend_target);
        if realization.status == "blocked" {
            let reason = realization
                .diagnostics
                .iter()
                .find(|diagnostic| diagnostic.blocks.iter().any(|block| block == "build_mesh"))
                .map(|diagnostic| diagnostic.message.clone())
                .unwrap_or_else(|| "Geometry realization is blocked.".to_string());
            return Err(ApiError::bad_request(reason));
        }
        return Ok(Some((scene, realization)));
    }
    for object in fullmag_authoring::scene_solve_objects(&scene) {
        fullmag_authoring::resolve_scene_object_solve_material(&scene, object)
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
    }
    if let Some(reason) = geometry_blocks_solver_run(&scene, backend_target) {
        return Err(ApiError::conflict(reason));
    }
    Ok(None)
}

async fn current_authoring_gate_scene(
    state: &Arc<AppState>,
) -> Result<Option<fullmag_authoring::SceneDocument>, ApiError> {
    let script_path = {
        let current = state.current_live_state.read().await;
        let Some(snapshot) = current.as_ref() else {
            return Err(ApiError::not_found("no active local live workspace"));
        };
        if let Some(scene) = snapshot.scene_document.clone() {
            return Ok(Some(scene));
        }
        snapshot.session.script_path.trim().to_string()
    };

    if script_path.is_empty() || !Path::new(&script_path).is_file() {
        return Ok(None);
    }

    match crate::get_or_load_current_live_scene_document(state).await {
        Ok(scene) => Ok(Some(scene)),
        Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => Ok(None),
        Err(error) => Err(error),
    }
}

fn attach_geometry_realization_to_mesh_request(
    req: &mut StructuredCommandRequest,
    scene: &SceneDocument,
    realization: &GeometryRealizationSnapshot,
) -> Result<(), ApiError> {
    let StructuredCommandRequest::MeshBuild { mesh_options, .. } = req else {
        return Ok(());
    };
    let mut options = mesh_options.take().unwrap_or_else(|| serde_json::json!({}));
    if !options.is_object() {
        options = serde_json::json!({ "user_options": options });
    }
    let Some(options_object) = options.as_object_mut() else {
        return Err(ApiError::internal("failed to prepare mesh options payload"));
    };
    options_object.insert(
        "geometry_realization".to_string(),
        serde_json::json!({
            "source_scene_revision": realization.source_scene_revision,
            "realization_revision": realization.realization_revision,
            "backend_target": realization.backend_target,
            "status": realization.status,
        }),
    );
    options_object.insert(
        "source_scene_revision".to_string(),
        serde_json::json!(realization.source_scene_revision),
    );
    if !options_object.contains_key("per_geometry") {
        if let Some(per_geometry) = scene_per_geometry_mesh_options(scene)? {
            options_object.insert("per_geometry".to_string(), per_geometry);
        }
    }
    options_object.insert(
        "scene_problem_patch".to_string(),
        scene_problem_patch_for_mesh(scene)?,
    );
    *mesh_options = Some(options);
    Ok(())
}

fn scene_per_geometry_mesh_options(
    scene: &SceneDocument,
) -> Result<Option<serde_json::Value>, ApiError> {
    let mut entries = Vec::new();

    for object in &scene.objects {
        let Some(mesh) = object
            .object_mesh
            .as_ref()
            .or(object.mesh_override.as_ref())
        else {
            continue;
        };
        let mut value = serde_json::to_value(mesh).map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize mesh policy for object '{}': {error}",
                object.id
            ))
        })?;
        let Some(map) = value.as_object_mut() else {
            return Err(ApiError::internal(format!(
                "mesh policy for object '{}' did not serialize as an object",
                object.id
            )));
        };
        map.insert(
            "geometry".to_string(),
            serde_json::Value::String(object.id.clone()),
        );
        map.insert(
            "geometry_name".to_string(),
            serde_json::Value::String(object.id.clone()),
        );
        map.insert(
            "object_id".to_string(),
            serde_json::Value::String(object.id.clone()),
        );
        entries.push(value);
    }

    if entries.is_empty() {
        Ok(None)
    } else {
        Ok(Some(serde_json::Value::Array(entries)))
    }
}

fn scene_problem_patch_for_mesh(scene: &SceneDocument) -> Result<serde_json::Value, ApiError> {
    let mut geometry_entries = Vec::with_capacity(scene.objects.len());
    let mut regions = Vec::with_capacity(scene.objects.len());
    let mut materials = Vec::with_capacity(scene.objects.len());
    let mut magnets = Vec::with_capacity(scene.objects.len());

    let mut object_regions = Vec::new();

    for object in fullmag_authoring::scene_solve_objects(scene) {
        let geometry_name = object.id.clone();
        let region_name = object.id.clone();
        let material_name = format!("material:{}", object.id);
        let material = fullmag_authoring::resolve_scene_object_solve_material(scene, object)
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        let material_asset = material.asset;

        geometry_entries.push(scene_object_geometry_entry(object, &geometry_name)?);
        regions.push(RegionIR {
            geometry: geometry_name,
            name: region_name.clone(),
        });
        for region in &object.regions {
            let ir: ObjectRegionIR = region.clone().into();
            object_regions.push(ir);
        }
        materials.push(MaterialIR {
            alpha_field: None,
            a_field: None,
            cubic_anisotropy_axis1: None,
            cubic_anisotropy_axis2: None,
            cubic_anisotropy_kc1: None,
            cubic_anisotropy_kc2: None,
            cubic_anisotropy_kc3: None,
            damping: material_asset.properties.alpha,
            exchange_stiffness: material.exchange_stiffness,
            kc1_field: None,
            kc2_field: None,
            kc3_field: None,
            ku2_field: None,
            ku_field: None,
            ms_field: None,
            name: material_name.clone(),
            saturation_magnetisation: material.saturation_magnetisation,
            uniaxial_anisotropy: None,
            uniaxial_anisotropy_k2: None,
            anisotropy_axis: None,
            interfacial_dmi: material_asset.properties.dind,
            bulk_dmi: material_asset.properties.dbulk,
            dind_field: None,
            dbulk_field: None,
        });
        magnets.push(MagnetIR {
            object_id: Some(object.id.clone()),
            absorbing_boundary: None,
            initial_magnetization: Some(initial_magnetization_for_object(scene, object)),
            material: material_name,
            name: object.id.clone(),
            region: region_name,
        });
    }

    Ok(serde_json::json!({
        "geometry_entries": geometry_entries,
        "magnets": magnets,
        "materials": materials,
        "regions": regions,
        "object_regions": object_regions,
        "source_scene_revision": scene.revision,
        "universe": study_universe_for_problem_patch(scene)?,
    }))
}

fn study_universe_for_problem_patch(
    scene: &SceneDocument,
) -> Result<Option<serde_json::Value>, ApiError> {
    let Some(universe) = scene
        .study
        .universe_mesh
        .as_ref()
        .or(scene.universe.as_ref())
    else {
        return Ok(None);
    };
    let mut value = serde_json::to_value(universe).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize scene universe for mesh patch: {error}"
        ))
    })?;
    if let Some(object) = value.as_object_mut() {
        let mode = object
            .get("mode")
            .and_then(|candidate| candidate.as_str())
            .unwrap_or("auto");
        if mode == "box" {
            object.insert(
                "mode".to_string(),
                serde_json::Value::String("manual".to_string()),
            );
        }
    }
    Ok(Some(value))
}

fn scene_object_geometry_entry(
    object: &SceneObject,
    geometry_name: &str,
) -> Result<GeometryEntryIR, ApiError> {
    if !is_identity_quat(object.transform.rotation_quat) {
        return Err(ApiError::bad_request(format!(
            "mesh build cannot lower rotated object '{}' into ProblemIR yet",
            object.id
        )));
    }
    if !is_unit_scale(object.transform.scale) {
        return Err(ApiError::bad_request(format!(
            "mesh build cannot lower scaled object '{}' into ProblemIR yet",
            object.id
        )));
    }

    let base = scene_geometry_entry(&object.geometry, geometry_name, &object.id)?;

    if is_zero_vec3(object.transform.translation) {
        Ok(base)
    } else {
        Ok(GeometryEntryIR::Translate {
            base: Box::new(base),
            by: object.transform.translation,
            name: geometry_name.to_string(),
        })
    }
}

fn scene_geometry_entry(
    geometry: &SceneGeometry,
    geometry_name: &str,
    object_id: &str,
) -> Result<GeometryEntryIR, ApiError> {
    let params = &geometry.geometry_params;
    match geometry.geometry_kind.as_str() {
        "Box" => Ok(GeometryEntryIR::Box {
            name: geometry_name.to_string(),
            size: vec3_param(params, "size")
                .or_else(|| vec3_param(params, "dimensions"))
                .ok_or_else(|| {
                    ApiError::bad_request(format!(
                        "Box object '{}' is missing size/dimensions",
                        object_id
                    ))
                })?,
        }),
        "Cylinder" => Ok(GeometryEntryIR::Cylinder {
            height: number_param(params, "height", object_id)?,
            name: geometry_name.to_string(),
            radius: number_param(params, "radius", object_id)?,
            axis: [0.0, 0.0, 1.0],
        }),
        "SinWaveguide" => Ok(GeometryEntryIR::SinWaveguide {
            amplitude: number_param(params, "amplitude", object_id)?,
            height: number_param(params, "height", object_id)?,
            length: number_param(params, "length", object_id)?,
            name: geometry_name.to_string(),
            period: number_param(params, "period", object_id)?,
            phase: optional_number_param(params, "phase").unwrap_or(0.0),
            width: number_param(params, "width", object_id)?,
            z0: optional_number_param(params, "z0").unwrap_or(0.0),
        }),
        "ArchWaveguide" => Ok(GeometryEntryIR::ArchWaveguide {
            arch_height: number_param(params, "arch_height", object_id)?,
            height: number_param(params, "height", object_id)?,
            length: number_param(params, "length", object_id)?,
            name: geometry_name.to_string(),
            width: number_param(params, "width", object_id)?,
            z0: optional_number_param(params, "z0").unwrap_or(0.0),
        }),
        "Ellipsoid" => Ok(GeometryEntryIR::Ellipsoid {
            name: geometry_name.to_string(),
            radii: vec3_param(params, "radii").unwrap_or([
                number_param(params, "rx", object_id)?,
                number_param(params, "ry", object_id)?,
                number_param(params, "rz", object_id)?,
            ]),
        }),
        "Sphere" => Ok(GeometryEntryIR::Sphere {
            name: geometry_name.to_string(),
            radius: number_param(params, "radius", object_id)?,
        }),
        "Ellipse" => Ok(GeometryEntryIR::Ellipse {
            height: number_param(params, "height", object_id)?,
            name: geometry_name.to_string(),
            radii: vec2_param(params, "radii").unwrap_or([
                number_param(params, "rx", object_id)?,
                number_param(params, "ry", object_id)?,
            ]),
        }),
        "Difference" => {
            let base = nested_scene_geometry_param(params, "base", object_id)?;
            let tool = nested_scene_geometry_param(params, "tool", object_id)?;
            Ok(GeometryEntryIR::Difference {
                name: geometry_name.to_string(),
                base: Box::new(scene_geometry_entry(
                    &base,
                    &format!("{geometry_name}_base"),
                    object_id,
                )?),
                tool: Box::new(scene_geometry_entry(
                    &tool,
                    &format!("{geometry_name}_tool"),
                    object_id,
                )?),
            })
        }
        other => Err(ApiError::bad_request(format!(
            "mesh build cannot lower geometry kind '{}' for object '{}'",
            other, object_id
        ))),
    }
}

fn nested_scene_geometry_param(
    params: &serde_json::Value,
    key: &str,
    object_id: &str,
) -> Result<SceneGeometry, ApiError> {
    let value = params.get(key).ok_or_else(|| {
        ApiError::bad_request(format!(
            "Difference object '{}' is missing '{}' geometry",
            object_id, key
        ))
    })?;
    serde_json::from_value(value.clone()).map_err(|error| {
        ApiError::bad_request(format!(
            "Difference object '{}' has invalid '{}' geometry: {error}",
            object_id, key
        ))
    })
}

fn initial_magnetization_for_object(
    scene: &SceneDocument,
    object: &SceneObject,
) -> InitialMagnetizationIR {
    let Some(reference) = object.magnetization_ref.as_ref() else {
        return InitialMagnetizationIR::Uniform {
            value: [0.0, 0.0, 1.0],
        };
    };
    let Some(asset) = scene
        .magnetization_assets
        .iter()
        .find(|candidate| candidate.id == *reference)
    else {
        return InitialMagnetizationIR::Uniform {
            value: [0.0, 0.0, 1.0],
        };
    };

    if let Some(value) = asset
        .value
        .as_ref()
        .and_then(|values| vec3_from_f64_slice(values))
    {
        return InitialMagnetizationIR::Uniform { value };
    }
    if asset.kind == "preset_texture" {
        let preset_kind = asset
            .preset_kind
            .clone()
            .unwrap_or_else(|| "uniform".to_string());
        if preset_kind == "uniform" {
            if let Some(value) = asset
                .preset_params
                .as_ref()
                .and_then(|params| params.get("direction"))
                .and_then(|value| value.as_array())
                .and_then(|values| vec3_from_json_slice(values))
            {
                return InitialMagnetizationIR::Uniform { value };
            }
        }

        // Map non-uniform preset textures correctly
        let mut preset_params = std::collections::BTreeMap::new();
        if let Some(serde_json::Value::Object(map)) = &asset.preset_params {
            for (k, v) in map {
                preset_params.insert(k.clone(), v.clone());
            }
        }

        let mapping = fullmag_ir::TextureMappingIR {
            space: asset.mapping.space.clone(),
            projection: match asset.mapping.projection.as_str() {
                "planar_xy" | "planarXy" => fullmag_ir::TextureProjectionMode::PlanarXy,
                "planar_xz" | "planarXz" => fullmag_ir::TextureProjectionMode::PlanarXz,
                "planar_yz" | "planarYz" => fullmag_ir::TextureProjectionMode::PlanarYz,
                _ => fullmag_ir::TextureProjectionMode::ObjectLocal,
            },
            clamp_mode: asset.mapping.clamp_mode.clone(),
        };

        let texture_transform = fullmag_ir::TextureTransform3DIR {
            translation: asset.texture_transform.translation,
            rotation_quat: asset.texture_transform.rotation_quat,
            scale: asset.texture_transform.scale,
            pivot: asset.texture_transform.pivot,
        };

        return InitialMagnetizationIR::PresetTexture {
            preset_kind,
            preset_version: asset.preset_version.unwrap_or(1),
            preset_params,
            mapping,
            texture_transform,
        };
    }
    InitialMagnetizationIR::Uniform {
        value: [0.0, 0.0, 1.0],
    }
}

fn number_param(params: &serde_json::Value, key: &str, object_id: &str) -> Result<f64, ApiError> {
    optional_number_param(params, key).ok_or_else(|| {
        ApiError::bad_request(format!(
            "object '{}' geometry parameter '{}' must be a finite number",
            object_id, key
        ))
    })
}

fn optional_number_param(params: &serde_json::Value, key: &str) -> Option<f64> {
    params.get(key).and_then(|value| {
        let number = value.as_f64()?;
        number.is_finite().then_some(number)
    })
}

fn vec3_param(params: &serde_json::Value, key: &str) -> Option<[f64; 3]> {
    params
        .get(key)
        .and_then(|value| value.as_array())
        .and_then(|values| vec3_from_json_slice(values))
}

fn vec2_param(params: &serde_json::Value, key: &str) -> Option<[f64; 2]> {
    let values = params.get(key)?.as_array()?;
    Some([
        finite_json_number(values.first()?)?,
        finite_json_number(values.get(1)?)?,
    ])
}

fn vec3_from_json_slice(values: &[serde_json::Value]) -> Option<[f64; 3]> {
    Some([
        finite_json_number(values.first()?)?,
        finite_json_number(values.get(1)?)?,
        finite_json_number(values.get(2)?)?,
    ])
}

fn vec3_from_f64_slice(values: &[f64]) -> Option<[f64; 3]> {
    let value = [*values.first()?, *values.get(1)?, *values.get(2)?];
    value
        .iter()
        .all(|component| component.is_finite())
        .then_some(value)
}

fn finite_json_number(value: &serde_json::Value) -> Option<f64> {
    let number = value.as_f64()?;
    number.is_finite().then_some(number)
}

fn is_zero_vec3(value: [f64; 3]) -> bool {
    value.iter().all(|component| component.abs() <= 1e-18)
}

fn is_unit_scale(value: [f64; 3]) -> bool {
    value
        .iter()
        .all(|component| (*component - 1.0).abs() <= 1e-12)
}

fn is_identity_quat(value: [f64; 4]) -> bool {
    value[0].abs() <= 1e-12
        && value[1].abs() <= 1e-12
        && value[2].abs() <= 1e-12
        && (value[3] - 1.0).abs() <= 1e-12
}

pub(crate) async fn enqueue_session_command_impl(
    state: Arc<AppState>,
    headers: &HeaderMap,
    command: SessionCommand,
) -> Result<CommandResponse, ApiError> {
    let snapshot = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;

    if let Some(idempotency_key) = command_request_key(&headers) {
        let cached = {
            let responses = state.current_command_responses.lock().await;
            responses
                .iter()
                .find(|(key, _)| key == &idempotency_key)
                .map(|(_, response)| response.clone())
        };
        if let Some(response) = cached {
            return Ok(response);
        }
    }
    let command_id = command.command_id.clone();
    let request_id = command_request_id(headers);

    // Enqueue
    let seq = {
        let mut next_seq = state.current_control_next_seq.lock().await;
        *next_seq = next_seq.saturating_add(1);
        *next_seq
    };
    let mut enqueued = command;
    enqueued.seq = seq;
    if enqueued.kind == "compute_fields" {
        enqueued.field_materialization_requirements =
            compute_fields_materialization_requirements(&snapshot);
    }
    state
        .current_control_queue
        .lock()
        .await
        .push_back(enqueued.clone());
    {
        let mut ledger = state.current_command_ledger.lock().await;
        ledger.push_back(TrackedCommandRecord {
            command: enqueued,
            request_id: request_id.clone(),
            status: CommandLifecycleState::Queued,
            dispatched_at_unix_ms: None,
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        });
        while ledger.len() > 256 {
            ledger.pop_front();
        }
    }
    let _ = state.current_control_events.send(seq);

    let response = CommandResponse {
        accepted: true,
        command_id,
        request_id,
        error: None,
    };

    if let Some(idempotency_key) = command_request_key(&headers) {
        let mut responses = state.current_command_responses.lock().await;
        responses.push_back((idempotency_key, response.clone()));
        while responses.len() > 128 {
            responses.pop_front();
        }
    }

    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let display_revision = state.current_display_selection.read().await.revision;
        let realtime_state =
            crate::current_live_realtime_state_from_snapshot(&state, &snapshot, display_revision)
                .await;
        crate::publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0)
            .await?;
    }

    Ok(response)
}

async fn reject_session_command_impl(
    state: Arc<AppState>,
    headers: &HeaderMap,
    mut command: SessionCommand,
    error: String,
) -> Result<CommandResponse, ApiError> {
    if state.current_live_state.read().await.is_none() {
        return Err(ApiError::not_found("no active local live workspace"));
    }

    if let Some(idempotency_key) = command_request_key(headers) {
        let responses = state.current_command_responses.lock().await;
        if let Some(response) = responses
            .iter()
            .find(|(key, _)| key == &idempotency_key)
            .map(|(_, response)| response.clone())
        {
            return Ok(response);
        }
    }

    let seq = {
        let mut next_seq = state.current_control_next_seq.lock().await;
        *next_seq = next_seq.saturating_add(1);
        *next_seq
    };
    command.seq = seq;
    let command_id = command.command_id.clone();
    let request_id = command_request_id(headers);
    let completed_at_unix_ms = command.created_at_unix_ms;
    {
        let mut ledger = state.current_command_ledger.lock().await;
        ledger.push_back(TrackedCommandRecord {
            command,
            request_id: request_id.clone(),
            status: CommandLifecycleState::Rejected,
            dispatched_at_unix_ms: None,
            completed_at_unix_ms: Some(completed_at_unix_ms),
            completion_status: Some(crate::types::CommandCompletionState::Rejected),
            error: Some(error.clone()),
        });
        while ledger.len() > 256 {
            ledger.pop_front();
        }
    }

    let response = CommandResponse {
        accepted: false,
        command_id,
        request_id,
        error: Some(error),
    };
    if let Some(idempotency_key) = command_request_key(headers) {
        let mut responses = state.current_command_responses.lock().await;
        responses.push_back((idempotency_key, response.clone()));
        while responses.len() > 128 {
            responses.pop_front();
        }
    }

    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let display_revision = state.current_display_selection.read().await.revision;
        let realtime_state =
            crate::current_live_realtime_state_from_snapshot(&state, &snapshot, display_revision)
                .await;
        crate::publish_current_live_realtime_batch_changed(&state, &realtime_state, false, 0)
            .await?;
    }

    Ok(response)
}

fn command_request_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn command_request_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn new_session_command(command_id: String, kind: &str, created_at_unix_ms: u128) -> SessionCommand {
    SessionCommand {
        seq: 0,
        command_id,
        kind: kind.to_string(),
        created_at_unix_ms,
        target: None,
        reason: None,
        precondition: None,
        client_intent_id: None,
        requested_at_unix_ms: None,
        until_seconds: None,
        max_steps: None,
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
        field_materialization_requirements: Vec::new(),
    }
}

fn compute_fields_materialization_requirements(
    snapshot: &SessionStateResponse,
) -> Vec<FieldMaterializationRequirement> {
    let has_resolved_plan_registry = snapshot
        .capabilities
        .as_ref()
        .and_then(|capabilities| capabilities.resolved_quantity_registry.as_ref())
        .is_some_and(|registry| {
            registry.source == fullmag_runner::QuantityProviderRegistrySource::ResolvedPlan
        });
    if !has_resolved_plan_registry {
        return Vec::new();
    }

    let canonical_ids = fullmag_runner::quantities::field_materialization_quantity_ids();
    let supported_quantity_ids = supported_materialization_quantity_ids(snapshot, &canonical_ids);
    if supported_quantity_ids.is_empty() {
        return Vec::new();
    }
    let is_multilayer = snapshot_is_fdm_multilayer(snapshot);
    let airbox_demag_supported = is_multilayer
        && supported_quantity_ids
            .iter()
            .any(|quantity_id| *quantity_id == "H_demag");
    let quantity_ids = if is_multilayer {
        supported_quantity_ids
            .iter()
            .copied()
            .filter(|quantity_id| *quantity_id != "H_demag")
            .collect::<Vec<_>>()
    } else {
        supported_quantity_ids
    };
    let generation_id = domain_generation_id(snapshot);
    let mut requirements = Vec::new();
    if !quantity_ids.is_empty() {
        requirements.push(FieldMaterializationRequirement {
            quantity_ids: quantity_ids.into_iter().map(ToString::to_string).collect(),
            scope_kind: "full".to_string(),
            scope_id: None,
            generation_id: generation_id.clone(),
            carrier_fingerprint: None,
        });
    }

    if airbox_demag_supported {
        let carrier_fingerprint =
            crate::router_v2::handlers::data::fields::load_fdm_multilayer_airbox_carrier(snapshot)
                .ok()
                .flatten()
                .map(|carrier| carrier.carrier_fingerprint);
        requirements.push(FieldMaterializationRequirement {
            quantity_ids: vec!["H_demag".to_string()],
            scope_kind: "airbox".to_string(),
            scope_id: Some("airbox".to_string()),
            generation_id,
            carrier_fingerprint,
        });
    }
    requirements
}

fn supported_materialization_quantity_ids<'a>(
    snapshot: &SessionStateResponse,
    canonical_ids: &'a [&'a str],
) -> Vec<&'a str> {
    let Some(capabilities) = snapshot.capabilities.as_ref() else {
        return Vec::new();
    };
    let precision = snapshot
        .session
        .resolved_precision
        .as_deref()
        .unwrap_or(snapshot.session.precision.as_str());
    supported_materialization_quantity_ids_for_capabilities(capabilities, precision, canonical_ids)
}

fn supported_materialization_quantity_ids_for_capabilities<'a>(
    capabilities: &fullmag_runner::BackendCapabilities,
    precision: &str,
    canonical_ids: &'a [&'a str],
) -> Vec<&'a str> {
    canonical_ids
        .iter()
        .copied()
        .filter(|quantity_id| {
            let Some(spec) = quantity_spec(quantity_id) else {
                return false;
            };
            let resolved = fullmag_runner::resolve_quantity_capability(
                capabilities,
                spec,
                fullmag_runner::ResolvedQuantityCapabilityContext {
                    scope: spec.domain.as_str(),
                    precision,
                    materialization:
                        fullmag_runner::QuantityMaterializationCapability::Unmaterialized,
                    carriers: Vec::new(),
                },
            );
            resolved.request == fullmag_runner::QuantityRequestCapability::FieldVector
                && resolved.materialization
                    != fullmag_runner::QuantityMaterializationCapability::Unavailable
        })
        .collect()
}

fn snapshot_is_fdm_multilayer(snapshot: &SessionStateResponse) -> bool {
    snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("artifact_layout"))
        .and_then(|layout| layout.get("backend"))
        .and_then(serde_json::Value::as_str)
        == Some("fdm_multilayer")
        || snapshot
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("execution_plan"))
            .and_then(|plan| plan.get("backend_plan"))
            .and_then(|plan| plan.get("kind"))
            .and_then(serde_json::Value::as_str)
            == Some("fdm_multilayer")
}

fn command_from_structured(
    req: StructuredCommandRequest,
    command_id: String,
    created_at_unix_ms: u128,
) -> SessionCommand {
    match req {
        StructuredCommandRequest::Run {
            intent,
            until_seconds,
            max_steps,
            integrator,
            fixed_timestep,
            solver_policy,
        } => {
            let mut command = new_session_command(command_id, "run", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::Run { run_id: None },
            );
            command.until_seconds = Some(until_seconds);
            command.max_steps = max_steps;
            command.integrator = integrator;
            command.fixed_timestep = fixed_timestep;
            command.solver_policy = solver_policy;
            command
        }
        StructuredCommandRequest::Relax {
            intent,
            until_seconds,
            max_relaxation_time_s,
            max_steps,
            torque_tolerance_apm,
            torque_tolerance_t,
            torque_tolerance,
            energy_tolerance,
            energy_tolerance_j,
            relax_algorithm,
            relax_alpha,
            fixed_timestep,
            max_error,
            solver_policy,
        } => {
            let mut command = new_session_command(command_id, "relax", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::Run { run_id: None },
            );
            command.until_seconds = max_relaxation_time_s.or(until_seconds);
            command.max_steps = max_steps;
            command.torque_tolerance = torque_tolerance_apm
                .or(torque_tolerance)
                .or_else(|| torque_tolerance_t.map(|value| value / MU0_T_PER_APM));
            command.energy_tolerance = energy_tolerance_j.or(energy_tolerance);
            command.relax_algorithm = relax_algorithm.map(|algorithm| algorithm.as_str().into());
            command.relax_alpha = relax_alpha;
            command.fixed_timestep = fixed_timestep;
            command.max_error = max_error;
            command.solver_policy = solver_policy;
            command
        }
        StructuredCommandRequest::Pause { intent } => {
            let mut command = new_session_command(command_id, "pause", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::Resume { intent } => {
            let mut command = new_session_command(command_id, "resume", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::Stop { intent } => {
            let mut command = new_session_command(command_id, "stop", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::Skip { intent } => {
            let mut command = new_session_command(command_id, "skip", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::SaveVtk { intent } => {
            let mut command = new_session_command(command_id, "save_vtk", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::CurrentStage { stage_id: None },
            );
            command
        }
        StructuredCommandRequest::Solve { intent } => {
            let mut command = new_session_command(command_id, "solve", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command
        }
        StructuredCommandRequest::ComputeFields { intent } => {
            let mut command = new_session_command(command_id, "compute_fields", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command
        }
        StructuredCommandRequest::ComputeEnergies { intent } => {
            let mut command =
                new_session_command(command_id, "compute_energies", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command
        }
        StructuredCommandRequest::Close { intent } => {
            let mut command = new_session_command(command_id, "close", created_at_unix_ms);
            apply_command_intent(
                &mut command,
                intent,
                RuntimeCommandTarget::Run { run_id: None },
            );
            command
        }
        StructuredCommandRequest::MeshBuild {
            intent,
            mesh_options,
            mesh_target,
            mesh_reason,
        } => {
            let mut command = new_session_command(command_id, "remesh", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command.mesh_options = mesh_options;
            command.mesh_target = mesh_target;
            command.mesh_reason = mesh_reason;
            command
        }
        StructuredCommandRequest::FdmGridRefresh { intent } => {
            let mut command =
                new_session_command(command_id, "fdm_grid_refresh", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command
        }
        StructuredCommandRequest::SetSolverProfile { intent, profile } => {
            let mut command =
                new_session_command(command_id, "set_solver_profile", created_at_unix_ms);
            apply_command_intent(&mut command, intent, RuntimeCommandTarget::Study);
            command.profile =
                Some(serde_json::to_value(profile).unwrap_or(serde_json::Value::Null));
            command
        }
    }
}

fn apply_command_intent(
    command: &mut SessionCommand,
    intent: RuntimeCommandIntent,
    default_target: RuntimeCommandTarget,
) {
    command.target = Some(intent.target.unwrap_or(default_target));
    command.reason = Some(intent.reason.unwrap_or_else(|| "unspecified".to_string()));
    command.precondition = intent.precondition;
    command.client_intent_id = intent.client_intent_id;
    command.requested_at_unix_ms = intent.requested_at_unix_ms;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schemas::diagnostics::SolverProfileCommandConfig;
    use crate::session::default_current_live_state;
    use crate::types::CurrentLiveSnapshotRequest;

    fn resolved_capability_fixture() -> fullmag_runner::BackendCapabilities {
        fullmag_runner::BackendCapabilities {
            engine_id: fullmag_runner::RuntimeEngineId::FdmCpuReference,
            capability_profile_version: "test".to_string(),
            supported_terms: Vec::new(),
            term_scopes: std::collections::BTreeMap::new(),
            feature_capabilities: std::collections::BTreeMap::new(),
            supported_demag_realizations: Vec::new(),
            preview_quantities: vec![
                "m".to_string(),
                "H_demag".to_string(),
                "spin_current_tensor".to_string(),
            ],
            snapshot_quantities: Vec::new(),
            scalar_outputs: vec!["E_total".to_string()],
            resolved_quantity_registry: Some(
                fullmag_runner::ResolvedQuantityProviderRegistry::from_resolved_plan(
                    "fdm_cpu_reference",
                    "double",
                    ["m", "H_demag", "spin_current_tensor"],
                    ["E_total"],
                ),
            ),
            approximate_operators: Vec::new(),
            supports_frequency_response: false,
            supports_coupled_magnetoelastic_quasistatic: false,
            supports_coupled_magnetoelastic_elastodynamic: false,
            supports_frequency_domain_elastodynamics: false,
            supports_coupled_eigenmodes: false,
            supports_lossy_fallback_override: false,
        }
    }

    fn compatibility_capability_fixture() -> fullmag_runner::BackendCapabilities {
        let mut capabilities = resolved_capability_fixture();
        let registry = capabilities
            .resolved_quantity_registry
            .as_mut()
            .expect("resolved registry fixture");
        registry.source = fullmag_runner::QuantityProviderRegistrySource::CompatibilityProfile;
        capabilities
    }

    #[test]
    fn compute_fields_uses_resolved_field_materialization_capability() {
        let candidates = ["m", "H_demag", "E_total", "spin_current_tensor"];

        assert_eq!(
            supported_materialization_quantity_ids_for_capabilities(
                &resolved_capability_fixture(),
                "double",
                &candidates,
            ),
            vec!["m", "H_demag", "spin_current_tensor"],
            "all runner-resolved spatial fields may be materialized; scalar resources must stay out"
        );
    }

    #[test]
    fn compute_fields_without_runtime_capabilities_is_fail_closed() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
            "session_id": "compute-fields-no-capabilities"
        }))
        .expect("minimal live snapshot request should deserialize");
        let snapshot = default_current_live_state(&request);

        assert!(supported_materialization_quantity_ids(&snapshot, &["m", "H_demag"]).is_empty());
    }

    #[test]
    fn multilayer_compute_fields_without_runtime_capabilities_has_no_airbox_requirement() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
            "session_id": "compute-fields-multilayer-no-capabilities"
        }))
        .expect("minimal live snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&request);
        snapshot.metadata = Some(serde_json::json!({
            "artifact_layout": { "backend": "fdm_multilayer" }
        }));

        assert!(compute_fields_materialization_requirements(&snapshot).is_empty());
    }

    #[test]
    fn compute_fields_with_compatibility_profile_has_no_unverified_requirements() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
            "session_id": "compute-fields-compatibility-profile"
        }))
        .expect("minimal live snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&request);
        snapshot.capabilities = Some(compatibility_capability_fixture());
        snapshot.metadata = Some(serde_json::json!({
            "artifact_layout": { "backend": "fdm_multilayer" }
        }));

        assert!(compute_fields_materialization_requirements(&snapshot).is_empty());
    }

    #[test]
    fn multilayer_compute_fields_rejects_compatibility_and_empty_resolved_registries() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(serde_json::json!({
            "session_id": "compute-fields-multilayer-untrusted-registry"
        }))
        .expect("minimal live snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&request);
        snapshot.metadata = Some(serde_json::json!({
            "artifact_layout": { "backend": "fdm_multilayer" }
        }));

        let mut compatibility = resolved_capability_fixture();
        compatibility
            .resolved_quantity_registry
            .as_mut()
            .expect("registry")
            .source = fullmag_runner::QuantityProviderRegistrySource::CompatibilityProfile;
        snapshot.capabilities = Some(compatibility);
        assert!(compute_fields_materialization_requirements(&snapshot).is_empty());

        let mut empty_resolved = resolved_capability_fixture();
        let registry = empty_resolved
            .resolved_quantity_registry
            .as_mut()
            .expect("registry");
        registry.field_quantities.clear();
        registry.scalar_quantities.clear();
        snapshot.capabilities = Some(empty_resolved);
        assert!(compute_fields_materialization_requirements(&snapshot).is_empty());
    }

    #[test]
    fn set_solver_profile_command_preserves_profile_payload() {
        let command = command_from_structured(
            StructuredCommandRequest::SetSolverProfile {
                intent: RuntimeCommandIntent::default(),
                profile: SolverProfileCommandConfig {
                    enabled: true,
                    sample_every: 2,
                    sample_interval_wall_ms: 5000,
                    max_samples: 7,
                    emit_engine_log: true,
                    persist_artifact: false,
                },
            },
            "cmd-profile".to_string(),
            123,
        );

        assert_eq!(command.kind, "set_solver_profile");
        assert_eq!(command.command_id, "cmd-profile");
        assert_eq!(
            command
                .profile
                .as_ref()
                .and_then(|value| value.get("enabled")),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            command
                .profile
                .as_ref()
                .and_then(|value| value.get("sample_every")),
            Some(&serde_json::json!(2))
        );
        assert_eq!(
            command
                .profile
                .as_ref()
                .and_then(|value| value.get("sample_interval_wall_ms")),
            Some(&serde_json::json!(5000))
        );
        assert_eq!(
            command
                .profile
                .as_ref()
                .and_then(|value| value.get("max_samples")),
            Some(&serde_json::json!(7))
        );
    }

    #[test]
    fn run_command_preserves_typed_fixed_solver_policy() {
        let request: StructuredCommandRequest = serde_json::from_value(serde_json::json!({
            "kind": "run",
            "until_seconds": 1e-9,
            "solver_policy": {
                "kind": "fixed",
                "fix_dt": 2e-15
            }
        }))
        .expect("canonical fixed policy should deserialize");
        let command = command_from_structured(request, "cmd-fixed".to_string(), 123);
        assert_eq!(
            serde_json::to_value(command.solver_policy).unwrap(),
            serde_json::json!({"kind": "fixed", "fix_dt": 2e-15})
        );
    }

    #[test]
    fn relax_command_requires_complete_typed_adaptive_policy_and_rejects_legacy_mixing() {
        let request: StructuredCommandRequest = serde_json::from_value(serde_json::json!({
            "kind": "relax",
            "solver_policy": {
                "kind": "adaptive_max_error",
                "integrator": "rk45",
                "dt_min": 1e-16,
                "dt_max": 1e-14,
                "max_err": 1e-6
            }
        }))
        .expect("canonical adaptive policy should deserialize");
        validate_solver_policy_controls(&request)
            .expect("omitted dt_initial must remain a valid adaptive request");
        assert!(
            validate_solver_policy_lane(&request, "fdm", "gpu", "double")
                .expect_err("adaptive FDM GPU must fail before enqueue")
                .message
                .contains("explicit CPU")
        );
        let command = command_from_structured(request, "cmd-adaptive".to_string(), 123);
        assert_eq!(
            serde_json::to_value(command.solver_policy).unwrap(),
            serde_json::json!({
                "kind": "adaptive_max_error",
                "integrator": "rk45",
                "dt_min": 1e-16,
                "dt_max": 1e-14,
                "max_err": 1e-6
            })
        );

        assert!(
            serde_json::from_value::<StructuredCommandRequest>(serde_json::json!({
                "kind": "relax",
                "solver_policy": {
                    "kind": "adaptive_max_error",
                    "integrator": "rk45",
                    "dt_min": 1e-16,
                    "max_err": 1e-6
                }
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<StructuredCommandRequest>(serde_json::json!({
                "kind": "run",
                "until_seconds": 1e-9,
                "solver_policy": {
                    "kind": "adaptive_advanced",
                    "integrator": "rk4",
                    "dt_min": 1e-16,
                    "dt_max": 1e-14,
                    "atol": 1e-8,
                    "rtol": 1e-5,
                    "safety": 0.9,
                    "growth_limit": 2.0,
                    "shrink_limit": 0.2
                }
            }))
            .is_err()
        );

        let mixed: StructuredCommandRequest = serde_json::from_value(serde_json::json!({
            "kind": "relax",
            "fixed_timestep": 1e-15,
            "solver_policy": {"kind": "fixed", "fix_dt": 1e-15}
        }))
        .expect("legacy fields remain readable for deterministic rejection");
        assert!(validate_solver_policy_controls(&mixed)
            .expect_err("legacy and canonical controls must not mix")
            .message
            .contains("cannot be mixed"));
    }
}
