//! Finding projects, scripts and results folders and keeping the workspace
//! database in step with them.
//!
//! The scanner only reads: it lists directories, `stat`s files and reads the
//! first bytes of a `.py` to see whether it imports `fullmag`. It never
//! executes, imports or follows a symbolic link, and it stops at documented
//! limits (depth, entries, time) instead of walking a whole disk.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use fullmag_workspace::{
    identity, script_meta_from_text, Actor, Item, ItemKind, ItemStatus, Query, RecordReceipt,
    SeenItem, Workspace, WorkspaceError, WorkspaceRoot,
};
use serde_json::{json, Map, Value};

use crate::project::{scan_archive, sha256_hex};
use crate::result_detail::{display_path, inspect_result, is_result_dir};

/// Directories never entered: environments, dependencies and build output.
pub const SKIPPED_DIRECTORIES: [&str; 8] = [
    ".venv",
    "venv",
    "site-packages",
    "node_modules",
    ".git",
    "__pycache__",
    "target",
    "dist",
];

/// A `.py` larger than this is not looked at by the scanner.
pub const MAX_SCANNED_SCRIPT_BYTES: u64 = 4 * 1024 * 1024;

/// Limits of one scan.
#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// Directory levels below a root (the root is level 0).
    pub max_depth: usize,
    /// Directory entries examined over the whole scan.
    pub max_entries: usize,
    pub time_budget: Duration,
    /// Bytes read from the start of a `.py` to look for the import.
    pub head_bytes: u64,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            max_depth: 8,
            max_entries: 20_000,
            time_budget: Duration::from_secs(8),
            head_bytes: 64 * 1024,
        }
    }
}

/// What a scan did. `scanned` counts directory entries examined.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub scanned: u64,
    pub added: u64,
    pub updated: u64,
    /// Items whose file was found gone.
    pub missing: u64,
    /// Entries left alone: links, skipped directories, `.py` without the import.
    pub skipped: u64,
    pub warnings: Vec<String>,
}

/// A file or folder understood well enough to store.
#[derive(Debug, Clone)]
pub struct Described {
    pub kind: ItemKind,
    pub path: PathBuf,
    pub name: String,
    pub project_id: Option<String>,
    pub status: ItemStatus,
    /// Merge patch for the item's `meta`.
    pub meta: Value,
    /// Stored preview of a project.
    pub thumbnail: Option<Vec<u8>>,
    pub size_bytes: Option<i64>,
    pub modified_at: Option<String>,
}

/// Read `path` as an item of `kind` (never fails; a damaged file is `failed`).
pub fn describe(path: &Path, kind: ItemKind) -> Described {
    match kind {
        ItemKind::Project => {
            let scanned = scan_archive(path);
            Described {
                kind,
                path: scanned.path,
                name: scanned.name,
                project_id: scanned.project_id,
                status: scanned.status,
                meta: scanned.meta,
                thumbnail: scanned.thumbnail,
                size_bytes: None,
                modified_at: None,
            }
        }
        ItemKind::Script => {
            let mut meta = fullmag_workspace::script_meta(path).unwrap_or_else(|_| json!({}));
            // Line count and digest belong to `observe_file`, which tracks edits.
            if let Some(map) = meta.as_object_mut() {
                map.remove("lines");
                // A merge patch only clears a stale key when it says `null`.
                for key in ["summary", "truncated"] {
                    map.entry(key).or_insert(Value::Null);
                }
            }
            Described {
                kind,
                path: path.to_path_buf(),
                name: stem(path),
                project_id: None,
                status: ItemStatus::Ready,
                meta,
                thumbnail: None,
                size_bytes: None,
                modified_at: None,
            }
        }
        ItemKind::Result => {
            let detail = inspect_result(path);
            let mut meta = Map::new();
            meta.insert(
                "source".into(),
                detail
                    .source
                    .as_ref()
                    .map(|source| {
                        json!({
                            "kind": source.kind,
                            "path": source.path,
                            "sha256": source.sha256,
                            "project_id": source.project_id,
                        })
                    })
                    .unwrap_or(Value::Null),
            );
            meta.insert("run_id".into(), json!(detail.run_id));
            meta.insert("status".into(), json!(detail.status));
            meta.insert("started_at".into(), json!(detail.started_at));
            meta.insert("finished_at".into(), json!(detail.finished_at));
            meta.insert("format".into(), json!(detail.format));
            meta.insert("frames".into(), json!(detail.frames));
            meta.insert("stages".into(), json!(detail.stages.len()));
            meta.insert("has_manifest".into(), json!(detail.has_manifest));
            Described {
                kind,
                path: path.to_path_buf(),
                name: stem(path),
                project_id: None,
                status: if detail.read_error.is_some() && !detail.has_manifest {
                    ItemStatus::Failed
                } else {
                    ItemStatus::Ready
                },
                meta: Value::Object(meta),
                thumbnail: None,
                size_bytes: detail.total_bytes.map(|bytes| bytes.min(i64::MAX as u64) as i64),
                modified_at: detail.modified_at,
            }
        }
    }
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("untitled")
        .to_string()
}

