"""Interpreted checks for request-scoped frozen-snapshot verification reuse."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from windows import build_snapshot, select_development_candidate


class SnapshotVerificationReuseChecks(unittest.TestCase):
    def setUp(self):
        temp_root = Path(os.environ.get("FULLMAG_TEST_TEMP_ROOT", tempfile.gettempdir()))
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.build = self.root / "build"
        self.build.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "snapshot-reuse@example.invalid")
        self.git("config", "user.name", "Snapshot Reuse Fixture")
        self.git("config", "core.autocrlf", "false")
        self.source_file = self.repo / "crates/demo/src/lib.rs"
        self.source_file.parent.mkdir(parents=True)
        self.source_file.write_bytes(b"pub const FIXTURE: u8 = 1;\r\n")
        (self.repo / "Cargo.toml").write_text("[workspace]\nmembers = []\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.PIPE)

    def make_snapshot(self):
        metadata = build_snapshot.create_snapshot(self.repo, self.build)
        self.addCleanup(self.writable, Path(metadata["source_root"]).parent)
        return metadata

    @staticmethod
    def writable(root):
        for path in root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                path.chmod(0o600)

    @staticmethod
    def rewrite_record(record_path, content):
        record_path.chmod(0o600)
        record_path.write_bytes(content)

    def test_selector_sequence_has_two_full_inventory_passes(self):
        metadata = self.make_snapshot()
        original_inventory = build_snapshot._inventory
        with patch.object(build_snapshot, "_inventory", wraps=original_inventory) as inventory:
            with build_snapshot.snapshot_verification_scope():
                initial = build_snapshot.verify_snapshot(metadata["record_path"], self.build)
                initial["source_identity"]["head_commit_full"] = "0" * 40
                first_nested = build_snapshot.verify_snapshot(metadata["record_path"], self.build)
                second_nested = build_snapshot.verify_snapshot(metadata["record_path"], self.build)
                final = build_snapshot.verify_snapshot(
                    metadata["record_path"], self.build, force_verify=True
                )
                self.assertEqual(first_nested, second_nested)
                self.assertEqual(second_nested, final)
                self.assertEqual(final["source_identity"]["head_commit_full"],
                                 metadata["source_identity"]["head_commit_full"])
            self.assertEqual(inventory.call_count, 2)

        # Scope exit drops the cache; the next standalone request is full again.
        with patch.object(build_snapshot, "_inventory", wraps=original_inventory) as inventory:
            build_snapshot.verify_snapshot(metadata["record_path"], self.build)
        self.assertEqual(inventory.call_count, 1)

    def test_selector_entrypoint_owns_the_verification_scope(self):
        metadata = self.make_snapshot()
        original_inventory = build_snapshot._inventory

        def selector_body(_repo_root, _request):
            first = build_snapshot.verify_snapshot(metadata["record_path"], self.build)
            second = build_snapshot.verify_snapshot(metadata["record_path"], self.build)
            return first, second

        with patch.object(build_snapshot, "_inventory", wraps=original_inventory) as inventory:
            with patch.object(select_development_candidate, "_validate_request_scoped", side_effect=selector_body):
                first, second = select_development_candidate.validate_request("unused", {})
        self.assertEqual(first, second)
        self.assertEqual(inventory.call_count, 1)

    def test_forced_final_pass_detects_source_mutation_inside_scope(self):
        metadata = self.make_snapshot()
        with build_snapshot.snapshot_verification_scope():
            build_snapshot.verify_snapshot(metadata["record_path"], self.build)
            # The nested manifest load can reuse the exact record-bound result.
            build_snapshot.verify_snapshot(metadata["record_path"], self.build)
            frozen_file = Path(metadata["source_root"]) / "crates/demo/src/lib.rs"
            frozen_file.chmod(0o600)
            frozen_file.write_bytes(b"changed after initial verification")
            with self.assertRaises(build_snapshot.SnapshotError):
                build_snapshot.verify_snapshot(
                    metadata["record_path"], self.build, force_verify=True
                )

    def test_forced_final_pass_detects_identity_sidecar_mutation(self):
        metadata = self.make_snapshot()
        with build_snapshot.snapshot_verification_scope():
            build_snapshot.verify_snapshot(metadata["record_path"], self.build)
            identity = Path(metadata["source_identity_file"])
            self.rewrite_record(identity, b"{}\n")
            # Reuse is intermediate only; publication requires the final pass.
            build_snapshot.verify_snapshot(metadata["record_path"], self.build)
            with self.assertRaisesRegex(build_snapshot.SnapshotError, "source identity file changed"):
                build_snapshot.verify_snapshot(metadata["record_path"], self.build, force_verify=True)

    def test_changed_record_invalidates_cache_and_failed_records_are_not_cached(self):
        metadata = self.make_snapshot()
        record_path = Path(metadata["record_path"])
        original_bytes = record_path.read_bytes()
        original_verify = build_snapshot._verify_snapshot_full

        with patch.object(build_snapshot, "_verify_snapshot_full", wraps=original_verify) as full_verify:
            with build_snapshot.snapshot_verification_scope():
                build_snapshot.verify_snapshot(record_path, self.build)
                invalid = json.loads(original_bytes)
                invalid["inventory_sha256"] = "0" * 64
                self.rewrite_record(
                    record_path,
                    (json.dumps(invalid, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode(),
                )
                for _ in range(2):
                    with self.assertRaises(build_snapshot.SnapshotError):
                        build_snapshot.verify_snapshot(record_path, self.build)
                self.rewrite_record(record_path, original_bytes)
                build_snapshot.verify_snapshot(record_path, self.build)
            self.assertEqual(full_verify.call_count, 4)

    def test_record_change_during_full_verification_is_not_cached(self):
        metadata = self.make_snapshot()
        record_path = Path(metadata["record_path"])
        original_bytes = record_path.read_bytes()
        original_verify = build_snapshot._verify_snapshot_full
        mutated = False

        def mutate_after_full_verification(record, build_root):
            nonlocal mutated
            result = original_verify(record, build_root)
            if not mutated:
                self.rewrite_record(record_path, original_bytes + b" ")
                mutated = True
            return result

        with patch.object(build_snapshot, "_verify_snapshot_full", side_effect=mutate_after_full_verification) as full_verify:
            with build_snapshot.snapshot_verification_scope():
                with self.assertRaises(build_snapshot.SnapshotError):
                    build_snapshot.verify_snapshot(record_path, self.build)
                self.rewrite_record(record_path, original_bytes)
                result = build_snapshot.verify_snapshot(record_path, self.build)
                self.assertEqual(result["snapshot_id"], metadata["snapshot_id"])
            self.assertEqual(full_verify.call_count, 2)

    def test_scope_resets_on_exception_and_is_not_shared_with_new_threads(self):
        metadata = self.make_snapshot()
        original_inventory = build_snapshot._inventory
        with patch.object(build_snapshot, "_inventory", wraps=original_inventory) as inventory:
            with self.assertRaisesRegex(RuntimeError, "scope exit"):
                with build_snapshot.snapshot_verification_scope():
                    build_snapshot.verify_snapshot(metadata["record_path"], self.build)
                    build_snapshot.verify_snapshot(metadata["record_path"], self.build)
                    result = []
                    errors = []

                    def verify_in_new_thread():
                        try:
                            result.append(build_snapshot.verify_snapshot(metadata["record_path"], self.build))
                        except BaseException as error:  # Propagate a thread failure to this test.
                            errors.append(error)

                    thread = threading.Thread(target=verify_in_new_thread)
                    thread.start()
                    thread.join(timeout=30)
                    self.assertFalse(thread.is_alive())
                    self.assertEqual(errors, [])
                    self.assertEqual(result[0]["snapshot_id"], metadata["snapshot_id"])
                    build_snapshot.verify_snapshot(metadata["record_path"], self.build)
                    raise RuntimeError("scope exit")
            build_snapshot.verify_snapshot(metadata["record_path"], self.build)
            with build_snapshot.snapshot_verification_scope():
                build_snapshot.verify_snapshot(metadata["record_path"], self.build)
        self.assertEqual(inventory.call_count, 4)

    def test_supplied_metadata_path_root_and_source_root_mismatches_refuse(self):
        metadata = self.make_snapshot()
        with build_snapshot.snapshot_verification_scope():
            verified = build_snapshot.verify_snapshot(metadata["record_path"], self.build)
            altered = dict(verified, snapshot_id="0" * 64)
            with self.assertRaises(build_snapshot.SnapshotError):
                build_snapshot.verify_snapshot(altered, self.build)

            alias = self.build / "alias-record.json"
            alias.write_bytes(Path(metadata["record_path"]).read_bytes())
            with self.assertRaises(build_snapshot.SnapshotError):
                build_snapshot.verify_snapshot(alias, self.build)

            wrong_root = self.root / "other-build"
            wrong_root.mkdir()
            with self.assertRaises(build_snapshot.SnapshotError):
                build_snapshot.verify_snapshot(metadata["record_path"], wrong_root)

            source_root = Path(metadata["source_root"])
            real_checked_root = build_snapshot._checked_root

            def reject_source_root(path):
                if Path(path) == source_root:
                    raise build_snapshot.SnapshotError("source root chain changed")
                return real_checked_root(path)

            with patch.object(build_snapshot, "_checked_root", side_effect=reject_source_root):
                with self.assertRaises(build_snapshot.SnapshotError):
                    build_snapshot.verify_snapshot(metadata["record_path"], self.build)


if __name__ == "__main__":
    unittest.main()
