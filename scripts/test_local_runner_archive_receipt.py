import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch

from local_runner.archive_receipt import validate_archive_receipt
from local_runner.build_executor import validate_build_receipt
from local_runner.worker_entrypoint import canonical


class ArchiveReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run_root = Path(self.tmp.name) / "runs" / "archive-worktree" / ("c" * 32)
        self.root = self.run_root / "artifacts"
        native = {"head_commit_full": "a" * 40, "source_snapshot_sha256": "b" * 64}
        self.job = {"job_id": "c" * 32, "source_digest": "d" * 64,
                    "worktree_id": "archive-worktree", "owner": "operator",
                    "profile": "fem-cpu-slepc-runtime-v2", "state": "succeeded", "exit_code": 0,
                    "payload": {"native_source_identity": native}}
        self.journal = {"schema": "fullmag.local-runner.coordinator.v1",
                        "image_digest": "sha256:" + "e" * 64, "job_id": self.job["job_id"],
                        "worktree_id": self.job["worktree_id"], "owner": self.job["owner"],
                        "source_digest": self.job["source_digest"], "profile": self.job["profile"],
                        "phase": "terminal", "state": "succeeded", "exit_code": 0}
        self.receipt = {"schema": "fullmag.local-runner.build-receipt.v1",
                        "job_id": self.job["job_id"], "source_digest": self.job["source_digest"],
                        "profile": self.job["profile"], "state": "succeeded", "qualification": "NOT VERIFIED",
                        "image_digest": self.journal["image_digest"], "native_source_identity": native,
                        "native_source_identity_sha256": hashlib.sha256(canonical(native)).hexdigest(),
                        "runtime_only": True, "runtime_contract": {"cmake_options": {"FULLMAG_ENABLE_FEM_GPU": "ON"}},
                        "stages": [{"name": "native-build", "exit_code": 0}], "artifacts": []}
        self.add_artifact("source-identity.json", json.dumps(native).encode())
        self.add_artifact("outputs/result.bin", b"archived bytes")
        self.add_artifact("outputs/.fullmag/local/bin/runtime.bin", b"runtime bytes")
        self.save()

    def add_artifact(self, name, data):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        self.receipt["artifacts"].append({"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})

    def save(self):
        (self.root / "build-receipt.json").write_text(json.dumps(self.receipt))

    def publish_removed_runtime_tombstone(self):
        from local_runner.retention import inspect_execution

        package = self.root / "outputs" / ".fullmag" / "local"
        tree_identity = inspect_execution(package)
        run_info = os.lstat(self.run_root)
        quarantine_path = self.run_root / ".runtime-package-quarantine-plan-1234abcd"
        quarantine_path.mkdir()
        quarantine_info = os.lstat(quarantine_path)
        quarantine_path.rmdir()
        tombstone_path = self.root / "runtime-package-retention.json"
        tombstone = {
            "schema": "fullmag.runtime-package-retention.v1",
            "state": "removed",
            "deletion_state": "deleted",
            "plan_id": "plan-1234abcd",
            "job_id": self.job["job_id"],
            "worktree_id": self.job["worktree_id"],
            "source_digest": self.job["source_digest"],
            "package_relative": "outputs/.fullmag/local",
            "build_receipt_sha256": hashlib.sha256(
                (self.root / "build-receipt.json").read_bytes(),
            ).hexdigest(),
            "package_tree_identity": tree_identity,
            "run_root_identity": {"device": run_info.st_dev, "inode": run_info.st_ino},
            "quarantine_identity": {"device": quarantine_info.st_dev, "inode": quarantine_info.st_ino},
            "quarantine_path": str(quarantine_path),
            "moved_path": str(quarantine_path / "package"),
            "removed_logical_bytes": tree_identity["logical_bytes"],
            "started_at": 1.0,
            "moved_at": 2.0,
            "tree_removed_at": 3.0,
            "finished_at": 4.0,
            "receipt": str(tombstone_path),
        }
        shutil.rmtree(package)
        tombstone_path.write_text(json.dumps(tombstone))
        return tombstone_path, tombstone

    def test_historical_contract_integrity_is_not_runtime_compatibility(self):
        self.assertEqual(validate_archive_receipt(self.root, self.job, self.journal), self.receipt)
        with self.assertRaisesRegex(ValueError, "runtime contract mismatch"):
            validate_build_receipt(self.root, self.job, self.journal)

    def test_corrupt_artifact_is_rejected(self):
        (self.root / "outputs/result.bin").write_bytes(b"changed bytes!")
        with self.assertRaises(ValueError):
            validate_archive_receipt(self.root, self.job, self.journal)

    def test_identity_schema_stages_and_members_are_fail_closed(self):
        baseline = copy.deepcopy(self.receipt)
        for mutate in (
            lambda r: r.update(schema="unknown"),
            lambda r: r.update(job_id="wrong"),
            lambda r: r.update(image_digest="wrong"),
            lambda r: r.update(native_source_identity_sha256="wrong"),
            lambda r: r.update(stages=[]),
            lambda r: r["stages"][0].update(exit_code=1),
            lambda r: r["artifacts"].append(dict(r["artifacts"][0])),
            lambda r: r["artifacts"][1].update(path="../escape"),
            lambda r: r["artifacts"][1].update(path="C:/escape"),
            lambda r: r["artifacts"][1].update(size=True),
            lambda r: r["artifacts"][1].update(sha256="wrong"),
        ):
            with self.subTest(mutate=mutate):
                self.receipt = copy.deepcopy(baseline)
                mutate(self.receipt)
                self.save()
                with self.assertRaises(ValueError):
                    validate_archive_receipt(self.root, self.job, self.journal)

    def test_symlink_artifact_is_rejected(self):
        p = self.root / "outputs/result.bin"
        p.unlink()
        try:
            p.symlink_to(self.root / "source-identity.json")
        except OSError:
            self.skipTest("host does not permit symlinks")
        with self.assertRaises(ValueError):
            validate_archive_receipt(self.root, self.job, self.journal)

    def test_completed_runtime_tombstone_allows_only_removed_package_artifacts(self):
        self.publish_removed_runtime_tombstone()

        self.assertEqual(validate_archive_receipt(self.root, self.job, self.journal), self.receipt)

    def test_archive_documents_reject_regular_replacement_before_open(self):
        from local_runner import retention_persistence

        self.publish_removed_runtime_tombstone()
        for name in ("build-receipt.json", "runtime-package-retention.json"):
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                replacement = path.with_name(path.name + ".foreign")
                replacement.write_bytes(b"foreign replacement bytes")
                real_open = retention_persistence._open_nofollow_file
                state = {"swapped": False}

                def replace_before_open(candidate):
                    if Path(candidate) == path and not state["swapped"]:
                        state["swapped"] = True
                        path.unlink()
                        os.replace(replacement, path)
                    return real_open(candidate)

                with patch.object(
                    retention_persistence, "_open_nofollow_file",
                    side_effect=replace_before_open,
                ):
                    with self.assertRaisesRegex(ValueError, "Cannot safely read"):
                        validate_archive_receipt(self.root, self.job, self.journal)
                self.assertTrue(state["swapped"])
                self.assertEqual(b"foreign replacement bytes", path.read_bytes())
                path.write_bytes(original)

    def test_archive_documents_reject_reparse_replacement_before_open(self):
        from local_runner import retention_persistence

        self.publish_removed_runtime_tombstone()
        source = self.root / "foreign-source.json"
        source.write_bytes(b"foreign reparse target")
        for name in ("build-receipt.json", "runtime-package-retention.json"):
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                real_open = retention_persistence._open_nofollow_file
                state = {"swapped": False}

                def replace_before_open(candidate):
                    if Path(candidate) == path and not state["swapped"]:
                        state["swapped"] = True
                        path.unlink()
                        try:
                            path.symlink_to(source)
                        except OSError as error:
                            self.skipTest(f"symlink race fixture unavailable: {error}")
                    return real_open(candidate)

                with patch.object(
                    retention_persistence, "_open_nofollow_file",
                    side_effect=replace_before_open,
                ):
                    with self.assertRaises(ValueError):
                        validate_archive_receipt(self.root, self.job, self.journal)
                self.assertTrue(state["swapped"])
                self.assertTrue(path.is_symlink())
                self.assertEqual(b"foreign reparse target", source.read_bytes())
                path.unlink()
                path.write_bytes(original)

    def test_posix_fifo_swap_of_archive_documents_is_bounded_and_rejected(self):
        if os.name != "posix" or not hasattr(os, "mkfifo"):
            self.skipTest("POSIX FIFO fixture is unavailable")

        import subprocess
        import sys

        self.publish_removed_runtime_tombstone()
        child_script = r"""import os
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from local_runner import retention_persistence
from local_runner.archive_receipt import validate_archive_receipt

artifacts = Path(sys.argv[2])
target = Path(sys.argv[3])
job = json.loads(sys.argv[4])
journal = json.loads(sys.argv[5])
real_open = retention_persistence._open_nofollow_file

def swap_to_fifo(path):
    if Path(path) == target:
        target.unlink()
        os.mkfifo(target)
    return real_open(path)

retention_persistence._open_nofollow_file = swap_to_fifo
try:
    try:
        validate_archive_receipt(artifacts, job, journal)
    except ValueError as error:
        if "Cannot safely read" not in str(error):
            raise
    else:
        raise AssertionError("raced FIFO archive document was accepted")
finally:
    retention_persistence._open_nofollow_file = real_open
print("raced FIFO rejected")
"""
        # The subprocess import namespace is the checkout's scripts directory.
        for name in ("build-receipt.json", "runtime-package-retention.json"):
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                completed = None
                try:
                    completed = subprocess.run(
                        [
                            sys.executable, "-c", child_script,
                            str(Path(__file__).resolve().parent), str(self.root), str(path),
                            json.dumps(self.job), json.dumps(self.journal),
                        ],
                        capture_output=True, text=True, timeout=5, check=False,
                    )
                except subprocess.TimeoutExpired:
                    self.fail("archive document reader blocked opening a raced FIFO")
                self.assertEqual(0, completed.returncode, completed.stderr)
                self.assertIn("raced FIFO rejected", completed.stdout)
                self.assertTrue(stat.S_ISFIFO(os.lstat(path).st_mode))
                path.unlink()
                path.write_bytes(original)

    def test_incomplete_or_foreign_runtime_tombstone_is_rejected(self):
        tombstone_path, original = self.publish_removed_runtime_tombstone()
        mutations = (
            lambda value: value.update(state="deleting", deletion_state="removal_started"),
            lambda value: value.update(state="partial_error", deletion_state="unknown_after_restart"),
            lambda value: value.update(deletion_state="tree_removed"),
            lambda value: value.update(job_id="foreign"),
            lambda value: value.update(worktree_id="foreign-worktree"),
            lambda value: value.update(source_digest="0" * 64),
            lambda value: value.update(package_relative="outputs/.fullmag/local-alias"),
            lambda value: value.update(build_receipt_sha256="0" * 64),
            lambda value: value.update(receipt=str(self.run_root / "foreign.json")),
            lambda value: value.update(quarantine_path=str(self.run_root / "foreign-quarantine")),
            lambda value: value.update(moved_path=str(self.run_root / "foreign-quarantine/package")),
            lambda value: value.update(run_root_identity={"device": 1, "inode": 2}),
            lambda value: value.update(package_tree_identity={"files": 999}),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                candidate = dict(original)
                mutate(candidate)
                tombstone_path.write_text(json.dumps(candidate))
                with self.assertRaises(ValueError):
                    validate_archive_receipt(self.root, self.job, self.journal)
        tombstone_path.write_text("not json")
        with self.assertRaises(ValueError):
            validate_archive_receipt(self.root, self.job, self.journal)
        tombstone_path.write_text(json.dumps(original))

        self.journal["owner"] = "foreign"
        with self.assertRaisesRegex(ValueError, "journal identity mismatch"):
            validate_archive_receipt(self.root, self.job, self.journal)
        self.journal["owner"] = self.job["owner"]
        self.journal["profile"] = "foreign-profile"
        with self.assertRaisesRegex(ValueError, "journal identity mismatch"):
            validate_archive_receipt(self.root, self.job, self.journal)

    def test_runtime_tombstone_cannot_mask_changed_receipt_other_artifact_or_reappeared_package(self):
        self.publish_removed_runtime_tombstone()
        receipt_path = self.root / "build-receipt.json"
        receipt_bytes = receipt_path.read_bytes()
        receipt_path.write_bytes(receipt_bytes + b" ")
        with self.assertRaisesRegex(ValueError, "tombstone identity mismatch"):
            validate_archive_receipt(self.root, self.job, self.journal)
        receipt_path.write_bytes(receipt_bytes)

        artifact = self.root / "outputs/result.bin"
        artifact.unlink()
        with self.assertRaises(ValueError):
            validate_archive_receipt(self.root, self.job, self.journal)
        artifact.write_bytes(b"archived bytes")

        package = self.root / "outputs" / ".fullmag" / "local"
        package.mkdir(parents=True)
        (package / "replacement.bin").write_bytes(b"unapproved replacement")
        with self.assertRaisesRegex(ValueError, "reappeared"):
            validate_archive_receipt(self.root, self.job, self.journal)

    def test_runtime_tombstone_rejects_unsafe_package_prefix(self):
        self.publish_removed_runtime_tombstone()
        package_parent = self.root / "outputs" / ".fullmag"
        shutil.rmtree(package_parent)
        outside = self.run_root / "outside"
        outside.mkdir()
        try:
            package_parent.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlink fixture unavailable: {error}")

        with self.assertRaisesRegex(ValueError, "unsafe_reparse_path"):
            validate_archive_receipt(self.root, self.job, self.journal)

    def test_runtime_tombstone_does_not_authorize_missing_package_ancestors(self):
        self.publish_removed_runtime_tombstone()
        outputs = self.root / "outputs"
        preserved_outputs = self.run_root / "outputs-preserved"
        shutil.move(outputs, preserved_outputs)
        with self.assertRaises(ValueError):
            validate_archive_receipt(self.root, self.job, self.journal)
        shutil.move(preserved_outputs, outputs)

        package_parent = outputs / ".fullmag"
        shutil.rmtree(package_parent)
        with self.assertRaises(ValueError):
            validate_archive_receipt(self.root, self.job, self.journal)
        package_parent.mkdir()
        self.assertEqual(validate_archive_receipt(self.root, self.job, self.journal), self.receipt)


if __name__ == "__main__":
    unittest.main()
