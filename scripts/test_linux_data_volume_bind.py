import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch

from scripts import linux_data_volume_copy
from scripts import fullmag_data_volume_pending as pending
from scripts import fullmag_data_volume_journal as journal_module
from scripts import fullmag_data_volume_manifest as manifest_module


def valid_bind_request():
    component_names = (
        *linux_data_volume_copy.COMPONENTS,
        "fullmag_data_volume_bind.py",
        "fullmag_data_volume_pending.py",
        "linux_data_volume_bind.py",
    )
    return {
        "schema": "fullmag.data-volume-linux-bind-request.v1",
        "volume_id": "1" * 32,
        "storage_root": "/srv/fullmag/storage",
        "token": "2" * 32,
        "copy_request_sha256": "a" * 64,
        "copy_receipt_sha256": "b" * 64,
        "fence_ready_sha256": "c" * 64,
        "components": {name: "d" * 64 for name in component_names},
    }


class LinuxDataVolumeBindRequestTests(unittest.TestCase):
    def test_accepts_closed_root_bind_request_with_exact_component_pins(self):
        from scripts import linux_data_volume_bind

        request = valid_bind_request()

        self.assertEqual(linux_data_volume_bind.validate_request(request), request)

    def test_rejects_open_or_incomplete_request_shape(self):
        from scripts import linux_data_volume_bind

        extra = valid_bind_request()
        extra["allow_admission"] = True
        missing = valid_bind_request()
        del missing["copy_receipt_sha256"]
        wrong_schema = valid_bind_request()
        wrong_schema["schema"] = "fullmag.data-volume-linux-bind-request.v2"

        for label, request in (("extra", extra), ("missing", missing), ("schema", wrong_schema)):
            with self.subTest(label=label), self.assertRaises(ValueError):
                linux_data_volume_bind.validate_request(request)

    def test_load_context_refuses_nonroot_before_reading_evidence(self):
        from scripts import linux_data_volume_bind

        with patch.object(linux_data_volume_bind.os, "geteuid", return_value=1000), patch.object(
            linux_data_volume_bind.qualification, "_read"
        ) as read:
            with self.assertRaisesRegex(ValueError, "root"):
                linux_data_volume_bind.load_context(Path("/srv/fullmag/storage/op/linux-bind-request.json"), "a" * 64)
        read.assert_not_called()

    def test_load_context_refuses_foreign_path_and_changed_component_before_copy_load(self):
        from scripts import linux_data_volume_bind

        for case in ("foreign_path", "changed_component"):
            with self.subTest(case=case):
                request = valid_bind_request()
                request["components"] = {
                    name: hashlib.sha256((Path(linux_data_volume_bind.__file__).parent / name).read_bytes()).hexdigest()
                    for name in linux_data_volume_bind.COMPONENTS
                }
                operation = Path(request["storage_root"]) / "migrations/data-volumes" / request["volume_id"]
                request_path = operation / "linux-bind-request.json"
                if case == "foreign_path":
                    request_path = operation / "elsewhere.json"
                else:
                    request["components"]["linux_data_volume_bind.py"] = "0" * 64
                raw = json.dumps(request, sort_keys=True).encode()
                with patch.object(linux_data_volume_bind.os, "geteuid", return_value=0), patch.object(
                    linux_data_volume_bind.qualification, "_read", return_value=(raw, request)
                ), patch.object(linux_data_volume_bind.copy_stage, "load_context") as copy_load:
                    with self.assertRaises(ValueError):
                        linux_data_volume_bind.load_context(request_path, hashlib.sha256(raw).hexdigest())
                copy_load.assert_not_called()

    def test_rejects_zero_boolean_or_malformed_id_and_evidence_sha(self):
        from scripts import linux_data_volume_bind

        for key, value in (
            ("volume_id", "0" * 32),
            ("volume_id", True),
            ("token", "0" * 32),
            ("token", "G" * 32),
            ("copy_request_sha256", True),
            ("copy_receipt_sha256", "a" * 63),
            ("fence_ready_sha256", "Z" * 64),
        ):
            request = valid_bind_request()
            request[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                linux_data_volume_bind.validate_request(request)

    def test_rejects_transient_or_noncanonical_storage_root(self):
        from scripts import linux_data_volume_bind

        for path in (
            "/tmp/fullmag/storage",
            "/run/fullmag/storage",
            "/srv/fullmag/../storage",
            "/srv/fullmag/storage/",
        ):
            request = valid_bind_request()
            request["storage_root"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                linux_data_volume_bind.validate_request(request)

    def test_requires_exact_component_set_and_lowercase_digests(self):
        from scripts import linux_data_volume_bind

        extra = valid_bind_request()
        extra["components"]["linux_data_volume_other.py"] = "e" * 64
        missing = valid_bind_request()
        missing["components"].pop("linux_data_volume_bind.py")
        bad_digest = valid_bind_request()
        bad_digest["components"]["linux_data_volume_bind.py"] = "F" * 64

        for label, request in (("extra", extra), ("missing", missing), ("digest", bad_digest)):
            with self.subTest(label=label), self.assertRaises(ValueError):
                linux_data_volume_bind.validate_request(request)


class PendingPublicationRaceTests(unittest.TestCase):
    def test_parent_replacement_after_exclusive_write_is_detected_and_marker_is_retained(self):
        from scripts import linux_data_volume_bind

        with tempfile.TemporaryDirectory(prefix="fullmag-bind-pending-race-") as temporary:
            root = Path(temporary)
            storage = root / "storage"
            index = storage / "index"
            index.mkdir(parents=True)
            repo = root / "source"
            repo.mkdir()
            runtime = storage / "runtimes" / "worktree-fixture"
            state_root = runtime / "docker-volume-dev" / "attempt"
            user_data = storage / "user-data" / "compose-fixture"
            state_root.mkdir(parents=True)
            user_data.mkdir(parents=True)
            source_payloads = {}
            for dataset in (state_root, user_data):
                payload = dataset / "keep.txt"
                payload.write_bytes((dataset.name + " retained\n").encode())
                source_payloads[payload] = (dataset.stat().st_dev, dataset.stat().st_ino, payload.read_bytes())

            operation = root / "operation"
            operation.mkdir()
            layout = {
                "repo_root": str(repo),
                "storage_root": str(storage),
                "runtime_root": str(runtime),
                "worktree_id": "worktree-fixture",
                "env": {"FULLMAG_PROJECT_ID": "project-fixture"},
            }
            plan = {
                "project_id": "project-fixture",
                "worktree_id": "worktree-fixture",
                "compose_project": "compose-fixture",
            }
            marker = {
                "schema": pending.SCHEMA,
                "project_id": plan["project_id"],
                "worktree_id": plan["worktree_id"],
                "compose_project": plan["compose_project"],
                "source_root": str(repo),
                "volume_id": "1" * 32,
                "plan_sha256": "2" * 64,
                "linux_request_sha256": "3" * 64,
                "copy_receipt_sha256": "4" * 64,
                "state_root": str(state_root),
                "user_data_root": str(user_data),
            }
            context = {
                "pending_layout": layout,
                "plan": plan,
                "pending": marker,
                "operation_root": operation,
            }
            marker_dir = storage / "index" / "data-volumes"
            marker_path = marker_dir / (plan["worktree_id"] + ".pending.json")
            saved_dir = marker_dir.with_name("data-volumes.saved")
            real_exclusive = linux_data_volume_bind._exclusive
            written = {}

            def replace_after_write(parent_fd, name, raw):
                real_exclusive(parent_fd, name, raw)
                written["bytes"] = raw
                marker_dir.rename(saved_dir)
                marker_dir.mkdir(mode=0o755)

            with patch.object(linux_data_volume_bind, "_exclusive", side_effect=replace_after_write):
                with self.assertRaises((ValueError, OSError)):
                    linux_data_volume_bind.publish_pending(context)

            self.assertEqual((saved_dir / marker_path.name).read_bytes(), written["bytes"])
            self.assertFalse(marker_path.exists())
            self.assertEqual(list(marker_dir.iterdir()), [])
            for payload, (device, inode, contents) in source_payloads.items():
                self.assertEqual((payload.parent.stat().st_dev, payload.parent.stat().st_ino), (device, inode))
                self.assertEqual(payload.read_bytes(), contents)


class CopiedWriterAclTests(unittest.TestCase):
    def test_authenticated_default_acl_mask_is_preserved_while_writer_lock_is_held(self):
        from scripts import linux_data_volume_bind

        undefined = 0xFFFFFFFF
        default_acl = struct.pack("<I", 2) + b"".join(
            struct.pack("<HHI", tag, permissions, identifier)
            for tag, permissions, identifier in (
                (0x01, 0b111, undefined),  # ACL_USER_OBJ: operator
                (0x02, 0b110, 65532),  # ACL_USER: runtime
                (0x04, 0b000, undefined),  # ACL_GROUP_OBJ
                (0x10, 0b111, undefined),  # ACL_MASK before creation
                (0x20, 0b000, undefined),  # ACL_OTHER
            )
        )

        with tempfile.TemporaryDirectory(prefix="fullmag-bind-writer-acl-") as temporary:
            base = Path(temporary)
            state_root = base / "state"
            user_data_root = base / "user-data"
            store = state_root / "runs/docker-all/session-store"
            store.mkdir(parents=True)
            user_data_root.mkdir()
            os.setxattr(store, "system.posix_acl_default", default_acl)
            lock_path = store / "WRITER.lock"
            descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
            os.close(descriptor)

            before = lock_path.stat()
            self.assertEqual(stat.S_IMODE(before.st_mode), 0o660)
            self.assertEqual(before.st_uid, os.getuid())
            acl = os.getxattr(lock_path, "system.posix_acl_access")
            self.assertEqual(struct.unpack_from("<I", acl)[0], 2)
            access_entries = [
                struct.unpack_from("<HHI", acl, offset)
                for offset in range(4, len(acl), 8)
            ]
            self.assertEqual(access_entries, [
                (0x01, 0b110, undefined),
                (0x02, 0b110, 65532),
                (0x04, 0b000, undefined),
                (0x10, 0b110, undefined),
                (0x20, 0b000, undefined),
            ])
            observed = manifest_module.inventory_datasets({"state": state_root, "user_data": user_data_root})
            writer_entry = next(
                entry for entry in observed["entries"]
                if entry["role"] == "state" and entry["path"] == "runs/docker-all/session-store/WRITER.lock"
            )
            self.assertIn("system.posix_acl_access", writer_entry["xattrs"])

            with linux_data_volume_bind._copied_writer(state_root, writer_entry):
                competing = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(competing, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(competing)

            after = lock_path.stat()
            self.assertEqual((after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)),
                             (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)))
            self.assertEqual(manifest_module.inventory_datasets(
                {"state": state_root, "user_data": user_data_root}
            )["entries"], observed["entries"])


class BindLifecycleTests(unittest.TestCase):
    def setUp(self):
        from scripts import linux_data_volume_bind

        self.temporary = tempfile.TemporaryDirectory(prefix="fullmag-bind-lifecycle-")
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        storage = base / "storage"
        (storage / "index").mkdir(parents=True)
        repo = base / "checkout"
        repo.mkdir()
        runtime_root = storage / "runtimes" / "worktree-fixture"
        source_state = runtime_root / "docker-volume-dev" / "attempt"
        source_user = storage / "user-data" / "compose-fixture"
        source_state.mkdir(parents=True)
        source_user.mkdir(parents=True)
        self.original_payloads = {}
        for root in (source_state, source_user):
            payload = root / "original.dat"
            payload.write_bytes((root.name + " original").encode())
            self.original_payloads[payload] = payload.read_bytes()

        operation = storage / "migrations" / "data-volumes" / ("1" * 32)
        operation.mkdir(parents=True)
        mount_root = base / "new-volume"
        mount_root.mkdir()
        copied_state = mount_root / "payload" / "runtimes" / "worktree-fixture" / "docker-volume-dev" / "attempt"
        copied_user = mount_root / "payload" / "user-data" / "compose-fixture"
        store = copied_state / "runs" / "docker-all" / "session-store"
        store.mkdir(parents=True)
        copied_user.mkdir(parents=True)
        self.writer_path = store / "WRITER.lock"
        writer_fd = os.open(self.writer_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(writer_fd)
        (copied_state / "copied.dat").write_bytes(b"copied state")
        (copied_user / "copied.dat").write_bytes(b"copied user data")

        archive = mount_root / "migration" / ("1" * 32) / "originals.pax"
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b"tiny verified PAX fixture")
        self.archive_bytes = archive.read_bytes()

        self.request = valid_bind_request()
        self.request["storage_root"] = str(storage)
        self.request_sha256 = "f" * 64
        self.operation = operation
        self.pending_layout = {
            "repo_root": str(repo),
            "storage_root": str(storage),
            "runtime_root": str(runtime_root),
            "worktree_id": "worktree-fixture",
            "env": {"FULLMAG_PROJECT_ID": "project-fixture"},
        }
        self.pending_value = {
            "schema": pending.SCHEMA,
            "project_id": "project-fixture",
            "worktree_id": "worktree-fixture",
            "compose_project": "compose-fixture",
            "source_root": str(repo),
            "volume_id": self.request["volume_id"],
            "plan_sha256": "5" * 64,
            "linux_request_sha256": "6" * 64,
            "copy_receipt_sha256": self.request["copy_receipt_sha256"],
            "state_root": str(source_state),
            "user_data_root": str(source_user),
        }
        copied_manifest = manifest_module.inventory_datasets(
            {"state": copied_state, "user_data": copied_user}
        )
        self.writer_entry = next(
            entry for entry in copied_manifest["entries"]
            if entry["role"] == "state" and entry["path"] == "runs/docker-all/session-store/WRITER.lock"
        )
        self.journal_path = operation / "journal.json"
        self.journal = journal_module.new_journal(self.request["volume_id"], "7" * 64)
        for phase in journal_module.PHASES[:5]:
            inputs = hashlib.sha256(phase.encode()).hexdigest()
            receipt = self.request["copy_receipt_sha256"] if phase == "copy-verified" else hashlib.sha256(
                (phase + "-receipt").encode()
            ).hexdigest()
            self.journal = journal_module.append_terminal(
                journal_module.append_started(self.journal, phase, inputs), "succeeded", receipt
            )
        self.journal_path.write_text(json.dumps(self.journal, sort_keys=True, indent=2) + "\n")
        self.context = {
            "request": self.request,
            "operation_root": operation,
            "copy_context": {"journal_path": self.journal_path, "journal": self.journal},
            "copy_result": {"archive_path": str(archive), "archive_sha256": hashlib.sha256(self.archive_bytes).hexdigest()},
            "plan": {"compose_project": "compose-fixture"},
            "linux": {"mount_root": str(mount_root)},
            "primitive": {"copied_roots": {"state": str(copied_state), "user_data": str(copied_user)}},
            "pending_layout": self.pending_layout,
            "pending": self.pending_value,
            "writer_entry": self.writer_entry,
        }

    def _run_with_switch(self, switch, *, publish_journal=None):
        from scripts import linux_data_volume_bind

        with patch.object(linux_data_volume_bind, "load_context", return_value=self.context), \
             patch.object(linux_data_volume_bind.primitive, "switch_roots", side_effect=switch):
            if publish_journal is None:
                return linux_data_volume_bind.bind_verified(
                    self.operation / "linux-bind-request.json", self.request_sha256
                )
            with patch.object(linux_data_volume_bind, "_publish_journal", side_effect=publish_journal):
                return linux_data_volume_bind.bind_verified(
                    self.operation / "linux-bind-request.json", self.request_sha256
                )

    def test_pending_and_writer_lock_are_held_before_primitive_then_success_is_not_admitted(self):
        pending_path = pending.pending_path(self.pending_layout)
        invocations = []

        def switch(request, record):
            invocations.append(request)
            self.assertTrue(pending_path.is_file())
            lock_fd = os.open(self.writer_path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(lock_fd)
            record({"step": "fixture-switch-verified", "role": "state"})
            return {"state": "binds-switched-not-admitted"}

        result = self._run_with_switch(switch)

        self.assertEqual(len(invocations), 1)
        self.assertEqual(result["state"], "binds-switched-not-admitted")
        self.assertFalse(result["namespace_admitted"])
        self.assertFalse(result["originals_retired"])
        self.assertEqual(pending.read_pending(self.pending_layout, "compose-fixture"), self.pending_value)
        self.assertTrue((self.operation / "linux-bind-event-000.json").is_file())
        self.assertEqual(json.loads((self.operation / "linux-bind-result.json").read_text()), result)
        stored_journal = json.loads(self.journal_path.read_text())
        self.assertEqual(stored_journal["events"][-2]["phase"], "binds-switched")
        self.assertEqual(stored_journal["events"][-1]["state"], "succeeded")
        for payload, contents in self.original_payloads.items():
            self.assertEqual(payload.read_bytes(), contents)
        self.assertEqual(Path(self.context["copy_result"]["archive_path"]).read_bytes(), self.archive_bytes)

    def test_partial_primitive_failure_retains_marker_sources_and_unknown_journal(self):
        pending_path = pending.pending_path(self.pending_layout)
        reached_primitive = []

        def fail_after_partial_switch(request, record):
            reached_primitive.append(request)
            self.assertTrue(pending_path.is_file())
            record({"step": "fixture-partial-state", "role": "state"})
            raise RuntimeError("injected partial primitive failure")

        with self.assertRaisesRegex(RuntimeError, "partial primitive"):
            self._run_with_switch(fail_after_partial_switch)

        self.assertEqual(len(reached_primitive), 1)
        self.assertTrue((self.operation / "linux-bind-failed.json").is_file())
        failure = json.loads((self.operation / "linux-bind-failed.json").read_text())
        self.assertEqual(failure["state"], "outcome-unknown-resources-retained")
        self.assertTrue(failure["originals_and_copies_retained"])
        self.assertFalse((self.operation / "linux-bind-result.json").exists())
        self.assertEqual(pending.read_pending(self.pending_layout, "compose-fixture"), self.pending_value)
        self.assertTrue((self.operation / "linux-bind-event-000.json").is_file())
        self.assertEqual(json.loads(self.journal_path.read_text())["events"][-1]["state"],
                         "outcome-unknown-resources-retained")
        for payload, contents in self.original_payloads.items():
            self.assertEqual(payload.read_bytes(), contents)
        self.assertTrue(self.writer_path.is_file())
        self.assertEqual(Path(self.context["copy_result"]["archive_path"]).read_bytes(), self.archive_bytes)

    def test_journal_failure_after_result_retains_unknown_state_and_success_artifact(self):
        from scripts import linux_data_volume_bind

        real_publish = linux_data_volume_bind._publish_journal
        calls = 0

        def fail_terminal_publish(path, expected, value):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected late journal failure")
            return real_publish(path, expected, value)

        def switch(request, record):
            self.assertTrue(pending.pending_path(self.pending_layout).is_file())
            record({"step": "fixture-switch-verified", "role": "state"})
            return {"state": "binds-switched-not-admitted"}

        with self.assertRaisesRegex(OSError, "late journal failure"):
            self._run_with_switch(switch, publish_journal=fail_terminal_publish)

        self.assertEqual(calls, 3)
        result = json.loads((self.operation / "linux-bind-result.json").read_text())
        self.assertEqual(result["state"], "binds-switched-not-admitted")
        failure = json.loads((self.operation / "linux-bind-failed.json").read_text())
        self.assertEqual(failure["state"], "outcome-unknown-resources-retained")
        self.assertTrue(pending.pending_path(self.pending_layout).is_file())
        self.assertEqual(json.loads(self.journal_path.read_text())["events"][-1]["state"],
                         "outcome-unknown-resources-retained")

if __name__ == "__main__":
    unittest.main()
