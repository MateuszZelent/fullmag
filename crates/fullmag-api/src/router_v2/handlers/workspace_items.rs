//! `/v2/workspace/...`: the per-user workspace database over HTTP.
//!
//! The API process runs on the user's machine and owns reads and bookkeeping
//! of the same `workspace.db` the desktop host and the CLI use, so the browser
//! build shows the same recent projects, scripts and result folders. The
//! handlers are thin: SQLite and file reads run on the blocking pool, every
//! reader failure is reported inside the detail document, and nothing a
//! renderer sends is read or executed except `POST /items` and
//! `PUT /roots`, which are explicit user actions on an absolute path.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use fullmag_workspace::{
    identity, now_rfc3339, Actor, Item, ItemKind, ItemStatus, OpenOutcome, Query as DbQuery, Sort,
    Workspace, WorkspaceError,
};
use fullmag_workspace_inspect::scanner::{
    classify_path, describe, scan_roots, store_observed, ScanOptions,
};
use fullmag_workspace_inspect::{display_path, inspect_item, link};

use super::workspace_archive as archive;
use crate::error::ApiError;
use crate::schemas::workspace_items::{
    FramesPage, WorkspaceAddRequest, WorkspaceEvent, WorkspaceForgetResult, WorkspaceFramesQuery,
    WorkspaceSetting, WorkspaceSettingRequest, WorkspaceHistory,
    WorkspaceHistoryQuery, WorkspaceItem, WorkspaceItemDetail, WorkspaceItemKind, WorkspaceItemList,
    WorkspaceItemStatus, WorkspaceItemsQuery, WorkspaceOpenState, WorkspaceOutcome,
    WorkspacePinRequest, WorkspaceRoot, WorkspaceRoots, WorkspaceRootsRequest,
    WorkspaceRootsSource, WorkspaceScanReport, WorkspaceScanRequest, WorkspaceThumbnailOrigin,
};

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;
const DEFAULT_HISTORY_LIMIT: usize = 100;
const MAX_HISTORY_LIMIT: usize = 500;
const DETAIL_EVENTS: usize = 30;
const MAX_ROOTS: usize = 64;
/// `kv` key the desktop host keeps its project roots under.
const LEGACY_ROOTS_KEY: &str = "recent_scanned_locations";

static SCAN_RUNNING: AtomicBool = AtomicBool::new(false);

// ── handlers ───────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/v2/workspace/items",
    params(WorkspaceItemsQuery),
    responses(
        (status = 200, description = "Recent projects, scripts and result folders", body = WorkspaceItemList),
        (status = 400, description = "Unknown kind or sort"),
        (status = 500, description = "The workspace database could not be opened"),
    ),
    tag = "workspace_items"
)]
pub async fn list_items(
    Query(query): Query<WorkspaceItemsQuery>,
) -> Result<Json<WorkspaceItemList>, ApiError> {
    run(move |db| list_items_at(db, &query)).await.map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}",
    params(("id" = String, Path, description = "Item id (decimal string)")),
    responses(
        (status = 200, description = "Item with the facts read from its file now", body = WorkspaceItemDetail),
        (status = 404, description = "Unknown or forgotten item"),
    ),
    tag = "workspace_items"
)]
pub async fn get_item(AxumPath(id): AxumPath<String>) -> Result<Json<WorkspaceItemDetail>, ApiError> {
    run(move |db| get_item_at(db, &id)).await.map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}/thumbnail",
    params(("id" = String, Path, description = "Item id (decimal string)")),
    responses(
        (status = 200, description = "PNG preview of the item", content_type = "image/png"),
        (status = 304, description = "The preview did not change (ETag matched)"),
        (status = 404, description = "The item has no preview"),
    ),
    tag = "workspace_items"
)]
pub async fn get_item_thumbnail(
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let matched = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let thumbnail = run(move |db| thumbnail_at(db, &id)).await?;
    let etag = format!("\"{}\"", thumbnail.sha256);
    let not_modified = matched.as_deref().is_some_and(|candidates| {
        candidates
            .split(',')
            .map(|candidate| candidate.trim().trim_start_matches("W/"))
            .any(|candidate| candidate == etag || candidate == "*")
    });
    let mut response = if not_modified {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        (StatusCode::OK, thumbnail.png).into_response()
    };
    let headers = response.headers_mut();
    if !not_modified {
        headers.insert(header::CONTENT_TYPE, "image/png".parse().expect("static"));
    }
    headers.insert(header::ETAG, etag.parse().expect("hex digest is a header value"));
    headers.insert(
        header::CACHE_CONTROL,
        "private, max-age=0, must-revalidate".parse().expect("static"),
    );
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}/archive",
    params(("id" = String, Path, description = "Result item id (decimal string)")),
    responses(
        (status = 200, description = "Zip of the result folder, streamed", content_type = "application/zip"),
        (status = 400, description = "The item is not a result folder"),
        (status = 404, description = "Unknown, forgotten or missing item"),
        (status = 409, description = "The folder contains a link or a name that cannot be archived"),
        (status = 413, description = "The folder exceeds the archive size or file limit"),
    ),
    tag = "workspace_items"
)]
pub async fn get_item_archive(AxumPath(id): AxumPath<String>) -> Result<Response, ApiError> {
    let (plan, file_name) = run(move |db| archive_plan_at(db, &id)).await?;
    let body = archive::archive_body(plan, archive::MAX_ARCHIVE_BYTES);
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, "application/zip".parse().expect("static"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{file_name}\"")
            .parse()
            .expect("the download name is ASCII"),
    );
    headers.insert(header::CACHE_CONTROL, "no-store".parse().expect("static"));
    Ok(response)
}

