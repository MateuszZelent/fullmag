//! Read-only result-folder browser adapters.
//!
//! Workspace items and the current local session intentionally share one
//! provider and wire contract.  SQLite lookup and all filesystem inspection
//! run on the blocking pool; current-session reads are fenced by the captured
//! session/run identity before and after the blocking operation.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use fullmag_workspace::{ItemKind, OpenOutcome, Workspace, WorkspaceError};
use fullmag_workspace_inspect::{
    is_result_dir, read_results_array, read_results_catalog, read_results_entry,
    read_results_sample, ResultsError, WorkspaceResultEntryPayload, WorkspaceResultsSource,
};

use crate::error::ApiError;
use crate::schemas::workspace_items::WorkspacePlaybackGeometryQuery;
use crate::schemas::workspace_results::{
    WorkspaceResultArray, WorkspaceResultEntryResponse, WorkspaceResultGeometryKind,
    WorkspaceResultsCatalog, WorkspaceResultsQuery, WorkspaceResultsRevisionQuery,
};
use crate::types::AppState;
use serde_json::Value;

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;
const ACCEPTED_OUTPUT_SCHEMA: &str = "fullmag.accepted_project_output.v1";
const OUTPUT_STORAGE_SCHEMA: &str = "fullmag.output_storage.resolved.v1";
const MAX_ACCEPTED_OUTPUT_RECEIPT_BYTES: u64 = 1024 * 1024;
const MAX_ACCEPTED_OUTPUT_CANDIDATES: usize = 256;

