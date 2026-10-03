//! Host-side recent-project index behind the start screen.
//!
//! The index is derived state: every field can be rebuilt by rescanning the
//! project locations, so a missing file reads as an empty index, an unreadable
//! one is reported (never panicked on) and the renderer offers a rebuild.
//! Writes are atomic (temporary file, flush, rename) so a crash cannot leave
//! the truncated file the error state exists to recover from.
//!
//! Schema: `docs/design/start-screen/schema/recent-index.schema.json`.

use fullmag_application::{ProjectRepository, ProjectSource};
use fullmag_application::FileProjectRepository;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FORMAT_VERSION: u64 = 1;
const MAX_SCAN_DEPTH: usize = 6;
const MAX_ENTRIES: usize = 2000;
const MAX_PROJECT_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
pub const INDEX_FILE_NAME: &str = "recent-index.json";

/// The status strings the renderer understands.
const STATUS_READY: &str = "ready";
const STATUS_MISSING: &str = "missing";
const STATUS_FAILED: &str = "failed";
const STATUS_MIGRATE: &str = "migrate";
const STATUS_READONLY: &str = "readonly";

pub fn empty_index(now: SystemTime) -> Value {
    json!({
        "format_version": FORMAT_VERSION,
        "generated_at": rfc3339_utc(now),
        "entries": [],
    })
}

/// Read the index. A missing file is an empty index, not an error.
pub fn read_index(file: &Path) -> Result<Value, String> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_index(SystemTime::now()));
        }
        Err(error) => return Err(format!("failed to read {}: {error}", file.display())),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON ({error})", file.display()))?;
    validate_index(&value)?;
    Ok(value)
}

fn validate_index(value: &Value) -> Result<(), String> {
    match value.get("format_version").and_then(Value::as_u64) {
        Some(FORMAT_VERSION) => {}
        other => {
            return Err(format!(
                "unsupported index format {}; expected {FORMAT_VERSION}",
                other.map_or_else(|| "(none)".to_string(), |v| v.to_string())
            ))
        }
    }
    if !value.get("entries").is_some_and(Value::is_array) {
        return Err("the index has no entries array".into());
    }
    Ok(())
}

/// Temporary file, flush, rename: readers see the old index or the new one.
pub fn write_atomic(file: &Path, index: &Value) -> Result<(), String> {
    let parent = file
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", file.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let temporary = file.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(index).map_err(|error| error.to_string())?;
    {
        let mut handle = fs::File::create(&temporary)
            .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?;
        handle
            .write_all(&bytes)
            .and_then(|()| handle.sync_all())
            .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    }
    fs::rename(&temporary, file).map_err(|error| {
        // Do not leave the temporary behind to be mistaken for state.
        let _ = fs::remove_file(&temporary);
        format!("failed to publish {}: {error}", file.display())
    })
}

fn entries_mut(index: &mut Value) -> Result<&mut Vec<Value>, String> {
    index
        .get_mut("entries")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "the index has no entries array".to_string())
}

pub fn set_pinned(file: &Path, project_id: &str, pinned: bool) -> Result<Value, String> {
    let mut index = read_index(file)?;
    let mut found = false;
    for entry in entries_mut(&mut index)? {
        if entry.get("project_id").and_then(Value::as_str) == Some(project_id) {
            entry["pinned"] = Value::Bool(pinned);
            found = true;
        }
    }
    if !found {
        return Err(format!("project {project_id} is not in the index"));
    }
    write_atomic(file, &index)?;
    Ok(index)
}

/// Remove an entry from the list. The file on disk is never touched.
pub fn forget(file: &Path, project_id: &str) -> Result<Value, String> {
    let mut index = read_index(file)?;
    entries_mut(&mut index)?
        .retain(|entry| entry.get("project_id").and_then(Value::as_str) != Some(project_id));
    write_atomic(file, &index)?;
    Ok(index)
}

