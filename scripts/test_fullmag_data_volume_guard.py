import errno
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

from scripts import fullmag_data_volume_guard as guard


FILESYSTEM_UUID = "123e4567-e89b-12d3-a456-426614174000"


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux filesystem UUID ioctl")
class FilesystemUuidReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix=".fullmag-filesystem-uuid-test-",
            dir=Path(__file__).resolve().parents[1],
        )
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def _write_uuid(self, descriptor, request, buffer, mutate=True, *, length=16, raw=None, result=0):
        self.assertEqual(request, 0x80111500)
        self.assertTrue(mutate)
        buffer[0] = length
        buffer[1:17] = uuid.UUID(FILESYSTEM_UUID).bytes if raw is None else raw
        return result

    def _directory_fd(self):
        return os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def test_filesystem_uuid_ioctl_uses_owned_duplicate_and_preserves_caller_fd(self):
        descriptor = self._directory_fd()
        duplicate = []

        def ioctl(fd, request, buffer, mutate=True):
            self.assertNotEqual(fd, descriptor)
            os.fstat(fd)
            duplicate.append(fd)
            return self._write_uuid(fd, request, buffer, mutate)

        try:
            with patch("fcntl.ioctl", side_effect=ioctl):
                self.assertEqual(guard.filesystem_uuid_from_fd(descriptor), FILESYSTEM_UUID)
            os.fstat(descriptor)
            self.assertEqual(len(duplicate), 1)
            with self.assertRaises(OSError) as error:
                os.fstat(duplicate[0])
            self.assertEqual(error.exception.errno, errno.EBADF)
        finally:
            os.close(descriptor)

    def test_filesystem_uuid_ioctl_rejects_unsupported_short_invalid_and_zero_results(self):
        descriptor = self._directory_fd()
        try:
            cases = (
                ("unsupported ioctl", OSError(errno.ENOTTY, "unsupported")),
                ("nonzero result", None),
                ("short UUID", None),
                ("zero UUID", None),
            )
            for label, error in cases:
                with self.subTest(label=label):
                    if error is not None:
                        mocked = patch("fcntl.ioctl", side_effect=error)
                    elif label == "nonzero result":
                        mocked = patch("fcntl.ioctl", side_effect=lambda fd, req, buf, mutate=True:
                                       self._write_uuid(fd, req, buf, mutate, result=1))
                    elif label == "short UUID":
                        mocked = patch("fcntl.ioctl", side_effect=lambda fd, req, buf, mutate=True:
                                       self._write_uuid(fd, req, buf, mutate, length=15))
                    else:
                        mocked = patch("fcntl.ioctl", side_effect=lambda fd, req, buf, mutate=True:
                                       self._write_uuid(fd, req, buf, mutate, raw=bytes(16)))
                    with mocked, self.assertRaises((OSError, ValueError)):
                        guard.filesystem_uuid_from_fd(descriptor)
                    os.fstat(descriptor)
        finally:
            os.close(descriptor)

    def test_filesystem_uuid_ioctl_rejects_non_directory_before_ioctl(self):
        regular = self.root / "ordinary-file"
        regular.write_bytes(b"x")
        descriptor = os.open(regular, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            with patch("fcntl.ioctl") as ioctl, self.assertRaises(ValueError):
                guard.filesystem_uuid_from_fd(descriptor)
            ioctl.assert_not_called()
            os.fstat(descriptor)
        finally:
            os.close(descriptor)

    def test_resolve_mount_uuid_uses_null_fallback_and_checks_pinned_major_minor(self):
        metadata = os.stat(self.root, follow_symlinks=False)
        major_minor = f"{os.major(metadata.st_dev)}:{os.minor(metadata.st_dev)}"
        other = "1:1" if major_minor != "1:1" else "2:2"
        with patch("fcntl.ioctl", side_effect=lambda fd, req, buf, mutate=True:
                   self._write_uuid(fd, req, buf, mutate)) as ioctl:
            self.assertEqual(
                guard.resolve_mount_uuid(self.root, None, major_minor=major_minor),
                FILESYSTEM_UUID,
            )
            self.assertEqual(ioctl.call_count, 1)
            with self.assertRaises(ValueError):
                guard.resolve_mount_uuid(self.root, None, major_minor=other)
            self.assertEqual(ioctl.call_count, 1)

    def test_resolve_mount_uuid_checks_supplied_device_even_when_uuid_was_reported(self):
        metadata = os.stat(self.root, follow_symlinks=False)
        major_minor = f"{os.major(metadata.st_dev)}:{os.minor(metadata.st_dev)}"
        other = "1:1" if major_minor != "1:1" else "2:2"
        with patch("fcntl.ioctl") as ioctl:
            self.assertEqual(
                guard.resolve_mount_uuid(self.root, FILESYSTEM_UUID, major_minor=major_minor),
                FILESYSTEM_UUID,
            )
            with self.assertRaises(ValueError):
                guard.resolve_mount_uuid(self.root, FILESYSTEM_UUID, major_minor=other)
            ioctl.assert_not_called()

    def test_resolve_mount_uuid_preserves_reported_value_and_rejects_bad_fallback_paths(self):
        with patch("fcntl.ioctl") as ioctl:
            self.assertEqual(
                guard.resolve_mount_uuid(self.root / "absent", FILESYSTEM_UUID),
                FILESYSTEM_UUID,
            )
            with self.assertRaises(ValueError):
                guard.resolve_mount_uuid(self.root / "absent", None)
            real = self.root / "real"
            real.mkdir()
            symlink = self.root / "link"
            symlink.symlink_to(real, target_is_directory=True)
            with self.assertRaises(ValueError):
                guard.resolve_mount_uuid(symlink, None)
            ioctl.assert_not_called()

    def test_findmnt_explicit_null_uuid_resolves_from_directory_fd(self):
        metadata = os.stat(self.root, follow_symlinks=False)
        major_minor = f"{os.major(metadata.st_dev)}:{os.minor(metadata.st_dev)}"
        payload = {
            "filesystems": [{
                "target": str(self.root),
                "fstype": "ext4",
                "uuid": None,
                "maj:min": major_minor,
            }]
        }
        result = type("Completed", (), {
            "returncode": 0,
            "stdout": json.dumps(payload).encode(),
            "stderr": b"",
        })()
        with patch.object(guard.subprocess, "run", return_value=result), patch(
            "fcntl.ioctl", side_effect=lambda fd, req, buf, mutate=True:
            self._write_uuid(fd, req, buf, mutate),
        ):
            observed = guard._run_findmnt(self.root)
        self.assertEqual(observed["filesystem_uuid"], FILESYSTEM_UUID)

    def test_findmnt_rejects_missing_ambiguous_and_invalid_uuid_fields(self):
        cases = (
            ("missing", {"target": str(self.root), "fstype": "ext4"}),
            ("ambiguous", {"target": str(self.root), "fstype": "ext4", "UUID": None,
                           "uuid": None}),
            ("wrong type", {"target": str(self.root), "fstype": "ext4", "uuid": False}),
            ("empty", {"target": str(self.root), "fstype": "ext4", "uuid": ""}),
        )
        for label, row in cases:
            result = type("Completed", (), {
                "returncode": 0,
                "stdout": json.dumps({"filesystems": [row]}).encode(),
                "stderr": b"",
            })()
            with self.subTest(label=label), patch.object(
                guard.subprocess, "run", return_value=result
            ), patch("fcntl.ioctl") as ioctl, self.assertRaises(ValueError):
                guard._run_findmnt(self.root)
            ioctl.assert_not_called()


class RegisteredVolumeGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix=".fullmag-data-volume-guard-test-",
            dir=Path(__file__).resolve().parents[1],
        )
        self.root = Path(self.temporary.name)
        self.storage = self.root / "storage"
        self.runtime_root = self.storage / "runtimes" / "test-wt"
        self.mount_root = self.root / "mounted-volume"
        self.user_data_root = self.storage / "user-data" / "fullmag-worktree-test-wt"
        self.state_root = self.runtime_root / "docker-volume-dev" / "attempt"
        self.volume_user_data = self.mount_root / "payload" / "user-data"
        self.volume_state = self.mount_root / "payload" / "state-root"
        for path in (
            self.storage,
            self.runtime_root,
            self.mount_root,
            self.user_data_root,
            self.state_root,
            self.volume_user_data,
            self.volume_state,
        ):
            path.mkdir(parents=True, exist_ok=True)
        self.layout = {
            "storage_root": str(self.storage),
            "runtime_root": str(self.runtime_root),
            "worktree_id": "test-wt",
            "env": {"FULLMAG_PROJECT_ID": "fullmag-0123456789abcdef"},
        }
        self.compose_project = "fullmag-worktree-test-wt"

    def tearDown(self):
        self.temporary.cleanup()

    def registration(self):
        return {
            "schema": "fullmag.user-data-volume.v1",
            "project_id": self.layout["env"]["FULLMAG_PROJECT_ID"],
            "worktree_id": self.layout["worktree_id"],
            "compose_project": self.compose_project,
            "volume_id": "a" * 32,
            "backing_file_windows": r"E:\git\storage\sp4-test.vhdx",
            "backing_file_wsl": "/mnt/e/git/storage/sp4-test.vhdx",
            "filesystem_uuid": FILESYSTEM_UUID,
            "mount_root": str(self.mount_root),
            "datasets": [
                {
                    "role": "user_data",
                    "canonical_root": str(self.user_data_root),
                    "relative_root": "payload/user-data",
                },
                {
                    "role": "state",
                    "canonical_root": str(self.state_root),
                    "relative_root": "payload/state-root",
                },
            ],
            "migration_receipt_sha256": "b" * 64,
            "state": "committed",
        }

    @property
    def index_path(self):
        return self.storage / "index" / "test-wt.json"

    @property
    def registration_path(self):
        return self.storage / "index" / "data-volumes" / "test-wt.json"

    def _write_registration(self, registration=None, raw=None):
        self.registration_path.parent.mkdir(parents=True, exist_ok=True)
        if raw is None:
            raw = json.dumps(
                registration or self.registration(),
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        self.registration_path.write_bytes(raw)
        return raw

    def _write_index(self, raw, *, reference=True, reference_sha=None, legacy_payload=None):
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        index = {
            "schema": "fullmag.worktree.v1",
            "worktree_id": "test-wt",
            "unrelated": {"keep": [1, "value"]},
        }
        if reference:
            index["data_volume_registration"] = {
                "path": str(self.registration_path),
                "sha256": reference_sha or hashlib.sha256(raw).hexdigest(),
                "volume_id": "a" * 32,
            }
        if legacy_payload is not None:
            index["legacy_payload"] = legacy_payload
        self.index_path.write_text(
            json.dumps(index, separators=(",", ":")), encoding="utf-8"
        )

    def _write_active(self, registration=None, raw=None, *, reference=True):
        raw = self._write_registration(registration, raw)
        self._write_index(raw, reference=reference)
        return raw

    def _mount_probe(self, path):
        path = Path(path)
        inode_by_path = {
            self.user_data_root: 101,
            self.state_root: 202,
            self.mount_root: 900,
        }
        return {
            "target": str(path),
            "filesystem": "ext4",
            "filesystem_uuid": FILESYSTEM_UUID,
            "device": 259,
            "inode": inode_by_path[path],
        }

    def _directory_probe(self, path):
        path = Path(path)
        inode_by_path = {
            self.volume_user_data: 101,
            self.volume_state: 202,
        }
        return {"device": 259, "inode": inode_by_path[path]}

    def _probe_mocks(self):
        return (
            patch.object(guard, "_observe_mount", side_effect=self._mount_probe),
            patch.object(guard, "_observe_directory", side_effect=self._directory_probe),
        )

    def _verify(self, **kwargs):
        mount_patch, directory_patch = self._probe_mocks()
        with mount_patch, directory_patch:
            return guard.verify_registered_volume(
                self.layout, self.compose_project, **kwargs
            )

    def test_no_registration_and_no_index_reference_is_a_noop(self):
        original_index = {
            "schema": "fullmag.worktree.v1",
            "worktree_id": "test-wt",
            "unrelated": {"keep": True},
        }
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text(json.dumps(original_index), encoding="utf-8")
        before = self.index_path.read_bytes()

        with patch.object(guard, "_observe_mount") as observe_mount, patch.object(
            guard, "_observe_directory"
        ) as observe_directory:
            self.assertIsNone(
                guard.verify_registered_volume(self.layout, self.compose_project)
            )

        observe_mount.assert_not_called()
        observe_directory.assert_not_called()
        self.assertEqual(self.index_path.read_bytes(), before)
        self.assertFalse(self.registration_path.exists())

    def test_no_index_and_no_registration_is_a_noop(self):
        with patch.object(guard, "_observe_mount") as observe_mount:
            self.assertIsNone(
                guard.verify_registered_volume(self.layout, self.compose_project)
            )
        observe_mount.assert_not_called()

    def test_large_legacy_index_without_opt_in_is_a_noop(self):
        self._write_index(b"", reference=False, legacy_payload="x" * (300 * 1024))
        before = self.index_path.read_bytes()
        self.assertGreater(len(before), 256 * 1024)

        with patch.object(guard, "_observe_mount") as observe_mount:
            self.assertIsNone(
                guard.verify_registered_volume(self.layout, self.compose_project)
            )

        observe_mount.assert_not_called()
        self.assertEqual(self.index_path.read_bytes(), before)

    def test_no_opt_in_needs_only_storage_root_and_worktree_id(self):
        minimal_layout = {
            "storage_root": str(self.storage),
            "worktree_id": "test-wt",
        }
        with patch.object(guard, "_observe_mount") as observe_mount:
            self.assertIsNone(
                guard.verify_registered_volume(
                    minimal_layout, self.compose_project
                )
            )
        observe_mount.assert_not_called()

    def test_no_opt_in_accepts_legacy_worktree_id_with_dot(self):
        layout = {
            "storage_root": str(self.storage),
            "worktree_id": "fullmag.test-0123456789abcdef",
        }
        with patch.object(guard, "_observe_mount") as observe_mount:
            self.assertIsNone(
                guard.verify_registered_volume(layout, self.compose_project)
            )
        observe_mount.assert_not_called()

    def test_active_registration_returns_verified_model_result_read_only(self):
        raw = self._write_active()
        before_index = self.index_path.read_bytes()
        before_registration = self.registration_path.read_bytes()

        result = self._verify()

        self.assertEqual(
            result,
            {
                "schema": "fullmag.user-data-volume-mounts.v1",
                "state": "verified",
                "volume_id": "a" * 32,
                "filesystem_uuid": FILESYSTEM_UUID,
                "datasets": ["user_data", "state"],
            },
        )
        self.assertEqual(hashlib.sha256(raw).hexdigest(), json.loads(before_index)["data_volume_registration"]["sha256"])
        self.assertEqual(self.index_path.read_bytes(), before_index)
        self.assertEqual(self.registration_path.read_bytes(), before_registration)

    def test_large_index_with_valid_reference_is_accepted(self):
        raw = self._write_registration()
        self._write_index(raw, legacy_payload="x" * (300 * 1024))
        self.assertGreater(self.index_path.stat().st_size, 256 * 1024)

        self.assertEqual(self._verify()["state"], "verified")

    def test_oversized_registration_remains_rejected(self):
        base = json.dumps(
            self.registration(), separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        raw = base + b" " * (256 * 1024 + 1 - len(base))
        self._write_active(raw=raw)
        self.assertGreater(len(raw), 256 * 1024)

        with patch.object(guard, "_observe_mount") as observe_mount:
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)
        observe_mount.assert_not_called()

    def test_registration_without_index_reference_fails_closed(self):
        self._write_active(reference=False)
        with patch.object(guard, "_observe_mount") as observe_mount:
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)
        observe_mount.assert_not_called()

    def test_index_reference_without_registration_fails_closed(self):
        registration = self.registration()
        raw = json.dumps(registration, separators=(",", ":")).encode()
        self._write_index(raw)
        with patch.object(guard, "_observe_mount") as observe_mount:
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)
        observe_mount.assert_not_called()

    def test_registration_digest_drift_fails_before_mount_probe(self):
        raw = self._write_registration()
        self._write_index(raw, reference_sha="c" * 64)
        with patch.object(guard, "_observe_mount") as observe_mount:
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)
        observe_mount.assert_not_called()

    def test_wrong_project_identity_fails_closed(self):
        registration = self.registration()
        registration["project_id"] = "fullmag-fedcba9876543210"
        self._write_active(registration)
        with patch.object(guard, "_observe_mount") as observe_mount:
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)
        observe_mount.assert_not_called()

    def test_state_root_outside_registered_mapped_tree_fails_closed(self):
        self._write_active()
        with patch.object(guard, "_observe_mount") as observe_mount:
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(
                    self.layout,
                    self.compose_project,
                    state_root=self.root / "fresh-state-outside-volume",
                )
        observe_mount.assert_not_called()

    def test_missing_volume_mount_fails_without_fallback(self):
        self._write_active()
        mount_patch, directory_patch = self._probe_mocks()
        with mount_patch as observe_mount, directory_patch:
            observe_mount.side_effect = ValueError("mount not observed")
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)
        self.assertEqual(observe_mount.call_count, 1)

    def test_mount_uuid_drift_fails_closed(self):
        self._write_active()
        mount_patch, directory_patch = self._probe_mocks()
        with mount_patch as observe_mount, directory_patch:
            def wrong_uuid(path):
                observed = self._mount_probe(path)
                if Path(path) == self.state_root:
                    observed["filesystem_uuid"] = "123e4567-e89b-12d3-a456-426614174001"
                return observed
            observe_mount.side_effect = wrong_uuid
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)

    def test_payload_inode_drift_fails_closed(self):
        self._write_active()
        mount_patch, directory_patch = self._probe_mocks()
        with mount_patch, directory_patch as observe_directory:
            def wrong_inode(path):
                observed = self._directory_probe(path)
                if Path(path) == self.volume_state:
                    observed["inode"] += 1
                return observed
            observe_directory.side_effect = wrong_inode
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)

    def test_findmnt_target_drift_fails_closed(self):
        self._write_active()
        mount_patch, directory_patch = self._probe_mocks()
        with mount_patch as observe_mount, directory_patch:
            def wrong_target(path):
                observed = self._mount_probe(path)
                if Path(path) == self.user_data_root:
                    observed["target"] = str(self.user_data_root.parent)
                return observed
            observe_mount.side_effect = wrong_target
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)

    def test_duplicate_json_key_is_rejected(self):
        raw = (
            b'{"schema":"fullmag.user-data-volume.v1",'
            b'"schema":"fullmag.user-data-volume.v1"}'
        )
        self._write_active(raw=raw)
        with patch.object(guard, "_observe_mount") as observe_mount:
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)
        observe_mount.assert_not_called()

    def test_hardlinked_registration_is_rejected(self):
        raw = self._write_active()
        os.link(self.registration_path, self.root / "registration-hardlink.json")
        with patch.object(guard, "_observe_mount") as observe_mount:
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(self.layout, self.compose_project)
        observe_mount.assert_not_called()
        self.assertEqual(self.registration_path.read_bytes(), raw)

    def test_explicit_user_data_root_must_match_registered_root(self):
        self._write_active()
        with patch.object(guard, "_observe_mount") as observe_mount:
            with self.assertRaises(ValueError):
                guard.verify_registered_volume(
                    self.layout,
                    self.compose_project,
                    user_data_root=self.storage / "user-data" / "other",
                )
        observe_mount.assert_not_called()


if __name__ == "__main__":
    unittest.main()
