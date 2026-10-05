//! Project provenance, host side: recording saves, runs and previews. Reading
//! (parsing and normalising the document) lives in
//! `fullmag-workspace-inspect`; it backs the start screen's Authors, History
//! and Runs tabs and the author list in the recent index.
//!
//! The data lives in one opaque archive document, `project/provenance.json`.
//! Opaque documents under `project/` survive load and save unchanged, so no
//! archive-format change is needed and a project without the document is
//! simply one that predates provenance tracking, which is reported as such.
//! Host Save and run recording append to it (`record_save`, `record_run`).

use crate::recent_index::{MAX_INLINE_THUMBNAIL_BYTES, PNG_SIGNATURE, THUMBNAIL_PATH};
use fullmag_application::{OpaqueDocument, ProjectEnvelope};
use serde_json::{json, Map, Value};
use std::process::Command;

// The read side (parsing and normalising the document) is shared with the
// local runtime API through `fullmag-workspace-inspect`; this module keeps the
// write side: recording saves, runs and previews.
pub use fullmag_workspace_inspect::provenance::{
    normalise_run, parse_provenance, read_from_archive, unrecorded, PREVIEW_COLOURINGS,
    PROVENANCE_PATH, RUN_STATUSES,
};

/// The stored document as a JSON object, or an empty one when there is none. A
/// document that cannot be extended is an error so callers leave it untouched.
fn parse_previous(previous: Option<&[u8]>) -> Result<Value, String> {
    match previous {
        Some(bytes) => {
            let parsed: Value = serde_json::from_slice(bytes)
                .map_err(|error| format!("existing provenance is not valid JSON ({error})"))?;
            if !parsed.is_object() {
                return Err("existing provenance is not a JSON object".into());
            }
            Ok(parsed)
        }
        None => Ok(json!({})),
    }
}

/// Append one save to a provenance document and return the new bytes.
///
/// `previous` is the document already stored in the target file, which is the
/// source of truth for history: the archive a webview sends back can predate
/// earlier saves and must never overwrite them. History is append-only. The
/// person saving is added to `authors` if absent (the first author of a record
/// is the creator, later ones contributors) and credited on the entry. The
/// summary only says what is known, that a revision was saved. Unknown fields
/// of the existing document are preserved. A previous document that is not a
/// JSON object is an error, so the caller can leave it untouched.
pub fn record_save(
    previous: Option<&[u8]>,
    identity: &Value,
    at: &str,
    revision: u64,
) -> Result<Vec<u8>, String> {
    let mut root = parse_previous(previous)?;
    let object = root
        .as_object_mut()
        .ok_or_else(|| "provenance root is not an object".to_string())?;

    let name = identity
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty());

    if let Some(name) = name {
        let authors = object
            .entry("authors")
            .or_insert_with(|| Value::Array(Vec::new()));
        let list = authors
            .as_array_mut()
            .ok_or_else(|| "existing provenance authors is not an array".to_string())?;
        let known = list
            .iter()
            .any(|a| a.get("name").and_then(Value::as_str) == Some(name));
        if !known {
            let role = if list.is_empty() { "creator" } else { "contributor" };
            let mut author = Map::new();
            author.insert("name".into(), Value::String(name.to_string()));
            author.insert("role".into(), Value::String(role.to_string()));
            if let Some(email) = identity
                .get("email")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
            {
                author.insert("email".into(), Value::String(email.to_string()));
            }
            list.push(Value::Object(author));
        }
    }

    let history = object
        .entry("history")
        .or_insert_with(|| Value::Array(Vec::new()));
    let list = history
        .as_array_mut()
        .ok_or_else(|| "existing provenance history is not an array".to_string())?;
    let mut entry = Map::new();
    entry.insert("revision".into(), json!(revision));
    entry.insert("at".into(), Value::String(at.to_string()));
    entry.insert("kind".into(), Value::String("edit".into()));
    entry.insert(
        "summary".into(),
        Value::String(format!("Saved revision {revision}")),
    );
    if let Some(name) = name {
        entry.insert("by".into(), Value::String(name.to_string()));
    }
    list.push(Value::Object(entry));

    serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())
}

