"""Small offline tests for byte-and-metadata data-tree manifests."""

import errno
import hashlib
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import fullmag_data_volume_manifest as manifest


_FIXED_MTIME_NS = 1_700_000_000_123_456_789
_ACL_VERSION = 2


def _make_tree(root: Path, payload: bytes = b"same") -> Path:
    nested = root / "nested"
    nested.mkdir(parents=True)
    data = nested / "data.bin"
    data.write_bytes(payload)
    data.chmod(0o640)
    nested.chmod(0o750)
    root.chmod(0o750)
    os.utime(data, ns=(_FIXED_MTIME_NS, _FIXED_MTIME_NS))
    os.utime(nested, ns=(_FIXED_MTIME_NS, _FIXED_MTIME_NS))
    os.utime(root, ns=(_FIXED_MTIME_NS, _FIXED_MTIME_NS))
    return data


def _make_roots(base: Path, side: str, payload: bytes = b"same") -> dict[str, Path]:
    roots = {}
    for role in ("user_data", "state"):
        roots[role] = base / side / role
        _make_tree(roots[role], payload)
    return roots


def _set_user_xattr(path: Path, value: bytes) -> None:
    if not hasattr(os, "setxattr"):
        raise unittest.SkipTest("Python has no xattr API")
    try:
        os.setxattr(path, "user.fullmag_manifest_test", value, follow_symlinks=False)
    except OSError as error:
        unsupported = {
            errno.ENOTSUP,
            getattr(errno, "EOPNOTSUPP", errno.ENOTSUP),
            getattr(errno, "ENOSYS", errno.ENOTSUP),
        }
        if error.errno in unsupported:
            raise unittest.SkipTest("temporary filesystem does not support xattrs") from error
        raise


def _acl_blob(named_user_permissions: int) -> bytes:
    undefined_id = 0xFFFFFFFF
    named_user_id = os.getuid() + 1
    entries = (
        (0x01, 0b110, undefined_id),  # ACL_USER_OBJ
        (0x02, named_user_permissions, named_user_id),  # ACL_USER
        (0x04, 0b100, undefined_id),  # ACL_GROUP_OBJ
        (0x10, named_user_permissions, undefined_id),  # ACL_MASK
        (0x20, 0b000, undefined_id),  # ACL_OTHER
    )
    return struct.pack("<I", _ACL_VERSION) + b"".join(
        struct.pack("<HHI", tag, permissions, identifier)
        for tag, permissions, identifier in entries
    )


def _set_acl(path: Path, named_user_permissions: int) -> None:
    if not hasattr(os, "setxattr"):
        raise unittest.SkipTest("Python has no xattr API")
    try:
        os.setxattr(
            path,
            "system.posix_acl_access",
            _acl_blob(named_user_permissions),
            follow_symlinks=False,
        )
    except OSError as error:
        unsupported = {
            errno.ENOTSUP,
            getattr(errno, "EOPNOTSUPP", errno.ENOTSUP),
            getattr(errno, "ENOSYS", errno.ENOTSUP),
            errno.EPERM,
            errno.EINVAL,
        }
        if error.errno in unsupported:
            raise unittest.SkipTest(
                "temporary filesystem/user does not support ACL xattrs"
            ) from error
        raise


