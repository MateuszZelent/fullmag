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
    ///
    /// With `SeenItem::explicit` (a person asked for this file to be added)
    /// the observation does count as a use, brings a forgotten item back and
    /// records `{"source": "add"}`.
    pub fn observe(&self, seen: &SeenItem) -> Result<RecordReceipt> {
        self.ensure_writable()?;
        let ident = identity(&seen.path)?;
        let now = rfc3339_millis(SystemTime::now());
        // A directory (a results folder) has no meaningful `len()`; the caller
        // may state size and modified time itself.
        let file = file_state(Path::new(&ident.path)).map(|(size, modified)| {
            (
                seen.size_bytes.unwrap_or(size),
                seen.modified_at.clone().or(modified),
            )
        });
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
                    let last_used = if seen.explicit {
                        now.clone()
                    } else {
                        file.as_ref()
                            .and_then(|f| f.1.clone())
                            .unwrap_or_else(|| now.clone())
                    };
                    let use_count = i64::from(seen.explicit);
                    c.execute(
                        "INSERT INTO items (kind, path, path_key, name, project_id, \
                         first_seen_at, last_used_at, use_count, pinned, forgotten, \
                         size_bytes, modified_at, status, meta) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?12, 0, 0, ?8, ?9, ?10, ?11)",
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
                            use_count,
                        ],
                    )?;
                    let item_id = c.last_insert_rowid();
                    c.execute(
                        "INSERT INTO events (item_id, at, kind, actor, detail) \
                         VALUES (?1, ?2, 'import', ?4, ?3)",
                        params![
                            item_id,
                            now,
                            serde_json::to_string(&json!({
                                "source": if seen.explicit { "add" } else { "scan" }
                            }))?,
                            seen.actor.as_str()
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
                         status = ?7, meta = ?8,                          use_count = use_count + ?10,                          last_used_at = CASE WHEN ?10 THEN ?11 ELSE last_used_at END,                          forgotten = CASE WHEN ?10 THEN 0 ELSE forgotten END                          WHERE id = ?9",
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
                            i64::from(seen.explicit),
                            now,
                        ],
                    )?;
                    if seen.explicit {
                        c.execute(
                            "INSERT INTO events (item_id, at, kind, actor, detail)                              VALUES (?1, ?2, 'import', ?3, '{\"source\":\"add\"}')",
                            params![item.id, now, seen.actor.as_str()],
                        )?;
                    }
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
