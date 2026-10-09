from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch


try:
    from scripts.local_runner import source_compaction
    from scripts.local_runner.build_entrypoint import materialize_capsule
    from scripts.local_runner.source import capture_source
    from scripts.local_runner.source_store import SourceContentStore
    from scripts.local_runner.worker_entrypoint import verify_source
except ModuleNotFoundError:
    from local_runner import source_compaction
    from local_runner.build_entrypoint import materialize_capsule
    from local_runner.source import capture_source
    from local_runner.source_store import SourceContentStore
    from local_runner.worker_entrypoint import verify_source


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ("git", *args),
        cwd=repo,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()


def _repository(root: Path, *, one_file: bool = False) -> tuple[Path, str]:
    repo = root / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Local runner compaction tests")
    _git(repo, "config", "user.email", "local-runner-compaction@example.invalid")
    (repo / "a.txt").write_text("shared source bytes\n", encoding="utf-8")
    if not one_file:
        (repo / "b.txt").write_text("second source bytes\n", encoding="utf-8")
        (repo / "bin").mkdir()
        (repo / "bin" / "tool.sh").write_text("#!/bin/sh\necho ready\n", encoding="utf-8")
    _git(repo, "add", ".")
    if not one_file:
        _git(repo, "update-index", "--chmod=+x", "bin/tool.sh")
    _git(repo, "commit", "-qm", "initial")
    return repo, _git(repo, "rev-parse", "HEAD")


def _capture(
    storage: Path,
    repo: Path,
    capture_id: str,
    *,
    ref: str | None = "HEAD",
    mode: str = "commit",
) -> tuple[Path, dict[str, object]]:
    source = storage / "runs" / "wt-1" / capture_id / "source"
    source.mkdir(parents=True)
    manifest = capture_source(repo, source, mode=mode, ref=ref if mode == "commit" else None)
    return source, manifest