class DataTreeManifestTests(unittest.TestCase):
    def test_equivalent_trees_match_despite_different_roots_and_allocations(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            base = Path(temporary)
            source = manifest.inventory_datasets(_make_roots(base, "source"))
            copied = manifest.inventory_datasets(_make_roots(base, "copy"))

            self.assertEqual(source["schema"], "fullmag.data-tree-manifest.v1")
            self.assertEqual(source["entries"], copied["entries"])
            self.assertNotEqual(source["roots"], copied["roots"])
            self.assertEqual(
                source["data_sha256"],
                hashlib.sha256(
                    json.dumps(
                        source["entries"],
                        sort_keys=True,
                        separators=(",", ":"),
                        ensure_ascii=False,
                    ).encode("utf-8")
                ).hexdigest(),
            )
            copied["totals"]["allocated_bytes"] += 4096
            self.assertIsNone(manifest.require_matching_data(source, copied))

    def test_entries_are_sorted_closed_and_totals_count_root_nodes_and_logical_bytes(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            result = manifest.inventory_datasets(_make_roots(Path(temporary), "data"))

        entries = result["entries"]
        keys = [
            (entry["role"], entry["path"])
            for entry in entries
        ]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(entries), 6)
        self.assertEqual(result["totals"]["entries"], 6)
        self.assertEqual(result["totals"]["files"], 2)
        self.assertEqual(result["totals"]["directories"], 4)
        self.assertEqual(result["totals"]["logical_bytes"], 8)
        self.assertGreaterEqual(result["totals"]["allocated_bytes"], 0)
        file_entry = next(entry for entry in entries if entry["kind"] == "file")
        self.assertEqual(
            set(file_entry),
            {
                "role",
                "path",
                "kind",
                "mode",
                "uid",
                "gid",
                "mtime_ns",
                "xattrs",
                "size",
                "sha256",
                "hardlink_to",
            },
        )
        self.assertEqual(file_entry["sha256"], hashlib.sha256(b"same").hexdigest())

    def test_hardlink_aliases_are_stable_across_roots_and_allocated_once(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            base = Path(temporary)
            user_data = base / "user_data"
            state = base / "state"
            user_data.mkdir()
            state.mkdir()
            first = state / "a.bin"
            alias = user_data / "b.bin"
            first.write_bytes(b"linked")
            first.chmod(0o640)
            os.utime(first, ns=(_FIXED_MTIME_NS, _FIXED_MTIME_NS))
            os.link(first, alias)
            roots = {"user_data": user_data, "state": state}

            result = manifest.inventory_datasets(roots)

            files = [entry for entry in result["entries"] if entry["kind"] == "file"]
            self.assertEqual([entry["role"] for entry in files], ["state", "user_data"])
            self.assertIsNone(files[0]["hardlink_to"])
            self.assertEqual(files[1]["hardlink_to"], "state:a.bin")
            self.assertEqual(result["totals"]["logical_bytes"], 12)
            expected_allocated = first.stat().st_blocks * 512
            self.assertEqual(result["totals"]["allocated_bytes"], expected_allocated)

    def test_content_change_is_rejected_even_when_size_mode_and_mtime_match(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            base = Path(temporary)
            source_roots = _make_roots(base, "source")
            copied_roots = _make_roots(base, "copy")
            source = manifest.inventory_datasets(source_roots)
            target = copied_roots["user_data"] / "nested" / "data.bin"
            target.write_bytes(b"DIFF")
            target.chmod(0o640)
            os.utime(target, ns=(_FIXED_MTIME_NS, _FIXED_MTIME_NS))
            copied = manifest.inventory_datasets(copied_roots)

            with self.assertRaises(ValueError):
                manifest.require_matching_data(source, copied)

    def test_mode_change_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            base = Path(temporary)
            source = manifest.inventory_datasets(_make_roots(base, "source"))
            copied_roots = _make_roots(base, "copy")
            (copied_roots["state"] / "nested" / "data.bin").chmod(0o600)
            copied = manifest.inventory_datasets(copied_roots)

            with self.assertRaises(ValueError):
                manifest.require_matching_data(source, copied)

    def test_mtime_change_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            base = Path(temporary)
            source = manifest.inventory_datasets(_make_roots(base, "source"))
            copied_roots = _make_roots(base, "copy")
            target = copied_roots["state"] / "nested" / "data.bin"
            os.utime(target, ns=(_FIXED_MTIME_NS + 1, _FIXED_MTIME_NS + 1))
            copied = manifest.inventory_datasets(copied_roots)

            with self.assertRaises(ValueError):
                manifest.require_matching_data(source, copied)

    def test_user_xattr_is_encoded_and_change_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            base = Path(temporary)
            source_roots = _make_roots(base, "source")
            copied_roots = _make_roots(base, "copy")
            source_file = source_roots["user_data"] / "nested" / "data.bin"
            copied_file = copied_roots["user_data"] / "nested" / "data.bin"
            _set_user_xattr(source_file, b"source")
            _set_user_xattr(copied_file, b"source")
            source = manifest.inventory_datasets(source_roots)
            source_entry = next(
                entry for entry in source["entries"]
                if entry["role"] == "user_data" and entry["kind"] == "file"
            )
            self.assertEqual(source_entry["xattrs"]["user.fullmag_manifest_test"], "c291cmNl")

            _set_user_xattr(copied_file, b"changed")
            copied = manifest.inventory_datasets(copied_roots)
            with self.assertRaises(ValueError):
                manifest.require_matching_data(source, copied)

    def test_unreadable_xattr_metadata_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            with patch.object(
                manifest.os,
                "listxattr",
                side_effect=OSError(errno.EOPNOTSUPP, "xattrs unavailable"),
            ):
                with self.assertRaises(ValueError):
                    manifest.inventory_datasets(roots)

    def test_posix_acl_xattr_is_retained_and_change_is_rejected_when_supported(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            base = Path(temporary)
            source_roots = _make_roots(base, "source")
            copied_roots = _make_roots(base, "copy")
            source_file = source_roots["user_data"] / "nested" / "data.bin"
            copied_file = copied_roots["user_data"] / "nested" / "data.bin"
            _set_acl(source_file, 0b100)
            _set_acl(copied_file, 0b100)
            source = manifest.inventory_datasets(source_roots)
            source_entry = next(
                entry for entry in source["entries"]
                if entry["role"] == "user_data" and entry["kind"] == "file"
            )
            self.assertIn("system.posix_acl_access", source_entry["xattrs"])

            _set_acl(copied_file, 0b010)
            copied = manifest.inventory_datasets(copied_roots)
            with self.assertRaises(ValueError):
                manifest.require_matching_data(source, copied)

    def test_symlink_and_fifo_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            try:
                (roots["user_data"] / "link").symlink_to("nested/data.bin")
            except (NotImplementedError, OSError) as error:
                raise unittest.SkipTest(f"temporary filesystem does not support symlinks: {error}")
            with self.assertRaises(ValueError):
                manifest.inventory_datasets(roots)

        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            try:
                os.mkfifo(roots["state"] / "special.fifo")
            except (AttributeError, NotImplementedError, OSError) as error:
                raise unittest.SkipTest(f"temporary filesystem does not support FIFO: {error}")
            with self.assertRaises(ValueError):
                manifest.inventory_datasets(roots)

    def test_unreadable_file_is_rejected(self):
        if os.geteuid() == 0:
            self.skipTest("read-permission check requires the WSL host user")
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            target = roots["user_data"] / "nested" / "data.bin"
            original_mode = target.stat().st_mode & 0o7777
            try:
                target.chmod(0)
                with self.assertRaises(ValueError):
                    manifest.inventory_datasets(roots)
            finally:
                target.chmod(original_mode)

    def test_overbound_and_lexically_overlapping_roots_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            with self.assertRaises(ValueError):
                manifest.inventory_datasets(roots, maximum_entries=2)

            nested_roots = {
                "user_data": roots["user_data"],
                "state": roots["user_data"] / "nested",
            }
            with self.assertRaises(ValueError):
                manifest.inventory_datasets(nested_roots)

    def test_same_physical_root_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            root = Path(temporary) / "one-root"
            _make_tree(root)
            with self.assertRaises(ValueError):
                manifest.inventory_datasets({"user_data": root, "state": root})

    def test_distinct_root_paths_with_same_physical_identity_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            original_open = manifest._open_directory_path
            first_descriptor = None

            def open_same_directory(components):
                nonlocal first_descriptor
                descriptor = original_open(components)
                if first_descriptor is None:
                    first_descriptor = descriptor
                    return descriptor
                os.close(descriptor)
                return os.dup(first_descriptor)

            with patch.object(
                manifest, "_open_directory_path", side_effect=open_same_directory
            ):
                with self.assertRaises(ValueError):
                    manifest.inventory_datasets(roots)

    def test_many_files_keep_owned_descriptor_peak_below_32(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-fds-") as temporary:
            base = Path(temporary)
            user_data = base / "user_data"
            state = base / "state"
            user_data.mkdir()
            state.mkdir()
            for index in range(100):
                (user_data / f"entry-{index:03d}.bin").write_bytes(bytes([index % 256]))
            roots = {"user_data": user_data, "state": state}

            original_open = os.open
            original_close = os.close
            original_dup = os.dup
            owned_descriptors = set()
            peak = 0

            def track_open(*args, **kwargs):
                nonlocal peak
                descriptor = original_open(*args, **kwargs)
                owned_descriptors.add(descriptor)
                peak = max(peak, len(owned_descriptors))
                return descriptor

            def track_dup(descriptor):
                nonlocal peak
                duplicate = original_dup(descriptor)
                owned_descriptors.add(duplicate)
                peak = max(peak, len(owned_descriptors))
                return duplicate

            def track_close(descriptor):
                try:
                    return original_close(descriptor)
                finally:
                    owned_descriptors.discard(descriptor)

            with patch.object(os, "open", side_effect=track_open):
                with patch.object(os, "dup", side_effect=track_dup):
                    with patch.object(os, "close", side_effect=track_close):
                        result = manifest.inventory_datasets(roots)

            self.assertEqual(result["totals"]["files"], 100)
            self.assertLessEqual(peak, 32)
            self.assertEqual(owned_descriptors, set())

    def test_root_symlink_and_noncanonical_root_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            base = Path(temporary)
            actual = base / "actual"
            _make_tree(actual)
            link = base / "link"
            link.symlink_to(actual, target_is_directory=True)
            other = base / "other"
            _make_tree(other)
            with self.assertRaises(ValueError):
                manifest.inventory_datasets({"user_data": link, "state": other})

            parent_component = Path(str(actual) + "/../actual")
            with self.assertRaises(ValueError):
                manifest.inventory_datasets(
                    {"user_data": parent_component, "state": other}
                )

    def test_addition_during_walk_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            user_root = roots["user_data"]
            root_identity = (user_root.stat().st_dev, user_root.stat().st_ino)
            original_listdir = manifest._listdir_fd
            injected = False

            def listdir_and_add(fd):
                nonlocal injected
                names = original_listdir(fd)
                info = os.fstat(fd)
                if not injected and (info.st_dev, info.st_ino) == root_identity:
                    (user_root / "raced.bin").write_bytes(b"late")
                    injected = True
                return names

            with patch.object(manifest, "_listdir_fd", side_effect=listdir_and_add):
                with self.assertRaises(ValueError):
                    manifest.inventory_datasets(roots)

    def test_removal_during_directory_walk_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            nested = roots["user_data"] / "nested"
            nested_identity = (nested.stat().st_dev, nested.stat().st_ino)
            target = nested / "data.bin"
            original_listdir = manifest._listdir_fd
            removed = False

            def listdir_then_remove(fd):
                nonlocal removed
                names = original_listdir(fd)
                info = os.fstat(fd)
                if not removed and (info.st_dev, info.st_ino) == nested_identity:
                    target.unlink()
                    removed = True
                return names

            with patch.object(manifest, "_listdir_fd", side_effect=listdir_then_remove):
                with self.assertRaises(ValueError):
                    manifest.inventory_datasets(roots)

    def test_file_changed_during_hash_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            target = roots["user_data"] / "nested" / "data.bin"
            original_hash = manifest._hash_file_descriptor

            def hash_then_mutate(fd):
                digest = original_hash(fd)
                target.write_bytes(b"changed during scan")
                return digest

            with patch.object(manifest, "_hash_file_descriptor", side_effect=hash_then_mutate):
                with self.assertRaises(ValueError):
                    manifest.inventory_datasets(roots)

    def test_same_size_rewrite_with_restored_mtime_is_rejected_by_ctime_drift(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            roots = _make_roots(Path(temporary), "data")
            target = roots["state"] / "nested" / "data.bin"
            original_stat = target.stat()
            original_hash = manifest._hash_file_descriptor
            mutation_ctimes = []

            def hash_then_rewrite_and_restore_mtime(descriptor):
                digest = original_hash(descriptor)
                target.write_bytes(b"DIFF")
                os.utime(
                    target,
                    ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
                )
                mutation_ctimes.append(target.stat().st_ctime_ns)
                return digest

            with patch.object(
                manifest,
                "_hash_file_descriptor",
                side_effect=hash_then_rewrite_and_restore_mtime,
            ):
                with self.assertRaises(ValueError):
                    manifest.inventory_datasets(roots)

            self.assertEqual(target.stat().st_size, original_stat.st_size)
            self.assertEqual(target.stat().st_mtime_ns, original_stat.st_mtime_ns)
            self.assertNotEqual(mutation_ctimes[0], original_stat.st_ctime_ns)

    def test_require_matching_rejects_forged_or_changed_digest(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-manifest-") as temporary:
            base = Path(temporary)
            source = manifest.inventory_datasets(_make_roots(base, "source"))
            forged = manifest.inventory_datasets(_make_roots(base, "copy"))
            forged["data_sha256"] = "0" * 64

            with self.assertRaises(ValueError):
                manifest.require_matching_data(source, forged)

            changed_entry = manifest.inventory_datasets(_make_roots(base, "copy2"))
            changed_entry["entries"][1]["mode"] ^= 0o100
            with self.assertRaises(ValueError):
                manifest.require_matching_data(source, changed_entry)


if __name__ == "__main__":
    unittest.main()
