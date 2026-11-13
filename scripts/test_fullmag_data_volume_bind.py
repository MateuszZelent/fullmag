"""Lifecycle and preflight tests for switching copied Linux data roots."""

import unittest
from contextlib import contextmanager
import copy
import errno
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from unittest.mock import Mock, patch

from scripts import fullmag_data_volume_bind as bind
from scripts import fullmag_data_volume_manifest as manifest


class BindScenario:
    def __init__(self, test_case):
        self._temporary = tempfile.TemporaryDirectory(prefix="fullmag-bind-")
        test_case.addCleanup(self._temporary.cleanup)
        self.root = Path(self._temporary.name)
        self.storage = self.root / "source-storage"
        self.storage.mkdir()
        self.sources = {}
        self.copies = {}
        for role in ("user_data", "state"):
            source = self.storage / role
            source.mkdir()
            (source / "fixture.txt").write_text(role + " payload\n", encoding="utf-8")
            self.sources[role] = source

            copied = self.root / "copied-payload" / role
            copied.parent.mkdir(exist_ok=True)
            shutil.copytree(source, copied, copy_function=shutil.copy2)
            self.copies[role] = copied

        self.mount = self.root / "new-mount"
        self.mount.mkdir()
        self.storage_root = "/srv/fullmag/storage"
        self.mount_root = "/mnt/fullmag-new"
        self.volume_id = "1" * 32
        self.filesystem_uuid = "11111111-2222-4333-8444-555555555555"
        self.source_manifest = manifest.inventory_datasets(self.sources)
        for role in ("user_data", "state"):
            self.source_manifest["roots"][role]["path"] = f"{self.storage_root}/{role}"
        mount_info = self.mount.stat()
        self.request = {
            "schema": bind.SCHEMA,
            "volume_id": self.volume_id,
            "storage_root": self.storage_root,
            "mount_root": self.mount_root,
            "filesystem_uuid": self.filesystem_uuid,
            "mount_identity": {"device": mount_info.st_dev, "inode": mount_info.st_ino},
            "source_manifest": self.source_manifest,
            "copied_roots": {
                role: f"{self.mount_root}/payload/{role}"
                for role in ("user_data", "state")
            },
        }

    def scope_request(self):
        request = copy.deepcopy(self.request)
        # `_scope` validates a destination on a distinct filesystem. A
        # synthetic positive device is sufficient for this pure contract test.
        request["mount_identity"]["device"] += 1
        return request

    def switch_mocks(self, *, parent_propagation="private", record=None, validate_scope=False):
        events = [] if record is None else record
        self.parent_propagation = parent_propagation
        original_scope = bind._scope

        def scope(request):
            if validate_scope:
                original_scope(request)
            return self.sources, self.copies

        def mount_info(path, exact=False):
            if exact:
                return None
            return {"target": str(path), "propagation": self.parent_propagation}

        return (
            patch.object(bind, "_scope", side_effect=scope),
            patch.object(bind, "_destination", return_value=self.mount),
            patch.object(bind, "_mount_info", side_effect=mount_info),
            events,
        )

    def private_underlay_mocks(self, test_case):
        state = {}
        original_directory_fd = bind._directory_fd

        def create_underlay(parent_fd, name):
            path = self.sources["user_data"]
            if name != path.name:
                raise AssertionError("fixture expects the first user_data underlay")
            os.mkdir(name, mode=0o700, dir_fd=parent_fd)
            descriptor = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=parent_fd,
            )
            os.fchmod(descriptor, 0)
            state["path"] = path
            state["fd"] = descriptor
            info = os.fstat(descriptor)
            return {"device": info.st_dev, "inode": info.st_ino}

        @contextmanager
        def directory_fd(path):
            if state.get("path") == Path(path):
                duplicate = os.dup(state["fd"])
                try:
                    yield duplicate
                finally:
                    os.close(duplicate)
            else:
                with original_directory_fd(path) as descriptor:
                    yield descriptor

        def cleanup_underlay_fd():
            descriptor = state.get("fd")
            if descriptor is not None:
                os.fchmod(descriptor, 0o700)
                os.close(descriptor)

        test_case.addCleanup(cleanup_underlay_fd)
        return (
            patch.object(bind, "_underlay", side_effect=create_underlay),
            patch.object(bind, "_directory_fd", side_effect=directory_fd),
            patch.dict(bind._same_directory.__globals__, {"_directory_fd": directory_fd}),
            state,
        )


