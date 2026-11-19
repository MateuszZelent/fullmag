"""Regression coverage for Linux script-output directory ACL admission."""
from __future__ import annotations

import os
import errno
from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_script_output_permissions as permissions


ACL_VERSION = 2
UNDEFINED = 0xFFFFFFFF
USER_OBJ, USER, GROUP_OBJ, GROUP, MASK, OTHER = 1, 2, 4, 8, 16, 32


def acl(entries):
    ordered = sorted(entries, key=lambda item: (
        {USER_OBJ: 0, USER: 1, GROUP_OBJ: 2, GROUP: 3, MASK: 4, OTHER: 5}[item[0]],
        item[2] if item[0] in {USER, GROUP} else 0,
    ))
    return struct.pack("<I", ACL_VERSION) + b"".join(
        struct.pack("<HHI", *entry) for entry in ordered
    )


def entries(path: Path, name: str):
    raw = os.getxattr(path, name)
    if struct.unpack_from("<I", raw)[0] != ACL_VERSION:
        raise AssertionError("ACL version differs")
    return [struct.unpack_from("<HHI", raw, offset)
            for offset in range(4, len(raw), 8)]


def permissions_for(values, tag, identifier=UNDEFINED):
    return next(value[1] for value in values if value[0] == tag and value[2] == identifier)


def entries_from_raw(raw: bytes):
    if struct.unpack_from("<I", raw)[0] != ACL_VERSION:
        raise AssertionError("ACL version differs")
    return [struct.unpack_from("<HHI", raw, offset)
            for offset in range(4, len(raw), 8)]


class ScriptOutputAclPureTests(unittest.TestCase):
    def test_acl_merge_preserves_old_effective_rights_when_mask_widens(self):
        prior_uid = 14001
        prior_gid = 17001
        prior = acl([
            (USER_OBJ, 7, UNDEFINED),
            (USER, 7, prior_uid),
            (GROUP_OBJ, 7, UNDEFINED),
            (GROUP, 7, prior_gid),
            (MASK, 5, UNDEFINED),
            (OTHER, 5, UNDEFINED),
        ])

        updated = entries_from_raw(permissions._augment_acl(
            prior, operator_uid=1000, runtime_uid=permissions.RUNTIME_UID,
            mode=0o755, default=False,
        ))

        self.assertEqual(permissions_for(updated, MASK), 7)
        self.assertEqual(permissions_for(updated, GROUP_OBJ) & permissions_for(updated, MASK), 5)
        self.assertEqual(permissions_for(updated, USER, prior_uid) & permissions_for(updated, MASK), 5)
        self.assertEqual(permissions_for(updated, GROUP, prior_gid) & permissions_for(updated, MASK), 5)
        self.assertEqual(permissions_for(updated, OTHER), 5)
        self.assertEqual(permissions_for(updated, USER, permissions.RUNTIME_UID), 7)

    def test_default_acl_merge_preserves_old_effective_rights_and_adds_operator(self):
        prior_uid = 14002
        prior_gid = 17002
        prior = acl([
            (USER_OBJ, 7, UNDEFINED),
            (USER, 7, prior_uid),
            (GROUP_OBJ, 5, UNDEFINED),
            (GROUP, 7, prior_gid),
            (MASK, 5, UNDEFINED),
            (OTHER, 5, UNDEFINED),
        ])

        updated = entries_from_raw(permissions._augment_acl(
            prior, operator_uid=1000, runtime_uid=permissions.RUNTIME_UID,
            mode=0o755, default=True,
        ))

        self.assertEqual(permissions_for(updated, USER, prior_uid) & permissions_for(updated, MASK), 5)
        self.assertEqual(permissions_for(updated, GROUP_OBJ) & permissions_for(updated, MASK), 5)
        self.assertEqual(permissions_for(updated, GROUP, prior_gid) & permissions_for(updated, MASK), 5)
        self.assertEqual(permissions_for(updated, USER, 1000), 7)
        self.assertEqual(permissions_for(updated, USER, permissions.RUNTIME_UID), 7)
        self.assertEqual(permissions_for(updated, OTHER), 5)

    def test_malformed_duplicate_entries_are_rejected(self):
        malformed = acl([
            (USER_OBJ, 7, UNDEFINED),
            (USER_OBJ, 7, UNDEFINED),
            (GROUP_OBJ, 5, UNDEFINED),
            (OTHER, 5, UNDEFINED),
        ])
        with self.assertRaises(permissions.ScriptOutputPermissionError):
            permissions._decode_acl(malformed, label="test ACL")

    def test_new_default_acl_grants_operator_and_runtime_without_group_or_other_access(self):
        updated = entries_from_raw(permissions._augment_acl(
            None, operator_uid=1000, runtime_uid=permissions.RUNTIME_UID,
            mode=0o755, default=True,
        ))

        self.assertEqual(permissions_for(updated, USER, 1000), 7)
        self.assertEqual(permissions_for(updated, USER, permissions.RUNTIME_UID), 7)
        self.assertEqual(permissions_for(updated, GROUP_OBJ), 0)
        self.assertEqual(permissions_for(updated, OTHER), 0)
        self.assertEqual(permissions_for(updated, MASK), 7)

    def test_foreign_owner_is_accepted_only_with_effective_access_and_defaults(self):
        operator_uid = 1000
        access = entries_from_raw(permissions._augment_acl(
            None, operator_uid=operator_uid, runtime_uid=permissions.RUNTIME_UID,
            mode=0o770, default=False,
        ))
        default = entries_from_raw(permissions._augment_acl(
            None, operator_uid=operator_uid, runtime_uid=permissions.RUNTIME_UID,
            mode=0o770, default=True,
        ))

        self.assertTrue(permissions._foreign_directory_already_admitted(
            65534, operator_uid, access, default,
        ))
        self.assertFalse(permissions._foreign_directory_already_admitted(
            65534, operator_uid, access, None,
        ))


