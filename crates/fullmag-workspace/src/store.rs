//! The workspace database: open, migrate, record, query.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use rusqlite::functions::FunctionFlags;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension, Row};
use serde_json::{json, Map, Value};

use crate::error::{Result, WorkspaceError};
use crate::paths::{default_database_path, identity, Identity};
use crate::timefmt::rfc3339_millis;
use crate::types::{
    Actor, Event, EventKind, Item, ItemKind, ItemRef, ItemStatus, OpenOutcome, Query, RecordEvent,
    RecordReceipt, Sort,
};

/// Schema version this build reads and writes.
pub const SCHEMA_VERSION: u32 = 1;

/// Events kept per item; the oldest are dropped first (spec section 11.2).
pub const MAX_EVENTS_PER_ITEM: usize = 500;

/// Forward-only migrations; entry `i` upgrades version `i` to `i + 1`.
const MIGRATIONS: [&str; 1] = [include_str!("../schema/v1.sql")];

/// The DDL of schema version 1, for tools that must build the same schema.
pub const SCHEMA_V1_SQL: &str = MIGRATIONS[0];

const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

pub(crate) const ITEM_COLUMNS: &str = "id, kind, path, name, project_id, first_seen_at, \
     last_used_at, use_count, pinned, forgotten, size_bytes, modified_at, status, meta";

/// Handle to the per-user database. One handle wraps one SQLite connection:
/// share the file between threads or processes by opening one handle each.
pub struct Workspace {
    pub(crate) conn: Connection,
    path: PathBuf,
    read_only: Option<(u32, u32)>,
}

