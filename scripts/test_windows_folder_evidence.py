"""Interpreted publication failure regressions for Docker Windows attestations."""
import json
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import windows_folder_host as host


class WindowsFolderEvidence(unittest.TestCase):
    @staticmethod
    def _assembly(binary_hashes):
        return {
            "image_id": "sha256:" + "1" * 64,
            "commit": "a" * 40,
            "build_receipt_sha256": "b" * 64,
            "source_digest": "f" * 64,
            "source_snapshot_sha256": "d" * 64,
            "binary_hashes": binary_hashes,
        }

    @staticmethod
    def _development_build(binary_hashes):
        return {
            "schema": host.DEVELOPMENT_BUILD_SCHEMA,
            "cargo_profile": "backend-dev",
            "toolchain_image_id": "sha256:" + "2" * 64,
            "package_root": "/opt/fullmag/package",
            "provenance_path": "/opt/fullmag/provenance.json",
            "group_identity": "fullmag-worktree-test",
            "source_identity": {
                "commit": "a" * 40,
                "source_digest": "c" * 64,
                "source_snapshot_sha256": "e" * 64,
                "native_source_identity_sha256": "d" * 64,
            },
        }

    def test_flush_failure_retains_the_previously_published_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}')
            with patch.object(host.os, "fsync", side_effect=OSError("flush failed")), \
                    patch.object(host, "_replace_write_through") as replace:
                with self.assertRaisesRegex(OSError, "flush failed"):
                    host.publish_evidence(target, {"owner": "new"})
                replace.assert_not_called()
            self.assertEqual(json.loads(target.read_text()), {"owner": "original"})
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_replacement_failure_retains_the_previously_published_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}')
            with patch.object(host, "_replace_write_through", side_effect=OSError("publish failed")):
                with self.assertRaisesRegex(OSError, "publish failed"):
                    host.publish_evidence(target, {"owner": "new"})
            self.assertEqual(json.loads(target.read_text()), {"owner": "original"})
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_successfully_published_evidence_is_complete_and_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}')
            value = {"owner": "new", "checks": {"restart": True}}
            host.publish_evidence(target, value)
            self.assertEqual(json.loads(target.read_text()), value)
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_bound_writer_updates_the_existing_certificate_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}\n', encoding="utf-8")
            inode = target.stat().st_ino
            value = {"owner": "new", "checks": {"restart": True}}
            digest = host.write_bound_evidence(target, value)
            self.assertEqual(json.loads(target.read_text()), value)
            self.assertEqual(target.stat().st_ino, inode)
            self.assertEqual(
                digest,
                hashlib.sha256(
                    (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
                ).hexdigest(),
            )

    def test_bound_writer_write_failure_restores_bytes_and_keeps_inode(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            original = b'{"owner": "original"}\n'
            target.write_bytes(original)
            inode = target.stat().st_ino
            real_fsync = host.os.fsync
            calls = 0

            def fail_once(fd):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError("flush failed")
                return real_fsync(fd)

            with patch.object(host.os, "fsync", side_effect=fail_once), \
                    patch.object(host.os, "replace") as replace:
                with self.assertRaisesRegex(OSError, "flush failed"):
                    host.write_bound_evidence(target, {"owner": "new"})
                replace.assert_not_called()
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(target.stat().st_ino, inode)

    def test_bound_writer_rejects_final_and_ancestor_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real_parent = root / "real"
            real_parent.mkdir()
            target = real_parent / "host.json"
            target.write_text('{"owner": "original"}\n', encoding="utf-8")
            final_link = root / "final.json"
            final_link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "reparse point"):
                host.write_bound_evidence(final_link, {"owner": "new"})

            parent_link = root / "linked-parent"
            parent_link.symlink_to(real_parent, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "reparse point"):
                host.write_bound_evidence(parent_link / "host.json", {"owner": "new"})

    def test_attest_emits_typed_development_build_delegation(self):
        binary_hashes = {"fullmag": "e" * 64}
        assembly = self._assembly(binary_hashes)
        development_build = self._development_build(binary_hashes)
        native = {
            "host_root": "C:/fullmag/state",
            "host_filesystem": "NTFS",
            "host_drive_type": 3,
            "host_volume_serial": 42,
            "host_root_no_reparse": True,
        }
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(host, "local_volume", return_value=native), \
                patch.object(host, "prepare_probe_link"), \
                patch.object(host, "publish_evidence") as publish:
            certificate = host.attest(
                directory, assembly, "engine-test", binary_hashes,
                development_build=development_build,
            )
        self.assertEqual(certificate["development_build"], development_build)
        publish.assert_called_once()

    def test_attest_legacy_certificate_has_no_development_delegation(self):
        binary_hashes = {"fullmag": "e" * 64}
        native = {
            "host_root": "C:/fullmag/state",
            "host_filesystem": "NTFS",
            "host_drive_type": 3,
            "host_volume_serial": 42,
            "host_root_no_reparse": True,
        }
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(host, "local_volume", return_value=native), \
                patch.object(host, "prepare_probe_link"), \
                patch.object(host, "publish_evidence"):
            certificate = host.attest(
                directory, self._assembly(binary_hashes), "engine-test", binary_hashes
            )
        self.assertNotIn("development_build", certificate)


if __name__ == "__main__":
    unittest.main()
