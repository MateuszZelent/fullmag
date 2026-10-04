"""Read and write the per-user Fullmag workspace database.

One SQLite file (``workspace.db`` in the Fullmag state directory) records what
a person has opened, saved and run with Fullmag: projects (``.fms``) and Python
scripts. The desktop application, the ``fullmag`` command and this module share
it. The contract is ``docs/design/start-screen/docs/07-workspace-database.md``;
the Rust crate ``fullmag-workspace`` is the reference implementation and this
module mirrors its state-directory resolution, schema, identity rules and
ordering using only the standard library (``sqlite3``).

The database is derived, personal state: paths and usage metadata only, never
file contents or environment values. Importing this module has no side effects;
nothing is read or created until a function is called, and it is deliberately
not imported by ``fullmag/__init__``.

Example::

    import fullmag.workspace as ws

    ws.record("wall.py", "script", "run", device="auto")
    ws.recent(kind="script", limit=5)
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

__all__ = [
    "DATABASE_FILE_NAME",
    "MAX_EVENTS_PER_ITEM",
    "SCHEMA_VERSION",
    "WorkspaceError",
    "database_path",
    "recent",
    "record",
    "script_meta",
    "state_dir",
]

SCHEMA_VERSION = 2
DATABASE_FILE_NAME = "workspace.db"
MAX_EVENTS_PER_ITEM = 500
MAX_SCRIPT_BYTES = 1024 * 1024
_BUSY_TIMEOUT_SECONDS = 5.0

_KINDS = ("project", "script")
_EVENTS = ("open", "save", "run", "create", "import", "pin", "unpin", "forget")
_COUNTS_AS_USE = frozenset({"open", "run", "save", "create", "import"})
_SORTS = {
    "last_used": " ORDER BY pinned DESC, last_used_at DESC, id DESC",
    "name": " ORDER BY pinned DESC, fm_fold(name) ASC, id ASC",
    "modified": " ORDER BY pinned DESC, (modified_at IS NULL) ASC, modified_at DESC, id DESC",
    "use_count": " ORDER BY pinned DESC, use_count DESC, last_used_at DESC, id DESC",
}
_CASE_INSENSITIVE_PATHS = sys.platform in ("win32", "darwin")

_ITEM_COLUMNS = (
    "id, kind, path, name, project_id, first_seen_at, last_used_at, use_count, "
    "pinned, forgotten, size_bytes, modified_at, status, meta"
)

# Schema version 1: the same DDL as crates/fullmag-workspace/schema/v1.sql (a
# test compares them). Executed statement by statement because migrations run
# inside a manual transaction, which ``executescript`` would end.
_SCHEMA_V1_SQL = """\
CREATE TABLE items (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('project','script')),
  path            TEXT NOT NULL,
  path_key        TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  project_id      TEXT,
  first_seen_at   TEXT NOT NULL,
  last_used_at    TEXT NOT NULL,
  use_count       INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  forgotten       INTEGER NOT NULL DEFAULT 0,
  size_bytes      INTEGER,
  modified_at     TEXT,
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
"""
_SCHEMA_V1 = tuple(part.strip() for part in _SCHEMA_V1_SQL.split(";") if part.strip())

# Schema version 2 adds the thumbnails table (crates/fullmag-workspace/schema/v2.sql).
_SCHEMA_V2_SQL = """\
CREATE TABLE thumbnails (
  item_id  INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  sha256   TEXT NOT NULL,
  png      BLOB NOT NULL
);
"""
_SCHEMA_V2 = tuple(part.strip() for part in _SCHEMA_V2_SQL.split(";") if part.strip())
_MIGRATIONS = (_SCHEMA_V1, _SCHEMA_V2)


class WorkspaceError(RuntimeError):
    """The workspace database cannot be located or read."""


# -- location ---------------------------------------------------------------


def state_dir() -> Path:
    """The per-user Fullmag state directory (not created here).

    ``FULLMAG_STATE_DIR`` replaces the platform default: Windows
    ``%APPDATA%\\Fullmag``, macOS ``~/Library/Application Support/Fullmag``,
    Linux ``$XDG_DATA_HOME/fullmag`` else ``~/.local/share/fullmag``.
    """
    env = os.environ
    explicit = env.get("FULLMAG_STATE_DIR")
    if explicit:
        return Path(explicit)
    if sys.platform == "win32":
        appdata = env.get("APPDATA")
        if appdata:
            return Path(appdata) / "Fullmag"
        profile = env.get("USERPROFILE")
        if profile:
            return Path(profile) / "AppData" / "Roaming" / "Fullmag"
    elif sys.platform == "darwin":
        home = env.get("HOME")
        if home:
            return Path(home) / "Library" / "Application Support" / "Fullmag"
    else:
        data_home = env.get("XDG_DATA_HOME")
        if data_home and os.path.isabs(data_home):
            return Path(data_home) / "fullmag"
        home = env.get("HOME")
        if home:
            return Path(home) / ".local" / "share" / "fullmag"
    raise WorkspaceError("cannot determine the Fullmag state directory; set FULLMAG_STATE_DIR")


def database_path(database: str | os.PathLike[str] | None = None) -> Path:
    """Path of ``workspace.db``; ``database`` overrides the default location."""
    if database is not None:
        return Path(database)
    return state_dir() / DATABASE_FILE_NAME


# -- reading ----------------------------------------------------------------


def recent(
    kind: str | None = None,
    sort: str = "last_used",
    search: str | None = None,
    limit: int = 200,
    *,
    include_missing: bool = True,
    database: str | os.PathLike[str] | None = None,
) -> list[dict[str, Any]]:
    """The start-screen list: recently used projects and scripts.

    ``kind`` is ``None``/``"all"``, ``"project"`` or ``"script"``. ``sort`` is
    ``"last_used"`` (default), ``"name"``, ``"modified"`` or ``"use_count"``;
    pinned items always come first and ties break by id, so the order equals
    the Rust query for the same database. ``search`` is a case-insensitive
    substring over name, path and ``meta.authors``. Forgotten items are never
    returned; missing files are, flagged by ``status == "missing"``, unless
    ``include_missing=False``.

    Returns ``[]`` when no database exists yet. Works on a database from a
    newer schema (read only). Raises :class:`ValueError` for an unknown
    ``kind`` or ``sort`` and :class:`WorkspaceError` when the database cannot
    be read.
    """
    if kind in (None, "all"):
        kind = None
    elif kind not in _KINDS:
        raise ValueError(f"kind must be None, 'all', 'project' or 'script', not {kind!r}")
    if sort not in _SORTS:
        raise ValueError(f"sort must be one of {sorted(_SORTS)}, not {sort!r}")
    path = database_path(database)
    if not path.exists():
        return []
    try:
        connection = _connect(path, create=False)
    except sqlite3.Error as error:
        raise WorkspaceError(f"cannot open {path}: {error}") from error
    try:
        connection.execute("PRAGMA query_only = ON")
        sql = f"SELECT {_ITEM_COLUMNS} FROM items WHERE forgotten = 0"
        args: dict[str, Any] = {}
        if kind is not None:
            args["kind"] = kind
            sql += " AND kind = :kind"
        if not include_missing:
            sql += " AND status != 'missing'"
        term = (search or "").strip()
        if term:
            args["term"] = term.lower()
            sql += (
                " AND (instr(fm_fold(name), :term) > 0 OR instr(fm_fold(path), :term) > 0"
                " OR EXISTS (SELECT 1 FROM json_each(items.meta, '$.authors') AS a WHERE"
                " instr(fm_fold(CASE a.type WHEN 'object' THEN json_extract(a.value, '$.name')"
                " WHEN 'text' THEN a.value END), :term) > 0))"
            )
        sql += _SORTS[sort]
        args["limit"] = max(int(limit), 0)
        sql += " LIMIT :limit"
        return [_item_dict(row) for row in connection.execute(sql, args).fetchall()]
    except sqlite3.Error as error:
        raise WorkspaceError(f"cannot read {path}: {error}") from error
    finally:
        connection.close()


# -- writing ----------------------------------------------------------------


def record(
    path: str | os.PathLike[str],
    kind: str,
    event: str,
    *,
    meta: dict[str, Any] | None = None,
    project_id: str | None = None,
    name: str | None = None,
    database: str | os.PathLike[str] | None = None,
    **detail: Any,
) -> bool:
    """Record that ``path`` was opened, saved, run, ... by Python.

    ``kind`` is ``"project"`` or ``"script"``; ``event`` one of ``open``,
    ``save``, ``run``, ``create``, ``import``, ``pin``, ``unpin``, ``forget``.
    Keyword arguments become the event ``detail`` (JSON; keep it free of file
    contents and environment values). ``meta`` is a JSON merge patch applied to
    the item's ``meta``; for scripts without one, :func:`script_meta` is used.

    Best effort: this never raises into user code. It returns ``True`` when the
    event was stored and ``False`` when it was skipped - invalid arguments, a
    locked or damaged database, or a database from a newer schema (writes are
    refused there). A missing database is created. Open, run, save, create and
    import count as use: they bump ``use_count`` and ``last_used_at``.
    """
    try:
        if kind not in _KINDS or event not in _EVENTS:
            return False
        file_path = Path(os.fspath(path))
        if meta is None and kind == "script" and event in _COUNTS_AS_USE:
            try:
                meta = script_meta(file_path)
            except OSError:
                meta = None
        target = database_path(database)
        target.parent.mkdir(parents=True, exist_ok=True)
        connection = _connect(target, create=True)
        try:
            version = _user_version(connection)
            if version > SCHEMA_VERSION:
                return False
            if version < SCHEMA_VERSION:
                _migrate(connection)
            _record(connection, file_path, kind, event, detail, meta, project_id, name)
        finally:
            connection.close()
        return True
    except Exception:  # noqa: BLE001 - recording must never fail the caller
        return False


def script_meta(path: str | os.PathLike[str]) -> dict[str, Any]:
    """``{lines, summary, uses_fullmag}`` of a Python file, never executing it.

    Reads at most 1 MiB (adding ``"truncated": True`` beyond that); ``summary``
    is the first line of the module docstring and is omitted when there is none.
    Only derived values are returned, never the text itself.
    """
    with open(path, "rb") as handle:
        data = handle.read(MAX_SCRIPT_BYTES + 1)
    truncated = len(data) > MAX_SCRIPT_BYTES
    text = data[:MAX_SCRIPT_BYTES].decode("utf-8", errors="replace")
    lines = text.splitlines()
    result: dict[str, Any] = {
        "lines": len(lines),
        "uses_fullmag": any(_imports_fullmag(line) for line in lines),
    }
    summary = _docstring_summary(text)
    if summary is not None:
        result["summary"] = summary
    if truncated:
        result["truncated"] = True
    return result


# -- internals --------------------------------------------------------------


def _fold(value: Any) -> str | None:
    return value.lower() if isinstance(value, str) else None


def _connect(path: Path, *, create: bool) -> sqlite3.Connection:
    if create:
        connection = sqlite3.connect(
            str(path), timeout=_BUSY_TIMEOUT_SECONDS, isolation_level=None
        )
    else:
        uri = path.resolve().as_uri() + "?mode=rw"
        connection = sqlite3.connect(
            uri, uri=True, timeout=_BUSY_TIMEOUT_SECONDS, isolation_level=None
        )
    try:
        connection.create_function("fm_fold", 1, _fold, deterministic=True)
        connection.execute(f"PRAGMA busy_timeout = {int(_BUSY_TIMEOUT_SECONDS * 1000)}")
        if create:
            # Readers never change the journal mode of a database they only read.
            for attempt in range(20):
                try:
                    connection.execute("PRAGMA journal_mode = WAL").fetchone()
                    break
                except sqlite3.OperationalError as error:
                    contended = "locked" in str(error) or "busy" in str(error)
                    if not contended or attempt == 19:
                        raise
                    time.sleep(0.05)
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA synchronous = NORMAL")
    except BaseException:
        connection.close()
        raise
    return connection


def _user_version(connection: sqlite3.Connection) -> int:
    return int(connection.execute("PRAGMA user_version").fetchone()[0])


def _migrate(connection: sqlite3.Connection) -> None:
    connection.execute("BEGIN IMMEDIATE")
    try:
        current = _user_version(connection)
        if current < SCHEMA_VERSION:
            for step in _MIGRATIONS[current:SCHEMA_VERSION]:
                for statement in step:
                    connection.execute(statement)
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _now() -> str:
    return _stamp(datetime.now(timezone.utc))


def _identity(path: Path) -> tuple[str, str]:
    """Absolute path as last seen and the normalised identity key (spec 3.1)."""
    resolved = os.path.realpath(os.path.abspath(os.fspath(path)))
    if sys.platform == "win32":
        if resolved.startswith("\\\\?\\UNC\\"):
            resolved = "\\\\" + resolved[8:]
        elif resolved.startswith("\\\\?\\") and len(resolved) > 5 and resolved[5] == ":":
            resolved = resolved[4:]
    key = resolved.lower() if _CASE_INSENSITIVE_PATHS else resolved
    return resolved, key


def _file_state(path: str) -> tuple[int, str] | None:
    try:
        info = os.stat(path)
    except OSError:
        return None
    return info.st_size, _stamp(datetime.fromtimestamp(info.st_mtime, timezone.utc))


def _merge_patch(target: Any, patch: Any) -> Any:
    """RFC 7396 merge patch: objects merge, ``None`` deletes, the rest replaces."""
    if not isinstance(patch, dict):
        return patch
    if not isinstance(target, dict):
        target = {}
    for key, value in patch.items():
        if value is None:
            target.pop(key, None)
        else:
            target[key] = _merge_patch(target.get(key), value)
    return target


def _item_dict(row: Iterable[Any]) -> dict[str, Any]:
    (
        item_id,
        kind,
        path,
        name,
        project_id,
        first_seen_at,
        last_used_at,
        use_count,
        pinned,
        forgotten,
        size_bytes,
        modified_at,
        status,
        meta,
    ) = tuple(row)
    try:
        parsed = json.loads(meta)
    except (TypeError, ValueError):
        parsed = {}
    return {
        "id": item_id,
        "kind": kind,
        "path": path,
        "name": name,
        "project_id": project_id,
        "first_seen_at": first_seen_at,
        "last_used_at": last_used_at,
        "use_count": use_count,
        "pinned": bool(pinned),
        "forgotten": bool(forgotten),
        "size_bytes": size_bytes,
        "modified_at": modified_at,
        "status": status,
        "meta": parsed,
    }


def _find_existing(
    connection: sqlite3.Connection, path_key: str, kind: str, project_id: str | None
) -> dict[str, Any] | None:
    row = connection.execute(
        f"SELECT {_ITEM_COLUMNS} FROM items WHERE path_key = ?", (path_key,)
    ).fetchone()
    if row is not None:
        return _item_dict(row)
    if kind != "project" or not project_id:
        return None
    candidates = connection.execute(
        f"SELECT {_ITEM_COLUMNS} FROM items WHERE project_id = ? AND kind = 'project' "
        "ORDER BY last_used_at DESC, id DESC",
        (project_id,),
    ).fetchall()
    for candidate in candidates:
        item = _item_dict(candidate)
        # A copy keeps the id too; only a vanished original counts as moved.
        if not os.path.exists(item["path"]):
            return item
    return None


def _record(
    connection: sqlite3.Connection,
    file_path: Path,
    kind: str,
    event: str,
    detail: dict[str, Any],
    meta_patch: dict[str, Any] | None,
    project_id: str | None,
    name: str | None,
) -> None:
    path, key = _identity(file_path)
    stamp = _now()
    file = _file_state(path)
    detail_text = json.dumps(detail or {}, default=str, ensure_ascii=False)
    bump = event in _COUNTS_AS_USE
    name = (name or "").strip() or None
    project_id = project_id or None

    connection.execute("BEGIN IMMEDIATE")
    try:
        item = _find_existing(connection, key, kind, project_id)
        if item is None:
            meta: Any = _merge_patch({}, meta_patch) if meta_patch else {}
            cursor = connection.execute(
                "INSERT INTO items (kind, path, path_key, name, project_id, first_seen_at, "
                "last_used_at, use_count, pinned, forgotten, size_bytes, modified_at, status, "
                "meta) VALUES (:kind, :path, :key, :name, :project_id, :stamp, :stamp, :bump, "
                ":pinned, :forgotten, :size, :modified, :status, :meta)",
                {
                    "kind": kind,
                    "path": path,
                    "key": key,
                    "name": name or Path(path).stem or "untitled",
                    "project_id": project_id,
                    "stamp": stamp,
                    "bump": int(bump),
                    "pinned": int(event == "pin"),
                    "forgotten": int(event == "forget"),
                    "size": file[0] if file else None,
                    "modified": file[1] if file else None,
                    "status": "ready" if file else "missing",
                    "meta": json.dumps(meta, ensure_ascii=False),
                },
            )
            item_id = cursor.lastrowid
        else:
            meta = item["meta"] if isinstance(item["meta"], dict) else {}
            if meta_patch:
                meta = _merge_patch(meta, meta_patch)
            pinned, forgotten = item["pinned"], item["forgotten"]
            if event == "pin":
                pinned = True
            elif event == "unpin":
                pinned = False
            elif event == "forget":
                forgotten, pinned = True, False
            if bump:
                forgotten = False
            if file is None:
                status = "missing"
            elif item["status"] == "missing":
                status = "ready"
            else:
                status = item["status"]
            connection.execute(
                "UPDATE items SET path = :path, path_key = :key, name = COALESCE(:name, name), "
                "project_id = COALESCE(:project_id, project_id), "
                "last_used_at = CASE WHEN :bump THEN :stamp ELSE last_used_at END, "
                "use_count = use_count + :bump, pinned = :pinned, forgotten = :forgotten, "
                "size_bytes = COALESCE(:size, size_bytes), "
                "modified_at = COALESCE(:modified, modified_at), "
                "status = :status, meta = :meta WHERE id = :id",
                {
                    "path": path,
                    "key": key,
                    "name": name,
                    "project_id": project_id,
                    "bump": int(bump),
                    "stamp": stamp,
                    "pinned": int(pinned),
                    "forgotten": int(forgotten),
                    "size": file[0] if file else None,
                    "modified": file[1] if file else None,
                    "status": status,
                    "meta": json.dumps(meta, ensure_ascii=False),
                    "id": item["id"],
                },
            )
            item_id = item["id"]
        connection.execute(
            "INSERT INTO events (item_id, at, kind, actor, detail) "
            "VALUES (?, ?, ?, 'python', ?)",
            (item_id, stamp, event, detail_text),
        )
        count = connection.execute(
            "SELECT count(*) FROM events WHERE item_id = ?", (item_id,)
        ).fetchone()[0]
        if count > MAX_EVENTS_PER_ITEM:
            connection.execute(
                "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE item_id = ? "
                "ORDER BY at ASC, id ASC LIMIT ?)",
                (item_id, count - MAX_EVENTS_PER_ITEM),
            )
        connection.execute("COMMIT")
    except BaseException:
        connection.execute("ROLLBACK")
        raise


def _imports_fullmag(line: str) -> bool:
    line = line.lstrip()
    if line.startswith("import "):
        for item in line[len("import ") :].split(","):
            words = item.split()
            if words and _is_fullmag_module(words[0]):
                return True
        return False
    if line.startswith("from "):
        words = line[len("from ") :].split()
        return bool(words) and _is_fullmag_module(words[0])
    return False


def _is_fullmag_module(module: str) -> bool:
    return module == "fullmag" or module.startswith("fullmag.")


def _docstring_summary(text: str) -> str | None:
    rest = text[1:] if text.startswith("﻿") else text
    while True:
        trimmed = rest.lstrip(" \t\r\n\x0c")
        if trimmed.startswith("#"):
            rest = trimmed.partition("\n")[2]
        else:
            rest = trimmed
            break
    if rest[:1] in ("r", "R", "u", "U"):
        rest = rest[1:]
    for quote in ('"""', "'''", '"', "'"):
        if rest.startswith(quote):
            body = rest[len(quote) :].split(quote)[0]
            for line in body.splitlines():
                if line.strip():
                    return line.strip()[:200]
            return None
    return None