impl Workspace {
    /// Open (creating, migrating or recovering as needed) the database at
    /// `path`. Damage never refuses to start: an unusable file is moved aside
    /// as `<name>.corrupt-<timestamp>` and a fresh database is created; the
    /// [`OpenOutcome`] says what happened. A database from a newer schema is
    /// opened read-only.
    pub fn open(path: impl AsRef<Path>) -> Result<(Workspace, OpenOutcome)> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let existed = std::fs::metadata(path)
            .map(|m| m.len() > 0)
            .unwrap_or(false);
        match Self::attach(path) {
            Ok(opened) => Ok(opened),
            Err(error) if existed && error.is_damage() => {
                let reason = error.to_string();
                let backup = quarantine(path)?;
                let (workspace, _) = Self::attach(path)?;
                Ok((workspace, OpenOutcome::Quarantined { backup, reason }))
            }
            Err(error) => Err(error),
        }
    }

    /// [`Self::open`] at `state_dir()/workspace.db`.
    pub fn open_default() -> Result<(Workspace, OpenOutcome)> {
        Self::open(default_database_path()?)
    }

    fn attach(path: &Path) -> Result<(Workspace, OpenOutcome)> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        register_functions(&conn)?;
        // Switching to WAL needs a brief exclusive lock that does not always
        // honour the busy handler; retry the contended case explicitly.
        retry_locked(|| {
            conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0))
                .map_err(WorkspaceError::from)
        })?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(WorkspaceError::Corrupt(format!("quick_check: {check}")));
        }

        let mut version = user_version(&conn)?;
        if version > SCHEMA_VERSION {
            conn.pragma_update(None, "query_only", true)?;
            return Ok((
                Workspace {
                    conn,
                    path: path.to_path_buf(),
                    read_only: Some((version, SCHEMA_VERSION)),
                },
                OpenOutcome::ReadOnlyNewerSchema {
                    found: version,
                    supported: SCHEMA_VERSION,
                },
            ));
        }
        let migrated_from = if version < SCHEMA_VERSION {
            let from = retry_locked(|| migrate(&conn))?;
            version = user_version(&conn)?;
            from
        } else {
            None
        };
        if version == SCHEMA_VERSION {
            let tables: i64 = conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' \
                 AND name IN ('items', 'events', 'kv')",
                [],
                |r| r.get(0),
            )?;
            if tables != 3 {
                return Err(WorkspaceError::Corrupt(
                    "schema version is current but tables are missing".into(),
                ));
            }
        }
        let outcome = match migrated_from {
            Some(0) => OpenOutcome::Created,
            Some(from) => OpenOutcome::Migrated {
                from,
                to: SCHEMA_VERSION,
            },
            None => OpenOutcome::Ready,
        };
        Ok((
            Workspace {
                conn,
                path: path.to_path_buf(),
                read_only: None,
            },
            outcome,
        ))
    }

    /// Path of the database file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `Some((found, supported))` when the file is from a newer schema and
    /// this handle refuses writes.
    pub fn read_only_reason(&self) -> Option<(u32, u32)> {
        self.read_only
    }

    pub(crate) fn ensure_writable(&self) -> Result<()> {
        match self.read_only {
            Some((found, supported)) => Err(WorkspaceError::ReadOnly { found, supported }),
            None => Ok(()),
        }
    }

    /// Run `body` inside one short `BEGIN IMMEDIATE` transaction.
    pub(crate) fn with_write_txn<T>(
        &self,
        body: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        self.ensure_writable()?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match body(&self.conn) {
            Ok(value) => {
                if let Err(error) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    // ── recording ────────────────────────────────────────────────────

    /// Record `event` now. See [`Self::record_at`].
    pub fn record(&self, event: &RecordEvent) -> Result<RecordReceipt> {
        self.record_at(event, SystemTime::now())
    }

    /// Record `event` at `at`.
    ///
    /// Creates or updates the item behind `event.path` (identity: spec 3.1),
    /// appends an event row (keeping the newest [`MAX_EVENTS_PER_ITEM`]) and
    /// merges `meta_patch` into the item's `meta`. Open, run, save, create
    /// and import count as use: they bump `use_count` and `last_used_at` and
    /// un-forget the item. Pin, unpin and forget events set the matching flag.
    pub fn record_at(&self, event: &RecordEvent, at: SystemTime) -> Result<RecordReceipt> {
        self.ensure_writable()?;
        let ident = identity(&event.path)?;
        self.record_resolved(&ident, event, at)
    }

    /// [`Self::record`] that logs and swallows every error; for call sites
    /// that must never fail because of history.
    pub fn record_best_effort(&self, event: &RecordEvent) -> bool {
        match self.record(event) {
            Ok(_) => true,
            Err(error) => {
                warn_once(&error);
                false
            }
        }
    }

    fn record_resolved(
        &self,
        ident: &Identity,
        event: &RecordEvent,
        at: SystemTime,
    ) -> Result<RecordReceipt> {
        let stamp = rfc3339_millis(at);
        let file = file_state(Path::new(&ident.path));
        let detail = match &event.detail {
            Value::Null => "{}".to_string(),
            other => serde_json::to_string(other)?,
        };
        let bump = event.event.counts_as_use();
        let name = event
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string);
        let project_id = event.project_id.clone().filter(|p| !p.is_empty());

        self.with_write_txn(|c| {
            let existing = find_existing(c, ident, event.kind, project_id.as_deref())?;
            let mut created = false;
            let mut repointed = false;
            let item_id = match existing {
                None => {
                    created = true;
                    let mut meta = Value::Object(Map::new());
                    if let Some(patch) = &event.meta_patch {
                        merge_patch(&mut meta, patch);
                    }
                    let status = if file.is_some() {
                        ItemStatus::Ready
                    } else {
                        ItemStatus::Missing
                    };
                    c.execute(
                        "INSERT INTO items (kind, path, path_key, name, project_id, \
                         first_seen_at, last_used_at, use_count, pinned, forgotten, \
                         size_bytes, modified_at, status, meta) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                        params![
                            event.kind.as_str(),
                            ident.path,
                            ident.key,
                            name.clone().unwrap_or_else(|| file_stem(&ident.path)),
                            project_id,
                            stamp,
                            i64::from(bump),
                            i64::from(event.event == EventKind::Pin),
                            i64::from(event.event == EventKind::Forget),
                            file.as_ref().map(|f| f.0),
                            file.as_ref().and_then(|f| f.1.clone()),
                            status.as_str(),
                            serde_json::to_string(&meta)?,
                        ],
                    )?;
                    c.last_insert_rowid()
                }
                Some((item, moved)) => {
                    repointed = moved;
                    let mut meta = match item.meta.clone() {
                        Value::Object(map) => Value::Object(map),
                        _ => Value::Object(Map::new()),
                    };
                    if let Some(patch) = &event.meta_patch {
                        merge_patch(&mut meta, patch);
                    }
                    let mut pinned = item.pinned;
                    let mut forgotten = item.forgotten;
                    match event.event {
                        EventKind::Pin => pinned = true,
                        EventKind::Unpin => pinned = false,
                        EventKind::Forget => {
                            forgotten = true;
                            pinned = false;
                        }
                        _ => {}
                    }
                    if bump {
                        forgotten = false;
                    }
                    let status = match (&file, item.status) {
                        (None, _) => ItemStatus::Missing,
                        (Some(_), ItemStatus::Missing) => ItemStatus::Ready,
                        (Some(_), other) => other,
                    };
                    c.execute(
                        "UPDATE items SET path = ?1, path_key = ?2, \
                         name = COALESCE(?3, name), \
                         project_id = COALESCE(?4, project_id), \
                         last_used_at = CASE WHEN ?5 THEN ?6 ELSE last_used_at END, \
                         use_count = use_count + ?5, pinned = ?7, forgotten = ?8, \
                         size_bytes = COALESCE(?9, size_bytes), \
                         modified_at = COALESCE(?10, modified_at), \
                         status = ?11, meta = ?12 WHERE id = ?13",
                        params![
                            ident.path,
                            ident.key,
                            name,
                            project_id,
                            i64::from(bump),
                            stamp,
                            i64::from(pinned),
                            i64::from(forgotten),
                            file.as_ref().map(|f| f.0),
                            file.as_ref().and_then(|f| f.1.clone()),
                            status.as_str(),
                            serde_json::to_string(&meta)?,
                            item.id,
                        ],
                    )?;
                    item.id
                }
            };
            c.execute(
                "INSERT INTO events (item_id, at, kind, actor, detail) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    item_id,
                    stamp,
                    event.event.as_str(),
                    event.actor.as_str(),
                    detail
                ],
            )?;
            trim_events(c, item_id)?;
            Ok(RecordReceipt {
                item_id,
                created,
                repointed,
            })
        })
    }

    /// Merge `patch` (RFC 7396) into an item's `meta` without recording an
    /// event or counting a use; for example to update `last_run` when a run
    /// finishes.
    pub fn patch_meta<'a>(&self, item: impl Into<ItemRef<'a>>, patch: &Value) -> Result<()> {
        let found = self.require(item.into())?;
        self.with_write_txn(|c| {
            let mut meta = match found.0.meta {
                Value::Object(map) => Value::Object(map),
                _ => Value::Object(Map::new()),
            };
            merge_patch(&mut meta, patch);
            c.execute(
                "UPDATE items SET meta = ?1 WHERE id = ?2",
                params![serde_json::to_string(&meta)?, found.0.id],
            )?;
            Ok(())
        })
    }

    /// Pin or unpin an item and record the event.
    pub fn pin<'a>(
        &self,
        item: impl Into<ItemRef<'a>>,
        pinned: bool,
        actor: Actor,
    ) -> Result<Item> {
        let kind = if pinned {
            EventKind::Pin
        } else {
            EventKind::Unpin
        };
        self.apply_flag_event(item.into(), kind, actor)
    }

    /// Remove an item from every list. The row and its events stay; using the
    /// file again brings it back.
    pub fn forget<'a>(&self, item: impl Into<ItemRef<'a>>, actor: Actor) -> Result<Item> {
        self.apply_flag_event(item.into(), EventKind::Forget, actor)
    }

    fn apply_flag_event(&self, item: ItemRef<'_>, kind: EventKind, actor: Actor) -> Result<Item> {
        self.ensure_writable()?;
        let (found, key) = self.require(item)?;
        let ident = Identity {
            path: found.path.clone(),
            key,
        };
        let event = RecordEvent::new(found.kind, found.path.clone(), kind, actor);
        let receipt = self.record_resolved(&ident, &event, SystemTime::now())?;
        self.find(ItemRef::Id(receipt.item_id))?
            .ok_or_else(|| WorkspaceError::NotFound(format!("item {}", receipt.item_id)))
    }

    /// Set the status of an item (for example `failed` or `migrate`).
    pub fn set_status<'a>(&self, item: impl Into<ItemRef<'a>>, status: ItemStatus) -> Result<()> {
        let found = self.require(item.into())?;
        self.with_write_txn(|c| {
            c.execute(
                "UPDATE items SET status = ?1 WHERE id = ?2",
                params![status.as_str(), found.0.id],
            )?;
            Ok(())
        })
    }

    /// Re-stat the file behind an item: refresh size and modified time, and
    /// flip `status` between `missing` and `ready`. Other statuses are kept
    /// while the file exists.
    pub fn refresh_file_state<'a>(&self, item: impl Into<ItemRef<'a>>) -> Result<Item> {
        let found = self.require(item.into())?;
        let file = file_state(Path::new(&found.0.path));
        let status = match (&file, found.0.status) {
            (None, _) => ItemStatus::Missing,
            (Some(_), ItemStatus::Missing) => ItemStatus::Ready,
            (Some(_), other) => other,
        };
        self.with_write_txn(|c| {
            c.execute(
                "UPDATE items SET size_bytes = COALESCE(?1, size_bytes), \
                 modified_at = COALESCE(?2, modified_at), status = ?3 WHERE id = ?4",
                params![
                    file.as_ref().map(|f| f.0),
                    file.as_ref().and_then(|f| f.1.clone()),
                    status.as_str(),
                    found.0.id
                ],
            )?;
            Ok(())
        })?;
        self.find(ItemRef::Id(found.0.id))?
            .ok_or_else(|| WorkspaceError::NotFound(format!("item {}", found.0.id)))
    }

    /// Drop all events and the per-item `last_run` / `args` memory. Pins,
    /// use counts and the item list stay.
    pub fn clear_history(&self) -> Result<()> {
        self.with_write_txn(|c| {
            c.execute("DELETE FROM events", [])?;
            c.execute(
                "UPDATE items SET meta = json_remove(meta, '$.last_run', '$.args')",
                [],
            )?;
            Ok(())
        })
    }

    // ── queries ──────────────────────────────────────────────────────

    /// The start-screen list (spec section 5): forgotten items are excluded,
    /// pinned items come first inside every sort, ties break by id.
    pub fn list(&self, query: &Query) -> Result<Vec<Item>> {
        let mut sql = format!("SELECT {ITEM_COLUMNS} FROM items WHERE forgotten = 0");
        let mut args: Vec<SqlValue> = Vec::new();
        if let Some(kind) = query.kind {
            args.push(SqlValue::Text(kind.as_str().into()));
            sql.push_str(&format!(" AND kind = ?{}", args.len()));
        }
        if !query.include_missing {
            sql.push_str(" AND status != 'missing'");
        }
        if let Some(term) = query
            .search
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            args.push(SqlValue::Text(term.to_lowercase()));
            let n = args.len();
            sql.push_str(&format!(
                " AND (instr(fm_fold(name), ?{n}) > 0 OR instr(fm_fold(path), ?{n}) > 0 \
                 OR EXISTS (SELECT 1 FROM json_each(items.meta, '$.authors') AS a WHERE \
                 instr(fm_fold(CASE a.type WHEN 'object' THEN json_extract(a.value, '$.name') \
                 WHEN 'text' THEN a.value END), ?{n}) > 0))"
            ));
        }
        sql.push_str(match query.sort {
            Sort::LastUsed => " ORDER BY pinned DESC, last_used_at DESC, id DESC",
            Sort::Name => " ORDER BY pinned DESC, fm_fold(name) ASC, id ASC",
            Sort::Modified => {
                " ORDER BY pinned DESC, (modified_at IS NULL) ASC, modified_at DESC, id DESC"
            }
            Sort::UseCount => " ORDER BY pinned DESC, use_count DESC, last_used_at DESC, id DESC",
        });
        args.push(SqlValue::Integer(query.limit.min(i64::MAX as usize) as i64));
        sql.push_str(&format!(" LIMIT ?{}", args.len()));

        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(args.iter()), item_from_row)?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    }

    /// One item by id or path, forgotten ones included.
    pub fn find<'a>(&self, item: impl Into<ItemRef<'a>>) -> Result<Option<Item>> {
        Ok(self.lookup(item.into())?.map(|(item, _)| item))
    }

    fn require(&self, item: ItemRef<'_>) -> Result<(Item, String)> {
        let label = match item {
            ItemRef::Id(id) => format!("item {id}"),
            ItemRef::Path(path) => path.display().to_string(),
        };
        self.lookup(item)?.ok_or(WorkspaceError::NotFound(label))
    }

    /// The item and its `path_key`.
    fn lookup(&self, item: ItemRef<'_>) -> Result<Option<(Item, String)>> {
        let sql = format!("SELECT {ITEM_COLUMNS}, path_key FROM items WHERE ");
        let map = |row: &Row<'_>| -> rusqlite::Result<(Item, String)> {
            Ok((item_from_row(row)?, row.get(14)?))
        };
        let found = match item {
            ItemRef::Id(id) => self
                .conn
                .query_row(&format!("{sql}id = ?1"), [id], map)
                .optional()?,
            ItemRef::Path(path) => {
                let ident = identity(path)?;
                self.conn
                    .query_row(&format!("{sql}path_key = ?1"), [&ident.key], map)
                    .optional()?
            }
        };
        Ok(found)
    }

    /// Events of an item, newest first.
    pub fn history<'a>(&self, item: impl Into<ItemRef<'a>>, limit: usize) -> Result<Vec<Event>> {
        let Some((found, _)) = self.lookup(item.into())? else {
            return Ok(Vec::new());
        };
        let mut statement = self.conn.prepare(
            "SELECT id, item_id, at, kind, actor, detail FROM events \
             WHERE item_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![found.id, limit.min(i64::MAX as usize) as i64],
            |row| {
                let kind: String = row.get(3)?;
                let actor: String = row.get(4)?;
                let detail: String = row.get(5)?;
                Ok(Event {
                    id: row.get(0)?,
                    item_id: row.get(1)?,
                    at: row.get(2)?,
                    kind: EventKind::parse(&kind).unwrap_or(EventKind::Open),
                    actor: Actor::parse(&actor).unwrap_or(Actor::Desktop),
                    detail: serde_json::from_str(&detail).unwrap_or(Value::Null),
                })
            },
        )?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row?);
        }
        Ok(events)
    }

    // ── key/value ────────────────────────────────────────────────────

    /// A personal setting (scanned roots, last sort, ...).
    pub fn get_kv(&self, key: &str) -> Result<Option<Value>> {
        let text: Option<String> = self
            .conn
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
            .optional()?;
        match text {
            Some(text) => Ok(Some(serde_json::from_str(&text)?)),
            None => Ok(None),
        }
    }

    pub fn set_kv(&self, key: &str, value: &Value) -> Result<()> {
        let text = serde_json::to_string(value)?;
        self.with_write_txn(|c| {
            c.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, text],
            )?;
            Ok(())
        })
    }

    pub fn remove_kv(&self, key: &str) -> Result<()> {
        self.with_write_txn(|c| {
            c.execute("DELETE FROM kv WHERE key = ?1", [key])?;
            Ok(())
        })
    }
}