// ── workspace item adapters ────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}/results",
    params(("id" = String, Path, description = "Result item id (decimal string)"), WorkspaceResultsQuery),
    responses((status = 200, description = "Bounded result-folder catalog", body = WorkspaceResultsCatalog)),
    tag = "workspace_results"
)]
pub async fn get_workspace_results_catalog(
    AxumPath(id): AxumPath<String>,
    Query(query): Query<WorkspaceResultsQuery>,
) -> Result<Json<WorkspaceResultsCatalog>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    run(move |db| {
        let root = result_root_at(db, &id)?;
        read_results_catalog(
            &root,
            query.cursor.as_deref(),
            limit,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .map_err(map_results_error)
    })
    .await
    .map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}/results/arrays/{array_id}",
    params(
        ("id" = String, Path, description = "Result item id (decimal string)"),
        ("array_id" = String, Path, description = "Opaque array id from the catalog"),
        WorkspaceResultsRevisionQuery,
    ),
    responses((status = 200, description = "Revision-pinned array metadata", body = WorkspaceResultArray)),
    tag = "workspace_results"
)]
pub async fn get_workspace_results_array(
    AxumPath((id, array_id)): AxumPath<(String, String)>,
    Query(query): Query<WorkspaceResultsRevisionQuery>,
) -> Result<Json<WorkspaceResultArray>, ApiError> {
    run(move |db| {
        let _budget = fullmag_workspace_inspect::ResultsReadBudget::begin();
        let root = result_root_at(db, &id)?;
        let array = read_results_array(&root, &array_id, &query.revision, None)
            .map_err(map_results_error)?;
        let array = enrich_fem_array(&root, array)?;
        fullmag_workspace_inspect::ensure_results_revision(&root, &query.revision, None)
            .map_err(map_results_error)?;
        Ok(array)
    })
    .await
    .map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}/results/arrays/{array_id}/geometry",
    params(
        ("id" = String, Path, description = "Result item id (decimal string)"),
        ("array_id" = String, Path, description = "Opaque FEM array id from the catalog"),
        WorkspacePlaybackGeometryQuery,
    ),
    responses(
        (status = 200, description = "Revision-pinned exact FEM topology (FMMT v2) or active-node support (FMSP v1)", content_type = "application/octet-stream"),
        (status = 400, description = "Invalid geometry part or result revision"),
        (status = 404, description = "The result array is missing"),
        (status = 409, description = "The result revision changed"),
        (status = 422, description = "The array has no exact FEM playback geometry"),
    ),
    tag = "workspace_results"
)]
pub async fn get_workspace_results_geometry(
    AxumPath((id, array_id)): AxumPath<(String, String)>,
    Query(query): Query<WorkspacePlaybackGeometryQuery>,
) -> Result<Response, ApiError> {
    let body = run(move |db| {
        let _budget = fullmag_workspace_inspect::ResultsReadBudget::begin();
        let root = result_root_at(db, &id)?;
        let playback_revision = fullmag_workspace_inspect::locate_results_fem_playback_revision(
            &root,
            &array_id,
            &query.revision,
            None,
        )
        .map_err(map_results_error)?;
        super::workspace_items::playback_geometry_from_root(
            &root,
            &WorkspacePlaybackGeometryQuery {
                revision: playback_revision,
                part: query.part,
            },
        )
        .and_then(|body| {
            fullmag_workspace_inspect::ensure_results_revision(&root, &query.revision, None)
                .map_err(map_results_error)
                .map(|()| body)
        })
    })
    .await?;
    Ok(geometry_response(body))
}

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}/results/arrays/{array_id}/samples/{sample_index}",
    params(
        ("id" = String, Path, description = "Result item id (decimal string)"),
        ("array_id" = String, Path, description = "Opaque array id from the catalog"),
        ("sample_index" = usize, Path, description = "Zero-based sample index"),
        WorkspaceResultsRevisionQuery,
    ),
    responses((status = 200, description = "Revision-pinned f64LE sample", content_type = "application/octet-stream")),
    tag = "workspace_results"
)]
pub async fn get_workspace_results_sample(
    AxumPath((id, array_id, sample_index)): AxumPath<(String, String, usize)>,
    Query(query): Query<WorkspaceResultsRevisionQuery>,
) -> Result<Response, ApiError> {
    let sample = run(move |db| {
        let root = result_root_at(db, &id)?;
        read_results_sample(&root, &array_id, sample_index, &query.revision, None)
            .map_err(map_results_error)
    })
    .await?;
    Ok(sample_response(sample))
}

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}/results/entries/{entry_id}",
    params(
        ("id" = String, Path, description = "Result item id (decimal string)"),
        ("entry_id" = String, Path, description = "Opaque entry id from the catalog"),
        WorkspaceResultsRevisionQuery,
    ),
    responses((status = 200, description = "Bounded text/JSON/CSV preview", body = WorkspaceResultEntryResponse)),
    tag = "workspace_results"
)]
pub async fn get_workspace_results_entry(
    AxumPath((id, entry_id)): AxumPath<(String, String)>,
    Query(query): Query<WorkspaceResultsRevisionQuery>,
) -> Result<Response, ApiError> {
    let payload = run(move |db| {
        let root = result_root_at(db, &id)?;
        read_results_entry(&root, &entry_id, &query.revision, None).map_err(map_results_error)
    })
    .await?;
    entry_response(payload)
}