@unittest.skipUnless(sys.platform.startswith("linux"), "POSIX ACL xattrs require Linux")
class ScriptOutputPermissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-output-acl-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "examples"
        self.nested = self.output / "interactive_study"
        self.nested.mkdir(parents=True)
        os.chmod(self.output, 0o755)
        os.chmod(self.nested, 0o755)

    def test_nested_directories_get_runtime_access_without_touching_files_or_neighbors(self):
        outside = self.root / "outside"
        outside.mkdir()
        sentinel = self.nested / "retained.py"
        sentinel.write_text("keep me\n", encoding="utf-8")
        file_before = (sentinel.stat().st_ino, sentinel.stat().st_mode,
                       sentinel.stat().st_uid, sentinel.read_bytes(), os.listxattr(sentinel))
        outside_before = (outside.stat().st_mode, os.listxattr(outside))

        changed = permissions.prepare_output_tree(self.output)

        self.assertEqual(changed, 2)
        for directory in (self.output, self.nested):
            access = entries(directory, "system.posix_acl_access")
            default = entries(directory, "system.posix_acl_default")
            self.assertEqual(permissions_for(access, USER, permissions.RUNTIME_UID), 7)
            self.assertEqual(permissions_for(default, USER, permissions.RUNTIME_UID), 7)
            self.assertEqual(permissions_for(default, USER, os.getuid()), 7)
            self.assertEqual(permissions_for(default, OTHER), 0)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode) & 0o002, 0)

        created = self.nested / "future-output"
        created.mkdir(mode=0o777)
        inherited = entries(created, "system.posix_acl_access")
        self.assertEqual(permissions_for(inherited, USER, permissions.RUNTIME_UID), 7)
        self.assertEqual(sentinel.read_bytes(), b"keep me\n")
        self.assertEqual((sentinel.stat().st_ino, sentinel.stat().st_mode,
                          sentinel.stat().st_uid, sentinel.read_bytes(), os.listxattr(sentinel)),
                         file_before)
        self.assertEqual(outside_before, (outside.stat().st_mode, os.listxattr(outside)))

    def test_existing_acl_mask_is_widened_without_widening_other_effective_rights(self):
        prior_uid = os.getuid() + 12001
        prior_access = acl([
            (USER_OBJ, 7, UNDEFINED),
            (USER, 7, prior_uid),
            (GROUP_OBJ, 7, UNDEFINED),
            (MASK, 5, UNDEFINED),
            (OTHER, 5, UNDEFINED),
        ])
        prior_default = acl([
            (USER_OBJ, 7, UNDEFINED),
            (USER, 7, prior_uid),
            (GROUP_OBJ, 5, UNDEFINED),
            (MASK, 5, UNDEFINED),
            (OTHER, 5, UNDEFINED),
        ])
        for directory in (self.output, self.nested):
            os.setxattr(directory, "system.posix_acl_access", prior_access)
            os.setxattr(directory, "system.posix_acl_default", prior_default)

        permissions.prepare_output_tree(self.output)

        access = entries(self.output, "system.posix_acl_access")
        default = entries(self.output, "system.posix_acl_default")
        self.assertEqual(permissions_for(access, MASK), 7)
        self.assertEqual(permissions_for(access, GROUP_OBJ) & permissions_for(access, MASK), 5)
        self.assertEqual(permissions_for(access, USER, prior_uid) & permissions_for(access, MASK), 5)
        self.assertEqual(permissions_for(default, MASK), 7)
        self.assertEqual(permissions_for(default, GROUP_OBJ) & permissions_for(default, MASK), 5)
        self.assertEqual(permissions_for(default, USER, prior_uid) & permissions_for(default, MASK), 5)

    def _run_with_mocked_acls(self, fsync):
        state = {}
        writes = []

        def key(descriptor, name):
            info = os.fstat(descriptor)
            return info.st_dev, info.st_ino, name

        def read_acl(descriptor, name, *, label):
            return state.get(key(descriptor, name))

        def write_acl(descriptor, name, value):
            state_key = key(descriptor, name)
            writes.append((state_key, value))
            if value is None:
                state.pop(state_key, None)
            else:
                state[state_key] = value

        with patch.object(permissions, "_raw_acl", side_effect=read_acl), \
             patch.object(permissions, "_write_acl", side_effect=write_acl), \
             patch.object(permissions.os, "fsync", side_effect=fsync):
            with self.assertRaises(permissions.ScriptOutputPermissionError):
                permissions.prepare_output_tree(self.output)
        return state, writes

    def test_fsync_failure_restores_the_acl_written_by_this_admission(self):
        calls = 0

        def fail_once(_descriptor):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError(errno.EIO, "injected directory fsync failure")

        state, writes = self._run_with_mocked_acls(fail_once)

        root_info = self.output.stat()
        access_key = (root_info.st_dev, root_info.st_ino, "system.posix_acl_access")
        self.assertNotIn(access_key, state)
        self.assertEqual(len(writes), 2)
        self.assertIsNotNone(writes[0][1])
        self.assertIsNone(writes[1][1])
        self.assertEqual(calls, 2)

    def test_rollback_preserves_acl_changed_by_another_writer(self):
        calls = 0
        concurrent_acl = b"concurrent ACL change"
        root_info = self.output.stat()
        access_key = (root_info.st_dev, root_info.st_ino, "system.posix_acl_access")
        state_holder = {}

        def fsync_after_concurrent_change(_descriptor):
            nonlocal calls
            calls += 1
            if calls == 1:
                # The ACL write has landed; emulate another writer replacing it
                # before the admission's failed directory fsync is rolled back.
                state_holder[access_key] = concurrent_acl
                raise OSError(errno.EIO, "injected directory fsync failure")

        def read_acl(descriptor, name, *, label):
            info = os.fstat(descriptor)
            return state_holder.get((info.st_dev, info.st_ino, name))

        writes = []

        def write_acl(descriptor, name, value):
            info = os.fstat(descriptor)
            state_key = (info.st_dev, info.st_ino, name)
            writes.append((state_key, value))
            if value is None:
                state_holder.pop(state_key, None)
            else:
                state_holder[state_key] = value

        with patch.object(permissions, "_raw_acl", side_effect=read_acl), \
             patch.object(permissions, "_write_acl", side_effect=write_acl), \
             patch.object(permissions.os, "fsync", side_effect=fsync_after_concurrent_change):
            with self.assertRaises(permissions.ScriptOutputPermissionError) as caught:
                permissions.prepare_output_tree(self.output)

        self.assertIn("rollback was incomplete", str(caught.exception))
        self.assertIn("left untouched", str(caught.exception))
        self.assertEqual(state_holder[access_key], concurrent_acl)
        self.assertEqual(len(writes), 1)

    def test_malformed_acl_is_rejected_before_any_directory_changes(self):
        # The kernel rejects malformed ACL xattrs, so inject malformed bytes
        # only at the xattr read boundary and keep all directory writes real.
        malformed = acl([
            (USER_OBJ, 7, UNDEFINED),
            (USER_OBJ, 7, UNDEFINED),
            (GROUP_OBJ, 5, UNDEFINED),
            (OTHER, 5, UNDEFINED),
        ])
        descriptor = os.open(self.nested, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        self.addCleanup(os.close, descriptor)
        before_root = (self.output.stat().st_mode, os.listxattr(self.output))
        before_nested = (self.nested.stat().st_mode, os.listxattr(self.nested))
        real_getxattr = os.getxattr

        def getxattr(path, name, *args, **kwargs):
            same_directory = isinstance(path, int) and (
                os.fstat(path).st_dev, os.fstat(path).st_ino
            ) == (os.fstat(descriptor).st_dev, os.fstat(descriptor).st_ino)
            if same_directory and name == "system.posix_acl_access":
                return malformed
            return real_getxattr(path, name, *args, **kwargs)

        with patch.object(permissions.os, "getxattr", side_effect=getxattr):
            with self.assertRaises(permissions.ScriptOutputPermissionError):
                permissions.prepare_output_tree(self.output)

        self.assertEqual(before_root, (self.output.stat().st_mode, os.listxattr(self.output)))
        self.assertEqual(before_nested, (self.nested.stat().st_mode, os.listxattr(self.nested)))

    def test_symlink_is_rejected_without_acl_mutation_or_following(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.output / "escape").symlink_to(outside, target_is_directory=True)
        before = {path: os.listxattr(path) for path in (self.output, self.nested, outside)}

        with self.assertRaises(permissions.ScriptOutputPermissionError):
            permissions.prepare_output_tree(self.output)

        self.assertEqual(before, {path: os.listxattr(path) for path in (self.output, self.nested, outside)})
        self.assertEqual(list(outside.iterdir()), [])

    def test_nested_git_administration_is_rejected_before_acl_mutation(self):
        git_dir = self.nested / ".git"
        git_dir.mkdir()
        before = {path: (path.stat().st_mode, os.listxattr(path))
                  for path in (self.output, self.nested, git_dir)}

        with self.assertRaises(permissions.ScriptOutputPermissionError):
            permissions.prepare_output_tree(self.output)

        self.assertEqual(before, {path: (path.stat().st_mode, os.listxattr(path))
                                  for path in (self.output, self.nested, git_dir)})

    def test_directory_bound_is_checked_before_acl_mutation(self):
        before = {path: os.listxattr(path) for path in (self.output, self.nested)}

        with self.assertRaises(permissions.ScriptOutputPermissionError):
            permissions.prepare_output_tree(self.output, max_directories=1)

        self.assertEqual(before, {path: os.listxattr(path) for path in (self.output, self.nested)})

    def test_entry_bound_covers_regular_files_before_acl_mutation(self):
        (self.nested / "one.py").write_text("source\n", encoding="utf-8")
        (self.nested / "two.py").write_text("source\n", encoding="utf-8")
        before = {path: (path.stat().st_mode, os.listxattr(path))
                  for path in (self.output, self.nested)}

        with self.assertRaises(permissions.ScriptOutputPermissionError):
            permissions.prepare_output_tree(self.output, max_entries=2)

        self.assertEqual(before, {path: (path.stat().st_mode, os.listxattr(path))
                                  for path in (self.output, self.nested)})


class ScriptOutputPermissionHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-output-hook-")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "examples"
        self.output.mkdir()

    def test_linux_setup_passes_only_the_explicit_writable_alias_to_acl_helper(self):
        import docker_volume_dev
        document = {"services": {"backend": {"volumes": [
            {"type": "bind", "source": str(self.output),
             "target": "/opt/fullmag/script-output", "read_only": False},
        ]}}}
        with patch.object(docker_volume_dev.storage, "filesystem_type", return_value="ext4"), \
             patch("docker_script_output_permissions.prepare_output_tree", return_value=2) as prepare:
            self.assertEqual(docker_volume_dev._prepare_script_output_permissions(document), 2)
        prepare.assert_called_once_with(self.output)

    def test_windows_host_does_not_call_linux_acl_helper(self):
        import docker_volume_dev
        document = {"services": {"backend": {"volumes": [
            {"type": "bind", "source": str(self.output),
             "target": "/opt/fullmag/script-output", "read_only": False},
        ]}}}
        with patch.object(docker_volume_dev.os, "name", "nt"), \
             patch("docker_script_output_permissions.prepare_output_tree") as prepare:
            self.assertEqual(docker_volume_dev._prepare_script_output_permissions(document), 0)
        prepare.assert_not_called()

    def test_disabled_alias_does_not_touch_the_output_tree(self):
        import docker_volume_dev
        document = {"services": {"backend": {"volumes": []}}}
        with patch("docker_script_output_permissions.prepare_output_tree") as prepare:
            self.assertEqual(docker_volume_dev._prepare_script_output_permissions(document), 0)
        prepare.assert_not_called()

    def test_unsupported_filesystem_is_rejected_before_acl_helper(self):
        import docker_volume_dev
        document = {"services": {"backend": {"volumes": [
            {"type": "bind", "source": str(self.output),
             "target": "/opt/fullmag/script-output", "read_only": False},
        ]}}}
        with patch.object(docker_volume_dev.storage, "filesystem_type", return_value="ntfs"), \
             patch("docker_script_output_permissions.prepare_output_tree") as prepare:
            with self.assertRaises(docker_volume_dev.BuildControlError):
                docker_volume_dev._prepare_script_output_permissions(document)
        prepare.assert_not_called()

    def test_unexpected_output_mount_shape_is_refused_before_acl_helper(self):
        import docker_volume_dev
        document = {"services": {"backend": {"volumes": [
            {"type": "bind", "source": str(self.output),
             "target": "/opt/fullmag/script-output", "read_only": True},
        ]}}}
        with patch("docker_script_output_permissions.prepare_output_tree") as prepare:
            with self.assertRaises(docker_volume_dev.BuildControlError):
                docker_volume_dev._prepare_script_output_permissions(document)
        prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