#[utoipa::path(
    post,
    path = "/v2/workspace/items/{id}/pin",
    params(("id" = String, Path, description = "Item id (decimal string)")),
    request_body = WorkspacePinRequest,
    responses(
        (status = 200, description = "The item with its new pin state", body = WorkspaceItem),
        (status = 404, description = "Unknown item"),
        (status = 409, description = "The database is read-only (newer schema)"),
    ),
    tag = "workspace_items"
)]
pub async fn pin_item(
    AxumPath(id): AxumPath<String>,
    Json(request): Json<WorkspacePinRequest>,
) -> Result<Json<WorkspaceItem>, ApiError> {
    run(move |db| pin_item_at(db, &id, request.pinned))
        .await
        .map(Json)
}

#[utoipa::path(
    post,
    path = "/v2/workspace/items/{id}/forget",
    params(("id" = String, Path, description = "Item id (decimal string)")),
    responses(
        (status = 200, description = "The item no longer appears in lists; its file is untouched", body = WorkspaceForgetResult),
        (status = 404, description = "Unknown item"),
        (status = 409, description = "The database is read-only (newer schema)"),
    ),
    tag = "workspace_items"
)]
pub async fn forget_item(
    AxumPath(id): AxumPath<String>,
) -> Result<Json<WorkspaceForgetResult>, ApiError> {
    run(move |db| forget_item_at(db, &id)).await.map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}/history",
    params(("id" = String, Path, description = "Item id (decimal string)"), WorkspaceHistoryQuery),
    responses(
        (status = 200, description = "Events of the item, newest first", body = WorkspaceHistory),
        (status = 404, description = "Unknown item"),
    ),
    tag = "workspace_items"
)]
pub async fn get_item_history(
    AxumPath(id): AxumPath<String>,
    Query(query): Query<WorkspaceHistoryQuery>,
) -> Result<Json<WorkspaceHistory>, ApiError> {
    run(move |db| history_at(db, &id, &query)).await.map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/workspace/items/{id}/frames",
    params(("id" = String, Path, description = "Result item id (decimal string)"), WorkspaceFramesQuery),
    responses(
        (status = 200, description = "A page of the saved-frame index (`frames.json`); `indexed` is false when the run wrote none", body = FramesPage),
        (status = 400, description = "The item is not a result folder"),
        (status = 404, description = "Unknown, forgotten or missing item"),
    ),
    tag = "workspace_items"
)]
pub async fn get_item_frames(
    AxumPath(id): AxumPath<String>,
    Query(query): Query<WorkspaceFramesQuery>,
) -> Result<Json<FramesPage>, ApiError> {
    run(move |db| frames_at(db, &id, &query)).await.map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/workspace/settings/{key}",
    params(("key" = String, Path, description = "`telemetry.enabled` or `update.available`")),
    responses(
        (status = 200, description = "The stored value, or the default when unset", body = WorkspaceSetting),
        (status = 404, description = "The key is not an allow-listed setting"),
    ),
    tag = "workspace_items"
)]
pub async fn get_setting(AxumPath(key): AxumPath<String>) -> Result<Json<WorkspaceSetting>, ApiError> {
    run(move |db| get_setting_at(db, &key)).await.map(Json)
}