// ── current-session adapters ───────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/results",
    params(WorkspaceResultsQuery),
    responses((status = 200, description = "Bounded current-run result-folder catalog", body = WorkspaceResultsCatalog)),
    tag = "data"
)]
pub async fn get_current_results_catalog(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WorkspaceResultsQuery>,
) -> Result<Json<WorkspaceResultsCatalog>, ApiError> {
    let (context, root, run_id) = current_results_root(&state).await?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    let result = tokio::task::spawn_blocking(move || {
        read_results_catalog(
            &root,
            query.cursor.as_deref(),
            limit,
            run_id.as_deref(),
            WorkspaceResultsSource::Current,
        )
        .map_err(map_results_error)
    })
    .await
    .map_err(|error| ApiError::internal(format!("result catalog task failed: {error}")))??;
    crate::validate_current_live_request_context(&state, &context).await?;
    Ok(Json(result))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/results/arrays/{array_id}",
    params(
        ("array_id" = String, Path, description = "Opaque array id from the catalog"),
        WorkspaceResultsRevisionQuery,
    ),
    responses((status = 200, description = "Revision-pinned current-run array metadata", body = WorkspaceResultArray)),
    tag = "data"
)]
pub async fn get_current_results_array(
    State(state): State<Arc<AppState>>,
    AxumPath(array_id): AxumPath<String>,
    Query(query): Query<WorkspaceResultsRevisionQuery>,
) -> Result<Json<WorkspaceResultArray>, ApiError> {
    let (context, root, run_id) = current_results_root(&state).await?;
    let result = tokio::task::spawn_blocking(move || {
        let _budget = fullmag_workspace_inspect::ResultsReadBudget::begin();
        let array = read_results_array(&root, &array_id, &query.revision, run_id.as_deref())
            .map_err(map_results_error)?;
        let array = enrich_fem_array(&root, array)?;
        fullmag_workspace_inspect::ensure_results_revision(
            &root,
            &query.revision,
            run_id.as_deref(),
        )
        .map_err(map_results_error)?;
        Ok::<_, ApiError>(array)
    })
    .await
    .map_err(|error| ApiError::internal(format!("result array task failed: {error}")))??;
    crate::validate_current_live_request_context(&state, &context).await?;
    Ok(Json(result))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/results/arrays/{array_id}/geometry",
    params(
        ("array_id" = String, Path, description = "Opaque FEM array id from the catalog"),
        WorkspacePlaybackGeometryQuery,
    ),
    responses(
        (status = 200, description = "Revision-pinned exact FEM topology (FMMT v2) or active-node support (FMSP v1)", content_type = "application/octet-stream"),
        (status = 400, description = "Invalid geometry part or result revision"),
        (status = 404, description = "The active result array is missing"),
        (status = 409, description = "The result revision or live session changed"),
        (status = 422, description = "The array has no exact FEM playback geometry"),
    ),
    tag = "data"
)]
pub async fn get_current_results_geometry(
    State(state): State<Arc<AppState>>,
    AxumPath(array_id): AxumPath<String>,
    Query(query): Query<WorkspacePlaybackGeometryQuery>,
) -> Result<Response, ApiError> {
    let (context, root, run_id) = current_results_root(&state).await?;
    let result_revision = query.revision.clone();
    let part = query.part.clone();
    let body = tokio::task::spawn_blocking(move || {
        let _budget = fullmag_workspace_inspect::ResultsReadBudget::begin();
        let playback_revision = fullmag_workspace_inspect::locate_results_fem_playback_revision(
            &root,
            &array_id,
            &result_revision,
            run_id.as_deref(),
        )
        .map_err(map_results_error)?;
        super::workspace_items::playback_geometry_from_root(
            &root,
            &WorkspacePlaybackGeometryQuery {
                revision: playback_revision,
                part,
            },
        )
        .and_then(|body| {
            fullmag_workspace_inspect::ensure_results_revision(
                &root,
                &result_revision,
                run_id.as_deref(),
            )
            .map_err(map_results_error)
            .map(|()| body)
        })
    })
    .await
    .map_err(|error| ApiError::internal(format!("result geometry task failed: {error}")))??;
    crate::validate_current_live_request_context(&state, &context).await?;
    Ok(geometry_response(body))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/results/arrays/{array_id}/samples/{sample_index}",
    params(
        ("array_id" = String, Path, description = "Opaque array id from the catalog"),
        ("sample_index" = usize, Path, description = "Zero-based sample index"),
        WorkspaceResultsRevisionQuery,
    ),
    responses((status = 200, description = "Revision-pinned current-run f64LE sample", content_type = "application/octet-stream")),
    tag = "data"
)]
pub async fn get_current_results_sample(
    State(state): State<Arc<AppState>>,
    AxumPath((array_id, sample_index)): AxumPath<(String, usize)>,
    Query(query): Query<WorkspaceResultsRevisionQuery>,
) -> Result<Response, ApiError> {
    let (context, root, run_id) = current_results_root(&state).await?;
    let sample = tokio::task::spawn_blocking(move || {
        read_results_sample(
            &root,
            &array_id,
            sample_index,
            &query.revision,
            run_id.as_deref(),
        )
        .map_err(map_results_error)
    })
    .await
    .map_err(|error| ApiError::internal(format!("result sample task failed: {error}")))??;
    crate::validate_current_live_request_context(&state, &context).await?;
    Ok(sample_response(sample))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/results/entries/{entry_id}",
    params(
        ("entry_id" = String, Path, description = "Opaque entry id from the catalog"),
        WorkspaceResultsRevisionQuery,
    ),
    responses((status = 200, description = "Bounded current-run text/JSON/CSV preview", body = WorkspaceResultEntryResponse)),
    tag = "data"
)]
pub async fn get_current_results_entry(
    State(state): State<Arc<AppState>>,
    AxumPath(entry_id): AxumPath<String>,
    Query(query): Query<WorkspaceResultsRevisionQuery>,
) -> Result<Response, ApiError> {
    let (context, root, run_id) = current_results_root(&state).await?;
    let payload = tokio::task::spawn_blocking(move || {
        read_results_entry(&root, &entry_id, &query.revision, run_id.as_deref())
            .map_err(map_results_error)
    })
    .await
    .map_err(|error| ApiError::internal(format!("result entry task failed: {error}")))??;
    crate::validate_current_live_request_context(&state, &context).await?;
    entry_response(payload)
}

