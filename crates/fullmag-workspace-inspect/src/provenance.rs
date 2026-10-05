//! Read side of project provenance: who made a project, what changed and what
//! was computed. Backs the start screen's Authors, History and Runs tabs, the
//! author list in the recent index and the browser inspector.
//!
//! The data lives in one opaque archive document, `project/provenance.json`.
//! Opaque documents under `project/` survive load and save unchanged, so no
//! archive-format change is needed and a project without the document is
//! simply one that predates provenance tracking, which is reported as such.
//! The write side (Save and run recording) stays in the desktop host.

use fullmag_application::{FileProjectRepository, ProjectRepository, ProjectSource};
use serde_json::{json, Map, Value};
use std::path::Path;

pub const PROVENANCE_PATH: &str = "project/provenance.json";

const HISTORY_KINDS: [&str; 5] = ["edit", "run", "migrate", "import", "restore"];
pub const RUN_STATUSES: [&str; 5] = ["queued", "running", "ready", "failed", "cancelled"];
const ROLES: [&str; 3] = ["creator", "contributor", "maintainer"];

/// Colour mappings a stored preview may declare, so a thumbnail is never read
/// under the wrong convention.
pub const PREVIEW_COLOURINGS: [&str; 4] = ["hsl-sphere", "mz-diverging", "scalar-viridis", "none"];

fn string_field(map: &Map<String, Value>, key: &str) -> Option<Value> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()))
}

fn copy_strings(source: &Map<String, Value>, target: &mut Map<String, Value>, keys: &[&str]) {
    for key in keys {
        if let Some(value) = string_field(source, key) {
            target.insert((*key).into(), value);
        }
    }
}

fn normalise_author(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let name = map.get("name")?.as_str().filter(|s| !s.is_empty())?;
    let role = map
        .get("role")
        .and_then(Value::as_str)
        .filter(|r| ROLES.contains(r))
        .unwrap_or("contributor");
    let mut author = Map::new();
    author.insert("name".into(), Value::String(name.to_string()));
    author.insert("role".into(), Value::String(role.to_string()));
    copy_strings(map, &mut author, &["email", "affiliation", "orcid"]);
    Some(Value::Object(author))
}

fn normalise_history(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let revision = map.get("revision")?.as_u64()?;
    let at = map.get("at")?.as_str()?;
    let kind = map
        .get("kind")?
        .as_str()
        .filter(|k| HISTORY_KINDS.contains(k))?;
    let summary = map.get("summary")?.as_str()?;
    let mut entry = Map::new();
    entry.insert("revision".into(), json!(revision));
    entry.insert("at".into(), Value::String(at.to_string()));
    entry.insert("kind".into(), Value::String(kind.to_string()));
    entry.insert("summary".into(), Value::String(summary.to_string()));
    copy_strings(map, &mut entry, &["by", "run_id"]);
    if let Some(changes) = map.get("changes").and_then(Value::as_array) {
        let changes: Vec<Value> = changes
            .iter()
            .filter_map(|c| c.as_str().map(|s| Value::String(s.to_string())))
            .collect();
        if !changes.is_empty() {
            entry.insert("changes".into(), Value::Array(changes));
        }
    }
    if let Some(restorable) = map.get("restorable").and_then(Value::as_bool) {
        entry.insert("restorable".into(), Value::Bool(restorable));
    }
    Some(Value::Object(entry))
}

pub fn normalise_run(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let run_id = map.get("run_id")?.as_str()?;
    let started_at = map.get("started_at")?.as_str()?;
    let status = map
        .get("status")?
        .as_str()
        .filter(|s| RUN_STATUSES.contains(s))?;
    let mut run = Map::new();
    run.insert("run_id".into(), Value::String(run_id.to_string()));
    run.insert("started_at".into(), Value::String(started_at.to_string()));
    run.insert("status".into(), Value::String(status.to_string()));
    copy_strings(map, &mut run, &["finished_at", "device", "backend", "error"]);
    for key in ["revision", "output_bytes", "frames"] {
        if let Some(number) = map.get(key).and_then(Value::as_u64) {
            run.insert(key.into(), json!(number));
        }
    }
    if let Some(seconds) = map.get("duration_seconds").and_then(Value::as_f64) {
        run.insert("duration_seconds".into(), json!(seconds));
    }
    Some(Value::Object(run))
}

fn normalise_list(root: &Value, key: &str, one: fn(&Value) -> Option<Value>) -> Vec<Value> {
    root.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(one)
        .collect()
}

/// Normalise a provenance document. Entries that do not fit the schema are
/// dropped one by one, so a single bad record never hides the rest. Invalid
/// JSON is an error; the caller treats it as "unreadable", not as "empty".
pub fn parse_provenance(bytes: &[u8]) -> Result<Value, String> {
    let root: Value =
        serde_json::from_slice(bytes).map_err(|error| format!("provenance is not valid JSON ({error})"))?;
    let mut citation = Map::new();
    if let Some(map) = root.get("citation").and_then(Value::as_object) {
        copy_strings(map, &mut citation, &["doi", "url", "preferred_bibtex", "license"]);
    }
    let mut parsed = json!({
        "recorded": true,
        "authors": normalise_list(&root, "authors", normalise_author),
        "citation": Value::Object(citation),
        "history": normalise_list(&root, "history", normalise_history),
        "runs": normalise_list(&root, "runs", normalise_run),
    });
    if let Some(preview) = root.get("preview").and_then(normalise_preview) {
        parsed["preview"] = preview;
    }
    Ok(parsed)
}

fn normalise_preview(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let colouring = map.get("colouring")?.as_str().filter(|c| !c.is_empty())?;
    let mut preview = Map::new();
    preview.insert("colouring".into(), Value::String(colouring.to_string()));
    copy_strings(map, &mut preview, &["run_id", "at"]);
    Some(Value::Object(preview))
}

/// What a project with no provenance document reports: empty, and flagged as
/// never recorded so the renderer can say it predates tracking.
pub fn unrecorded() -> Value {
    json!({
        "recorded": false,
        "authors": [],
        "citation": {},
        "history": [],
        "runs": [],
    })
}

/// Read the provenance of the archive at `path`.
pub fn read_from_archive(path: &Path) -> Result<Value, String> {
    let opened = FileProjectRepository::new()
        .open(ProjectSource::Path(path.to_path_buf()))
        .map_err(|error| error.to_string())?;
    match opened
        .envelope
        .opaque_documents
        .iter()
        .find(|document| document.path() == PROVENANCE_PATH)
    {
        Some(document) => parse_provenance(document.bytes()),
        None => Ok(unrecorded()),
    }
}