/// Open the default database and record `event`, logging and swallowing every
/// failure (locked, damaged, newer schema, no state directory). Returns
/// whether the event was stored. Cheap enough to call from a CLI command.
pub fn record_best_effort(event: RecordEvent) -> bool {
    let result = Workspace::open_default().and_then(|(workspace, outcome)| {
        log_outcome(&outcome);
        workspace.record(&event)
    });
    match result {
        Ok(_) => true,
        Err(error) => {
            warn_once(&error);
            false
        }
    }
}

/// Print a warning for a recovery the user should know about (quarantine).
pub fn log_outcome(outcome: &OpenOutcome) {
    if let OpenOutcome::Quarantined { backup, reason } = outcome {
        eprintln!(
            "[fullmag-workspace] the workspace database was damaged ({reason}); \
             kept as {} and started a fresh one",
            backup.display()
        );
    }
}

static WARNED: AtomicBool = AtomicBool::new(false);

/// One stderr line per process; `FULLMAG_WORKSPACE_QUIET` silences it.
fn warn_once(error: &WorkspaceError) {
    if std::env::var_os("FULLMAG_WORKSPACE_QUIET").is_some() {
        return;
    }
    if !WARNED.swap(true, Ordering::Relaxed) {
        eprintln!("[fullmag-workspace] usage history not recorded: {error}");
    }
}

