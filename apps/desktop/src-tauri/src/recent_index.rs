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

use base64::{engine::general_purpose::STANDARD, Engine as _};
use fullmag_application::FileProjectRepository;
use fullmag_workspace::{
    rfc3339_millis, Actor, Item, ItemKind, ItemStatus, Query, SeenItem, Sort, Workspace,
    WorkspaceError,
};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FORMAT_VERSION: u64 = 1;
const MAX_SCAN_DEPTH: usize = 6;
const MAX_ENTRIES: usize = 2000;
/// File name of the legacy JSON index, read once by the database import.
pub const INDEX_FILE_NAME: &str = "recent-index.json";
/// `kv` key holding the roots of the last rebuild (the schema's `scanned_locations`).
pub const SCANNED_LOCATIONS_KEY: &str = "recent_scanned_locations";

// The project readers (summary, scan of one archive, schema and solver
// labels, the preview constants) live in `fullmag-workspace-inspect`, shared
// with the local runtime API so both read a project the same way.
pub use fullmag_workspace_inspect::project::{
    is_inlinable_png, rfc3339_utc, scan_archive, sha256_hex, short_schema_version,
    ScannedProject, MAX_INLINE_THUMBNAIL_BYTES, PNG_SIGNATURE, THUMBNAIL_PATH,
};

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
            include_results: false,
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


/// A preview as a data URI, or `None` when it is not a PNG or is too large to
/// inline. Checking the signature keeps arbitrary bytes out of an `<img>`.
pub fn thumbnail_data_uri(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_INLINE_THUMBNAIL_BYTES || !bytes.starts_with(&PNG_SIGNATURE) {
        return None;
    }
    Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
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
            crate::provenance::set_document(&mut envelope, THUMBNAIL_PATH, png.to_vec()).unwrap();
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
