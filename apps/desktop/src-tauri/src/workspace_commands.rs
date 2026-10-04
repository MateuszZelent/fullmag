//! Tauri commands over the per-user workspace database (`fullmag-workspace`,
//! spec `docs/design/start-screen/docs/07-workspace-database.md`).
//!
//! The command bodies are thin: every behaviour lives in a plain function over
//! `&Workspace` so it is testable without an `AppHandle`. The database is
//! opened once, lazily, through the crate's default state directory (not
//! Tauri's per-bundle `app_data_dir`, which the CLI cannot see) and cached in
//! managed state; each write is one short transaction inside the crate. The
//! renderer never sends a path: scripts are addressed by item id and the host
//! reads the stored path.

use crate::recent_index;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use fullmag_workspace::{
    script_meta, Actor, Event, EventKind, Item, ItemKind, ItemStatus, OpenOutcome, Query,
    RecordEvent, Sort, Workspace, MAX_SCRIPT_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const DEFAULT_LIST_LIMIT: usize = 200;
const MAX_LIST_LIMIT: usize = 2000;
const DEFAULT_HISTORY_LIMIT: usize = 50;
const MAX_HISTORY_LIMIT: usize = 500;
const PNG_DATA_URI_PREFIX: &str = "data:image/png;base64,";

// ── wire types ──────────────────────────────────────────────────────────

/// How the database was obtained, for the renderer to say when it matters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceOutcome {
    /// `ready`, `created`, `migrated`, `quarantined` or `read_only_newer_schema`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub fn outcome_dto(outcome: &OpenOutcome) -> WorkspaceOutcome {
    match outcome {
        OpenOutcome::Ready => WorkspaceOutcome {
            state: "ready",
            detail: None,
        },
        OpenOutcome::Created => WorkspaceOutcome {
            state: "created",
            detail: None,
        },
        OpenOutcome::Migrated { from, to } => WorkspaceOutcome {
            state: "migrated",
            detail: Some(format!("migrated from schema version {from} to {to}")),
        },
        OpenOutcome::Quarantined { backup, reason } => WorkspaceOutcome {
            state: "quarantined",
            detail: Some(format!(
                "the workspace database was damaged ({reason}); it was kept as {} and a \
                 fresh one was created",
                display_path(&backup.display().to_string())
            )),
        },
        OpenOutcome::ReadOnlyNewerSchema { found, supported } => WorkspaceOutcome {
            state: "read_only_newer_schema",
            detail: Some(format!(
                "the workspace database has schema version {found}, newer than the \
                 supported version {supported}; history is shown but not recorded"
            )),
        },
    }
}

/// One row of the start screen's list, projects and scripts alike.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkspaceItem {
    pub id: i64,
    pub kind: &'static str,
    /// Absolute path without the Windows verbatim prefix.
    pub path: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub first_seen_at: String,
    pub last_used_at: String,
    pub use_count: i64,
    pub pinned: bool,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    pub meta: Value,
}

pub fn item_dto(item: &Item) -> WorkspaceItem {
    WorkspaceItem {
        id: item.id,
        kind: item.kind.as_str(),
        path: display_path(&item.path),
        name: item.name.clone(),
        project_id: item.project_id.clone(),
        first_seen_at: item.first_seen_at.clone(),
        last_used_at: item.last_used_at.clone(),
        use_count: item.use_count,
        pinned: item.pinned,
        status: item.status.as_str(),
        size_bytes: item.size_bytes,
        modified_at: item.modified_at.clone(),
        meta: item.meta.clone(),
    }
}