class DataVolumeBindTests(unittest.TestCase):
    def test_shared_original_parent_refuses_before_record_or_mutation(self):
        fixture = BindScenario(self)
        events = []
        scope, destination, mount_info, _ = fixture.switch_mocks(
            parent_propagation="shared", record=events
        )
        rename = Mock(side_effect=ValueError("rename reached before private-parent gate"))
        bind_mount = Mock()
        with patch.object(bind.os, "geteuid", return_value=0), scope, destination, mount_info, \
                patch.object(bind, "_rename_noreplace", rename), \
                patch.object(bind, "_bind", bind_mount):
            with self.assertRaises(ValueError):
                bind.switch_roots(fixture.request, events.append)

        rename.assert_not_called()
        bind_mount.assert_not_called()
        self.assertEqual(events, [])

    def test_scope_accepts_exact_canonical_request(self):
        fixture = BindScenario(self)
        sources, copies = bind._scope(fixture.scope_request())

        self.assertEqual(sources, {
            role: Path(f"{fixture.storage_root}/{role}")
            for role in ("user_data", "state")
        })
        self.assertEqual(copies, {
            role: Path(f"{fixture.mount_root}/payload/{role}")
            for role in ("user_data", "state")
        })

    def test_request_and_identity_failures_precede_record_rename_and_bind(self):
        mutations = ("nonroot", "unknown-field", "foreign-copy-root", "invalid-device")
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                fixture = BindScenario(self)
                request = fixture.scope_request()
                if mutation == "unknown-field":
                    request["unrecognized"] = True
                elif mutation == "foreign-copy-root":
                    request["copied_roots"]["foreign"] = f"{fixture.mount_root}/payload/foreign"
                elif mutation == "invalid-device":
                    request["mount_identity"]["device"] = fixture.source_manifest["roots"]["state"]["device"]
                events = []
                rename = Mock()
                bind_mount = Mock()
                scope = (
                    patch.object(bind, "_scope", side_effect=bind._scope)
                    if mutation == "invalid-device"
                    else patch.object(bind, "_scope", wraps=bind._scope)
                )
                with patch.object(bind.os, "geteuid", return_value=1000 if mutation == "nonroot" else 0), \
                        patch.object(bind, "_rename_noreplace", rename), \
                        patch.object(bind, "_bind", bind_mount), \
                        patch.object(bind, "_destination", return_value=fixture.mount), scope:
                    with self.assertRaises(ValueError):
                        bind.switch_roots(request, events.append)

                rename.assert_not_called()
                bind_mount.assert_not_called()
                self.assertEqual(events, [])

    def test_source_manifest_drift_refuses_before_mutation(self):
        fixture = BindScenario(self)
        (fixture.sources["user_data"] / "fixture.txt").write_text(
            "changed after saved manifest\n", encoding="utf-8"
        )
        events = []
        scope, destination, mount_info, _ = fixture.switch_mocks(record=events)
        rename = Mock()
        bind_mount = Mock()
        with patch.object(bind.os, "geteuid", return_value=0), scope, destination, mount_info, \
                patch.object(bind, "_rename_noreplace", rename), \
                patch.object(bind, "_bind", bind_mount):
            with self.assertRaises(ValueError):
                bind.switch_roots(fixture.request, events.append)

        rename.assert_not_called()
        bind_mount.assert_not_called()
        self.assertEqual(events, [])

    def test_source_symlink_refuses_before_mutation(self):
        fixture = BindScenario(self)
        source_file = fixture.sources["user_data"] / "fixture.txt"
        source_file.unlink()
        source_file.symlink_to(fixture.sources["state"] / "fixture.txt")
        events = []
        scope, destination, mount_info, _ = fixture.switch_mocks(record=events)
        rename = Mock()
        bind_mount = Mock()
        with patch.object(bind.os, "geteuid", return_value=0), scope, destination, mount_info, \
                patch.object(bind, "_rename_noreplace", rename), \
                patch.object(bind, "_bind", bind_mount):
            with self.assertRaises(ValueError):
                bind.switch_roots(fixture.request, events.append)

        rename.assert_not_called()
        bind_mount.assert_not_called()
        self.assertEqual(events, [])

    def test_retained_backup_collision_refuses_before_mutation(self):
        fixture = BindScenario(self)
        backup = fixture.sources["user_data"].with_name(
            f".user_data.fullmag-before-{fixture.volume_id}"
        )
        backup.mkdir()
        events = []
        scope, destination, mount_info, _ = fixture.switch_mocks(record=events)
        rename = Mock()
        bind_mount = Mock()
        with patch.object(bind.os, "geteuid", return_value=0), scope, destination, mount_info, \
                patch.object(bind, "_rename_noreplace", rename), \
                patch.object(bind, "_bind", bind_mount):
            with self.assertRaisesRegex(ValueError, "already exists"):
                bind.switch_roots(fixture.request, events.append)

        rename.assert_not_called()
        bind_mount.assert_not_called()
        self.assertTrue(backup.is_dir())
        self.assertEqual(events, [])

    def test_invalid_mount_identity_device_refuses_before_mutation(self):
        fixture = BindScenario(self)
        request = fixture.scope_request()
        request["mount_identity"]["device"] += 1
        events = []
        scope, _, mount_info, _ = fixture.switch_mocks(record=events, validate_scope=True)
        rename = Mock()
        bind_mount = Mock()
        with patch.object(bind.os, "geteuid", return_value=0), scope, \
                patch.object(bind, "_destination", return_value=fixture.mount), mount_info, \
                patch.object(bind, "_rename_noreplace", rename), \
                patch.object(bind, "_bind", bind_mount):
            with self.assertRaisesRegex(ValueError, "identity drifted"):
                bind.switch_roots(request, events.append)

        rename.assert_not_called()
        bind_mount.assert_not_called()
        self.assertEqual(events, [])

    @unittest.skipUnless(sys.platform.startswith("linux"), "renameat2 is Linux-specific")
    def test_real_rename_noreplace_refuses_existing_empty_target(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-rename-existing-") as temporary:
            parent = Path(temporary)
            original = parent / "original"
            original.mkdir()
            (original / "payload.txt").write_text("original bytes\n", encoding="utf-8")
            target = parent / "backup"
            target.mkdir()
            original_inode = original.stat().st_ino
            target_inode = target.stat().st_ino
            parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(OSError) as raised:
                    bind._rename_noreplace(parent_fd, original.name, target.name)
            finally:
                os.close(parent_fd)

            self.assertEqual(raised.exception.errno, errno.EEXIST)
            self.assertEqual(original.stat().st_ino, original_inode)
            self.assertEqual((original / "payload.txt").read_text(encoding="utf-8"), "original bytes\n")
            self.assertEqual(target.stat().st_ino, target_inode)
            self.assertEqual(list(target.iterdir()), [])

    @unittest.skipUnless(sys.platform.startswith("linux"), "renameat2 is Linux-specific")
    def test_real_rename_noreplace_preserves_inode_and_contents(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-rename-absent-") as temporary:
            parent = Path(temporary)
            original = parent / "original"
            original.mkdir()
            payload = original / "payload.txt"
            payload.write_text("retained bytes\n", encoding="utf-8")
            original_inode = original.stat().st_ino
            parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                bind._rename_noreplace(parent_fd, original.name, "backup")
            finally:
                os.close(parent_fd)

            backup = parent / "backup"
            self.assertFalse(original.exists())
            self.assertEqual(backup.stat().st_ino, original_inode)
            self.assertEqual((backup / "payload.txt").read_text(encoding="utf-8"), "retained bytes\n")

    def assert_first_root_retained(self, fixture, events, rename, bind_mount, make_private):
        backup = fixture.sources["user_data"].with_name(
            f".user_data.fullmag-before-{fixture.volume_id}"
        )
        self.assertEqual(rename.call_count, 1)
        self.assertEqual((backup / "fixture.txt").read_text(encoding="utf-8"), "user_data payload\n")
        self.assertTrue(fixture.sources["user_data"].is_dir())
        self.assertEqual(stat.S_IMODE(fixture.sources["user_data"].stat().st_mode), 0)
        self.assertTrue(fixture.sources["state"].is_dir())
        self.assertFalse(
            fixture.sources["state"].with_name(
                f".state.fullmag-before-{fixture.volume_id}"
            ).exists()
        )
        steps = [event["step"] for event in events]
        self.assertEqual(
            steps,
            ["rename-intent", "original-retained", "underlay-created", "bind-intent"],
        )
        for event in events:
            self.assertTrue(
                {
                    "step",
                    "role",
                    "canonical_root",
                    "backup_root",
                    "copied_root",
                    "original_identity",
                }
                <= set(event)
            )
            self.assertEqual(event["role"], "user_data")
        make_private.assert_not_called()

    def test_mount_failure_after_first_rename_keeps_backup_without_rollback(self):
        fixture = BindScenario(self)
        events = []
        scope, destination, mount_info, _ = fixture.switch_mocks(record=events)
        make_underlay, directory_fd, same_directory_fd, underlay_state = fixture.private_underlay_mocks(self)
        real_rename = Mock(wraps=bind._rename_noreplace)
        bind_mount = Mock(side_effect=OSError("simulated bind mount failure"))
        make_private = Mock()
        with patch.object(bind.os, "geteuid", return_value=0), scope, destination, mount_info, \
                make_underlay, directory_fd, same_directory_fd, \
                patch.object(bind, "_rename_noreplace", real_rename), \
                patch.object(bind, "_bind", bind_mount), patch.object(bind, "_make_private", make_private):
            with self.assertRaisesRegex(OSError, "simulated bind mount failure"):
                bind.switch_roots(fixture.request, events.append)

        self.assertEqual(bind_mount.call_count, 1)
        self.assert_first_root_retained(fixture, events, real_rename, bind_mount, make_private)
        self.assertEqual(underlay_state["path"], fixture.sources["user_data"])

    def test_noop_bind_is_rejected_before_private_propagation_change(self):
        fixture = BindScenario(self)
        events = []
        scope, destination, mount_info, _ = fixture.switch_mocks(record=events)
        make_underlay, directory_fd, same_directory_fd, _underlay_state = fixture.private_underlay_mocks(self)
        real_rename = Mock(wraps=bind._rename_noreplace)
        bind_mount = Mock(return_value=None)
        make_private = Mock()
        with patch.object(bind.os, "geteuid", return_value=0), scope, destination, mount_info, \
                make_underlay, directory_fd, same_directory_fd, \
                patch.object(bind, "_rename_noreplace", real_rename), \
                patch.object(bind, "_bind", bind_mount), patch.object(bind, "_make_private", make_private):
            with self.assertRaisesRegex(ValueError, "exact copied directory"):
                bind.switch_roots(fixture.request, events.append)

        self.assertEqual(bind_mount.call_count, 1)
        self.assert_first_root_retained(fixture, events, real_rename, bind_mount, make_private)
        self.assertNotIn("bind-verified", [event["step"] for event in events])

    def test_parent_becoming_shared_at_bind_intent_refuses_bind(self):
        fixture = BindScenario(self)
        events = []

        def record(event):
            events.append(event)
            if event["step"] == "bind-intent":
                fixture.parent_propagation = "shared"

        scope, destination, mount_info, _ = fixture.switch_mocks(record=events)
        make_underlay, directory_fd, same_directory_fd, _underlay_state = fixture.private_underlay_mocks(self)
        real_rename = Mock(wraps=bind._rename_noreplace)
        bind_mount = Mock()
        make_private = Mock()
        with patch.object(bind.os, "geteuid", return_value=0), scope, destination, mount_info, \
                make_underlay, directory_fd, same_directory_fd, \
                patch.object(bind, "_rename_noreplace", real_rename), \
                patch.object(bind, "_bind", bind_mount), patch.object(bind, "_make_private", make_private):
            with self.assertRaisesRegex(ValueError, "private mount"):
                bind.switch_roots(fixture.request, record)

        self.assert_first_root_retained(fixture, events, real_rename, bind_mount, make_private)
        bind_mount.assert_not_called()


class BindResultValidationTests(unittest.TestCase):
    def scenario(self):
        volume_id = "1" * 32
        filesystem_uuid = "11111111-2222-4333-8444-555555555555"
        request = {"volume_id": volume_id}
        linux = {
            "filesystem_uuid": filesystem_uuid,
            "source_roots": {
                "state": {
                    "canonical_root": "/srv/fullmag/storage/runs/docker-all/session-store",
                    "device": 101,
                    "inode": 201,
                },
                "user_data": {
                    "canonical_root": "/srv/fullmag/storage/user-data/worktree-a",
                    "device": 101,
                    "inode": 202,
                },
            },
        }
        copy_result = {
            "data_sha256": "a" * 64,
            "copied_roots": {
                "state": "/mnt/fullmag-new/payload/runs/docker-all/session-store",
                "user_data": "/mnt/fullmag-new/payload/user-data/worktree-a",
            },
        }
        roots = {}
        for role, source in linux["source_roots"].items():
            canonical = Path(source["canonical_root"])
            roots[role] = {
                "role": role,
                "canonical_root": str(canonical),
                "backup_root": str(canonical.with_name(
                    "." + canonical.name + ".fullmag-before-" + volume_id
                )),
                "copied_root": copy_result["copied_roots"][role],
                "original_identity": {key: source[key] for key in ("device", "inode")},
                "underlay_identity": {"device": source["device"], "inode": 300 + len(roots)},
                "bound_identity": {"device": 501 + len(roots), "inode": 400 + len(roots)},
                "mount": {
                    "target": str(canonical),
                    "fstype": "ext4",
                    "uuid": filesystem_uuid,
                    "options": "rw,nodev,nosuid,noatime",
                    "propagation": "private",
                },
            }
        switch = {
            "schema": "fullmag.data-volume-bind-result.v1",
            "state": "binds-switched-not-admitted",
            "volume_id": volume_id,
            "filesystem_uuid": filesystem_uuid,
            "data_sha256": copy_result["data_sha256"],
            "roots": roots,
            "namespace_admitted": False,
            "originals_retired": False,
        }
        return request, linux, copy_result, switch

    def test_pure_validator_accepts_exact_switch_without_mutating_inputs(self):
        request, linux, copy_result, switch = self.scenario()
        before = copy.deepcopy((request, linux, copy_result, switch))

        result = bind.validate_switch_result(switch, request, linux, copy_result)

        self.assertIsNone(result)
        self.assertEqual((request, linux, copy_result, switch), before)

    def test_pure_validator_rejects_scope_identity_and_mount_drift(self):
        mutations = (
            ("closed top-level keys", lambda switch, _request, _linux: switch.update(extra=True)),
            ("volume identity", lambda switch, _request, _linux: switch.update(volume_id="e" * 32)),
            ("filesystem UUID", lambda switch, _request, _linux: switch.update(filesystem_uuid="e" * 36)),
            ("canonical path", lambda switch, _request, _linux: switch["roots"]["state"].update(
                canonical_root="/srv/foreign/state"
            )),
            ("root closed keys", lambda switch, _request, _linux: switch["roots"]["state"].update(extra=True)),
            ("underlay device", lambda switch, _request, _linux: switch["roots"]["state"].update(
                underlay_identity={"device": 999, "inode": 301}
            )),
            ("bound device", lambda switch, _request, _linux: switch["roots"]["state"].update(
                bound_identity={"device": 101, "inode": 401}
            )),
            ("mount UUID", lambda switch, _request, _linux: switch["roots"]["state"]["mount"].update(
                uuid="22222222-2222-4222-8222-222222222222"
            )),
            ("shared propagation", lambda switch, _request, _linux: switch["roots"]["state"]["mount"].update(
                propagation="shared"
            )),
            ("authority flag", lambda switch, _request, _linux: switch.update(namespace_admitted=True)),
        )
        for label, mutate in mutations:
            with self.subTest(label=label):
                request, linux, copy_result, switch = self.scenario()
                mutate(switch, request, linux)
                with self.assertRaises(ValueError):
                    bind.validate_switch_result(switch, request, linux, copy_result)

    def test_pure_module_import_does_not_load_host_bind_job(self):
        scripts = str(Path(__file__).resolve().parent)
        code = (
            "import sys; sys.path.insert(0, sys.argv[1]); "
            "import fullmag_data_volume_bind; "
            "assert callable(fullmag_data_volume_bind.validate_switch_result); "
            "assert 'docker_data_volume_bind_job' not in sys.modules"
        )
        subprocess.run(
            [sys.executable, "-B", "-I", "-c", code, scripts],
            check=True,
            capture_output=True,
            text=True,
        )


if __name__ == "__main__":
    unittest.main()