/// Record that a project was just opened. Best effort for the caller: a failure
/// here must never stop the project from opening.
pub fn touch_opened(file: &Path, path: &Path, now: SystemTime) -> Result<(), String> {
    let mut index = read_index(file)?;
    let target = path.display().to_string();
    let stamp = rfc3339_utc(now);
    let mut touched = false;
    for entry in entries_mut(&mut index)? {
        if entry.get("path").and_then(Value::as_str) == Some(target.as_str()) {
            entry["last_opened_at"] = Value::String(stamp.clone());
            touched = true;
        }
    }
    if touched {
        write_atomic(file, &index)?;
    }
    Ok(())
}

/// Rescan `roots` and merge with what the previous index remembered.
///
/// What a scan cannot know is carried over: pins and the last-opened time.
/// Entries whose file is gone are kept with status `missing` instead of being
/// dropped, so an offline share does not silently erase the user's list.
pub fn rebuild_index(file: &Path, roots: &[PathBuf], now: SystemTime) -> Result<Value, String> {
    let previous = read_index(file).unwrap_or_else(|_| empty_index(now));
    let mut remembered: HashMap<String, Value> = HashMap::new();
    for entry in previous
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(path) = entry.get("path").and_then(Value::as_str) {
            remembered.insert(path.to_string(), entry.clone());
        }
    }

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

    let mut entries: Vec<Value> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    for path in found_paths.iter().take(MAX_ENTRIES) {
        let key = path.display().to_string();
        let entry = entry_from_file(path, remembered.get(&key));
        seen_paths.insert(key);
        entries.push(entry);
    }
    for (key, old) in remembered {
        if seen_paths.contains(&key) {
            continue;
        }
        // Kept, not dropped: the file may be on a share that is offline.
        let mut kept = old;
        if !Path::new(&key).exists() {
            kept["status"] = Value::String(STATUS_MISSING.into());
        }
        entries.push(kept);
    }

    let entries = dedupe_by_project_id(entries);
    let index = json!({
        "format_version": FORMAT_VERSION,
        "generated_at": rfc3339_utc(now),
        "scanned_locations": locations,
        "entries": entries,
    });
    write_atomic(file, &index)?;
    Ok(index)
}

/// The same project id at two paths is a copy; keep the most recently modified.
fn dedupe_by_project_id(entries: Vec<Value>) -> Vec<Value> {
    let mut best: HashMap<String, Value> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("project_id").and_then(Value::as_str).map(String::from) else {
            continue;
        };
        match best.get(&id) {
            None => {
                order.push(id.clone());
                best.insert(id, entry);
            }
            Some(existing) => {
                let newer = entry.get("modified_at").and_then(Value::as_str)
                    > existing.get("modified_at").and_then(Value::as_str);
                if newer {
                    best.insert(id, entry);
                }
            }
        }
    }
    order.into_iter().filter_map(|id| best.remove(&id)).collect()
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

