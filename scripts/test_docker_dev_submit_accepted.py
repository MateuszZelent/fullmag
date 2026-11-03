"""Interpreted regressions for one-shot accepted DEV submission."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import docker_dev_submit_accepted as target


class SubmitAcceptedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "backend").mkdir()
        (self.root / "backend/runtime-provenance.json").write_text(json.dumps({"source_snapshot_sha256": "a" * 64}))
        self.relative = "verification/input/request.json"
        self.path = self.root / self.relative
        self.path.parent.mkdir(parents=True)
        self.raw = json.dumps({"run_intent": {"specification": {
            "run_id": "run-test", "snapshot": {"project_id": "project-test"}}}}).encode()
        self.path.write_bytes(self.raw)
        self.digest = hashlib.sha256(self.raw).hexdigest()

    def submit(self, digest=None, snapshot=None):
        return target.submit_once(self.root, self.relative, digest or self.digest, snapshot or "a" * 64)

    def test_submit_uses_frozen_bytes_and_public_cli_once(self):
        def invoke(command, **kwargs):
            self.assertEqual(Path(command[2]).read_bytes(), self.raw)
            self.assertEqual(command[1], "run-json")
            self.assertEqual(command[-1], "--submit-only")
            return subprocess.CompletedProcess(command, 0)
        with patch.object(target.subprocess, "run", side_effect=invoke) as run:
            receipt = self.submit()
            self.assertEqual(receipt["cli_exit_code"], 0)
            with self.assertRaises(FileExistsError):
                self.submit()
            self.assertEqual(run.call_count, 1)

    def test_cli_timeout_is_recorded_without_retry(self):
        with patch.object(target.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)) as run:
            self.assertEqual(self.submit()["cli_exit_code"], 1)
            with self.assertRaises(FileExistsError):
                self.submit()
            self.assertEqual(run.call_count, 1)

    def test_interrupted_client_leaves_fence_and_never_replays(self):
        with patch.object(target.subprocess, "run", side_effect=OSError("client disconnected")) as run:
            with self.assertRaises(OSError):
                self.submit()
            with self.assertRaises(FileExistsError):
                self.submit()
            self.assertEqual(run.call_count, 1)

    def test_changed_payload_for_same_run_cannot_replay(self):
        with patch.object(target.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.submit()
            self.path.write_bytes(self.raw + b" ")
            with self.assertRaises(FileExistsError):
                self.submit(hashlib.sha256(self.path.read_bytes()).hexdigest())
            self.assertEqual(run.call_count, 1)

    def test_bad_digest_or_snapshot_never_submits(self):
        with patch.object(target.subprocess, "run") as run:
            for digest, snapshot in [("b" * 64, None), (None, "b" * 64), ("bad", None)]:
                with self.subTest(digest=digest, snapshot=snapshot), self.assertRaises(ValueError):
                    self.submit(digest, snapshot)
            run.assert_not_called()

    def test_oversized_request_never_submits(self):
        with patch.object(target, "MAX_REQUEST_BYTES", 1), patch.object(target.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                self.submit()
            run.assert_not_called()

    def test_symbolic_request_or_parent_is_rejected(self):
        destination = self.root / "payload.json"
        self.path.rename(destination)
        self.path.symlink_to(destination)
        with self.assertRaises(ValueError):
            self.submit()

    def test_hard_link_is_rejected(self):
        import os
        os.link(self.path, self.root / "alias.json")
        with self.assertRaises(ValueError):
            self.submit()

    def test_noncanonical_or_escaping_paths_are_rejected(self):
        for value in ["/verification/r.json", "verification/../r.json", "verification//r.json", "verification/./r.json", "backend/r.json", "verification\\r.json", ""]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                target.validate_relative(value)


    def accepted_response(self, **changes):
        import io
        body = {"run_id": "run-test", "project_id": "project-test", "payload_fingerprint": "e" * 64,
                "catalog_state": "pending_materialization", **changes}
        response = io.BytesIO(json.dumps(body).encode())
        response.status = 200
        return response

    def materialize(self):
        return target.materialize_once(self.root, self.relative, self.digest, "a" * 64, "e" * 64)

    def test_materialization_sends_only_one_separate_post(self):
        responses = [self.accepted_response(), self.accepted_response(task_ids=["task-test"]), self.accepted_response()]
        with patch.object(target.urllib.request, "urlopen", side_effect=responses) as request:
            self.assertEqual(self.materialize()["http_status"], 200)
            self.assertEqual(request.call_args_list[1].args[0].method, "POST")
            self.assertTrue(request.call_args_list[1].args[0].full_url.endswith('/materialization'))
            with self.assertRaises(FileExistsError):
                self.materialize()
            self.assertEqual(request.call_count, 3)  # GET, POST, reconciliation GET; no second POST.

    def test_materialization_identity_mismatch_never_posts(self):
        for changes in [{"run_id": "other"}, {"project_id": "other"}, {"payload_fingerprint": "f" * 64}, {"catalog_state": "materialized"}]:
            with self.subTest(changes=changes), patch.object(target.urllib.request, "urlopen", return_value=self.accepted_response(**changes)) as request:
                with self.assertRaises(ValueError):
                    self.materialize()
                self.assertEqual(request.call_count, 1)

    def test_materialization_timeout_keeps_fence(self):
        with patch.object(target.urllib.request, "urlopen", side_effect=[self.accepted_response(), TimeoutError("lost response"), self.accepted_response()]) as request:
            with self.assertRaises(TimeoutError):
                self.materialize()
            with self.assertRaises(FileExistsError):
                self.materialize()
            self.assertEqual(request.call_count, 3)


class StorageShellRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fake = Path(self.temp.name) / "python3"
        self.fake.write_text("#!/usr/bin/python3\nimport json,sys\nif sys.argv[1:2] != ['-c']: print(json.dumps(sys.argv[1:]))\n")
        self.fake.chmod(0o755)
        self.repo = Path(__file__).resolve().parents[1]
        self.body = (f'python3 "{self.repo}/scripts/docker_dev_submit_accepted.py" '
                     f'--repo-root "{self.repo}" --source-root \'{self.repo}\' '
                     + "--attempt '" + "a" * 32 + "' --config-sha256 '" + "b" * 64
                     + "' --source-snapshot-sha256 '" + "c" * 64
                     + "' --request-relative 'verification/r/request.json' --request-sha256 '" + "d" * 64 + "'")

    def invoke(self, body):
        import os
        return subprocess.run(['bash', str(self.repo / 'scripts/just_storage_shell.sh'), body],
                              env=dict(os.environ, FULLMAG_STORAGE_PYTHON=str(self.fake)),
                              capture_output=True, text=True)

    def test_exact_route_preserves_all_pins(self):
        result = self.invoke(self.body)
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = json.loads(result.stdout)
        self.assertEqual(argv[0], '-B')
        self.assertEqual(argv[-1], 'd' * 64)
        self.assertEqual(argv[argv.index('--source-snapshot-sha256') + 1], 'c' * 64)

    def test_materialization_route_preserves_fingerprint(self):
        result = self.invoke(self.body + " --operation 'materialize' --payload-fingerprint '" + "e" * 64 + "'")
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = json.loads(result.stdout)
        self.assertEqual(argv[-4:], ['--operation', 'materialize', '--payload-fingerprint', 'e' * 64])

    def test_materialization_requires_both_arguments(self):
        result = self.invoke(self.body + " --operation 'materialize'")
        self.assertEqual(result.returncode, 2)

    def test_trailing_command_is_rejected(self):
        result = self.invoke(self.body + '; echo UNEXPECTED')
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('UNEXPECTED', result.stdout)

    def test_malformed_hash_is_rejected(self):
        result = self.invoke(self.body.replace("'" + 'c' * 64 + "'", "'invalid'"))
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
