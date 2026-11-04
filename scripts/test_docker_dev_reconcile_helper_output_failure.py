"""Fail-closed checks for terminal-history startup-output reconciliation."""
import copy
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_dev_reconcile_helper_output_failure as recovery
from docker_build_control import BuildControlError


REQUEST = "failed-startup"
SOURCE = "a" * 64
RUN = "run-live-historical"
INTENT = {"schema_version": "run_intent.v1", "run_id": RUN,
          "idempotency_key": "other-request", "specification": {"parameters": {
              "live_workspace": {"session_id": "older-session", "command_id": "older-command",
                                 "request_idempotency_key": "older-command",
                                 "command": {"request_id": "older-command"}}}}}


class FailureSignatureTests(unittest.TestCase):
    def error(self, **changes):
        response = {"code": "internal_error", "message": recovery.FAILURE, **changes}
        return "startup activation returned HTTP 500: " + json.dumps(response)

    def test_only_exact_output_failure_is_accepted(self):
        self.assertEqual(recovery.failure_response(self.error())["message"], recovery.FAILURE)
        for error in (self.error(message="Python helper exceeded the 30 second deadline"),
                      self.error(code="validation_error"), self.error() + "\nextra",
                      self.error().replace("HTTP 500", "HTTP 422"), None):
            with self.subTest(error=error), self.assertRaises(BuildControlError):
                recovery.failure_response(error)


class AbsentRequestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / "runs" / RUN / "run_intent.json"
        self.path.parent.mkdir(parents=True)

    def check(self, value):
        self.path.write_text(json.dumps(value))
        recovery.request_absent(self.root, [{"run_id": RUN}], REQUEST, SOURCE)

    def test_unrelated_historical_intent_is_preserved(self):
        self.check(INTENT)
        self.assertEqual(json.loads(self.path.read_text()), INTENT)

    def test_each_accepted_request_identity_refuses_release(self):
        cases = []
        value = copy.deepcopy(INTENT)
        value["idempotency_key"] = "live-http-" + recovery.sha(REQUEST.encode())
        cases.append(value)
        for key, matching in (
            ("session_id", "docker-startup-" + recovery.sha((REQUEST + "\0" + SOURCE).encode())),
            ("command_id", REQUEST), ("request_idempotency_key", REQUEST),
        ):
            value = copy.deepcopy(INTENT)
            value["specification"]["parameters"]["live_workspace"][key] = matching
            cases.append(value)
        value = copy.deepcopy(INTENT)
        value["specification"]["parameters"]["live_workspace"]["command"]["request_id"] = REQUEST
        cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                self.check(value)

    def test_malformed_or_missing_intent_refuses_release(self):
        cases = [None, [], {**INTENT, "schema_version": "unknown"},
                 {**INTENT, "run_id": "different"}, {**INTENT, "specification": None}]
        value = copy.deepcopy(INTENT)
        value["specification"]["parameters"]["live_workspace"] = "invalid"
        cases.append(value)
        value = copy.deepcopy(INTENT)
        value["specification"]["parameters"]["live_workspace"]["command"] = "invalid"
        cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                self.check(value)
        self.path.unlink()
        with self.assertRaises(BuildControlError):
            recovery.request_absent(self.root, [{"run_id": RUN}], REQUEST, SOURCE)

    def test_protected_run_digest_detects_changed_payload(self):
        self.path.write_text(json.dumps(INTENT))
        initial = recovery.protected_runs_digest(self.root)
        self.path.write_text(json.dumps({**INTENT, "extra": True}))
        self.assertNotEqual(initial, recovery.protected_runs_digest(self.root))


