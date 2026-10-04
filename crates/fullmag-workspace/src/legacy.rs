//! One-time import of the start screen's `recent-index.json` (spec section 7).

use std::path::Path;
use std::time::SystemTime;

use rusqlite::params;
use serde_json::{json, Map, Value};

use crate::error::{Result, WorkspaceError};
use crate::paths::identity;
use crate::store::{find_existing, merge_patch, Workspace};
use crate::timefmt::{parse_rfc3339, rfc3339_millis};
use crate::types::{ItemKind, ItemStatus, LegacyImportReport};

/// `kv` key that records the import; set in the same transaction as the rows.
pub const LEGACY_IMPORT_MARKER: &str = "legacy_recent_index_imported";

const LEGACY_FORMAT_VERSION: u64 = 1;

impl Workspace {
    /// Import the entries of a legacy `recent-index.json` once.
    ///
    /// Pins, tags, last-opened time, thumbnail reference, solver, authors and
    /// revision are carried over; a project whose file is gone is imported as
    /// `missing`. Entries already known to the database keep their own counters
    /// and values and only gain what they lack (a pin is never lost). The
    /// legacy file is not modified. Idempotent through the `kv` marker
    /// [`LEGACY_IMPORT_MARKER`]; a missing file does nothing and sets no marker.
    pub fn import_legacy_recent_index(&self, json_path: &Path) -> Result<LegacyImportReport> {
        self.ensure_writable()?;
        if self.get_kv(LEGACY_IMPORT_MARKER)?.is_some() {
            return Ok(LegacyImportReport {
                already_imported: true,
                ..Default::default()
            });
        }
        let text = match std::fs::read_to_string(json_path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LegacyImportReport {
                    file_missing: true,
                    ..Default::default()
                });
            }
            Err(error) => return Err(error.into()),
        };
        let document: Value = serde_json::from_str(&text).map_err(|error| {
            WorkspaceError::Invalid(format!("legacy recent index is not valid JSON ({error})"))
        })?;
        if document.get("format_version").and_then(Value::as_u64) != Some(LEGACY_FORMAT_VERSION) {
            return Err(WorkspaceError::Invalid(format!(
                "legacy recent index has an unsupported format; expected {LEGACY_FORMAT_VERSION}"
            )));
        }
        let entries = document
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| WorkspaceError::Invalid("legacy recent index has no entries".into()))?;

        let now = rfc3339_millis(SystemTime::now());
        let source = json_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("recent-index.json")
            .to_string();

        self.with_write_txn(|c| {
            // Another process may have imported while this one was reading.
            let marked: Option<String> = c
                .query_row(
                    "SELECT value FROM kv WHERE key = ?1",
                    [LEGACY_IMPORT_MARKER],
                    |r| r.get(0),
                )
                .ok();
            if marked.is_some() {
                return Ok(LegacyImportReport {
                    already_imported: true,
                    ..Default::default()
                });
            }
            let mut report = LegacyImportReport::default();
            for entry in entries {
                let Some(legacy) = LegacyEntry::from_value(entry) else {
                    report.skipped += 1;
                    continue;
                };
                let Ok(ident) = identity(Path::new(&legacy.path)) else {
                    report.skipped += 1;
                    continue;
                };
                let on_disk = std::fs::metadata(&ident.path).ok();
                let status = match (&on_disk, legacy.status) {
                    (None, _) => ItemStatus::Missing,
                    (Some(_), ItemStatus::Missing) => ItemStatus::Ready,
                    (Some(_), other) => other,
                };
                let last_used = legacy.last_opened_at.clone().unwrap_or_else(|| now.clone());
                let first_seen = legacy
                    .created_at
                    .clone()
                    .unwrap_or_else(|| last_used.clone());
                let size = legacy
                    .size_bytes
                    .or_else(|| on_disk.as_ref().map(|m| m.len() as i64));
                let modified = legacy.modified_at.clone();

                let item_id = match find_existing(
                    c,
                    &ident,
                    ItemKind::Project,
                    legacy.project_id.as_deref(),
                )? {
                    None => {
                        c.execute(
                            "INSERT INTO items (kind, path, path_key, name, project_id, \
                             first_seen_at, last_used_at, use_count, pinned, forgotten, \
                             size_bytes, modified_at, status, meta) \
                             VALUES ('project', ?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 0, ?8, ?9, ?10, ?11)",
                            params![
                                ident.path,
                                ident.key,
                                legacy.name,
                                legacy.project_id,
                                first_seen,
                                last_used,
                                i64::from(legacy.pinned),
                                size,
                                modified,
                                status.as_str(),
                                serde_json::to_string(&legacy.meta)?,
                            ],
                        )?;
                        c.last_insert_rowid()
                    }
                    Some((existing, _)) => {
                        // What the database already knows wins over the old index.
                        let mut meta = legacy.meta.clone();
                        merge_patch(&mut meta, &existing.meta);
                        let pinned = existing.pinned || legacy.pinned;
                        let last = if existing.last_used_at.as_str() >= last_used.as_str() {
                            existing.last_used_at.clone()
                        } else {
                            last_used.clone()
                        };
                        let first = if existing.first_seen_at.as_str() <= first_seen.as_str() {
                            existing.first_seen_at.clone()
                        } else {
                            first_seen.clone()
                        };
                        c.execute(
                            "UPDATE items SET project_id = COALESCE(project_id, ?1), \
                             first_seen_at = ?2, last_used_at = ?3, pinned = ?4, \
                             size_bytes = COALESCE(size_bytes, ?5), \
                             modified_at = COALESCE(modified_at, ?6), meta = ?7 WHERE id = ?8",
                            params![
                                legacy.project_id,
                                first,
                                last,
                                i64::from(pinned),
                                size,
                                modified,
                                serde_json::to_string(&meta)?,
                                existing.id,
                            ],
                        )?;
                        existing.id
                    }
                };
                c.execute(
                    "INSERT INTO events (item_id, at, kind, actor, detail) \
                     VALUES (?1, ?2, 'import', 'desktop', ?3)",
                    params![
                        item_id,
                        now,
                        serde_json::to_string(&json!({ "source": "recent-index" }))?
                    ],
                )?;
                report.imported += 1;
            }
            c.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2)",
                params![
                    LEGACY_IMPORT_MARKER,
                    serde_json::to_string(&json!({
                        "at": now,
                        "source": source,
                        "imported": report.imported,
                        "skipped": report.skipped,
                    }))?
                ],
            )?;
            Ok(report)
        })
    }
}