// ── internals ──────────────────────────────────────────────────────────

fn user_version(conn: &Connection) -> Result<u32> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    Ok(version.max(0) as u32)
}

/// Apply pending migrations in one transaction. Returns the version the
/// database had before, or `None` when another process migrated it first.
fn migrate(conn: &Connection) -> Result<Option<u32>> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| -> Result<Option<u32>> {
        let from = user_version(conn)?;
        if from >= SCHEMA_VERSION {
            return Ok(None);
        }
        for step in &MIGRATIONS[from as usize..SCHEMA_VERSION as usize] {
            conn.execute_batch(step)?;
        }
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
        Ok(Some(from))
    })();
    match outcome {
        Ok(value) => {
            if let Err(error) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error.into());
            }
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn retry_locked<T>(mut attempt: impl FnMut() -> Result<T>) -> Result<T> {
    let mut tries = 0;
    loop {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(error) => {
                tries += 1;
                if error.is_locked() && tries < 20 {
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                return Err(error);
            }
        }
    }
}

/// `fm_fold(text)`: Unicode lower-casing, shared with the Python reader so
/// sorting and searching agree across languages. Not part of the stored schema.
fn register_functions(conn: &Connection) -> Result<()> {
    conn.create_scalar_function(
        "fm_fold",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            Ok(match ctx.get_raw(0) {
                ValueRef::Text(bytes) => Some(String::from_utf8_lossy(bytes).to_lowercase()),
                _ => None,
            })
        },
    )?;
    Ok(())
}