/// The Windows verbatim prefix (`\\?\`, `\\?\UNC\`) is an implementation detail
/// of path canonicalisation, not something to show.
pub fn display_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KindFilter {
    #[default]
    All,
    Project,
    Script,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceListQuery {
    #[serde(default)]
    pub kind: KindFilter,
    /// `last_used` (default), `name`, `modified` or `use_count`.
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_missing: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceListResult {
    pub items: Vec<WorkspaceItem>,
    pub outcome: WorkspaceOutcome,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkspaceEvent {
    pub at: String,
    pub kind: &'static str,
    pub actor: &'static str,
    pub detail: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceHistory {
    pub events: Vec<WorkspaceEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScriptText {
    /// File name with its extension.
    pub name: String,
    pub path: String,
    pub sha256: String,
    pub text: String,
}

// ── the cached handle ───────────────────────────────────────────────────

/// The open database and how it was obtained.
pub struct Session {
    pub workspace: Workspace,
    pub outcome: WorkspaceOutcome,
}

impl Session {
    /// Open (creating, migrating or recovering) the database at `database`,
    /// then import the legacy `recent-index.json` once. Neither a damaged file
    /// nor an unreadable legacy index stops the application: the first is
    /// quarantined by the crate and reported in the outcome, the second is
    /// logged and skipped.
    pub fn open(database: &Path, legacy_index: Option<&Path>) -> Result<Session, String> {
        let (workspace, outcome) = Workspace::open(database).map_err(|error| error.to_string())?;
        fullmag_workspace::log_outcome(&outcome);
        if workspace.read_only_reason().is_none() {
            if let Some(legacy) = legacy_index {
                import_legacy_index(&workspace, legacy);
            }
        }
        Ok(Session {
            workspace,
            outcome: outcome_dto(&outcome),
        })
    }
}

fn import_legacy_index(workspace: &Workspace, legacy: &Path) {
    match workspace.import_legacy_recent_index(legacy) {
        Ok(report) if report.imported > 0 => {
            migrate_legacy_thumbnails(workspace);
        }
        Ok(_) => {}
        Err(error) => eprintln!("[fullmag-ui] the legacy recent index was not imported: {error}"),
    }
}

/// The legacy import keeps an old index entry's `thumbnail` as
/// `meta.thumbnail_ref`, which can be a whole data URI. Move those previews
/// into the `thumbnails` table and drop the reference: `meta` never carries
/// image bytes. Returns how many previews were moved.
pub fn migrate_legacy_thumbnails(workspace: &Workspace) -> usize {
    let Ok(items) = workspace.list(&Query {
        kind: Some(ItemKind::Project),
        sort: Sort::LastUsed,
        search: None,
        limit: usize::MAX,
        include_missing: true,
    }) else {
        return 0;
    };
    let mut moved = 0;
    for item in items {
        let Some(reference) = item.meta.get("thumbnail_ref").and_then(Value::as_str) else {
            continue;
        };
        if let Some(png) = reference
            .strip_prefix(PNG_DATA_URI_PREFIX)
            .and_then(|encoded| STANDARD.decode(encoded).ok())
        {
            if workspace
                .set_thumbnail(item.id, &recent_index::sha256_hex(&png), &png)
                .is_ok()
            {
                moved += 1;
            }
        }
        // A relative path or an unusable URI is dropped too: a rebuild reads
        // the preview from the archive again.
        let _ = workspace.patch_meta(item.id, &json!({ "thumbnail_ref": null }));
    }
    moved
}

/// Managed state: one lazily opened database shared by every command.
#[derive(Clone, Default)]
pub struct WorkspaceHost {
    session: Arc<Mutex<Option<Session>>>,
    /// Test override of the database location.
    database: Option<PathBuf>,
}

impl WorkspaceHost {
    /// A host bound to one database file instead of the default state directory.
    #[cfg(test)]
    pub fn at(database: PathBuf) -> Self {
        Self {
            session: Arc::default(),
            database: Some(database),
        }
    }

    /// Run `body` on the open database, opening it first when needed. An open
    /// that fails is retried by the next call.
    pub fn with<T>(
        &self,
        legacy_index: Option<&Path>,
        body: impl FnOnce(&Workspace, &WorkspaceOutcome) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.session.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_none() {
            let database = match &self.database {
                Some(path) => path.clone(),
                None => {
                    fullmag_workspace::default_database_path().map_err(|error| error.to_string())?
                }
            };
            *guard = Some(Session::open(&database, legacy_index)?);
        }
        let session = guard.as_ref().expect("session was just opened");
        body(&session.workspace, &session.outcome)
    }
}

/// Run database work off the async executor.
pub async fn run<T: Send + 'static>(
    host: WorkspaceHost,
    legacy_index: Option<PathBuf>,
    body: impl FnOnce(&Workspace, &WorkspaceOutcome) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || host.with(legacy_index.as_deref(), body))
        .await
        .map_err(|error| format!("the workspace operation was interrupted: {error}"))?
}

/// Best-effort mirror of project activity: a locked, damaged or read-only
/// database is logged by the crate and never fails the command that called.
pub async fn mirror(
    host: &WorkspaceHost,
    legacy_index: Option<PathBuf>,
    body: impl FnOnce(&Workspace) + Send + 'static,
) {
    let _ = run(host.clone(), legacy_index, move |workspace, _| {
        body(workspace);
        Ok(())
    })
    .await;
}

/// Where the legacy `recent-index.json` lives: Tauri's per-bundle app-data
/// directory, which only the importer still looks at.
pub fn legacy_index_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(recent_index::INDEX_FILE_NAME))
}

// ── project activity ────────────────────────────────────────────────────

/// A project was opened (file dialog, recent list or path).
pub fn project_open_event(
    path: &Path,
    project_id: &str,
    name: Option<&str>,
    revision: u64,
    read_only: bool,
) -> RecordEvent {
    let mut event = RecordEvent::new(ItemKind::Project, path, EventKind::Open, Actor::Desktop)
        .with_project_id(project_id)
        .with_detail(json!({
            "revision": revision,
            "mode": if read_only { "read_only" } else { "read_write" },
        }))
        .with_meta_patch(json!({ "revision": revision }));
    if let Some(name) = name {
        event = event.with_name(name);
    }
    event
}

/// A project archive was saved by the host.
pub fn project_save_event(
    path: &Path,
    project_id: &str,
    revision: u64,
    save_as: bool,
) -> RecordEvent {
    RecordEvent::new(ItemKind::Project, path, EventKind::Save, Actor::Desktop)
        .with_project_id(project_id)
        .with_detail(json!({ "revision": revision, "save_as": save_as }))
        .with_meta_patch(json!({ "revision": revision }))
}

/// A run outcome was recorded in a project file. `run` is the run record the
/// renderer sent (`run_id`, `status`, `started_at`, `finished_at`, ...).
pub fn project_run_event(
    path: &Path,
    project_id: &str,
    run: &Value,
    revision: u64,
    now: &str,
) -> RecordEvent {
    let text = |key: &str| run.get(key).and_then(Value::as_str);
    let mut detail = Map::new();
    let mut last_run = Map::new();
    if let Some(run_id) = text("run_id") {
        detail.insert("run_id".into(), json!(run_id));
        last_run.insert("run_id".into(), json!(run_id));
    }
    if let Some(status) = text("status") {
        detail.insert("status".into(), json!(status));
        last_run.insert("status".into(), json!(status));
    }
    detail.insert("revision".into(), json!(revision));
    let at = text("finished_at").or(text("started_at")).unwrap_or(now);
    last_run.insert("at".into(), json!(at));
    RecordEvent::new(ItemKind::Project, path, EventKind::Run, Actor::Desktop)
        .with_project_id(project_id)
        .with_detail(Value::Object(detail))
        .with_meta_patch(json!({ "revision": revision, "last_run": last_run }))
}

// ── command cores ───────────────────────────────────────────────────────

fn db_error(error: fullmag_workspace::WorkspaceError) -> String {
    error.to_string()
}

fn sort_of(name: Option<&str>) -> Result<Sort, String> {
    match name {
        None => Ok(Sort::LastUsed),
        Some(name) => Sort::parse(name).ok_or_else(|| {
            format!("unknown sort {name:?}; expected last_used, name, modified or use_count")
        }),
    }
}

/// A script whose file vanished (or came back) is flagged before it is
/// listed. A cheap stat decides; the row is written only when it changed. When
/// the database refuses writes the answer is still corrected in memory.
fn refresh_script(workspace: &Workspace, item: &mut Item) -> bool {
    if !recent_index::file_state_changed(item) {
        return false;
    }
    match workspace.refresh_file_state(item.id) {
        Ok(fresh) => {
            *item = fresh;
            true
        }
        Err(_) => {
            let exists = Path::new(&item.path).exists();
            item.status = match (exists, item.status) {
                (false, _) => ItemStatus::Missing,
                (true, ItemStatus::Missing) => ItemStatus::Ready,
                (true, other) => other,
            };
            false
        }
    }
}

/// The start screen's list (spec section 5). Scripts are re-stat'ed first, so
/// a deleted file reads as missing and, when missing items are excluded, drops
/// out of the answer.
pub fn list_items(
    workspace: &Workspace,
    query: &WorkspaceListQuery,
) -> Result<Vec<WorkspaceItem>, String> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let db_query = Query {
        kind: match query.kind {
            KindFilter::All => None,
            KindFilter::Project => Some(ItemKind::Project),
            KindFilter::Script => Some(ItemKind::Script),
        },
        sort: sort_of(query.sort.as_deref())?,
        search: query.search.clone(),
        limit,
        include_missing: query.include_missing.unwrap_or(true),
    };
    let mut items = workspace.list(&db_query).map_err(db_error)?;
    let mut changed = false;
    for item in items
        .iter_mut()
        .filter(|item| item.kind == ItemKind::Script)
    {
        changed |= refresh_script(workspace, item);
    }
    if changed {
        items = workspace.list(&db_query).map_err(db_error)?;
    }
    Ok(items.iter().map(item_dto).collect())
}

