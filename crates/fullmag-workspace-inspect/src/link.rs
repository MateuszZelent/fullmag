//! Linking a results folder to the script or project that produced it.
//!
//! The link is derived, never stored: a result's `meta.source` (from its run
//! manifest) names the producer by path, by project id or by script digest, and
//! this module matches that against the other items of the database.

use std::path::Path;

use fullmag_workspace::{identity, Item, ItemKind, Query, Workspace, WorkspaceError};
use serde_json::Value;

const LIMIT: usize = 100_000;

fn source_of(result: &Item) -> Option<&Value> {
    result.meta.get("source").filter(|value| value.is_object())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn same_path(a: &str, b: &str) -> bool {
    match (identity(Path::new(a)), identity(Path::new(b))) {
        (Ok(a), Ok(b)) => a.key == b.key,
        _ => false,
    }
}

/// Does the manifest source of `result` name `item`?
pub fn result_belongs_to(result: &Item, item: &Item) -> bool {
    let Some(source) = source_of(result) else {
        return false;
    };
    if text(source, "kind") != Some(item.kind.as_str()) {
        return false;
    }
    if text(source, "path").is_some_and(|path| same_path(path, &item.path)) {
        return true;
    }
    match item.kind {
        ItemKind::Script => match (text(source, "sha256"), item.meta.get("sha256")) {
            (Some(sha), Some(Value::String(own))) => sha.eq_ignore_ascii_case(own),
            _ => false,
        },
        ItemKind::Project => match (text(source, "project_id"), item.project_id.as_deref()) {
            (Some(id), Some(own)) => id == own,
            _ => false,
        },
        ItemKind::Result => false,
    }
}

/// Result folders whose manifest source is `item` (a script or project),
/// newest first.
pub fn linked_results(workspace: &Workspace, item: &Item) -> Result<Vec<Item>, WorkspaceError> {
    if item.kind == ItemKind::Result {
        return Ok(Vec::new());
    }
    let mut results: Vec<Item> = workspace
        .list(&Query {
            kind: Some(ItemKind::Result),
            limit: LIMIT,
            ..Query::default()
        })?
        .into_iter()
        .filter(|result| result_belongs_to(result, item))
        .collect();
    results.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(b.id.cmp(&a.id)));
    Ok(results)
}

/// The script or project a result folder came from, when it is in the database.
pub fn linked_source(workspace: &Workspace, result: &Item) -> Result<Option<Item>, WorkspaceError> {
    let Some(source) = source_of(result) else {
        return Ok(None);
    };
    let Some(kind) = text(source, "kind").and_then(ItemKind::parse) else {
        return Ok(None);
    };
    if kind == ItemKind::Result {
        return Ok(None);
    }
    if let Some(path) = text(source, "path") {
        if let Some(found) = workspace.find(Path::new(path))? {
            if found.kind == kind && !found.forgotten {
                return Ok(Some(found));
            }
        }
    }
    let candidates = workspace.list(&Query {
        kind: Some(kind),
        limit: LIMIT,
        ..Query::default()
    })?;
    Ok(candidates
        .into_iter()
        .find(|candidate| result_belongs_to(result, candidate)))
}
