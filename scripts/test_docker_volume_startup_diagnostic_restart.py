"""Read-only restart authentication regressions; no Docker mutation is executed."""
import ast
import inspect
from contextlib import ExitStack, nullcontext
from copy import deepcopy
import hashlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from docker_build_control import BuildControlError, canonical
import docker_volume_dev as dev
import docker_volume_container_recovery as recovery
import docker_volume_startup_diagnostic_restart as restart
from docker_volume_reconcile import fingerprint

B, F, IMAGE = "b" * 64, "f" * 64, "sha256:" + "a" * 64
ATTEMPT, RESUME, STOP = "1" * 32, "2" * 32, "3" * 32
DIGEST = "d" * 64
START = "2026-10-26T01:00:00.000000000Z"
END = "2026-10-26T01:01:00.000000000Z"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class Fixture:
    def __init__(self):
        self.control = SimpleNamespace(project="project", volume="control")
        self.auth = {"native_request_sha256": "e" * 64}
        self.auth_raw, self.receipt_raw = b"authorization", b"native-complete"
        self.history_raw = b"historical process receipt"
        self.previous = {"attempt": ATTEMPT, "phase": "development", "compose_project": "project", "control_volume": "control", "inputs": {"source_root": "/source", "image_id": IMAGE}}
        self.document = {"services": {"backend": {"environment": {
            recovery.AUTHORIZATION_ENV: recovery.CONTROL_ROOT + "/authorization.json"}}}}
        self.actual = {name: {"Id": identifier, "Image": IMAGE, "Config": {}, "HostConfig": {}, "Mounts": [],
            "State": {"StartedAt": START, "FinishedAt": END, "Running": name == "frontend",
                      "Pid": 0 if name == "backend" else 100, "OOMKilled": False, "ExitCode": 0}}
            for name, identifier in (("backend", B), ("frontend", F))}
        self.released = {"schema": "fullmag.pre-ack-released-observation.v1", "active_count": 0,
                         "reservations": [], "leases": []}
        self.guest = {"owner_sha256": DIGEST, "runtime_config_sha256": DIGEST,
            "historical_process_receipt_sha256": sha(self.history_raw), "active_reservations": 0,
            "active_local_leases": 0, "historical_process_receipt_used_as_current": False}
        self.inspection = {"schema": "fullmag.docker-startup-diagnostic-inspection.v1", "state": "inspected",
            "backend_container_id": B, "image_id": IMAGE, "backend_started_at": START, "guest": self.guest}
        self.resume = {"schema": "fullmag.docker-build-operation.v1", "state": "failed-confirmed", "compose_project": "project", "control_volume": "control",
            "phase": "resume", "attempt": RESUME, "config_sha256": sha(canonical(self.document)),
            "backend_started_at": START, "worker_cgroup": {"schema": "fullmag.worker-cgroup-ready.v1", "state": "ready",
                "container_id": B, "image_id": IMAGE, "compose_project": "project"}, "inputs": {"attempt": ATTEMPT, "config_sha256": sha(canonical(self.document))}}
        self.request = {"schema": "fullmag.docker-startup-diagnostic-stop-request.v1",
            "request_id": "12345678-1234-4234-8234-123456789abc", "reason": "Stop our failed startup diagnostic",
            "development_attempt": ATTEMPT, "compose_config_sha256": sha(canonical(self.document)),
            "source_root": "/source", "compose_project": "project", "resume_attempt": RESUME,
            "inspection_relative": "verification/inspection.json", "historical_process_receipt_sha256": sha(self.history_raw)}
        for service in ("backend", "frontend"):
            actual = self.actual[service]
            self.request.update({service + "_container_id": actual["Id"], service + "_image_id": IMAGE,
                                 service + "_started_at": START})
        self.journal = {"schema": restart.STOP_SCHEMA, "state": "stopped-confirmed", "request": self.request,
            "inspection": self.inspection, "completed_recovery": {
                "authorization_sha256": sha(self.auth_raw), "receipt_sha256": sha(self.receipt_raw)},
            "released_before": self.released, "released_after": self.released,
            "stop_operation": {"phase": "startup-diagnostic-stop", "attempt": STOP,
                               "root": "startup-diagnostic-stop/attempts/" + STOP}, **self.guest}
        for service in ("backend", "frontend"):
            actual = self.actual[service]
            self.journal[service + "_before"] = {"container_id": actual["Id"], "image_id": IMAGE,
                "started_at": START, "fingerprint": fingerprint(actual)}
        self.journal["backend_after"] = {**self.journal["backend_before"], "finished_at": END,
            "exit_code": 0, "running": False, "pid": 0, "oom_killed": False}
        self.journal["frontend_after"] = {**self.journal["frontend_before"], "running": True}
        self.records = {}
        self.reseal()

    def record(self, path, value):
        raw = canonical(value) + b"\n"
        self.records[path] = (raw, deepcopy(value))
        return sha(raw)

    def reseal(self):
        self.journal["development_terminal_sha256"] = self.record("development/attempts/" + ATTEMPT + "/terminal.json", self.previous)
        self.journal["compose_document_sha256"] = self.record("development/attempts/" + ATTEMPT + "/compose.json", self.document)
        self.request["resume_terminal_sha256"] = self.record("resume/attempts/" + RESUME + "/terminal.json", self.resume)
        self.request["inspection_sha256"] = self.record("verification/inspection.json", self.inspection)
        self.journal["request_sha256"] = sha(canonical(self.request) + b"\n")
        digest = self.record("verification/stop-startup-diagnostic-" + B + ".json", self.journal)
        root = self.journal["stop_operation"]["root"]
        self.record(root + "/stop-journal.json", self.journal)
        self.record(root + "/terminal.json", {"state": "succeeded", "phase": "startup-diagnostic-stop",
            "attempt": STOP, "compose_project": "project", "control_volume": "control",
            "inputs": {"request_sha256": self.journal["request_sha256"]}, "startup_diagnostic_stop_sha256": digest})

    def invoke(self, *, removed=False, fresh=False, completed=True):
        def control_bytes(control, path, optional=False):
            if path == "activation/unresolved.json": return None
            if path == "authorization.json": return self.auth_raw
            if path == "runtime-control/runtime-service/process-tree.json": return self.history_raw
            if path.endswith("/receipt.json"): return self.receipt_raw
            return self.records.get(path, (None, None))[0]
        with ExitStack() as stack:
            stack.enter_context(patch.object(restart, "_read", side_effect=lambda c,p,l: self.records[p]))
            stack.enter_context(patch.object(recovery, "_control_bytes", side_effect=control_bytes))
            stack.enter_context(patch.object(dev, "_validate_completed_recovery_receipt", return_value=completed))
            stack.enter_context(patch.object(dev, "_read_runtime_config_digest", return_value=DIGEST))
            stack.enter_context(patch.object(restart, "_owner_digest", return_value=DIGEST))
            stack.enter_context(patch("docker_volume_pre_ack_retry._released_snapshot", return_value=self.released))
            return restart.retained_context(self.control, self.previous, self.document, B,
                fresh_state=fresh, authorization=self.auth, actual=self.actual,
                removed_container_proof={"container_id": B, "frontend_container": F} if removed else None)