#[utoipa::path(
    put,
    path = "/v2/workspace/settings/{key}",
    params(("key" = String, Path, description = "`telemetry.enabled`")),
    request_body = WorkspaceSettingRequest,
    responses(
        (status = 200, description = "Setting saved", body = WorkspaceSetting),
        (status = 400, description = "The value has the wrong type, or the key is not writable through the API"),
        (status = 404, description = "The key is not an allow-listed setting"),
        (status = 409, description = "The database is read-only (newer schema)"),
    ),
    tag = "workspace_items"
)]
pub async fn put_setting(
    AxumPath(key): AxumPath<String>,
    Json(request): Json<WorkspaceSettingRequest>,
) -> Result<Json<WorkspaceSetting>, ApiError> {
    run(move |db| put_setting_at(db, &key, request.value))
        .await
        .map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/workspace/roots",
    responses(
        (status = 200, description = "Folders the scanner looks through", body = WorkspaceRoots),
    ),
    tag = "workspace_items"
)]
pub async fn get_roots() -> Result<Json<WorkspaceRoots>, ApiError> {
    run(roots_at).await.map(Json)
}

#[utoipa::path(
    put,
    path = "/v2/workspace/roots",
    request_body = WorkspaceRootsRequest,
    responses(
        (status = 200, description = "Roots saved", body = WorkspaceRoots),
        (status = 400, description = "A root is not an absolute existing folder"),
        (status = 409, description = "The database is read-only (newer schema)"),
    ),
    tag = "workspace_items"
)]
pub async fn put_roots(
    Json(request): Json<WorkspaceRootsRequest>,
) -> Result<Json<WorkspaceRoots>, ApiError> {
    run(move |db| put_roots_at(db, &request.roots)).await.map(Json)
}

#[utoipa::path(
    post,
    path = "/v2/workspace/scan",
    request_body(content = WorkspaceScanRequest, description = "Optional; an empty body scans the saved roots"),
    responses(
        (status = 200, description = "What the scan found", body = WorkspaceScanReport),
        (status = 400, description = "Invalid roots or body"),
        (status = 409, description = "A scan is already running, or the database is read-only"),
    ),
    tag = "workspace_items"
)]
pub async fn post_scan(body: Bytes) -> Result<Json<WorkspaceScanReport>, ApiError> {
    let request: WorkspaceScanRequest = if body.iter().all(u8::is_ascii_whitespace) {
        WorkspaceScanRequest::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|error| ApiError::bad_request(format!("invalid scan request: {error}")))?
    };
    if SCAN_RUNNING.swap(true, Ordering::SeqCst) {
        return Err(ApiError::conflict_with_code(
            "workspace_scan_running",
            "a workspace scan is already running",
        ));
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            SCAN_RUNNING.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release;
    run(move |db| scan_at(db, request.roots.as_deref(), &ScanOptions::default()))
        .await
        .map(Json)
}

#[utoipa::path(
    post,
    path = "/v2/workspace/items",
    request_body = WorkspaceAddRequest,
    responses(
        (status = 200, description = "The added (or refreshed) item", body = WorkspaceItem),
        (status = 400, description = "The path cannot be added"),
        (status = 409, description = "The database is read-only (newer schema)"),
    ),
    tag = "workspace_items"
)]
pub async fn post_item(Json(request): Json<WorkspaceAddRequest>) -> Result<Json<WorkspaceItem>, ApiError> {
    run(move |db| add_item_at(db, &request)).await.map(Json)
}

// ── plumbing ───────────────────────────────────────────────────────────────

/// Run `body` on the blocking pool against the default database path.
async fn run<T: Send + 'static>(
    body: impl FnOnce(&Path) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let db = fullmag_workspace::default_database_path().map_err(|error| {
        ApiError::internal(format!("cannot resolve the Fullmag state directory: {error}"))
    })?;
    tokio::task::spawn_blocking(move || body(&db))
        .await
        .map_err(|_| ApiError::internal("workspace task failed"))?
}

fn open(db: &Path) -> Result<(Workspace, OpenOutcome), ApiError> {
    Workspace::open(db).map_err(map_error)
}

fn open_writable(db: &Path) -> Result<Workspace, ApiError> {
    let (workspace, _) = open(db)?;
    if let Some((found, supported)) = workspace.read_only_reason() {
        return Err(read_only_error(found, supported));
    }
    Ok(workspace)
}

