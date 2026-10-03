//! Read side of project provenance: who made a project, what changed and what
//! was computed. Backs the start screen's Authors, History and Runs tabs and
//! the author list in the recent index.
//!
//! The data lives in one opaque archive document, `project/provenance.json`.
//! Opaque documents under `project/` survive load and save unchanged, so no
//! archive-format change is needed and a project without the document is
//! simply one that predates provenance tracking, which is reported as such.
//! Nothing writes the document yet; this module only reads and normalises it.

use fullmag_application::{FileProjectRepository, ProjectRepository, ProjectSource};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::process::Command;

pub const PROVENANCE_PATH: &str = "project/provenance.json";

const HISTORY_KINDS: [&str; 5] = ["edit", "run", "migrate", "import", "restore"];
const RUN_STATUSES: [&str; 5] = ["queued", "running", "ready", "failed", "cancelled"];
const ROLES: [&str; 3] = ["creator", "contributor", "maintainer"];

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

fn normalise_run(value: &Value) -> Option<Value> {
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
    Ok(json!({
        "recorded": true,
        "authors": normalise_list(&root, "authors", normalise_author),
        "citation": Value::Object(citation),
        "history": normalise_list(&root, "history", normalise_history),
        "runs": normalise_list(&root, "runs", normalise_run),
    }))
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

fn git_config(key: &str) -> Option<String> {
    let output = Command::new("git").args(["config", "--get", key]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Who the current user is, for the greeting and for crediting new work: git
/// config first (the name a physicist already commits under), then the OS
/// user. Either may be absent; the greeting then stays generic.
pub fn author_identity() -> Value {
    let name = git_config("user.name")
        .or_else(|| std::env::var("USERNAME").ok().filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("USER").ok().filter(|s| !s.is_empty()));
    let source = if git_config("user.name").is_some() {
        "git"
    } else if name.is_some() {
        "os"
    } else {
        "none"
    };
    json!({
        "name": name,
        "email": git_config("user.email"),
        "source": source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_a_full_document_and_drops_bad_entries_individually() {
        let doc = json!({
            "authors": [
                {"name": "A. Author", "role": "creator", "orcid": "0000-0001"},
                {"role": "creator"},
                {"name": "B", "role": "wizard"}
            ],
            "citation": {"doi": "10.1/x", "unknown": "ignored"},
            "history": [
                {"revision": 2, "at": "2026-10-01T00:00:00Z", "kind": "edit",
                 "summary": "cell z 10 -> 5 nm", "changes": ["z", 5]},
                {"revision": 3, "at": "t", "kind": "teleport", "summary": "bad kind"},
                {"at": "t", "kind": "edit", "summary": "no revision"}
            ],
            "runs": [
                {"run_id": "r-1", "started_at": "t", "status": "ready", "frames": 12},
                {"run_id": "r-2", "started_at": "t", "status": "melted"}
            ]
        });
        let parsed = parse_provenance(doc.to_string().as_bytes()).unwrap();
        assert_eq!(parsed["recorded"], true);
        assert_eq!(parsed["authors"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["authors"][1]["role"], "contributor");
        assert_eq!(parsed["citation"], json!({"doi": "10.1/x"}));
        assert_eq!(parsed["history"].as_array().unwrap().len(), 1);
        assert_eq!(parsed["history"][0]["changes"], json!(["z"]));
        assert_eq!(parsed["runs"].as_array().unwrap().len(), 1);
        assert_eq!(parsed["runs"][0]["frames"], 12);
    }

    #[test]
    fn invalid_json_is_an_error_not_an_empty_record() {
        assert!(parse_provenance(b"{ not json").is_err());
    }

    #[test]
    fn an_empty_object_is_recorded_but_empty() {
        let parsed = parse_provenance(b"{}").unwrap();
        assert_eq!(parsed["recorded"], true);
        assert_eq!(parsed["history"], json!([]));
    }

    #[test]
    fn a_project_without_the_document_reports_unrecorded() {
        let value = unrecorded();
        assert_eq!(value["recorded"], false);
        assert_eq!(value["runs"], json!([]));
    }
}
