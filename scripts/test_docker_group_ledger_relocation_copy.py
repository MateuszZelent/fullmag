"""Byte-transfer regressions; native semantic/fence qualification is separate."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import docker_group_ledger_relocation_copy as transfer

from docker_group_ledger_relocation_copy import LedgerCopyError, copy_snapshot, validate_manifest


class LedgerRelocationCopyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.target = self.root / "target"
        self.source.mkdir()
        self.target.mkdir()
        (self.source / "release-proofs").mkdir()
        self.payloads = {"INITIALIZED": b"marker\n", "ledger.json": b'{"history":[1,2]}\n',
                         "release-proofs/a.json": b'{"proof":"historical"}\n', "WRITER.lock": b""}
        for name, body in self.payloads.items():
            (self.source / name).write_bytes(body)
        self.inspection = {"schema_version": "fullmag.group-ledger-relocation-inspection.v1",
                           "directories": ["release-proofs"],
                           "manifest": [{"path": name, "size_bytes": len(body),
                                         "sha256": hashlib.sha256(body).hexdigest()}
                                        for name, body in sorted(self.payloads.items())]}

    def test_exact_copy_preserves_bytes_and_source_without_publishing_adoption(self):
        before = {name: (self.source / name).stat().st_ino for name in self.payloads}
        result = copy_snapshot(self.source, self.target, self.inspection)
        self.assertTrue(result["target_preview_required"])
        self.assertEqual(result["bytes"], sum(map(len, self.payloads.values())))
        for name, body in self.payloads.items():
            self.assertEqual((self.source / name).read_bytes(), body)
            self.assertEqual((self.target / "ledger" / name).read_bytes(), body)
            self.assertEqual((self.source / name).stat().st_ino, before[name])
            self.assertNotEqual((self.target / "ledger" / name).stat().st_ino, before[name])
        self.assertFalse((self.target / "receipt.json").exists())

    def test_fifo_swap_after_inventory_refuses_without_blocking(self):
        inventory = transfer._inventory
        swapped = False
        def swap(root_fd, prefix=""):
            nonlocal swapped
            result = inventory(root_fd, prefix)
            if not prefix and not swapped:
                swapped = True
                (self.source / "ledger.json").unlink()
                os.mkfifo(self.source / "ledger.json")
            return result
        with patch.object(transfer, "_inventory", side_effect=swap):
            with self.assertRaisesRegex(LedgerCopyError, "file shape differs"):
                copy_snapshot(self.source, self.target, self.inspection)
        self.assertTrue(swapped)

    def test_appended_source_read_is_bounded_by_inspected_size(self):
        fdopen = os.fdopen
        read_sizes = []
        source_path = self.source / "ledger.json"
        class GrowingReader:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return self.stream.__exit__(*args)
            def fileno(self):
                return self.stream.fileno()
            def read(self, size):
                read_sizes.append(size)
                with source_path.open("ab") as append:
                    append.write(b"x" * 10000)
                return self.stream.read(size)
        def wrap(fd, mode):
            source = mode == "rb" and os.readlink("/proc/self/fd/" + str(fd)) == str(source_path)
            stream = fdopen(fd, mode)
            return GrowingReader(stream) if source else stream
        with patch.object(transfer.os, "fdopen", side_effect=wrap):
            with self.assertRaisesRegex(LedgerCopyError, "grew during transfer"):
                copy_snapshot(self.source, self.target, self.inspection)
        self.assertEqual(read_sizes, [len(self.payloads["ledger.json"]) + 1])

    def test_no_existing_target_is_overwritten_even_if_identical(self):
        copy_snapshot(self.source, self.target, self.inspection)
        with self.assertRaises(FileExistsError):
            copy_snapshot(self.source, self.target, self.inspection)
        self.assertEqual((self.target / "ledger/ledger.json").read_bytes(), self.payloads["ledger.json"])

    def test_source_digest_drift_retains_partial_copy_without_receipt(self):
        (self.source / "ledger.json").write_bytes(b'{"history":[9,9]}\n')
        with self.assertRaisesRegex(LedgerCopyError, "changed during transfer"):
            copy_snapshot(self.source, self.target, self.inspection)
        self.assertTrue((self.target / "ledger").exists())
        self.assertFalse((self.target / "receipt.json").exists())

    def test_new_source_entry_refuses_before_creating_target(self):
        (self.source / "unexpected.json").write_bytes(b"new")
        with self.assertRaisesRegex(LedgerCopyError, "inventory differs"):
            copy_snapshot(self.source, self.target, self.inspection)
        self.assertFalse((self.target / "ledger").exists())

    def test_links_and_devices_are_not_ledger_data(self):
        for kind in ("symlink", "hardlink", "fifo"):
            with self.subTest(kind=kind):
                leaf = self.source / "foreign"
                if kind == "symlink":
                    leaf.symlink_to(self.source / "ledger.json")
                elif kind == "hardlink":
                    os.link(self.source / "ledger.json", leaf)
                else:
                    os.mkfifo(leaf)
                try:
                    with self.assertRaisesRegex(LedgerCopyError, "link, device"):
                        copy_snapshot(self.source, self.target, self.inspection)
                finally:
                    leaf.unlink()
        self.assertFalse((self.target / "ledger").exists())

    def test_target_and_source_directory_symlinks_are_rejected(self):
        for source_alias, target_alias in ((True, False), (False, True)):
            source, target = self.source, self.target
            if source_alias:
                source = self.root / "source-alias"
                source.symlink_to(self.source, target_is_directory=True)
            if target_alias:
                target = self.root / "target-alias"
                target.symlink_to(self.target, target_is_directory=True)
            with self.assertRaises(OSError):
                copy_snapshot(source, target, self.inspection)
        self.assertFalse((self.target / "ledger").exists())

    def test_untrusted_manifest_paths_sizes_and_duplicates_fail_before_writes(self):
        for path in ("../outside", "/outside", "a/../outside", ".", "", "a//b", "a\\b", "bad\0name"):
            with self.subTest(path=path):
                manifest = copy.deepcopy(self.inspection)
                manifest["manifest"][0]["path"] = path
                with self.assertRaises(LedgerCopyError):
                    copy_snapshot(self.source, self.target, manifest)
        for size in (-1, True, 1.0, "1"):
            manifest = copy.deepcopy(self.inspection)
            manifest["manifest"][0]["size_bytes"] = size
            with self.assertRaises(LedgerCopyError):
                validate_manifest(manifest)
        manifest = copy.deepcopy(self.inspection)
        manifest["manifest"].append(manifest["manifest"][0])
        with self.assertRaises(LedgerCopyError):
            validate_manifest(manifest)
        manifest = copy.deepcopy(self.inspection)
        manifest["directories"] = []
        with self.assertRaisesRegex(LedgerCopyError, "parent directory"):
            validate_manifest(manifest)
        self.assertFalse((self.target / "ledger").exists())


if __name__ == "__main__":
    unittest.main()