fn read_only_error(found: u32, supported: u32) -> ApiError {
    ApiError::conflict_with_code(
        "workspace_read_only",
        format!(
            "the workspace database was written by a newer Fullmag (schema {found}, this build \
             supports {supported}); it is opened read-only"
        ),
    )
}

fn map_error(error: WorkspaceError) -> ApiError {
    match error {
        WorkspaceError::NotFound(what) => ApiError::not_found(format!("workspace item not found: {what}")),
        WorkspaceError::ReadOnly { found, supported } => read_only_error(found, supported),
        WorkspaceError::Invalid(message) => ApiError::bad_request(message),
        other => ApiError::internal(other.to_string()),
    }
}

fn parse_id(text: &str) -> Result<i64, ApiError> {
    if text.is_empty() || text.len() > 18 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::bad_request(format!(
            "invalid item id `{text}`: expected a decimal string"
        )));
    }
    text.parse::<i64>()
        .map_err(|_| ApiError::bad_request(format!("invalid item id `{text}`")))
}

fn outcome_dto(outcome: &OpenOutcome) -> WorkspaceOutcome {
    match outcome {
        OpenOutcome::Ready => WorkspaceOutcome {
            state: WorkspaceOpenState::Ready,
            detail: None,
        },
        OpenOutcome::Created => WorkspaceOutcome {
            state: WorkspaceOpenState::Created,
            detail: None,
        },
        OpenOutcome::Migrated { from, to } => WorkspaceOutcome {
            state: WorkspaceOpenState::Migrated,
            detail: Some(format!("schema {from} -> {to}")),
        },
        OpenOutcome::Quarantined { backup, reason } => WorkspaceOutcome {
            state: WorkspaceOpenState::Quarantined,
            detail: Some(format!(
                "the previous database was damaged ({reason}); kept as {}",
                display_path(&backup.display().to_string())
            )),
        },
        OpenOutcome::ReadOnlyNewerSchema { found, supported } => WorkspaceOutcome {
            state: WorkspaceOpenState::ReadOnlyNewerSchema,
            detail: Some(format!(
                "schema {found} is newer than the supported {supported}; writes are refused"
            )),
        },
    }
}

fn kind_dto(kind: ItemKind) -> WorkspaceItemKind {
    match kind {
        ItemKind::Project => WorkspaceItemKind::Project,
        ItemKind::Script => WorkspaceItemKind::Script,
        ItemKind::Result => WorkspaceItemKind::Result,
    }
}

fn kind_from_dto(kind: WorkspaceItemKind) -> ItemKind {
    match kind {
        WorkspaceItemKind::Project => ItemKind::Project,
        WorkspaceItemKind::Script => ItemKind::Script,
        WorkspaceItemKind::Result => ItemKind::Result,
    }
}

fn status_dto(status: ItemStatus) -> WorkspaceItemStatus {
    match status {
        ItemStatus::Ready => WorkspaceItemStatus::Ready,
        ItemStatus::Missing => WorkspaceItemStatus::Missing,
        ItemStatus::Failed => WorkspaceItemStatus::Failed,
        ItemStatus::Migrate => WorkspaceItemStatus::Migrate,
        ItemStatus::Readonly => WorkspaceItemStatus::Readonly,
    }
}

/// A file that vanished (or came back) since the last stat reads as such
/// without a database write; the stored status is only a cache.
fn live_status(item: &Item) -> ItemStatus {
    match (Path::new(&item.path).exists(), item.status) {
        (false, _) => ItemStatus::Missing,
        (true, ItemStatus::Missing) => ItemStatus::Ready,
        (true, other) => other,
    }
}

/// Which items have a preview image, and where a result folder gets one.
///
/// A project owns its stored preview (`project/preview/thumb.png`). A result
/// folder has no image of its own: it shows the stored preview of the project
/// named in its run manifest, and only that; a script run or a folder without
/// a manifest has none, and nothing is rendered in its place.
pub(crate) struct Thumbnails {
    own: HashSet<i64>,
    /// Stored preview owner by stable project id.
    project_by_id: HashMap<String, i64>,
}