// ── shared plumbing ────────────────────────────────────────────────────────

async fn run<T: Send + 'static>(
    body: impl FnOnce(&Path) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let db = fullmag_workspace::default_database_path().map_err(|error| {
        ApiError::internal(format!(
            "cannot resolve the Fullmag state directory: {error}"
        ))
    })?;
    tokio::task::spawn_blocking(move || body(&db))
        .await
        .map_err(|error| ApiError::internal(format!("workspace result task failed: {error}")))?
}

fn open(db: &Path) -> Result<(Workspace, OpenOutcome), ApiError> {
    Workspace::open(db).map_err(map_workspace_error)
}

fn map_workspace_error(error: WorkspaceError) -> ApiError {
    match error {
        WorkspaceError::NotFound(what) => {
            ApiError::not_found(format!("workspace item not found: {what}"))
        }
        WorkspaceError::ReadOnly { found, supported } => ApiError::conflict_with_code(
            "workspace_read_only",
            format!("workspace database schema {found} is newer than supported {supported}"),
        ),
        WorkspaceError::Invalid(message) => ApiError::bad_request(message),
        other => ApiError::internal(other.to_string()),
    }
}

fn parse_id(text: &str) -> Result<i64, ApiError> {
    if text.is_empty() || text.len() > 18 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ApiError::bad_request(format!(
            "invalid workspace item id `{text}`"
        )));
    }
    text.parse::<i64>()
        .map_err(|_| ApiError::bad_request(format!("invalid workspace item id `{text}`")))
}

fn result_root_at(db: &Path, id: &str) -> Result<PathBuf, ApiError> {
    let (workspace, _) = open(db)?;
    let id = parse_id(id)?;
    let item = workspace
        .find(id)
        .map_err(map_workspace_error)?
        .filter(|item| !item.forgotten)
        .ok_or_else(|| ApiError::not_found(format!("workspace item not found: {id}")))?;
    if item.kind != ItemKind::Result {
        return Err(ApiError::bad_request(
            "workspace item is not a result folder",
        ));
    }
    let root = PathBuf::from(item.path);
    if !is_result_dir(&root) {
        return Err(ApiError::bad_request(
            "workspace item is not a registered result folder",
        ));
    }
    if !root.is_dir() {
        return Err(ApiError::not_found("registered result folder is missing"));
    }
    Ok(root)
}

async fn current_results_root(
    state: &Arc<AppState>,
) -> Result<
    (
        crate::types::CurrentLiveRequestContext,
        PathBuf,
        Option<String>,
    ),
    ApiError,
