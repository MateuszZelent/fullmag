"""Metadata-only checks for a WSL local Docker Desktop alias root."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

import docker_group_local_filesystem_alias as subject
from docker_build_control import BuildControlError, canonical
from docker_foreign_bind_identity import WSL_ALIAS


class LocalFilesystemAliasTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "aliases"
        self.root.mkdir()
        self.alias_id = "a" * 64
        self.alias = WSL_ALIAS + "Ubuntu2/" + self.alias_id
        self.local = self.root / self.alias_id
        self.local.mkdir()
        self.mountinfo = Path(self.temp.name) / "mountinfo"
        self.mountinfo.write_bytes(self._mountinfo())

    def tearDown(self):
        self.temp.cleanup()

    def _mount_row(self, mount_id, device, mountpoint, *, root="/backing/alias", fstype="ext4",
                   source="/proc/self/fd/5[/backing/alias]"):
        return (f"{mount_id} 1 {device} {root} {mountpoint} rw - {fstype} {source} rw\n")

    def _mountinfo(self, *, root_device=None, nested=(), fstype="ext4", source=None):
        device_number = os.stat(self.local).st_dev if root_device is None else root_device
        device = f"{os.major(device_number)}:{os.minor(device_number)}"
        source = source or "/proc/self/fd/5[/backing/alias]"
        rows = [self._mount_row(10, device, str(self.local), fstype=fstype, source=source)]
        rows.append(self._mount_row(8, "0:99", "/run", root="/", fstype="tmpfs", source="tmpfs"))
        rows.extend(nested)
        return "".join(rows).encode()

    def _prove(self, *, protected_devices=None, mountinfo_path=None):
        devices = ([os.makedev(2128, 1)] if protected_devices is None else protected_devices)
        with mock.patch.object(subject, "LOCAL_ALIAS_ROOT", self.root), \
             mock.patch.object(subject, "MOUNTINFO_PATH", mountinfo_path or self.mountinfo):
            return subject.prove_alias(self.alias, devices)

    def test_proves_stable_cross_filesystem_alias_without_reading_its_tree(self):
        protected = [os.makedev(2128, 1), os.makedev(2112, 1)]
        proof = self._prove(protected_devices=protected)
        self.assertEqual(proof["schema"], subject.PROOF_SCHEMA)
        self.assertEqual(proof["decision"], "disjoint")
        self.assertEqual(proof["alias"], self.alias)
        self.assertEqual(proof["root_device"], os.stat(self.local).st_dev)
        self.assertEqual(proof["root_stat_before"], proof["root_stat_after"])
        self.assertEqual(len(proof["mounts"]), 1)
        self.assertEqual(proof["mounts"][0]["filesystem_type"], "ext4")
        self.assertEqual(proof["proof_sha256"], subject.proof_sha256(proof))
        with mock.patch.object(subject, "LOCAL_ALIAS_ROOT", self.root):
            self.assertEqual(subject.validate_proof(proof), proof)

    def test_unrelated_windows_mount_root_is_not_interpreted_as_a_linux_candidate(self):
        unrelated = (r"33 1 0:99 \134\134server\134share /mnt/foreign rw - 9p drvfs rw" + "\n").encode()
        self.mountinfo.write_bytes(self._mountinfo() + unrelated)
        proof = self._prove()
        self.assertEqual(proof["decision"], "disjoint")
        self.assertEqual(len(proof["mounts"]), 1)

    def test_returns_none_only_for_same_protected_root_device(self):
        root_device = os.stat(self.local).st_dev
        self.assertIsNone(self._prove(protected_devices=[root_device]))

    def test_accepts_single_link_regular_file_root_without_reading_contents(self):
        self.local.rmdir()
        self.local.write_bytes(b"metadata only; never opened by the proof")
        self.mountinfo.write_bytes(self._mountinfo())
        proof = self._prove()
        self.assertTrue(stat.S_ISREG(proof["root_stat_before"]["mode"]))
        self.assertEqual(proof["root_stat_before"]["nlink"], 1)

    def test_rejects_multilink_regular_file_root_and_empty_protected_set(self):
        self.local.rmdir()
        self.local.write_bytes(b"do not read")
        os.link(self.local, self.root / "other-name")
        self.mountinfo.write_bytes(self._mountinfo())
        with self.assertRaisesRegex(BuildControlError, "single-link"):
            self._prove()
        with self.assertRaisesRegex(BuildControlError, "protected device set is empty"):
            self._prove(protected_devices=[])

    def test_rejects_nested_mount_on_any_protected_device(self):
        root_device = os.stat(self.local).st_dev
        protected = os.makedev(2160, 7)
        nested = self._mount_row(11, f"{os.major(protected)}:{os.minor(protected)}",
                                 str(self.local / "child"), root="/shared/child")
        self.mountinfo.write_bytes(self._mountinfo(root_device=root_device, nested=(nested,)))
        with self.assertRaisesRegex(BuildControlError, "protected device"):
            self._prove(protected_devices=[protected])

    def test_rejects_missing_or_symlinked_alias_root(self):
        self.local.rmdir()
        with self.assertRaisesRegex(BuildControlError, "root"):
            self._prove()

        target = Path(self.temp.name) / "target"
        target.mkdir()
        self.local.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(BuildControlError, "symlink"):
            self._prove()

    def test_rejects_malformed_alias_and_non_boolean_protected_device(self):
        with mock.patch.object(subject, "LOCAL_ALIAS_ROOT", self.root), \
             mock.patch.object(subject, "MOUNTINFO_PATH", self.mountinfo):
            with self.assertRaisesRegex(BuildControlError, "alias"):
                subject.prove_alias(WSL_ALIAS + "Ubuntu2/../outside", [])
            with self.assertRaisesRegex(BuildControlError, "device"):
                subject.prove_alias(self.alias, [True])

    def test_rejects_root_stat_device_mismatch(self):
        wrong_device = os.makedev(99, 99)
        self.mountinfo.write_bytes(self._mountinfo(root_device=wrong_device))
        with self.assertRaisesRegex(BuildControlError, "stat device"):
            self._prove()

    def test_rejects_mountinfo_drift_between_snapshots(self):
        first = self._mountinfo()
        second = self._mountinfo().replace(b"/backing/alias", b"/backing/changed")
        with mock.patch.object(subject, "LOCAL_ALIAS_ROOT", self.root), \
             mock.patch.object(subject, "_read_mountinfo", side_effect=(first, second)):
            with self.assertRaisesRegex(BuildControlError, "mountinfo changed"):
                subject.prove_alias(self.alias, [os.makedev(2128, 1)])

    def test_rejects_alias_root_stat_drift(self):
        original = subject._stat_path

        def changed(path):
            result = original(path)
            result["inode"] += 1
            return result

        with mock.patch.object(subject, "LOCAL_ALIAS_ROOT", self.root), \
             mock.patch.object(subject, "MOUNTINFO_PATH", self.mountinfo), \
             mock.patch.object(subject, "_stat_path", side_effect=changed):
            with self.assertRaisesRegex(BuildControlError, "root stat changed"):
                subject.prove_alias(self.alias, [os.makedev(2128, 1)])

    def test_rejects_windows_or_unverified_filesystem_sources(self):
        self.mountinfo.write_bytes(self._mountinfo(fstype="9p", source="drvfs"))
        with self.assertRaisesRegex(BuildControlError, "filesystem"):
            self._prove()
        self.mountinfo.write_bytes(self._mountinfo(source="//server/share"))
        with self.assertRaisesRegex(BuildControlError, "source"):
            self._prove()

    def test_rejects_invalid_or_tampered_proof(self):
        proof = self._prove()
        changed = dict(proof)
        changed["root_inode"] += 1
        with mock.patch.object(subject, "LOCAL_ALIAS_ROOT", self.root):
            with self.assertRaisesRegex(BuildControlError, "root stat identity"):
                subject.validate_proof(changed)


if __name__ == "__main__":
    unittest.main()