class PublicationAndResumeTests(unittest.TestCase):
    def test_resume_rejects_changed_pins_plan_or_backend_incarnation(self):
        bindings = {"schema": recovery.SCHEMA, "activation": "a" * 32, "source_sha256": SOURCE}
        plan = {**bindings, "backend_started_at": "original-start", "protected_runs_sha256": "b" * 64}
        intent = {"schema": recovery.SCHEMA, "plan": plan, "plan_sha256": recovery.sha(recovery.canonical(plan))}
        self.assertEqual(recovery.retained_plan(intent, bindings, "original-start")[0], plan)
        for value, pins, incarnation in (
            (None, bindings, "original-start"),
            (intent, bindings, "restarted"),
            (intent, {**bindings, "source_sha256": "c" * 64}, "original-start"),
            ({**intent, "plan_sha256": "d" * 64}, bindings, "original-start"),
        ):
            with self.subTest(value=value, pins=pins, incarnation=incarnation), self.assertRaises(BuildControlError):
                recovery.retained_plan(value, pins, incarnation)

    def test_publication_guard_stops_on_symlink_or_changed_bytes(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            control = SimpleNamespace(path=lambda relative: str(root / relative))
            actual = root / "actual"
            actual.write_bytes(b"original")
            guarded = root / "active"
            guarded.symlink_to(actual)
            guards = recovery.publication_guards(control, (("active", recovery.sha(b"original")),))
            command = "; ".join(["set -euo pipefail", *guards, "printf published"])
            result = subprocess.run(["bash", "-c", command], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b"published", result.stdout)
            guarded.unlink()
            guarded.write_bytes(b"changed")
            result = subprocess.run(["bash", "-c", command], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            guarded.write_bytes(b"original")
            result = subprocess.run(["bash", "-c", command], capture_output=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b"published")

    def test_stopped_backend_resumes_from_durable_intent_without_health_or_restart(self):
        with TemporaryDirectory() as temporary:
            state = Path(temporary)
            store = state / "runs/docker-all/session-store"
            intent_file = store / "runs" / RUN / "run_intent.json"
            intent_file.parent.mkdir(parents=True)
            intent_file.write_text(json.dumps(INTENT))
            root = "activation/attempts/" + "a" * 32
            marker_path = "backend/script-activation-key/activation.json"
            inputs = {"request_id": REQUEST, "source_sha256": SOURCE, "provenance_sha256": "b" * 64,
                      "activation_receipt_path": "/opt/fullmag/control/" + marker_path}
            receipt = {"retirement_phase": "startup", "helper_container": "original-helper", "inputs": inputs,
                       "error": FailureSignatureTests().error()}
            raw = recovery.canonical(receipt)
            marker = recovery.canonical({"state": "started", **{key: inputs[key] for key in ("request_id", "source_sha256", "provenance_sha256")}})
            previous = {"state": "succeeded", "attempt": "dev", "backend_container": "backend",
                        "inputs": {"image_id": "image"}, "config_sha256": "config", "state_root": str(state)}
            documents = {"development/current.json": previous, "development/attempts/dev/compose.json": {}}
            control = SimpleNamespace(read=lambda name, optional=False: documents.get(name),
                                      write=lambda name, value: documents.__setitem__(name, value),
                                      path=lambda name: "/control/" + name, project="project")
            running, active, interruption, new_session = True, True, True, False
            calls = []

            def raw_read(unused, name, optional=False):
                if name == "active":
                    return b"a" * 32 if active else None
                if name == marker_path:
                    return marker
                return b"{}"

            def docker(*args, **kwargs):
                nonlocal running, active, interruption
                calls.append(args)
                if args[0] == "inspect":
                    return SimpleNamespace(stdout=json.dumps([{"State": {"Running": running, "StartedAt": "2026-11-02T12:00:00Z"}}]))
                if args[0] == "kill":
                    self.assertIn(root + "/terminal-history-output-intent.json", documents)
                    running = False
                    if interruption:
                        interruption = False
                        raise OSError("observation lost after SIGTERM")
                if args[:2] == ("exec", "backend"):
                    self.assertTrue(running, "must not exec health into a stopped backend")
                    return SimpleNamespace(stdout=json.dumps({"status": "ok", "active_session": new_session}))
                if args[:2] == ("exec", "original-helper"):
                    active = False
                    proof = documents[root + "/terminal-history-output-proof.json"]
                    documents[root + "/terminal.json"] = {**receipt, "state": "failed-confirmed",
                        "activation_state": "not-admitted", "reconciliation": "pre-admission-output-terminal-history",
                        "release_proof_sha256": recovery.sha(recovery.canonical(proof))}
                    return SimpleNamespace(stdout=b"RECONCILED\n")
                return SimpleNamespace(stdout=b"")

            arguments = SimpleNamespace(activation="a" * 32, apply=False, plan_sha256=None)
            with patch.object(recovery, "_selected_context", return_value=(None, Path("/source"), None, {}, control)), \
                 patch.object(recovery, "_validate_activation_receipt", return_value=(receipt, raw, inputs)), \
                 patch.object(recovery, "_validate_helper", return_value=(None, "original-helper")), \
                 patch.object(recovery, "_validate_helper_logged"), \
                 patch.object(recovery, "_linked_runtime_terminals", return_value=[{}]), \
                 patch.object(recovery, "_validate_running_group", return_value=("backend", "frontend")) as live_group, \
                 patch.object(recovery, "_inventory_store", return_value={"runs": [{"run_id": RUN}]}), \
                 patch.object(recovery, "validate_stopped_backend") as stopped, \
                 patch.object(recovery, "validate_drained") as drained, \
                 patch.object(recovery, "_raw", side_effect=raw_read), \
                 patch.object(recovery, "docker_capture", side_effect=docker):
                preview = recovery.reconcile(arguments)
                arguments.apply, arguments.plan_sha256 = True, preview["plan_sha256"]
                with self.assertRaisesRegex(OSError, "observation lost"):
                    recovery.reconcile(arguments)
                live_calls = live_group.call_count
                result = recovery.reconcile(arguments)
                self.assertEqual(result["state"], "not-admitted-confirmed")
                self.assertEqual(live_group.call_count, live_calls)
                stopped.assert_called_once()
                drained.assert_called_once()
                self.assertEqual(sum(call[0] == "kill" for call in calls), 1)
                repeated = recovery.reconcile(arguments)
                self.assertIs(repeated["replayed"], False)
                self.assertIs(repeated["already_completed"], True)
                self.assertEqual(json.loads(intent_file.read_text()), INTENT)
                # Simulate an interrupted pre-stop attempt retaining its intent,
                # followed by a new live session. Resume must not send SIGTERM.
                del documents[root + "/terminal.json"]
                del documents[root + "/terminal-history-output-proof.json"]
                running, active, new_session = True, True, True
                signals_before = sum(call[0] == "kill" for call in calls)
                with self.assertRaisesRegex(BuildControlError, "no longer empty"):
                    recovery.reconcile(arguments)
                self.assertEqual(sum(call[0] == "kill" for call in calls), signals_before)


if __name__ == "__main__":
    unittest.main()
