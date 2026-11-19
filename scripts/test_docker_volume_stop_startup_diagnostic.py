"""Fail-closed request and terminal-observation gates for diagnostic startup stop."""
from contextlib import ExitStack, contextmanager
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock, patch
import sys
import subprocess
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_stop_startup_diagnostic as stop


def request():
    return {"schema": stop.REQUEST_SCHEMA, "request_id": "eb2a01dc-82d3-42b4-a31b-3cd68a2bd9cb",
            "source_root": "/checkout", "compose_project": "fullmag-worktree-test",
            "development_attempt": "a" * 32, "compose_config_sha256": "c" * 64,
            "resume_attempt": "d" * 32, "resume_terminal_sha256": "e" * 64,
            "backend_container_id": "b" * 64, "backend_image_id": "sha256:" + "1" * 64,
            "backend_started_at": "2026-10-26T04:26:40.818325783Z",
            "frontend_container_id": "f" * 64, "frontend_image_id": "sha256:" + "2" * 64,
            "frontend_started_at": "2026-10-26T03:00:00.123456789Z",
            "inspection_relative": "verification/startup/inspection.json", "inspection_sha256": "3" * 64,
            "historical_process_receipt_sha256": "4" * 64, "reason": "Stop this own empty diagnostic namespace."}


def terminal(req):
    return {"schema": "fullmag.docker-build-operation.v1", "phase": "resume", "state": "failed-confirmed",
            "attempt": req["resume_attempt"], "compose_project": req["compose_project"], "control_volume": "volume",
            "inputs": {"attempt": req["development_attempt"], "config_sha256": req["compose_config_sha256"]},
            "config_sha256": req["compose_config_sha256"], "backend_started_at": req["backend_started_at"],
            "worker_cgroup": {"schema": "fullmag.worker-cgroup-ready.v1", "state": "ready",
                              "container_id": req["backend_container_id"], "image_id": req["backend_image_id"],
                              "compose_project": req["compose_project"]}}


class StopRequestTests(unittest.TestCase):
    def test_complete_request_is_accepted(self):
        self.assertEqual(stop.validate_request(request()), request())

    def test_missing_or_unknown_fields_are_rejected(self):
        for field in stop.FIELDS:
            req = request(); req.pop(field)
            with self.subTest(missing=field), self.assertRaises(stop.BuildControlError):
                stop.validate_request(req)
        with self.assertRaises(stop.BuildControlError):
            stop.validate_request(dict(request(), force=True))

    def test_incomplete_pins_are_rejected(self):
        for field in ("development_attempt", "resume_attempt", "backend_container_id", "frontend_container_id",
                      "compose_config_sha256", "resume_terminal_sha256", "inspection_sha256",
                      "historical_process_receipt_sha256", "backend_image_id", "frontend_image_id"):
            req = request(); req[field] = req[field][:10]
            with self.subTest(field=field), self.assertRaises(stop.BuildControlError):
                stop.validate_request(req)

    def test_unsafe_paths_and_reasons_are_rejected(self):
        for path in ("/tmp/request.json", "verification/../active.json", "verification//x.json", "active"):
            req = request(); req["inspection_relative"] = path
            with self.subTest(path=path), self.assertRaises(stop.BuildControlError):
                stop.validate_request(req)
        for reason in ("", " ", "bad\nreason", "x" * 4097):
            req = request(); req["reason"] = reason
            with self.subTest(reason=reason[:10]), self.assertRaises(stop.BuildControlError):
                stop.validate_request(req)

    def test_noncanonical_or_nil_uuid_is_rejected(self):
        for value in ("00000000-0000-0000-0000-000000000000", request()["request_id"].upper(), "broken"):
            req = request(); req["request_id"] = value
            with self.subTest(value=value), self.assertRaises(stop.BuildControlError):
                stop.validate_request(req)


class ResumeTerminalTests(unittest.TestCase):
    def test_exact_failed_terminal_is_accepted(self):
        req = request(); stop.validate_resume(terminal(req), req, req["compose_project"], "volume")

    def test_running_unknown_or_successful_observation_is_rejected(self):
        req = request()
        for state in ("resuming-observation", "starting", "outcome-unknown-resources-retained", "succeeded"):
            value = terminal(req); value["state"] = state
            with self.subTest(state=state), self.assertRaises(stop.BuildControlError):
                stop.validate_resume(value, req, req["compose_project"], "volume")

    def test_wrong_terminal_incarnation_and_scope_are_rejected(self):
        req = request()
        for field, changed in (("phase", "iteration"), ("attempt", "0" * 32), ("compose_project", "foreign"),
                               ("control_volume", "foreign"), ("backend_started_at", "other"),
                               ("config_sha256", "0" * 64)):
            value = terminal(req); value[field] = changed
            with self.subTest(field=field), self.assertRaises(stop.BuildControlError):
                stop.validate_resume(value, req, req["compose_project"], "volume")

    def test_wrong_cgroup_admission_is_rejected(self):
        req = request()
        for field in ("schema", "state", "container_id", "image_id", "compose_project"):
            value = terminal(req); value["worker_cgroup"][field] = "foreign"
            with self.subTest(field=field), self.assertRaises(stop.BuildControlError):
                stop.validate_resume(value, req, req["compose_project"], "volume")