/// The fields of a legacy entry that map onto the database.
struct LegacyEntry {
    path: String,
    name: String,
    project_id: Option<String>,
    status: ItemStatus,
    pinned: bool,
    last_opened_at: Option<String>,
    created_at: Option<String>,
    modified_at: Option<String>,
    size_bytes: Option<i64>,
    meta: Value,
}

impl LegacyEntry {
    fn from_value(entry: &Value) -> Option<Self> {
        let path = entry.get("path")?.as_str()?.to_string();
        if !Path::new(&path).is_absolute() {
            return None;
        }
        let text = |key: &str| entry.get(key).and_then(Value::as_str);
        let name = text("name")
            .filter(|n| !n.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                Path::new(&path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("project")
                    .to_string()
            });
        // Normalise to the database timestamp form so ordering stays textual.
        let stamp = |key: &str| text(key).and_then(parse_rfc3339).map(rfc3339_millis);
        let status = match text("status") {
            Some("failed") => ItemStatus::Failed,
            Some("migrate") => ItemStatus::Migrate,
            Some("missing") => ItemStatus::Missing,
            Some("readonly") => ItemStatus::Readonly,
            // `running` and `draft` are transient states of the old index.
            _ => ItemStatus::Ready,
        };

        let mut meta = Map::new();
        if let Some(solver) = text("solver") {
            meta.insert("solver".into(), Value::String(solver.to_lowercase()));
        }
        if let Some(version) = text("manifest_schema_version") {
            meta.insert("schema_version".into(), Value::String(version.into()));
        }
        for (from, to) in [
            ("revision", "revision"),
            ("thumbnail", "thumbnail_ref"),
            ("authors", "authors"),
            ("tags", "tags"),
            ("mode", "mode"),
            ("mode_reason", "mode_reason"),
            ("last_error", "last_error"),
            ("created_with_version", "created_with_version"),
        ] {
            if let Some(value) = entry.get(from).filter(|v| !v.is_null()) {
                meta.insert(to.into(), value.clone());
            }
        }

        Some(Self {
            path,
            name,
            project_id: text("project_id").map(str::to_string),
            status,
            pinned: entry
                .get("pinned")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            last_opened_at: stamp("last_opened_at"),
            created_at: stamp("created_at"),
            modified_at: stamp("modified_at"),
            size_bytes: entry.get("size_bytes").and_then(Value::as_i64),
            meta: Value::Object(meta),
        })
    }
}