class LocalRunnerSourceCompactionTests(unittest.TestCase):
    def test_identical_legacy_capsules_share_cas_and_keep_manifest_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-compaction-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root)
            first, first_manifest = _capture(storage, repo, "capture-a", mode="snapshot")
            second, second_manifest = _capture(storage, repo, "capture-b", mode="snapshot")
            first_manifest_bytes = (first / "manifest.json").read_bytes()
            second_manifest_bytes = (second / "manifest.json").read_bytes()
            self.assertEqual(first_manifest["source_digest"], second_manifest["source_digest"])

            first_result = source_compaction.compact_source_capsule(
                storage, first, first_manifest["source_digest"]
            )
            second_result = source_compaction.compact_source_capsule(
                storage, second, second_manifest["source_digest"]
            )

            for relative in ("a.txt", "b.txt", "bin/tool.sh"):
                left = first / "tree" / relative
                right = second / "tree" / relative
                entry = next(item for item in first_manifest["files"] if item["path"] == relative)
                object_path = SourceContentStore(storage / "cache" / "source-content-v1")._object_path(
                    entry["sha256"], entry["mode"]
                )
                self.assertTrue(os.path.samefile(left, right))
                self.assertTrue(os.path.samefile(left, object_path))
                self.assertGreaterEqual(left.stat().st_nlink, 3)
                self.assertEqual(left.stat().st_size, entry["size"])
                self.assertEqual(
                    hashlib.sha256(left.read_bytes()).hexdigest(), entry["sha256"]
                )
            self.assertEqual(first_manifest_bytes, (first / "manifest.json").read_bytes())
            self.assertEqual(second_manifest_bytes, (second / "manifest.json").read_bytes())
            self.assertEqual(
                verify_source(first, first_manifest["source_digest"])["source_digest"],
                first_manifest["source_digest"],
            )
            self.assertEqual(
                verify_source(second, second_manifest["source_digest"])["source_digest"],
                second_manifest["source_digest"],
            )
            self.assertEqual(first_result["converted_count"], 3)
            self.assertEqual(second_result["converted_count"], 3)
            self.assertEqual(second_result["skipped_count"], 0)
            self.assertEqual(first_result["logical_duplicate_bytes"], sum(x["size"] for x in first_manifest["files"]))

    def test_changed_bytes_use_distinct_objects_and_execution_copy_is_private(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-compaction-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            first, first_manifest = _capture(storage, repo, "capture-a", mode="snapshot")
            _git(repo, "config", "core.filemode", "true")
            (repo / "a.txt").write_text("changed source bytes\n", encoding="utf-8")
            second, second_manifest = _capture(storage, repo, "capture-b", mode="snapshot")
            self.assertNotEqual(first_manifest["source_digest"], second_manifest["source_digest"])

            first_result = source_compaction.compact_source_capsule(
                storage, first, first_manifest["source_digest"]
            )
            second_result = source_compaction.compact_source_capsule(
                storage, second, second_manifest["source_digest"]
            )
            self.assertEqual(first_result["converted_count"], 1)
            self.assertEqual(second_result["converted_count"], 1)
            store = SourceContentStore(storage / "cache" / "source-content-v1")
            first_entry = first_manifest["files"][0]
            second_entry = second_manifest["files"][0]
            self.assertNotEqual(first_entry["sha256"], second_entry["sha256"])
            self.assertFalse(
                os.path.samefile(
                    first / "tree" / "a.txt",
                    store._object_path(second_entry["sha256"], second_entry["mode"]),
                )
            )

            workspace = root / "execution"
            workspace.mkdir()
            materialize_capsule(first_manifest, first, workspace)
            execution_file = workspace / "a.txt"
            capsule_file = first / "tree" / "a.txt"
            object_path = store._object_path(first_entry["sha256"], first_entry["mode"])
            self.assertFalse(os.path.samefile(execution_file, capsule_file))
            self.assertFalse(os.path.samefile(execution_file, object_path))
            execution_file.write_text("private execution mutation\n", encoding="utf-8")
            self.assertEqual(capsule_file.read_text(encoding="utf-8"), "shared source bytes\n")
            self.assertEqual(hashlib.sha256(object_path.read_bytes()).hexdigest(), first_entry["sha256"])
            self.assertEqual(
                verify_source(first, first_manifest["source_digest"])["source_digest"],
                first_manifest["source_digest"],
            )

    def test_partial_replace_failure_keeps_original_and_resume_finishes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-compaction-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=False)
            source, manifest = _capture(storage, repo, "capture-a")
            second_file = source / "tree" / "b.txt"
            original_metadata = second_file.stat()
            original_identity = (original_metadata.st_dev, original_metadata.st_ino)
            real_replace = source_compaction._VerifiedDirectoryOwner.rename_file_from

            def fail_second_replace(
                parent_owner: object,
                stage_owner: object,
                source_name: str,
                destination_name: str,
            ) -> None:
                if Path(parent_owner.path) == second_file.parent and destination_name == second_file.name:
                    raise OSError("injected replace failure")
                real_replace(parent_owner, stage_owner, source_name, destination_name)

            with patch.object(
                source_compaction._VerifiedDirectoryOwner,
                "rename_file_from",
                new=fail_second_replace,
            ):
                with self.assertRaises(source_compaction.SourceCompactionError):
                    source_compaction.compact_source_capsule(
                        storage, source, manifest["source_digest"]
                    )

            self.assertEqual(
                (second_file.stat().st_dev, second_file.stat().st_ino), original_identity
            )
            self.assertEqual(second_file.stat().st_mode, original_metadata.st_mode)
            self.assertEqual(
                getattr(second_file.stat(), "st_file_attributes", 0),
                getattr(original_metadata, "st_file_attributes", 0),
            )
            self.assertEqual(second_file.read_text(encoding="utf-8"), "second source bytes\n")
            self.assertEqual(
                verify_source(source, manifest["source_digest"])["source_digest"],
                manifest["source_digest"],
            )
            receipt = json.loads(
                source_compaction.compaction_receipt_path(storage, source).read_text(encoding="utf-8")
            )
            self.assertEqual(receipt["state"], "partial_failure")
            self.assertEqual(receipt["converted_count"], 1)
            failed_entry = next(item for item in manifest["files"] if item["path"] == "b.txt")
            failed_object = SourceContentStore(
                storage / "cache" / "source-content-v1"
            )._object_path(failed_entry["sha256"], failed_entry["mode"])
            self.assertEqual(failed_object.stat().st_nlink, 1)
            stage_root = (
                storage / "tmp" / "source-compaction" / "wt-1" / "capture-a"
            )
            self.assertEqual(list(stage_root.glob(".compact-quarantine-*")), [])
            self.assertEqual(
                hashlib.sha256(failed_object.read_bytes()).hexdigest(), failed_entry["sha256"]
            )
            if os.name == "nt":
                self.assertTrue(getattr(failed_object.stat(), "st_file_attributes", 0) & 0x1)
            else:
                self.assertEqual(failed_object.stat().st_mode & 0o777, 0o444)

            source_root_mode = stat.S_IMODE(source.stat().st_mode)
            source.chmod(source_root_mode | stat.S_IWUSR)
            moved_tree = source / "tree-owner-release"
            try:
                os.rename(source / "tree", moved_tree)
                os.rename(moved_tree, source / "tree")
            finally:
                source.chmod(source_root_mode)

            result = source_compaction.compact_source_capsule(
                storage, source, manifest["source_digest"]
            )
            self.assertEqual(result["state"], "completed")
            self.assertEqual(result["converted_count"], 2)
            self.assertEqual(result["skipped_count"], 1)
            self.assertTrue(
                os.path.samefile(
                    source / "tree" / "b.txt",
                    SourceContentStore(storage / "cache" / "source-content-v1")._object_path(
                        next(item["sha256"] for item in manifest["files"] if item["path"] == "b.txt"),
                        "100644",
                    ),
                )
            )

    def _assert_parent_replacement_isolated(self, timing: str) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-parent-race-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-race")
            source_file = source / "tree" / "a.txt"
            tree_path = source_file.parent
            source_root = tree_path.parent
            moved_tree = source_root / "tree-original"
            foreign_file: Path | None = None
            foreign_snapshot: tuple[tuple[int, int], int, bytes] | None = None
            swapped = False
            source_root_mode = stat.S_IMODE(source_root.stat().st_mode)
            tree_mode = stat.S_IMODE(tree_path.stat().st_mode)
            file_metadata = source_file.stat()
            file_mode = stat.S_IMODE(file_metadata.st_mode)
            original_bytes = source_file.read_bytes()
            original_rename = os.rename

            def substitute_parent() -> None:
                nonlocal foreign_file, foreign_snapshot, swapped
                source_root.chmod(source_root_mode | stat.S_IWUSR)
                original_rename(tree_path, moved_tree)
                tree_path.mkdir()
                foreign_file = tree_path / source_file.name
                foreign_file.write_bytes(original_bytes)
                foreign_file.chmod(file_mode)
                tree_path.chmod(tree_mode)
                foreign_metadata = foreign_file.stat()
                foreign_snapshot = (
                    (foreign_metadata.st_dev, foreign_metadata.st_ino),
                    stat.S_IMODE(foreign_metadata.st_mode),
                    foreign_file.read_bytes(),
                )
                source_root.chmod(source_root_mode)
                swapped = True

            def replace_with_parent_race(
                source_name: str,
                destination_name: str,
                *,
                src_dir_fd: int | None = None,
                dst_dir_fd: int | None = None,
            ) -> None:
                nonlocal swapped
                is_commit = (
                    dst_dir_fd is not None
                    and destination_name == source_file.name
                    and source_name.startswith(".compact-")
                )
                if is_commit and timing == "before_commit" and not swapped:
                    substitute_parent()
                original_rename(
                    source_name,
                    destination_name,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                )
                if is_commit and timing == "before_postverify" and not swapped:
                    substitute_parent()

            try:
                with patch.object(
                    source_compaction.os,
                    "rename",
                    side_effect=replace_with_parent_race,
                ) as rename_hook:
                    # The hook delegates the actual descriptor-relative API;
                    # preserve capability detection while injecting the race.
                    with patch.object(
                        source_compaction.os, "supports_dir_fd",
                        source_compaction.os.supports_dir_fd | {rename_hook},
                    ):
                        with self.assertRaises(source_compaction.SourceCompactionError):
                            source_compaction.compact_source_capsule(
                                storage, source, manifest["source_digest"]
                            )

                self.assertIsNotNone(foreign_file)
                self.assertIsNotNone(foreign_snapshot)
                foreign_metadata = foreign_file.stat()
                self.assertEqual(
                    (foreign_metadata.st_dev, foreign_metadata.st_ino), foreign_snapshot[0]
                )
                self.assertEqual(stat.S_IMODE(foreign_metadata.st_mode), foreign_snapshot[1])
                self.assertEqual(foreign_file.read_bytes(), foreign_snapshot[2])

                receipt = json.loads(
                    source_compaction.compaction_receipt_path(storage, source).read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(receipt["state"], "partial_failure")
            finally:
                if swapped and moved_tree.exists() and foreign_file is not None:
                    source_root.chmod(source_root_mode | stat.S_IWUSR)
                    preserved_tree = root / "foreign-tree-preserved"
                    # Moving a directory to a different parent also updates
                    # its '..' entry: grant only the fixture's temporary write
                    # permission, then restore the original directory mode.
                    tree_path.chmod(tree_mode | stat.S_IWUSR)
                    try:
                        original_rename(tree_path, preserved_tree)
                    finally:
                        (preserved_tree if preserved_tree.exists() else tree_path).chmod(tree_mode)
                    original_rename(moved_tree, tree_path)
                    source_root.chmod(source_root_mode)

            resumed = source_compaction.compact_source_capsule(
                storage, source, manifest["source_digest"]
            )
            self.assertEqual(resumed["state"], "completed")
            self.assertEqual(resumed["skipped_count"], 1)
            preserved_foreign = root / "foreign-tree-preserved" / source_file.name
            preserved_metadata = preserved_foreign.stat()
            self.assertEqual((preserved_metadata.st_dev, preserved_metadata.st_ino), foreign_snapshot[0])
            self.assertEqual(stat.S_IMODE(preserved_metadata.st_mode), foreign_snapshot[1])
            self.assertEqual(preserved_foreign.read_bytes(), foreign_snapshot[2])

    @unittest.skipIf(os.name == "nt", "Windows owner handles deny direct parent rename")
    def test_parent_rename_and_replacement_before_commit_preserve_foreign_file(self) -> None:
        self._assert_parent_replacement_isolated("before_commit")

    @unittest.skipIf(os.name == "nt", "Windows owner handles deny direct parent rename")
    def test_parent_rename_and_replacement_before_postverify_preserve_foreign_file(self) -> None:
        self._assert_parent_replacement_isolated("before_postverify")

    @unittest.skipIf(os.name == "nt", "Windows owner handles deny direct stage-parent rename")
    def test_stage_parent_replacement_before_cleanup_preserves_foreign_inode_and_fails_closed_on_restart(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-stage-parent-race-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-stage-race")
            source_file = source / "tree" / "a.txt"
            entry = next(item for item in manifest["files"] if item["path"] == "a.txt")
            stage_name = source_compaction._stage_name(entry)
            stage_root = (
                storage / "tmp" / "source-compaction" / "wt-1" / "capture-stage-race"
            )
            moved_stage_root = stage_root.with_name("capture-stage-race-original")
            foreign_bytes = b"foreign replacement stage must survive\n"
            foreign_mode = 0o640
            source_metadata = source_file.stat()
            source_identity = (source_metadata.st_dev, source_metadata.st_ino)
            source_mode = stat.S_IMODE(source_metadata.st_mode)
            source_bytes = source_file.read_bytes()
            original_rename = os.rename
            real_rename_file = source_compaction._VerifiedDirectoryOwner.rename_file_from
            foreign_stage: Path | None = None
            foreign_identity: tuple[int, int] | None = None

            def replace_stage_parent(
                parent_owner: object,
                stage_owner: object,
                source_name: str,
                destination_name: str,
            ) -> None:
                nonlocal foreign_stage, foreign_identity
                if (
                    Path(parent_owner.path) == source_file.parent
                    and destination_name == source_file.name
                ):
                    original_rename(stage_root, moved_stage_root)
                    stage_root.mkdir()
                    foreign_stage = stage_root / stage_name
                    foreign_stage.write_bytes(foreign_bytes)
                    foreign_stage.chmod(foreign_mode)
                    metadata = foreign_stage.stat()
                    foreign_identity = (metadata.st_dev, metadata.st_ino)
                    raise OSError("injected stage-parent replacement before cleanup")
                real_rename_file(
                    parent_owner, stage_owner, source_name, destination_name
                )

            with patch.object(
                source_compaction._VerifiedDirectoryOwner,
                "rename_file_from",
                new=replace_stage_parent,
            ):
                with self.assertRaisesRegex(
                    source_compaction.SourceCompactionError,
                    "stage parent identity changed; preserving stage",
                ):
                    source_compaction.compact_source_capsule(
                        storage, source, manifest["source_digest"]
                    )

            self.assertIsNotNone(foreign_stage)
            self.assertIsNotNone(foreign_identity)
            first_metadata = foreign_stage.stat()
            self.assertEqual(
                (first_metadata.st_dev, first_metadata.st_ino), foreign_identity
            )
            self.assertEqual(stat.S_IMODE(first_metadata.st_mode), foreign_mode)
            self.assertEqual(foreign_stage.read_bytes(), foreign_bytes)
            after_source = source_file.stat()
            self.assertEqual(
                (after_source.st_dev, after_source.st_ino), source_identity
            )
            self.assertEqual(stat.S_IMODE(after_source.st_mode), source_mode)
            self.assertEqual(source_file.read_bytes(), source_bytes)

            receipt_path = source_compaction.compaction_receipt_path(storage, source)
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["state"], "partial_failure")
            self.assertIn("stage parent identity changed", receipt["last_error"])

            # A later invocation cannot adopt an unknown inode from the replacement
            # directory as a stale private stage, even though its deterministic name
            # matches the manifest entry.
            with self.assertRaisesRegex(
                source_compaction.SourceCompactionError,
                "unowned private compaction stage remains; preserving it",
            ):
                source_compaction.compact_source_capsule(
                    storage, source, manifest["source_digest"]
                )
            second_metadata = foreign_stage.stat()
            self.assertEqual(
                (second_metadata.st_dev, second_metadata.st_ino), foreign_identity
            )
            self.assertEqual(stat.S_IMODE(second_metadata.st_mode), foreign_mode)
            self.assertEqual(foreign_stage.read_bytes(), foreign_bytes)

    @unittest.skipIf(os.name == "nt", "POSIX file modes are asserted exactly")
    def test_stage_identity_mismatch_before_cleanup_preserves_foreign_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-stage-inode-race-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-stage-inode")
            source_file = source / "tree" / "a.txt"
            entry = next(item for item in manifest["files"] if item["path"] == "a.txt")
            stage_root = (
                storage / "tmp" / "source-compaction" / "wt-1" / "capture-stage-inode"
            )
            stage_path = stage_root / source_compaction._stage_name(entry)
            foreign_source = root / "foreign-stage-inode"
            foreign_bytes = b"foreign stage inode must survive\n"
            foreign_source.write_bytes(foreign_bytes)
            foreign_source.chmod(0o640)
            foreign_mode = 0o640
            source_metadata = source_file.stat()
            source_identity = (source_metadata.st_dev, source_metadata.st_ino)
            source_mode = stat.S_IMODE(source_metadata.st_mode)
            source_bytes = source_file.read_bytes()
            foreign_identity: tuple[int, int] | None = None

            def replace_stage_inode(
                path: Path,
                *,
                source_file: Path,
                source_owner: object,
                source_name: str,
                source_identity: tuple[int, int],
                stage_owner: object,
                store: object,
                entry: dict[str, object],
                private_identity: tuple[int, int],
            ) -> None:
                nonlocal foreign_identity
                stage_owner.unlink_file(
                    path.name, private_identity, expected_nlink=1
                )
                os.rename(foreign_source, path)
                metadata = path.stat()
                foreign_identity = (metadata.st_dev, metadata.st_ino)
                if foreign_identity == private_identity:
                    raise AssertionError("foreign fixture reused the private stage inode")
                raise source_compaction.SourceCompactionError(
                    "injected stage inode replacement before cleanup"
                )

            with patch.object(
                source_compaction,
                "_link_private_stage_to_cas",
                side_effect=replace_stage_inode,
            ):
                with self.assertRaisesRegex(
                    source_compaction.SourceCompactionError,
                    "compaction stage identity changed; leaving it untouched",
                ):
                    source_compaction.compact_source_capsule(
                        storage, source, manifest["source_digest"]
                    )

            self.assertIsNotNone(foreign_identity)
            foreign_metadata = stage_path.stat()
            self.assertEqual(
                (foreign_metadata.st_dev, foreign_metadata.st_ino), foreign_identity
            )
            self.assertEqual(stat.S_IMODE(foreign_metadata.st_mode), foreign_mode)
            self.assertEqual(stage_path.read_bytes(), foreign_bytes)
            after_source = source_file.stat()
            self.assertEqual(
                (after_source.st_dev, after_source.st_ino), source_identity
            )
            self.assertEqual(stat.S_IMODE(after_source.st_mode), source_mode)
            self.assertEqual(source_file.read_bytes(), source_bytes)

            with self.assertRaisesRegex(
                source_compaction.SourceCompactionError,
                "unowned private compaction stage remains; preserving it",
            ):
                source_compaction.compact_source_capsule(
                    storage, source, manifest["source_digest"]
                )
            after_retry = stage_path.stat()
            self.assertEqual(
                (after_retry.st_dev, after_retry.st_ino), foreign_identity
            )
            self.assertEqual(stat.S_IMODE(after_retry.st_mode), foreign_mode)
            self.assertEqual(stage_path.read_bytes(), foreign_bytes)

    @unittest.skipIf(os.name == "nt", "POSIX stage quarantine is required")
    def test_initial_unknown_stage_sweep_journals_partial_failure_and_preserves_inode(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-stage-sweep-recovery-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-sweep-recovery")
            source_file = source / "tree" / "a.txt"
            entry = next(item for item in manifest["files"] if item["path"] == "a.txt")
            stage_root = (
                storage / "tmp" / "source-compaction" / "wt-1" / "capture-sweep-recovery"
            )
            stage_root.mkdir(parents=True)
            unknown_stage = stage_root / source_compaction._stage_name(entry)
            unknown_bytes = b"unknown private stage from an interrupted process\\n"
            unknown_stage.write_bytes(unknown_bytes)
            unknown_stage.chmod(0o640)
            before = unknown_stage.stat()
            identity = (before.st_dev, before.st_ino)
            mode = stat.S_IMODE(before.st_mode)
            source_before = source_file.stat()
            source_identity = (source_before.st_dev, source_before.st_ino)
            source_bytes = source_file.read_bytes()
            states: list[str] = []
            real_write_receipt = source_compaction._write_receipt

            def record_receipt(path: Path, receipt: dict[str, object]) -> None:
                states.append(str(receipt["state"]))
                real_write_receipt(path, receipt)

            with patch.object(
                source_compaction, "_write_receipt", side_effect=record_receipt
            ):
                with self.assertRaisesRegex(
                    source_compaction.SourceCompactionError,
                    "unowned private compaction stage remains; preserving it",
                ):
                    source_compaction.compact_source_capsule(
                        storage, source, manifest["source_digest"]
                    )

            self.assertEqual(states, ["running", "partial_failure"])
            receipt = json.loads(
                source_compaction.compaction_receipt_path(storage, source).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(receipt["state"], "partial_failure")
            self.assertIn("unowned private compaction stage", receipt["last_error"])
            after = unknown_stage.stat()
            self.assertEqual((after.st_dev, after.st_ino), identity)
            self.assertEqual(stat.S_IMODE(after.st_mode), mode)
            self.assertEqual(unknown_stage.read_bytes(), unknown_bytes)
            source_after = source_file.stat()
            self.assertEqual(
                (source_after.st_dev, source_after.st_ino), source_identity
            )
            self.assertEqual(source_file.read_bytes(), source_bytes)

    @unittest.skipIf(os.name == "nt", "POSIX stage quarantine is required")
    def test_stage_child_swap_at_quarantine_rename_preserves_both_inodes_and_recovery(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-stage-quarantine-race-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-quarantine-race")
            source_file = source / "tree" / "a.txt"
            entry = next(item for item in manifest["files"] if item["path"] == "a.txt")
            stage_name = source_compaction._stage_name(entry)
            stage_root = (
                storage / "tmp" / "source-compaction" / "wt-1" / "capture-quarantine-race"
            )
            stage_path = stage_root / stage_name
            foreign_source = root / "foreign-stage-before-quarantine"
            foreign_bytes = b"foreign inode moved by the last-syscall race\\n"
            foreign_mode = 0o640
            foreign_source.write_bytes(foreign_bytes)
            foreign_source.chmod(foreign_mode)
            foreign_metadata = foreign_source.stat()
            foreign_identity = (foreign_metadata.st_dev, foreign_metadata.st_ino)
            saved_owned_stage = root / "authorized-stage-preserved"
            source_metadata = source_file.stat()
            source_identity = (source_metadata.st_dev, source_metadata.st_ino)
            source_mode = stat.S_IMODE(source_metadata.st_mode)
            source_bytes = source_file.read_bytes()
            original_rename = os.rename
            swapped = False
            commit_failed = False

            def race_at_quarantine_rename(
                source_name: str,
                destination_name: str,
                *,
                src_dir_fd: int | None = None,
                dst_dir_fd: int | None = None,
            ) -> None:
                nonlocal swapped, commit_failed
                if (
                    source_name == stage_name
                    and destination_name == source_file.name
                    and src_dir_fd is not None
                    and dst_dir_fd is not None
                ):
                    commit_failed = True
                    raise OSError("injected source commit failure")
                if (
                    source_name == stage_name
                    and destination_name == stage_name
                    and src_dir_fd is not None
                    and dst_dir_fd is not None
                    and src_dir_fd != dst_dir_fd
                    and commit_failed
                    and not swapped
                ):
                    original_rename(
                        source_name, saved_owned_stage, src_dir_fd=src_dir_fd
                    )
                    original_rename(foreign_source, stage_path)
                    original_rename(
                        source_name,
                        destination_name,
                        src_dir_fd=src_dir_fd,
                        dst_dir_fd=dst_dir_fd,
                    )
                    swapped = True
                    return
                original_rename(
                    source_name,
                    destination_name,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                )

            with patch.object(
                source_compaction.os,
                "rename",
                side_effect=race_at_quarantine_rename,
            ) as rename_hook:
                with patch.object(
                    source_compaction.os,
                    "supports_dir_fd",
                    source_compaction.os.supports_dir_fd | {rename_hook},
                ):
                    with self.assertRaisesRegex(
                        source_compaction.SourceCompactionError,
                        "preserving stage quarantine entry",
                    ):
                        source_compaction.compact_source_capsule(
                            storage, source, manifest["source_digest"]
                        )

            self.assertTrue(commit_failed)
            self.assertTrue(swapped)
            quarantine_dirs = list(stage_root.glob(".compact-quarantine-*"))
            self.assertEqual(len(quarantine_dirs), 1)
            quarantined_foreign = quarantine_dirs[0] / stage_name
            quarantined_metadata = quarantined_foreign.stat()
            self.assertEqual(
                (quarantined_metadata.st_dev, quarantined_metadata.st_ino),
                foreign_identity,
            )
            self.assertEqual(
                stat.S_IMODE(quarantined_metadata.st_mode), foreign_mode
            )
            self.assertEqual(quarantined_foreign.read_bytes(), foreign_bytes)

            store = SourceContentStore(storage / "cache" / "source-content-v1")
            object_path = store._object_path(entry["sha256"], entry["mode"])
            self.assertTrue(os.path.samefile(saved_owned_stage, object_path))
            store._verify_object(
                object_path,
                digest=entry["sha256"],
                mode=entry["mode"],
                size=entry["size"],
            )
            source_after = source_file.stat()
            self.assertEqual(
                (source_after.st_dev, source_after.st_ino), source_identity
            )
            self.assertEqual(stat.S_IMODE(source_after.st_mode), source_mode)
            self.assertEqual(source_file.read_bytes(), source_bytes)

            receipt_path = source_compaction.compaction_receipt_path(storage, source)
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["state"], "partial_failure")
            self.assertIn(str(quarantined_foreign), receipt["last_error"])

            with self.assertRaisesRegex(
                source_compaction.SourceCompactionError,
                "unreconciled stage quarantine remains; preserving it",
            ):
                source_compaction.compact_source_capsule(
                    storage, source, manifest["source_digest"]
                )
            recovered_receipt = json.loads(
                receipt_path.read_text(encoding="utf-8")
            )
            self.assertEqual(recovered_receipt["state"], "partial_failure")
            self.assertIn(
                str(quarantine_dirs[0]), recovered_receipt["last_error"]
            )
            final_foreign_metadata = quarantined_foreign.stat()
            self.assertEqual(
                (final_foreign_metadata.st_dev, final_foreign_metadata.st_ino),
                foreign_identity,
            )
            self.assertEqual(
                stat.S_IMODE(final_foreign_metadata.st_mode), foreign_mode
            )
            self.assertEqual(quarantined_foreign.read_bytes(), foreign_bytes)

    @unittest.skipIf(os.name != "posix", "POSIX descriptor-relative APIs are required")
    def test_missing_descriptor_relative_api_fails_closed_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-parent-api-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-no-dirfd")
            source_file = source / "tree" / "a.txt"
            before = source_file.stat()
            content = source_file.read_bytes()

            with patch.object(source_compaction.os, "supports_dir_fd", set()):
                with self.assertRaisesRegex(
                    source_compaction.SourceCompactionError,
                    "descriptor-relative source-parent operations are unsupported",
                ):
                    source_compaction.compact_source_capsule(
                        storage, source, manifest["source_digest"]
                    )

            after = source_file.stat()
            self.assertEqual((after.st_dev, after.st_ino), (before.st_dev, before.st_ino))
            self.assertEqual(stat.S_IMODE(after.st_mode), stat.S_IMODE(before.st_mode))
            self.assertEqual(source_file.read_bytes(), content)

    @unittest.skipUnless(os.name == "nt", "Win32 owner-handle behavior is Windows-specific")
    def test_windows_owner_handle_blocks_parent_rename_and_releases_after_success(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-parent-owner-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-owner")
            source_file = source / "tree" / "a.txt"
            source_root = source_file.parent.parent
            tree_path = source_file.parent
            moved_tree = source_root / "tree-moved"
            source_root_mode = stat.S_IMODE(source_root.stat().st_mode)
            original_replace = os.replace
            original_rename = os.rename
            blocked: list[bool] = []

            def observe_owner_lock(source_path: os.PathLike[str] | str,
                                  destination_path: os.PathLike[str] | str) -> None:
                if Path(destination_path) == source_file:
                    source_root.chmod(source_root_mode | stat.S_IWUSR)
                    try:
                        original_rename(tree_path, moved_tree)
                    except OSError:
                        blocked.append(True)
                    else:
                        original_rename(moved_tree, tree_path)
                        raise AssertionError("Windows source-parent owner allowed rename")
                    finally:
                        source_root.chmod(source_root_mode)
                original_replace(source_path, destination_path)

            with patch.object(
                source_compaction.os, "replace", side_effect=observe_owner_lock
            ):
                result = source_compaction.compact_source_capsule(
                    storage, source, manifest["source_digest"]
                )
            self.assertEqual(result["state"], "completed")
            self.assertEqual(blocked, [True])

            source_root.chmod(source_root_mode | stat.S_IWUSR)
            original_rename(tree_path, moved_tree)
            original_rename(moved_tree, tree_path)
            source_root.chmod(source_root_mode)

    @unittest.skipUnless(os.name == "nt", "Win32 CAS readonly attributes are required")
    def test_cas_seal_is_restored_when_readonly_clear_changes_state_then_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-cas-reseal-error-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-reseal-error")
            source_file = source / "tree" / "a.txt"
            entry = next(item for item in manifest["files"] if item["path"] == "a.txt")
            store = SourceContentStore(storage / "cache" / "source-content-v1")
            object_path = store._object_path(entry["sha256"], entry["mode"])
            source_before = source_file.stat()
            source_bytes = source_file.read_bytes()
            original_replace = os.replace
            original_chmod = Path.chmod
            cleared_then_failed = False

            def fail_source_commit(source_path, destination_path):
                if Path(destination_path) == source_file:
                    raise OSError("injected source commit failure")
                return original_replace(source_path, destination_path)

            def fail_after_readonly_clear(path, mode, *args, **kwargs):
                nonlocal cleared_then_failed
                result = original_chmod(path, mode, *args, **kwargs)
                if Path(path) == object_path and mode == 0o666 and not cleared_then_failed:
                    cleared_then_failed = True
                    raise OSError("injected failure after clearing CAS readonly")
                return result

            with patch.object(source_compaction.os, "replace", side_effect=fail_source_commit):
                with patch.object(Path, "chmod", new=fail_after_readonly_clear):
                    with self.assertRaises(source_compaction.SourceCompactionError):
                        source_compaction.compact_source_capsule(
                            storage, source, manifest["source_digest"]
                        )

            self.assertTrue(cleared_then_failed)
            store._verify_object(
                object_path, digest=entry["sha256"], mode=entry["mode"], size=entry["size"]
            )
            self.assertTrue(source_compaction._readonly_seal(object_path.stat(), entry["mode"]))
            source_after = source_file.stat()
            self.assertEqual((source_after.st_dev, source_after.st_ino),
                             (source_before.st_dev, source_before.st_ino))
            self.assertEqual(stat.S_IMODE(source_after.st_mode), stat.S_IMODE(source_before.st_mode))
            self.assertEqual(source_file.read_bytes(), source_bytes)
            stage_root = storage / "tmp" / "source-compaction" / "wt-1" / "capture-reseal-error"
            stage_path = stage_root / source_compaction._stage_name(entry)
            self.assertTrue(stage_path.is_file())
            self.assertTrue(os.path.samefile(stage_path, object_path))
            receipt = json.loads(source_compaction.compaction_receipt_path(storage, source).read_text())
            self.assertEqual(receipt["state"], "partial_failure")

    @unittest.skipIf(os.name == "nt", "directory fsync is not supported on Windows")
    def test_source_parent_sync_precedes_checkpoint_and_completed_receipt(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-compaction-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-a")
            source_parent = source / "tree"
            events: list[tuple[object, ...]] = []
            real_sync = source_compaction._fsync_source_parent
            real_write_receipt = source_compaction._write_receipt

            def observe_sync(directory: Path, *, owner: object | None = None) -> None:
                events.append(("source_parent_fsync", directory))
                real_sync(directory, owner=owner)

            def observe_receipt(path: Path, receipt: dict[str, object]) -> None:
                if receipt.get("checkpoint_files", 0) > 0:
                    events.append(("receipt", receipt.get("state"), receipt["checkpoint_files"]))
                real_write_receipt(path, receipt)

            with (
                patch.object(source_compaction, "_CHECKPOINT_FILES", 1),
                patch.object(source_compaction, "_fsync_source_parent", side_effect=observe_sync),
                patch.object(source_compaction, "_write_receipt", side_effect=observe_receipt),
            ):
                result = source_compaction.compact_source_capsule(
                    storage, source, manifest["source_digest"]
                )

            self.assertEqual(result["state"], "completed")
            sync_indices = [
                index
                for index, event in enumerate(events)
                if event == ("source_parent_fsync", source_parent)
            ]
            self.assertEqual(len(sync_indices), 1)
            receipt_indices = [
                index for index, event in enumerate(events) if event[0] == "receipt"
            ]
            self.assertEqual(
                [events[index][1] for index in receipt_indices],
                ["running", "completed"],
            )
            self.assertTrue(all(sync_indices[0] < index for index in receipt_indices))

    @unittest.skipIf(os.name == "nt", "directory fsync is not supported on Windows")
    def test_source_parent_sync_failure_is_partial_and_resume_completes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-compaction-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-a")
            source_file = source / "tree" / "a.txt"

            real_sync = source_compaction._fsync_source_parent

            def fail_source_parent_sync(directory: Path, *, owner: object | None = None) -> None:
                if directory == source_file.parent:
                    raise OSError("injected source-parent fsync failure")
                real_sync(directory, owner=owner)

            with patch.object(
                source_compaction,
                "_fsync_source_parent",
                side_effect=fail_source_parent_sync,
            ):
                with self.assertRaises(source_compaction.SourceCompactionError):
                    source_compaction.compact_source_capsule(
                        storage, source, manifest["source_digest"]
                    )

            receipt_path = source_compaction.compaction_receipt_path(storage, source)
            failed_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(failed_receipt["state"], "partial_failure")
            self.assertEqual(
                verify_source(source, manifest["source_digest"])["source_digest"],
                manifest["source_digest"],
            )
            entry = manifest["files"][0]
            object_path = SourceContentStore(
                storage / "cache" / "source-content-v1"
            )._object_path(entry["sha256"], entry["mode"])
            self.assertTrue(os.path.samefile(source_file, object_path))

            resumed = source_compaction.compact_source_capsule(
                storage, source, manifest["source_digest"]
            )
            final_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(resumed["state"], "completed")
            self.assertEqual(resumed["skipped_count"], 1)
            self.assertEqual(final_receipt["state"], "completed")

    def test_source_parent_sync_does_not_open_directories_on_windows(self) -> None:
        directory = Path("unused-source-parent")
        with (
            patch.object(source_compaction.os, "name", "nt"),
            patch.object(source_compaction.os, "open") as open_directory,
            patch.object(source_compaction.os, "fsync") as fsync_directory,
        ):
            source_compaction._fsync_source_parent(directory)
        open_directory.assert_not_called()
        fsync_directory.assert_not_called()

    def test_unsafe_source_symlink_is_rejected_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-compaction-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            external, manifest = _capture(storage, repo, "capture-external")
            canonical_source = storage / "runs" / "wt-1" / "capture-unsafe" / "source"
            canonical_source.parent.mkdir(parents=True)
            try:
                canonical_source.symlink_to(external, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"directory symlinks are unavailable: {error}")

            with self.assertRaises(source_compaction.SourceCompactionError):
                source_compaction.compact_source_capsule(
                    storage, canonical_source, manifest["source_digest"]
                )
            self.assertEqual(
                verify_source(external, manifest["source_digest"])["source_digest"],
                manifest["source_digest"],
            )
            self.assertFalse((storage / "cache" / "source-content-v1").exists())

    def test_foreign_hardlink_is_protected_without_chmod_or_replace(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-compaction-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-a")
            original = source / "tree" / "a.txt"
            external = root / "foreign-link.txt"
            try:
                os.link(original, external)
            except OSError as error:
                self.skipTest(f"hard links are unavailable: {error}")
            original_mode = original.stat().st_mode
            original_attributes = getattr(original.stat(), "st_file_attributes", 0)
            original_identity = (original.stat().st_dev, original.stat().st_ino)

            result = source_compaction.compact_source_capsule(
                storage, source, manifest["source_digest"]
            )

            self.assertEqual(result["protected_count"], 1)
            self.assertEqual(result["state"], "completed_with_protected_files")
            self.assertEqual(result["converted_count"], 0)
            self.assertEqual((original.stat().st_dev, original.stat().st_ino), original_identity)
            self.assertEqual(original.stat().st_mode, original_mode)
            self.assertEqual(
                getattr(original.stat(), "st_file_attributes", 0), original_attributes
            )
            self.assertTrue(os.path.samefile(original, external))
            self.assertEqual(original.stat().st_nlink, 2)
            self.assertEqual(
                verify_source(source, manifest["source_digest"])["source_digest"],
                manifest["source_digest"],
            )

    def test_cas_hardlinks_remain_readonly_and_verified(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-compaction-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-a")
            result = source_compaction.compact_source_capsule(
                storage, source, manifest["source_digest"]
            )
            self.assertEqual(result["converted_count"], 1)
            entry = manifest["files"][0]
            object_path = SourceContentStore(storage / "cache" / "source-content-v1")._object_path(
                entry["sha256"], entry["mode"]
            )
            metadata = object_path.stat()
            if os.name == "nt":
                self.assertTrue(getattr(metadata, "st_file_attributes", 0) & 0x1)
            else:
                self.assertEqual(metadata.st_mode & 0o777, 0o444)
            self.assertTrue(os.path.samefile(source / "tree" / "a.txt", object_path))
            self.assertEqual(
                hashlib.sha256(object_path.read_bytes()).hexdigest(), entry["sha256"]
            )

    def test_corrupt_existing_cas_object_is_rejected_without_repair(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-compaction-") as raw:
            root = Path(raw)
            storage = root / "storage"
            storage.mkdir()
            repo, _ = _repository(root, one_file=True)
            source, manifest = _capture(storage, repo, "capture-a")
            entry = manifest["files"][0]
            object_path = SourceContentStore(storage / "cache" / "source-content-v1")._object_path(
                entry["sha256"], entry["mode"]
            )
            object_path.parent.mkdir(parents=True)
            object_path.write_bytes(b"corrupt")
            object_path.chmod(0o444)

            with self.assertRaises(source_compaction.SourceCompactionError):
                source_compaction.compact_source_capsule(
                    storage, source, manifest["source_digest"]
                )
            self.assertEqual(object_path.read_bytes(), b"corrupt")
            self.assertEqual(
                verify_source(source, manifest["source_digest"])["source_digest"],
                manifest["source_digest"],
            )


if __name__ == "__main__":
    unittest.main()
