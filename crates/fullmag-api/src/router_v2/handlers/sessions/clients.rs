//! `/v2/sessions/current/clients` — presence of external clients (ADR 0068).
//!
//! A Python live script sends a heartbeat while it is connected; the Control
//! Room lists clients seen within the TTL. Presence is informational only: it
//! never grants or locks authoring, which stays revision-checked.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::realtime::{RealtimeResourceChange, RealtimeResourceName};
use crate::schemas::session_clients::{
    SessionClientEntry, SessionClientHeartbeatRequest, SessionClientsResource,
};
use crate::types::AppState;

/// Heartbeats are expected every few seconds; three missed ones expire a client.
pub(crate) const SESSION_CLIENT_TTL_MS: u64 = 30_000;
const MAX_SESSION_CLIENTS: usize = 64;
const CLIENTS_PATH: &str = "/v2/sessions/current/clients";

#[utoipa::path(
    get,
    path = "/v2/sessions/current/clients",
    responses(
        (status = 200, description = "External clients seen within the presence TTL", body = SessionClientsResource),
    ),
    tag = "sessions"
)]
pub async fn get_session_clients(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SessionClientsResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let now = unix_ms_now();
    let clients = state
        .current_session_clients
        .read()
        .await
        .values()
        .filter(|entry| now.saturating_sub(entry.last_seen_unix_ms) <= SESSION_CLIENT_TTL_MS)
        .cloned()
        .collect();
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(Json(SessionClientsResource {
        revision: state.current_session_clients_revision.load(Ordering::Relaxed),
        ttl_ms: SESSION_CLIENT_TTL_MS,
        clients,
    }))
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/clients/{client_id}",
    params(("client_id" = String, Path, description = "Client-chosen stable identifier")),
    request_body = SessionClientHeartbeatRequest,
    responses(
        (status = 200, description = "Heartbeat recorded", body = SessionClientEntry),
        (status = 400, description = "Invalid client identity"),
    ),
    tag = "sessions"
)]
pub async fn put_session_client(
    State(state): State<Arc<AppState>>,
    Path(client_id): Path<String>,
    Json(request): Json<SessionClientHeartbeatRequest>,
) -> Result<Json<SessionClientEntry>, ApiError> {
    let client_id = validated_text("client_id", &client_id, 128)?;
    let label = match request.label.as_deref() {
        Some(label) => Some(validated_text("label", label, 128)?),
        None => None,
    };
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let now = unix_ms_now();
    let (entry, newly_listed) = {
        let mut clients = state.current_session_clients.write().await;
        clients.retain(|_, entry| now.saturating_sub(entry.last_seen_unix_ms) <= SESSION_CLIENT_TTL_MS);
        let newly_listed = !clients.contains_key(&client_id);
        if newly_listed && clients.len() >= MAX_SESSION_CLIENTS {
            return Err(ApiError::conflict_with_code(
                "session_clients_full",
                format!("at most {MAX_SESSION_CLIENTS} external clients can be listed"),
            ));
        }
        let connected_at = clients
            .get(&client_id)
            .map(|entry| entry.connected_at_unix_ms)
            .unwrap_or(now);
        let entry = SessionClientEntry {
            client_id: client_id.clone(),
            kind: request.kind,
            label,
            connected_at_unix_ms: connected_at,
            last_seen_unix_ms: now,
        };
        clients.insert(client_id, entry.clone());
        (entry, newly_listed)
    };
    crate::validate_current_live_request_context(&state, &request_context).await?;
    if newly_listed {
        publish_clients_change(&state).await?;
    }
    Ok(Json(entry))
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/clients/{client_id}",
    params(("client_id" = String, Path, description = "Client-chosen stable identifier")),
    responses((status = 204, description = "Client removed or already absent")),
    tag = "sessions"
)]
pub async fn delete_session_client(
    State(state): State<Arc<AppState>>,
    Path(client_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let removed = state
        .current_session_clients
        .write()
        .await
        .remove(&client_id)
        .is_some();
    crate::validate_current_live_request_context(&state, &request_context).await?;
    if removed {
        publish_clients_change(&state).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn publish_clients_change(state: &Arc<AppState>) -> Result<(), ApiError> {
    let revision = state
        .current_session_clients_revision
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let (session_id, run_id) = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|snapshot| {
            (
                snapshot.session.session_id.clone(),
                snapshot.run.as_ref().map(|run| run.run_id.clone()),
            )
        })
        .unwrap_or_else(|| ("current".to_string(), None));
    crate::publish_current_live_realtime_resource_changes(
        state,
        session_id,
        run_id,
        vec![RealtimeResourceChange {
            resource: RealtimeResourceName::Events,
            revision,
            resource_id: Some("session-clients".to_string()),
            quantity_ids: Vec::new(),
            broad: false,
            domain_generation_id: None,
            recommended_fetch: Some(CLIENTS_PATH.to_string()),
        }],
        false,
        0,
    )
    .await
}

fn validated_text(field: &'static str, value: &str, max_len: usize) -> Result<String, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max_len || trimmed.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "{field} must be 1..={max_len} printable characters"
        )));
    }
    Ok(trimmed.to_string())
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
