from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_isolated_control_snapshot as control_snapshot
from docker_build_control import BuildControlError


RECOVERY_ID = "a" * 32
OLD_ID = "b" * 32
BACKEND_IMAGE_ID = "sha256:" + "c" * 64


class FakeControl:
    def __init__(self, namespace: str = ""):
        self.namespace = namespace
        self.image = "sha256:" + "d" * 64
        self.calls: list[tuple[str, str, bool]] = []
        self.images: list[str] = []

    def helper_args(self, script: str, *, name=None, initialize=False):
        self.calls.append((script, self.namespace, initialize))
        self.images.append(self.image)
        parts = shlex.split(script)
        if parts[:5] != ["exec", "python3", "-I", "-B", "-c"] or len(parts) != 6:
            raise AssertionError("control helper did not use the isolated inline Python command")
        return [sys.executable, "-I", "-B", "-c", parts[5]]


class ControlSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.control_root = Path(self.temporary.name) / "control"
        self.control_root.mkdir()
        (self.control_root / "runtime-control").mkdir()
        (self.control_root / "namespaces").mkdir()
        self.old_live = self.control_root / "runtime-control" / "local-live"
        self._embedded = control_snapshot.helper_script_text

    def run_snapshot(self, control, recovery_id=RECOVERY_ID, **kwargs):
        with mock.patch.object(
            control_snapshot,
            "helper_script_text",
            lambda: self._embedded(self.control_root),
        ), mock.patch.object(
            control_snapshot,
            "_expected_source_root",
            lambda namespace: str((self.control_root / namespace if namespace else self.control_root)
                                  / "runtime-control" / "local-live"),
        ):
            return control_snapshot.snapshot_control_workspace(
                control, recovery_id, image_id=BACKEND_IMAGE_ID, **kwargs,
            )

    def make_live_workspace(self, *, namespace: str = "") -> Path:
        parent = self.control_root
        if namespace:
            parent = parent / namespace
            parent.mkdir(parents=True)
        live = parent / "runtime-control" / "local-live"
        live.mkdir(parents=True)
        (live / "current").mkdir()
        (live / "current" / "model.json").write_text(
            '{"model":"retained","revision":17}\n', encoding="utf-8",
        )
        store = live / "session-store"
        (store / "live_command_journals").mkdir(parents=True)
        (store / "objects" / "sha256").mkdir(parents=True)
        (store / "live_command_journals" / "commands.jsonl").write_text(
            '{"command":"compute","state":"accepted"}\n', encoding="utf-8",
        )
        blob = b"immutable-cas-object\n"
        (store / "objects" / "sha256" / hashlib.sha256(blob).hexdigest()).write_bytes(blob)
        (store / "WRITER.lock").write_bytes(b"")
        (store / "WRITER.owner.json").write_text(
            json.dumps({"schema": "fullmag.writer.v1", "released": True}),
            encoding="utf-8",
        )
        return live

    @staticmethod
    def safe_source_metadata(root: Path):
        result = {}
        for directory, names, files in os.walk(root, followlinks=False):
            parent = Path(directory)
            for name in names + files:
                path = parent / name
                info = path.lstat()
                result[str(path.relative_to(root))] = (
                    info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
                    info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                    info.st_uid, info.st_gid,
                )
                if stat.S_ISREG(info.st_mode):
                    result[str(path.relative_to(root)) + ":sha256"] = hashlib.sha256(
                        path.read_bytes(),
                    ).hexdigest()
        root_info = root.lstat()
        result[""] = (
            root_info.st_dev, root_info.st_ino, root_info.st_mode,
            root_info.st_nlink, root_info.st_size, root_info.st_mtime_ns,
            root_info.st_ctime_ns, root_info.st_uid, root_info.st_gid,
        )
        return result

    def prepare_destination_namespace(self):
        namespace = self.control_root / "namespaces" / RECOVERY_ID
        namespace.mkdir()
        return namespace

    def test_preview_and_publish_copy_model_command_journal_and_cas_without_source_changes(self):
        live = self.make_live_workspace()
        source_before = self.safe_source_metadata(live)
        control = FakeControl()
        preview = self.run_snapshot(control)
        self.assertEqual(preview["source"]["schema"], control_snapshot.CONTROL_SNAPSHOT_SCHEMA)
        self.assertTrue(preview["source"]["present"])
        self.assertEqual(preview["source"]["tree"]["file_count"], 5)
        self.assertFalse(preview["copied"])
        self.assertEqual(control.namespace, "")
        self.assertEqual(control.calls[-1][1], "")
        self.assertEqual(control.images[-1], BACKEND_IMAGE_ID)

        destination_namespace = self.prepare_destination_namespace()
        published = self.run_snapshot(control, expected=preview["source"], publish=True)
        destination = destination_namespace / "runtime-control" / "local-live"
        self.assertTrue(published["copied"])
        self.assertEqual(published["destination"], str(Path(
            f"/control/namespaces/{RECOVERY_ID}/runtime-control/local-live",
        )))
        self.assertEqual((destination / "current" / "model.json").read_bytes(),
                         (live / "current" / "model.json").read_bytes())
        self.assertEqual((destination / "session-store" / "live_command_journals" / "commands.jsonl").read_bytes(),
                         (live / "session-store" / "live_command_journals" / "commands.jsonl").read_bytes())
        source_cas = next((live / "session-store" / "objects" / "sha256").iterdir())
        self.assertEqual((destination / "session-store" / "objects" / "sha256" / source_cas.name).read_bytes(),
                         source_cas.read_bytes())
        self.assertNotEqual(live.stat().st_ino, destination.stat().st_ino)
        self.assertEqual(published["source"], preview["source"])
        self.assertEqual(self.safe_source_metadata(live), source_before)

    def test_existing_namespaced_source_is_snapshotted_from_its_fixed_location(self):
        live = self.make_live_workspace(namespace="namespaces/" + OLD_ID)
        control = FakeControl("namespaces/" + OLD_ID)
        preview = self.run_snapshot(control)
        self.assertEqual(preview["source"]["tree"]["source_root"], str(live))
        self.assertEqual(preview["destination"],
                         f"/control/namespaces/{RECOVERY_ID}/runtime-control/local-live")
        self.assertEqual(control.namespace, "namespaces/" + OLD_ID)
        self.assertEqual(control.images[-1], BACKEND_IMAGE_ID)

    def test_wrong_expected_record_fails_before_destination_creation(self):
        self.make_live_workspace()
        expected = self.run_snapshot(FakeControl())["source"]
        expected["tree"]["total_bytes"] += 1
        self.prepare_destination_namespace()

        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl(), expected=expected, publish=True)
        self.assertFalse((self.control_root / "namespaces" / RECOVERY_ID / "runtime-control").exists())

    def test_publish_requires_explicit_expected_record(self):
        self.make_live_workspace()
        self.prepare_destination_namespace()
        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl(), publish=True)
        self.assertFalse((self.control_root / "namespaces" / RECOVERY_ID / "runtime-control").exists())

    def test_existing_destination_is_never_overwritten(self):
        self.make_live_workspace()
        expected = self.run_snapshot(FakeControl())["source"]
        namespace = self.prepare_destination_namespace()
        existing = namespace / "runtime-control"
        existing.mkdir()
        local_live = existing / "local-live"
        local_live.mkdir()
        sentinel = local_live / "operator-data"
        sentinel.write_bytes(b"retain")

        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl(), expected=expected, publish=True)
        self.assertEqual(sentinel.read_bytes(), b"retain")

    def test_missing_live_leaf_returns_explicit_absence_and_publish_does_not_create_it(self):
        control = FakeControl()
        preview = self.run_snapshot(control)
        absent = {"schema": control_snapshot.CONTROL_SNAPSHOT_SCHEMA, "present": False}
        self.assertEqual(preview["source"], absent)
        self.prepare_destination_namespace()

        published = self.run_snapshot(control, expected=absent, publish=True)
        self.assertFalse(published["copied"])
        self.assertFalse((self.control_root / "namespaces" / RECOVERY_ID / "runtime-control").exists())

    def test_missing_source_ancestor_is_an_error_not_a_false_absence(self):
        (self.control_root / "runtime-control").rmdir()
        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl())

    def test_source_symlinks_and_hardlinks_are_rejected(self):
        live = self.make_live_workspace()
        (live / "current" / "linked-model").symlink_to(live / "current" / "model.json")
        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl())
        (live / "current" / "linked-model").unlink()
        os.link(live / "current" / "model.json", live / "current" / "hardlinked-model")
        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl())

    def test_busy_writer_is_rejected_and_lock_and_owner_bytes_remain_unchanged(self):
        live = self.make_live_workspace()
        store = live / "session-store"
        lock_path = store / "WRITER.lock"
        owner_path = store / "WRITER.owner.json"
        lock_before = lock_path.read_bytes()
        owner_before = owner_path.read_bytes()
        descriptor = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BuildControlError):
                self.run_snapshot(FakeControl())
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)
        self.assertEqual(lock_path.read_bytes(), lock_before)
        self.assertEqual(owner_path.read_bytes(), owner_before)

    def test_unreleased_or_missing_writer_owner_is_rejected(self):
        live = self.make_live_workspace()
        store = live / "session-store"
        owner = store / "WRITER.owner.json"
        owner.write_text('{"schema":"fullmag.writer.v1","released":false}', encoding="utf-8")
        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl())
        owner.unlink()
        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl())

    def test_legacy_lock_and_linked_session_store_are_rejected(self):
        live = self.make_live_workspace()
        store = live / "session-store"
        (store / "LOCK").write_bytes(b"")
        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl())
        (store / "LOCK").unlink()
        moved = live / "session-store-moved"
        store.rename(moved)
        store.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(BuildControlError):
            self.run_snapshot(FakeControl())

    def test_invalid_or_reused_namespace_tokens_are_rejected_without_helper(self):
        control = FakeControl(namespace="namespaces/" + RECOVERY_ID)
        with self.assertRaises(BuildControlError):
            control_snapshot.snapshot_control_workspace(
                control, RECOVERY_ID, image_id=BACKEND_IMAGE_ID,
            )
        self.assertEqual(control.calls, [])
        with self.assertRaises(BuildControlError):
            control_snapshot.snapshot_control_workspace(
                FakeControl(), "../bad", image_id=BACKEND_IMAGE_ID,
            )
        with self.assertRaises(BuildControlError):
            control_snapshot.snapshot_control_workspace(FakeControl(), RECOVERY_ID,
                                                        image_id="latest")


if __name__ == "__main__":
    unittest.main()