/// Upsert one run record and append the matching history entry; return the new
/// bytes. `run` is normalised through the run schema and rejected when it does
/// not fit. A run with the same `run_id` is replaced, any other is appended;
/// other runs and unknown fields of the existing document are preserved. A
/// damaged `previous` is an error, so the caller leaves it byte for byte.
pub fn record_run(
    previous: Option<&[u8]>,
    run: &Value,
    identity: &Value,
    at: &str,
    revision: u64,
) -> Result<Vec<u8>, String> {
    let run = normalise_run(run).ok_or_else(|| {
        format!(
            "run record is invalid: it needs run_id, started_at and a status of {}",
            RUN_STATUSES.join("|")
        )
    })?;
    let run_id = run["run_id"].as_str().unwrap_or_default().to_string();
    if run_id.is_empty() {
        return Err("run record is invalid: run_id must not be empty".into());
    }
    let status = run["status"].as_str().unwrap_or_default().to_string();
    let mut root = parse_previous(previous)?;
    let object = root
        .as_object_mut()
        .ok_or_else(|| "provenance root is not an object".to_string())?;

    let runs = object
        .entry("runs")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "existing provenance runs is not an array".to_string())?;
    match runs
        .iter_mut()
        .find(|existing| existing.get("run_id").and_then(Value::as_str) == Some(run_id.as_str()))
    {
        Some(existing) => *existing = run,
        None => runs.push(run),
    }

    let history = object
        .entry("history")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "existing provenance history is not an array".to_string())?;
    let mut entry = Map::new();
    entry.insert("revision".into(), json!(revision));
    entry.insert("at".into(), Value::String(at.to_string()));
    entry.insert("kind".into(), Value::String("run".into()));
    entry.insert(
        "summary".into(),
        Value::String(format!("Run {run_id} finished: {status}")),
    );
    if let Some(name) = identity
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
    {
        entry.insert("by".into(), Value::String(name.to_string()));
    }
    entry.insert("run_id".into(), Value::String(run_id));
    history.push(Value::Object(entry));

    serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())
}

/// Record how the stored preview was coloured, and which run produced it.
/// Unknown fields of the document are preserved.
pub fn record_preview(
    previous: &[u8],
    colouring: &str,
    run_id: &str,
    at: &str,
) -> Result<Vec<u8>, String> {
    let mut root = parse_previous(Some(previous))?;
    root["preview"] = json!({"colouring": colouring, "run_id": run_id, "at": at});
    serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())
}

/// Check a preview before it is stored: a PNG small enough for the index to
/// inline, under a known colour mapping.
pub fn validate_preview(png: &[u8], colouring: &str) -> Result<(), String> {
    if !PREVIEW_COLOURINGS.contains(&colouring) {
        return Err(format!(
            "unknown preview colouring `{colouring}`; expected one of {}",
            PREVIEW_COLOURINGS.join(", ")
        ));
    }
    if !png.starts_with(&PNG_SIGNATURE) {
        return Err("preview is not a PNG image".into());
    }
    if png.len() > MAX_INLINE_THUMBNAIL_BYTES {
        return Err(format!(
            "preview is {} bytes; the limit is {MAX_INLINE_THUMBNAIL_BYTES}",
            png.len()
        ));
    }
    Ok(())
}

/// Set an opaque document of a candidate, replacing any with the same path.
pub fn set_document(
    candidate: &mut ProjectEnvelope,
    path: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let document = OpaqueDocument::new(path, bytes).map_err(|error| error.to_string())?;
    candidate
        .opaque_documents
        .retain(|existing| existing.path() != path);
    candidate.opaque_documents.push(document);
    Ok(())
}

/// Keep the stored thumbnail when the candidate archive lacks one, so an
/// ordinary Save never deletes it. Only the host writes the thumbnail.
pub fn carry_thumbnail(candidate: &mut ProjectEnvelope, stored: Option<&OpaqueDocument>) {
    let Some(stored) = stored else { return };
    if candidate
        .opaque_documents
        .iter()
        .any(|existing| existing.path() == THUMBNAIL_PATH)
    {
        return;
    }
    candidate.opaque_documents.push(stored.clone());
}

