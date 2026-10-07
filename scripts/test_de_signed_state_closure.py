"""Interpreted regressions for frozen-input receipt coverage."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import de_signed_state_closure as closure


class SignedStateClosureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.case = Path(self.temp.name) / "case"
        self.meta = self.case / "eigen/metadata/sample_00003"
        self.meta.mkdir(parents=True)
        self.eq = self.meta / "equilibrium_artifact.v8.json"
        self.eq.write_text(json.dumps({"schema_version": "equilibrium_artifact.v8",
                                      "content_sha256": "sha256:" + "a" * 64}), encoding="utf-8")

    def test_all_dependencies_are_bound_with_distinct_raw_and_content_hashes(self):
        producer = self.case / "equilibrium/producer/metadata.json"
        producer.parent.mkdir(parents=True)
        producer.write_bytes(b'{"producer":"exact"}')
        nested = self.meta / "nonshared_source/mesh.bin"
        nested.parent.mkdir()
        nested.write_bytes(b"mesh-and-markers")
        artifacts = {"required_artifact_hashes": {"metadata.json": {"size": 5, "sha256": "b" * 64}}}
        closure.bind_signed_state_closure(self.case, artifacts)
        entries = {entry["path"]: entry for entry in artifacts["signed_state_closure"]["files"]}
        self.assertEqual(len(entries), 3)
        eq = entries[self.eq.relative_to(self.case).as_posix()]
        self.assertEqual(eq["sha256"], hashlib.sha256(self.eq.read_bytes()).hexdigest())
        self.assertNotEqual("sha256:" + eq["sha256"], eq["native_content_sha256"])
        self.assertIn(nested.relative_to(self.case).as_posix(), artifacts["required_artifact_hashes"])
        self.assertIn(producer.relative_to(self.case).as_posix(), artifacts["required_artifact_hashes"])
        self.assertEqual(artifacts["signed_state_closure"]["status"], "hash_bound_only")

    def test_missing_equilibrium_rejected(self):
        self.eq.unlink()
        with self.assertRaisesRegex(ValueError, "no exported equilibrium"):
            closure.collect_signed_state_closure(self.case)

    def test_tamper_changes_raw_binding(self):
        before = closure.collect_signed_state_closure(self.case)
        self.eq.write_text(self.eq.read_text() + "\n", encoding="utf-8")
        after = closure.collect_signed_state_closure(self.case)
        self.assertNotEqual(before["file_table_sha256"], after["file_table_sha256"])
        self.assertEqual(before["files"][0]["native_content_sha256"], after["files"][0]["native_content_sha256"])

    def test_invalid_schema_content_and_duplicate_keys_rejected(self):
        for payload in ('{"schema_version":"wrong"}',
                        '{"schema_version":"equilibrium_artifact.v8","content_sha256":"bad"}',
                        '{"schema_version":"equilibrium_artifact.v8","schema_version":"equilibrium_artifact.v8"}'):
            with self.subTest(payload=payload):
                self.eq.write_text(payload, encoding="utf-8")
                with self.assertRaises(ValueError):
                    closure.collect_signed_state_closure(self.case)

    def test_budget_rejected_without_mutating_receipt(self):
        artifacts = {"required_artifact_hashes": {}}
        with patch.object(closure, "MAX_TOTAL_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "budget"):
                closure.bind_signed_state_closure(self.case, artifacts)
        self.assertEqual(artifacts, {"required_artifact_hashes": {}})

    def test_conflicting_existing_binding_rejected(self):
        relative = self.eq.relative_to(self.case).as_posix()
        artifacts = {"required_artifact_hashes": {relative: {"size": 1, "sha256": "b" * 64}}}
        with self.assertRaisesRegex(ValueError, "conflicts"):
            closure.bind_signed_state_closure(self.case, artifacts)
        self.assertNotIn("signed_state_closure", artifacts)

    def test_link_in_tree_rejected(self):
        link = self.meta / "linked"
        try:
            link.symlink_to(self.temp.name, target_is_directory=True)
        except OSError:
            self.skipTest("host does not permit unprivileged directory symlinks")
        with self.assertRaisesRegex(ValueError, "link"):
            closure.collect_signed_state_closure(self.case)


    def test_driver_binds_closure_and_rejects_missing_state_before_success(self):
        from contextlib import ExitStack
        from types import SimpleNamespace
        import run_de_100nm_pilot as pilot
        for with_equilibrium in (True, False):
            with self.subTest(with_equilibrium=with_equilibrium), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary)
                meta = output / pilot.SIGNED_FIFTEEN_PILOT / "eigen/metadata"
                meta.mkdir(parents=True)
                if with_equilibrium:
                    (meta / "equilibrium_artifact.v8.json").write_bytes(self.eq.read_bytes())
                context = SimpleNamespace(layout={"repo_root": str(output)}, image_digest="sha256:fixture")
                with ExitStack() as stack:
                    stack.enter_context(patch.object(pilot.managed, "_run_request", return_value={"source": {}, "job": {}, "runtime": {}}))
                    stack.enter_context(patch.object(pilot.managed, "_compose_environment", return_value={}))
                    stack.enter_context(patch.object(pilot.subprocess, "run", return_value=SimpleNamespace(returncode=0)))
                    stack.enter_context(patch.object(pilot.managed, "_validate_case_artifacts", return_value={"required_artifact_hashes": {}}))
                    stack.enter_context(patch.object(pilot, "validate_rows", return_value={"sample_count": 15}))
                    stack.enter_context(patch.object(pilot, "validate_smoke_potential_fields", return_value={"status": "consistent"}))
                    stack.enter_context(patch.object(pilot, "signed_fifteen_campaign_identity", return_value={"mode": "serial"}))
                    stack.enter_context(patch.object(pilot.managed, "_cleanup_benchmark_container", return_value={"status": "verified_absent"}))
                    stack.enter_context(patch("builtins.print"))
                    code = pilot.execute(context, output, ["fixture-no-process"], "a" * 64,
                                         pilot=pilot.SIGNED_FIFTEEN_PILOT, parallel_mode="serial")
                result = json.loads((output / "run-result.json").read_text())
                self.assertEqual(code, 0 if with_equilibrium else 1)
                self.assertEqual(result["qualification"], "NOT VERIFIED")
                if with_equilibrium:
                    self.assertEqual(result["artifacts"]["signed_state_closure"]["status"], "hash_bound_only")
                    self.assertIn("eigen/metadata/equilibrium_artifact.v8.json", result["artifacts"]["required_artifact_hashes"])
                else:
                    self.assertEqual(result["status"], "failed")
                    self.assertIn("no exported equilibrium", result["error"])


    def test_enumeration_error_cannot_silently_skip_dependencies(self):
        def failing_walk(root, *, followlinks, onerror):
            onerror(PermissionError("unreadable dependency directory"))
            return iter(())
        artifacts = {"required_artifact_hashes": {}}
        with patch.object(closure.os, "walk", side_effect=failing_walk):
            with self.assertRaisesRegex(ValueError, "fully enumerated"):
                closure.bind_signed_state_closure(self.case, artifacts)
        self.assertEqual(artifacts, {"required_artifact_hashes": {}})


if __name__ == "__main__":
    unittest.main()