class AuthenticationTests(unittest.TestCase):
    def test_retained_and_removed_preserve_exact_config_without_old_authority(self):
        f = Fixture()
        for removed in (False, True):
            if removed: f.actual["frontend"]["State"]["Running"] = False
            context = f.invoke(removed=removed)
            self.assertIsInstance(context, restart.StartupDiagnosticStopContext)
            self.assertEqual(set(context), {"previous_config_sha256", "startup_diagnostic_restart"})
            self.assertEqual(context["previous_config_sha256"], DIGEST)

    def test_owner_digest_uses_canonical_overmounted_control_record(self):
        control = Mock(); control.read_bytes.return_value = b"retained Failed owner"
        self.assertEqual(restart._owner_digest(control), sha(control.read_bytes.return_value))
        control.read_bytes.assert_called_once_with("runtime-control/runtime-services/OWNER.json", maximum=256 * 1024)

    def test_incomplete_native_recovery_is_rejected(self):
        with self.assertRaises(BuildControlError): Fixture().invoke(completed=False)

    def test_fresh_state_is_rejected(self):
        with self.assertRaises(BuildControlError): Fixture().invoke(fresh=True)

    def test_failed_resume_terminal_required(self):
        f = Fixture(); f.resume["state"] = "succeeded"; f.reseal()
        with self.assertRaises(BuildControlError): f.invoke()

    def test_stale_container_incarnation_is_rejected(self):
        f = Fixture(); f.actual["backend"]["State"]["StartedAt"] = "new"
        with self.assertRaises(BuildControlError): f.invoke()

    def test_restarted_frontend_is_rejected(self):
        f = Fixture(); f.actual["frontend"]["State"]["StartedAt"] = "new"
        with self.assertRaises(BuildControlError): f.invoke()

    def test_stopped_frontend_requires_removed_namespace_proof(self):
        f = Fixture(); f.actual["frontend"]["State"]["Running"] = False
        with self.assertRaises(BuildControlError): f.invoke()

    def test_changed_resource_inventory_is_rejected(self):
        f = Fixture(); f.released = {**f.released, "leases": [["new", DIGEST]]}
        with self.assertRaises(BuildControlError): f.invoke()

    def test_changed_historical_process_receipt_is_rejected(self):
        for removed in (False, True):
            f = Fixture(); f.history_raw = b"changed after successful stop"
            if removed: f.actual["frontend"]["State"]["Running"] = False
            with self.subTest(removed=removed), self.assertRaisesRegex(BuildControlError, "historical process receipt changed"):
                f.invoke(removed=removed)

    def test_missing_immutable_stop_terminal_is_rejected(self):
        f = Fixture(); path = f.journal["stop_operation"]["root"] + "/terminal.json"
        raw, value = f.records[path]; value["state"] = "failed-confirmed"; f.record(path, value)
        with self.assertRaises(BuildControlError): f.invoke()

    def test_changed_completed_recovery_digest_is_rejected(self):
        f = Fixture(); f.journal["completed_recovery"]["receipt_sha256"] = "0" * 64; f.reseal()
        with self.assertRaises(BuildControlError): f.invoke()

    def test_backend_oom_is_rejected(self):
        f = Fixture(); f.actual["backend"]["State"]["OOMKilled"] = True
        with self.assertRaises(BuildControlError): f.invoke()

    def test_missing_journal_keeps_existing_authority(self):
        f = Fixture(); del f.records["verification/stop-startup-diagnostic-" + B + ".json"]
        self.assertIsNone(f.invoke())

    def test_no_backend_pin_keeps_existing_authority(self):
        self.assertIsNone(restart.retained_context(None, {}, {}, None,
            fresh_state=False, authorization={}))

    def test_script_cannot_be_activated(self):
        f = Fixture(); f.document["services"]["backend"]["environment"]["FULLMAG_STARTUP_ENABLED"] = "1"
        f.request["compose_config_sha256"] = sha(canonical(f.document)); f.reseal()
        with self.assertRaises(BuildControlError): f.invoke()

    def test_start_metadata_alone_cannot_authorize_new_start(self):
        metadata = Fixture().invoke()["startup_diagnostic_restart"]
        with self.assertRaisesRegex(BuildControlError, "authenticated completed recreation"):
            dev.start(SimpleNamespace(script=None), reuse_state={},
                      previous_config_sha256=DIGEST, startup_diagnostic_restart=metadata)

    def test_start_cannot_combine_different_recovery(self):
        metadata = Fixture().invoke()["startup_diagnostic_restart"]
        with self.assertRaisesRegex(BuildControlError, "same store"):
            dev.start(SimpleNamespace(script=None), reuse_state=None,
                      previous_config_sha256=DIGEST, startup_diagnostic_restart=metadata)

    def test_start_revalidates_with_exact_operation_inside_lease(self):
        function = ast.parse(inspect.getsource(dev.start)).body[0]
        leased = next(node for node in ast.walk(function) if isinstance(node, ast.With)
            and isinstance(node.items[0].context_expr, ast.Name)
            and node.items[0].context_expr.id == "operation_context")
        # Execute the real startup-diagnostic branch from start, with its actual lease binding.
        branch = ast.With(items=leased.items, body=[leased.body[0]], type_comment=None)
        module = ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[]))
        operation, metadata, proof = {}, {"schema": restart.SCHEMA}, {"proof": "pinned"}
        calls = []
        def validate(*args, **kwargs):
            calls.append(kwargs)
            self.assertIs(kwargs.get("current_operation"), operation)
            self.assertIs(kwargs.get("expected_proof"), proof)
            return {"native_recovery_context": {"startup_diagnostic_restart": metadata}}
        scope = {"operation_context": nullcontext(operation), "validated_startup_diagnostic_restart": metadata,
                 "recreation_resume_proof": proof, "_validate_recreation_resume_records": validate,
                 "args": None, "control": None, "selected": None, "identity": None,
                 "BuildControlError": BuildControlError}
        exec(compile(module, dev.__file__, "exec"), scope)
        self.assertEqual(len(calls), 1)

    def test_metadata_cannot_alias_native_stop_or_escape_control(self):
        context = Fixture().invoke()
        for key, value in (("schema", "fullmag.docker-native-failed-stop.v1"),
                           ("stop_journal_relative", "../outside"), ("runtime_config_sha256", "bad")):
            metadata = {**context["startup_diagnostic_restart"], key: value}
            with self.assertRaises(BuildControlError): restart.validate_metadata(metadata)


if __name__ == "__main__":
    unittest.main()