impl Thumbnails {
    /// The item whose stored PNG `item` shows, and whether it is its own.
    fn target(&self, item: &Item) -> Option<(i64, WorkspaceThumbnailOrigin)> {
        if self.own.contains(&item.id) {
            return Some((item.id, WorkspaceThumbnailOrigin::Item));
        }
        if item.kind != ItemKind::Result {
            return None;
        }
        let source = item.meta.get("source")?;
        if source.get("kind").and_then(|kind| kind.as_str()) != Some("project") {
            return None;
        }
        let project_id = source.get("project_id").and_then(|id| id.as_str())?;
        self.project_by_id
            .get(project_id)
            .map(|id| (*id, WorkspaceThumbnailOrigin::SourceProject))
    }
}

fn item_dto(item: &Item, thumbnails: &Thumbnails) -> WorkspaceItem {
    let target = thumbnails.target(item);
    WorkspaceItem {
        id: item.id.to_string(),
        kind: kind_dto(item.kind),
        path: display_path(&item.path),
        name: item.name.clone(),
        project_id: item.project_id.clone(),
        first_seen_at: item.first_seen_at.clone(),
        last_used_at: item.last_used_at.clone(),
        use_count: item.use_count,
        pinned: item.pinned,
        status: status_dto(live_status(item)),
        size_bytes: item.size_bytes,
        modified_at: item.modified_at.clone(),
        meta: item.meta.clone(),
        has_thumbnail: target.is_some(),
        thumbnail_origin: target.map(|(_, origin)| origin),
    }
}

fn event_dto(event: &fullmag_workspace::Event) -> WorkspaceEvent {
    WorkspaceEvent {
        id: event.id.to_string(),
        at: event.at.clone(),
        kind: event.kind.as_str().to_string(),
        actor: event.actor.as_str().to_string(),
        detail: event.detail.clone(),
    }
}

fn thumbnails_of(workspace: &Workspace) -> Result<Thumbnails, ApiError> {
    let own = workspace.thumbnail_item_ids().map_err(map_error)?;
    let mut project_by_id = HashMap::new();
    if !own.is_empty() {
        let projects = workspace
            .list(&DbQuery {
                kind: Some(ItemKind::Project),
                limit: 100_000,
                ..DbQuery::default()
            })
            .map_err(map_error)?;
        for project in projects {
            if let Some(project_id) = project.project_id.clone() {
                if own.contains(&project.id) {
                    project_by_id.entry(project_id).or_insert(project.id);
                }
            }
        }
    }
    Ok(Thumbnails { own, project_by_id })
}

fn items_dto(workspace: &Workspace, items: &[Item]) -> Result<Vec<WorkspaceItem>, ApiError> {
    let thumbnails = thumbnails_of(workspace)?;
    Ok(items.iter().map(|item| item_dto(item, &thumbnails)).collect())
}

fn require_visible(workspace: &Workspace, id: i64) -> Result<Item, ApiError> {
    match workspace.find(id).map_err(map_error)? {
        Some(item) if !item.forgotten => Ok(item),
        _ => Err(ApiError::not_found(format!("workspace item not found: {id}"))),
    }
}

// ── operations (testable without HTTP or the process environment) ─────────

pub(crate) fn list_items_at(db: &Path, query: &WorkspaceItemsQuery) -> Result<WorkspaceItemList, ApiError> {
    let (kind, include_results) = match query.kind.as_deref().unwrap_or("all") {
        "all" => (None, true),
        other => match ItemKind::parse(other) {
            Some(kind) => (Some(kind), true),
            None => {
                return Err(ApiError::bad_request(format!(
                    "unknown kind `{other}`; expected all, project, script or result"
                )))
            }
        },
    };
    let sort = match query.sort.as_deref() {
        None => Sort::LastUsed,
        Some(name) => Sort::parse(name).ok_or_else(|| {
            ApiError::bad_request(format!(
                "unknown sort `{name}`; expected last_used, name, modified or use_count"
            ))
        })?,
    };
    let include_missing = query.include_missing.unwrap_or(true);
    let (workspace, outcome) = open(db)?;
    let items = workspace
        .list(&DbQuery {
            kind,
            sort,
            search: query.search.clone(),
            limit: query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
            // The stored status is a cache; filter on the live one below.
            include_missing: true,
            include_results,
        })
        .map_err(map_error)?;
    let items: Vec<Item> = items
        .into_iter()
        .filter(|item| include_missing || live_status(item) != ItemStatus::Missing)
        .collect();
    Ok(WorkspaceItemList {
        items: items_dto(&workspace, &items)?,
        outcome: outcome_dto(&outcome),
    })
}

