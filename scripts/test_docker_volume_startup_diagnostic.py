"""Validate the non-mutating startup diagnostic inspection boundary."""
import ast
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import sys
import subprocess
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_startup_diagnostic as diagnostic


class StartupDiagnosticOptionsTests(unittest.TestCase):
    def options(self, **changes):
        values = {"backend_container_id": "a" * 64, "image_id": "sha256:" + "b" * 64,
                  "report": "verification/startup-diagnostic/inspection.json"}
        return SimpleNamespace(**dict(values, **changes))

    def test_complete_immutable_pins_and_control_path_are_accepted(self):
        diagnostic.validate_options(self.options())

    def test_abbreviated_or_malformed_identity_is_rejected(self):
        for changes in ({"backend_container_id": "a" * 12}, {"image_id": "latest"},
                        {"backend_container_id": "A" * 64}, {"image_id": "sha256:" + "z" * 64}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                diagnostic.validate_options(self.options(**changes))

    def test_report_cannot_escape_or_alias_control_verification(self):
        for report in ("/tmp/report.json", "verification/../active", "verification//x.json",
                       "verification/./x.json", "active", "verification/x.txt"):
            with self.subTest(report=report), self.assertRaises(ValueError):
                diagnostic.validate_options(self.options(report=report))


def ready_guest():
    owner = {"schema_version": "runtime_service_owner.v1", "protocol": "stdin-v1", "state": "ready",
             "target_id": "docker-all", "pid": 20, "owner_token": "owner", "process_start_token": "start",
             "host": "host", "control_address": "control", "acquired_at": "then", "heartbeat_at": "later",
             "build_commit": "a" * 40, "build_snapshot": "b" * 64,
             "compute_pool_id": "compute", "preparation_pool_id": "preparation",
             "compute_pool_generation": 1, "preparation_pool_generation": 1,
             "children": [{"role": "compute", "pid": 21, "status": "running"},
                          {"role": "preparation", "pid": 22, "status": "running"}]}
    historical = deepcopy(owner); historical["heartbeat_at"] = "earlier"
    return {"schema": "fullmag.docker-startup-diagnostic-guest.v2", "owner": owner,
            "historical_process_receipt": {"schema": "fullmag.docker-process-tree.v1", "state": "ready",
                                           "api_pid": 19, "service_owner": historical},
            "live_pids": [1, 7, 99], "fence": {"reason": diagnostic.READY_FAILURE_REASON},
            "active_reservations": 0, "active_local_leases": 0,
            "historical_process_receipt_used_as_current": False, "terminal_catalog_digests": {}}


class HistoricalReadyTests(unittest.TestCase):
    def test_heartbeat_drift_preserves_the_same_historical_identity(self):
        value = ready_guest()
        self.assertEqual(diagnostic.validate_ready_guest(value), value)

    def test_changed_historical_identity_is_rejected(self):
        for field, changed in (("owner_token", "foreign"), ("process_start_token", "foreign"),
                               ("pid", 123), ("build_commit", "c" * 40), ("acquired_at", "other")):
            value = ready_guest(); value["historical_process_receipt"]["service_owner"][field] = changed
            with self.subTest(field=field), self.assertRaises(diagnostic.BuildControlError):
                diagnostic.validate_ready_guest(value)
        for field, changed in (("schema", "foreign"), ("state", "failed")):
            value = ready_guest(); value["historical_process_receipt"][field] = changed
            with self.subTest(field=field), self.assertRaises(diagnostic.BuildControlError):
                diagnostic.validate_ready_guest(value)

    def test_live_historical_api_owner_or_scheduler_is_rejected(self):
        for pid in (19, 20, 21, 22):
            value = ready_guest(); value["live_pids"].append(pid)
            with self.subTest(pid=pid), self.assertRaises(diagnostic.BuildControlError):
                diagnostic.validate_ready_guest(value)

    def test_wrong_failure_or_active_resources_are_rejected(self):
        value = ready_guest(); value["fence"]["reason"] = "some other failure"
        with self.assertRaises(diagnostic.BuildControlError):
            diagnostic.validate_ready_guest(value)
        for field in ("active_reservations", "active_local_leases"):
            value = ready_guest(); value[field] = 1
            with self.subTest(field=field), self.assertRaises(diagnostic.BuildControlError):
                diagnostic.validate_ready_guest(value)

    def test_non_ready_owner_is_rejected(self):
        value = ready_guest(); value["owner"]["state"] = "failed"
        with self.assertRaises(diagnostic.BuildControlError):
            diagnostic.validate_ready_guest(value)


class TerminalCatalogTests(unittest.TestCase):
    def check(self, catalog):
        tree = ast.parse(diagnostic.PROBE)
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "terminal_catalog")
        namespace = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "<actual-diagnostic-catalog-validator>", "exec"), namespace)
        namespace["terminal_catalog"](catalog, "run-test")

    def test_terminal_tasks_are_accepted(self):
        self.check({"run_id": "run-test", "tasks": [{"task_id": str(i), "lifecycle": state}
                   for i, state in enumerate(("succeeded", "failed", "cancelled"))]})

    def test_active_pending_or_ambiguous_tasks_are_rejected(self):
        for state in ("queued", "running", "preparing", "pending", "unknown", None):
            with self.subTest(state=state), self.assertRaises(RuntimeError):
                self.check({"run_id": "run-test", "tasks": [{"task_id": "one", "lifecycle": state}]})
        for catalog in ({}, {"run_id": "foreign", "tasks": []}, {"run_id": "run-test", "tasks": []},
                        {"run_id": "run-test", "tasks": [{"task_id": "same", "lifecycle": "failed"}] * 2}):
            with self.subTest(catalog=catalog), self.assertRaises(RuntimeError):
                self.check(catalog)


class StartupDiagnosticShellTests(unittest.TestCase):
    def test_composite_command_cannot_use_the_read_only_route(self):
        root = Path(__file__).resolve().parent.parent
        body = (f'python3 "{root}/scripts/docker_volume_startup_diagnostic.py" '
                "--source-root '/checkout' --backend-container-id '" + "a" * 64
                + "' --image-id 'sha256:" + "b" * 64
                + "' --report 'verification/x.json'; echo SHOULD_NOT_EXECUTE")
        result = subprocess.run(["bash", str(root / "scripts/just_storage_shell.sh"), body],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("SHOULD_NOT_EXECUTE", result.stdout)
        self.assertIn("invalid read-only startup diagnostic inspection recipe", result.stderr)


if __name__ == "__main__":
    unittest.main()
