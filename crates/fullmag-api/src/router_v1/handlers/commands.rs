//! POST /v1/live/current/commands — submit a command.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::commands::{CommandRequest, CommandResponse};
use crate::types::{AppState, SessionCommand};

#[utoipa::path(
    post,
    path = "/v1/live/current/commands",
    request_body = CommandRequest,
    responses(
        (status = 200, description = "Command accepted", body = CommandResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "commands"
)]
pub async fn submit_command(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CommandRequest>,
) -> Result<Json<CommandResponse>, ApiError> {
    let _guard = state.current_live_state.read().await;
    if _guard.is_none() {
        return Err(ApiError::not_found("no active local live workspace"));
    }
    drop(_guard);

    let command_id = format!("fm-{}", uuid::Uuid::new_v4());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let command = SessionCommand {
        seq: 0,
        command_id: command_id.clone(),
        kind: req.command.clone(),
        created_at_unix_ms: now,
        until_seconds: req.params.get("until_seconds").and_then(|v| v.as_f64()),
        max_steps: req.params.get("max_steps").and_then(|v| v.as_u64()),
        torque_tolerance: req.params.get("torque_tolerance").and_then(|v| v.as_f64()),
        energy_tolerance: req.params.get("energy_tolerance").and_then(|v| v.as_f64()),
        integrator: req
            .params
            .get("integrator")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        fixed_timestep: req.params.get("fixed_timestep").and_then(|v| v.as_f64()),
        max_error: req.params.get("max_error").and_then(|v| v.as_f64()),
        relax_algorithm: req
            .params
            .get("relax_algorithm")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        relax_alpha: req.params.get("relax_alpha").and_then(|v| v.as_f64()),
        mesh_options: req.params.get("mesh_options").cloned(),
        mesh_target: None,
        mesh_reason: req
            .params
            .get("mesh_reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        state_path: None,
        state_format: None,
        state_dataset: None,
        state_sample_index: None,
        display_selection: None,
        preview_config: None,
        stages: None,
    };

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
        .push_back(enqueued);
    let _ = state.current_control_events.send(seq);

    Ok(Json(CommandResponse {
        accepted: true,
        command_id,
        error: None,
    }))
}
