from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from fullmag import workspace as ws


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
RUST_SCHEMA = REPOSITORY_ROOT / "crates/fullmag-workspace/schema/v1.sql"


def _normalise_sql(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


class WorkspaceTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.db = self.dir / "state" / "workspace.db"

    def touch(self, name: str, text: str = "x = 1\n") -> Path:
        path = self.dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def record(self, path: Path, kind: str, event: str, **kwargs) -> bool:
        return ws.record(path, kind, event, database=self.db, **kwargs)

    def recent(self, **kwargs):
        return ws.recent(database=self.db, **kwargs)


class ImportContractTests(unittest.TestCase):
    def test_package_import_does_not_load_workspace_or_touch_disk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "never-created"
            env = dict(os.environ, FULLMAG_STATE_DIR=str(state))
            source = Path(__file__).resolve().parents[1] / "src"
            env["PYTHONPATH"] = str(source) + os.pathsep + env.get("PYTHONPATH", "")
            code = (
                "import sys, fullmag;"
                "print('fullmag.workspace' in sys.modules);"
                "import fullmag.workspace;"
            )
            result = subprocess.run(
                [sys.executable, "-c", code], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "False")
            self.assertFalse(state.exists(), "importing must not create the state directory")


class LocationTests(unittest.TestCase):
    def test_explicit_state_dir_wins(self) -> None:
        with mock.patch.dict(os.environ, {"FULLMAG_STATE_DIR": "/somewhere/fm"}):
            self.assertEqual(ws.state_dir(), Path("/somewhere/fm"))
            self.assertEqual(ws.database_path(), Path("/somewhere/fm") / "workspace.db")

    @unittest.skipUnless(sys.platform == "win32", "Windows default")
    def test_windows_default_is_appdata(self) -> None:
        env = {"APPDATA": r"C:\Users\x\AppData\Roaming"}
        with mock.patch.dict(os.environ, env):
            os.environ.pop("FULLMAG_STATE_DIR", None)
            self.assertEqual(ws.state_dir(), Path(r"C:\Users\x\AppData\Roaming") / "Fullmag")

    @unittest.skipIf(sys.platform in ("win32", "darwin"), "XDG default")
    def test_linux_default_follows_xdg(self) -> None:
        with mock.patch.dict(os.environ, {"XDG_DATA_HOME": "/x/data", "HOME": "/h"}):
            os.environ.pop("FULLMAG_STATE_DIR", None)
            self.assertEqual(ws.state_dir(), Path("/x/data/fullmag"))
        with mock.patch.dict(os.environ, {"XDG_DATA_HOME": "rel", "HOME": "/h"}):
            os.environ.pop("FULLMAG_STATE_DIR", None)
            self.assertEqual(ws.state_dir(), Path("/h/.local/share/fullmag"))


class SchemaTests(WorkspaceTestCase):
    def test_embedded_schema_matches_the_rust_crate_ddl(self) -> None:
        if not RUST_SCHEMA.is_file():
            self.skipTest("Rust crate sources are not part of this checkout")
        self.assertEqual(
            _normalise_sql(ws._SCHEMA_V1_SQL),
            _normalise_sql(RUST_SCHEMA.read_text(encoding="utf-8")),
        )

    def test_created_database_has_the_specified_tables_and_version(self) -> None:
        self.assertTrue(self.record(self.touch("a.py"), "script", "open"))
        connection = sqlite3.connect(self.db)
        try:
            names = {
                row[0] for row in connection.execute("SELECT name FROM sqlite_master")
            }
            self.assertTrue(
                {"items", "events", "kv", "items_recent", "items_project_id", "events_item"}
                <= names
            )
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            columns = [r[1] for r in connection.execute("PRAGMA table_info(items)")]
            self.assertEqual(
                columns,
                [
                    "id", "kind", "path", "path_key", "name", "project_id", "first_seen_at",
                    "last_used_at", "use_count", "pinned", "forgotten", "size_bytes",
                    "modified_at", "status", "meta",
                ],
            )
        finally:
            connection.close()


class RecordAndRecentTests(WorkspaceTestCase):
    def test_empty_when_no_database_exists(self) -> None:
        self.assertEqual(self.recent(), [])
        self.assertFalse(self.db.exists(), "reading must not create the database")

    def test_record_counts_use_and_script_meta_is_attached(self) -> None:
        script = self.touch("wall.py", '"""Domain wall."""\nimport fullmag as fm\n')
        self.assertTrue(self.record(script, "script", "open"))
        self.assertTrue(self.record(script, "script", "run", device="auto", status="ok"))
        (item,) = self.recent()
        self.assertEqual(item["name"], "wall")
        self.assertEqual(item["kind"], "script")
        self.assertEqual(item["use_count"], 2)
        self.assertEqual(item["status"], "ready")
        self.assertEqual(
            item["meta"], {"lines": 2, "uses_fullmag": True, "summary": "Domain wall."}
        )
        connection = sqlite3.connect(self.db)
        try:
            rows = connection.execute(
                "SELECT kind, actor, detail FROM events ORDER BY id"
            ).fetchall()
        finally:
            connection.close()
        self.assertEqual([r[:2] for r in rows], [("open", "python"), ("run", "python")])
        self.assertEqual(json.loads(rows[1][2]), {"device": "auto", "status": "ok"})

    def test_pin_forget_and_non_use_events(self) -> None:
        script = self.touch("a.py")
        self.record(script, "script", "open")
        self.record(script, "script", "pin")
        (item,) = self.recent()
        self.assertTrue(item["pinned"])
        self.assertEqual(item["use_count"], 1)
        self.record(script, "script", "forget")
        self.assertEqual(self.recent(), [])
        self.record(script, "script", "open")
        (item,) = self.recent()
        self.assertFalse(item["pinned"])
        self.assertEqual(item["use_count"], 2)

    def test_two_spellings_are_one_item(self) -> None:
        script = self.touch("Wall.py")
        self.record(script, "script", "open")
        self.record(script.parent / "sub" / ".." / "Wall.py", "script", "open")
        (item,) = self.recent()
        self.assertEqual(item["use_count"], 2)

    def test_moved_project_keeps_its_row_and_a_copy_does_not(self) -> None:
        pid = "7b1f0c2e-9a44-4d1b-8f52-2c9e0a7d1101"
        old = self.touch("old.fms", "archive")
        self.record(old, "project", "open", project_id=pid, name="Waveguide")
        copy = self.touch("copy.fms", "archive")
        self.record(copy, "project", "open", project_id=pid)
        self.assertEqual(len(self.recent()), 2)
        moved = self.dir / "moved.fms"
        old.rename(moved)
        self.record(moved, "project", "open", project_id=pid)
        by_name = {item["name"]: item for item in self.recent()}
        self.assertEqual(len(by_name), 2)
        self.assertTrue(by_name["Waveguide"]["path"].endswith("moved.fms"))
        self.assertEqual(by_name["Waveguide"]["use_count"], 2)

    def test_meta_patch_merges_and_preserves_unknown_fields(self) -> None:
        script = self.touch("a.py")
        self.record(script, "script", "open", meta={"future": {"a": 1, "b": 2}, "lines": 1})
        self.record(script, "script", "run", meta={"future": {"b": None, "c": 3}})
        (item,) = self.recent()
        self.assertEqual(item["meta"], {"future": {"a": 1, "c": 3}, "lines": 1})

    def test_sorts_pinned_first_search_and_kind(self) -> None:
        for name, kind, opens in [
            ("alpha.fms", "project", 1),
            ("Bravo.py", "script", 5),
            ("charlie.fms", "project", 3),
            ("delta.py", "script", 2),
        ]:
            path = self.touch(name, "content")
            for _ in range(opens):
                self.record(path, kind, "open")
        names = lambda **kw: [i["name"] for i in self.recent(**kw)]  # noqa: E731
        self.assertEqual(names(sort="name"), ["alpha", "Bravo", "charlie", "delta"])
        self.assertEqual(names(sort="use_count"), ["Bravo", "charlie", "delta", "alpha"])
        self.assertEqual(names(kind="script", sort="name"), ["Bravo", "delta"])
        self.assertEqual(names(kind="project", sort="name"), ["alpha", "charlie"])
        self.assertEqual(names(search="CHAR"), ["charlie"])
        self.assertEqual(names(limit=2, sort="name"), ["alpha", "Bravo"])
        self.record(self.dir / "delta.py", "script", "pin")
        self.assertEqual(names(sort="name")[0], "delta")
        self.assertEqual(names(sort="use_count")[0], "delta")
        with self.assertRaises(ValueError):
            self.recent(sort="nope")
        with self.assertRaises(ValueError):
            self.recent(kind="nope")

    def test_author_search(self) -> None:
        project = self.touch("p.fms", "x")
        self.record(
            project,
            "project",
            "open",
            meta={"authors": [{"name": "Ada Lovelace", "role": "creator"}]},
        )
        self.assertEqual([i["name"] for i in self.recent(search="lovelace")], ["p"])
        self.assertEqual(self.recent(search="babbage"), [])

    def test_missing_files_are_flagged_and_can_be_hidden(self) -> None:
        ghost = self.dir / "ghost.py"
        self.record(ghost, "script", "open")
        (item,) = self.recent()
        self.assertEqual(item["status"], "missing")
        self.assertEqual(self.recent(include_missing=False), [])

    def test_event_retention(self) -> None:
        script = self.touch("a.py")
        for _ in range(ws.MAX_EVENTS_PER_ITEM + 10):
            self.assertTrue(self.record(script, "script", "open"))
        connection = sqlite3.connect(self.db)
        try:
            count = connection.execute("SELECT count(*) FROM events").fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(count, ws.MAX_EVENTS_PER_ITEM)
        self.assertEqual(self.recent()[0]["use_count"], ws.MAX_EVENTS_PER_ITEM + 10)

    def test_concurrent_writers_lose_no_increments(self) -> None:
        script = self.touch("shared.py")
        results: list[bool] = []

        def work() -> None:
            for _ in range(40):
                results.append(self.record(script, "script", "open"))

        threads = [threading.Thread(target=work) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertTrue(all(results), "no write may be reported as locked")
        self.assertEqual(self.recent()[0]["use_count"], 240)


class BestEffortTests(WorkspaceTestCase):
    def test_record_never_raises_and_reports_false(self) -> None:
        script = self.touch("a.py")
        self.assertFalse(ws.record(script, "notebook", "open", database=self.db))
        self.assertFalse(ws.record(script, "script", "explode", database=self.db))
        self.assertFalse(ws.record(object(), "script", "open", database=self.db))  # type: ignore[arg-type]
        blocker = self.touch("blocker", "a file, not a directory")
        self.assertFalse(
            ws.record(script, "script", "open", database=blocker / "workspace.db")
        )

    def test_detail_that_is_not_json_is_stringified_not_raised(self) -> None:
        script = self.touch("a.py")
        self.assertTrue(self.record(script, "script", "run", obj=object()))

    def test_newer_schema_refuses_writes_but_reads(self) -> None:
        script = self.touch("a.py")
        self.assertTrue(self.record(script, "script", "open"))
        connection = sqlite3.connect(self.db)
        connection.execute("PRAGMA user_version = 99")
        connection.close()
        self.assertFalse(self.record(script, "script", "open"))
        self.assertEqual(self.recent()[0]["use_count"], 1)
        connection = sqlite3.connect(self.db)
        try:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 99)
        finally:
            connection.close()

    def test_damaged_database_is_not_overwritten_by_python(self) -> None:
        self.db.parent.mkdir(parents=True, exist_ok=True)
        self.db.write_bytes(b"definitely not sqlite " * 100)
        before = self.db.read_bytes()
        self.assertFalse(self.record(self.touch("a.py"), "script", "open"))
        self.assertEqual(self.db.read_bytes(), before, "quarantine is the Rust host's job")
        with self.assertRaises(ws.WorkspaceError):
            self.recent()


class ScriptMetaTests(WorkspaceTestCase):
    def test_summary_lines_and_import_flag(self) -> None:
        script = self.touch(
            "s.py", '#!/usr/bin/env python\n"""Domain wall.\n\nMore."""\nfrom fullmag import Box\n'
        )
        self.assertEqual(
            ws.script_meta(script),
            {"lines": 5, "uses_fullmag": True, "summary": "Domain wall."},
        )

    def test_lookalike_imports_and_no_docstring(self) -> None:
        script = self.touch("s.py", "import fullmagic\n# import fullmag\nx = 1\n")
        meta = ws.script_meta(script)
        self.assertFalse(meta["uses_fullmag"])
        self.assertNotIn("summary", meta)

    def test_large_files_are_bounded(self) -> None:
        body = "# SECRET-MARKER filler\n" * (ws.MAX_SCRIPT_BYTES // 20)
        script = self.touch("big.py", "import fullmag\n" + body)
        meta = ws.script_meta(script)
        self.assertTrue(meta["truncated"])
        self.assertNotIn("SECRET-MARKER", json.dumps(meta))


class PrivacyTests(WorkspaceTestCase):
    def test_database_holds_no_file_contents(self) -> None:
        secret = "SECRET-BODY-d41d8cd98f00"
        script = self.touch("private.py", f'"""Summary."""\nimport fullmag\ntoken = "{secret}"\n')
        self.assertTrue(self.record(script, "script", "run"))
        for candidate in self.db.parent.iterdir():
            if candidate.name.startswith("workspace.db"):
                self.assertNotIn(secret.encode(), candidate.read_bytes(), candidate.name)


@unittest.skipUnless(
    os.environ.get("FULLMAG_WORKSPACE_PARITY_DB")
    and Path(os.environ["FULLMAG_WORKSPACE_PARITY_DB"]).is_file(),
    "set FULLMAG_WORKSPACE_PARITY_DB to a database written by the Rust parity test",
)
class RustParityTests(unittest.TestCase):
    """Reads a database created by the Rust crate and compares ordered lists.

    Create the fixture with::

        FULLMAG_WORKSPACE_PARITY_DB=<dir>/workspace.db cargo test -p fullmag-workspace \\
            writes_parity_database_when_requested
    """

    def setUp(self) -> None:
        self.db = Path(os.environ["FULLMAG_WORKSPACE_PARITY_DB"])
        expected = Path(str(self.db) + ".expected.json")
        self.expected = json.loads(expected.read_text(encoding="utf-8"))

    def test_python_returns_the_rust_order_for_every_sort(self) -> None:
        for sort in ("last_used", "name", "use_count"):
            paths = [item["path"] for item in ws.recent(sort=sort, database=self.db)]
            self.assertEqual(paths, self.expected[sort], sort)

    def test_search_and_kind_filter_agree(self) -> None:
        self.assertEqual(
            [i["path"] for i in ws.recent(search="lovelace", database=self.db)],
            self.expected["search_lovelace"],
        )
        self.assertEqual(
            [i["path"] for i in ws.recent(kind="script", database=self.db)],
            self.expected["kind_script"],
        )

    def test_python_writes_into_a_rust_created_database(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "workspace.db"
            shutil.copyfile(self.db, copy)
            item = ws.recent(database=copy)[0]
            before = item["use_count"]
            self.assertTrue(ws.record(item["path"], item["kind"], "open", database=copy))
            after = {i["id"]: i for i in ws.recent(database=copy)}[item["id"]]
            self.assertEqual(after["use_count"], before + 1)


if __name__ == "__main__":
    unittest.main()
