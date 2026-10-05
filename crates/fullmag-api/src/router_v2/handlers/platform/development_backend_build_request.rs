//! Owner-authenticated, build-only request transport for the native development watcher.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Path as RequestPath, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::ApiError,
    router_v2::handlers::platform::{
        development_backend::{DevelopmentBackendConfig, DevelopmentBackendObservation},
        development_restart_request::self as restart_transport,
    },
    schemas::{
        development_backend::DevelopmentBackendState,
        development_backend_build_request::{
            DevelopmentBackendBuildRequest, DevelopmentBackendBuildRequestResource,
            DevelopmentBackendBuildRequestState,
        },
    },
    types::AppState,
};

const INTENT_SCHEMA: &str = "fullmag.development-backend-build-intent.v1";
const REQUEST_SCHEMA: &str = "fullmag.development-backend-build-request.v1";
const MAX_INTENT_BYTES: usize = 2048;
const RESULT_SCHEMA: &str = "fullmag.development-backend-build-result.v1";
const MAX_RESULT_BYTES: usize = 4096;
static BUILD_REQUEST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildIntent {
    schema: String,
    request_id: String,
    api_instance_id: String,
    worktree_id: String,
    generation_id: String,
    status_token_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildResult {
    schema: String,
    request_id: String,
    api_instance_id: String,
    worktree_id: String,
    generation_id: String,
    status_token_sha256: String,
    state: BuildResultState,
    #[serde(deserialize_with = "required_optional_string")]
    ready_build_id: Option<String>,
    #[serde(deserialize_with = "required_optional_string")]
    ready_source_sha256: Option<String>,
}

fn required_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BuildResultState {
    Ready,
    Failed,
}

fn unavailable() -> ApiError {
    ApiError::conflict_with_code(
        "development_backend_build_unavailable",
        "manual development backend build is unavailable",
    )
}

fn conflict() -> ApiError {
    ApiError::conflict_with_code(
        "development_backend_build_request_conflict",
        "another development backend build request is active",
    )
}

fn not_found() -> ApiError {
    ApiError::not_found("development backend build request unavailable")
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_intent(intent: &BuildIntent) -> Result<(), ()> {
    if intent.schema != INTENT_SCHEMA
        || !canonical_uuid(&intent.request_id)
        || !canonical_uuid(&intent.api_instance_id)
        || !lower_hex(&intent.generation_id, 32)
        || !lower_hex(&intent.status_token_sha256, 64)
        || fullmag_session::repository_path::validate_store_id(&intent.worktree_id).is_err()
    {
        return Err(());
    }
    Ok(())
}

fn managed_scope(
    state: &AppState,
) -> Result<(PathBuf, String, String, String), ApiError> {
    if !state.development_restart_transport.is_configured() {
        return Err(unavailable());
    }
    match &state.development_backend {
        DevelopmentBackendConfig::Managed {
            storage_root,
            relative_status,
            generation,
            worktree,
            ..
        } => Ok((
            storage_root.clone(),
            relative_status.clone(),
            generation.clone(),
            worktree.clone(),
        )),
        DevelopmentBackendConfig::Disabled | DevelopmentBackendConfig::Invalid => {
            Err(unavailable())
        }
    }
}

fn intent_relative_path(relative_status: &str) -> Result<String, ()> {
    sibling_relative_path(relative_status, "backend-build-request.json")
}

fn result_relative_path(relative_status: &str) -> Result<String, ()> {
    sibling_relative_path(relative_status, "backend-build-result.json")
}

fn sibling_relative_path(relative_status: &str, file_name: &str) -> Result<String, ()> {
    let parent = Path::new(relative_status).parent().ok_or(())?;
    let parent = parent.to_str().ok_or(())?.replace('\\', "/");
    let relative = if parent.is_empty() || parent == "." {
        file_name.to_owned()
    } else {
        format!("{parent}/{file_name}")
    };
    fullmag_session::repository_path::validate_relative_path(&relative).map_err(|_| ())?;
    Ok(relative)
}

fn read_result(root: &Path, relative: &str) -> Result<Option<BuildResult>, ()> {
    let path = fullmag_session::repository_path::checked_path(root, relative).map_err(|_| ())?;
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let bytes = fullmag_session::repository_path::read_bounded_regular_file(
                root,
                relative,
                MAX_RESULT_BYTES,
            )
            .map_err(|_| ())?;
            let result: BuildResult = serde_json::from_slice(&bytes).map_err(|_| ())?;
            validate_result_shape(&result)?;
            Ok(Some(result))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

fn validate_result_shape(result: &BuildResult) -> Result<(), ()> {
    if result.schema != RESULT_SCHEMA
        || !canonical_uuid(&result.request_id)
        || !canonical_uuid(&result.api_instance_id)
        || !lower_hex(&result.generation_id, 32)
        || !lower_hex(&result.status_token_sha256, 64)
        || fullmag_session::repository_path::validate_store_id(&result.worktree_id).is_err()
    {
        return Err(());
    }
    match result.state {
        BuildResultState::Ready
            if result
                .ready_build_id
                .as_deref()
                .is_some_and(|value| lower_hex(value, 64))
                && result
                    .ready_source_sha256
                    .as_deref()
                    .is_some_and(|value| lower_hex(value, 64)) =>
        {
            Ok(())
        }
        BuildResultState::Failed
            if result.ready_build_id.is_none() && result.ready_source_sha256.is_none() =>
        {
            Ok(())
        }
        _ => Err(()),
    }
}

fn result_matches_intent(result: &BuildResult, intent: &BuildIntent) -> bool {
    result.request_id == intent.request_id
        && result.api_instance_id == intent.api_instance_id
        && result.worktree_id == intent.worktree_id
        && result.generation_id == intent.generation_id
        && result.status_token_sha256 == intent.status_token_sha256
}

fn resource_from_result(
    request_id: String,
    result: &BuildResult,
) -> DevelopmentBackendBuildRequestResource {
    let (state, build_id, source) = match result.state {
        BuildResultState::Ready => (
            DevelopmentBackendBuildRequestState::Ready,
            result.ready_build_id.clone(),
            result.ready_source_sha256.clone(),
        ),
        BuildResultState::Failed => {
            (DevelopmentBackendBuildRequestState::Failed, None, None)
        }
    };
    DevelopmentBackendBuildRequestResource::new(request_id, state, build_id, source)
}

fn read_intent(root: &Path, relative: &str) -> Result<Option<BuildIntent>, ()> {
    let path = fullmag_session::repository_path::checked_path(root, relative).map_err(|_| ())?;
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let bytes = fullmag_session::repository_path::read_bounded_regular_file(
                root,
                relative,
                MAX_INTENT_BYTES,
            )
            .map_err(|_| ())?;
            let intent: BuildIntent = serde_json::from_slice(&bytes).map_err(|_| ())?;
            validate_intent(&intent)?;
            Ok(Some(intent))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

fn write_intent_atomically(root: &Path, relative: &str, intent: &BuildIntent) -> Result<(), ()> {
    let bytes = serde_json::to_vec(intent).map_err(|_| ())?;
    if bytes.len() > MAX_INTENT_BYTES
        || fullmag_runtime_control::accepted_store::writable_product_state_path(root).as_deref()
            != Some(root)
    {
        return Err(());
    }
    fullmag_session::repository_path::checked_path(root, relative).map_err(|_| ())?;
    let parent = Path::new(relative).parent().and_then(Path::to_str).ok_or(())?;
    let temporary_relative = format!(
        "{}/.backend-build-request-{}.tmp",
        parent.replace('\\', "/"),
        Uuid::new_v4()
    );
    fullmag_session::repository_path::validate_relative_path(&temporary_relative).map_err(|_| ())?;
    let temporary = fullmag_session::repository_path::checked_path(root, &temporary_relative)
        .map_err(|_| ())?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| ())?;
    file.write_all(&bytes).map_err(|_| ())?;
    file.sync_all().map_err(|_| ())?;
    drop(file);

    if fullmag_runtime_control::accepted_store::writable_product_state_path(root).as_deref()
        != Some(root)
    {
        return Err(());
    }
    let temporary = fullmag_session::repository_path::checked_path(root, &temporary_relative)
        .map_err(|_| ())?;
    let destination = fullmag_session::repository_path::checked_path(root, relative).map_err(|_| ())?;
    fs::rename(temporary, destination).map_err(|_| ())?;
    let published = fullmag_session::repository_path::read_bounded_regular_file(
        root,
        relative,
        MAX_INTENT_BYTES,
    )
    .map_err(|_| ())?;
    if published != bytes {
        return Err(());
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn observation(config: &DevelopmentBackendConfig) -> DevelopmentBackendObservation {
    config.observe_for_consumer(now_ms())
}

fn build_resource(
    request_id: String,
    observed: &DevelopmentBackendObservation,
) -> DevelopmentBackendBuildRequestResource {
    let status = &observed.resource;
    let is_request_current = status.build_request_id.as_deref() == Some(request_id.as_str());
    let (state, ready_build_id, ready_source_sha256) = if !is_request_current {
        if matches!(status.state, DevelopmentBackendState::Unknown | DevelopmentBackendState::Disabled | DevelopmentBackendState::Stopped) {
            (DevelopmentBackendBuildRequestState::Unknown, None, None)
        } else {
            (DevelopmentBackendBuildRequestState::Pending, None, None)
        }
    } else {
        match status.state {
            DevelopmentBackendState::Waiting => {
                (DevelopmentBackendBuildRequestState::Pending, None, None)
            }
            DevelopmentBackendState::Building => {
                (DevelopmentBackendBuildRequestState::Building, None, None)
            }
            DevelopmentBackendState::Ready => {
                (DevelopmentBackendBuildRequestState::Unknown, None, None)
            }
            DevelopmentBackendState::Failed => {
                (DevelopmentBackendBuildRequestState::Unknown, None, None)
            }
            DevelopmentBackendState::Disabled
            | DevelopmentBackendState::Superseded
            | DevelopmentBackendState::Stopped
            | DevelopmentBackendState::Unknown => {
                (DevelopmentBackendBuildRequestState::Unknown, None, None)
            }
        }
    };
    DevelopmentBackendBuildRequestResource::new(
        request_id,
        state,
        ready_build_id,
        ready_source_sha256,
    )
}

fn resource_response(
    status: StatusCode,
    resource: DevelopmentBackendBuildRequestResource,
) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(resource),
    )
        .into_response()
}

#[utoipa::path(
    post,
    path = "/v2/platform/development-backend/build-requests",
    request_body = DevelopmentBackendBuildRequest,
    params(
        ("Authorization" = String, Header, description = "Bearer token generated before submission"),
        ("Origin" = String, Header, description = "Exact launcher UI origin"),
        ("x-fullmag-api-instance" = String, Header, description = "Current API instance pin")
    ),
    responses(
        (status = 202, description = "Build-only intent durably queued", body = DevelopmentBackendBuildRequestResource),
        (status = 409, description = "Build coordinator unavailable or request conflicts")
    ),
    tag = "platform"
)]
pub async fn post_development_backend_build_request(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<DevelopmentBackendBuildRequest>,
) -> Result<Response, ApiError> {
    restart_transport::validate_ui_origin_and_api_instance(&state, &headers, false)?;
    let token_hash = restart_transport::status_token_hash(&headers)?;
    if input.schema != REQUEST_SCHEMA
        || !canonical_uuid(&input.request_id)
        || !canonical_uuid(&input.api_instance_id)
    {
        return Err(ApiError::bad_request("invalid development backend build request"));
    }
    if input.api_instance_id != state.request_scope_instance_id {
        return Err(unavailable());
    }
    let (root, relative_status, generation, worktree) = managed_scope(&state)?;
    let relative_intent = intent_relative_path(&relative_status).map_err(|_| unavailable())?;
    let relative_result = result_relative_path(&relative_status).map_err(|_| unavailable())?;
    let config = state.development_backend.clone();
    let api_instance_id = state.request_scope_instance_id.clone();
    let request_id = input.request_id;
    let intent = BuildIntent {
        schema: INTENT_SCHEMA.into(),
        request_id: request_id.clone(),
        api_instance_id,
        worktree_id: worktree.clone(),
        generation_id: generation.clone(),
        status_token_sha256: token_hash,
    };
    let outcome = tokio::task::spawn_blocking(move || {
        let _guard = BUILD_REQUEST_LOCK.lock().map_err(|_| ())?;
        let observed = observation(&config);
        if !observed.resource.configured
            || observed.generation_id.as_deref() != Some(generation.as_str())
            || observed.worktree_id.as_deref() != Some(worktree.as_str())
        {
            return Err(());
        }
        if let Some(existing) = read_intent(&root, &relative_intent)? {
            let same_request = existing.request_id == intent.request_id
                && existing.api_instance_id == intent.api_instance_id
                && existing.worktree_id == intent.worktree_id
                && existing.generation_id == intent.generation_id
                && existing.status_token_sha256 == intent.status_token_sha256;
            if same_request {
                if let Some(result) = read_result(&root, &relative_result)? {
                    if result_matches_intent(&result, &existing) {
                        return Ok(resource_from_result(request_id, &result));
                    }
                }
                return Ok(build_resource(request_id, &observed));
            }
            if existing.request_id == intent.request_id
                || matches!(
                    observed.resource.state,
                    DevelopmentBackendState::Disabled
                        | DevelopmentBackendState::Unknown
                        | DevelopmentBackendState::Stopped
                        | DevelopmentBackendState::Building
                )
            {
                return Err(());
            }
            let prior_generation = existing.generation_id != intent.generation_id;
            let prior_terminal = read_result(&root, &relative_result)?
                .is_some_and(|result| result_matches_intent(&result, &existing));
            if !prior_generation && !prior_terminal {
                return Err(());
            }
            if !prior_generation
                && (existing.worktree_id != intent.worktree_id
                    || existing.api_instance_id != intent.api_instance_id)
            {
                return Err(());
            }
        } else if matches!(
            observed.resource.state,
            DevelopmentBackendState::Disabled
                | DevelopmentBackendState::Unknown
                | DevelopmentBackendState::Stopped
                | DevelopmentBackendState::Building
        ) {
            return Err(());
        }
        write_intent_atomically(&root, &relative_intent, &intent)?;
        Ok(DevelopmentBackendBuildRequestResource::new(
            request_id,
            DevelopmentBackendBuildRequestState::Pending,
            None,
            None,
        ))
    })
    .await
    .map_err(|_| ApiError::internal("development backend build request outcome is unknown"))?;
    match outcome {
        Ok(resource) => Ok(resource_response(StatusCode::ACCEPTED, resource)),
        Err(()) => Err(conflict()),
    }
}

#[utoipa::path(
    get,
    path = "/v2/platform/development-backend/build-requests/{request_id}",
    params(
        ("request_id" = String, Path, description = "Opaque build request identity"),
        ("Authorization" = String, Header, description = "Bearer status token"),
        ("Origin" = String, Header, description = "Exact launcher UI origin when sent"),
        ("x-fullmag-ui-origin" = String, Header, description = "Exact launcher UI origin echo for same-origin GET"),
        ("x-fullmag-api-instance" = String, Header, description = "Current API instance pin")
    ),
    responses(
        (status = 200, description = "Token-bound build request state", body = DevelopmentBackendBuildRequestResource),
        (status = 404, description = "Request unavailable")
    ),
    tag = "platform"
)]
pub async fn get_development_backend_build_request(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    RequestPath(request_id): RequestPath<String>,
) -> Result<Response, ApiError> {
    restart_transport::validate_ui_origin_and_api_instance(&state, &headers, true)?;
    let token_hash = restart_transport::status_token_hash(&headers)?;
    if !canonical_uuid(&request_id) {
        return Err(not_found());
    }
    let (root, relative_status, generation, worktree) = managed_scope(&state)?;
    let relative_intent = intent_relative_path(&relative_status).map_err(|_| unavailable())?;
    let relative_result = result_relative_path(&relative_status).map_err(|_| unavailable())?;
    let config = state.development_backend.clone();
    let api_instance_id = state.request_scope_instance_id.clone();
    let response_id = request_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let _guard = BUILD_REQUEST_LOCK.lock().map_err(|_| ())?;
        let Some(intent) = read_intent(&root, &relative_intent)? else {
            return Ok(DevelopmentBackendBuildRequestResource::new(
                response_id,
                DevelopmentBackendBuildRequestState::Unknown,
                None,
                None,
            ));
        };
        if intent.request_id != request_id {
            return Ok(DevelopmentBackendBuildRequestResource::new(
                response_id,
                DevelopmentBackendBuildRequestState::Unknown,
                None,
                None,
            ));
        }
        if intent.status_token_sha256 != token_hash {
            return Err(());
        }
        if intent.api_instance_id != api_instance_id
            || intent.generation_id != generation
            || intent.worktree_id != worktree
        {
            return Ok(DevelopmentBackendBuildRequestResource::new(
                response_id,
                DevelopmentBackendBuildRequestState::Unknown,
                None,
                None,
            ));
        }
        if let Some(result) = read_result(&root, &relative_result)? {
            if result_matches_intent(&result, &intent) {
                return Ok(resource_from_result(response_id, &result));
            }
        }
        let observed = observation(&config);
        if observed.resource.build_request_id.as_deref() == Some(request_id.as_str())
            && matches!(
                observed.resource.state,
                DevelopmentBackendState::Ready | DevelopmentBackendState::Failed
            )
        {
            return Ok(DevelopmentBackendBuildRequestResource::new(
                response_id,
                DevelopmentBackendBuildRequestState::Unknown,
                None,
                None,
            ));
        }
        Ok(build_resource(response_id, &observed))
    })
    .await
    .map_err(|_| ApiError::internal("development backend build status is unavailable"))?;
    match outcome {
        Ok(resource) => Ok(resource_response(StatusCode::OK, resource)),
        Err(()) => Err(not_found()),
    }
}
