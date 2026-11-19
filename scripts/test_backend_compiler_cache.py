"""Safety and retention tests for Cargo's private incremental cache."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "docker" / "all-in-one"))

import backend_compiler_cache as compiler_cache
from backend_compiler_cache import BackendCompilerCacheError, collect

OWNER_MARKER = ".fullmag-direct-backend-owner.json"
OWNER_SCHEMA = "fullmag.direct-compose.backend-workspace.v1"
INVENTORY_SCHEMA = "fullmag.direct-compose.workspace-inventory.v1"
INCREMENTAL = Path(".fullmag-build/cargo-targets/direct/backend-dev/incremental")


def owned_workspace(base: Path) -> Path:
    workspace = base / "workspace"
    workspace.mkdir()
    digest = "a" * 64
    marker = {
        "schema": OWNER_SCHEMA,
        "state": "ready",
        "source_mode": "live-shadow-v1",
        "source_digest": digest,
        "live_manifest_sha256": "b" * 64,
        "workspace_inventory_schema": INVENTORY_SCHEMA,
        "workspace_inventory_sha256": digest,
    }
    (workspace / OWNER_MARKER).write_text(json.dumps(marker), encoding="utf-8")
    return workspace


def incremental_root(workspace: Path) -> Path:
    root = workspace / INCREMENTAL
    root.mkdir(parents=True)
    return root


def crate(root: Path, name: str, payload: bytes = b"cache") -> Path:
    path = root / f"{name}-0123456789abc"
    path.mkdir()
    session = path / "s-0123456789-abcdefgh-0123456789abcdef"
    session.mkdir()
    output = session / "dep-graph.bin"
    output.write_bytes(payload)
    return output


class BackendCompilerCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary.cleanup)
        self.tmp_path = Path(self._temporary.name)

    def test_keeps_cache_below_limit(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        cache_file = crate(root, "fullmag_api", b"a" * 8192)
        used = cache_file.stat().st_blocks * 512

        receipt = collect(workspace, max_incremental_bytes=used)

        self.assertEqual(receipt["state"], "complete")
        self.assertEqual(receipt["before_bytes"], used)
        self.assertEqual(receipt["after_bytes"], used)
        self.assertEqual(receipt["removed_paths"], [])
        self.assertTrue(cache_file.is_file())

    def test_prunes_oldest_whole_crate_to_budget(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        old = crate(root, "fullmag_api", b"o" * 32768)
        new = crate(root, "fullmag_engine", b"n" * 32768)
        deps_marker = root.parent / "deps" / "must-remain"
        deps_marker.parent.mkdir()
        deps_marker.write_text("dependency artifact", encoding="utf-8")
        build_marker = root.parent / "build" / "must-remain"
        build_marker.parent.mkdir()
        build_marker.write_text("native build output", encoding="utf-8")
        release_incremental = (
            workspace / ".fullmag-build/cargo-targets/direct/release/incremental"
        )
        release_incremental.mkdir(parents=True)
        release_marker = release_incremental / "must-remain"
        release_marker.write_text("other profile", encoding="utf-8")
        source_marker = workspace / "source.txt"
        source_marker.write_text("source", encoding="utf-8")
        now = time.time_ns()
        os.utime(old, ns=(now - 20_000_000_000, now - 20_000_000_000))
        os.utime(new, ns=(now - 1_000_000_000, now - 1_000_000_000))
        limit = new.stat().st_blocks * 512
        old_crate = old.parent.parent

        receipt = collect(workspace, max_incremental_bytes=limit)

        self.assertEqual(
            receipt["removed_paths"],
            [(INCREMENTAL / old_crate.name).as_posix()],
        )
        self.assertFalse(old_crate.exists())
        self.assertTrue(new.is_file())
        self.assertEqual(deps_marker.read_text(encoding="utf-8"), "dependency artifact")
        self.assertEqual(build_marker.read_text(encoding="utf-8"), "native build output")
        self.assertEqual(release_marker.read_text(encoding="utf-8"), "other profile")
        self.assertEqual(source_marker.read_text(encoding="utf-8"), "source")
        self.assertLessEqual(receipt["after_bytes"], limit)
        self.assertGreater(receipt["before_bytes"], receipt["after_bytes"])

    def test_symlink_refusal_precedes_all_deletions(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        old = crate(root, "fullmag_api", b"old" * 100)
        bad = root / "fullmag_engine-1123456789abc"
        bad.mkdir()
        outside = self.tmp_path / "outside.txt"
        outside.write_text("do not follow", encoding="utf-8")
        (bad / "escape").symlink_to(outside)
        now = time.time_ns()
        os.utime(old, ns=(now - 20_000_000_000, now - 20_000_000_000))

        with self.assertRaisesRegex(BackendCompilerCacheError, "symlink"):
            collect(workspace, max_incremental_bytes=0)

        self.assertTrue(old.is_file())
        self.assertEqual(outside.read_text(encoding="utf-8"), "do not follow")

    def test_rejects_foreign_workspace_marker_without_deleting(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        cache_file = crate(root, "fullmag_api", b"owned-by-no-one")
        (workspace / OWNER_MARKER).write_text(
            json.dumps({"schema": "foreign.workspace.v1", "state": "ready"}),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(BackendCompilerCacheError, "owner marker"):
            collect(workspace, max_incremental_bytes=0)

        self.assertTrue(cache_file.is_file())

    def test_existing_workspace_without_owner_marker_fails_closed(self) -> None:
        workspace = self.tmp_path / "workspace"
        workspace.mkdir()

        with self.assertRaisesRegex(BackendCompilerCacheError, "owner marker"):
            collect(workspace)

        self.assertFalse((workspace / INCREMENTAL).exists())

    def test_missing_workspace_returns_missing_without_creating_it(self) -> None:
        workspace = self.tmp_path / "absent" / "workspace"

        receipt = collect(workspace)

        self.assertEqual(receipt["state"], "missing")
        self.assertEqual(receipt["before_bytes"], 0)
        self.assertEqual(receipt["after_bytes"], 0)
        self.assertEqual(receipt["removed_paths"], [])
        self.assertFalse(workspace.exists())

    def test_missing_incremental_root_is_not_created(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        missing = workspace / INCREMENTAL

        receipt = collect(workspace)

        self.assertEqual(receipt["state"], "missing")
        self.assertEqual(receipt["before_bytes"], 0)
        self.assertEqual(receipt["after_bytes"], 0)
        self.assertEqual(receipt["removed_paths"], [])
        self.assertFalse(missing.exists())

    def test_external_hardlink_survives_cache_pruning(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        cache_file = crate(root, "fullmag_api", b"shared inode payload")
        outside = self.tmp_path / "outside-hardlink.bin"
        os.link(cache_file, outside)

        receipt = collect(workspace, max_incremental_bytes=0)

        self.assertFalse(cache_file.parent.parent.exists())
        self.assertEqual(outside.read_bytes(), b"shared inode payload")
        self.assertEqual(outside.stat().st_nlink, 1)
        self.assertEqual(receipt["after_bytes"], 0)

    def test_unknown_top_level_file_fails_closed_before_deletion(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        cache_file = crate(root, "fullmag_api", b"preserve me")
        (root / "unexpected.txt").write_text("unknown", encoding="utf-8")

        with self.assertRaisesRegex(BackendCompilerCacheError, "unknown incremental entry"):
            collect(workspace, max_incremental_bytes=0)

        self.assertTrue(cache_file.is_file())

    def test_mount_boundary_fails_closed_before_deletion(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        cache_file = crate(root, "fullmag_api", b"preserve across mount boundary")
        crate_root = cache_file.parent.parent

        with patch.object(compiler_cache, "_mountpoints", return_value={str(crate_root)}):
            with self.assertRaisesRegex(BackendCompilerCacheError, "mount boundary"):
                collect(workspace, max_incremental_bytes=0)

        self.assertTrue(cache_file.is_file())

    def test_symlink_in_incremental_path_is_rejected_without_creating_cache(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        outside = self.tmp_path / "outside"
        outside.mkdir()
        (workspace / ".fullmag-build").symlink_to(outside, target_is_directory=True)

        with self.assertRaisesRegex(BackendCompilerCacheError, "symlink"):
            collect(workspace, max_incremental_bytes=0)

        self.assertEqual(list(outside.iterdir()), [])

    def test_budget_counts_hardlinked_inode_once(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        first = crate(root, "fullmag_api", b"one inode" * 1024)
        second_root = root / "fullmag_engine-1123456789abc"
        second_root.mkdir()
        os.link(first, second_root / "shared.bin")
        allocated = first.stat().st_blocks * 512

        receipt = collect(workspace, max_incremental_bytes=allocated)

        self.assertEqual(receipt["before_bytes"], allocated)
        self.assertEqual(receipt["after_bytes"], allocated)
        self.assertEqual(first.stat().st_ino, (second_root / "shared.bin").stat().st_ino)

    def test_interrupted_removal_leaves_cache_unreachable_and_recovers(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        cache_file = crate(root, "fullmag_api", b"interrupted cleanup")
        adjacent_file = cache_file.parent.parent / "second.bin"
        adjacent_file.write_bytes(b"second file remains in interrupted tombstone")
        original_unlink = os.unlink
        interrupted = False

        def unlink_once_then_interrupt(name, *, dir_fd=None):
            nonlocal interrupted
            original_unlink(name, dir_fd=dir_fd)
            if not interrupted:
                interrupted = True
                raise KeyboardInterrupt()

        with patch.object(compiler_cache.os, "unlink", side_effect=unlink_once_then_interrupt):
            with self.assertRaises(KeyboardInterrupt):
                collect(workspace, max_incremental_bytes=0)

        self.assertFalse(cache_file.parent.parent.exists())
        retired = list(root.glob(".fullmag-retired-*"))
        self.assertEqual(len(retired), 1)

        receipt = collect(workspace, max_incremental_bytes=0)

        self.assertEqual(receipt["state"], "complete")
        self.assertFalse(retired[0].exists())
        self.assertEqual(list(root.iterdir()), [])


    def test_accepts_current_archive_owner_marker_from_backend_dev(self) -> None:
        workspace = owned_workspace(self.tmp_path)
        root = incremental_root(workspace)
        cache_file = crate(root, "fullmag_api", b"archive-owned cache")
        source_digest = "c" * 64
        archive_digest = "d" * 64
        marker = {
            "schema": OWNER_SCHEMA,
            "state": "ready",
            "source_digest": source_digest,
            "source_tar_sha256": archive_digest,
            "workspace_inventory_schema": INVENTORY_SCHEMA,
            "workspace_inventory_sha256": source_digest,
        }
        (workspace / OWNER_MARKER).write_text(json.dumps(marker), encoding="utf-8")

        receipt = collect(workspace, max_incremental_bytes=0)

        self.assertEqual(receipt["state"], "complete")
        self.assertFalse(cache_file.parent.parent.exists())


if __name__ == "__main__":
    unittest.main()