> {
    let context = crate::capture_current_live_read_context(state).await?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let run_id = snapshot
        .run
        .as_ref()
        .map(|run| run.run_id.clone())
        .filter(|run_id| !run_id.trim().is_empty())
        .or_else(|| context.run_id.clone());
    if run_id.is_none() {
        return Err(ApiError::not_found(
            "no run identity for the active artifact directory",
        ));
    }
    if let (Some(expected), Some(actual)) = (context.run_id.as_deref(), run_id.as_deref()) {
        if expected != actual {
            return Err(ApiError::conflict_with_code(
                "results_run_mismatch",
                "current run changed while resolving the artifact root",
            ));
        }
    }
    // Keep the identity fence under the read guard, then resolve the published
    // output outside it.  The resolver may inspect a bounded receipt set on a
    // blocking thread; all current result endpoints receive the same root and
    // the same durable run identity from this one decision.
    let snapshot = snapshot.clone();
    let expected_run_id = run_id
        .ok_or_else(|| ApiError::not_found("no run identity for the active artifact directory"))?;
    drop(guard);
    let (root, published_run_id) = tokio::task::spawn_blocking(move || {
        resolve_current_results_root(&snapshot, &expected_run_id)
    })
    .await
    .map_err(|error| ApiError::internal(format!("result root task failed: {error}")))??;
    Ok((context, root, Some(published_run_id)))
}

