"""Archive inventory and closed recovery dispatch regression coverage."""
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_volume_resume_protected as module
from docker_build_control import BuildControlError, canonical
import test_docker_volume_abandoned_diagnostic_integration as integration

class ProtectedArchiveTests(unittest.TestCase):
    def context(self):
        pin = {"state_root": "/old-state", "source_root": "/source", "expected_inventory": module.EXPECTED}
        control = mock.Mock(volume="private-volume", image="helper-image")
        control.helper_args.return_value = ["docker", "run", "--mount", "type=volume,src=private-volume,dst=/control,volume-nocopy", "--entrypoint", "bash", "helper-image", "-c", "script"]
        return pin, control

    def test_full_hash_uses_readonly_archive_views_and_frozen_historical_image(self):
        pin, control = self.context()
        result = SimpleNamespace(returncode=0, stderr=b"", stdout=canonical(module.EXPECTED))
        with mock.patch.object(module, "_archive_context", return_value=(pin, {}, [])), mock.patch.object(module, "bounded_capture", return_value=result) as capture:
            self.assertEqual(module.read_archived_protected(control, {"protected_store": pin}), module.EXPECTED)
        args = capture.call_args.args[0]
        mounts = [args[i+1] for i, word in enumerate(args) if word == "--mount"]
        self.assertEqual(len(mounts), 7)
        self.assertTrue(all("readonly" in value.split(",") for value in mounts))
        self.assertIn(module.HISTORICAL_IMAGE, args)
        self.assertNotIn(control.image, args)
        self.assertTrue(any("dst=/host-ledger/ledger" in value and "runtime-archives/" in value for value in mounts))
        self.assertEqual(capture.call_args.kwargs["timeout"], 300)

    def test_changed_request_refuses_before_helper_execution(self):
        pin, control = self.context()
        with mock.patch.object(module, "_archive_context", return_value=(pin, {}, [])), mock.patch.object(module, "bounded_capture") as capture:
            with self.assertRaises(BuildControlError):
                module.read_archived_protected(control, {"protected_store": {}})
        capture.assert_not_called()

    def test_missing_or_changed_science_never_passes(self):
        pin, control = self.context()
        cases = [SimpleNamespace(returncode=1, stderr=b"unreadable", stdout=b""), SimpleNamespace(returncode=0, stderr=b"", stdout=canonical({**module.EXPECTED, "files": 0}))]
        for result in cases:
            with self.subTest(result=result), mock.patch.object(module, "_archive_context", return_value=(pin, {}, [])), mock.patch.object(module, "bounded_capture", return_value=result):
                with self.assertRaises(BuildControlError):
                    module.read_archived_protected(control, {"protected_store": pin})

    def test_evidence_cas_and_path_escape_refuse(self):
        control = mock.Mock(); control.read_bytes.return_value = b"{}"
        with self.assertRaises(BuildControlError): module._pin(control, "evidence.json", "0" * 64)
        for path in ("../other", "/outside/evidence", "a/../b", "a//b"):
            with self.subTest(path=path), self.assertRaises(BuildControlError): module._relative(path)

class ResumePreflightDispatchTests(unittest.TestCase):
    def test_closed_recipe_round_trip_and_injection_rejection(self):
        harness = integration.AbandonedDiagnosticShellTests()
        marker = '  *"scripts/docker_volume_resume_preflight_recovery.py"*)\n'
        source = "/selected/worktree with spaces/$(printf injected);literal"
        for apply in (False, True):
            recipe = harness.dry_recipe("docker-dev-reconcile-resume-preflight", "verification/recovery/request.json", "a" * 64, source, "true" if apply else "false")
            result = harness.dispatch(recipe, marker)
            self.assertEqual(result.returncode, 0, result.stderr)
            words = result.stdout.split(b"\0")[:-1]
            self.assertEqual(words[3:], [b"--request", b"verification/recovery/request.json", b"--request-sha256", b"a" * 64, b"--source-root", source.encode()] + ([b"--apply"] if apply else []))
            for invalid in (recipe + "; printf injected", recipe + "\nprintf injected", recipe + " --apply --apply", recipe.replace("a" * 64, "short")):
                rejected = harness.dispatch(invalid, marker)
                self.assertEqual(rejected.returncode, 2)
                self.assertFalse(rejected.stdout)

if __name__ == "__main__": unittest.main()
