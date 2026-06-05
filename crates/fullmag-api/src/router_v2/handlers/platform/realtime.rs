//! Realtime endpoints for the resource-first control-room contract.

use std::sync::Arc;

use axum::extract::{ws::WebSocketUpgrade, Query, State};
use axum::http::header::SEC_WEBSOCKET_PROTOCOL;
use axum::http::HeaderMap;
use axum::response::Html;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::error::ApiError;
use crate::realtime_policy::{
    current_live_realtime_policy_resource, patch_current_live_realtime_policy,
};
use crate::schemas::realtime::{
    RealtimeCommunicationPolicyPatch, RealtimeCommunicationPolicyResource, RealtimeResourceChange,
    RealtimeResourceName, FULLMAG_LIVE_SUBPROTOCOL,
};
use crate::types::AppState;

#[derive(Debug, Deserialize)]
pub struct RealtimeConnectQuery {
    #[serde(default)]
    pub after_seq: u64,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/events/ws",
    params(
        ("after_seq" = Option<u64>, Query, description = "Replay events strictly newer than this sequence number"),
    ),
    responses(
        (status = 101, description = "Switches protocols to the Fullmag realtime websocket using subprotocol `fullmag.live.v1`"),
        (status = 400, description = "Missing or unsupported websocket subprotocol"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "platform"
)]
pub async fn ws_current_live(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RealtimeConnectQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    if state.current_live_state.read().await.is_none() {
        return Err(ApiError::not_found("no active local live workspace"));
    }
    ensure_realtime_subprotocol(&headers)?;
    Ok(ws
        .protocols([FULLMAG_LIVE_SUBPROTOCOL])
        .on_upgrade(move |socket| {
            crate::handle_current_live_realtime_ws(socket, state, query.after_seq)
        }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/events/communication-policy",
    responses(
        (status = 200, description = "Current backend-owned realtime communication policy", body = RealtimeCommunicationPolicyResource),
    ),
    tag = "platform"
)]
pub async fn get_communication_policy(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RealtimeCommunicationPolicyResource>, ApiError> {
    let policy = state.current_live_realtime_policy.read().await;
    Ok(Json(current_live_realtime_policy_resource(&policy)))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/events/communication-policy",
    request_body = RealtimeCommunicationPolicyPatch,
    responses(
        (status = 200, description = "Updated backend-owned realtime communication policy", body = RealtimeCommunicationPolicyResource),
        (status = 400, description = "Invalid communication policy patch"),
    ),
    tag = "platform"
)]
pub async fn patch_communication_policy(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<RealtimeCommunicationPolicyPatch>,
) -> Result<Json<RealtimeCommunicationPolicyResource>, ApiError> {
    let resource = {
        let mut policy = state.current_live_realtime_policy.write().await;
        patch_current_live_realtime_policy(&mut policy, patch)?
    };
    publish_communication_policy_change(&state, resource.revision).await?;
    Ok(Json(resource))
}

async fn publish_communication_policy_change(
    state: &Arc<AppState>,
    revision: u64,
) -> Result<(), ApiError> {
    let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() else {
        return Ok(());
    };
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        crate::current_live_realtime_state_from_snapshot(state, &snapshot, display_revision).await;
    crate::publish_current_live_realtime_resource_changes(
        state,
        realtime_state.session_id,
        realtime_state.run_id,
        vec![RealtimeResourceChange {
            resource: RealtimeResourceName::Events,
            revision,
            resource_id: Some("communication-policy".to_string()),
            quantity_ids: Vec::new(),
            broad: false,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/events/communication-policy".to_string()),
        }],
        false,
        0,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/platform/asyncapi.json",
    responses(
        (status = 200, description = "AsyncAPI draft for the Fullmag realtime websocket", body = Value),
    ),
    tag = "platform"
)]
pub async fn get_asyncapi_document() -> Result<Json<Value>, ApiError> {
    let value: Value = serde_json::from_str(include_str!(
        "../../../../../../docs/specs/asyncapi/fullmag-live-realtime-v1.json"
    ))
    .map_err(|error| {
        ApiError::internal(format!("failed to parse embedded AsyncAPI draft: {error}"))
    })?;
    Ok(Json(value))
}

#[utoipa::path(
    get,
    path = "/v2/platform/docs/asyncapi",
    responses(
        (status = 200, description = "Human-readable landing page for the realtime AsyncAPI draft"),
    ),
    tag = "platform"
)]
pub async fn get_asyncapi_docs() -> Html<&'static str> {
    Html(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Fullmag AsyncAPI</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 56rem; line-height: 1.55; color: #172033; }
      code, pre { font-family: ui-monospace, SFMono-Regular, monospace; }
      a { color: #0b57d0; }
      .card { border: 1px solid #d7deea; border-radius: 14px; padding: 1.25rem 1.5rem; background: #f8fbff; }
    </style>
  </head>
  <body>
    <h1>Fullmag Realtime AsyncAPI Draft</h1>
    <p>This endpoint publishes the current draft contract for the canonical realtime websocket.</p>
    <div class="card">
      <p><strong>Handshake</strong></p>
      <p><code>GET /v2/sessions/current/events/ws?after_seq=&lt;last_seen_seq&gt;</code></p>
      <p><code>Sec-WebSocket-Protocol: fullmag.live.v1</code></p>
      <p><a href="/v2/platform/asyncapi.json">Open raw AsyncAPI JSON</a></p>
    </div>
    <p>This page is intentionally lightweight for now. The machine-readable source of truth is <code>/v2/platform/asyncapi.json</code>.</p>
  </body>
</html>"#,
    )
}

pub(crate) fn ensure_realtime_subprotocol(headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(value) = headers.get(SEC_WEBSOCKET_PROTOCOL) else {
        return Err(ApiError::bad_request(format!(
            "missing required websocket subprotocol header '{}'",
            FULLMAG_LIVE_SUBPROTOCOL
        )));
    };
    let offered = value.to_str().map_err(|error| {
        ApiError::bad_request(format!("invalid websocket subprotocol header: {error}"))
    })?;
    let supports_protocol = offered
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == FULLMAG_LIVE_SUBPROTOCOL);
    if !supports_protocol {
        return Err(ApiError::bad_request(format!(
            "unsupported websocket subprotocol; expected '{}'",
            FULLMAG_LIVE_SUBPROTOCOL
        )));
    }
    Ok(())
}
