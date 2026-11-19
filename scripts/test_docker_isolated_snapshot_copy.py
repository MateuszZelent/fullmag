"""Interpreted regressions for Linux read-only retained-tree snapshots."""
from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import docker_isolated_snapshot_copy as snapshot


def _owner_bytes(*, released: bool = True) -> bytes:
    return json.dumps({"schema": "fullmag.writer.v1", "released": released},
                      sort_keys=True).encode("utf-8") + b"\n"


class IsolatedSnapshotCopyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "nested").mkdir()
        (self.source / "alpha.txt").write_bytes(b"alpha\n")
        (self.source / "nested" / "data.bin").write_bytes(bytes(range(256)) * 8)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_snapshot_manifest_is_sorted_bounded_and_hashes_actual_contents(self) -> None:
        manifest = snapshot.snapshot_tree(self.source)

        self.assertEqual(manifest["schema"], snapshot.SNAPSHOT_SCHEMA)
        self.assertEqual(manifest["source_root"], str(self.source.resolve()))
        self.assertEqual(manifest["root_identity"], {
            "device": self.source.stat().st_dev,
            "inode": self.source.stat().st_ino,
        })
        self.assertEqual(manifest["directories"], ["nested"])
        self.assertEqual([item["path"] for item in manifest["files"]],
                         ["alpha.txt", "nested/data.bin"])
        self.assertEqual(manifest["file_count"], 2)
        self.assertEqual(manifest["directory_count"], 1)
        self.assertEqual(manifest["total_bytes"], 6 + 2048)
        for item in manifest["files"]:
            actual = (self.source / item["path"]).read_bytes()
            self.assertEqual(item["size"], len(actual))
            self.assertEqual(item["sha256"], hashlib.sha256(actual).hexdigest())
            self.assertEqual(item["inode"], (self.source / item["path"]).stat().st_ino)

    def test_snapshot_rejects_symlink_and_hardlinked_files(self) -> None:
        linked = self.root / "linked-source"
        linked.mkdir()
        (linked / "target").write_bytes(b"target")
        (linked / "symlink").symlink_to(linked / "target")
        with self.assertRaises(ValueError):
            snapshot.snapshot_tree(linked)

        (linked / "symlink").unlink()
        try:
            os.link(linked / "target", linked / "hardlink")
        except OSError as error:
            self.skipTest(f"hard links are unavailable in the temporary filesystem: {error}")
        with self.assertRaises(ValueError):
            snapshot.snapshot_tree(linked)

    def test_snapshot_rejects_special_files_and_file_budget_overflow(self) -> None:
        fifo_root = self.root / "fifo-source"
        fifo_root.mkdir()
        os.mkfifo(fifo_root / "pipe")
        with self.assertRaises(ValueError):
            snapshot.snapshot_tree(fifo_root)

        with self.assertRaises(ValueError):
            snapshot.snapshot_tree(self.source, max_files=1)
        with self.assertRaises(ValueError):
            snapshot.snapshot_tree(self.source, max_bytes=1)

    def test_copy_verifies_hashes_and_preserves_source_stable_metadata(self) -> None:
        source_before = snapshot.snapshot_tree(self.source)
        source_paths = [self.source, self.source / "nested",
                        self.source / "alpha.txt", self.source / "nested" / "data.bin"]
        metadata_before = {
            path: (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_nlink,
                   metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns,
                   metadata.st_uid, metadata.st_gid)
            for path in source_paths
            for metadata in [path.stat()]
        }
        destination = self.root / "copied"

        copied = snapshot.copy_verified_tree(self.source, destination, source_before)

        self.assertEqual(copied["schema"], snapshot.SNAPSHOT_SCHEMA)
        self.assertEqual(copied["source_root"], str(self.source.resolve()))
        self.assertEqual(copied["destination_root"], str(destination.resolve()))
        self.assertEqual(copied["destination_identity"], {
            "device": destination.stat().st_dev,
            "inode": destination.stat().st_ino,
        })
        self.assertEqual(copied["root_identity"], copied["destination_identity"])
        self.assertEqual(copied["directories"], source_before["directories"])
        self.assertEqual([item["sha256"] for item in copied["files"]],
                         [item["sha256"] for item in source_before["files"]])
        self.assertEqual(snapshot.snapshot_tree(self.source), source_before)
        metadata_after = {
            path: (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_nlink,
                   metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns,
                   metadata.st_uid, metadata.st_gid)
            for path in source_paths
            for metadata in [path.stat()]
        }
        self.assertEqual(metadata_after, metadata_before)
        self.assertEqual(snapshot.snapshot_tree(destination)["files"], copied["files"])
        for relative in ("alpha.txt", "nested/data.bin"):
            source_mode = stat.S_IMODE((self.source / relative).stat().st_mode)
            copied_mode = stat.S_IMODE((destination / relative).stat().st_mode)
            self.assertEqual(copied_mode, source_mode | stat.S_IRUSR | stat.S_IWUSR)
            self.assertEqual((destination / relative).stat().st_mtime_ns,
                             (self.source / relative).stat().st_mtime_ns)
            self.assertNotEqual((self.source / relative).stat().st_ino,
                                (destination / relative).stat().st_ino)

    def test_snapshot_does_not_request_noatime_permission(self) -> None:
        real_open = snapshot.os.open
        requested_flags: list[int] = []
        noatime = getattr(os, "O_NOATIME", 0)

        def reject_noatime(path, flags, *args, **kwargs):
            requested_flags.append(flags)
            if noatime and flags & noatime:
                raise PermissionError(errno.EPERM, "O_NOATIME requires file ownership")
            return real_open(path, flags, *args, **kwargs)

        with patch.object(snapshot.os, "open", side_effect=reject_noatime):
            manifest = snapshot.snapshot_tree(self.source)

        self.assertTrue(requested_flags)
        self.assertFalse(any(noatime and flags & noatime for flags in requested_flags))
        self.assertEqual(manifest["file_count"], 2)

    def test_copy_rejects_corrupt_manifest_without_creating_destination(self) -> None:
        manifest = snapshot.snapshot_tree(self.source)
        manifest["files"][0]["sha256"] = "0" * 64
        destination = self.root / "corrupt-copy"

        with self.assertRaises(ValueError):
            snapshot.copy_verified_tree(self.source, destination, manifest)

        self.assertFalse(destination.exists())

    def test_copy_rejects_source_mutation_since_snapshot(self) -> None:
        manifest = snapshot.snapshot_tree(self.source)
        (self.source / "alpha.txt").write_bytes(b"changed after the snapshot")
        destination = self.root / "stale-copy"

        with self.assertRaises(ValueError):
            snapshot.copy_verified_tree(self.source, destination, manifest)

        self.assertFalse(destination.exists())

    def test_copy_keeps_partial_destination_when_source_drifts_during_copy(self) -> None:
        manifest = snapshot.snapshot_tree(self.source)
        destination = self.root / "partial-copy"
        original_copy_file = snapshot._copy_regular_file
        changed = False

        def copy_then_drift(*args, **kwargs):
            nonlocal changed
            result = original_copy_file(*args, **kwargs)
            if not changed:
                (self.source / "late-file").write_bytes(b"added during copy")
                changed = True
            return result

        with patch.object(snapshot, "_copy_regular_file", side_effect=copy_then_drift):
            with self.assertRaises(ValueError):
                snapshot.copy_verified_tree(self.source, destination, manifest)

        self.assertTrue(destination.is_dir())
        self.assertTrue((destination / "alpha.txt").is_file())
        self.assertTrue((self.source / "late-file").is_file())
        with self.assertRaises(ValueError):
            snapshot.copy_verified_tree(self.source, destination, manifest)
        self.assertTrue((destination / "alpha.txt").is_file())

    def test_copy_adds_owner_read_write_permissions_to_restricted_sources(self) -> None:
        restricted_file = self.source / "nested" / "data.bin"
        restricted_file.chmod(0o400)
        (self.source / "nested").chmod(0o500)
        try:
            manifest = snapshot.snapshot_tree(self.source)
            destination = self.root / "restricted-copy"

            snapshot.copy_verified_tree(self.source, destination, manifest)

            self.assertEqual(stat.S_IMODE((destination / "nested").stat().st_mode), 0o700)
            self.assertEqual(
                stat.S_IMODE((destination / "nested" / "data.bin").stat().st_mode), 0o600,
            )
        finally:
            (self.source / "nested").chmod(0o700)
            restricted_file.chmod(0o600)

    def test_snapshot_detects_directory_listing_drift(self) -> None:
        original_list = snapshot._list_directory
        changed = False

        def list_then_drift(directory_fd):
            nonlocal changed
            names = original_list(directory_fd)
            if not changed and os.fstat(directory_fd).st_ino == self.source.stat().st_ino:
                (self.source / "concurrent").write_bytes(b"new")
                changed = True
            return names

        with patch.object(snapshot, "_list_directory", side_effect=list_then_drift):
            with self.assertRaises(ValueError):
                snapshot.snapshot_tree(self.source)

        self.assertTrue(changed)

    def test_copy_rejects_overlapping_destination_paths(self) -> None:
        manifest = snapshot.snapshot_tree(self.source)
        for destination in (self.source / "child", self.source.parent):
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                snapshot.copy_verified_tree(self.source, destination, manifest)

    def _writer_store(self) -> tuple[Path, bytes, tuple[int, ...]]:
        store = self.root / "store"
        store.mkdir()
        lock = store / "WRITER.lock"
        lock.touch()
        owner = store / "WRITER.owner.json"
        original_owner = _owner_bytes()
        owner.write_bytes(original_owner)
        metadata = owner.stat()
        owner_identity = (metadata.st_dev, metadata.st_ino, metadata.st_nlink,
                          metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns)
        return store, original_owner, owner_identity

    def test_writer_lock_is_readonly_and_does_not_change_owner_record(self) -> None:
        store, owner_bytes, owner_identity = self._writer_store()

        with snapshot.hold_source_writer(store) as store_descriptor:
            self.assertTrue(stat.S_ISDIR(os.fstat(store_descriptor).st_mode))
            current = os.stat(store, follow_symlinks=False)
            self.assertEqual((current.st_dev, current.st_ino),
                             (os.fstat(store_descriptor).st_dev,
                              os.fstat(store_descriptor).st_ino))
            self.assertEqual(fcntl.fcntl(store_descriptor, fcntl.F_GETFL) & os.O_ACCMODE,
                             os.O_RDONLY)
            with self.assertRaises(BlockingIOError):
                other = os.open(store / "WRITER.lock", os.O_RDONLY)
                try:
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(other)

        owner = store / "WRITER.owner.json"
        metadata = owner.stat()
        self.assertEqual(owner.read_bytes(), owner_bytes)
        self.assertEqual((metadata.st_dev, metadata.st_ino, metadata.st_nlink,
                          metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns),
                         owner_identity)

    def test_writer_lock_detects_store_root_replacement_on_success_exit(self) -> None:
        store, _, _ = self._writer_store()
        original_identity = (store.stat().st_dev, store.stat().st_ino)
        moved = self.root / "old-store"

        with self.assertRaises(snapshot.SnapshotError):
            with snapshot.hold_source_writer(store):
                store.rename(moved)
                store.mkdir()

        self.assertEqual((moved.stat().st_dev, moved.stat().st_ino), original_identity)
        self.assertNotEqual((store.stat().st_dev, store.stat().st_ino), original_identity)

    def test_writer_lock_rechecks_store_root_before_yield(self) -> None:
        store, _, _ = self._writer_store()
        moved = self.root / "old-store"
        read_owner = snapshot._read_owner_record

        def read_owner_then_replace(store_fd):
            result = read_owner(store_fd)
            store.rename(moved)
            store.mkdir()
            return result

        with patch.object(snapshot, "_read_owner_record", side_effect=read_owner_then_replace):
            with self.assertRaises(snapshot.SnapshotError):
                with snapshot.hold_source_writer(store):
                    self.fail("replaced source store unexpectedly reached the caller")

        self.assertTrue((moved / "WRITER.lock").is_file())
        self.assertTrue(store.is_dir())

    def test_writer_lock_detects_store_root_replacement_on_exception_exit(self) -> None:
        store, _, _ = self._writer_store()
        moved = self.root / "old-store"

        with self.assertRaises(snapshot.SnapshotError):
            with snapshot.hold_source_writer(store):
                store.rename(moved)
                store.mkdir()
                raise RuntimeError("operation failed after path replacement")

        self.assertTrue((moved / "WRITER.lock").is_file())
        self.assertTrue(store.is_dir())

    def test_writer_lock_detects_store_root_renamed_away_and_back(self) -> None:
        store, _, _ = self._writer_store()
        moved = self.root / "old-store"

        with self.assertRaises(snapshot.SnapshotError):
            with snapshot.hold_source_writer(store):
                store.rename(moved)
                moved.rename(store)

    def test_writer_lock_rechecks_path_after_final_owner_read(self) -> None:
        store, _, _ = self._writer_store()
        moved = self.root / "old-store"
        read_owner = snapshot._read_owner_record
        reads = 0

        def read_owner_then_replace_on_exit(store_fd):
            nonlocal reads
            result = read_owner(store_fd)
            reads += 1
            if reads == 2:
                store.rename(moved)
                store.mkdir()
            return result

        with patch.object(snapshot, "_read_owner_record",
                          side_effect=read_owner_then_replace_on_exit):
            with self.assertRaises(snapshot.SnapshotError):
                with snapshot.hold_source_writer(store):
                    pass

        self.assertEqual(reads, 2)
        self.assertTrue((moved / "WRITER.lock").is_file())

    def test_writer_lock_rejects_contention_without_changing_owner(self) -> None:
        store, owner_bytes, _ = self._writer_store()
        holder = os.open(store / "WRITER.lock", os.O_RDONLY)
        try:
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises((ValueError, BlockingIOError)):
                with snapshot.hold_source_writer(store):
                    self.fail("contended source lock unexpectedly acquired")
        finally:
            fcntl.flock(holder, fcntl.LOCK_UN)
            os.close(holder)
        self.assertEqual((store / "WRITER.owner.json").read_bytes(), owner_bytes)

    def test_writer_lock_file_descriptor_is_readonly(self) -> None:
        store, _, _ = self._writer_store()
        lock_identity = (store / "WRITER.lock").stat().st_dev, (store / "WRITER.lock").stat().st_ino
        original_flock = fcntl.flock
        access_modes: list[int] = []

        def inspect_lock(descriptor, operation):
            metadata = os.fstat(descriptor)
            if ((metadata.st_dev, metadata.st_ino) == lock_identity
                    and operation == fcntl.LOCK_EX | fcntl.LOCK_NB):
                access_modes.append(fcntl.fcntl(descriptor, fcntl.F_GETFL) & os.O_ACCMODE)
            return original_flock(descriptor, operation)

        with patch.object(snapshot.fcntl, "flock", side_effect=inspect_lock):
            with snapshot.hold_source_writer(store):
                pass

        self.assertEqual(access_modes, [os.O_RDONLY])

    def test_writer_lock_rejects_missing_or_unreleased_owner_without_creating_files(self) -> None:
        store, _, _ = self._writer_store()
        owner = store / "WRITER.owner.json"
        owner.unlink()
        with self.assertRaises(ValueError):
            with snapshot.hold_source_writer(store):
                self.fail("missing owner record unexpectedly accepted")
        self.assertFalse(owner.exists())

        owner.write_bytes(_owner_bytes(released=False))
        with self.assertRaises(ValueError):
            with snapshot.hold_source_writer(store):
                self.fail("unreleased owner record unexpectedly accepted")

    def test_writer_lock_rejects_legacy_lock_and_linked_lock_files(self) -> None:
        store, _, _ = self._writer_store()
        (store / "LOCK").touch()
        with self.assertRaises(ValueError):
            with snapshot.hold_source_writer(store):
                self.fail("legacy LOCK unexpectedly accepted")
        (store / "LOCK").unlink()

        lock = store / "WRITER.lock"
        hardlink = store / "lock-hardlink"
        try:
            os.link(lock, hardlink)
        except OSError as error:
            self.skipTest(f"hard links are unavailable in the temporary filesystem: {error}")
        with self.assertRaises(ValueError):
            with snapshot.hold_source_writer(store):
                self.fail("hardlinked writer lock unexpectedly accepted")

    def test_writer_lock_rejects_symlink_without_following_it(self) -> None:
        store, _, _ = self._writer_store()
        lock = store / "WRITER.lock"
        original = store / "real-lock"
        lock.rename(original)
        lock.symlink_to(original)

        with self.assertRaises(ValueError):
            with snapshot.hold_source_writer(store):
                self.fail("symlinked writer lock unexpectedly accepted")


if __name__ == "__main__":
    unittest.main()