/// Upsert what a scan found, without counting a use. For scripts the content
/// digest is observed afterwards so an edit is recorded once.
pub fn store_observed(
    workspace: &Workspace,
    described: &Described,
    actor: Actor,
    explicit: bool,
) -> Result<RecordReceipt, WorkspaceError> {
    let mut seen = SeenItem::new(described.kind, &described.path);
    seen.name = Some(described.name.clone());
    seen.project_id = described.project_id.clone();
    seen.status = described.status;
    seen.meta_patch = Some(described.meta.clone());
    seen.actor = actor;
    seen.size_bytes = described.size_bytes;
    seen.modified_at = described.modified_at.clone();
    seen.explicit = explicit;
    let receipt = workspace.observe(&seen)?;
    match &described.thumbnail {
        Some(png) => workspace.set_thumbnail(receipt.item_id, &sha256_hex(png), png)?,
        None if described.kind == ItemKind::Project => {
            if workspace.get_thumbnail(receipt.item_id)?.is_some() {
                workspace.remove_thumbnail(receipt.item_id)?;
            }
        }
        None => {}
    }
    if described.kind == ItemKind::Script {
        // A script that cannot be read keeps its row; the digest comes next time.
        let _ = workspace.observe_file(receipt.item_id, actor);
    }
    Ok(receipt)
}

/// Why `path` cannot be added as an item, or the kind it would have.
///
/// The path must be absolute, free of `..`, exist, and not itself be a
/// symbolic link or reparse point. A file is a project (`.fms`) or a script
/// (`.py`); a directory is a result when it is a recognised results folder.
pub fn classify_path(path: &Path, requested: Option<ItemKind>) -> Result<ItemKind, String> {
    if !path.is_absolute() {
        return Err("the path must be absolute".into());
    }
    if path.components().any(|part| part == Component::ParentDir) {
        return Err("the path must not contain `..`".into());
    }
    let meta = std::fs::symlink_metadata(path)
        .map_err(|error| format!("cannot read {}: {error}", display_path(&path.display().to_string())))?;
    if meta.file_type().is_symlink() {
        return Err("the path is a symbolic link or junction; add its target instead".into());
    }
    let found = if meta.is_dir() {
        if !is_result_dir(path) {
            return Err("the folder is not a recognised Fullmag results folder".into());
        }
        ItemKind::Result
    } else if meta.is_file() {
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        match extension.as_str() {
            "fms" => ItemKind::Project,
            "py" => ItemKind::Script,
            _ => return Err("only .fms projects, .py scripts and results folders can be added".into()),
        }
    } else {
        return Err("the path is neither a file nor a folder".into());
    };
    match requested {
        Some(requested) if requested != found => Err(format!(
            "the path is a {}, not a {}",
            found.as_str(),
            requested.as_str()
        )),
        _ => Ok(found),
    }
}

/// Scan `roots` and upsert what is found. Roots that are disabled, relative
/// or unreachable are skipped with a warning. Never executes anything.
pub fn scan_roots(
    workspace: &Workspace,
    roots: &[WorkspaceRoot],
    options: &ScanOptions,
    actor: Actor,
) -> ScanReport {
    let mut report = ScanReport::default();
    let started = Instant::now();
    let mut seen_keys: HashSet<String> = HashSet::new();
    let mut stopped = false;
    for root in roots.iter().filter(|root| root.enabled) {
        if stopped {
            break;
        }
        let path = PathBuf::from(&root.path);
        if !path.is_absolute() {
            report
                .warnings
                .push(format!("root {} skipped: the path must be absolute", root.path));
            continue;
        }
        if !path.is_dir() {
            report
                .warnings
                .push(format!("root {} skipped: not a reachable folder", root.path));
            continue;
        }
        let wanted = |kind: ItemKind| root.kinds.is_empty() || root.kinds.contains(&kind);
        let mut pending = vec![(path.clone(), 0_usize)];
        while let Some((dir, depth)) = pending.pop() {
            if wanted(ItemKind::Result) && is_result_dir(&dir) {
                upsert(workspace, &dir, ItemKind::Result, actor, &mut report, &mut seen_keys);
                continue;
            }
            let Ok(read) = std::fs::read_dir(&dir) else {
                report.skipped += 1;
                continue;
            };
            for entry in read.flatten() {
                report.scanned += 1;
                if report.scanned as usize > options.max_entries {
                    report.warnings.push(format!(
                        "scan stopped after {} entries; narrow the roots or raise the limit",
                        options.max_entries
                    ));
                    stopped = true;
                    break;
                }
                if started.elapsed() > options.time_budget {
                    report.warnings.push(format!(
                        "scan stopped after {:.0} s; run it again to continue",
                        options.time_budget.as_secs_f64()
                    ));
                    stopped = true;
                    break;
                }
                let Ok(file_type) = entry.file_type() else {
                    report.skipped += 1;
                    continue;
                };
                if file_type.is_symlink() {
                    report.skipped += 1;
                    continue;
                }
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if file_type.is_dir() {
                    if SKIPPED_DIRECTORIES.contains(&name.as_str()) {
                        report.skipped += 1;
                    } else if root.recursive && depth < options.max_depth {
                        pending.push((path, depth + 1));
                    } else {
                        report.skipped += 1;
                    }
                } else if file_type.is_file() {
                    if name.ends_with(".fms") && wanted(ItemKind::Project) {
                        upsert(workspace, &path, ItemKind::Project, actor, &mut report, &mut seen_keys);
                    } else if name.ends_with(".py") && wanted(ItemKind::Script) {
                        if imports_fullmag(&path, options.head_bytes) {
                            upsert(workspace, &path, ItemKind::Script, actor, &mut report, &mut seen_keys);
                        } else {
                            report.skipped += 1;
                        }
                    }
                }
            }
            if stopped {
                break;
            }
        }
    }
    if !stopped {
        report.missing += mark_missing(workspace, roots, &seen_keys, &mut report.warnings);
    }
    report
}