/// Resolve the current run's published result leaf without deriving an
/// attempt suffix or trusting the stale live artifact projection.
///
/// Docker accepted runs publish `run.json` only after `AcceptedProjectStorage`
/// has copied the completed numerical data and finalized the output-storage
/// lease.  The receipt's `resolved_output_storage.run_id` is therefore the
/// expected identity for the result inspector; the API must not synthesize it
/// from the live run id.  A running/unknown publication is an explicit state,
/// never an invitation to read another child of the output parent.
fn resolve_current_results_root(
    snapshot: &crate::types::SessionStateResponse,
    current_run_id: &str,
) -> Result<(PathBuf, String), ApiError> {
    let Some(startup) = snapshot
        .metadata
        .as_deref()
        .and_then(|metadata| metadata.get("docker_startup"))
    else {
        let root = crate::session::current_artifact_dir(snapshot)
            .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))?;
        return Ok((root, current_run_id.to_owned()));
    };

    fullmag_session::repository_path::validate_store_id(current_run_id).map_err(|error| {
        ApiError::conflict_with_code(
            "results_run_mismatch",
            format!("current run identity is invalid for results publication: {error}"),
        )
    })?;
    let output_parent = startup
        .pointer("/output_storage_binding/output_storage/output_dir")
        .and_then(Value::as_str)
        .or_else(|| {
            startup
                .pointer("/output_storage_binding/output_dir")
                .and_then(Value::as_str)
        })
        .map(PathBuf::from)
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "current_results_output_binding_missing",
                "the accepted run has no resolved output-storage parent",
            )
        })?;
    validate_absolute_storage_path(&output_parent, "resolved output-storage parent")?;
    match fs::symlink_metadata(&output_parent) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "the resolved output-storage parent is a symbolic link",
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "the resolved output-storage parent is not a directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(publication_state_error(
                snapshot,
                "the resolved output-storage parent has not been published",
            ));
        }
        Err(error) => {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_unavailable",
                format!("cannot inspect the resolved output-storage parent: {error}"),
            ));
        }
    }
    reject_reparse_directory(&output_parent, "resolved output-storage parent")?;

    let run_parent = output_parent.join(current_run_id);
    match fs::symlink_metadata(&run_parent) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "the current accepted run output parent is a symbolic link",
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "the current accepted run output parent is not a directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(publication_state_error(
                snapshot,
                "no accepted output leaf has been published",
            ));
        }
        Err(error) => {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_unavailable",
                format!("cannot inspect the current accepted run output parent: {error}"),
            ));
        }
    }
    reject_reparse_directory(&run_parent, "current accepted run output parent")?;
    let mut candidates = 0usize;
    let mut saw_identity_mismatch = false;
    let mut saw_unfinished_publication = false;
    let mut published: Option<(PathBuf, String)> = None;
    let entries = fs::read_dir(&run_parent).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            return publication_state_error(snapshot, "no accepted output leaf has been published");
        }
        ApiError::conflict_with_code(
            "current_results_publication_unavailable",
            format!("cannot inspect the accepted output parent: {error}"),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            ApiError::conflict_with_code(
                "current_results_publication_unavailable",
                format!("cannot enumerate the accepted output parent: {error}"),
            )
        })?;
        candidates = candidates.saturating_add(1);
        if candidates > MAX_ACCEPTED_OUTPUT_CANDIDATES {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_ambiguous",
                "the current run has too many output leaves to resolve safely",
            ));
        }
        let file_type = entry.file_type().map_err(|error| {
            ApiError::conflict_with_code(
                "current_results_publication_unavailable",
                format!("cannot inspect an accepted output leaf: {error}"),
            )
        })?;
        if file_type.is_symlink() {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "the accepted output parent contains a symbolic-link leaf",
            ));
        }
        if !file_type.is_dir() {
            continue;
        }
        let candidate = entry.path();
        reject_reparse_directory(&candidate, "accepted output leaf")?;
        let descriptor_path = candidate.join("run.json");
        if !descriptor_path.exists() {
            continue;
        }
        let descriptor = read_bounded_json(&descriptor_path, "accepted output receipt")?;
        if descriptor.get("schema").and_then(Value::as_str) != Some(ACCEPTED_OUTPUT_SCHEMA) {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "accepted output receipt has an unsupported schema",
            ));
        }
        let resolved = descriptor.get("resolved_output_storage").ok_or_else(|| {
            ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "accepted output receipt has no resolved storage binding",
            )
        })?;
        let declared_output_dir = resolved
            .get("output_dir")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "current_results_publication_invalid",
                    "accepted output receipt has no output directory",
                )
            })?;
        validate_absolute_storage_path(&declared_output_dir, "accepted output directory")?;
        reject_reparse_directory(&declared_output_dir, "accepted output directory")?;
        if fs::canonicalize(&declared_output_dir).ok() != fs::canonicalize(&candidate).ok() {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "accepted output receipt points at a different directory",
            ));
        }
        let published_run_id = resolved
            .get("run_id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "current_results_publication_invalid",
                    "accepted output receipt has no run identity",
                )
            })?
            .to_owned();
        fullmag_session::repository_path::validate_store_id(&published_run_id).map_err(
            |error| {
                ApiError::conflict_with_code(
                    "results_run_mismatch",
                    format!("accepted output receipt has an invalid run identity: {error}"),
                )
            },
        )?;
        let attempt_receipt = descriptor
            .get("attempt_receipt_directory")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "current_results_publication_invalid",
                    "accepted output receipt has no execution receipt binding",
                )
            })?;
        validate_absolute_storage_path(&attempt_receipt, "accepted execution receipt")?;
        if !path_has_component(&attempt_receipt, current_run_id) {
            saw_identity_mismatch = true;
            continue;
        }

        let manifest: fullmag_workspace_inspect::manifest::RunManifest = serde_json::from_value(
            read_bounded_json(&candidate.join("fullmag-run.json"), "accepted run manifest")?,
        )
        .map_err(|error| {
            ApiError::conflict_with_code(
                "current_results_publication_invalid",
                format!("accepted output run manifest cannot be parsed: {error}"),
            )
        })?;
        if manifest.schema != fullmag_workspace_inspect::manifest::RUN_MANIFEST_SCHEMA {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "accepted output run manifest has an unsupported schema",
            ));
        }
        if manifest.run_id != published_run_id {
            saw_identity_mismatch = true;
            continue;
        }
        if manifest.status != "completed" {
            saw_unfinished_publication = true;
            continue;
        }

        let storage_receipt = read_bounded_json(
            &candidate.join("output-storage.json"),
            "accepted output-storage receipt",
        )?;
        if storage_receipt.get("schema").and_then(Value::as_str) != Some(OUTPUT_STORAGE_SCHEMA)
            || storage_receipt.get("state").and_then(Value::as_str) != Some("succeeded")
            || storage_receipt
                .pointer("/resolved/run_id")
                .and_then(Value::as_str)
                != Some(published_run_id.as_str())
            || storage_receipt
                .pointer("/resolved/output_dir")
                .and_then(Value::as_str)
                .map(Path::new)
                .and_then(|path| fs::canonicalize(path).ok())
                != fs::canonicalize(&candidate).ok()
        {
            saw_unfinished_publication = true;
            continue;
        }
        if !is_result_dir(&candidate) {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "accepted output receipt points at a non-result directory",
            ));
        }
        if published.replace((candidate, published_run_id)).is_some() {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_ambiguous",
                "the current run has more than one published result leaf",
            ));
        }
    }

    if let Some(published) = published {
        return Ok(published);
    }
    if saw_identity_mismatch {
        return Err(ApiError::conflict_with_code(
            "results_run_mismatch",
            "the published result receipt belongs to another accepted run",
        ));
    }
    if saw_unfinished_publication {
        return Err(publication_state_error(
            snapshot,
            "the accepted output exists but has not reached a terminal publication state",
        ));
    }
    Err(publication_state_error(
        snapshot,
        "no canonical accepted output receipt has been published",
    ))
}