class StopShellTests(unittest.TestCase):
    def test_shell_composition_cannot_reach_apply(self):
        root = Path(__file__).resolve().parent.parent
        body = (f'python3 "{root}/scripts/docker_volume_stop_startup_diagnostic.py" '
                "--source-root '/checkout' --image-id 'sha256:" + "b" * 64
                + "' --request 'verification/request.json' --request-sha256 '" + "c" * 64
                + "' --apply; echo SHOULD_NOT_EXECUTE")
        result = subprocess.run(["bash", str(root / "scripts/just_storage_shell.sh"), body],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("SHOULD_NOT_EXECUTE", result.stdout)
        self.assertIn("invalid startup diagnostic stop recipe", result.stderr)


class StopEntryPointTests(unittest.TestCase):
    def test_active_observer_never_acquires_stop_lease_or_sends_signal(self):
        req = request(); value = terminal(req); value["state"] = "resuming-observation"
        control = Mock(project=req["compose_project"], volume="volume")
        argv = ["stop", "--source-root", "/checkout", "--image-id", req["backend_image_id"],
                "--request", "verification/stop/request.json", "--request-sha256", "9" * 64, "--apply"]
        with patch.object(sys, "argv", argv), patch("docker_dev._select_source", return_value=(Path("/checkout"), {})), \
                patch("docker_dev._compose_identity", return_value={}), patch.object(stop, "BuildControl", return_value=control), \
                patch.object(stop, "pinned_json", side_effect=[(stop.canonical(req) + b"\n", req), (b"resume", value)]), \
                patch.object(stop, "docker_capture") as daemon, patch.object(stop, "verify") as verify:
            with self.assertRaisesRegex(stop.BuildControlError, "terminal failed-confirmed"):
                stop.main()
        control.operation.assert_not_called(); daemon.assert_not_called(); verify.assert_not_called()

    def test_changed_preserved_receipt_is_rejected(self):
        control = Mock(); control.read_bytes.return_value = b"modified"
        evidence = {field: "0" * 64 for field in ("owner_sha256", "runtime_config_sha256", "historical_process_receipt_sha256")}
        with self.assertRaisesRegex(stop.BuildControlError, "Preserved runtime evidence changed"):
            stop.unchanged_control_evidence(control, evidence)
        control.write.assert_not_called()


class PinnedJsonTests(unittest.TestCase):
    def test_duplicate_control_fields_are_rejected(self):
        control = Mock(); control.read_bytes.return_value = b'{"state":"ready","state":"failed"}'
        with self.assertRaisesRegex(stop.BuildControlError, "Duplicate control field"):
            stop.pinned_json(control, "verification/example.json")

    def test_non_object_and_invalid_json_are_rejected(self):
        for raw in (b'[]', b'null', b'broken', b'\xff'):
            control = Mock(); control.read_bytes.return_value = raw
            with self.subTest(raw=raw), self.assertRaises(stop.BuildControlError):
                stop.pinned_json(control, "verification/example.json")

    def test_digest_is_checked_before_parsing(self):
        control = Mock(); control.read_bytes.return_value = b'broken'
        with self.assertRaisesRegex(stop.BuildControlError, "digest changed"):
            stop.pinned_json(control, "verification/example.json", "0" * 64)


class StopWorkflowTests(unittest.TestCase):
    def invoke(self, *, apply=False, preview_valid=True, evidence_changed=False, stop_confirmed=True):
        req = request(); source = Path(req["source_root"])
        inputs = {"request_sha256": "9" * 64, "source_root": str(source),
                  "controller_sha256": stop.sha(Path(stop.__file__).read_bytes()),
                  "probe_sha256": stop.sha(stop.inspection.PROBE.encode())}
        preview = {"phase": "startup-diagnostic-stop-preview", "state": "succeeded",
                   "attempt": "5" * 32, "inputs": inputs,
                   "result": {"state": "preview-passed"}}
        control = Mock(project=req["compose_project"], volume="volume")
        control.read.side_effect = lambda path, optional=False: preview if path.endswith("verified.json") and preview_valid else None
        phase = "startup-diagnostic-stop" if apply else "startup-diagnostic-stop-preview"
        operation = {"root": phase + "/attempts/" + "6" * 32, "receipt": {"attempt": "6" * 32},
                     "helper_container_id": "7" * 64, "daemon_pending": False}
        self.operation = operation
        @contextmanager
        def leased(*args):
            yield operation
        control.operation.side_effect = leased
        def record(c, path, expected=None):
            if path == "verification/request.json": return stop.canonical(req) + b"\n", req
            if path.startswith("resume/"): return b"resume", terminal(req)
            if path.startswith("startup-diagnostic-stop-preview/"): return b"preview", preview
            raise AssertionError(path)
        def actual(service, running):
            return {"Id": req[service + "_container_id"], "Image": req[service + "_image_id"],
                    "State": {"StartedAt": req[service + "_started_at"], "Running": running,
                              "FinishedAt": "2026-10-26T05:40:00.123456789Z", "Pid": 0 if not running else 100,
                              "OOMKilled": False, "ExitCode": 0}}
        backend, frontend = actual("backend", True), actual("frontend", True)
        def pins(item):
            return {"container_id": item["Id"], "image_id": item["Image"],
                    "started_at": item["State"]["StartedAt"], "fingerprint": "8" * 64}
        released = {"active_count": 0, "leases": [], "reservations": []}
        evidence = {"backend_before": pins(backend), "frontend_before": pins(frontend), "released_before": released}
        fresh = deepcopy(evidence)
        if evidence_changed: fresh["changed"] = True
        argv = ["stop", "--source-root", str(source), "--image-id", req["backend_image_id"],
                "--request", "verification/request.json", "--request-sha256", "9" * 64] + (["--apply"] if apply else [])
        with ExitStack() as stack:
            for target, kwargs in [
                ("sys.argv", {"new": argv}),
                ("docker_dev._select_source", {"return_value": (source, {})}),
                ("docker_dev._compose_identity", {"return_value": {}}),
                ("docker_volume_stop_startup_diagnostic.BuildControl", {"return_value": control}),
                ("docker_volume_stop_startup_diagnostic.pinned_json", {"side_effect": record}),
                ("docker_volume_stop_startup_diagnostic.verify", {"side_effect": [(evidence, backend, frontend), (fresh, backend, frontend)]}),
                ("docker_volume_stop_startup_diagnostic.container_pins", {"side_effect": pins}),
                ("docker_volume_stop_startup_diagnostic.unchanged_control_evidence", {}),
                ("docker_volume_unclaimed_cancellation._project_container_ids", {"return_value": {backend["Id"], frontend["Id"], operation["helper_container_id"]}}),
                ("docker_volume_unclaimed_cancellation._volume_consumer_ids", {"return_value": {backend["Id"], frontend["Id"], operation["helper_container_id"]}}),
                ("docker_dev_recovery_build.inspect_one", {"side_effect": [actual("backend", not stop_confirmed), frontend]}),
                ("docker_volume_pre_ack_retry._released_snapshot", {"return_value": released}),
            ]:
                stack.enter_context(patch(target, **kwargs))
            self.daemon = stack.enter_context(patch.object(stop, "docker_capture"))
            self.control = control
            stop.main()
        return req, operation

    def test_preview_never_sends_stop_or_publishes_stop_intent(self):
        self.invoke()
        self.daemon.assert_not_called()
        self.assertFalse(self.operation["daemon_pending"])
        self.assertEqual(self.operation["receipt"]["result"]["state"], "preview-passed")
        self.assertTrue(all(not call.args[0].startswith("verification/stop-startup-diagnostic-") for call in self.control.write.call_args_list))

    def test_apply_requires_matching_successful_preview(self):
        with self.assertRaisesRegex(stop.BuildControlError, "successful preview"):
            self.invoke(apply=True, preview_valid=False)
        self.daemon.assert_not_called(); self.control.operation.assert_not_called()

    def test_changed_pre_signal_evidence_never_stops_backend(self):
        with self.assertRaisesRegex(stop.BuildControlError, "changed under"):
            self.invoke(apply=True, evidence_changed=True)
        self.daemon.assert_not_called()
        self.assertFalse(self.operation["daemon_pending"])

    def test_apply_sends_one_stop_and_authenticates_immutable_journal(self):
        req, operation = self.invoke(apply=True)
        self.daemon.assert_called_once_with("stop", "--time", "60", req["backend_container_id"], timeout=90)
        writes = self.control.write.call_args_list
        journals = [call.args[1] for call in writes if call.args[0].endswith("/stop-journal.json")]
        self.assertEqual(len(journals), 1)
        journal = journals[0]
        self.assertEqual(journal["released_before"], journal["released_after"])
        self.assertEqual(operation["receipt"]["startup_diagnostic_stop_sha256"], stop.sha(stop.canonical(journal) + b"\n"))
        self.assertEqual(operation["receipt"]["state"], "succeeded")
        self.assertFalse(operation["daemon_pending"])

    def test_uncertain_stop_retains_intent_and_unknown_daemon_state(self):
        with self.assertRaisesRegex(stop.BuildControlError, "not confirmed"):
            self.invoke(apply=True, stop_confirmed=False)
        self.daemon.assert_called_once()
        self.assertTrue(self.operation["daemon_pending"])
        self.assertTrue(any(call.args[1].get("state") == "stop-planned" for call in self.control.write.call_args_list))
        self.assertFalse(any(call.args[0].endswith("/stop-journal.json") for call in self.control.write.call_args_list))


if __name__ == "__main__":
    unittest.main()