/// Build one entry from an archive on disk. An archive that cannot be read is
/// still listed, as failed with the reason, so a corrupt project is visible
/// rather than silently absent.
pub fn entry_from_file(path: &Path, previous: Option<&Value>) -> Value {
    let path_text = path.display().to_string();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("project")
        .to_string();
    let meta = fs::metadata(path).ok();
    let size = meta.as_ref().map(|m| m.len());
    let modified = meta.as_ref().and_then(|m| m.modified().ok());
    let created = meta.as_ref().and_then(|m| m.created().ok());

    let mut entry = Map::new();
    entry.insert("path".into(), Value::String(path_text.clone()));
    if let Some(size) = size {
        entry.insert("size_bytes".into(), json!(size));
    }
    if let Some(modified) = modified {
        entry.insert("modified_at".into(), Value::String(rfc3339_utc(modified)));
    }
    if let Some(created) = created {
        entry.insert("created_at".into(), Value::String(rfc3339_utc(created)));
    }

    let loaded = if size.is_some_and(|s| s > MAX_PROJECT_ARCHIVE_BYTES) {
        Err(format!("archive exceeds {MAX_PROJECT_ARCHIVE_BYTES} byte limit"))
    } else {
        FileProjectRepository::new()
            .open(ProjectSource::Path(path.to_path_buf()))
            .map_err(|error| error.to_string())
    };

    match loaded {
        Ok(opened) => {
            let definition = &opened.envelope.definition;
            entry.insert(
                "project_id".into(),
                Value::String(definition.project_id.as_str().to_string()),
            );
            entry.insert("name".into(), Value::String(definition.name.clone()));
            entry.insert("revision".into(), json!(definition.revision));
            entry.insert(
                "manifest_schema_version".into(),
                Value::String(short_schema_version(&opened.migration.source_schema)),
            );
            entry.insert(
                "solver".into(),
                Value::String(solver_from_scene(definition.scene.value()).into()),
            );
            let status = if opened.read_only_reason.is_some() {
                STATUS_READONLY
            } else if opened.migration.source_schema != opened.migration.target_schema {
                STATUS_MIGRATE
            } else {
                STATUS_READY
            };
            entry.insert("status".into(), Value::String(status.into()));
            if let Some(reason) = opened.read_only_reason {
                entry.insert("mode".into(), Value::String("read_only".into()));
                entry.insert("mode_reason".into(), Value::String(reason));
            } else {
                entry.insert("mode".into(), Value::String("read_write".into()));
            }
        }
        Err(reason) => {
            // Stable synthetic id so the row survives rebuilds until it opens.
            entry.insert(
                "project_id".into(),
                Value::String(format!("path:{path_text}")),
            );
            entry.insert("name".into(), Value::String(stem));
            entry.insert("solver".into(), Value::String("FDM".into()));
            entry.insert("status".into(), Value::String(STATUS_FAILED.into()));
            entry.insert("last_error".into(), Value::String(reason));
        }
    }

    let carried_open = previous
        .and_then(|p| p.get("last_opened_at"))
        .and_then(Value::as_str)
        .map(String::from);
    let opened_at = carried_open
        .or_else(|| entry.get("modified_at").and_then(Value::as_str).map(String::from))
        .unwrap_or_else(|| rfc3339_utc(UNIX_EPOCH));
    entry.insert("last_opened_at".into(), Value::String(opened_at));
    if previous
        .and_then(|p| p.get("pinned"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        entry.insert("pinned".into(), Value::Bool(true));
    }
    if let Some(tags) = previous.and_then(|p| p.get("tags")) {
        entry.insert("tags".into(), tags.clone());
    }
    Value::Object(entry)
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

/// The requested discretisation lives in the scene, not in the project
/// definition. Looks for the first `backend`/`discretization`-like string; a
/// scene that does not say defaults to FDM, which is what a new empty problem is.
pub fn solver_from_scene(scene: &Value) -> &'static str {
    fn walk(value: &Value, depth: usize) -> Option<&'static str> {
        if depth > 6 {
            return None;
        }
        match value {
            Value::Object(map) => {
                for key in ["requested_backend", "backend", "discretization", "solver"] {
                    if let Some(text) = map.get(key).and_then(Value::as_str) {
                        let lower = text.to_ascii_lowercase();
                        if lower.starts_with("fem") {
                            return Some("FEM");
                        }
                        if lower.starts_with("fdm") {
                            return Some("FDM");
                        }
                    }
                }
                map.values().find_map(|child| walk(child, depth + 1))
            }
            Value::Array(items) => items.iter().find_map(|child| walk(child, depth + 1)),
            _ => None,
        }
    }
    walk(scene, 0).unwrap_or("FDM")
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
    use std::time::Duration;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
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
    fn missing_index_reads_as_empty_and_corrupt_one_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(INDEX_FILE_NAME);
        let index = read_index(&file).unwrap();
        assert_eq!(index["entries"].as_array().unwrap().len(), 0);

        fs::write(&file, b"{\"format_version\": 1, \"entr").unwrap();
        assert!(read_index(&file).is_err());
        fs::write(&file, b"{\"format_version\": 2, \"entries\": []}").unwrap();
        assert!(read_index(&file).unwrap_err().contains("unsupported"));
    }

    #[test]
    fn atomic_write_replaces_the_file_and_leaves_no_temporary() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(INDEX_FILE_NAME);
        write_atomic(&file, &empty_index(at(0))).unwrap();
        write_atomic(&file, &json!({"format_version": 1, "generated_at": "x", "entries": []}))
            .unwrap();
        assert_eq!(read_index(&file).unwrap()["generated_at"], "x");
        assert!(!file.with_extension("json.tmp").exists());
    }

    #[test]
    fn pin_and_forget_update_the_index_and_reject_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(INDEX_FILE_NAME);
        let index = json!({
            "format_version": 1,
            "generated_at": "x",
            "entries": [{"project_id": "a", "name": "A", "path": "/a.fms"}],
        });
        write_atomic(&file, &index).unwrap();
        let pinned = set_pinned(&file, "a", true).unwrap();
        assert_eq!(pinned["entries"][0]["pinned"], true);
        assert!(set_pinned(&file, "nope", true).is_err());
        let forgotten = forget(&file, "a").unwrap();
        assert_eq!(forgotten["entries"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn rebuild_keeps_pins_and_marks_vanished_files_missing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(INDEX_FILE_NAME);
        let root = dir.path().join("projects");
        fs::create_dir_all(&root).unwrap();
        let gone = root.join("gone.fms");
        let previous = json!({
            "format_version": 1,
            "generated_at": "x",
            "entries": [{
                "project_id": "g", "name": "Gone", "path": gone.display().to_string(),
                "solver": "FDM", "status": "ready", "pinned": true,
                "last_opened_at": "2026-01-01T00:00:00Z"
            }],
        });
        write_atomic(&file, &previous).unwrap();
        let rebuilt = rebuild_index(&file, &[root.clone()], at(1_791_030_896)).unwrap();
        let entry = &rebuilt["entries"][0];
        assert_eq!(entry["status"], STATUS_MISSING);
        assert_eq!(entry["pinned"], true);
        assert_eq!(rebuilt["scanned_locations"][0]["reachable"], true);
    }

    #[test]
    fn an_unreadable_archive_is_listed_as_failed_with_its_reason() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("broken.fms");
        fs::write(&bad, b"not a zip").unwrap();
        let entry = entry_from_file(&bad, None);
        assert_eq!(entry["status"], STATUS_FAILED);
        assert_eq!(entry["name"], "broken");
        assert!(entry["last_error"].as_str().is_some_and(|s| !s.is_empty()));
    }

    #[test]
    fn solver_is_read_from_the_scene_and_defaults_to_fdm() {
        assert_eq!(solver_from_scene(&json!({"study": {"backend": "fem"}})), "FEM");
        assert_eq!(solver_from_scene(&json!({"requested_backend": "FDM"})), "FDM");
        assert_eq!(solver_from_scene(&json!({"unrelated": 1})), "FDM");
    }

    #[test]
    fn schema_versions_are_shortened_to_major_minor() {
        assert_eq!(short_schema_version("1.2.0"), "1.2");
        assert_eq!(short_schema_version("fullmag-project/1.1"), "1.1");
    }

    #[test]
    fn duplicates_keep_the_most_recently_modified_copy() {
        let entries = vec![
            json!({"project_id": "a", "path": "/old.fms", "modified_at": "2026-01-01T00:00:00Z"}),
            json!({"project_id": "a", "path": "/new.fms", "modified_at": "2026-06-01T00:00:00Z"}),
        ];
        let kept = dedupe_by_project_id(entries);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["path"], "/new.fms");
    }
}