pub(crate) fn get_item_at(db: &Path, id: &str) -> Result<WorkspaceItemDetail, ApiError> {
    let id = parse_id(id)?;
    let (workspace, _) = open(db)?;
    let mut item = require_visible(&workspace, id)?;
    if workspace.read_only_reason().is_none() {
        // Re-stat, and for a script record an `edit` when its digest changed.
        // A failure keeps the stored row: the detail below reports file problems.
        if let Ok(fresh) = workspace.refresh_file_state_as(id, Actor::Web) {
            item = fresh;
        }
    }
    let mut detail = inspect_item(&item);
    if let fullmag_workspace_inspect::ItemDetail::Script(script) = &mut detail {
        // Parser-backed facts when an interpreter resolves; the static scan
        // (with its reason) otherwise. The script is never executed.
        crate::script_check::apply_script_check(Path::new(&item.path), script);
    }
    let events = workspace.history(id, DETAIL_EVENTS).map_err(map_error)?;
    let linked_results = link::linked_results(&workspace, &item).map_err(map_error)?;
    let linked_source = if item.kind == ItemKind::Result {
        link::linked_source(&workspace, &item).map_err(map_error)?
    } else {
        None
    };
    let thumbnails = thumbnails_of(&workspace)?;
    Ok(WorkspaceItemDetail {
        item: item_dto(&item, &thumbnails),
        detail,
        events: events.iter().map(event_dto).collect(),
        read_at: now_rfc3339(),
        linked_results: linked_results
            .iter()
            .map(|result| item_dto(result, &thumbnails))
            .collect(),
        linked_source: linked_source.map(|source| item_dto(&source, &thumbnails)),
    })
}

pub(crate) fn thumbnail_at(db: &Path, id: &str) -> Result<fullmag_workspace::Thumbnail, ApiError> {
    let id = parse_id(id)?;
    let (workspace, _) = open(db)?;
    let item = require_visible(&workspace, id)?;
    let (owner, _) = thumbnails_of(&workspace)?
        .target(&item)
        .ok_or_else(|| ApiError::not_found(format!("workspace item {id} has no preview")))?;
    workspace
        .get_thumbnail(owner)
        .map_err(map_error)?
        .ok_or_else(|| ApiError::not_found(format!("workspace item {id} has no preview")))
}

/// The files of a result folder that `GET .../archive` would stream, checked
/// before any byte is sent. Only result folders are archived.
pub(crate) fn archive_plan_at(
    db: &Path,
    id: &str,
) -> Result<(archive::ArchivePlan, String), ApiError> {
    let id = parse_id(id)?;
    let (workspace, _) = open(db)?;
    let item = require_visible(&workspace, id)?;
    if item.kind != ItemKind::Result {
        return Err(ApiError::bad_request(
            "only result folders can be downloaded as an archive",
        ));
    }
    if live_status(&item) == ItemStatus::Missing {
        return Err(ApiError::not_found(format!(
            "the folder of workspace item {id} is missing"
        )));
    }
    let plan = archive::plan_archive(
        Path::new(&item.path),
        archive::MAX_ARCHIVE_BYTES,
        archive::MAX_ARCHIVE_FILES,
    )?;
    Ok((plan, archive::download_name(&item.name)))
}

const DEFAULT_FRAMES_LIMIT: usize = 200;
const TELEMETRY_KEY: &str = "telemetry.enabled";
const UPDATE_KEY: &str = "update.available";

/// One page of the saved-frame index of a result folder. Only `frames.json`
/// is read; no chunk or field file is opened.
pub(crate) fn frames_at(
    db: &Path,
    id: &str,
    query: &WorkspaceFramesQuery,
) -> Result<FramesPage, ApiError> {
    let id = parse_id(id)?;
    let (workspace, _) = open(db)?;
    let item = require_visible(&workspace, id)?;
    if item.kind != ItemKind::Result {
        return Err(ApiError::bad_request(
            "only result folders have a saved-frame index",
        ));
    }
    if live_status(&item) == ItemStatus::Missing {
        return Err(ApiError::not_found(format!(
            "the folder of workspace item {id} is missing"
        )));
    }
    Ok(fullmag_workspace_inspect::read_frames_page(
        Path::new(&item.path),
        query.from.unwrap_or(0),
        query.limit.unwrap_or(DEFAULT_FRAMES_LIMIT),
    ))
}

