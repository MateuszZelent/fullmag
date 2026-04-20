//! POST /v1/live/current/commands — submit a command.

use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::commands::{CommandRequest, CommandResponse};
use crate::types::{AppState, MeshCommandTarget, SessionCommand};

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

    let mesh_target = req
        .params
        .get("mesh_target")
        .cloned()
        .map(serde_json::from_value::<MeshCommandTarget>)
        .transpose()
        .map_err(|error| ApiError::bad_request(format!("invalid mesh_target: {error}")))?;

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
        mesh_target,
        mesh_reason: req
            .params
            .get("mesh_reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        state_path: req
            .params
            .get("state_path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        state_format: req
            .params
            .get("state_format")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
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
    state.current_control_queue.lock().await.push_back(enqueued);
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
    ["idempotency-key", "x-request-id"]
        .into_iter()
        .find_map(|name| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}
