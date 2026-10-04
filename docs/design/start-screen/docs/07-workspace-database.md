# Workspace database

One per-user database that records what a person has opened, saved and run with
Fullmag — projects (`.fms`) and Python scripts (`.py`) alike. It replaces the
single-purpose `recent-index.json` of the start screen and is shared by every
Fullmag front end on the machine: the desktop application, the CLI and, read
and write, Python.

Status: **specification** (2026-10-04), **store layer implemented** (same
day). Implemented: the Rust crate `crates/fullmag-workspace` (schema, state
directory, identity, record/list/pin/forget/status/kv/history, quarantine,
read-only newer schema, legacy import, script metadata), the Python reader
and writer `fullmag.workspace`, and best-effort CLI recording. **Not
implemented:** the desktop host wrappers and commands (section 8) and the
start-screen changes (section 9); the gates of section 10 are covered at
the store level only (section 12). Sections below carry their own
*Implemented* / *Not implemented* notes.

---

## 1. Why a database, and why SQLite

The recent list started as a JSON file derived from a folder scan. Three needs
outgrew it:

- **Scripts.** Many people work from a `.py` file and never create an `.fms`.
  Their recent work must be on the start screen too.
- **Several writers.** The desktop application, `fullmag run script.py` and a
  Python session all touch the same history. A rename-over JSON file loses
  writes between processes.
- **Queries.** Sorting by last used, name, modified time or use count, a kind
  filter and search should be a query, not a client-side pass over a blob.

The store is **SQLite** in WAL mode, one file. It is file-based and needs no
server like the NoSQL file stores that were considered, but it is also
transactional, safe for concurrent processes, queryable, and **readable from
Python with the standard library** (`sqlite3`) without any Fullmag extension.
Flexible per-kind fields live in a JSON column, so the schema does not need a
migration for every new attribute.

Rejected: a JSON/JSONL file (no concurrency, no queries), an embedded
key-value store such as `sled` or `redb` (no cross-language reader, hand-built
indexes), a server (a daemon for a history list is the wrong weight).

---

## 2. Location and ownership

One file per OS user, `workspace.db`, in the Fullmag state directory:

| Platform | Default directory |
|---|---|
| Windows | `%APPDATA%\Fullmag` |
| macOS | `~/Library/Application Support/Fullmag` |
| Linux | `$XDG_DATA_HOME/fullmag`, else `~/.local/share/fullmag` |

`FULLMAG_STATE_DIR`, when set, replaces the default (tests, portable
installs, CI). The directory is resolved by one function in the Rust crate and
mirrored in Python; the desktop host does **not** use Tauri's per-bundle
`app_data_dir` for this file, otherwise the CLI and the app would see different
histories.

The database is **derived and personal**: it holds paths and usage metadata,
never project content, results or credentials, and it is never uploaded.
Deleting it loses history and pins only; projects and scripts are untouched.
It is not part of `storage/` (builds, runs, caches) governed by
`FULLMAG_PROJECT_STORAGE_ROOT`.

---

## 3. Schema (version 1)

`PRAGMA user_version` carries the schema version. Migrations are forward-only,
run inside one transaction on open, and refuse to open a database from a newer
version (read-only fallback with a visible reason).

```sql
CREATE TABLE items (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('project','script')),
  path            TEXT NOT NULL,          -- as last seen, absolute
  path_key        TEXT NOT NULL UNIQUE,   -- normalised identity, see 3.1
  name            TEXT NOT NULL,          -- file stem, or project name
  project_id      TEXT,                   -- .fms only: stable project id
  first_seen_at   TEXT NOT NULL,          -- RFC 3339 UTC
  last_used_at    TEXT NOT NULL,
  use_count       INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  forgotten       INTEGER NOT NULL DEFAULT 0,  -- removed from lists, row kept
  size_bytes      INTEGER,
  modified_at     TEXT,                   -- file mtime when last seen
  status          TEXT NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('ready','missing','failed','migrate','readonly')),
  meta            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta))
);
CREATE INDEX items_recent ON items (forgotten, kind, last_used_at DESC);
CREATE INDEX items_project_id ON items (project_id) WHERE project_id IS NOT NULL;

CREATE TABLE events (
  id        INTEGER PRIMARY KEY,
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN
            ('open','save','run','create','import','pin','unpin','forget')),
  actor     TEXT NOT NULL CHECK (actor IN ('desktop','cli','python','web')),
  detail    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
);
CREATE INDEX events_item ON events (item_id, at DESC);

CREATE TABLE kv (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL CHECK (json_valid(value))
);
```

`kv` holds small settings that belong to the person, not to a project: scanned
project roots, the sort and filter last chosen on the start screen, the
author identity override.

### 3.1 Identity

*Implemented* (Rust `identity()`, mirrored in Python): the path is made
absolute and lexically normalised, its longest existing prefix is canonicalised
(so a missing file keeps a stable identity), the Windows verbatim prefix is
stripped, and the key is lower-cased on Windows and macOS. A moved project is
re-pointed only while the old path no longer exists; a copy that keeps the
`project_id` next to its original is a separate item.