fn publication_state_error(
    snapshot: &crate::types::SessionStateResponse,
    detail: &str,
) -> ApiError {
    let terminal = snapshot
        .run
        .as_ref()
        .is_some_and(|run| matches!(run.status.as_str(), "completed" | "failed" | "cancelled"));
    ApiError::conflict_with_code(
        if terminal {
            "current_results_publication_missing"
        } else {
            "current_results_not_published"
        },
        detail,
    )
}

fn validate_absolute_storage_path(path: &Path, label: &str) -> Result<(), ApiError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(ApiError::conflict_with_code(
            "current_results_publication_invalid",
            format!("{label} must be an absolute path without parent traversal"),
        ));
    }
    Ok(())
}

fn reject_reparse_directory(path: &Path, label: &str) -> Result<(), ApiError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            ApiError::conflict_with_code(
                "current_results_publication_unavailable",
                format!("cannot inspect {label}: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                format!("{label} contains a symbolic-link ancestor"),
            ));
        }
        if !metadata.is_dir() {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                format!("{label} contains a non-directory ancestor"),
            ));
        }
    }
    Ok(())
}

fn read_bounded_json(path: &Path, label: &str) -> Result<Value, ApiError> {
    let parent = path.parent().ok_or_else(|| {
        ApiError::conflict_with_code(
            "current_results_publication_invalid",
            format!("{label} has no parent directory"),
        )
    })?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "current_results_publication_invalid",
                format!("{label} has no portable file name"),
            )
        })?;
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(
        parent,
        name,
        MAX_ACCEPTED_OUTPUT_RECEIPT_BYTES as usize,
    )
    .map_err(|error| {
        ApiError::conflict_with_code(
            "current_results_publication_unavailable",
            format!("cannot read {label}: {error}"),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        ApiError::conflict_with_code(
            "current_results_publication_invalid",
            format!("{label} is not valid JSON: {error}"),
        )
    })
}

fn path_has_component(path: &Path, expected: &str) -> bool {
    path.components().any(|component| {
        matches!(component, Component::Normal(value) if value == std::ffi::OsStr::new(expected))
    })
}

fn map_results_error(error: ResultsError) -> ApiError {
    match error {
        ResultsError::NotFound(message) => ApiError::not_found(message),
        ResultsError::Invalid(message) | ResultsError::Cursor(message) => {
            ApiError::bad_request(message)
        }
        ResultsError::Unsupported(message) => ApiError::unprocessable(message),
        ResultsError::StaleRevision => ApiError::conflict_with_code(
            "results_revision_stale",
            "the supplied result revision is stale",
        ),
        ResultsError::SourceChanged => ApiError::conflict_with_code(
            "results_source_changed",
            "the result folder changed while it was being read",
        ),
        ResultsError::TooLarge(message) => ApiError::with_status_and_code(
            StatusCode::PAYLOAD_TOO_LARGE,
            "results_payload_too_large",
            message,
        ),
        ResultsError::Link(message) => ApiError::bad_request(message),
        ResultsError::RunMismatch { expected, actual } => ApiError::conflict_with_code(
            "results_run_mismatch",
            format!("expected run {expected}, found {actual}"),
        ),
        ResultsError::Io(message) => ApiError::internal(message),
    }
}