/// Stamp a candidate envelope with the provenance of the save that is about to
/// publish it. When the stored document cannot be extended, it is carried over
/// byte for byte instead, so a damaged record is never destroyed by a save.
pub fn stamp_envelope(
    candidate: &mut ProjectEnvelope,
    stored: Option<&OpaqueDocument>,
    identity: &Value,
    at: &str,
    revision: u64,
) {
    let bytes = match record_save(stored.map(OpaqueDocument::bytes), identity, at, revision) {
        Ok(bytes) => bytes,
        Err(_) => match stored {
            Some(document) => document.bytes().to_vec(),
            None => return,
        },
    };
    let Ok(document) = OpaqueDocument::new(PROVENANCE_PATH, bytes) else {
        return;
    };
    candidate
        .opaque_documents
        .retain(|existing| existing.path() != PROVENANCE_PATH);
    candidate.opaque_documents.push(document);
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
    fn the_first_save_creates_the_record_with_a_creator() {
        let identity = json!({"name": "Anna", "email": "a@x.org"});
        let bytes = record_save(None, &identity, "2026-10-04T10:00:00Z", 3).unwrap();
        let parsed = parse_provenance(&bytes).unwrap();
        assert_eq!(parsed["authors"][0]["name"], "Anna");
        assert_eq!(parsed["authors"][0]["role"], "creator");
        assert_eq!(parsed["authors"][0]["email"], "a@x.org");
        assert_eq!(parsed["history"][0]["revision"], 3);
        assert_eq!(parsed["history"][0]["by"], "Anna");
        assert_eq!(parsed["history"][0]["summary"], "Saved revision 3");
    }

    #[test]
    fn later_saves_append_and_add_new_people_as_contributors() {
        let first = record_save(None, &json!({"name": "Anna"}), "t1", 1).unwrap();
        let second = record_save(Some(&first), &json!({"name": "Jan"}), "t2", 2).unwrap();
        let third = record_save(Some(&second), &json!({"name": "Jan"}), "t3", 3).unwrap();
        let parsed = parse_provenance(&third).unwrap();
        assert_eq!(parsed["authors"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["authors"][1]["role"], "contributor");
        assert_eq!(parsed["history"].as_array().unwrap().len(), 3);
        assert_eq!(parsed["history"][0]["revision"], 1);
    }

    #[test]
    fn unknown_fields_and_runs_survive_a_save() {
        let before = json!({"citation": {"doi": "10.1/x"}, "runs": [
            {"run_id": "r-1", "started_at": "t", "status": "ready"}
        ], "note": "kept"});
        let bytes = record_save(Some(before.to_string().as_bytes()), &json!({}), "t", 2).unwrap();
        let raw: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(raw["note"], "kept");
        assert_eq!(raw["citation"]["doi"], "10.1/x");
        assert_eq!(raw["runs"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn an_unknown_user_adds_a_history_entry_but_no_author() {
        let bytes = record_save(None, &json!({"name": null}), "t", 1).unwrap();
        let parsed = parse_provenance(&bytes).unwrap();
        assert_eq!(parsed["authors"], json!([]));
        assert!(parsed["history"][0].get("by").is_none());
    }

    #[test]
    fn a_damaged_previous_record_is_an_error_so_it_can_be_left_alone() {
        assert!(record_save(Some(b"{ nope"), &json!({}), "t", 1).is_err());
        assert!(record_save(Some(b"[1,2]"), &json!({}), "t", 1).is_err());
        assert!(record_save(Some(br#"{"history": 5}"#), &json!({}), "t", 1).is_err());
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

    fn run(id: &str, status: &str) -> Value {
        json!({"run_id": id, "started_at": "t0", "status": status, "frames": 3})
    }

    #[test]
    fn a_run_is_appended_with_a_history_entry_and_replaced_by_id() {
        let first = record_run(None, &run("r-1", "running"), &json!({"name": "Anna"}), "t1", 1).unwrap();
        let second = record_run(Some(&first), &run("r-2", "ready"), &json!({}), "t2", 2).unwrap();
        let third = record_run(Some(&second), &run("r-1", "failed"), &json!({}), "t3", 3).unwrap();
        let parsed = parse_provenance(&third).unwrap();
        let runs = parsed["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0]["run_id"], "r-1");
        assert_eq!(runs[0]["status"], "failed");
        assert_eq!(runs[1]["status"], "ready");
        let history = parsed["history"].as_array().unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[0]["kind"], "run");
        assert_eq!(history[0]["run_id"], "r-1");
        assert_eq!(history[0]["revision"], 1);
        assert_eq!(history[0]["by"], "Anna");
        assert_eq!(history[0]["summary"], "Run r-1 finished: running");
        assert!(history[1].get("by").is_none());
    }

    #[test]
    fn recording_a_run_preserves_unknown_fields_and_other_content() {
        let before = json!({
            "citation": {"doi": "10.1/x"},
            "note": "kept",
            "history": [{"revision": 1, "at": "t", "kind": "edit", "summary": "s", "extra": 1}],
            "runs": [{"run_id": "r-0", "started_at": "t", "status": "ready"}]
        });
        let bytes = record_run(Some(before.to_string().as_bytes()), &run("r-1", "ready"), &json!({}), "t", 2).unwrap();
        let raw: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(raw["note"], "kept");
        assert_eq!(raw["citation"]["doi"], "10.1/x");
        assert_eq!(raw["history"][0]["extra"], 1);
        assert_eq!(raw["runs"].as_array().unwrap().len(), 2);
        assert_eq!(raw["runs"][0]["run_id"], "r-0");
    }

    #[test]
    fn a_damaged_previous_record_or_an_invalid_run_is_an_error() {
        let ok = run("r-1", "ready");
        assert!(record_run(Some(b"{ nope"), &ok, &json!({}), "t", 1).is_err());
        assert!(record_run(Some(b"[1]"), &ok, &json!({}), "t", 1).is_err());
        assert!(record_run(Some(br#"{"runs": 5}"#), &ok, &json!({}), "t", 1).is_err());
        assert!(record_run(Some(br#"{"history": 5}"#), &ok, &json!({}), "t", 1).is_err());
        assert!(record_run(None, &run("r-1", "melted"), &json!({}), "t", 1).is_err());
        assert!(record_run(None, &json!({"run_id": "r", "status": "ready"}), &json!({}), "t", 1).is_err());
        assert!(record_run(None, &run("", "ready"), &json!({}), "t", 1).is_err());
        assert!(record_run(None, &json!("run"), &json!({}), "t", 1).is_err());
    }

    #[test]
    fn a_preview_is_recorded_and_exposed_with_unknown_fields_kept() {
        let doc = record_run(Some(br#"{"note": "kept"}"#), &run("r-1", "ready"), &json!({}), "t", 1).unwrap();
        let bytes = record_preview(&doc, "mz-diverging", "r-1", "t9").unwrap();
        let parsed = parse_provenance(&bytes).unwrap();
        assert_eq!(parsed["preview"], json!({"colouring": "mz-diverging", "run_id": "r-1", "at": "t9"}));
        let raw: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(raw["note"], "kept");
        assert!(parse_provenance(b"{}").unwrap().get("preview").is_none());
    }

    #[test]
    fn previews_must_be_small_pngs_under_a_known_colouring() {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(b"data");
        assert!(validate_preview(&png, "hsl-sphere").is_ok());
        assert!(validate_preview(&png, "none").is_ok());
        assert!(validate_preview(b"GIF89a....", "hsl-sphere").is_err());
        assert!(validate_preview(&[], "hsl-sphere").is_err());
        assert!(validate_preview(&png, "rainbow").is_err());
        assert!(validate_preview(&png, "").is_err());
        let mut huge = PNG_SIGNATURE.to_vec();
        huge.resize(MAX_INLINE_THUMBNAIL_BYTES + 1, 0);
        assert!(validate_preview(&huge, "hsl-sphere").is_err());
        huge.truncate(MAX_INLINE_THUMBNAIL_BYTES);
        assert!(validate_preview(&huge, "hsl-sphere").is_ok());
    }
}