pub fn pin_item(workspace: &Workspace, id: i64, pinned: bool) -> Result<(), String> {
    workspace
        .pin(id, pinned, Actor::Desktop)
        .map(|_| ())
        .map_err(db_error)
}

pub fn forget_item(workspace: &Workspace, id: i64) -> Result<(), String> {
    workspace
        .forget(id, Actor::Desktop)
        .map(|_| ())
        .map_err(db_error)
}

pub fn item_history(
    workspace: &Workspace,
    id: i64,
    limit: Option<usize>,
) -> Result<WorkspaceHistory, String> {
    if workspace.find(id).map_err(db_error)?.is_none() {
        return Err(format!("workspace item not found: item {id}"));
    }
    let limit = limit
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .clamp(1, MAX_HISTORY_LIMIT);
    let events = workspace.history(id, limit).map_err(db_error)?;
    Ok(WorkspaceHistory {
        events: events.iter().map(event_dto).collect(),
    })
}

fn event_dto(event: &Event) -> WorkspaceEvent {
    WorkspaceEvent {
        at: event.at.clone(),
        kind: event.kind.as_str(),
        actor: event.actor.as_str(),
        detail: event.detail.clone(),
    }
}

/// Record that the script at `path` was opened and return its item. Reads the
/// cheap derived facts (lines, docstring summary, whether it imports fullmag)
/// without executing or keeping the text.
pub fn record_script_open(workspace: &Workspace, path: &Path) -> Result<WorkspaceItem, String> {
    if !path.is_file() {
        return Err(format!("script file not found: {}", path.display()));
    }
    let mut meta = script_meta(path)
        .map_err(|error| format!("cannot read script {}: {error}", path.display()))?;
    // A merge patch only changes what it mentions: clear what this read lacks.
    for key in ["summary", "truncated"] {
        if meta.get(key).is_none() {
            meta[key] = Value::Null;
        }
    }
    let receipt = workspace
        .record(
            &RecordEvent::new(ItemKind::Script, path, EventKind::Open, Actor::Desktop)
                .with_meta_patch(meta),
        )
        .map_err(db_error)?;
    let item = workspace
        .find(receipt.item_id)
        .map_err(db_error)?
        .ok_or_else(|| format!("workspace item not found: item {}", receipt.item_id))?;
    Ok(item_dto(&item))
}

