"""Operational Linux host/guest storage checks without Docker or compilation."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch

import linux_native_host as host

spec = importlib.util.spec_from_file_location("linux_host_guest_probe",
    Path(__file__).resolve().parents[1] / "docker/all-in-one/linux_native_probe.py")
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
IMAGE = "sha256:" + "a" * 64
ASSEMBLY = {"image_id": IMAGE, "commit": "b" * 40, "build_receipt_sha256": "c" * 64,
            "binary_hashes": {}}


@unittest.skipUnless(os.name == "posix", "POSIX operational storage")
class LinuxNativeHostTests(unittest.TestCase):
    def native(self, state):
        return {"host_root": str(state), "host_filesystem": "ext4", "host_device": state.stat().st_dev,
                "host_platform": "linux", "host_root_no_reparse": True}

    def test_real_publication_lock_sqlite_and_bound_certificate_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            certificate_path = state / host.CERTIFICATE_NAME
            with patch.object(host, "local_volume", return_value=self.native(state)):
                certificate = host.attest(state, ASSEMBLY, "engine", {})
                host.publish_evidence(certificate_path, certificate)
                inode = certificate_path.stat().st_ino
                env = {"FULLMAG_RUNTIME_IMAGE_ID": IMAGE,
                       "FULLMAG_DOCKER_HOST_ID": hashlib.sha256(b"engine").hexdigest()}
                with patch.dict(os.environ, env), \
                     patch.object(guest.subprocess, "check_output", return_value="ef53"):
                    def invoke(*args, **kwargs):
                        guest.run(False, state, certificate_path)
                        return "storage verified"
                    host.complete_preflight(invoke, "container", state, certificate_path, certificate,
                                            log_writer=lambda output: None)
                    guest.validate_host(state, certificate_path)
                self.assertEqual(certificate_path.stat().st_ino, inode)
                self.assertTrue(certificate["restart_verified"])
                self.assertEqual(json.loads(host.read_owned_regular(state / host.OWNER_NAME)), certificate)
                evidence = json.loads(host.read_owned_regular(state / ".linux-native-probe.json"))
                self.assertEqual(evidence["host_attestation_sha256"],
                                 hashlib.sha256(certificate_path.read_bytes()).hexdigest())

    def test_recreate_retains_owner_and_refuses_another_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            certificate_path = state / host.CERTIFICATE_NAME
            with patch.object(host, "local_volume", return_value=self.native(state)):
                certificate = host.attest(state, ASSEMBLY, "engine", {})
                host.publish_evidence(certificate_path, certificate)
                reuse = {"state": state, "host_certificate": certificate_path, "receipt": {"image_id": IMAGE}}
                with self.assertRaisesRegex(ValueError, "ownership"):
                    host.reuse_certificate(reuse, ASSEMBLY, "another-engine")
                replacement = {**ASSEMBLY, "image_id": "sha256:" + "d" * 64}
                rotated = host.reuse_certificate(reuse, replacement, "engine")
            self.assertEqual(rotated["owner_token"], certificate["owner_token"])
            self.assertEqual(rotated["image_id"], replacement["image_id"])
            self.assertFalse(rotated["restart_verified"])

    def test_no_follow_and_unshared_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_bytes(b"original")
            (root / "link").symlink_to(target)
            with self.assertRaises(host.storage.StorageError):
                host.read_owned_regular(root / "link")
            os.link(target, root / "hardlink")
            with self.assertRaisesRegex(ValueError, "bounded regular"):
                host.read_owned_regular(target)

    def test_runtime_acl_grants_operator_and_fixed_uid_without_world_access(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            host.admit_runtime_uid(root)
            for name in ("system.posix_acl_access", "system.posix_acl_default"):
                raw = os.getxattr(root, name)
                self.assertEqual(struct.unpack_from("<I", raw)[0], 2)
                entries = [struct.unpack_from("<HHI", raw, position) for position in range(4, len(raw), 8)]
                self.assertIn((2, 7, 65532), entries)
                self.assertIn((2, 7, os.getuid()), entries)
                self.assertIn((32, 0, 0xffffffff), entries)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode) & 7, 0)

    def test_fresh_nested_mount_parents_have_writable_runtime_acl(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared = host.prepare_runtime_directories(root)
            self.assertEqual(prepared, host.RUNTIME_DIRECTORIES)
            self.assertEqual(sorted(path.name for path in root.iterdir()), ["runs"])
            for path in (root, *(root / relative for relative in prepared)):
                self.assertEqual(path.stat().st_uid, os.getuid())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 7, 0)
                for name in ("system.posix_acl_access", "system.posix_acl_default"):
                    raw = os.getxattr(path, name)
                    entries = [struct.unpack_from("<HHI", raw, index)
                               for index in range(4, len(raw), 8)]
                    self.assertIn((2, 7, 65532), entries)
                    self.assertIn((16, 7, 0xffffffff), entries)
                descriptor = os.open(path / "write-probe", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o660)
                os.close(descriptor)

    def test_existing_nested_mount_parent_is_retained_without_acl_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runs = root / "runs"
            runs.mkdir(mode=0o750)
            sentinel = runs / "retained"
            sentinel.write_bytes(b"existing state")
            before = {path: (path.stat().st_mode, os.listxattr(path)) for path in (root, runs)}
            with self.assertRaisesRegex(ValueError, "already contains runs"):
                host.prepare_runtime_directories(root)
            self.assertEqual(sentinel.read_bytes(), b"existing state")
            self.assertEqual(before, {path: (path.stat().st_mode, os.listxattr(path)) for path in (root, runs)})

    def test_nested_mount_parent_link_is_rejected_without_touching_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state, outside = root / "state", root / "outside"
            state.mkdir()
            outside.mkdir()
            (state / "runs").symlink_to(outside, target_is_directory=True)
            before = outside.stat().st_mode
            with self.assertRaisesRegex(ValueError, "already contains runs"):
                host.prepare_runtime_directories(state)
            self.assertEqual(list(outside.iterdir()), [])
            self.assertEqual(outside.stat().st_mode, before)


if __name__ == "__main__":
    unittest.main()
