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

use super::persistence::solutions::saved_geometry as saved_geometry_binary;
use crate::error::ApiError;
use crate::schemas::workspace_items::WorkspacePlaybackGeometryQuery;
use crate::schemas::workspace_results::{
    WorkspaceResultArray, WorkspaceResultEntryResponse, WorkspaceResultGeometryKind,
    WorkspaceResultsCatalog, WorkspaceResultsQuery, WorkspaceResultsRevisionQuery,
};
use crate::types::AppState;
use serde_json::Value;

mod collection;

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;
const ACCEPTED_OUTPUT_SCHEMA: &str = "fullmag.accepted_project_output.v1";
const OUTPUT_STORAGE_SCHEMA: &str = "fullmag.output_storage.resolved.v1";
const MAX_ACCEPTED_OUTPUT_RECEIPT_BYTES: u64 = 1024 * 1024;
const MAX_ACCEPTED_OUTPUT_CANDIDATES: usize = 256;
const MAX_ACCEPTED_OUTPUT_DISCOVERY_BYTES: usize = 16 * 1024 * 1024;

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
        let array = enrich_fem_array(&root, array, None)?;
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
        results_geometry_from_root(&root, &array_id, &query, None)
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
    let (context, results) = current_results_root(&state).await?;
    let result = tokio::task::spawn_blocking(move || results.catalog(query))
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
    let (context, results) = current_results_root(&state).await?;
    let result = tokio::task::spawn_blocking(move || results.array(&array_id, &query.revision))
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
    let (context, results) = current_results_root(&state).await?;
    let body = tokio::task::spawn_blocking(move || results.geometry(&array_id, &query))
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
    let (context, results) = current_results_root(&state).await?;
    let sample = tokio::task::spawn_blocking(move || {
        results.sample(&array_id, sample_index, &query.revision)
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
    let (context, results) = current_results_root(&state).await?;
    let payload = tokio::task::spawn_blocking(move || results.entry(&entry_id, &query.revision))
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

#[derive(Debug, PartialEq, Eq)]
struct ResolvedCurrentResults {
    root: PathBuf,
    run_id: String,
    members: Vec<collection::Member>,
    collection: bool,
}

struct CurrentResultsRead {
    snapshot: crate::types::SessionStateResponse,
    expected_run_id: String,
    source: ResolvedCurrentResults,
}

impl CurrentResultsRead {
    fn capture(&self) -> Result<Option<collection::CollectionSnapshot>, ApiError> {
        if self.source.collection {
            collection::CollectionSnapshot::capture(
                &self.source.run_id,
                self.source.members.clone(),
            )
            .map(Some)
            .map_err(map_results_error)
        } else {
            Ok(None)
        }
    }

    fn capture_request(
        &self,
        id: &str,
        revision: &str,
    ) -> Result<Option<collection::CollectionSnapshot>, ApiError> {
        if self.source.collection && revision.starts_with("leaf:") {
            collection::CollectionSnapshot::capture_selected(
                &self.source.run_id,
                self.source.members.clone(),
                id,
            )
            .map(Some)
            .map_err(map_results_error)
        } else {
            self.capture()
        }
    }

    fn target(
        &self,
        view: Option<&collection::CollectionSnapshot>,
        id: &str,
        revision: &str,
    ) -> Result<collection::Target, ApiError> {
        if let Some(view) = view {
            return view.resolve(id, revision).map_err(map_results_error);
        }
        Ok(collection::Target {
            root: self.source.root.clone(),
            run_id: self.source.run_id.clone(),
            revision: revision.into(),
            inner_id: id.into(),
            key: String::new(),
            label: String::new(),
        })
    }

    fn verify(
        &self,
        view: Option<&collection::CollectionSnapshot>,
        leaf: Option<&collection::Target>,
    ) -> Result<(), ApiError> {
        let after = resolve_current_results_root(&self.snapshot, &self.expected_run_id)?;
        if let Some(target) = leaf {
            let before_member = self
                .source
                .members
                .iter()
                .find(|member| member.root == target.root);
            let after_member = after
                .members
                .iter()
                .find(|member| member.root == target.root);
            if before_member.is_none()
                || before_member != after_member
                || self.source.run_id != after.run_id
            {
                return Err(map_results_error(ResultsError::SourceChanged));
            }
            fullmag_workspace_inspect::ensure_results_revision(
                &target.root,
                &target.revision,
                Some(&target.run_id),
            )
            .map_err(map_results_error)?;
        } else {
            if self.source != after {
                return Err(map_results_error(ResultsError::SourceChanged));
            }
            if let Some(view) = view {
                view.ensure_unchanged().map_err(map_results_error)?;
            }
        }
        Ok(())
    }

    fn catalog(&self, query: WorkspaceResultsQuery) -> Result<WorkspaceResultsCatalog, ApiError> {
        let _budget = fullmag_workspace_inspect::ResultsReadBudget::begin();
        let view = self.capture()?;
        let limit = query.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
        let result = if let Some(view) = &view {
            view.catalog(query.cursor.as_deref(), limit)
                .map_err(map_results_error)?
        } else {
            read_results_catalog(
                &self.source.root,
                query.cursor.as_deref(),
                limit,
                Some(&self.source.run_id),
                WorkspaceResultsSource::Current,
            )
            .map_err(map_results_error)?
        };
        self.verify(view.as_ref(), None)?;
        Ok(result)
    }

    fn array(&self, id: &str, revision: &str) -> Result<WorkspaceResultArray, ApiError> {
        let _budget = fullmag_workspace_inspect::ResultsReadBudget::begin();
        let view = self.capture_request(id, revision)?;
        let target = self.target(view.as_ref(), id, revision)?;
        let array = read_results_array(
            &target.root,
            &target.inner_id,
            &target.revision,
            Some(&target.run_id),
        )
        .map_err(map_results_error)?;
        let array = enrich_fem_array(&target.root, array, Some(&target.run_id))?;
        fullmag_workspace_inspect::ensure_results_revision(
            &target.root,
            &target.revision,
            Some(&target.run_id),
        )
        .map_err(map_results_error)?;
        self.verify(
            view.as_ref(),
            (view.is_some() && revision.starts_with("leaf:")).then_some(&target),
        )?;
        Ok(if let Some(view) = &view {
            view.normalize_array(&target, array)
        } else {
            array
        })
    }

    fn geometry(
        &self,
        id: &str,
        query: &WorkspacePlaybackGeometryQuery,
    ) -> Result<Vec<u8>, ApiError> {
        let _budget = fullmag_workspace_inspect::ResultsReadBudget::begin();
        let view = self.capture_request(id, &query.revision)?;
        let target = self.target(view.as_ref(), id, &query.revision)?;
        let bytes = results_geometry_from_root(
            &target.root,
            &target.inner_id,
            &WorkspacePlaybackGeometryQuery {
                revision: target.revision.clone(),
                part: query.part.clone(),
            },
            Some(&target.run_id),
        )?;
        self.verify(
            view.as_ref(),
            (view.is_some() && query.revision.starts_with("leaf:")).then_some(&target),
        )?;
        Ok(bytes)
    }

    fn sample(
        &self,
        id: &str,
        index: usize,
        revision: &str,
    ) -> Result<fullmag_workspace_inspect::WorkspaceResultSample, ApiError> {
        let _budget = fullmag_workspace_inspect::ResultsReadBudget::begin();
        let view = self.capture_request(id, revision)?;
        let target = self.target(view.as_ref(), id, revision)?;
        let mut sample = read_results_sample(
            &target.root,
            &target.inner_id,
            index,
            &target.revision,
            Some(&target.run_id),
        )
        .map_err(map_results_error)?;
        self.verify(
            view.as_ref(),
            (view.is_some() && revision.starts_with("leaf:")).then_some(&target),
        )?;
        if let Some(view) = &view {
            sample.array_id = id.into();
            sample.revision = view.array_revision(&target);
        }
        Ok(sample)
    }

    fn entry(&self, id: &str, revision: &str) -> Result<WorkspaceResultEntryPayload, ApiError> {
        let _budget = fullmag_workspace_inspect::ResultsReadBudget::begin();
        let view = self.capture()?;
        let target = self.target(view.as_ref(), id, revision)?;
        let payload = read_results_entry(
            &target.root,
            &target.inner_id,
            &target.revision,
            Some(&target.run_id),
        )
        .map_err(map_results_error)?;
        self.verify(view.as_ref(), None)?;
        Ok(if let Some(view) = &view {
            view.normalize_entry(&target, payload)
        } else {
            payload
        })
    }
}

async fn current_results_root(
    state: &Arc<AppState>,
) -> Result<(crate::types::CurrentLiveRequestContext, CurrentResultsRead), ApiError> {
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
    let results = tokio::task::spawn_blocking(move || {
        let source = resolve_current_results_root(&snapshot, &expected_run_id)?;
        Ok::<_, ApiError>(CurrentResultsRead {
            snapshot,
            expected_run_id,
            source,
        })
    })
    .await
    .map_err(|error| ApiError::internal(format!("result root task failed: {error}")))??;
    Ok((context, results))
}

/// Resolve all current-run result leaves without deriving an
/// attempt suffix or trusting the stale live artifact projection.
///
/// Incremental Zarr autosave publishes an immutable `run.json` before the
/// runner starts. Its accepted-run/attempt binding and per-array sample commit
/// policy permit reads while the storage lease is running. Older outputs keep
/// the completed-publication boundary. The declared resolved run identity is
/// checked against the manifest and storage receipt in either case.
fn resolve_current_results_root(
    snapshot: &crate::types::SessionStateResponse,
    current_run_id: &str,
) -> Result<ResolvedCurrentResults, ApiError> {
    let Some(startup) = snapshot
        .metadata
        .as_deref()
        .and_then(|metadata| metadata.get("docker_startup"))
    else {
        let root = crate::session::current_artifact_dir(snapshot)
            .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))?;
        return Ok(ResolvedCurrentResults {
            root,
            run_id: current_run_id.to_owned(),
            members: Vec::new(),
            collection: false,
        });
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
    let mut receipt_budget = MAX_ACCEPTED_OUTPUT_DISCOVERY_BYTES;
    let mut saw_identity_mismatch = false;
    let mut saw_unfinished_publication = false;
    let mut published = Vec::new();
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
        let descriptor = read_bounded_json(
            &descriptor_path,
            "accepted output receipt",
            &mut receipt_budget,
        )?;
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

        let manifest: fullmag_workspace_inspect::manifest::RunManifest =
            serde_json::from_value(read_bounded_json(
                &candidate.join("fullmag-run.json"),
                "accepted run manifest",
                &mut receipt_budget,
            )?)
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
        let incremental = validate_incremental_publication(
            &descriptor,
            &manifest,
            current_run_id,
            &published_run_id,
            &attempt_receipt,
        )?;

        let storage_receipt = read_bounded_json(
            &candidate.join("output-storage.json"),
            "accepted output-storage receipt",
            &mut receipt_budget,
        )?;
        if storage_receipt.get("schema").and_then(Value::as_str) != Some(OUTPUT_STORAGE_SCHEMA)
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
        let storage_state = storage_receipt.get("state").and_then(Value::as_str);
        let completed = manifest.status == "completed" && storage_state == Some("succeeded");
        // The sample commit protocol also preserves readable prefixes after
        // cancellation or failed finalization. These states are not success
        // claims; the persisted manifests remain visible in the collection.
        let committed_prefix = incremental
            && matches!(
                manifest.status.as_str(),
                "running" | "completed" | "failed" | "cancelled"
            )
            && matches!(
                storage_state,
                Some("running" | "finalizing" | "finalization_failed" | "succeeded" | "failed")
            )
            && storage_receipt
                .pointer("/resolved/data_format")
                .and_then(Value::as_str)
                == Some("zarr");
        if !completed && !committed_prefix {
            saw_unfinished_publication = true;
            continue;
        }
        if !is_result_dir(&candidate) {
            return Err(ApiError::conflict_with_code(
                "current_results_publication_invalid",
                "accepted output receipt points at a non-result directory",
            ));
        }
        let label = candidate
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "current_results_publication_invalid",
                    "output leaf name must be UTF-8",
                )
            })?
            .to_owned();
        let identity = descriptor
            .pointer("/publication/output_identity")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| attempt_receipt.to_string_lossy().into_owned());
        published.push(collection::Member {
            root: candidate,
            run_id: published_run_id,
            label,
            identity,
        });
    }

    if !published.is_empty() {
        published.sort_by(|left, right| left.label.cmp(&right.label));
        return Ok(ResolvedCurrentResults {
            root: run_parent,
            run_id: current_run_id.to_owned(),
            members: published,
            collection: true,
        });
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

/// Validate the producer's immutable incremental-publication declaration.
/// Presence is authoritative: a malformed declaration cannot downgrade to the
/// legacy completed-folder contract. This is a data provenance check, not a
/// replacement for private worker-receipt reconciliation.
fn validate_incremental_publication(
    descriptor: &Value,
    manifest: &fullmag_workspace_inspect::manifest::RunManifest,
    accepted_run_id: &str,
    resolved_run_id: &str,
    attempt_receipt: &Path,
) -> Result<bool, ApiError> {
    let Some(publication) = descriptor.get("publication") else {
        return Ok(false);
    };
    let invalid = || {
        ApiError::conflict_with_code(
        "current_results_publication_invalid",
        "incremental output publication does not match its accepted run, attempt or sample policy",
    )
    };
    if publication.get("schema").and_then(Value::as_str)
        != Some("fullmag.accepted_results_publication.v1")
        || publication.get("sample_policy").and_then(Value::as_str)
            != Some("fullmag.zarr.sample_publication.v1")
        || publication.get("accepted_run_id").and_then(Value::as_str) != Some(accepted_run_id)
        || descriptor
            .pointer("/resolved_output_storage/data_format")
            .and_then(Value::as_str)
            != Some("zarr")
    {
        return Err(invalid());
    }
    let epoch = publication
        .get("ownership_epoch")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(invalid)?;
    let task_id = publication
        .get("task_id")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let attempt_id = publication
        .get("attempt_id")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let step_id = publication
        .get("step_id")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    for id in [task_id, attempt_id, step_id] {
        fullmag_session::repository_path::validate_store_id(id).map_err(|_| invalid())?;
    }
    let identity = publication
        .get("output_identity")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    uuid::Uuid::parse_str(identity).map_err(|_| invalid())?;
    let fingerprint = publication
        .get("specification_fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let expected_receipt_suffix = PathBuf::from(accepted_run_id)
        .join("worker-attempts")
        .join(task_id)
        .join(attempt_id)
        .join(format!("epoch-{epoch}"));
    if resolved_run_id != format!("{accepted_run_id}-{epoch}")
        || !attempt_receipt.ends_with(expected_receipt_suffix)
        || fingerprint.len() != 64
        || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
        || manifest.run_spec_sha256.as_deref() != Some(fingerprint)
    {
        return Err(invalid());
    }
    Ok(true)
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

fn read_bounded_json(path: &Path, label: &str, remaining: &mut usize) -> Result<Value, ApiError> {
    let limit = (*remaining).min(MAX_ACCEPTED_OUTPUT_RECEIPT_BYTES as usize);
    let budget_error = || {
        ApiError::with_status_and_code(
            StatusCode::PAYLOAD_TOO_LARGE,
            "current_results_discovery_budget_exceeded",
            "accepted-output receipt discovery exceeds its aggregate byte budget",
        )
    };
    if limit == 0 {
        return Err(budget_error());
    }
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
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(parent, name, limit)
        .map_err(|error| {
            if limit < MAX_ACCEPTED_OUTPUT_RECEIPT_BYTES as usize
                && error.is::<fullmag_session::repository_path::MetadataByteBudgetExceeded>()
            {
                return budget_error();
            }
            ApiError::conflict_with_code(
                "current_results_publication_unavailable",
                format!("cannot read {label}: {error}"),
            )
        })?;
    *remaining -= bytes.len();
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

/// Both current-run and saved-folder routes resolve geometry by array identity.
/// A malformed new binding is never reinterpreted as a legacy magnetization field.
fn results_geometry_from_root(
    root: &Path,
    array_id: &str,
    query: &WorkspacePlaybackGeometryQuery,
    expected_run_id: Option<&str>,
) -> Result<Vec<u8>, ApiError> {
    if !matches!(query.part.as_str(), "topology" | "support") {
        return Err(ApiError::bad_request(
            "result geometry part must be topology or support",
        ));
    }
    let body = if let Some(geometry) = fullmag_workspace_inspect::read_results_fem_nodal_geometry(
        root,
        array_id,
        &query.revision,
        expected_run_id,
    )
    .map_err(map_results_error)?
    {
        match query.part.as_str() {
            "support" => saved_geometry_binary::encode_saved_support(&geometry.active_node_mask)?,
            "topology" => saved_geometry_binary::encode_saved_mesh_topology(geometry.mesh.mesh)?,
            _ => unreachable!("geometry part validated before read"),
        }
    } else {
        let playback_revision = fullmag_workspace_inspect::locate_results_fem_playback_revision(
            root,
            array_id,
            &query.revision,
            expected_run_id,
        )
        .map_err(map_results_error)?;
        super::workspace_items::playback_geometry_from_root(
            root,
            &WorkspacePlaybackGeometryQuery {
                revision: playback_revision,
                part: query.part.clone(),
            },
        )?
    };
    fullmag_workspace_inspect::ensure_results_revision(root, &query.revision, expected_run_id)
        .map_err(map_results_error)?;
    Ok(body)
}

fn enrich_nodal_array(
    array: &mut WorkspaceResultArray,
    geometry: fullmag_workspace_inspect::ResultsFemNodalGeometry,
) -> Result<(), ApiError> {
    let mut mesh = fullmag_workspace_inspect::SavedPlaybackFemMesh {
        node_count: geometry.mesh.mesh.nodes.len(),
        cell_count: geometry.mesh.mesh.cells.len(),
        facet_count: geometry.mesh.mesh.facets.len(),
        geometry_sha256: geometry.geometry_sha256.clone(),
        topology_byte_length: None,
        topology_sha256: None,
        support_byte_length: None,
        support_sha256: None,
    };
    if let Some((length, hash)) =
        saved_geometry_binary::mesh_topology_binary_identity(&geometry.mesh.mesh)?
    {
        mesh.topology_byte_length = Some(length);
        mesh.topology_sha256 = Some(hash);
    }
    if let Some((body, hash)) =
        saved_geometry_binary::bounded_support_binary_identity(&geometry.active_node_mask)?
    {
        mesh.support_byte_length = Some(body.len());
        mesh.support_sha256 = Some(hash);
    }
    let binary_available = mesh.topology_sha256.is_some() && mesh.support_sha256.is_some();
    let reason = (!binary_available)
        .then(|| "exact FEM geometry exceeds the bounded binary transport budget".to_string());
    array.geometry = Some(fullmag_workspace_inspect::WorkspaceResultGeometry {
        kind: WorkspaceResultGeometryKind::FemP1,
        cells_xyz: None,
        cell_size_m: None,
        origin_m: None,
        component_count: Some(geometry.binding.component_count),
        node_count: Some(mesh.node_count),
        cell_count: Some(mesh.cell_count),
        topology_array_id: None,
        playback_geometry_sha256: Some(geometry.geometry_sha256),
        fem_mesh: Some(mesh),
        reason: reason.clone(),
    });
    // The validated producer contract is authoritative also for canonical
    // scalar/vector quantities absent from the legacy reader's small catalog.
    array.component_count = Some(geometry.binding.component_count);
    array.field_layout = Some(geometry.binding.field_layout.as_str().to_string());
    array.can_visualize_3d = array.can_read_values && binary_available;
    if array.can_read_values {
        array.reason = reason;
    }
    Ok(())
}

fn enrich_fem_array(
    root: &Path,
    mut array: WorkspaceResultArray,
    expected_run_id: Option<&str>,
) -> Result<WorkspaceResultArray, ApiError> {
    match fullmag_workspace_inspect::read_results_fem_nodal_geometry(
        root,
        &array.id,
        &array.revision,
        expected_run_id,
    ) {
        Ok(Some(geometry)) => {
            enrich_nodal_array(&mut array, geometry)?;
            return Ok(array);
        }
        Ok(None) => {} // Only an absent binding permits legacy playback.
        Err(
            error @ (ResultsError::Invalid(_)
            | ResultsError::Unsupported(_)
            | ResultsError::TooLarge(_)
            | ResultsError::Link(_)),
        ) => {
            array.can_visualize_3d = false;
            array.geometry = None;
            array.reason = Some(error.to_string());
            return Ok(array);
        }
        Err(error) => return Err(map_results_error(error)),
    }
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

#[cfg(test)]
mod receipt_budget_tests {
    use super::*;

    #[test]
    fn reduced_budget_does_not_disguise_missing_files_or_non_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("receipt.json"), b"{}").unwrap();
        fs::create_dir(root.path().join("directory")).unwrap();
        for name in ["missing.json", "directory"] {
            let mut remaining = 1;
            let error =
                read_bounded_json(&root.path().join(name), "receipt", &mut remaining).unwrap_err();
            assert_eq!(error.status, StatusCode::CONFLICT);
            assert_eq!(
                error.code.as_deref(),
                Some("current_results_publication_unavailable")
            );
            assert_eq!(remaining, 1);
        }
        let mut remaining = 1;
        let error = read_bounded_json(&root.path().join("receipt.json"), "receipt", &mut remaining)
            .unwrap_err();
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            error.code.as_deref(),
            Some("current_results_discovery_budget_exceeded")
        );
    }

    #[cfg(unix)]
    #[test]
    fn reduced_budget_keeps_symlink_rejection_distinct() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("receipt.json"), b"{}").unwrap();
        std::os::unix::fs::symlink(
            root.path().join("receipt.json"),
            root.path().join("link.json"),
        )
        .unwrap();
        let mut remaining = 1;
        let error = read_bounded_json(&root.path().join("link.json"), "receipt", &mut remaining)
            .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(
            error.code.as_deref(),
            Some("current_results_publication_unavailable")
        );
    }
}