fn sample_response(sample: fullmag_workspace_inspect::WorkspaceResultSample) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().expect("static"),
    );
    headers.insert(header::CACHE_CONTROL, "no-store".parse().expect("static"));
    headers.insert(
        "x-fullmag-results-revision",
        sample
            .revision
            .parse()
            .expect("sha256 revision is a header value"),
    );
    headers.insert(
        "x-fullmag-results-array-id",
        sample
            .array_id
            .parse()
            .expect("opaque id is a header value"),
    );
    headers.insert(
        "x-fullmag-results-sample-index",
        sample
            .sample_index
            .to_string()
            .parse()
            .expect("index is a header value"),
    );
    headers.insert(
        "x-fullmag-results-shape",
        serde_json::to_string(&sample.shape)
            .expect("shape serializes")
            .parse()
            .expect("shape is a header value"),
    );
    headers.insert("x-fullmag-results-dtype", "f64le".parse().expect("static"));
    if let Some(layout) = sample.layout {
        if let Ok(value) = layout.parse() {
            headers.insert("x-fullmag-results-layout", value);
        }
    }
    if let Some(coordinate) = sample.coordinate {
        if let Ok(value) = serde_json::to_string(&coordinate)
            .expect("coordinate serializes")
            .parse()
        {
            headers.insert("x-fullmag-results-coordinate", value);
        }
    }
    (headers, sample.bytes).into_response()
}

fn geometry_response(body: Vec<u8>) -> Response {
    let mut response = Response::new(axum::body::Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().expect("static"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().expect("static"));
    response
}

fn enrich_fem_array(
    root: &Path,
    mut array: WorkspaceResultArray,
) -> Result<WorkspaceResultArray, ApiError> {
    let Some(expected_hash) = array.geometry.as_ref().and_then(|geometry| {
        (geometry.kind == WorkspaceResultGeometryKind::FemP1)
            .then(|| geometry.playback_geometry_sha256.clone())
            .flatten()
    }) else {
        return Ok(array);
    };
    let resource = super::workspace_items::playback_resource_from_root(root)?;
    let Some(fem_mesh) = resource.fem_mesh else {
        return Err(ApiError::unprocessable_with_code(
            "saved_playback_invalid",
            "the exact FEM playback descriptor has no mesh metadata",
        ));
    };
    if fem_mesh.geometry_sha256 != expected_hash {
        return Err(ApiError::conflict_with_code(
            "saved_playback_geometry_mismatch",
            "the array geometry hash differs from the playback descriptor",
        ));
    }
    let binary_identity_available = fem_mesh.topology_byte_length.is_some()
        && fem_mesh.topology_sha256.is_some()
        && fem_mesh.support_byte_length.is_some()
        && fem_mesh.support_sha256.is_some();
    let capability_reason = (!binary_identity_available)
        .then(|| "exact FEM geometry exceeds the bounded binary transport budget".to_string());
    if let Some(geometry) = array.geometry.as_mut() {
        geometry.fem_mesh = Some(fem_mesh);
        if let Some(reason) = capability_reason.as_ref() {
            geometry.reason = Some(reason.clone());
        }
    }
    if let Some(reason) = capability_reason {
        array.can_visualize_3d = false;
        array.reason = Some(reason);
    }
    Ok(array)
}

fn entry_response(payload: WorkspaceResultEntryPayload) -> Result<Response, ApiError> {
    let textual = payload.mime_type.starts_with("text/")
        || payload.mime_type.contains("json")
        || payload.mime_type.contains("yaml");
    let text = textual
        .then(|| String::from_utf8(payload.bytes.clone()).ok())
        .flatten();
    let preview = WorkspaceResultEntryResponse {
        id: payload.entry.id,
        path: payload.entry.path,
        revision: payload.revision,
        content_type: payload.mime_type.clone(),
        text,
        truncated: payload.truncated,
    };
    let body = serde_json::to_vec(&preview).map_err(|error| {
        ApiError::internal(format!("result preview serialization failed: {error}"))
    })?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response())
}