/// `(default value, writable through the API)` of an allow-listed key.
fn setting_default(key: &str) -> Option<(serde_json::Value, bool)> {
    match key {
        TELEMETRY_KEY => Some((serde_json::Value::Bool(false), true)),
        UPDATE_KEY => Some((serde_json::Value::Null, false)),
        _ => None,
    }
}

fn unknown_setting(key: &str) -> ApiError {
    ApiError::not_found(format!(
        "unknown setting `{key}`; expected {TELEMETRY_KEY} or {UPDATE_KEY}"
    ))
}

pub(crate) fn get_setting_at(db: &Path, key: &str) -> Result<WorkspaceSetting, ApiError> {
    let (default, writable) = setting_default(key).ok_or_else(|| unknown_setting(key))?;
    let (workspace, _) = open(db)?;
    let stored = workspace.get_kv(key).map_err(map_error)?;
    // A stored value of the wrong type is reported as unset, never coerced.
    let stored = stored.filter(|value| key != TELEMETRY_KEY || value.is_boolean());
    Ok(WorkspaceSetting {
        key: key.to_string(),
        is_default: stored.is_none(),
        value: stored.unwrap_or(default),
        writable,
    })
}

pub(crate) fn put_setting_at(
    db: &Path,
    key: &str,
    value: serde_json::Value,
) -> Result<WorkspaceSetting, ApiError> {
    let (_, writable) = setting_default(key).ok_or_else(|| unknown_setting(key))?;
    if !writable {
        return Err(ApiError::bad_request(format!(
            "`{key}` is written by an updater and cannot be set through the API"
        )));
    }
    if !value.is_boolean() {
        return Err(ApiError::bad_request(format!("`{key}` must be a boolean")));
    }
    let workspace = open_writable(db)?;
    workspace.set_kv(key, &value).map_err(map_error)?;
    Ok(WorkspaceSetting {
        key: key.to_string(),
        value,
        is_default: false,
        writable,
    })
}

pub(crate) fn pin_item_at(db: &Path, id: &str, pinned: bool) -> Result<WorkspaceItem, ApiError> {
    let id = parse_id(id)?;
    let workspace = open_writable(db)?;
    require_visible(&workspace, id)?;
    let item = workspace.pin(id, pinned, Actor::Web).map_err(map_error)?;
    let thumbnails = thumbnails_of(&workspace)?;
    Ok(item_dto(&item, &thumbnails))
}

pub(crate) fn forget_item_at(db: &Path, id: &str) -> Result<WorkspaceForgetResult, ApiError> {
    let id = parse_id(id)?;
    let workspace = open_writable(db)?;
    require_visible(&workspace, id)?;
    workspace.forget(id, Actor::Web).map_err(map_error)?;
    Ok(WorkspaceForgetResult {
        id: id.to_string(),
        forgotten: true,
    })
}

pub(crate) fn history_at(
    db: &Path,
    id: &str,
    query: &WorkspaceHistoryQuery,
) -> Result<WorkspaceHistory, ApiError> {
    let id = parse_id(id)?;
    let (workspace, _) = open(db)?;
    require_visible(&workspace, id)?;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .clamp(1, MAX_HISTORY_LIMIT);
    let events = workspace.history(id, limit).map_err(map_error)?;
    Ok(WorkspaceHistory {
        events: events.iter().map(event_dto).collect(),
    })
}

fn root_dto(root: &fullmag_workspace::WorkspaceRoot) -> WorkspaceRoot {
    WorkspaceRoot {
        path: display_path(&root.path),
        kinds: root.kinds.iter().map(|kind| kind_dto(*kind)).collect(),
        recursive: root.recursive,
        enabled: root.enabled,
    }
}

/// The saved roots, else the project folders the desktop host last scanned.
fn effective_roots(
    workspace: &Workspace,
) -> Result<(Vec<fullmag_workspace::WorkspaceRoot>, WorkspaceRootsSource), ApiError> {
    let configured = workspace.roots().map_err(map_error)?;
    if !configured.is_empty() {
        return Ok((configured, WorkspaceRootsSource::Configured));
    }
    let legacy: Vec<fullmag_workspace::WorkspaceRoot> = workspace
        .get_kv(LEGACY_ROOTS_KEY)
        .map_err(map_error)?
        .and_then(|value| value.as_array().cloned())
        .into_iter()
        .flatten()
        .filter_map(|location| {
            let path = location.get("path").and_then(|path| path.as_str())?;
            Some(fullmag_workspace::WorkspaceRoot {
                path: path.to_string(),
                kinds: vec![ItemKind::Project],
                recursive: location
                    .get("recursive")
                    .and_then(|flag| flag.as_bool())
                    .unwrap_or(true),
                enabled: true,
            })
        })
        .collect();
    if legacy.is_empty() {
        Ok((Vec::new(), WorkspaceRootsSource::None))
    } else {
        Ok((legacy, WorkspaceRootsSource::Legacy))
    }
}

