"""Focused source-only regressions for the native failed-admission stop draft."""

from __future__ import annotations

import ast
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


MODULE_PATH = Path(__file__).with_name("docker_volume_stop_failed.py")
sys.path.insert(0, str(Path(__file__).resolve().parent))
SPEC = importlib.util.spec_from_file_location("stop_failed_draft", MODULE_PATH)
assert SPEC and SPEC.loader
stop = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stop)


def owner(*, compute_status: str = "exited_success") -> dict[str, object]:
    return {
        "schema_version": "runtime_service_owner.v1",
        "protocol": "stdin-v1",
        "state": "failed",
        "owner_token": "owner-token",
        "process_start_token": "process-token",
        "pid": 3241,
        "host": "fullmag-test-host",
        "target_id": "docker-all",
        "control_address": "127.0.0.1:43123",
        "build_commit": "a" * 40,
        "build_snapshot": "b" * 64,
        "compute_pool_id": "compute-pool",
        "preparation_pool_id": "preparation-pool",
        "compute_pool_generation": 7,
        "preparation_pool_generation": 8,
        "acquired_at": "2026-10-19T10:00:00Z",
        "heartbeat_at": "2026-10-19T10:00:01Z",
        "children": [
            {"role": "compute", "pid": 3250, "status": compute_status},
            {"role": "preparation", "pid": 3251, "status": "exited_success"},
        ],
    }


def ready_owner(*, compute_status: str = "running") -> dict[str, object]:
    value = owner(compute_status=compute_status)
    value["state"] = "ready"
    value["children"] = [
        {**child, "status": compute_status if child["role"] == "compute" else "running"}
        for child in value["children"]
    ]
    return value


def probe(**changes: object) -> dict[str, object]:
    receipt = {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "failed_outcome_retained",
        "api_pid": 3227,
        "api_exit_code": -15,
        "error": "runtime CLI failed: native service exited during startup",
    }
    document = {
        "schema": stop.NATIVE_FAILURE_PROBE_SCHEMA,
        "process_receipt_sha256": "r" * 64,
        "process_receipt": receipt,
        "failed_owner_sha256": "o" * 64,
        "failed_owner": owner(),
        "api_pid_exists": False,
        "native_processes_live": False,
        "startup_enabled": None,
        "legacy_activation_marker_exists": False,
        "reservation_states": ["released"],
        "lease_states": ["released"],
        "active_lease_count": 0,
    }
    document.update(changes)
    return document


def after_ready_probe(**changes: object) -> dict[str, object]:
    receipt = {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "failed_outcome_retained",
        "api_pid": 3227,
        "api_exit_code": -15,
        "error": "runtime service owner observation failed during supervision",
        "service_owner": ready_owner(),
    }
    failed = owner(compute_status="exited_failure")
    document = {
        "schema": stop.NATIVE_AFTER_READY_FAILURE_PROBE_SCHEMA,
        "process_receipt_sha256": "r" * 64,
        "process_receipt": receipt,
        "failed_owner_sha256": "o" * 64,
        "failed_owner": failed,
        "api_pid_exists": False,
        "owner_pid_exists": False,
        "child_pids_exist": False,
        "native_processes_live": False,
        "startup_enabled": None,
        "legacy_activation_marker_exists": False,
        "reservation_states": ["released"],
        "lease_states": ["released"],
        "active_lease_count": 0,
    }
    document.update(changes)
    return document


