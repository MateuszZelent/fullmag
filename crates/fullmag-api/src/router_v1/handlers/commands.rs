//! POST /v1/live/current/commands — submit a command.

use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::commands::{
    CommandRequest, CommandResponse, LegacyCommandRequest, StructuredCommandRequest,
};
use crate::types::{
    AppState, CommandLifecycleState, MeshCommandTarget, SessionCommand, TrackedCommandRecord,
};

#[utoipa::path(
    post,
    path = "/v1/live/current/commands",
    request_body = StructuredCommandRequest,
    responses(
        (status = 200, description = "Command accepted", body = CommandResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "commands"
)]
pub async fn submit_command(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CommandRequest>,
) -> Result<Json<CommandResponse>, ApiError> {
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
            return Ok(Json(response));
        }
    }

    let command_id = format!("fm-{}", uuid::Uuid::new_v4());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let command = match req {
        CommandRequest::Structured(req) => command_from_structured(req, command_id.clone(), now),
        CommandRequest::Legacy(req) => command_from_legacy(req, command_id.clone(), now)?,
    };

    // Enqueue
    let seq = {
        let mut next_seq = state.current_control_next_seq.lock().await;
        *next_seq = next_seq.saturating_add(1);
        *next_seq
    };
    let mut enqueued = command;
    enqueued.seq = seq;
    state.current_control_queue.lock().await.push_back(enqueued.clone());
    {
        let mut ledger = state.current_command_ledger.lock().await;
        ledger.push_back(TrackedCommandRecord {
            command: enqueued,
            status: CommandLifecycleState::Queued,
            dispatched_at_unix_ms: None,
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

    Ok(Json(response))
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
        StructuredCommandRequest::Skip => new_session_command(command_id, "skip", created_at_unix_ms),
        StructuredCommandRequest::Remesh {
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
        StructuredCommandRequest::SaveVtk => {
            new_session_command(command_id, "save_vtk", created_at_unix_ms)
        }
        StructuredCommandRequest::Solve => {
            new_session_command(command_id, "solve", created_at_unix_ms)
        }
        StructuredCommandRequest::Close => {
            new_session_command(command_id, "close", created_at_unix_ms)
        }
    }
}

fn command_from_legacy(
    req: LegacyCommandRequest,
    command_id: String,
    created_at_unix_ms: u128,
) -> Result<SessionCommand, ApiError> {
    let mesh_target = req
        .params
        .get("mesh_target")
        .cloned()
        .map(serde_json::from_value::<MeshCommandTarget>)
        .transpose()
        .map_err(|error| ApiError::bad_request(format!("invalid mesh_target: {error}")))?;

    let mut command = new_session_command(command_id, &req.command, created_at_unix_ms);
    command.until_seconds = req.params.get("until_seconds").and_then(|v| v.as_f64());
    command.max_steps = req.params.get("max_steps").and_then(|v| v.as_u64());
    command.torque_tolerance = req.params.get("torque_tolerance").and_then(|v| v.as_f64());
    command.energy_tolerance = req.params.get("energy_tolerance").and_then(|v| v.as_f64());
    command.integrator = req
        .params
        .get("integrator")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    command.fixed_timestep = req.params.get("fixed_timestep").and_then(|v| v.as_f64());
    command.max_error = req.params.get("max_error").and_then(|v| v.as_f64());
    command.relax_algorithm = req
        .params
        .get("relax_algorithm")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    command.relax_alpha = req.params.get("relax_alpha").and_then(|v| v.as_f64());
    command.mesh_options = req.params.get("mesh_options").cloned();
    command.mesh_target = mesh_target;
    command.mesh_reason = req
        .params
        .get("mesh_reason")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    command.state_path = req
        .params
        .get("state_path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    command.state_format = req
        .params
        .get("state_format")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(command)
}