fn upsert(
    workspace: &Workspace,
    path: &Path,
    kind: ItemKind,
    actor: Actor,
    report: &mut ScanReport,
    seen_keys: &mut HashSet<String>,
) {
    if let Ok(ident) = identity(path) {
        seen_keys.insert(ident.key);
    }
    match store_observed(workspace, &describe(path, kind), actor, false) {
        Ok(receipt) if receipt.created => report.added += 1,
        Ok(_) => report.updated += 1,
        Err(error) => report
            .warnings
            .push(format!("{} not stored: {error}", display_path(&path.display().to_string()))),
    }
}

/// Items under an enabled root whose file is gone: flagged `missing` by a
/// re-stat. Returns how many were newly found missing.
fn mark_missing(
    workspace: &Workspace,
    roots: &[WorkspaceRoot],
    seen_keys: &HashSet<String>,
    warnings: &mut Vec<String>,
) -> u64 {
    let prefixes: Vec<String> = roots
        .iter()
        .filter(|root| root.enabled)
        .filter_map(|root| identity(Path::new(&root.path)).ok())
        .map(|ident| normalise_for_prefix(&ident.key))
        .collect();
    if prefixes.is_empty() {
        return 0;
    }
    let query = Query {
        kind: None,
        limit: 100_000,
        include_missing: true,
        include_results: true,
        ..Query::default()
    };
    let items = match workspace.list(&query) {
        Ok(items) => items,
        Err(error) => {
            warnings.push(format!("missing files not checked: {error}"));
            return 0;
        }
    };
    let mut newly_missing = 0;
    for item in items {
        let Ok(ident) = identity(Path::new(&item.path)) else {
            continue;
        };
        if seen_keys.contains(&ident.key) || item.status == ItemStatus::Missing {
            continue;
        }
        let key = normalise_for_prefix(&ident.key);
        if !prefixes.iter().any(|prefix| key.starts_with(prefix.as_str())) {
            continue;
        }
        if !Path::new(&item.path).exists() {
            if let Ok(updated) = workspace.refresh_file_state_as(item.id, Actor::Web) {
                if updated.status == ItemStatus::Missing {
                    newly_missing += 1;
                }
            }
        }
    }
    newly_missing
}

/// `a\b` and `a/b` compare equal, and `a` is a prefix of `a/b` but not of `ab`.
fn normalise_for_prefix(key: &str) -> String {
    let mut text = key.replace('\\', "/");
    if !text.ends_with('/') {
        text.push('/');
    }
    text
}

/// Does the first `head_bytes` of `path` contain an `import fullmag` or
/// `from fullmag ...` line? Files over [`MAX_SCANNED_SCRIPT_BYTES`] are not
/// considered.
pub fn imports_fullmag(path: &Path, head_bytes: u64) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() > MAX_SCANNED_SCRIPT_BYTES {
        return false;
    }
    let mut head = Vec::new();
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    if file.take(head_bytes).read_to_end(&mut head).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&head);
    script_meta_from_text(&text)
        .get("uses_fullmag")
        .and_then(Value::as_bool)
        == Some(true)
}

/// The same files as [`Item`]s of a kind, for tests and callers that need a
/// stable listing.
pub fn items_of(workspace: &Workspace, kind: ItemKind) -> Vec<Item> {
    workspace
        .list(&Query {
            kind: Some(kind),
            limit: 100_000,
            ..Query::default()
        })
        .unwrap_or_default()
}
