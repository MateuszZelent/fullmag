//! Bounded UI transport. Process ownership and canonical scene acquisition remain private.
use std::{path::PathBuf, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use fullmag_session::development_restart_transport as transport;

use crate::{
    error::ApiError,
    schemas::development_restart_request::{
        DevelopmentRestartRequest, DevelopmentRestartResource, DevelopmentRestartState,
    },
    types::AppState,
};

use super::development_backend::DevelopmentBackendConfig;

#[derive(Clone, Debug, Default)]
pub(crate) struct DevelopmentRestartTransportConfig {
    ui_origin: Option<String>,
}

impl DevelopmentRestartTransportConfig {
    pub(crate) fn from_environment() -> Self {
        if std::env::var("FULLMAG_DEVELOPMENT_RESTART_COORDINATOR").as_deref() != Ok("1") {
            return Self::default();
        }
        let token = std::env::var("FULLMAG_DEVELOPMENT_OWNER_TOKEN").unwrap_or_default();
        if !hex(&token, 32) {
            return Self::default();
        }
        let origin = std::env::var("FULLMAG_DEVELOPMENT_RESTART_UI_ORIGIN").unwrap_or_default();
        let Some(port) = origin
            .strip_prefix("http://localhost:")
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port != 0)
        else {
            return Self::default();
        };
        if origin != format!("http://localhost:{port}") {
            return Self::default();
        }
        Self {
            ui_origin: Some(origin),
        }
    }
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}

fn status_token_hash(headers: &HeaderMap) -> Result<String, ApiError> {
    let token = single_header(headers, header::AUTHORIZATION.as_str())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| hex(value, 32))
        .ok_or_else(|| ApiError::not_found("development restart request unavailable"))?;
    Ok(fullmag_session::hex_sha256(token.as_bytes()))
}

fn managed_scope(state: &AppState) -> Result<(PathBuf, String, String), ApiError> {
    match &state.development_backend {
        DevelopmentBackendConfig::Managed {
            storage_root,
            worktree,
            generation,
            ..
        } => Ok((storage_root.clone(), worktree.clone(), generation.clone())),
        _ => Err(unavailable()),
    }
}

fn unavailable() -> ApiError {
    ApiError::conflict_with_code(
        "development_restart_unavailable",
        "controlled development restart is unavailable",
    )
}

fn resource_response(status: StatusCode, resource: DevelopmentRestartResource) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(resource),
    )
        .into_response()
}

#[utoipa::path(post, path = "/v2/platform/development-restart-requests",
    request_body = DevelopmentRestartRequest,
    params(("Authorization" = String, Header, description = "Bearer token generated before submission"),
        ("Origin" = String, Header, description = "Exact launcher UI origin"),
        ("x-fullmag-api-instance" = String, Header, description = "Current API instance pin")),
    responses((status = 202, description = "Restart intent durably queued; no process restart is implied", body = DevelopmentRestartResource),
        (status = 409, description = "Restart coordinator unavailable or request conflicts")), tag = "platform")]
pub async fn post_development_restart_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<DevelopmentRestartRequest>,
) -> Result<Response, ApiError> {
    let expected_origin = state
        .development_restart_transport
        .ui_origin
        .as_deref()
        .ok_or_else(unavailable)?;
    if single_header(&headers, header::ORIGIN.as_str()) != Some(expected_origin)
        || single_header(&headers, "x-fullmag-api-instance")
            != Some(state.request_scope_instance_id.as_str())
    {
        return Err(unavailable());
    }
    let token_hash = status_token_hash(&headers)?;
    if input.schema != "fullmag.development-ui-restart-request.v1"
        || !input.editor.is_object()
        || !input.workspace.is_object()
        || !input.project_document.is_object()
    {
        return Err(ApiError::bad_request("invalid development restart request"));
    }
    if !uuid::Uuid::parse_str(&input.request_id)
        .is_ok_and(|id| !id.is_nil() && id.to_string() == input.request_id)
    {
        return Err(ApiError::bad_request(
            "invalid development restart request identity",
        ));
    }
    let (root, worktree, generation) = managed_scope(&state)?;
    // Admission already precedes this lock through router middleware. An idle
    // proof is acquired later by the private owner, never inferred here.
    let transition = state
        .current_live_session_transition
        .clone()
        .lock_owned()
        .await;
    let current_session = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|snapshot| snapshot.session.session_id.clone());
    let epoch = state
        .current_live_session_epoch
        .load(std::sync::atomic::Ordering::Acquire);
    if current_session != input.session_id || epoch != input.session_epoch {
        return Err(ApiError::conflict_with_code(
            "development_restart_workspace_changed",
            "workspace identity changed before restart submission",
        ));
    }
    let request = transport::RestartRequest {
        schema: input.schema,
        request_id: input.request_id.clone(),
        status_token_sha256: token_hash,
        old_api_instance_id: state.request_scope_instance_id.clone(),
        generation_id: generation,
        session_id: current_session,
        session_epoch: epoch,
        editor: input.editor,
        workspace: input.workspace,
        project_document: input.project_document,
    };
    tokio::task::spawn_blocking(move || {
        // The publication and its identity lock outlive an HTTP cancellation.
        let _transition = transition;
        transport::publish_request(&root, &worktree, &request)
    })
    .await
    .map_err(|_| ApiError::internal("development restart publication outcome is unknown"))?
    .map_err(|_| {
        ApiError::conflict_with_code(
            "development_restart_publication_unconfirmed",
            "restart publication could not be confirmed; inspect this request before retrying",
        )
    })?;
    Ok(resource_response(
        StatusCode::ACCEPTED,
        DevelopmentRestartResource::pending(input.request_id),
    ))
}

#[utoipa::path(get, path = "/v2/platform/development-restart-requests/{request_id}",
    params(("request_id" = String, Path, description = "Opaque restart request identity"),
        ("Authorization" = String, Header, description = "Bearer status token; omit stale API instance header")),
    responses((status = 200, description = "Token-bound restart status and confirmed restore payload", body = DevelopmentRestartResource),
        (status = 404, description = "Request unavailable")), tag = "platform")]
pub async fn get_development_restart_request(
    State(state): State<Arc<AppState>>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let token_hash = status_token_hash(&headers)?;
    let (root, worktree, _) = managed_scope(&state)?;
    let lookup_id = request_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        transport::read_result(&root, &worktree, &lookup_id, &token_hash)
    })
    .await
    .map_err(|_| ApiError::internal("development restart status unavailable"))?
    .map_err(|_| ApiError::not_found("development restart request unavailable"))?;
    let Some(result) = result else {
        return Ok(resource_response(
            StatusCode::OK,
            DevelopmentRestartResource::pending(request_id),
        ));
    };
    Ok(resource_response(
        StatusCode::OK,
        DevelopmentRestartResource {
            schema: "fullmag.development-ui-restart-resource.v1".into(),
            request_id,
            state: match result.state {
                transport::RestartResultState::Ready => DevelopmentRestartState::Ready,
                transport::RestartResultState::Failed => DevelopmentRestartState::Failed,
                transport::RestartResultState::Unknown => DevelopmentRestartState::Unknown,
            },
            new_api_instance_id: result.new_api_instance_id,
            session_id: result.session_id,
            session_epoch: result.session_epoch,
            editor: result.editor,
            workspace: result.workspace,
            project_document: result.project_document,
            public_reason: result.public_reason,
        },
    ))
}
