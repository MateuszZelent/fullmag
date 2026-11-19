"""Failure-only resume qualification and real terminal-last CAS regression checks."""
import copy
import fcntl
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_volume_reconcile as recovery
import docker_volume_resume_layout_refusal as refusal
from docker_build_control import BuildControlError, canonical


class LayoutRefusalTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(__file__).resolve().parent.parent
        self.control = SimpleNamespace(project="fullmag-test", volume="control-test",
            path=lambda name: "/control/" + name)
        self.token, self.base = "a"*32, "b"*32
        self.root = "resume/attempts/" + self.token
        self.actual = {}
        for name, char in (("backend", "c"), ("frontend", "d"), ("lease", "e")):
            self.actual[name] = {"Id": char*64, "Image": "sha256:" + "f"*64,
                "Config": {}, "HostConfig": {}, "Mounts": [],
                "State": {"Status": "exited", "Running": False, "Pid": 0, "ExitCode": 255,
                    "OOMKilled": False, "Dead": False, "Restarting": False, "Paused": False,
                    "Error": "", "StartedAt": "2026-11-06T18:00:00Z", "FinishedAt": "2026-11-06T20:00:00Z"}}
        self.original = {"schema": "fullmag.docker-build-operation.v1", "phase": "resume",
            "state": "outcome-unknown-resources-retained", "attempt": self.token,
            "compose_project": self.control.project, "control_volume": self.control.volume,
            "error": refusal.ERROR, "started_at": 1794000000,
            "inputs": {"attempt": self.base}, "helper_container": "fullmag-control-" + self.token}
        for name in ("backend", "frontend"):
            self.original[name + "_container"] = self.actual[name]["Id"]
            self.original[name + "_started_at"] = self.actual[name]["State"]["StartedAt"]
        self.previous = {"state": "succeeded", "private_group_storage": "group-volume-v1"}
        self.owner = {"schema": "fullmag.docker-group-storage-owner.v1", "compose_project": self.control.project}
        self.files = {"development/attempts/" + self.base + "/terminal.json": canonical(self.previous),
            "development/attempts/" + self.base + "/compose.json": b"{}",
            "private/.owner.json": canonical(self.owner), "frontend/development-inputs.json": b"{}",
            self.root + "/receipt.json": canonical(self.original)}
        proof = {"previous_receipt_sha256": refusal.digest(canonical(self.previous)),
            "compose_sha256": refusal.digest(b"{}"), "private_owner_sha256": refusal.digest(canonical(self.owner)),
            "frontend_inputs_sha256": refusal.digest(b"{}"), "helper_log_sha256": refusal.digest(b"READY\nLOGGED\n"),
            "engine_id": "engine", "current_sha256": None, "verified_sha256": None,
            "service_states": {name: refusal.digest(canonical(self.actual[name]["State"])) for name in ("backend", "frontend")},
            "controllers": {name: refusal.digest((self.source / "scripts" / name).read_bytes()) for name in refusal.CONTROLLERS}}
        self.request = {"schema": refusal.SCHEMA, "attempt": self.token, "compose_project": self.control.project,
            "source_root": str(self.source), "port": 3274, "config_sha256": "1"*64,
            "unknown_receipt_sha256": refusal.digest(canonical(self.original)), "controller_sha256": "2"*64,
            "failure": proof, "containers": {name: {"id": value["Id"], "image": value["Image"],
                "started_at": value["State"]["StartedAt"], "fingerprint": recovery.fingerprint(value)}
                for name, value in self.actual.items()}}

    def read(self, control, path, optional=False):
        if optional:
            return self.files.get(path)
        return self.files[path]

    def qualify(self, *, helper_log="READY\nLOGGED\n", helper_id=None):
        with patch.object(refusal, "read_raw", side_effect=self.read), \
             patch.object(refusal, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
             patch("docker_group_storage.owner_manifest", return_value=self.owner), \
             patch("docker_volume_activation_reconcile._validate_helper", return_value=(self.actual["lease"], helper_id or self.actual["lease"]["Id"])), \
             patch("docker_volume_activation_reconcile._validate_helper_logged", return_value=helper_log):
            return refusal.validate_failure(self.control, self.root, self.request, self.original, self.actual, Path("/state"))

    def test_exact_refusal_qualifies_without_starting_services(self):
        recovery.validate_request(self.request)
        self.assertEqual(self.qualify(), self.request["failure"])

    def test_wrong_error_layout_obligation_or_service_lifecycle_refuses(self):
        mutations = (
            lambda: self.original.update(error="another failure"),
            lambda: self.original.update(private_group_storage="group-volume-v1"),
            lambda: self.previous.update(private_group_storage=None),
            lambda: self.original.update(worker_cgroup={}),
            lambda: self.original.update(prestart_reconciliation="a"*32),
            lambda: self.original.update(saved_authoring_restore_required="archive"),
            lambda: self.actual["backend"]["State"].update(StartedAt="2026-11-06T19:00:00Z"),
            lambda: self.actual["frontend"]["State"].update(Running=True),
            lambda: self.actual["backend"]["State"].update(OOMKilled=True),
            lambda: self.actual["frontend"]["State"].update(FinishedAt="2026-11-07T20:00:00Z"),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.setUp(); mutate()
                with self.assertRaises(BuildControlError):
                    refusal.validate_original(self.original, self.previous, self.actual)

    def test_refuses_proof_drift_and_allocation_evidence(self):
        for path in ("private/.owner.json", "frontend/development-inputs.json", "resume/current.json",
                     "resume/verified.json", *(self.root + "/" + name for name in refusal.ABSENT_FILES)):
            with self.subTest(path=path):
                self.setUp(); self.files[path] = b'{"changed":true}'
                with self.assertRaises(BuildControlError): self.qualify()
        with self.assertRaises(BuildControlError): self.qualify(helper_log="READY\n")
        with self.assertRaises(BuildControlError): self.qualify(helper_id="9"*64)

    def test_same_schema_wrong_owner_refuses_even_with_matching_digest(self):
        wrong = {**self.owner, "compose_project": "foreign"}
        self.files["private/.owner.json"] = canonical(wrong)
        self.request["failure"]["private_owner_sha256"] = refusal.digest(canonical(wrong))
        with self.assertRaisesRegex(BuildControlError, "owner"):
            self.qualify()

    def test_closed_shape_and_failure_only_phase(self):
        for key, value in (("schema", recovery.SCHEMA), ("port", True), ("failure", {}), ("containers", {})):
            with self.subTest(key=key):
                request = copy.deepcopy(self.request); request[key] = value
                with self.assertRaises(BuildControlError): refusal.validate_shape(request)
        with self.assertRaises(BuildControlError):
            recovery.commit_script(self.control, self.root, self.request, "journal", "3"*64, "4"*64,
                phase="resume", publish_verified=True)

    def test_real_cas_preserves_verified_and_active_for_fresh_and_partial_commit(self):
        for partial in (False, True):
            with self.subTest(partial=partial), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); attempt = root / self.root; attempt.mkdir(parents=True)
                journal = attempt / "reconciliation" / ("3"*64); journal.mkdir(parents=True)
                original, result, verified = b"unknown", b"exact prepared result", b"old verified"
                self.request["unknown_receipt_sha256"] = refusal.digest(original)
                self.request["failure"].update(current_sha256=None, verified_sha256=refusal.digest(verified))
                (attempt / "unknown-receipt.json").write_bytes(original)
                current = result if partial else original
                (attempt / "receipt.json").write_bytes(current)
                (root / "resume/verified.json").write_bytes(verified)
                if partial: (root / "resume/current.json").write_bytes(result)
                (root / "active").write_text(self.token + "\n")
                (journal / "result.json").write_bytes(result)
                script = recovery.commit_script(self.control, self.root, self.request,
                    self.root + "/reconciliation/" + "3"*64, refusal.digest(result), refusal.digest(current),
                    phase="resume", publish_verified=False).replace("/control", str(root))
                with (root / "operation.lock").open("w") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    run = subprocess.run(["bash", "-euo", "pipefail", "-c", script], capture_output=True, timeout=5)
                self.assertEqual(run.returncode, 0, run.stderr.decode())
                for path in (attempt / "receipt.json", attempt / "terminal.json", root / "resume/current.json"):
                    self.assertEqual(path.read_bytes(), result)
                self.assertEqual((root / "resume/verified.json").read_bytes(), verified)
                self.assertEqual((root / "active").read_text(), self.token + "\n")

    def test_completed_retry_requires_exact_prepared_chain(self):
        result = {**self.original, "state": "failed-confirmed", "layout_refusal_proof": self.request["failure"],
            "reconciliation": {"request_sha256": "3"*64,
                "unknown_receipt_sha256": self.request["unknown_receipt_sha256"]}}
        raw = canonical(result); sha = refusal.digest(raw)
        self.files.update({self.root + "/unknown-receipt.json": canonical(self.original),
            self.root + "/terminal.json": raw, self.root + "/receipt.json": raw, "resume/current.json": raw,
            self.root + "/reconciliation/" + sha + "/result.json": raw,
            self.root + "/reconciliation/" + sha + "/prepared.json": canonical({"request_sha256": "3"*64,
                "unknown_receipt_sha256": self.request["unknown_receipt_sha256"], "result_sha256": sha})})
        with patch.object(refusal, "read_raw", side_effect=self.read), patch.object(refusal, "wait_release") as release:
            self.assertTrue(refusal.completed(self.control, self.root, self.request, "3"*64))
            release.assert_called_once()
            self.files[self.root + "/reconciliation/" + sha + "/result.json"] = b"changed"
            with self.assertRaises(BuildControlError): refusal.completed(self.control, self.root, self.request, "3"*64)

    def test_release_handles_helper_removal_between_two_inspections(self):
        with patch.object(refusal, "read_raw", return_value=None), \
             patch("docker_volume_activation_reconcile._probe_helper_absence", side_effect=[None, "absence", "absence"]), \
             patch.object(refusal, "docker_capture", return_value=SimpleNamespace(returncode=1)), \
             patch.object(refusal.time, "sleep"):
            refusal.wait_release(self.control, self.request)

    def test_release_rejects_different_name_occupant(self):
        with patch.object(refusal, "read_raw", return_value=None), \
             patch("docker_volume_activation_reconcile._probe_helper_absence", return_value=None), \
             patch.object(refusal, "docker_capture", return_value=SimpleNamespace(returncode=0, stdout=canonical([{"Id": "8"*64}]))):
            with self.assertRaises(BuildControlError): refusal.wait_release(self.control, self.request)


if __name__ == "__main__":
    unittest.main()
