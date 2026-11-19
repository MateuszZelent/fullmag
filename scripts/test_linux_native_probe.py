"""Source-level regressions for the explicit Linux Docker session profile."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("linux_native_probe", Path(__file__).resolve().parents[1] / "docker/all-in-one/linux_native_probe.py")
probe = importlib.util.module_from_spec(SPEC)
if sys.platform.startswith("linux"):
    SPEC.loader.exec_module(probe)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux guest syscalls required")
class LinuxNativeProbeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name)
        self.certificate = self.state / "certificate.json"
        self.image = "sha256:" + "a" * 64
        self.payload = ("b" * 32 + ":" + self.image).encode()
        self.host = {"schema": "fullmag.linux-native-host.v1", "storage_profile": "linux-native-v1",
                     "role": "session", "owner_scope": "docker-linux",
                     "owner_token": "b" * 32, "engine_id": "engine", "image_id": self.image,
                     "restart_expected_sha256": hashlib.sha256(self.payload).hexdigest(), "restart_verified": False}
        (self.state / ".linux-native-sentinel").write_bytes(self.payload)
        self.publish()
        self.environment = patch.dict(os.environ, FULLMAG_RUNTIME_IMAGE_ID=self.image,
                                           FULLMAG_DOCKER_HOST_ID=hashlib.sha256(b"engine").hexdigest())
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def publish(self):
        self.certificate.write_text(json.dumps(self.host))
        (self.state / ".fullmag-linux-native-owner.json").write_text(json.dumps(self.host))

    def test_roundtrip_binds_real_probe_results_to_final_certificate_and_namespace(self):
        with patch.object(probe.subprocess, "check_output", return_value="ef53\n"):
            first = probe.run(False, self.state, self.certificate)
            self.assertTrue(all(first["checks"].values()))
            self.host["restart_verified"] = True
            self.publish()
            final = probe.run(True, self.state, self.certificate)
        self.assertEqual(final["host_attestation_sha256"], hashlib.sha256(self.certificate.read_bytes()).hexdigest())
        self.assertEqual(final["mount_namespace_inode"], Path("/proc/self/ns/mnt").stat().st_ino)
        self.assertEqual(set(final["checks"]), set(probe.CHECKS))
        self.assertEqual((self.state / ".linux-native-restart").read_bytes(), self.payload)

    def test_diagnostic_probe_preserves_default_evidence_and_bound_inode(self):
        self.host["restart_verified"] = True
        self.publish()
        (self.state / ".linux-native-restart").write_bytes(self.payload)
        default = self.state / ".linux-native-probe.json"
        default.write_bytes(b"retained-backend-evidence")
        private = self.state / "diagnostic.json"
        private.write_bytes(b"{}")
        inode = private.stat().st_ino
        with patch.object(probe.subprocess, "check_output", return_value="ef53\n"):
            evidence = probe.run(True, self.state, self.certificate, evidence_path=private)
        self.assertEqual(private.stat().st_ino, inode)
        self.assertEqual(default.read_bytes(), b"retained-backend-evidence")
        self.assertEqual(json.loads(private.read_bytes()), evidence)
        self.assertTrue(all(evidence["checks"].values()))
        self.assertEqual(evidence["mount_namespace_inode"], Path("/proc/self/ns/mnt").stat().st_ino)

    def test_bound_probe_refuses_links_and_unverified_restart(self):
        target = self.state / "diagnostic.json"
        target.write_bytes(b"{}")
        for hard in (False, True):
            alias = self.state / ("hard" if hard else "symbolic")
            if hard:
                os.link(target, alias)
            else:
                alias.symlink_to(target)
            with self.assertRaises((RuntimeError, OSError)):
                probe.publish_bound_evidence(alias, b"changed")
            self.assertEqual(target.read_bytes(), b"{}")
        with patch.object(probe.subprocess, "check_output", return_value="ef53\n"):
            with self.assertRaisesRegex(RuntimeError, "verified restart"):
                probe.run(False, self.state, self.certificate, evidence_path=target)
        self.assertEqual(target.read_bytes(), b"{}")

    def test_guest_evidence_remains_readable_with_restrictive_umask(self):
        previous = os.umask(0o077)
        try:
            with patch.object(probe.subprocess, "check_output", return_value="ef53\n"):
                probe.run(False, self.state, self.certificate)
        finally:
            os.umask(previous)
        self.assertEqual((self.state / ".linux-native-probe.json").stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.state / ".linux-native-restart").stat().st_mode & 0o777, 0o644)

    def test_engine_from_another_daemon_is_rejected(self):
        with patch.dict(os.environ, FULLMAG_DOCKER_HOST_ID="c" * 64):
            with self.assertRaisesRegex(RuntimeError, "engine differs"):
                probe.validate_host(self.state, self.certificate, require_restart=False)

    def test_symlinked_parent_is_rejected_without_following_it(self):
        directory = self.state / "real"
        directory.mkdir()
        (directory / "data").write_bytes(b"secret")
        (self.state / "alias").symlink_to(directory, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            probe.read_regular(self.state / "alias" / "data")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            probe._publish(self.state / "alias" / "data", b"changed")
        self.assertEqual((directory / "data").read_bytes(), b"secret")

    def test_publication_refuses_existing_symlink_or_hardlink(self):
        target = self.state / "target"
        target.write_bytes(b"foreign")
        link = self.state / "publication"
        link.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, "refuses links"):
            probe._publish(link, b"changed")
        link.unlink()
        os.link(target, link)
        with self.assertRaisesRegex(RuntimeError, "refuses links"):
            probe._publish(link, b"changed")
        self.assertEqual(target.read_bytes(), b"foreign")

    def test_role_and_owner_scope_must_match_linux_session_admission(self):
        for field, value in (("role", "build"), ("owner_scope", "docker-desktop-linux")):
            with self.subTest(field=field):
                original = self.host[field]
                self.host[field] = value
                self.publish()
                with self.assertRaisesRegex(RuntimeError, "scope/owner/image"):
                    probe.validate_host(self.state, self.certificate, require_restart=False)
                self.host[field] = original
                self.publish()

    def test_unverified_restart_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "restart readback"):
            probe.validate_host(self.state, self.certificate)

    def test_owner_difference_is_rejected(self):
        (self.state / ".fullmag-linux-native-owner.json").write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "scope/owner/image"):
            probe.validate_host(self.state, self.certificate, require_restart=False)

    def test_symlinked_certificate_is_rejected(self):
        link = self.state / "link"
        link.symlink_to(self.certificate)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            probe.validate_host(self.state, link, require_restart=False)

    def test_unsupported_filesystem_is_rejected(self):
        with patch.object(probe.subprocess, "check_output", return_value="794c7630\n"):
            with self.assertRaisesRegex(RuntimeError, "ext4, xfs or btrfs"):
                probe.run(False, self.state, self.certificate)

    def test_readback_from_another_owner_is_rejected(self):
        (self.state / ".linux-native-restart").write_bytes(b"foreign-owner")
        with patch.object(probe.subprocess, "check_output", return_value="ef53\n"):
            with self.assertRaisesRegex(RuntimeError, "another owner"):
                probe.run(False, self.state, self.certificate)


if __name__ == "__main__":
    unittest.main()