/// Move a damaged database (and its WAL sidecars) aside; returns the new path
/// of the main file.
fn quarantine(path: &Path) -> Result<PathBuf> {
    let stamp = rfc3339_millis(SystemTime::now())
        .chars()
        .filter(char::is_ascii_digit)
        .take(14)
        .collect::<String>();
    let base = path.as_os_str().to_os_string();
    let mut suffix = 0_u32;
    let target = loop {
        let mut name = base.clone();
        name.push(format!(
            ".corrupt-{stamp}{}",
            if suffix == 0 {
                String::new()
            } else {
                format!("-{suffix}")
            }
        ));
        let candidate = PathBuf::from(name);
        if !candidate.exists() {
            break candidate;
        }
        suffix += 1;
    };
    match std::fs::rename(path, &target) {
        Ok(()) => {}
        // Another process quarantined it first; just carry on.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    for sidecar in ["-wal", "-shm"] {
        let mut from = base.clone();
        from.push(sidecar);
        let mut to = target.as_os_str().to_os_string();
        to.push(sidecar);
        let _ = std::fs::rename(PathBuf::from(from), PathBuf::from(to));
    }
    Ok(target)
}

fn file_state(path: &Path) -> Option<(i64, Option<String>)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len() as i64, meta.modified().ok().map(rfc3339_millis)))
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("untitled")
        .to_string()
}