A file is the same item when its `path_key` matches: the canonical absolute
path (symlinks resolved when the file exists), with a case-folded drive and
path on Windows and macOS. A moved project is found again by `project_id`
(for `.fms`), which re-points `path` instead of creating a second item. Scripts
have no stable id; a moved script is a new item and the old one becomes
`missing`.

### 3.2 `meta` by kind

- **project**: `solver` (`fdm`|`fem`), `schema_version`, `revision`,
  `thumbnail_ref`, `authors`, `last_run` `{run_id,status,at}`. These mirror what
  the recent index carries today.
- **script**: `lines`, `summary` (first docstring line), `uses_fullmag`
  (imports `fullmag`), `last_run` `{status,at,duration_seconds,device}`,
  `args` (last CLI arguments, never environment values).

Fields not understood by a reader are preserved on write: `record` applies
`meta_patch` as a JSON merge patch (RFC 7396; objects merge, `null` removes a
key), so a writer only mentions what it changes.

*Implemented* in Rust and Python. Timestamps are written as
`YYYY-MM-DDTHH:MM:SS.mmmZ` (millisecond precision, always `Z`) so that textual
order is chronological order; the legacy index's whole-second stamps are
normalised on import. `meta.args` is written only by the CLI, with the value of
secret-looking options redacted (`fullmag_workspace::redact_args`); a
`clear_history()` call drops all events and `meta.last_run` / `meta.args`.

---

## 4. What records an event

| Source | Event | Notes |
|---|---|---|
| Desktop: open project / script | `open` | also bumps `use_count` and `last_used_at` |
| Desktop: save project | `save` | revision in `detail` |
| Desktop: run outcome | `run` | status, duration, device; updates `meta.last_run` |
| Desktop: create from template, import | `create`, `import` | |
| CLI: `fullmag run <script.py>`, `fullmag open <file>` | `run`, `open` | `actor: cli` |
| Python: `fullmag.workspace.record(...)` | any | `actor: python`; best effort, never raises into user code |
| Start screen: pin, forget | `pin`, `unpin`, `forget` | |

Recording never blocks or fails the action it describes: a locked or damaged
database is logged and skipped.

*Implemented:* the CLI rows (`fullmag script.py` records `run` with
`meta.last_run` `started`, updated to `ok` or `failed` with the duration when
the command returns; `fullmag project open` and `fullmag session open` record
`open`) and the Python row. A run that is killed before it returns keeps
`last_run.status = "started"`. *Not implemented:* the Desktop and Start-screen
rows. Use events (`open`, `run`, `save`, `create`, `import`) bump `use_count`
and `last_used_at` and bring a forgotten item back; `pin`, `unpin` and `forget`
only set their flag.

---

## 5. Queries the start screen needs

```
recent(kind: all|project|script, sort, search, limit, include_missing)
  sort: last_used (default) | name | modified | use_count
```

- Pinned items come first inside every sort, as in the project list today.
- `search` matches name, path and, for projects, authors (case-insensitive
  substring over those columns).
- `missing` items stay visible but flagged; `forgotten` items are excluded.
- Ties break by id (descending for `last_used`, `modified` and `use_count`,
  ascending for `name`). `name` sorts and `search` matches by Unicode
  lower-casing (`fm_fold`, a function both the Rust and the Python reader
  register on their connection; it is not part of the stored schema, so a plain
  `sqlite3` shell cannot reproduce that ordering).
- `limit` defaults to 200; the list virtualises above 40 rows (unchanged).

*Implemented:* `Workspace::list(&Query)` and `fullmag.workspace.recent(...)`.

---

## 6. Concurrency, durability, damage

- `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`,
  `synchronous=NORMAL` (the content is derived; losing the last transaction on
  power loss is acceptable and the project files themselves are written with
  their own durability contract).
- Every write is a short transaction; no long-lived handle is held by the UI.
- **Damage:** if the file fails `PRAGMA quick_check` or cannot be opened, it is
  renamed to `workspace.db.corrupt-<timestamp>`, a fresh database is created,
  and the start screen rebuilds projects from its roots. The previous file is
  kept for the user. The application never refuses to start because of this
  database. *Implemented in Rust* (`Workspace::open` reports it as
  `OpenOutcome::Quarantined`); the Python module never quarantines: it returns
  `False` from `record` and raises `WorkspaceError` from `recent`, leaving the
  repair to the Rust host. A file that is merely *locked* is never quarantined.
- **Newer schema:** opened read-only; recording is skipped; the Settings page
  says why. *Implemented:* `OpenOutcome::ReadOnlyNewerSchema`, a typed
  `WorkspaceError::ReadOnly` for every write, and the same refusal in Python.
  The Settings page is not implemented.

---

## 7. Migration from `recent-index.json`

On first open of the new store, if `recent-index.json` exists next to the
legacy app-data location and `workspace.db` has no `projects imported` marker
in `kv`, its entries are imported once (pin, tags in `meta`, last-opened time,
thumbnail reference) and the marker is set. The legacy file is left in place
and no longer written. A project whose file is gone is imported as `missing`.