fn script_item(workspace: &Workspace, id: i64) -> Result<Item, String> {
    let item = workspace
        .find(id)
        .map_err(db_error)?
        .ok_or_else(|| format!("workspace item not found: item {id}"))?;
    if item.kind != ItemKind::Script {
        return Err(format!("item {id} is not a script"));
    }
    Ok(item)
}

/// Open a script of the list again: the stored path is re-read, never one the
/// renderer sent. A file that is gone is an error and flags the item missing.
pub fn open_script_by_id(workspace: &Workspace, id: i64) -> Result<WorkspaceItem, String> {
    let item = script_item(workspace, id)?;
    let path = PathBuf::from(&item.path);
    if !path.is_file() {
        let _ = workspace.refresh_file_state(id);
        return Err(format!(
            "the script file no longer exists: {}",
            display_path(&item.path)
        ));
    }
    record_script_open(workspace, &path)
}

/// The text of a stored script, for Copy script. At most 1 MiB, UTF-8 only.
pub fn read_script_text(workspace: &Workspace, id: i64) -> Result<ScriptText, String> {
    let item = script_item(workspace, id)?;
    let path = PathBuf::from(&item.path);
    let shown = display_path(&item.path);
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|file| file.take(MAX_SCRIPT_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("cannot read script {shown}: {error}"))?;
    if bytes.len() as u64 > MAX_SCRIPT_BYTES {
        return Err(format!("script {shown} is larger than 1 MiB"));
    }
    let sha256 = recent_index::sha256_hex(&bytes);
    let text =
        String::from_utf8(bytes).map_err(|_| format!("script {shown} is not valid UTF-8 text"))?;
    Ok(ScriptText {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("script.py")
            .to_string(),
        path: shown,
        sha256,
        text,
    })
}

/// The program and arguments that show `path` in the OS file manager. A file
/// that is gone opens its folder instead; with no folder either it is an error.
pub fn reveal_command_for(
    os: &str,
    path: &Path,
    file_exists: bool,
) -> Result<(&'static str, Vec<OsString>), String> {
    let folder = path.parent().filter(|parent| parent.is_dir());
    if !file_exists && folder.is_none() {
        return Err(format!(
            "neither {} nor its folder exists",
            display_path(&path.display().to_string())
        ));
    }
    let shown = display_path(&path.display().to_string());
    Ok(match (os, file_exists) {
        ("windows", true) => (
            "explorer",
            vec![OsString::from("/select,"), OsString::from(&shown)],
        ),
        ("macos", true) => ("open", vec![OsString::from("-R"), OsString::from(&shown)]),
        ("windows", false) => ("explorer", vec![OsString::from(folder.expect("checked"))]),
        ("macos", false) => ("open", vec![OsString::from(folder.expect("checked"))]),
        // xdg-open cannot select a file; it opens the folder.
        (_, _) => ("xdg-open", vec![OsString::from(folder.unwrap_or(path))]),
    })
}

/// Show the file of an item in the file manager. The path comes from the
/// database, after the id is checked to exist.
pub fn reveal_item(workspace: &Workspace, id: i64) -> Result<(), String> {
    let item = workspace
        .find(id)
        .map_err(db_error)?
        .ok_or_else(|| format!("workspace item not found: item {id}"))?;
    let path = PathBuf::from(&item.path);
    let (program, args) = reveal_command_for(std::env::consts::OS, &path, path.exists())?;
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("cannot open the file manager: {error}"))
}

// ── commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn workspace_list(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    query: WorkspaceListQuery,
) -> Result<WorkspaceListResult, String> {
    run(
        workspace.inner().clone(),
        legacy_index_path(&app),
        move |ws, outcome| {
            Ok(WorkspaceListResult {
                items: list_items(ws, &query)?,
                outcome: outcome.clone(),
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn workspace_pin(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    id: i64,
    pinned: bool,
) -> Result<(), String> {
    run(
        workspace.inner().clone(),
        legacy_index_path(&app),
        move |ws, _| pin_item(ws, id, pinned),
    )
    .await
}

#[tauri::command]
pub async fn workspace_forget(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    id: i64,
) -> Result<(), String> {
    run(
        workspace.inner().clone(),
        legacy_index_path(&app),
        move |ws, _| forget_item(ws, id),
    )
    .await
}

#[tauri::command]
pub async fn workspace_history(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    id: i64,
    limit: Option<usize>,
) -> Result<WorkspaceHistory, String> {
    run(
        workspace.inner().clone(),
        legacy_index_path(&app),
        move |ws, _| item_history(ws, id, limit),
    )
    .await
}

/// Pick a `.py` file in the native dialog, record the open and return its item.
/// `None` when the dialog is cancelled.
#[tauri::command]
pub async fn workspace_open_script_dialog(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
) -> Result<Option<WorkspaceItem>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Python script", &["py"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "selected script path is not available on this platform".to_string())?;
    run(
        workspace.inner().clone(),
        legacy_index_path(&app),
        move |ws, _| record_script_open(ws, &path).map(Some),
    )
    .await
}

#[tauri::command]
pub async fn workspace_open_script(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    id: i64,
) -> Result<WorkspaceItem, String> {
    run(
        workspace.inner().clone(),
        legacy_index_path(&app),
        move |ws, _| open_script_by_id(ws, id),
    )
    .await
}

#[tauri::command]
pub async fn workspace_reveal(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    id: i64,
) -> Result<(), String> {
    run(
        workspace.inner().clone(),
        legacy_index_path(&app),
        move |ws, _| reveal_item(ws, id),
    )
    .await
}

#[tauri::command]
pub async fn workspace_read_script_text(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    id: i64,
) -> Result<ScriptText, String> {
    run(
        workspace.inner().clone(),
        legacy_index_path(&app),
        move |ws, _| read_script_text(ws, id),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_700_000_000 + seconds)
    }

    fn open_workspace(dir: &Path) -> Workspace {
        Workspace::open(dir.join("workspace.db")).unwrap().0
    }

    fn script(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, text).unwrap();
        path
    }

    fn query(kind: KindFilter, sort: &str) -> WorkspaceListQuery {
        WorkspaceListQuery {
            kind,
            sort: Some(sort.into()),
            search: None,
            limit: None,
            include_missing: None,
        }
    }

    fn names(items: &[WorkspaceItem]) -> Vec<&str> {
        items.iter().map(|item| item.name.as_str()).collect()
    }

    fn open_at(workspace: &Workspace, path: &Path, seconds: u64) {
        workspace
            .record_at(
                &RecordEvent::new(ItemKind::Script, path, EventKind::Open, Actor::Desktop),
                at(seconds),
            )
            .unwrap();
    }

    #[test]
    fn scripts_list_in_every_sort_with_pins_first_and_search_and_kind_filters() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let wall = script(dir.path(), "wall.py", "import fullmag\n");
        let alpha = script(dir.path(), "alpha.py", "x = 1\n");
        let vortex = script(dir.path(), "vortex.py", "x = 2\n");
        open_at(&workspace, &wall, 0);
        open_at(&workspace, &alpha, 10);
        open_at(&workspace, &vortex, 20);
        open_at(&workspace, &wall, 30);
        workspace.pin(&alpha, true, Actor::Desktop).unwrap();
        // A project is not a script.
        workspace
            .record(&RecordEvent::new(
                ItemKind::Project,
                script(dir.path(), "p.fms", "archive"),
                EventKind::Open,
                Actor::Desktop,
            ))
            .unwrap();

        let scripts = |sort| list_items(&workspace, &query(KindFilter::Script, sort)).unwrap();
        // Pinned first; the rest by last use (wall was reopened last).
        assert_eq!(names(&scripts("last_used")), ["alpha", "wall", "vortex"]);
        assert_eq!(names(&scripts("name")), ["alpha", "vortex", "wall"]);
        assert_eq!(names(&scripts("use_count")), ["alpha", "wall", "vortex"]);
        assert_eq!(scripts("use_count")[1].use_count, 2);
        assert_eq!(scripts("last_used")[0].kind, "script");
        assert!(scripts("name").iter().all(|item| item.kind == "script"));

        let all = list_items(&workspace, &query(KindFilter::All, "name")).unwrap();
        assert_eq!(all.len(), 4);
        let projects = list_items(&workspace, &query(KindFilter::Project, "name")).unwrap();
        assert_eq!(names(&projects), ["p"]);

        let mut search = query(KindFilter::Script, "name");
        search.search = Some("VORT".into());
        assert_eq!(names(&list_items(&workspace, &search).unwrap()), ["vortex"]);
        let mut limited = query(KindFilter::All, "name");
        limited.limit = Some(2);
        assert_eq!(list_items(&workspace, &limited).unwrap().len(), 2);

        assert!(list_items(&workspace, &query(KindFilter::All, "newest")).is_err());
    }

    #[test]
    fn item_json_has_the_documented_shape() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let path = script(dir.path(), "wall.py", "\"\"\"Wall.\"\"\"\nimport fullmag\n");
        record_script_open(&workspace, &path).unwrap();
        let items = list_items(&workspace, &query(KindFilter::All, "last_used")).unwrap();
        let value = serde_json::to_value(&items[0]).unwrap();
        for key in [
            "id",
            "kind",
            "path",
            "name",
            "first_seen_at",
            "last_used_at",
            "use_count",
            "pinned",
            "status",
            "size_bytes",
            "modified_at",
            "meta",
        ] {
            assert!(value.get(key).is_some(), "missing {key}");
        }
        assert!(value.get("project_id").is_none(), "absent for scripts");
        assert!(!value["path"].as_str().unwrap().starts_with(r"\\?\"));
        assert_eq!(value["kind"], "script");
        assert_eq!(value["status"], "ready");
        assert_eq!(value["meta"]["summary"], "Wall.");
        assert_eq!(value["meta"]["uses_fullmag"], true);
    }

    #[test]
    fn opening_a_script_records_an_open_event_and_reads_its_facts() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let path = script(
            dir.path(),
            "wall.py",
            "\"\"\"Domain wall in a strip.\"\"\"\nimport fullmag as fm\nprint(1)\n",
        );
        let first = record_script_open(&workspace, &path).unwrap();
        assert_eq!(first.use_count, 1);
        assert_eq!(first.name, "wall");
        assert_eq!(first.meta["lines"], 3);
        assert_eq!(first.meta["summary"], "Domain wall in a strip.");
        assert_eq!(first.meta["uses_fullmag"], true);
        assert!(first.meta.get("truncated").is_none());

        // The docstring goes away: the stale summary does not linger.
        fs::write(&path, "x = 1\n").unwrap();
        let second = open_script_by_id(&workspace, first.id).unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.use_count, 2);
        assert!(second.meta.get("summary").is_none());
        assert_eq!(second.meta["uses_fullmag"], false);

        let history = item_history(&workspace, first.id, None).unwrap();
        assert_eq!(history.events.len(), 2);
        assert_eq!(history.events[0].kind, "open");
        assert_eq!(history.events[0].actor, "desktop");
        assert!(item_history(&workspace, 424_242, None).is_err());
        assert_eq!(
            item_history(&workspace, first.id, Some(1))
                .unwrap()
                .events
                .len(),
            1
        );
    }

    #[test]
    fn opening_a_script_that_is_gone_fails_clearly_and_marks_it_missing() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let path = script(dir.path(), "gone.py", "x = 1\n");
        let item = record_script_open(&workspace, &path).unwrap();
        fs::remove_file(&path).unwrap();

        let error = open_script_by_id(&workspace, item.id).unwrap_err();
        assert!(error.contains("no longer exists"), "{error}");
        assert!(error.contains("gone.py"), "{error}");
        assert_eq!(
            workspace.find(item.id).unwrap().unwrap().status,
            ItemStatus::Missing
        );
        assert_eq!(
            workspace.find(item.id).unwrap().unwrap().use_count,
            1,
            "a failed open is not a use"
        );
        assert!(open_script_by_id(&workspace, 424_242).is_err());
        assert!(record_script_open(&workspace, &path).is_err());
    }

    #[test]
    fn a_project_item_is_not_a_script() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let project = script(dir.path(), "p.fms", "archive");
        let id = workspace
            .record(&RecordEvent::new(
                ItemKind::Project,
                &project,
                EventKind::Open,
                Actor::Desktop,
            ))
            .unwrap()
            .item_id;
        assert!(open_script_by_id(&workspace, id)
            .unwrap_err()
            .contains("not a script"));
        assert!(read_script_text(&workspace, id).is_err());
    }

    #[test]
    fn deleted_scripts_read_as_missing_and_can_be_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let keep = script(dir.path(), "keep.py", "x = 1\n");
        let gone = script(dir.path(), "gone.py", "x = 2\n");
        record_script_open(&workspace, &keep).unwrap();
        record_script_open(&workspace, &gone).unwrap();
        fs::remove_file(&gone).unwrap();

        let mut with_missing = query(KindFilter::Script, "name");
        let listed = list_items(&workspace, &with_missing).unwrap();
        assert_eq!(names(&listed), ["gone", "keep"]);
        assert_eq!(listed[0].status, "missing");
        assert_eq!(listed[1].status, "ready");

        with_missing.include_missing = Some(false);
        assert_eq!(
            names(&list_items(&workspace, &with_missing).unwrap()),
            ["keep"]
        );

        // The file comes back: it reads as ready again.
        fs::write(&gone, "x = 2\n").unwrap();
        let listed = list_items(&workspace, &query(KindFilter::Script, "name")).unwrap();
        assert!(listed.iter().all(|item| item.status == "ready"));
    }

    #[test]
    fn pin_and_forget_by_id_and_unknown_ids_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let path = script(dir.path(), "a.py", "x = 1\n");
        let id = record_script_open(&workspace, &path).unwrap().id;

        pin_item(&workspace, id, true).unwrap();
        let listed = list_items(&workspace, &query(KindFilter::All, "name")).unwrap();
        assert!(listed[0].pinned);
        pin_item(&workspace, id, false).unwrap();
        forget_item(&workspace, id).unwrap();
        assert!(list_items(&workspace, &query(KindFilter::All, "name"))
            .unwrap()
            .is_empty());
        assert!(pin_item(&workspace, 424_242, true).is_err());
        assert!(forget_item(&workspace, 424_242).is_err());

        let kinds: Vec<&str> = item_history(&workspace, id, None)
            .unwrap()
            .events
            .iter()
            .map(|event| event.kind)
            .collect();
        assert_eq!(kinds, ["forget", "unpin", "pin", "open"]);
    }

    #[test]
    fn script_text_is_returned_with_its_digest_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let path = script(dir.path(), "wall.py", "print('caf\u{e9}')\n");
        let id = record_script_open(&workspace, &path).unwrap().id;
        let text = read_script_text(&workspace, id).unwrap();
        assert_eq!(text.name, "wall.py");
        assert_eq!(text.text, "print('caf\u{e9}')\n");
        assert_eq!(text.sha256, recent_index::sha256_hex(text.text.as_bytes()));
        assert_eq!(text.sha256.len(), 64);

        fs::write(&path, vec![b'a'; MAX_SCRIPT_BYTES as usize]).unwrap();
        assert!(
            read_script_text(&workspace, id).is_ok(),
            "exactly 1 MiB fits"
        );
        fs::write(&path, vec![b'a'; MAX_SCRIPT_BYTES as usize + 1]).unwrap();
        assert!(read_script_text(&workspace, id)
            .unwrap_err()
            .contains("larger than 1 MiB"));
        fs::write(&path, [0xff, 0xfe, b'x']).unwrap();
        assert!(read_script_text(&workspace, id)
            .unwrap_err()
            .contains("UTF-8"));
        fs::remove_file(&path).unwrap();
        assert!(read_script_text(&workspace, id).is_err());
    }

    #[test]
    fn project_activity_is_mirrored_as_open_save_and_run_events() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let path = script(dir.path(), "yig.fms", "archive");

        workspace
            .record(&project_open_event(
                &path,
                "pid-yig",
                Some("YIG strip"),
                3,
                false,
            ))
            .unwrap();
        workspace
            .record(&project_save_event(&path, "pid-yig", 4, false))
            .unwrap();
        let run = json!({
            "run_id": "run-1",
            "status": "ready",
            "started_at": "2026-10-04T10:00:00Z",
            "finished_at": "2026-10-04T10:05:00Z"
        });
        workspace
            .record(&project_run_event(
                &path,
                "pid-yig",
                &run,
                5,
                "2026-10-04T10:06:00Z",
            ))
            .unwrap();

        let item = workspace.find(&path).unwrap().unwrap();
        assert_eq!(item.kind, ItemKind::Project);
        assert_eq!(item.project_id.as_deref(), Some("pid-yig"));
        assert_eq!(item.name, "YIG strip");
        assert_eq!(item.use_count, 3);
        assert_eq!(item.meta["revision"], 5);
        assert_eq!(item.meta["last_run"]["run_id"], "run-1");
        assert_eq!(item.meta["last_run"]["status"], "ready");
        assert_eq!(item.meta["last_run"]["at"], "2026-10-04T10:05:00Z");

        let history = item_history(&workspace, item.id, None).unwrap().events;
        let kinds: Vec<&str> = history.iter().map(|event| event.kind).collect();
        assert_eq!(kinds, ["run", "save", "open"]);
        assert_eq!(history[0].detail["status"], "ready");
        assert_eq!(history[0].detail["revision"], 5);
        assert_eq!(history[1].detail["revision"], 4);
        assert_eq!(history[2].detail["mode"], "read_write");

        // A save keeps the name the open recorded.
        assert_eq!(workspace.find(&path).unwrap().unwrap().name, "YIG strip");
    }

    #[test]
    fn a_run_without_a_finish_time_falls_back_to_start_then_now() {
        let path = Path::new("/p.fms");
        let started = json!({"run_id": "r", "status": "failed", "started_at": "S"});
        let event = project_run_event(path, "p", &started, 1, "NOW");
        assert_eq!(event.meta_patch.unwrap()["last_run"]["at"], "S");
        let bare = json!({"status": "failed"});
        let event = project_run_event(path, "p", &bare, 1, "NOW");
        let patch = event.meta_patch.unwrap();
        assert_eq!(patch["last_run"]["at"], "NOW");
        assert!(patch["last_run"].get("run_id").is_none());
    }

    #[test]
    fn the_first_use_imports_the_legacy_index_once_and_moves_thumbnails_out_of_meta() {
        let dir = tempfile::tempdir().unwrap();
        let present = script(dir.path(), "present.fms", "archive");
        let mut png = fullmag_workspace::PNG_SIGNATURE.to_vec();
        png.extend_from_slice(b"legacy preview");
        let legacy = dir.path().join("recent-index.json");
        let index = json!({
            "format_version": 1,
            "generated_at": "2026-10-03T12:04:11Z",
            "entries": [{
                "project_id": "pid-legacy",
                "name": "Legacy",
                "path": present.display().to_string(),
                "solver": "FEM",
                "status": "ready",
                "last_opened_at": "2026-10-03T12:04:02Z",
                "pinned": true,
                "tags": ["old"],
                "thumbnail": format!("{PNG_DATA_URI_PREFIX}{}", STANDARD.encode(&png))
            }]
        });
        fs::write(&legacy, serde_json::to_string(&index).unwrap()).unwrap();
        let database = dir.path().join("state").join("workspace.db");

        let host = WorkspaceHost::at(database.clone());
        let listed = host
            .with(Some(&legacy), |ws, outcome| {
                assert_eq!(outcome.state, "created");
                list_items(ws, &query(KindFilter::Project, "last_used"))
            })
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].pinned);
        assert_eq!(listed[0].meta["tags"], json!(["old"]));
        assert!(
            listed[0].meta.get("thumbnail_ref").is_none(),
            "no data URI stays in meta"
        );

        // The renderer-facing index still carries the preview, from its table.
        let index = host
            .with(None, |ws, _| recent_index::read_index(ws))
            .unwrap();
        let entry = &index["entries"][0];
        assert_eq!(entry["project_id"], "pid-legacy");
        assert_eq!(entry["solver"], "FEM");
        assert_eq!(entry["pinned"], true);
        assert_eq!(
            entry["thumbnail"],
            format!("{PNG_DATA_URI_PREFIX}{}", STANDARD.encode(&png))
        );

        // A second process start does not import again.
        drop(host);
        let host = WorkspaceHost::at(database);
        let history_len = host
            .with(Some(&legacy), |ws, outcome| {
                assert_eq!(outcome.state, "ready");
                let id = list_items(ws, &query(KindFilter::Project, "last_used"))?[0].id;
                Ok(item_history(ws, id, None)?.events.len())
            })
            .unwrap();
        assert_eq!(history_len, 1);
    }

    #[test]
    fn a_missing_or_broken_legacy_index_never_stops_the_database_from_opening() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("workspace.db");
        let none = dir.path().join("absent.json");
        assert!(Session::open(&database, Some(&none)).is_ok());
        let broken = script(dir.path(), "recent-index.json", "{ not json");
        let session = Session::open(&database, Some(&broken)).unwrap();
        assert_eq!(session.outcome.state, "ready");
    }

    #[test]
    fn the_open_outcome_maps_to_the_renderer_states() {
        assert_eq!(outcome_dto(&OpenOutcome::Ready).state, "ready");
        assert_eq!(outcome_dto(&OpenOutcome::Created).state, "created");
        let migrated = outcome_dto(&OpenOutcome::Migrated { from: 1, to: 2 });
        assert_eq!(migrated.state, "migrated");
        assert!(migrated.detail.unwrap().contains("1"));
        let read_only = outcome_dto(&OpenOutcome::ReadOnlyNewerSchema {
            found: 9,
            supported: 2,
        });
        assert_eq!(read_only.state, "read_only_newer_schema");
        assert!(read_only.detail.unwrap().contains('9'));
        let quarantined = outcome_dto(&OpenOutcome::Quarantined {
            backup: PathBuf::from("workspace.db.corrupt-1"),
            reason: "not a database".into(),
        });
        assert_eq!(quarantined.state, "quarantined");
        let detail = quarantined.detail.unwrap();
        assert!(detail.contains("workspace.db.corrupt-1") && detail.contains("not a database"));
        let json = serde_json::to_value(outcome_dto(&OpenOutcome::Ready)).unwrap();
        assert_eq!(json, json!({"state": "ready"}));
    }

    #[test]
    fn a_damaged_database_is_quarantined_and_reported() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("workspace.db");
        fs::write(&database, b"this is not a sqlite database".repeat(40)).unwrap();
        let session = Session::open(&database, None).unwrap();
        assert_eq!(session.outcome.state, "quarantined");
        assert!(session
            .outcome
            .detail
            .as_deref()
            .unwrap()
            .contains("corrupt"));
        // The application keeps working on the fresh database.
        let path = script(dir.path(), "a.py", "x = 1\n");
        assert!(record_script_open(&session.workspace, &path).is_ok());
    }

    #[test]
    fn a_newer_schema_reads_but_refuses_every_write_with_a_clear_message() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("workspace.db");
        let path = script(dir.path(), "a.py", "x = 1\n");
        let id = {
            let workspace = open_workspace(dir.path());
            record_script_open(&workspace, &path).unwrap().id
        };
        set_schema_version(&database, 99);

        let session = Session::open(&database, None).unwrap();
        assert_eq!(session.outcome.state, "read_only_newer_schema");
        let workspace = &session.workspace;
        let listed = list_items(workspace, &query(KindFilter::All, "name")).unwrap();
        assert_eq!(listed.len(), 1);
        for result in [
            pin_item(workspace, id, true),
            forget_item(workspace, id),
            open_script_by_id(workspace, id).map(|_| ()),
        ] {
            assert!(result.unwrap_err().contains("read-only"));
        }
        // A deleted script is still reported missing, from the disk.
        fs::remove_file(&path).unwrap();
        let listed = list_items(workspace, &query(KindFilter::All, "name")).unwrap();
        assert_eq!(listed[0].status, "missing");
    }

    fn set_schema_version(database: &Path, version: i64) {
        rusqlite::Connection::open(database)
            .unwrap()
            .pragma_update(None, "user_version", version)
            .unwrap();
    }

    #[test]
    fn reveal_picks_the_platform_command_and_falls_back_to_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let file = script(dir.path(), "a.py", "x = 1\n");
        let (program, args) = reveal_command_for("windows", &file, true).unwrap();
        assert_eq!(program, "explorer");
        assert_eq!(args[0], OsString::from("/select,"));
        assert!(args[1].to_string_lossy().ends_with("a.py"));
        let (program, args) = reveal_command_for("macos", &file, true).unwrap();
        assert_eq!(
            (program, args[0].to_string_lossy().into_owned()),
            ("open", "-R".into())
        );
        let (program, args) = reveal_command_for("linux", &file, true).unwrap();
        assert_eq!(program, "xdg-open");
        assert_eq!(PathBuf::from(&args[0]), dir.path());

        // A deleted file opens its folder; without the folder it is an error.
        let gone = dir.path().join("gone.py");
        let (_, args) = reveal_command_for("windows", &gone, false).unwrap();
        assert_eq!(PathBuf::from(&args[0]), dir.path());
        let nowhere = dir.path().join("no-folder").join("x.py");
        assert!(reveal_command_for("linux", &nowhere, false).is_err());
    }

    #[test]
    fn revealing_needs_an_existing_item_id() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        assert!(reveal_item(&workspace, 424_242)
            .unwrap_err()
            .contains("not found"));
    }

    #[test]
    fn verbatim_windows_prefixes_are_not_shown() {
        assert_eq!(display_path(r"\\?\C:\sim\wall.py"), r"C:\sim\wall.py");
        assert_eq!(display_path(r"\\?\UNC\srv\share\a.py"), r"\\srv\share\a.py");
        assert_eq!(display_path("/home/a/wall.py"), "/home/a/wall.py");
    }

    #[test]
    fn the_query_deserialises_with_defaults() {
        let query: WorkspaceListQuery =
            serde_json::from_value(json!({"kind": "script", "sort": "name"})).unwrap();
        assert_eq!(query.kind, KindFilter::Script);
        assert!(query.limit.is_none() && query.include_missing.is_none());
        let query: WorkspaceListQuery = serde_json::from_value(json!({})).unwrap();
        assert_eq!(query.kind, KindFilter::All);
        assert!(serde_json::from_value::<WorkspaceListQuery>(json!({"kind": "folder"})).is_err());
    }

    #[test]
    fn sha256_of_nothing_is_the_known_digest() {
        assert_eq!(
            format!("{:x}", Sha256::digest(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
