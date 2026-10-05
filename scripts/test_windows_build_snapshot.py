"""Interpreted regression checks for frozen native Windows source inputs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from windows import build_snapshot


class SnapshotChecks(unittest.TestCase):
    def test_capture_retries_only_source_races_and_is_bounded(self):
        with patch.object(build_snapshot, "create_snapshot", side_effect=[
            build_snapshot.SourceChangedSnapshot("race"), {"captured": True}
        ]) as create, patch.object(build_snapshot.time, "sleep"):
            self.assertEqual(build_snapshot.capture_for_build("repo", "build"), {"captured": True})
            self.assertEqual(create.call_count, 2)
        with patch.object(build_snapshot, "create_snapshot", side_effect=build_snapshot.SourceChangedSnapshot("race")) as create, patch.object(build_snapshot.time, "sleep"):
            with self.assertRaises(build_snapshot.SourceChangedSnapshot):
                build_snapshot.capture_for_build("repo", "build")
            self.assertEqual(create.call_count, 3)
        with patch.object(build_snapshot, "create_snapshot", side_effect=build_snapshot.SnapshotError("unsafe path")) as create:
            with self.assertRaises(build_snapshot.SnapshotError):
                build_snapshot.capture_for_build("repo", "build")
            self.assertEqual(create.call_count, 1)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.build = self.root / "build"
        self.build.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "snapshot@example.invalid")
        self.git("config", "user.name", "Snapshot fixture")
        self.git("config", "core.autocrlf", "false")
        self.file = self.repo / "crates/demo/src/lib.rs"
        self.file.parent.mkdir(parents=True)
        self.file.write_bytes(b"// raw CRLF\r\npub const VALUE: u8 = 1;\r\n")
        (self.repo / "Cargo.toml").write_text("[workspace]\nmembers = []\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.PIPE)

    def make(self):
        metadata = build_snapshot.create_snapshot(self.repo, self.build)
        # TemporaryDirectory cleanup also needs to remove read-only files on Windows.
        self.addCleanup(self.writable, Path(metadata["source_root"]).parent)
        return metadata

    @staticmethod
    def writable(root):
        for path in root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                path.chmod(0o600)

    def test_raw_bytes_provenance_and_reuse(self):
        self.file.write_bytes(self.file.read_bytes() + b"// dirty\r\n")
        untracked = self.repo / "scripts/new_helper.py"
        untracked.parent.mkdir()
        untracked.write_bytes(b"print('untracked')\r\n")
        metadata = self.make()
        frozen = Path(metadata["source_root"])
        self.assertEqual((frozen / "crates/demo/src/lib.rs").read_bytes(), self.file.read_bytes())
        self.assertEqual((frozen / "scripts/new_helper.py").read_bytes(), untracked.read_bytes())
        self.assertTrue(metadata["source_identity"]["source_snapshot_dirty"])
        self.assertEqual(build_snapshot.create_snapshot(self.repo, self.build), metadata)
        self.assertFalse((frozen / ".git").exists())

    def test_origin_changes_do_not_affect_verification(self):
        metadata = self.make()
        self.file.write_text("changed origin")
        (self.repo / "later.rs").write_text("later")
        with patch.object(build_snapshot, "capture", side_effect=AssertionError("live capture")), \
             patch.object(build_snapshot, "fingerprint", side_effect=AssertionError("live fingerprint")):
            self.assertEqual(build_snapshot.verify_snapshot(metadata, self.build), metadata)

    def test_unchanged_native_files_keep_mtime_across_different_snapshots(self):
        timestamp = 1_600_000_000_123_456_700
        os.utime(self.file, ns=(timestamp, timestamp))
        origin_mtime = self.file.stat().st_mtime_ns
        first = self.make()
        docs = self.repo / "docs/cache-note.md"
        docs.parent.mkdir()
        docs.write_text("Documentation changed without changing native inputs.\n")
        second = self.make()
        self.assertNotEqual(first["snapshot_id"], second["snapshot_id"])
        self.assertEqual(first["backend_source_sha256"], second["backend_source_sha256"])
        for snapshot in (first, second):
            copied = Path(snapshot["source_root"]) / "crates/demo/src/lib.rs"
            self.assertEqual(copied.stat().st_mtime_ns, origin_mtime)
            self.assertEqual(copied.read_bytes(), self.file.read_bytes())
        self.file.write_bytes(b"pub const VALUE: u8 = 2;\n")
        os.utime(self.file, ns=(timestamp + 1_000_000_000, timestamp + 1_000_000_000))
        third = self.make()
        copied = Path(third["source_root"]) / "crates/demo/src/lib.rs"
        self.assertNotEqual(third["backend_source_sha256"], second["backend_source_sha256"])
        self.assertEqual(copied.stat().st_mtime_ns, self.file.stat().st_mtime_ns)
        self.assertEqual(copied.read_bytes(), self.file.read_bytes())

    def test_snapshot_modification_and_extra_file_rejected(self):
        metadata = self.make()
        frozen = Path(metadata["source_root"])
        changed = frozen / "crates/demo/src/lib.rs"
        original = changed.read_bytes()
        changed.chmod(0o600)
        changed.write_bytes(b"changed")
        with self.assertRaises(build_snapshot.SnapshotError):
            build_snapshot.verify_snapshot(metadata, self.build)
        changed.write_bytes(original)
        (frozen / "extra.rs").write_text("extra")
        with self.assertRaises(build_snapshot.SnapshotError):
            build_snapshot.verify_snapshot(metadata, self.build)

    def test_copy_race_rejected(self):
        copy = build_snapshot._copy_file
        mutated = False
        def racing_copy(source, destination):
            nonlocal mutated
            result = copy(source, destination)
            if not mutated:
                mutated = True
                self.file.write_text("edited during capture")
            return result
        with patch.object(build_snapshot, "_copy_file", side_effect=racing_copy):
            with self.assertRaises(build_snapshot.SnapshotError):
                self.make()
        self.assertFalse(list((self.build / "source-snapshots").glob("*/record.json")))

    def test_frontend_and_docs_edits_record_actual_bytes_without_native_retry(self):
        frontend = self.repo / "apps/control-room/app/page.tsx"
        frontend.parent.mkdir(parents=True)
        frontend.write_bytes(b"// old frontend\r\n")
        document = self.repo / "docs/notes.md"
        document.parent.mkdir()
        document.write_bytes(b"old notes\r\n")
        self.git("add", ".")
        self.git("commit", "-qm", "frontend fixture")
        copy = build_snapshot._copy_file

        def racing_copy(source, destination):
            if source in (frontend, document):
                source.write_bytes(b"edited during capture\r\n")
            return copy(source, destination)

        with patch.object(build_snapshot, "_copy_file", side_effect=racing_copy):
            metadata = self.make()
        frozen = Path(metadata["source_root"])
        self.assertEqual((frozen / "apps/control-room/app/page.tsx").read_bytes(), frontend.read_bytes())
        self.assertEqual((frozen / "docs/notes.md").read_bytes(), document.read_bytes())
        self.assertEqual(build_snapshot.verify_snapshot(metadata, self.build), metadata)
        self.assertEqual(metadata["backend_source_sha256"], build_snapshot.fingerprint(self.repo)["sha256"])

    def test_frontend_dependency_edit_during_copy_is_still_rejected(self):
        package = self.repo / "apps/control-room/package.json"
        package.parent.mkdir(parents=True)
        package.write_text('{"dependencies": {}}')
        copy = build_snapshot._copy_file

        def racing_copy(source, destination):
            if source == package:
                source.write_text('{"dependencies": {"new": "1"}}')
            return copy(source, destination)

        with patch.object(build_snapshot, "_copy_file", side_effect=racing_copy):
            with self.assertRaises(build_snapshot.SourceChangedSnapshot):
                self.make()
        self.assertFalse(list((self.build / "source-snapshots").glob("*/record.json")))

    def test_traversal_and_record_tampering_rejected(self):
        with patch.object(build_snapshot, "_paths", return_value=["../outside"]):
            with self.assertRaises(build_snapshot.SnapshotError):
                self.make()
        metadata = self.make()
        record = Path(metadata["record_path"])
        data = json.loads(record.read_text())
        data["inventory"][0]["path"] = "../outside"
        record.chmod(0o600)
        record.write_text(json.dumps(data))
        with self.assertRaises(build_snapshot.SnapshotError):
            build_snapshot.verify_snapshot(record, self.build)
        with self.assertRaises(build_snapshot.SnapshotError):
            build_snapshot.create_snapshot(self.repo, self.repo / "nested-build")

    def test_link_refused(self):
        link = self.repo / "linked.rs"
        try:
            link.symlink_to(self.file)
        except OSError:
            self.skipTest("Host does not permit creating symlinks")
        with self.assertRaises((build_snapshot.SnapshotError, build_snapshot.SourceIdentityError)):
            self.make()

    def test_bounded_tauri_outputs_are_not_frozen_inputs(self):
        metadata = self.make()
        generated = Path(metadata["source_root"]) / build_snapshot.TAURI_OUTPUT_DIRECTORY
        generated.mkdir(parents=True)
        for name in build_snapshot.TAURI_OUTPUT_NAMES:
            (generated / name).write_text('{"generated": true}')
        self.assertEqual(build_snapshot.verify_snapshot(metadata, self.build), metadata)
        (generated / "capabilities.json").write_text('{"generated": "changed output"}')
        self.assertEqual(build_snapshot.verify_snapshot(metadata, self.build), metadata)
        for name, content in (("extra.rs", "source"), ("capabilities.json", "[]"),
                              ("capabilities.json", "invalid")):
            path = generated / name
            path.write_text(content)
            with self.assertRaises(build_snapshot.SnapshotError):
                build_snapshot.verify_snapshot(metadata, self.build)
            path.unlink()
        nested = generated / "nested"
        nested.mkdir()
        with self.assertRaises(build_snapshot.SnapshotError):
            build_snapshot.verify_snapshot(metadata, self.build)
        nested.rmdir()
        output = generated / "capabilities.json"
        try:
            output.symlink_to(self.file)
        except OSError:
            return  # Earlier regular/unknown/nested cases still exercised on this host.
        with self.assertRaises(build_snapshot.SnapshotError):
            build_snapshot.verify_snapshot(metadata, self.build)

    def test_tauri_output_collision_is_not_silently_excluded(self):
        generated = self.repo / build_snapshot.TAURI_OUTPUT_DIRECTORY
        generated.mkdir(parents=True)
        (generated / "capabilities.json").write_text("{}")
        with self.assertRaises(build_snapshot.SnapshotError):
            self.make()


if __name__ == "__main__":
    unittest.main()
