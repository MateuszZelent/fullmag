from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


try:
    from scripts.local_runner.build_entrypoint import materialize_capsule
    from scripts.local_runner import source_store
    from scripts.local_runner.source import SourceError, capture_source
    from scripts.local_runner.worker_entrypoint import verify_source
except ModuleNotFoundError:
    from local_runner.build_entrypoint import materialize_capsule
    from local_runner import source_store
    from local_runner.source import SourceError, capture_source
    from local_runner.worker_entrypoint import verify_source


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ("git", "-c", "core.filemode=false", *args),
        cwd=repo,
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def _repository(root: Path, *, script: bool = False) -> Path:
    repo = root / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "Local runner content-store tests")
    _git(repo, "config", "user.email", "local-runner-content-store@example.invalid")
    (repo / "tracked.txt").write_bytes(b"committed source\n")
    (repo / "deleted.txt").write_bytes(b"delete me\n")
    if script:
        (repo / "program.sh").write_bytes(b"#!/bin/sh\nprintf test\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "initial")
    return repo


def _capture(
    repo: Path,
    root: Path,
    name: str,
    *,
    store: Path | None,
    mode: str = "snapshot",
    ref: str | None = None,
    include_untracked: tuple[str, ...] = (),
):
    output = root / name
    output.mkdir()
    return output, capture_source(
        repo,
        output,
        mode=mode,
        ref=ref,
        include_untracked=include_untracked,
        **({"content_store": store} if store is not None else {}),
    )


def _object_path(store: Path, entry: dict[str, object]) -> Path:
    digest = str(entry["sha256"])
    mode = str(entry["mode"])
    return store / "sha256" / digest[:2] / f"{digest}-{mode}"


class LocalRunnerSourceStoreTests(unittest.TestCase):
    def test_parallel_captures_share_verified_objects_and_keep_v1_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            first = root / "capsule-one"
            second = root / "capsule-two"
            first.mkdir()
            second.mkdir()

            def capture(output: Path):
                return capture_source(repo, output, content_store=store)

            with ThreadPoolExecutor(max_workers=2) as executor:
                manifests = list(executor.map(capture, (first, second)))

            self.assertEqual(manifests[0]["schema_version"], "fullmag.source-capsule.v1")
            self.assertEqual(manifests[0]["source_digest"], manifests[1]["source_digest"])
            self.assertEqual(manifests[0]["files"], manifests[1]["files"])
            for output, manifest in ((first, manifests[0]), (second, manifests[1])):
                verified = verify_source(output, manifest["source_digest"])
                self.assertEqual(verified["source_digest"], manifest["source_digest"])

            entry = next(item for item in manifests[0]["files"] if item["path"] == "tracked.txt")
            first_file = first / "tree" / "tracked.txt"
            second_file = second / "tree" / "tracked.txt"
            object_file = _object_path(store, entry)
            self.assertTrue(os.path.samefile(first_file, second_file))
            self.assertTrue(os.path.samefile(first_file, object_file))
            if first_file.stat().st_nlink:
                self.assertGreaterEqual(first_file.stat().st_nlink, 3)
            self.assertFalse(object_file.with_name(object_file.name + ".lock").exists())

    def test_changed_bytes_get_a_distinct_object_and_execution_copy_is_private(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            first, first_manifest = _capture(repo, root, "capsule-one", store=store)
            first_entry = next(item for item in first_manifest["files"] if item["path"] == "tracked.txt")
            first_file = first / "tree" / "tracked.txt"
            object_file = _object_path(store, first_entry)
            original = first_file.read_bytes()

            execution = root / "execution"
            execution.mkdir()
            materialize_capsule(first_manifest, first, execution)
            execution_file = execution / "tracked.txt"
            self.assertFalse(os.path.samefile(execution_file, object_file))
            execution_file.write_bytes(b"private execution change\n")
            self.assertEqual(first_file.read_bytes(), original)
            self.assertEqual(object_file.read_bytes(), original)

            (repo / "tracked.txt").write_bytes(b"changed source\n")
            second, second_manifest = _capture(repo, root, "capsule-two", store=store)
            second_entry = next(item for item in second_manifest["files"] if item["path"] == "tracked.txt")
            second_file = second / "tree" / "tracked.txt"
            second_object = _object_path(store, second_entry)
            self.assertNotEqual(first_manifest["source_digest"], second_manifest["source_digest"])
            self.assertNotEqual(first_entry["sha256"], second_entry["sha256"])
            self.assertFalse(os.path.samefile(first_file, second_file))
            self.assertFalse(os.path.samefile(object_file, second_object))
            self.assertEqual(first_file.read_bytes(), original)
            self.assertEqual(second_file.read_bytes(), b"changed source\n")

    def test_store_and_legacy_capsules_preserve_dirty_snapshot_fidelity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            (repo / "tracked.txt").write_bytes(b"dirty tracked bytes\n")
            (repo / "deleted.txt").unlink()
            (repo / "input.txt").write_bytes(b"explicit untracked input\n")
            store = root / "storage" / "cache" / "source-content-v1"

            legacy, legacy_manifest = _capture(
                repo,
                root,
                "legacy-capsule",
                store=None,
                include_untracked=("input.txt",),
            )
            shared, shared_manifest = _capture(
                repo,
                root,
                "shared-capsule",
                store=store,
                include_untracked=("input.txt",),
            )

            self.assertEqual(legacy_manifest, shared_manifest)
            self.assertTrue(shared_manifest["dirty"])
            self.assertTrue(shared_manifest["working_tree_dirty"])
            self.assertEqual(shared_manifest["deleted"], ["deleted.txt"])
            self.assertEqual(shared_manifest["included_untracked"], ["input.txt"])
            self.assertEqual(
                (shared / "tree" / "tracked.txt").read_bytes(),
                b"dirty tracked bytes\n",
            )
            self.assertEqual(
                (shared / "tree" / "input.txt").read_bytes(),
                b"explicit untracked input\n",
            )
            self.assertFalse((shared / "tree" / "deleted.txt").exists())
            self.assertEqual(verify_source(legacy)["source_digest"], legacy_manifest["source_digest"])
            self.assertEqual(verify_source(shared)["source_digest"], shared_manifest["source_digest"])

    def test_zero_byte_and_executable_mode_have_separate_object_keys(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root, script=True)
            (repo / "empty.txt").write_bytes(b"")
            _git(repo, "add", "empty.txt")
            _git(repo, "commit", "-qm", "empty input")
            store = root / "storage" / "cache" / "source-content-v1"

            first, first_manifest = _capture(repo, root, "capsule-one", store=store)
            empty = next(item for item in first_manifest["files"] if item["path"] == "empty.txt")
            self.assertEqual(empty["size"], 0)
            self.assertEqual(empty["sha256"], hashlib.sha256(b"").hexdigest())
            self.assertEqual(_object_path(store, empty).stat().st_size, 0)
            script_before = next(
                item for item in first_manifest["files"] if item["path"] == "program.sh"
            )

            _git(repo, "update-index", "--chmod=+x", "program.sh")
            _git(repo, "commit", "-qm", "mark script executable")
            second, second_manifest = _capture(
                repo,
                root,
                "capsule-two",
                store=store,
                mode="commit",
                ref="HEAD",
            )
            script_after = next(
                item for item in second_manifest["files"] if item["path"] == "program.sh"
            )
            self.assertEqual(script_before["sha256"], script_after["sha256"])
            self.assertEqual(script_before["mode"], "100644")
            self.assertEqual(script_after["mode"], "100755")
            self.assertNotEqual(
                _object_path(store, script_before),
                _object_path(store, script_after),
            )
            self.assertFalse(
                os.path.samefile(
                    _object_path(store, script_before),
                    _object_path(store, script_after),
                )
            )
            self.assertEqual(verify_source(first)["source_digest"], first_manifest["source_digest"])
            self.assertEqual(verify_source(second)["source_digest"], second_manifest["source_digest"])

    def test_corrupt_existing_object_is_rejected_without_replacing_it(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            first, first_manifest = _capture(repo, root, "capsule-one", store=store)
            entry = next(item for item in first_manifest["files"] if item["path"] == "tracked.txt")
            object_file = _object_path(store, entry)
            object_file.chmod(0o666)
            object_file.write_bytes(b"corrupt existing object\n")
            object_file.chmod(0o555 if entry["mode"] == "100755" else 0o444)

            output = root / "capsule-two"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "content object digest or size mismatch"):
                capture_source(repo, output, content_store=store)
            self.assertEqual(tuple(output.iterdir()), ())

    def test_reparse_object_and_store_overlap_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            digest = hashlib.sha256(b"committed source\n").hexdigest()
            object_parent = store / "sha256" / digest[:2]
            object_parent.mkdir(parents=True)
            outside = root / "outside-object"
            outside.write_bytes(b"committed source\n")
            object_file = object_parent / f"{digest}-100644"
            try:
                object_file.symlink_to(outside)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlinks unavailable: {error}")

            output = root / "capsule"
            output.mkdir()
            with self.assertRaisesRegex(SourceError, "symlink or reparse point"):
                capture_source(repo, output, content_store=store)
            self.assertEqual(tuple(output.iterdir()), ())

            overlap_output = root / "overlap-capsule"
            overlap_output.mkdir()
            with self.assertRaisesRegex(SourceError, "overlaps the repository"):
                capture_source(repo, overlap_output, content_store=repo / "cache")
            self.assertEqual(tuple(overlap_output.iterdir()), ())

            dangling_target = root / "missing-target"
            dangling_store = root / "dangling-store"
            try:
                dangling_store.symlink_to(dangling_target, target_is_directory=True)
            except (OSError, NotImplementedError):
                pass
            else:
                escaped_output = root / "escaped-capsule"
                escaped_output.mkdir()
                with self.assertRaisesRegex(SourceError, "symlink or reparse point"):
                    capture_source(
                        repo,
                        escaped_output,
                        content_store=dangling_store / "source-content-v1",
                    )
                self.assertEqual(tuple(escaped_output.iterdir()), ())

    def test_atomic_publication_failure_does_not_fall_back_to_copy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store = root / "storage" / "cache" / "source-content-v1"
            output = root / "capsule"
            output.mkdir()
            with patch.object(source_store.os, "link", side_effect=OSError("simulated failure")):
                with self.assertRaisesRegex(SourceError, "atomic content object publication failed"):
                    capture_source(repo, output, content_store=store)
            self.assertEqual(tuple(output.iterdir()), ())
            self.assertEqual(
                tuple(store.glob("sha256/*/*.lock")),
                (),
            )

    def test_failed_post_publication_verification_removes_readonly_object(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store_path = root / "storage" / "cache" / "source-content-v1"
            output = root / "capsule"
            output.mkdir()
            store = source_store.SourceContentStore(store_path)
            with patch.object(
                source_store.SourceContentStore,
                "_verify_object",
                side_effect=source_store.SourceContentStoreError("simulated mismatch"),
            ):
                with self.assertRaisesRegex(SourceError, "simulated mismatch"):
                    capture_source(repo, output, content_store=store_path)

            digest = hashlib.sha256(b"committed source\n").hexdigest()
            object_file = store._object_path(digest, "100644")
            self.assertFalse(object_file.exists())
            self.assertFalse(object_file.with_name(object_file.name + ".lock").exists())
            self.assertEqual(tuple(output.iterdir()), ())

    def test_partial_capture_failure_cleans_stage_link_and_keeps_cas_sealed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-source-store-test-") as raw:
            root = Path(raw)
            repo = _repository(root)
            store_path = root / "storage" / "cache" / "source-content-v1"
            output = root / "capsule"
            output.mkdir()
            real_link = os.link
            link_calls = 0

            def fail_second_object_publication(source, destination, *args, **kwargs):
                nonlocal link_calls
                link_calls += 1
                if link_calls == 3:
                    raise OSError("simulated second-object publication failure")
                return real_link(source, destination, *args, **kwargs)

            with patch.object(
                source_store.os,
                "link",
                side_effect=fail_second_object_publication,
            ):
                with self.assertRaisesRegex(
                    SourceError,
                    "atomic content object publication failed",
                ):
                    capture_source(repo, output, content_store=store_path)

            first_digest = hashlib.sha256(b"delete me\n").hexdigest()
            first_object = store_path / "sha256" / first_digest[:2] / f"{first_digest}-100644"
            store = source_store.SourceContentStore(store_path)
            first_metadata = store._verify_object(
                first_object,
                digest=first_digest,
                mode="100644",
                size=len(b"delete me\n"),
            )
            self.assertEqual(first_object.read_bytes(), b"delete me\n")
            if first_object.stat().st_nlink:
                self.assertEqual(first_object.stat().st_nlink, 1)
            self.assertEqual(link_calls, 3)
            self.assertEqual(tuple(output.iterdir()), ())
            self.assertEqual(tuple(root.glob(".capsule.capture-*")), ())
            if os.name != "nt":
                self.assertEqual(first_metadata.st_mode & 0o777, 0o444)


if __name__ == "__main__":
    unittest.main()