pub(crate) fn item_from_row(row: &Row<'_>) -> rusqlite::Result<Item> {
    let kind: String = row.get(1)?;
    let status: String = row.get(12)?;
    let meta: String = row.get(13)?;
    Ok(Item {
        id: row.get(0)?,
        kind: ItemKind::parse(&kind).unwrap_or(ItemKind::Project),
        path: row.get(2)?,
        name: row.get(3)?,
        project_id: row.get(4)?,
        first_seen_at: row.get(5)?,
        last_used_at: row.get(6)?,
        use_count: row.get(7)?,
        pinned: row.get::<_, i64>(8)? != 0,
        forgotten: row.get::<_, i64>(9)? != 0,
        size_bytes: row.get(10)?,
        modified_at: row.get(11)?,
        status: ItemStatus::parse(&status).unwrap_or(ItemStatus::Ready),
        meta: serde_json::from_str(&meta).unwrap_or_else(|_| json!({})),
    })
}

/// The item for `ident`, or - for a project - the row of the same
/// `project_id` whose file has disappeared (a moved `.fms`). The second flag
/// tells the caller the row is being re-pointed. A copy of a project keeps its
/// id too, but while the original still exists it is a different item.
pub(crate) fn find_existing(
    c: &Connection,
    ident: &Identity,
    kind: ItemKind,
    project_id: Option<&str>,
) -> Result<Option<(Item, bool)>> {
    let by_key = c
        .query_row(
            &format!("SELECT {ITEM_COLUMNS} FROM items WHERE path_key = ?1"),
            [&ident.key],
            item_from_row,
        )
        .optional()?;
    if let Some(item) = by_key {
        return Ok(Some((item, false)));
    }
    if kind != ItemKind::Project {
        return Ok(None);
    }
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let mut statement = c.prepare(&format!(
        "SELECT {ITEM_COLUMNS} FROM items WHERE project_id = ?1 AND kind = 'project' \
         ORDER BY last_used_at DESC, id DESC"
    ))?;
    let rows = statement.query_map([project_id], item_from_row)?;
    for row in rows {
        let candidate = row?;
        if !Path::new(&candidate.path).exists() {
            return Ok(Some((candidate, true)));
        }
    }
    Ok(None)
}

fn trim_events(c: &Connection, item_id: i64) -> Result<()> {
    let count: i64 = c.query_row(
        "SELECT count(*) FROM events WHERE item_id = ?1",
        [item_id],
        |r| r.get(0),
    )?;
    let excess = count - MAX_EVENTS_PER_ITEM as i64;
    if excess > 0 {
        c.execute(
            "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE item_id = ?1 \
             ORDER BY at ASC, id ASC LIMIT ?2)",
            params![item_id, excess],
        )?;
    }
    Ok(())
}

/// RFC 7396 JSON merge patch: objects merge recursively, `null` deletes a
/// key, any other value replaces. Keys the patch does not mention survive.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    match patch {
        Value::Object(changes) => {
            if !target.is_object() {
                *target = Value::Object(Map::new());
            }
            let map = target.as_object_mut().expect("object just ensured");
            for (key, value) in changes {
                if value.is_null() {
                    map.remove(key);
                } else {
                    merge_patch(map.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        other => *target = other.clone(),
    }
}