pub(crate) fn roots_at(db: &Path) -> Result<WorkspaceRoots, ApiError> {
    let (workspace, _) = open(db)?;
    let (roots, source) = effective_roots(&workspace)?;
    Ok(WorkspaceRoots {
        roots: roots.iter().map(root_dto).collect(),
        source,
    })
}

/// Roots must be absolute existing folders; they are stored in their
/// normalised absolute spelling, once each.
pub(crate) fn validate_roots(
    roots: &[WorkspaceRoot],
) -> Result<Vec<fullmag_workspace::WorkspaceRoot>, ApiError> {
    if roots.len() > MAX_ROOTS {
        return Err(ApiError::bad_request(format!(
            "at most {MAX_ROOTS} roots are supported"
        )));
    }
    let mut seen = HashSet::new();
    let mut accepted = Vec::new();
    for root in roots {
        let path = PathBuf::from(&root.path);
        if !path.is_absolute() {
            return Err(ApiError::bad_request(format!(
                "root `{}` must be an absolute path",
                root.path
            )));
        }
        if path.components().any(|part| part == Component::ParentDir) {
            return Err(ApiError::bad_request(format!(
                "root `{}` must not contain `..`",
                root.path
            )));
        }
        if !path.is_dir() {
            return Err(ApiError::bad_request(format!(
                "root `{}` is not an existing folder",
                root.path
            )));
        }
        let ident = identity(&path).map_err(map_error)?;
        if !seen.insert(ident.key) {
            continue;
        }
        let mut kinds = Vec::new();
        for kind in &root.kinds {
            let kind = kind_from_dto(*kind);
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
        accepted.push(fullmag_workspace::WorkspaceRoot {
            path: ident.path,
            kinds,
            recursive: root.recursive,
            enabled: root.enabled,
        });
    }
    Ok(accepted)
}

pub(crate) fn put_roots_at(db: &Path, roots: &[WorkspaceRoot]) -> Result<WorkspaceRoots, ApiError> {
    let accepted = validate_roots(roots)?;
    let workspace = open_writable(db)?;
    workspace.set_roots(&accepted).map_err(map_error)?;
    Ok(WorkspaceRoots {
        roots: accepted.iter().map(root_dto).collect(),
        source: if accepted.is_empty() {
            WorkspaceRootsSource::None
        } else {
            WorkspaceRootsSource::Configured
        },
    })
}

pub(crate) fn scan_at(
    db: &Path,
    explicit: Option<&[WorkspaceRoot]>,
    options: &ScanOptions,
) -> Result<WorkspaceScanReport, ApiError> {
    let workspace = open_writable(db)?;
    let roots = match explicit {
        Some(roots) => validate_roots(roots)?,
        None => effective_roots(&workspace)?.0,
    };
    let report = scan_roots(&workspace, &roots, options, Actor::Web);
    Ok(WorkspaceScanReport {
        scanned: report.scanned,
        added: report.added,
        updated: report.updated,
        missing: report.missing,
        skipped: report.skipped,
        warnings: report.warnings,
    })
}

pub(crate) fn add_item_at(db: &Path, request: &WorkspaceAddRequest) -> Result<WorkspaceItem, ApiError> {
    let path = PathBuf::from(&request.path);
    let kind = classify_path(&path, request.kind.map(kind_from_dto)).map_err(ApiError::bad_request)?;
    let workspace = open_writable(db)?;
    let receipt = store_observed(&workspace, &describe(&path, kind), Actor::Web, true)
        .map_err(map_error)?;
    let item = workspace
        .find(receipt.item_id)
        .map_err(map_error)?
        .ok_or_else(|| ApiError::internal("the added item disappeared"))?;
    let thumbnails = thumbnails_of(&workspace)?;
    Ok(item_dto(&item, &thumbnails))
}