class NativeFailedStopTests(unittest.TestCase):
    @staticmethod
    def _extract_native_processes_live(os_mock):
        """Compile only the image-owned process scanner from the probe."""
        tree = ast.parse(stop._native_failure_probe_script(), mode="exec")
        function = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "native_processes_live"
        )
        module = ast.Module(body=[function], type_ignores=[])
        namespace = {"os": os_mock, "pathlib": __import__("pathlib")}
        exec(compile(ast.fix_missing_locations(module), "<native-process-probe>", "exec"), namespace)
        return namespace["native_processes_live"]

    def test_accepts_terminal_native_owner_with_drained_children(self):
        value = stop._validate_native_failure_probe(
            probe(), "r" * 64
        )
        self.assertEqual(value["failed_owner"]["state"], "failed")

    def test_rejects_failed_child_without_rewriting_evidence(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(
                probe(failed_owner=owner(compute_status="exited_failure")), "r" * 64
            )

    def test_rejects_live_child(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(
                probe(failed_owner=owner(compute_status="running")), "r" * 64
            )

    def test_rejects_active_lease_without_touching_history(self):
        document = probe(lease_states=["released", "active"])
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(document, "r" * 64)

    def test_rejects_receipt_that_can_still_drain_an_owner(self):
        document = probe(
            process_receipt={
                **probe()["process_receipt"],
                "service_owner": owner(),
            }
        )
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(document, "r" * 64)

    def test_rejects_digest_mismatch(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_failure_probe(probe(), "x" * 64)

    def test_native_failure_requires_positive_api_pid(self):
        for value in (None, False, 0, "3227"):
            with self.subTest(api_pid=value):
                document = probe()
                document["process_receipt"] = {
                    **document["process_receipt"],
                    "api_pid": value,
                }
                with self.assertRaisesRegex(stop.BuildControlError, "API pid"):
                    stop._validate_native_failure_probe(document, "r" * 64)

        document = probe()
        document["process_receipt"] = {
            key: value for key, value in document["process_receipt"].items()
            if key != "api_pid"
        }
        with self.assertRaisesRegex(stop.BuildControlError, "API pid"):
            stop._validate_native_failure_probe(document, "r" * 64)

    def test_accepts_after_ready_failure_with_failed_compute_child(self):
        value = stop._validate_native_after_ready_failure_probe(
            after_ready_probe(), "r" * 64
        )
        self.assertEqual(value["failed_owner"]["state"], "failed")
        self.assertEqual(value["ready_owner"]["state"], "ready")

    def test_after_ready_owner_is_identity_pinned(self):
        altered = after_ready_probe()
        altered["failed_owner"] = {**altered["failed_owner"], "owner_token": "other"}
        with self.assertRaisesRegex(stop.BuildControlError, "differs from retained ready"):
            stop._validate_native_after_ready_failure_probe(altered, "r" * 64)

    def test_after_ready_child_identity_is_pinned(self):
        altered = after_ready_probe()
        failed_owner = altered["failed_owner"]
        altered["failed_owner"] = {
            **failed_owner,
            "children": [
                {**failed_owner["children"][0], "pid": 9999},
                failed_owner["children"][1],
            ],
        }
        with self.assertRaisesRegex(stop.BuildControlError, "differs from retained ready"):
            stop._validate_native_after_ready_failure_probe(altered, "r" * 64)

    def test_after_ready_rejects_live_native_child(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_after_ready_failure_probe(
                after_ready_probe(child_pids_exist=True), "r" * 64
            )

    def test_after_ready_rejects_live_native_worker(self):
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_after_ready_failure_probe(
                after_ready_probe(native_processes_live=True), "r" * 64
            )

    def test_after_ready_requires_positive_api_pid(self):
        for value in (None, False, 0, "3227"):
            with self.subTest(api_pid=value):
                document = after_ready_probe()
                document["process_receipt"] = {
                    **document["process_receipt"],
                    "api_pid": value,
                }
                with self.assertRaisesRegex(stop.BuildControlError, "API pid"):
                    stop._validate_native_after_ready_failure_probe(document, "r" * 64)

        document = after_ready_probe()
        document["process_receipt"] = {
            key: value for key, value in document["process_receipt"].items()
            if key != "api_pid"
        }
        with self.assertRaisesRegex(stop.BuildControlError, "API pid"):
            stop._validate_native_after_ready_failure_probe(document, "r" * 64)

    def test_after_ready_rejects_active_host_ledger(self):
        with self.assertRaisesRegex(stop.BuildControlError, "host ledger"):
            stop._validate_native_after_ready_failure_probe(
                after_ready_probe(reservation_states=["active"]), "r" * 64
            )

    def test_after_ready_requires_integer_zero_lease_count(self):
        with self.assertRaisesRegex(stop.BuildControlError, "active durable resource lease"):
            stop._validate_native_after_ready_failure_probe(
                after_ready_probe(active_lease_count=False), "r" * 64
            )

    def test_after_ready_requires_retained_ready_owner(self):
        document = after_ready_probe()
        document["process_receipt"] = {
            key: value for key, value in document["process_receipt"].items()
            if key != "service_owner"
        }
        with self.assertRaises(stop.BuildControlError):
            stop._validate_native_after_ready_failure_probe(document, "r" * 64)

    def test_probe_uses_canonical_receipt_and_scans_both_lease_roots(self):
        script = stop._native_failure_probe_script()
        self.assertIn(stop.CANONICAL_PROCESS_RECEIPT, script)
        self.assertIn("runtime_service.process_receipt_path(paths)", script)
        self.assertIn("resource_leases", script)
        self.assertIn("preparation_resource_leases", script)
        self.assertIn("OWNER.json", script)
        self.assertIn("NATIVE_AFTER_READY_FAILURE_PROBE_SCHEMA", stop.__dict__)
        self.assertIn("owner_pid_exists", script)
        self.assertIn("package_root=pathlib.Path('/opt/fullmag/package')", script)
        self.assertIn("relative=pathlib.Path(executable).relative_to(package_root)", script)
        self.assertIn("executable_name == 'fullmag'", script)
        self.assertIn("executable_name.startswith('fullmag-')", script)
        self.assertIn("runtime_service.UUID_RE", script)
        self.assertNotIn("validation_owner={**owner", script)

    def test_native_process_scanner_detects_versioned_package_executables(self):
        entries = [
            SimpleNamespace(name="101", path="/proc/101"),
            SimpleNamespace(name="102", path="/proc/102"),
            SimpleNamespace(name="103", path="/proc/103"),
            SimpleNamespace(name="104", path="/proc/104"),
        ]
        executables = {
            "/proc/101/exe": "/opt/fullmag/package/bin/fullmag",
            "/proc/102/exe": "/opt/fullmag/package/current/bin/fullmag-api",
            "/proc/103/exe": "/opt/fullmag/package/generations/g/bin/fullmag-worker",
            "/proc/104/exe": "/usr/bin/python3",
        }
        os_mock = Mock()
        os_mock.scandir.return_value = entries
        os_mock.readlink.side_effect = executables.__getitem__

        self.assertEqual(self._extract_native_processes_live(os_mock)(), [101, 102, 103])

    def test_native_process_scanner_fails_closed_on_permission_errors(self):
        os_mock = Mock()
        os_mock.scandir.side_effect = PermissionError("proc denied")
        with self.assertRaisesRegex(RuntimeError, "cannot enumerate private process namespace"):
            self._extract_native_processes_live(os_mock)()

        os_mock = Mock()
        os_mock.scandir.return_value = [SimpleNamespace(name="101", path="/proc/101")]
        os_mock.readlink.side_effect = PermissionError("exe denied")
        with self.assertRaisesRegex(RuntimeError, "cannot inspect private process namespace"):
            self._extract_native_processes_live(os_mock)()


if __name__ == "__main__":
    unittest.main()
