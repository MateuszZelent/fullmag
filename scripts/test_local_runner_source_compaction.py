from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
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
            real_replace = os.replace

            def fail_second_replace(source_path: os.PathLike[str] | str, destination_path: os.PathLike[str] | str) -> None:
                if Path(destination_path) == second_file:
                    raise OSError("injected replace failure")
                real_replace(source_path, destination_path)

            with patch.object(source_compaction.os, "replace", side_effect=fail_second_replace):
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
            self.assertEqual(
                hashlib.sha256(failed_object.read_bytes()).hexdigest(), failed_entry["sha256"]
            )
            if os.name == "nt":
                self.assertTrue(getattr(failed_object.stat(), "st_file_attributes", 0) & 0x1)
            else:
                self.assertEqual(failed_object.stat().st_mode & 0o777, 0o444)

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
