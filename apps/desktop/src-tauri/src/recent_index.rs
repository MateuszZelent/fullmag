//! Host-side recent-project list behind the start screen.
//!
//! The list is a view of the per-user workspace database (`fullmag-workspace`,
//! spec `docs/design/start-screen/docs/07-workspace-database.md`): projects are
//! the items of kind `project`, the rich fields the inspector shows live in
//! their `meta` and their previews in the `thumbnails` table. The JSON the
//! renderer reads is unchanged (`docs/design/start-screen/schema/
//! recent-index.schema.json`); `recent-index.json` is only read, once, by the
//! legacy import and is no longer written.
//!
//! The list is derived state: every field can be rebuilt by rescanning the
//! project locations, so a rebuild repairs whatever a damaged database lost.

use crate::provenance;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use fullmag_application::FileProjectRepository;
use fullmag_application::{ProjectRepository, ProjectSource};
use fullmag_workspace::{
    rfc3339_millis, Actor, Item, ItemKind, ItemStatus, Query, SeenItem, Sort, Workspace,
    WorkspaceError,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FORMAT_VERSION: u64 = 1;
const MAX_SCAN_DEPTH: usize = 6;
const MAX_ENTRIES: usize = 2000;
const MAX_PROJECT_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
/// File name of the legacy JSON index, read once by the database import.
pub const INDEX_FILE_NAME: &str = "recent-index.json";
/// `kv` key holding the roots of the last rebuild (the schema's `scanned_locations`).
pub const SCANNED_LOCATIONS_KEY: &str = "recent_scanned_locations";

/// Where a project stores the preview of its last result (design §6.2).
pub const THUMBNAIL_PATH: &str = "project/preview/thumb.png";
/// Previews are inlined as data URIs, so the cap is the design's target size,
/// not its hard limit: a larger preview is left out, never truncated.
pub const MAX_INLINE_THUMBNAIL_BYTES: usize = fullmag_workspace::MAX_THUMBNAIL_BYTES;
pub const PNG_SIGNATURE: [u8; 8] = fullmag_workspace::PNG_SIGNATURE;

fn db_error(error: WorkspaceError) -> String {
    error.to_string()
}

/// The index document the renderer reads, from the projects in the database.
/// A copy of a project (same id at two paths) is listed once, as the most
/// recently modified one.
pub fn read_index(workspace: &Workspace) -> Result<Value, String> {
    let items = project_items(workspace)?;
    let mut entries = Vec::with_capacity(items.len());
    for item in dedupe_by_project_id(items) {
        let thumbnail = workspace
            .get_thumbnail(item.id)
            .map_err(db_error)?
            .and_then(|stored| thumbnail_data_uri(&stored.png));
        entries.push(entry_from_item(&item, thumbnail));
    }
    let mut index = Map::new();
    index.insert("format_version".into(), json!(FORMAT_VERSION));
    index.insert(
        "generated_at".into(),
        Value::String(rfc3339_utc(SystemTime::now())),
    );
    if let Some(locations) = workspace
        .get_kv(SCANNED_LOCATIONS_KEY)
        .map_err(db_error)?
        .filter(Value::is_array)
    {
        index.insert("scanned_locations".into(), locations);
    }
    index.insert("entries".into(), Value::Array(entries));
    Ok(Value::Object(index))
}

/// The roots the last rebuild scanned, for the next one.
pub fn stored_roots(workspace: &Workspace) -> Vec<PathBuf> {
    workspace
        .get_kv(SCANNED_LOCATIONS_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.as_array().cloned())
        .into_iter()
        .flatten()
        .filter_map(|location| {
            location
                .get("path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .collect()
}

fn project_items(workspace: &Workspace) -> Result<Vec<Item>, String> {
    workspace
        .list(&Query {
            kind: Some(ItemKind::Project),
            sort: Sort::LastUsed,
            search: None,
            limit: MAX_ENTRIES,
            include_missing: true,
        })
        .map_err(db_error)
}

/// The id the renderer keys an entry by: the project id, or a stable synthetic
/// one for a file that never opened.
pub fn entry_project_id(item: &Item) -> String {
    item.project_id
        .clone()
        .unwrap_or_else(|| format!("path:{}", item.path))
}

fn dedupe_by_project_id(items: Vec<Item>) -> Vec<Item> {
    let mut best: HashMap<String, usize> = HashMap::new();
    for (position, item) in items.iter().enumerate() {
        let Some(id) = item.project_id.as_deref() else {
            continue;
        };
        match best.get(id) {
            Some(&current) if items[current].modified_at >= item.modified_at => {}
            _ => {
                best.insert(id.to_string(), position);
            }
        }
    }
    items
        .into_iter()
        .enumerate()
        .filter(|(position, item)| {
            item.project_id
                .as_deref()
                .map_or(true, |id| best.get(id) == Some(position))
        })
        .map(|(_, item)| item)
        .collect()
}

/// One renderer entry (the schema's `entry`) from a database row; the preview
/// arrives as a data URI read from the `thumbnails` table.
pub fn entry_from_item(item: &Item, thumbnail: Option<String>) -> Value {
    let meta = item.meta.as_object();
    let text = |key: &str| meta.and_then(|m| m.get(key)).and_then(Value::as_str);
    let value = |key: &str| meta.and_then(|m| m.get(key)).filter(|v| !v.is_null());

    let mut entry = Map::new();
    entry.insert("project_id".into(), Value::String(entry_project_id(item)));
    entry.insert("name".into(), Value::String(item.name.clone()));
    entry.insert("path".into(), Value::String(item.path.clone()));
    let solver = match text("solver").map(str::to_ascii_lowercase).as_deref() {
        Some("fem") => "FEM",
        _ => "FDM",
    };
    entry.insert("solver".into(), Value::String(solver.into()));
    entry.insert("status".into(), Value::String(item.status.as_str().into()));
    entry.insert(
        "last_opened_at".into(),
        Value::String(item.last_used_at.clone()),
    );
    if let Some(created) = text("created_at") {
        entry.insert("created_at".into(), Value::String(created.into()));
    }
    if let Some(modified) = &item.modified_at {
        entry.insert("modified_at".into(), Value::String(modified.clone()));
    }
    if let Some(size) = item.size_bytes.filter(|size| *size >= 0) {
        entry.insert("size_bytes".into(), json!(size));
    }
    for (from, to) in [
        ("revision", "revision"),
        ("schema_version", "manifest_schema_version"),
        ("created_with_version", "created_with_version"),
        ("mode", "mode"),
        ("mode_reason", "mode_reason"),
        ("tags", "tags"),
        ("last_error", "last_error"),
        ("summary", "summary"),
        ("authors", "authors"),
    ] {
        if let Some(found) = value(from) {
            entry.insert(to.into(), found.clone());
        }
    }
    entry.insert("pinned".into(), Value::Bool(item.pinned));
    if let Some(uri) = thumbnail {
        entry.insert("thumbnail".into(), Value::String(uri));
    }
    Value::Object(entry)
}

/// Pin or unpin every row of a project and return the refreshed index. A
/// project the database does not list is an error, as before.
pub fn set_pinned(workspace: &Workspace, project_id: &str, pinned: bool) -> Result<Value, String> {
    let items = items_of_entry(workspace, project_id)?;
    if items.is_empty() {
        return Err(format!("project {project_id} is not in the index"));
    }
    for item in items {
        workspace
            .pin(item.id, pinned, Actor::Desktop)
            .map_err(db_error)?;
    }
    read_index(workspace)
}

/// Remove a project from the list. The row, its history and the file on disk
/// stay; using the project again brings it back.
pub fn forget(workspace: &Workspace, project_id: &str) -> Result<Value, String> {
    for item in items_of_entry(workspace, project_id)? {
        workspace
            .forget(item.id, Actor::Desktop)
            .map_err(db_error)?;
    }
    read_index(workspace)
}

fn items_of_entry(workspace: &Workspace, project_id: &str) -> Result<Vec<Item>, String> {
    Ok(project_items(workspace)?
        .into_iter()
        .filter(|item| entry_project_id(item) == project_id)
        .collect())
}

/// Whether the file behind an item no longer matches what the row says
/// (gone, back, resized or touched): a cheap stat, so callers can skip the
/// write when nothing changed.
pub fn file_state_changed(item: &Item) -> bool {
    match fs::metadata(&item.path) {
        Err(_) => item.status != ItemStatus::Missing,
        Ok(meta) => {
            item.status == ItemStatus::Missing
                || item.size_bytes != Some(meta.len() as i64)
                || item.modified_at != meta.modified().ok().map(rfc3339_millis)
        }
    }
}

/// Rescan `roots` and merge the result into the database.
///
/// What a scan cannot know is untouched: pins, use counts and the last-used
/// time. A project that was forgotten stays forgotten. Rows whose file was not
/// found this time are re-checked on disk, so a vanished file turns `missing`
/// instead of being dropped, and an offline share does not silently erase the
/// user's list.
pub fn rebuild_index(
    workspace: &Workspace,
    roots: &[PathBuf],
    now: SystemTime,
) -> Result<Value, String> {
    let mut found_paths = Vec::new();
    let mut locations = Vec::new();
    for root in roots {
        let reachable = root.is_dir();
        locations.push(json!({
            "path": root.display().to_string(),
            "recursive": true,
            "last_scanned_at": rfc3339_utc(now),
            "reachable": reachable,
        }));
        if reachable {
            collect_archives(root, 0, &mut found_paths);
        }
    }
    found_paths.sort();
    found_paths.dedup();

    let mut seen_ids: HashSet<i64> = HashSet::new();
    for path in found_paths.iter().take(MAX_ENTRIES) {
        let id = store_scanned(workspace, &scan_archive(path)).map_err(db_error)?;
        seen_ids.insert(id);
    }
    for item in project_items(workspace)? {
        if !seen_ids.contains(&item.id) && file_state_changed(&item) {
            workspace.refresh_file_state(item.id).map_err(db_error)?;
        }
    }
    workspace
        .set_kv(SCANNED_LOCATIONS_KEY, &Value::Array(locations))
        .map_err(db_error)?;
    read_index(workspace)
}

/// Re-read one archive into the database, so a fresh thumbnail or summary
/// appears without a rescan.
pub fn refresh_project(workspace: &Workspace, path: &Path) -> Result<(), String> {
    store_scanned(workspace, &scan_archive(path))
        .map(|_| ())
        .map_err(db_error)
}

/// Write one scan result: the item with its `meta`, and its preview.
pub fn store_scanned(
    workspace: &Workspace,
    scanned: &ScannedProject,
) -> Result<i64, WorkspaceError> {
    let mut seen = SeenItem::new(ItemKind::Project, &scanned.path);
    seen.name = Some(scanned.name.clone());
    seen.project_id = scanned.project_id.clone();
    seen.status = scanned.status;
    seen.meta_patch = Some(scanned.meta.clone());
    let id = workspace.observe(&seen)?.item_id;
    match &scanned.thumbnail {
        Some(png) => workspace.set_thumbnail(id, &sha256_hex(png), png)?,
        None => {
            if workspace.get_thumbnail(id)?.is_some() {
                workspace.remove_thumbnail(id)?;
            }
        }
    }
    Ok(id)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn collect_archives(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_SCAN_DEPTH || out.len() >= MAX_ENTRIES {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for item in read.flatten() {
        let path = item.path();
        // symlink_metadata: do not follow links out of the project roots.
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            collect_archives(&path, depth + 1, out);
        } else if meta.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("fms"))
        {
            out.push(path);
        }
    }
}

/// What reading one archive on disk yields, ready for the database. An archive
/// that cannot be read is still a result, as `failed` with the reason, so a
/// corrupt project is visible rather than silently absent.
pub struct ScannedProject {
    pub path: PathBuf,
    pub name: String,
    /// `None` for an archive that could not be read.
    pub project_id: Option<String>,
    pub status: ItemStatus,
    /// Merge patch for the item's `meta`; `null` clears a key.
    pub meta: Value,
    /// The stored preview, when it is a PNG within the inline cap.
    pub thumbnail: Option<Vec<u8>>,
}

pub fn scan_archive(path: &Path) -> ScannedProject {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("project")
        .to_string();
    let file = fs::metadata(path).ok();
    let size = file.as_ref().map(|m| m.len());
    let created = file.as_ref().and_then(|m| m.created().ok());

    let mut meta = Map::new();
    if let Some(created) = created {
        meta.insert("created_at".into(), Value::String(rfc3339_utc(created)));
    }

    let loaded = if size.is_some_and(|s| s > MAX_PROJECT_ARCHIVE_BYTES) {
        Err(format!(
            "archive exceeds {MAX_PROJECT_ARCHIVE_BYTES} byte limit"
        ))
    } else {
        FileProjectRepository::new()
            .open(ProjectSource::Path(path.to_path_buf()))
            .map_err(|error| error.to_string())
    };

    match loaded {
        Ok(opened) => {
            let definition = &opened.envelope.definition;
            meta.insert("revision".into(), json!(definition.revision));
            meta.insert(
                "schema_version".into(),
                Value::String(short_schema_version(&opened.migration.source_schema)),
            );
            meta.insert(
                "solver".into(),
                Value::String(solver_from_scene(definition.scene.value()).to_lowercase()),
            );
            let authors = opened
                .envelope
                .opaque_documents
                .iter()
                .find(|document| document.path() == provenance::PROVENANCE_PATH)
                .and_then(|document| provenance::parse_provenance(document.bytes()).ok())
                .and_then(|value| value.get("authors").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            meta.insert(
                "authors".into(),
                if authors.is_empty() {
                    Value::Null
                } else {
                    Value::Array(authors)
                },
            );
            meta.insert(
                "summary".into(),
                summary_from_scene(definition.scene.value()).unwrap_or(Value::Null),
            );
            meta.insert("last_error".into(), Value::Null);
            let thumbnail = opened
                .envelope
                .opaque_documents
                .iter()
                .find(|document| document.path() == THUMBNAIL_PATH)
                .map(|document| document.bytes().to_vec())
                .filter(|bytes| is_inlinable_png(bytes));
            let status = if opened.read_only_reason.is_some() {
                ItemStatus::Readonly
            } else if opened.migration.source_schema != opened.migration.target_schema {
                ItemStatus::Migrate
            } else {
                ItemStatus::Ready
            };
            if let Some(reason) = opened.read_only_reason {
                meta.insert("mode".into(), Value::String("read_only".into()));
                meta.insert("mode_reason".into(), Value::String(reason));
            } else {
                meta.insert("mode".into(), Value::String("read_write".into()));
                meta.insert("mode_reason".into(), Value::Null);
            }
            ScannedProject {
                path: path.to_path_buf(),
                name: definition.name.clone(),
                project_id: Some(definition.project_id.as_str().to_string()),
                status,
                meta: Value::Object(meta),
                thumbnail,
            }
        }
        Err(reason) => {
            for stale in [
                "revision",
                "schema_version",
                "authors",
                "summary",
                "mode",
                "mode_reason",
            ] {
                meta.insert(stale.into(), Value::Null);
            }
            meta.insert("solver".into(), Value::String("fdm".into()));
            meta.insert("last_error".into(), Value::String(reason));
            ScannedProject {
                path: path.to_path_buf(),
                name: stem,
                project_id: None,
                status: ItemStatus::Failed,
                meta: Value::Object(meta),
                thumbnail: None,
            }
        }
    }
}

fn is_inlinable_png(bytes: &[u8]) -> bool {
    bytes.len() <= MAX_INLINE_THUMBNAIL_BYTES && bytes.starts_with(&PNG_SIGNATURE)
}

/// A preview as a data URI, or `None` when it is not a PNG or is too large to
/// inline. Checking the signature keeps arbitrary bytes out of an `<img>`.
pub fn thumbnail_data_uri(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_INLINE_THUMBNAIL_BYTES || !bytes.starts_with(&PNG_SIGNATURE) {
        return None;
    }
    Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

/// `"1.2.0"` and `"project/1.2"` both read as `1.2`, the schema's pattern.
fn short_schema_version(version: &str) -> String {
    let digits: String = version
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .collect();
    let mut parts = digits.split('.').take(2);
    match (parts.next(), parts.next()) {
        (Some(major), Some(minor)) if !major.is_empty() && !minor.is_empty() => {
            format!("{major}.{minor}")
        }
        _ => version.to_string(),
    }
}

/// The requested discretisation lives in the scene's `study`, not in the
/// project definition. `study.backend` (the resolved choice) wins over
/// `study.requested_backend`; `auto` says nothing, so it falls through to the
/// first `backend`-like string elsewhere and finally to FDM, which is what a
/// new empty problem is.
pub fn solver_from_scene(scene: &Value) -> &'static str {
    fn classify(text: &str) -> Option<&'static str> {
        let lower = text.to_ascii_lowercase();
        if lower.starts_with("fem") {
            Some("FEM")
        } else if lower.starts_with("fdm") {
            Some("FDM")
        } else {
            None
        }
    }
    fn walk(value: &Value, depth: usize) -> Option<&'static str> {
        if depth > 6 {
            return None;
        }
        match value {
            Value::Object(map) => {
                for key in ["requested_backend", "backend", "discretization", "solver"] {
                    if let Some(found) = map.get(key).and_then(Value::as_str).and_then(classify) {
                        return Some(found);
                    }
                }
                map.values().find_map(|child| walk(child, depth + 1))
            }
            Value::Array(items) => items.iter().find_map(|child| walk(child, depth + 1)),
            _ => None,
        }
    }
    if let Some(study) = scene.get("study") {
        for key in ["backend", "requested_backend"] {
            if let Some(found) = study.get(key).and_then(Value::as_str).and_then(classify) {
                return found;
            }
        }
    }
    walk(scene, 0).unwrap_or("FDM")
}

/// `value` with an SI prefix and three significant digits: `1.4e5` A/m reads
/// `140 kA/m`. Zero and non-finite values have no sensible prefix.
pub fn si_value(value: f64, unit: &str) -> String {
    const PREFIXES: [(f64, &str); 9] = [
        (1e9, "G"),
        (1e6, "M"),
        (1e3, "k"),
        (1.0, ""),
        (1e-3, "m"),
        (1e-6, "\u{b5}"),
        (1e-9, "n"),
        (1e-12, "p"),
        (1e-15, "f"),
    ];
    if value == 0.0 || !value.is_finite() {
        return format!("{value} {unit}");
    }
    let magnitude = value.abs();
    let (scale, prefix) = PREFIXES
        .iter()
        .find(|(scale, _)| magnitude >= *scale * 0.9995)
        .copied()
        .unwrap_or(PREFIXES[PREFIXES.len() - 1]);
    format!("{} {prefix}{unit}", trim_significant(value / scale, 3))
}

fn trim_significant(value: f64, digits: usize) -> String {
    let magnitude = value.abs();
    let before_point = if magnitude >= 1.0 {
        magnitude.log10().floor() as usize + 1
    } else {
        1
    };
    let decimals = digits.saturating_sub(before_point);
    let text = format!("{value:.decimals$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}

/// The damping constant is dimensionless: plain at 0.01 and above, exponent
/// form below, as it is written in papers.
fn format_alpha(alpha: f64) -> String {
    if alpha != 0.0 && alpha.abs() < 0.01 {
        format!("{alpha:.1e}")
    } else {
        trim_significant(alpha, 3)
    }
}

fn triple(value: Option<&Value>) -> Option<[f64; 3]> {
    let items = value?.as_array()?;
    if items.len() != 3 {
        return None;
    }
    Some([items[0].as_f64()?, items[1].as_f64()?, items[2].as_f64()?])
}

/// Denormalised model facts for the inspector, read from the scene so it can
/// render without opening the archive. Only what the scene actually states is
/// emitted: a missing field is left out, never guessed, and a scene with
/// nothing to say yields no summary at all.
pub fn summary_from_scene(scene: &Value) -> Option<Value> {
    let mut summary = Map::new();
    let study = scene.get("study");
    let fdm = study.and_then(|s| s.get("fdm"));

    if let Some(cell) = triple(fdm.and_then(|f| f.get("default_cell"))) {
        let nm: Vec<String> = cell.iter().map(|v| trim_significant(v * 1e9, 3)).collect();
        summary.insert(
            "cell_size".into(),
            Value::String(format!("{} nm", nm.join(" \u{d7} "))),
        );
        if let Some(size) = triple(scene.get("universe").and_then(|u| u.get("size"))) {
            let cells: Vec<String> = size
                .iter()
                .zip(cell.iter())
                .filter(|(_, c)| **c > 0.0)
                .map(|(s, c)| format!("{}", (s / c).round() as i64))
                .collect();
            if cells.len() == 3 {
                summary.insert(
                    "discretisation".into(),
                    Value::String(cells.join(" \u{d7} ")),
                );
            }
        }
    }

    if let Some(materials) = scene.get("materials").and_then(Value::as_array) {
        let names: Vec<Value> = materials
            .iter()
            .filter_map(|m| m.get("name").and_then(Value::as_str))
            .map(|n| Value::String(n.to_string()))
            .collect();
        if !names.is_empty() {
            summary.insert("materials".into(), Value::Array(names));
        }
        // One material states its constants; with several there is no single Ms.
        if materials.len() == 1 {
            if let Some(props) = materials[0].get("properties") {
                if let Some(ms) = props.get("Ms").and_then(Value::as_f64) {
                    summary.insert("ms".into(), Value::String(si_value(ms, "A/m")));
                }
                if let Some(aex) = props.get("Aex").and_then(Value::as_f64) {
                    summary.insert("aex".into(), Value::String(si_value(aex, "J/m")));
                }
                if let Some(alpha) = props.get("alpha").and_then(Value::as_f64) {
                    summary.insert("alpha".into(), Value::String(format_alpha(alpha)));
                }
            }
        }
    }

    let mut interactions: Vec<String> = Vec::new();
    let mut add = |name: &str| {
        if !interactions.iter().any(|existing| existing == name) {
            interactions.push(name.to_string());
        }
    };
    if study
        .and_then(|s| s.get("exchange_enabled"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        add("exchange");
    }
    if study
        .and_then(|s| s.get("demag_enabled"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        add("demag");
    }
    for object in scene
        .get("objects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for entry in object
            .get("physics_stack")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            if let Some(kind) = entry.get("kind").and_then(Value::as_str) {
                add(&kind.replace('_', " "));
            }
        }
    }
    if !interactions.is_empty() {
        summary.insert(
            "interactions".into(),
            Value::Array(interactions.into_iter().map(Value::String).collect()),
        );
    }

    if let Some(solver) = study.and_then(|s| s.get("solver")) {
        if let Some(integrator) = solver.get("integrator").and_then(Value::as_str) {
            if !integrator.is_empty() {
                summary.insert(
                    "integrator".into(),
                    Value::String(integrator.to_uppercase()),
                );
            }
        }
        if let Some(max_err) = solver.get("max_err").and_then(Value::as_str) {
            if !max_err.trim().is_empty() {
                summary.insert(
                    "tolerance".into(),
                    Value::String(max_err.trim().to_string()),
                );
            }
        }
    }

    if summary.is_empty() {
        None
    } else {
        Some(Value::Object(summary))
    }
}

/// RFC 3339 in UTC, to the second. Days-from-civil arithmetic keeps the host
/// free of a date dependency for the one place that formats a timestamp.
pub fn rfc3339_utc(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{ProjectEnvelope, ProjectId};
    use fullmag_workspace::{EventKind, RecordEvent};
    use std::time::Duration;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn open_workspace(dir: &Path) -> Workspace {
        Workspace::open(dir.join("workspace.db")).unwrap().0
    }

    fn tiny_png() -> Vec<u8> {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(b"not really image data");
        png
    }

    fn write_project(path: &Path, id: &str, name: &str, png: Option<&[u8]>) {
        let mut envelope = ProjectEnvelope::blank(ProjectId::parse(id).unwrap(), name).unwrap();
        if let Some(png) = png {
            provenance::set_document(&mut envelope, THUMBNAIL_PATH, png.to_vec()).unwrap();
        }
        let bytes = FileProjectRepository::new()
            .encode_archive(&envelope)
            .unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn observe(workspace: &Workspace, path: &Path, id: &str, name: &str) -> i64 {
        let mut seen = SeenItem::new(ItemKind::Project, path);
        seen.project_id = Some(id.into());
        seen.name = Some(name.into());
        workspace.observe(&seen).unwrap().item_id
    }

    #[test]
    fn formats_timestamps_in_utc() {
        assert_eq!(rfc3339_utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        // 2026-10-03T12:34:56Z
        assert_eq!(rfc3339_utc(at(1_791_030_896)), "2026-10-03T12:34:56Z");
        // A leap day.
        assert_eq!(rfc3339_utc(at(1_709_208_000)), "2024-02-29T12:00:00Z");
    }

    #[test]
    fn an_empty_database_reads_as_an_empty_index() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let index = read_index(&workspace).unwrap();
        assert_eq!(index["format_version"], 1);
        assert_eq!(index["entries"].as_array().unwrap().len(), 0);
        assert!(index.get("scanned_locations").is_none());
    }

    #[test]
    fn items_become_entries_with_their_meta_in_the_documented_shape() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let path = dir.path().join("wall.fms");
        fs::write(&path, b"archive").unwrap();
        workspace
            .record(
                &RecordEvent::new(ItemKind::Project, &path, EventKind::Open, Actor::Desktop)
                    .with_project_id("pid-wall")
                    .with_name("Domain wall")
                    .with_meta_patch(json!({
                        "solver": "fem",
                        "schema_version": "1.2",
                        "revision": 7,
                        "tags": ["magnonics"],
                        "authors": [{"name": "Ada", "role": "creator"}],
                        "summary": {"ms": "140 kA/m"},
                        "last_error": null
                    })),
            )
            .unwrap();
        workspace.pin(&path, true, Actor::Desktop).unwrap();

        let index = read_index(&workspace).unwrap();
        let entry = &index["entries"][0];
        assert_eq!(entry["project_id"], "pid-wall");
        assert_eq!(entry["name"], "Domain wall");
        assert_eq!(entry["solver"], "FEM");
        assert_eq!(entry["status"], "ready");
        assert_eq!(entry["revision"], 7);
        assert_eq!(entry["manifest_schema_version"], "1.2");
        assert_eq!(entry["pinned"], true);
        assert_eq!(entry["tags"], json!(["magnonics"]));
        assert_eq!(entry["authors"][0]["name"], "Ada");
        assert_eq!(entry["summary"]["ms"], "140 kA/m");
        assert_eq!(entry["size_bytes"], 7);
        assert!(entry["last_opened_at"].as_str().unwrap().ends_with('Z'));
        assert!(entry.get("thumbnail").is_none());
        assert!(entry.get("last_error").is_none());
    }

    #[test]
    fn a_file_that_never_opened_gets_a_stable_synthetic_id() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let path = dir.path().join("broken.fms");
        fs::write(&path, b"not a zip").unwrap();
        refresh_project(&workspace, &path).unwrap();
        let entry = read_index(&workspace).unwrap()["entries"][0].clone();
        assert_eq!(entry["status"], "failed");
        assert_eq!(entry["name"], "broken");
        assert!(entry["last_error"].as_str().is_some_and(|s| !s.is_empty()));
        let id = entry["project_id"].as_str().unwrap().to_string();
        assert!(id.starts_with("path:"));
        // Pinning by the synthetic id reaches the row.
        let pinned = set_pinned(&workspace, &id, true).unwrap();
        assert_eq!(pinned["entries"][0]["pinned"], true);
    }

    #[test]
    fn pin_and_forget_go_through_the_database_and_reject_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let path = dir.path().join("a.fms");
        fs::write(&path, b"archive").unwrap();
        observe(&workspace, &path, "a", "A");

        let pinned = set_pinned(&workspace, "a", true).unwrap();
        assert_eq!(pinned["entries"][0]["pinned"], true);
        assert!(workspace.find(&path).unwrap().unwrap().pinned);
        assert!(set_pinned(&workspace, "nope", true).is_err());

        let forgotten = forget(&workspace, "a").unwrap();
        assert_eq!(forgotten["entries"].as_array().unwrap().len(), 0);
        // The row and the file stay.
        assert!(workspace.find(&path).unwrap().unwrap().forgotten);
        assert!(path.exists());
        // Forgetting something unknown is not an error, as before.
        assert!(forget(&workspace, "nope").is_ok());
    }

    #[test]
    fn rebuild_keeps_pins_and_marks_vanished_files_missing() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let root = dir.path().join("projects");
        fs::create_dir_all(&root).unwrap();
        let gone = root.join("gone.fms");
        fs::write(&gone, b"archive").unwrap();
        observe(&workspace, &gone, "g", "Gone");
        set_pinned(&workspace, "g", true).unwrap();
        fs::remove_file(&gone).unwrap();

        let rebuilt = rebuild_index(&workspace, &[root.clone()], at(1_791_030_896)).unwrap();
        let entry = &rebuilt["entries"][0];
        assert_eq!(entry["status"], "missing");
        assert_eq!(entry["pinned"], true);
        assert_eq!(rebuilt["scanned_locations"][0]["reachable"], true);
        assert_eq!(stored_roots(&workspace), vec![root]);
    }

    #[test]
    fn rebuild_stores_archives_with_their_thumbnail_outside_meta_and_updates_it() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let root = dir.path().join("projects");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("yig.fms");
        let png = tiny_png();
        write_project(&file, "pid-yig", "YIG strip", Some(&png));

        let index = rebuild_index(&workspace, &[root.clone()], at(0)).unwrap();
        let entry = &index["entries"][0];
        assert_eq!(entry["project_id"], "pid-yig");
        assert_eq!(entry["name"], "YIG strip");
        assert_eq!(entry["status"], "ready");
        assert_eq!(entry["solver"], "FDM");
        assert_eq!(entry["revision"], 0);
        let uri = entry["thumbnail"].as_str().unwrap();
        assert_eq!(
            STANDARD
                .decode(uri.trim_start_matches("data:image/png;base64,"))
                .unwrap(),
            png
        );
        let item = workspace.find(&file).unwrap().unwrap();
        assert!(
            !item.meta.to_string().contains("data:image"),
            "no data URI in meta"
        );
        assert_eq!(item.use_count, 0, "a scan is not a use");
        let stored = workspace.get_thumbnail(item.id).unwrap().unwrap();
        assert_eq!(stored.sha256, sha256_hex(&png));

        // A project saved without its preview loses it on the next scan.
        write_project(&file, "pid-yig", "YIG strip", None);
        let index = rebuild_index(&workspace, &[root], at(1)).unwrap();
        assert!(index["entries"][0].get("thumbnail").is_none());
        assert!(workspace.get_thumbnail(item.id).unwrap().is_none());
    }

    #[test]
    fn refreshing_one_project_keeps_its_pin_and_last_use() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let listed = dir.path().join("listed.fms");
        write_project(&listed, "pid-l", "Listed", None);
        workspace
            .record_at(
                &RecordEvent::new(ItemKind::Project, &listed, EventKind::Open, Actor::Desktop)
                    .with_project_id("pid-l"),
                at(1_700_000_000),
            )
            .unwrap();
        set_pinned(&workspace, "pid-l", true).unwrap();
        let before = workspace.find(&listed).unwrap().unwrap();

        fs::write(&listed, b"not an archive").unwrap();
        refresh_project(&workspace, &listed).unwrap();
        let after = workspace.find(&listed).unwrap().unwrap();
        assert!(after.pinned);
        assert_eq!(after.last_used_at, before.last_used_at);
        assert_eq!(after.use_count, before.use_count);
        assert_eq!(after.status, ItemStatus::Failed);
        assert_eq!(after.meta["last_error"].as_str().is_some(), true);
    }

    #[test]
    fn a_copy_of_a_project_is_listed_once_as_the_most_recently_modified_one() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = open_workspace(dir.path());
        let old = dir.path().join("old.fms");
        let new = dir.path().join("copy.fms");
        fs::write(&old, b"1").unwrap();
        observe(&workspace, &old, "same", "Original");
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&new, b"22").unwrap();
        observe(&workspace, &new, "same", "Copy");

        let index = read_index(&workspace).unwrap();
        let entries = index["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "Copy");
    }

    #[test]
    fn solver_is_read_from_the_scene_and_defaults_to_fdm() {
        assert_eq!(
            solver_from_scene(&json!({"study": {"backend": "fem"}})),
            "FEM"
        );
        assert_eq!(
            solver_from_scene(&json!({"requested_backend": "FDM"})),
            "FDM"
        );
        assert_eq!(solver_from_scene(&json!({"unrelated": 1})), "FDM");
    }

    #[test]
    fn solver_prefers_the_study_over_unrelated_keys() {
        let scene = json!({
            "objects": [{"backend": "fem"}],
            "study": {"requested_backend": "auto", "backend": "fdm"}
        });
        assert_eq!(solver_from_scene(&scene), "FDM");
    }

    #[test]
    fn si_values_get_a_prefix_and_three_significant_digits() {
        assert_eq!(si_value(1.4e5, "A/m"), "140 kA/m");
        assert_eq!(si_value(3.65e-12, "J/m"), "3.65 pJ/m");
        assert_eq!(si_value(2.0e-9, "m"), "2 nm");
        assert_eq!(si_value(0.0, "A/m"), "0 A/m");
        assert_eq!(format_alpha(2.0e-4), "2.0e-4");
        assert_eq!(format_alpha(0.5), "0.5");
    }

    #[test]
    fn summary_reports_only_what_the_scene_states() {
        let scene = json!({
            "universe": {"mode": "manual", "size": [1.024e-6, 1.024e-6, 4.0e-8]},
            "materials": [{"name": "YIG", "properties": {"Ms": 1.4e5, "Aex": 3.65e-12, "alpha": 2.0e-4}}],
            "objects": [{"physics_stack": [
                {"kind": "interfacial_dmi", "enabled": true},
                {"kind": "bulk_dmi", "enabled": false}
            ]}],
            "study": {
                "exchange_enabled": true, "demag_enabled": true,
                "fdm": {"default_cell": [2.0e-9, 2.0e-9, 5.0e-9]},
                "solver": {"integrator": "rk45", "max_err": "1e-6"}
            }
        });
        let summary = summary_from_scene(&scene).unwrap();
        assert_eq!(summary["cell_size"], "2 \u{d7} 2 \u{d7} 5 nm");
        assert_eq!(summary["discretisation"], "512 \u{d7} 512 \u{d7} 8");
        assert_eq!(summary["materials"], json!(["YIG"]));
        assert_eq!(summary["ms"], "140 kA/m");
        assert_eq!(summary["aex"], "3.65 pJ/m");
        assert_eq!(summary["alpha"], "2.0e-4");
        assert_eq!(
            summary["interactions"],
            json!(["exchange", "demag", "interfacial dmi"])
        );
        assert_eq!(summary["integrator"], "RK45");
        assert_eq!(summary["tolerance"], "1e-6");
        assert!(summary.get("periodicity").is_none());
    }

    #[test]
    fn several_materials_state_no_single_set_of_constants() {
        let scene = json!({"materials": [
            {"name": "A", "properties": {"Ms": 1.0, "alpha": 0.01}},
            {"name": "B", "properties": {"Ms": 2.0, "alpha": 0.02}}
        ]});
        let summary = summary_from_scene(&scene).unwrap();
        assert_eq!(summary["materials"], json!(["A", "B"]));
        assert!(summary.get("ms").is_none());
    }

    #[test]
    fn an_empty_scene_has_no_summary() {
        assert!(summary_from_scene(&json!({})).is_none());
    }

    #[test]
    fn a_png_preview_becomes_a_data_uri() {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(b"rest");
        let uri = thumbnail_data_uri(&png).unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));
        assert_eq!(
            STANDARD
                .decode(uri.trim_start_matches("data:image/png;base64,"))
                .unwrap(),
            png
        );
    }

    #[test]
    fn previews_that_are_not_png_or_too_large_are_left_out() {
        assert!(thumbnail_data_uri(b"GIF89a....").is_none());
        assert!(thumbnail_data_uri(&[]).is_none());
        let mut huge = PNG_SIGNATURE.to_vec();
        huge.resize(MAX_INLINE_THUMBNAIL_BYTES + 1, 0);
        assert!(thumbnail_data_uri(&huge).is_none());
        assert!(!is_inlinable_png(&huge));
    }

    #[test]
    fn schema_versions_are_shortened_to_major_minor() {
        assert_eq!(short_schema_version("1.2.0"), "1.2");
        assert_eq!(short_schema_version("fullmag-project/1.1"), "1.1");
    }
}
