import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import fullmag_data_volume_guard as guard


FILESYSTEM_UUID = "123e4567-e89b-12d3-a456-426614174000"


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
