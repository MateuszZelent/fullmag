"""Private Docker same-run API input: volume bounds, build pins and EOF."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "accepted_reattach_runtime", Path(__file__).resolve().parents[1] / "docker/all-in-one/runtime_service.py")
runtime = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runtime
SPEC.loader.exec_module(runtime)


class AcceptedReattachTransportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.paths = runtime.RuntimePaths(state_root=self.root, runtime_services=self.root / "runtime-services")
        self.proof = self.root / "proof.json"
        self.backing = {}
        for prefix, filename, current in (
                ("terminal_owner_record", "terminal-owner.json", self.paths.runtime_services / "OWNER.json"),
                ("terminal_process_record", "terminal-process.json", runtime.process_receipt_path(self.paths))):
            raw = json.dumps({"schema": "test-terminal", "state": "failed", "kind": prefix}).encode()
            current.parent.mkdir(parents=True, exist_ok=True)
            current.write_bytes(raw)
            (self.root / filename).write_bytes(raw)
            self.backing[prefix + "_path"] = filename
            self.backing[prefix + "_sha256"] = hashlib.sha256(raw).hexdigest()
        self.proof.write_text(json.dumps({
            "schema": "fullmag.development-accepted-run-reattach-proof.v1", **self.backing}))
        self.request = {
            "schema": runtime.ACCEPTED_REATTACH_REQUEST_SCHEMA,
            "run_id": "run-existing", "project_id": "project-existing",
            "source_request_id": "original-request", "source_sha256": "a" * 64,
            "startup_provenance_sha256": "b" * 64, "config_sha256": "c" * 64,
            "proof_path": "proof.json", "proof_sha256": hashlib.sha256(self.proof.read_bytes()).hexdigest(),
        }
        self.provenance = self.root / "provenance.json"
        self.provenance.write_text(json.dumps({"schema": "fullmag.docker-all-image.v1",
            "state": "succeeded", "commit": "d" * 40, "source_snapshot_sha256": "e" * 64}))
        self.environment = {"FULLMAG_RUNTIME_PROVENANCE": str(self.provenance)}
        self.addCleanup(patch.stopall)
        patch.object(runtime, "process_environment", side_effect=lambda paths: dict(self.environment)).start()
        patch.object(runtime, "ACCEPTED_REATTACH_PROVENANCE", self.provenance).start()
        self.save_request()

    def input(self):
        return runtime.accepted_reattach_api_input(
            self.paths, preflight=runtime.accepted_reattach_preflight(self.paths))

    def test_early_preflight_rejects_changed_owner_process_or_archive(self):
        paths = [self.paths.runtime_services / "OWNER.json",
                 runtime.process_receipt_path(self.paths), self.root / "terminal-owner.json",
                 self.root / "terminal-process.json"]
        for path in paths:
            original = path.read_bytes()
            try:
                path.write_bytes(b"changed")
                with self.subTest(path=path.name), self.assertRaises(runtime.RuntimeServiceError):
                    runtime.accepted_reattach_preflight(self.paths)
            finally:
                path.write_bytes(original)

    def test_legitimate_rotation_after_preflight_preserves_private_handoff(self):
        token = runtime.accepted_reattach_preflight(self.paths)
        (self.paths.runtime_services / "OWNER.json").write_bytes(b"new recovered owner")
        runtime.process_receipt_path(self.paths).write_bytes(b"new starting process")
        with runtime.accepted_reattach_api_input(self.paths, preflight=token) as (_, stream):
            self.assertEqual(json.load(stream)["run_id"], self.request["run_id"])
        with self.assertRaises(runtime.RuntimeServiceError):
            runtime.accepted_reattach_preflight(self.paths)

    def test_missing_or_mismatched_preflight_cannot_launch_api(self):
        for token in [None, {}, {"request_sha256": "f" * 64, "proof_sha256": self.request["proof_sha256"]}]:
            with self.subTest(token=token), self.assertRaises(runtime.RuntimeServiceError):
                with runtime.accepted_reattach_api_input(self.paths, preflight=token):
                    self.fail("unverified early terminal records reached API")
        token = runtime.accepted_reattach_preflight(self.paths)
        self.request["source_request_id"] = "changed-request"
        self.save_request()
        with self.assertRaises(runtime.RuntimeServiceError):
            with runtime.accepted_reattach_api_input(self.paths, preflight=token):
                self.fail("old preflight accepted a different request")

    def save_request(self):
        raw = json.dumps(self.request).encode()
        (self.root / "request.json").write_bytes(raw)
        self.environment[runtime.ACCEPTED_REATTACH_REQUEST_ENV] = "request.json"
        self.environment[runtime.ACCEPTED_REATTACH_DIGEST_ENV] = hashlib.sha256(raw).hexdigest()

    def test_child_reads_pinned_input_and_eof_without_a_pipe_writer(self):
        before = set(self.root.iterdir())
        with self.input() as (environment, stream):
            self.assertEqual(environment[runtime.ACCEPTED_REATTACH_STDIN_ENV], "1")
            result = subprocess.run([sys.executable, "-B", "-c",
                "import json,sys; print(json.dumps(json.load(sys.stdin)))"],
                stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=True)
            value = json.loads(result.stdout)
            self.assertEqual(value["target_build_id"], "d" * 40)
            self.assertEqual(value["target_source_sha256"], "e" * 64)
            self.assertEqual(value["run_id"], "run-existing")
            self.assertEqual(value["schema"], runtime.ACCEPTED_REATTACH_INPUT_SCHEMA)
        self.assertTrue(stream.closed)
        self.assertEqual(set(self.root.iterdir()), before)
        self.assertNotIn(runtime.ACCEPTED_REATTACH_STDIN_ENV, self.environment)

    def test_unconfigured_start_has_no_restore_input(self):
        self.environment = {}
        with self.input() as (environment, stream):
            self.assertEqual(environment, {})
            self.assertIsNone(stream)

    def test_partial_configuration_and_conflicting_startup_fail_closed(self):
        original = dict(self.environment)
        variants = [{runtime.ACCEPTED_REATTACH_REQUEST_ENV: "request.json"},
                    {runtime.ACCEPTED_REATTACH_DIGEST_ENV: "f" * 64},
                    {runtime.ACCEPTED_REATTACH_STDIN_ENV: "1"},
                    dict(original, FULLMAG_STARTUP_ENABLED="1"),
                    dict(original, FULLMAG_DEVELOPMENT_RESTORE_STDIN="1")]
        for environment in variants:
            self.environment = environment
            with self.subTest(environment=environment), self.assertRaises(runtime.RuntimeServiceError):
                with self.input():
                    self.fail("invalid restore reached API launch")

    def test_changed_request_or_proof_cannot_reach_api(self):
        (self.root / "request.json").write_bytes(b"{}")
        with self.assertRaises(runtime.RuntimeServiceError):
            with self.input():
                self.fail("changed request accepted")
        self.save_request()
        self.proof.write_bytes(b"changed")
        with self.assertRaises(runtime.RuntimeServiceError):
            with self.input():
                self.fail("changed proof accepted")

    def test_unpublished_or_invalid_build_cannot_supply_target_identity(self):
        valid = json.loads(self.provenance.read_text())
        for field, value in (("state", "building"), ("schema", "foreign"),
                             ("commit", "short"), ("source_snapshot_sha256", None)):
            self.provenance.write_text(json.dumps(dict(valid, **{field: value})))
            with self.subTest(field=field), self.assertRaises(runtime.RuntimeServiceError):
                with self.input():
                    self.fail("invalid build reached API launch")
        self.provenance.write_text(json.dumps(valid))
        self.environment["FULLMAG_RUNTIME_PROVENANCE"] = "/tmp/foreign.json"
        with self.assertRaises(runtime.RuntimeServiceError):
            with self.input():
                self.fail("foreign build path accepted")

    def test_proof_traversal_symlink_or_extra_target_fields_fail_closed(self):
        for relative in ("../proof.json", "/tmp/proof.json", "a/../proof.json", "C:/proof.json"):
            self.request["proof_path"] = relative
            self.save_request()
            with self.subTest(path=relative), self.assertRaises(runtime.RuntimeServiceError):
                with self.input():
                    self.fail("invalid proof path accepted")
        self.request["proof_path"] = "proof.json"
        self.request["target_build_id"] = "foreign"
        self.save_request()
        with self.assertRaises(runtime.RuntimeServiceError):
            with self.input():
                self.fail("caller supplied target identity accepted")
        self.request.pop("target_build_id")
        self.proof.unlink()
        self.proof.symlink_to(self.provenance)
        self.request["proof_sha256"] = hashlib.sha256(self.provenance.read_bytes()).hexdigest()
        self.save_request()
        with self.assertRaises((runtime.RuntimeServiceError, OSError)):
            with self.input():
                self.fail("symlink proof accepted")


if __name__ == "__main__":
    unittest.main()
