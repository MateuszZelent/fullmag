//! Recording files found by a scan, as opposed to files a person used.

use std::path::Path;
use std::time::SystemTime;

use rusqlite::params;
use serde_json::{json, Map, Value};

use crate::error::Result;
use crate::paths::identity;
use crate::store::{file_state, file_stem, find_existing, merge_patch, Workspace};
use crate::timefmt::rfc3339_millis;
use crate::types::{ItemStatus, RecordReceipt, SeenItem};

impl Workspace {
    /// Upsert the item behind a scanned file without counting a use.
    ///
    /// A new item starts with `use_count = 0`, `last_used_at` set to the file's
    /// modification time (so a freshly scanned folder does not look "just
    /// used") and an `import` event with `{"source": "scan"}`. For an existing
    /// item only what a scan can know changes: name, project id, size, modified
    /// time, `status` and `meta` (by merge patch). Counters, pin, forgotten
    /// flag and `last_used_at` stay, so a scan never resurrects a forgotten
    /// item. A project whose old path has vanished is re-pointed by its
    /// `project_id`, as in [`Workspace::record`].
    pub fn observe(&self, seen: &SeenItem) -> Result<RecordReceipt> {
        self.ensure_writable()?;
        let ident = identity(&seen.path)?;
        let now = rfc3339_millis(SystemTime::now());
        let file = file_state(Path::new(&ident.path));
        let status = match (&file, seen.status) {
            (None, _) => ItemStatus::Missing,
            (Some(_), ItemStatus::Missing) => ItemStatus::Ready,
            (Some(_), other) => other,
        };
        let name = seen
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string);
        let project_id = seen.project_id.clone().filter(|p| !p.is_empty());

        self.with_write_txn(
            |c| match find_existing(c, &ident, seen.kind, project_id.as_deref())? {
                None => {
                    let mut meta = Value::Object(Map::new());
                    if let Some(patch) = &seen.meta_patch {
                        merge_patch(&mut meta, patch);
                    }
                    let last_used = file
                        .as_ref()
                        .and_then(|f| f.1.clone())
                        .unwrap_or_else(|| now.clone());
                    c.execute(
                        "INSERT INTO items (kind, path, path_key, name, project_id, \
                         first_seen_at, last_used_at, use_count, pinned, forgotten, \
                         size_bytes, modified_at, status, meta) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, ?8, ?9, ?10, ?11)",
                        params![
                            seen.kind.as_str(),
                            ident.path,
                            ident.key,
                            name.unwrap_or_else(|| file_stem(&ident.path)),
                            project_id,
                            now,
                            last_used,
                            file.as_ref().map(|f| f.0),
                            file.as_ref().and_then(|f| f.1.clone()),
                            status.as_str(),
                            serde_json::to_string(&meta)?,
                        ],
                    )?;
                    let item_id = c.last_insert_rowid();
                    c.execute(
                        "INSERT INTO events (item_id, at, kind, actor, detail) \
                         VALUES (?1, ?2, 'import', 'desktop', ?3)",
                        params![
                            item_id,
                            now,
                            serde_json::to_string(&json!({ "source": "scan" }))?
                        ],
                    )?;
                    Ok(RecordReceipt {
                        item_id,
                        created: true,
                        repointed: false,
                    })
                }
                Some((item, moved)) => {
                    let mut meta = match item.meta.clone() {
                        Value::Object(map) => Value::Object(map),
                        _ => Value::Object(Map::new()),
                    };
                    if let Some(patch) = &seen.meta_patch {
                        merge_patch(&mut meta, patch);
                    }
                    c.execute(
                        "UPDATE items SET path = ?1, path_key = ?2, \
                         name = COALESCE(?3, name), \
                         project_id = COALESCE(?4, project_id), \
                         size_bytes = COALESCE(?5, size_bytes), \
                         modified_at = COALESCE(?6, modified_at), \
                         status = ?7, meta = ?8 WHERE id = ?9",
                        params![
                            ident.path,
                            ident.key,
                            name,
                            project_id,
                            file.as_ref().map(|f| f.0),
                            file.as_ref().and_then(|f| f.1.clone()),
                            status.as_str(),
                            serde_json::to_string(&meta)?,
                            item.id,
                        ],
                    )?;
                    Ok(RecordReceipt {
                        item_id: item.id,
                        created: false,
                        repointed: moved,
                    })
                }
            },
        )
    }
}
