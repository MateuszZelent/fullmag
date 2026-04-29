//! POST /v2/sessions/current/simulation/commands — submit a command.

use std::path::Path;
use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::commands::{CommandResponse, StructuredCommandRequest};
use crate::types::{AppState, CommandLifecycleState, SessionCommand, TrackedCommandRecord};
use fullmag_authoring::{
    geometry_blocks_solver_run, realize_geometry_scene, GeometryBackendTarget,
    GeometryRealizationSnapshot,
};

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
    if let Some(realization) = validate_authoring_gate_for_command(&state, &req).await? {
        attach_geometry_realization_to_mesh_request(&mut req, &realization)?;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let command_id = format!("fm-{}", uuid::Uuid::new_v4());
    let command = command_from_structured(req, command_id, now);
    enqueue_session_command_impl(state, headers, command).await
}

async fn validate_authoring_gate_for_command(
    state: &Arc<AppState>,
    req: &StructuredCommandRequest,
) -> Result<Option<GeometryRealizationSnapshot>, ApiError> {
    let should_check_mesh = matches!(req, StructuredCommandRequest::MeshBuild { .. });
    let should_check_run = matches!(
        req,
        StructuredCommandRequest::Run { .. }
            | StructuredCommandRequest::Relax { .. }
            | StructuredCommandRequest::Solve
            | StructuredCommandRequest::ComputeFields
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
        return Ok(Some(realization));
    } else if let Some(reason) = geometry_blocks_solver_run(&scene, backend_target) {
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
    *mesh_options = Some(options);
    Ok(())
}

pub(crate) async fn enqueue_session_command_impl(
    state: Arc<AppState>,
    headers: &HeaderMap,
    command: SessionCommand,
) -> Result<CommandResponse, ApiError> {
    let _guard = state.current_live_state.read().await;
    if _guard.is_none() {
        return Err(ApiError::not_found("no active local live workspace"));
    }
    drop(_guard);

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

    // Enqueue
    let seq = {
        let mut next_seq = state.current_control_next_seq.lock().await;
        *next_seq = next_seq.saturating_add(1);
        *next_seq
    };
    let mut enqueued = command;
    enqueued.seq = seq;
    state
        .current_control_queue
        .lock()
        .await
        .push_back(enqueued.clone());
    {
        let mut ledger = state.current_command_ledger.lock().await;
        ledger.push_back(TrackedCommandRecord {
            command: enqueued,
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

fn command_request_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
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
        until_seconds: None,
        max_steps: None,
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
    }
}

fn command_from_structured(
    req: StructuredCommandRequest,
    command_id: String,
    created_at_unix_ms: u128,
) -> SessionCommand {
    match req {
        StructuredCommandRequest::Run {
            until_seconds,
            max_steps,
            integrator,
            fixed_timestep,
        } => {
            let mut command = new_session_command(command_id, "run", created_at_unix_ms);
            command.until_seconds = Some(until_seconds);
            command.max_steps = max_steps;
            command.integrator = integrator;
            command.fixed_timestep = fixed_timestep;
            command
        }
        StructuredCommandRequest::Relax {
            until_seconds,
            max_steps,
            torque_tolerance,
            energy_tolerance,
            relax_algorithm,
            relax_alpha,
            fixed_timestep,
            max_error,
        } => {
            let mut command = new_session_command(command_id, "relax", created_at_unix_ms);
            command.until_seconds = until_seconds;
            command.max_steps = max_steps;
            command.torque_tolerance = torque_tolerance;
            command.energy_tolerance = energy_tolerance;
            command.relax_algorithm = relax_algorithm;
            command.relax_alpha = relax_alpha;
            command.fixed_timestep = fixed_timestep;
            command.max_error = max_error;
            command
        }
        StructuredCommandRequest::Pause => {
            new_session_command(command_id, "pause", created_at_unix_ms)
        }
        StructuredCommandRequest::Resume => {
            new_session_command(command_id, "resume", created_at_unix_ms)
        }
        StructuredCommandRequest::Stop => {
            new_session_command(command_id, "stop", created_at_unix_ms)
        }
        StructuredCommandRequest::Skip => {
            new_session_command(command_id, "skip", created_at_unix_ms)
        }
        StructuredCommandRequest::SaveVtk => {
            new_session_command(command_id, "save_vtk", created_at_unix_ms)
        }
        StructuredCommandRequest::Solve => {
            new_session_command(command_id, "solve", created_at_unix_ms)
        }
        StructuredCommandRequest::ComputeFields => {
            new_session_command(command_id, "compute_fields", created_at_unix_ms)
        }
        StructuredCommandRequest::Close => {
            new_session_command(command_id, "close", created_at_unix_ms)
        }
        StructuredCommandRequest::MeshBuild {
            mesh_options,
            mesh_target,
            mesh_reason,
        } => {
            let mut command = new_session_command(command_id, "remesh", created_at_unix_ms);
            command.mesh_options = mesh_options;
            command.mesh_target = mesh_target;
            command.mesh_reason = mesh_reason;
            command
        }
    }
}