*Implemented* as `Workspace::import_legacy_recent_index(path)`; the marker key is
`legacy_recent_index_imported`. Entries already in the database keep their
counters and values and only gain what they lack (a legacy pin is never lost);
entries with a relative path are skipped. The legacy `running` and `draft`
statuses are transient and become `ready`. Imported rows start with
`use_count = 0`. `scanned_locations` and `continue` of the old index are not
imported; the desktop host owns the roots and the Continue card. Nothing calls
this yet: the desktop host must invoke it once on first open.

---

## 8. Interfaces

- **Rust crate `fullmag-workspace`** (new, no Tauri dependency): `Workspace::open`,
  `record`, `list`, `pin`, `forget`, `set_kv`/`get_kv`, `import_legacy_recent_index`,
  `state_dir()`. The CLI links it directly. SQLite is bundled
  (`rusqlite` with the `bundled` feature) so no system library is required.
- **Desktop host:** thin Tauri wrappers over the crate —
  `workspace_recent`, `workspace_record_open`, `workspace_pin`, `workspace_forget`,
  `workspace_pick_script` (file dialog filtered to `.py`, records and returns the
  text). `recent_index_*` commands become wrappers over the same store; the
  renderer contract of the project list does not change.
- **Python:** `fullmag.workspace` (stdlib `sqlite3`): `recent(kind=..., sort=...)`
  and `record(path, kind, event, **detail)`, same schema, same state-directory
  resolution, same newer-schema refusal.
- **Browser (no desktop host):** the web build has no filesystem authority and
  keeps showing an empty list with the existing explanation. The database is
  not exposed through the runtime HTTP API.

*Implemented:* the Rust crate (no Tauri dependency; the extra `RecordEvent`
fields `project_id` and `name` carry the stable project id and the display
name), `fullmag.workspace` for Python, and the CLI link
(`crates/fullmag-cli/src/workspace_usage.rs`). *Not implemented:* the Tauri
wrappers listed above.

---

## 9. Start screen changes

- A kind switch above the list: **All · Projects · Scripts**, remembered in `kv`.
- Sort menu: **Last used · Name · Modified · Most used**, applying to the active
  kind; pinned first.
- Script rows: `.py` badge, name, folder, last used, lines, `last_run` status.
  Selecting a script fills the inspector (path, summary, recent events, last
  run); its primary action is **Open script**, then **Reveal in folder**,
  **Pin**, **Forget**.
- Launch tile **Open script…** and a command `start.open-script` in the
  palette; opening runs the same flow as opening a script anywhere else in the
  application and records `open`.
- The History view of an item lists its `events` (opened, saved, run), which is
  the "what did I do last" answer for scripts that have no `.fms` history.

---

## 10. Gates

| Check | Pass condition |
|---|---|
| Schema | creating a v1 database, reopening it and migrating from an empty file yield the same `sqlite_master` |
| Concurrency | two processes recording in a loop produce no lost `use_count` increments and no `database is locked` error surfaces |
| Damage | a truncated file is quarantined and replaced; the app starts |
| Newer schema | a database with `user_version` above the supported one opens read-only and records nothing |
| Identity | the same file via two path spellings is one item; a moved `.fms` keeps its row |
| Migration | a legacy index with pins and tags imports once and not twice |
| Python parity | the Python reader returns the same ordered list as the Rust query for the same database |
| Privacy | the database contains no environment variables and no file contents |

---

## 11. Open decisions

1. Whether `meta.args` for scripts is worth keeping (useful for re-run, but
   arguments can contain paths or tokens). Default: store it, redact values for
   arguments whose name looks like a secret, and offer *Clear history*.
2. A retention limit for `events` (default: 500 per item, oldest dropped).
3. Whether the web build should read the database through the runtime API in a
   later step (not planned).

---

## 12. Gate coverage (store level)

| Gate | Evidence |
|---|---|
| Schema | `tests::schema_is_identical_on_create_reopen_and_migration_from_empty_file` (Rust); Python `SchemaTests` compare the embedded DDL with `crates/fullmag-workspace/schema/v1.sql` |
| Concurrency | `tests::eight_connections_recording_concurrently_lose_no_use_count` (8 connections x 200 events, threads in one process, including the race on creation); Python `test_concurrent_writers_lose_no_increments`. Separate OS processes are not exercised yet |
| Damage | garbage and truncated file tests quarantine and replace |
| Newer schema | `newer_schema_opens_read_only_and_refuses_writes`; Python `test_newer_schema_refuses_writes_but_reads` |
| Identity | two-spelling, case, and moved/copied project tests |
| Migration | `legacy_index_imports_once_and_not_twice` and two companions |
| Python parity | `RustParityTests` read a database written by the Rust test when `FULLMAG_WORKSPACE_PARITY_DB` is set (otherwise skipped) |
| Privacy | `database_holds_no_file_contents_or_environment_values` (file contents; the crate never reads environment values into the database) |

The gates are not yet exercised end to end through the desktop application.
