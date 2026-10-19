"""Focused source-only regressions for the native failed-admission stop draft."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


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


class NativeFailedStopTests(unittest.TestCase):
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

    def test_probe_uses_canonical_receipt_and_scans_both_lease_roots(self):
        script = stop._native_failure_probe_script()
        self.assertIn(stop.CANONICAL_PROCESS_RECEIPT, script)
        self.assertIn("runtime_service.process_receipt_path(paths)", script)
        self.assertIn("resource_leases", script)
        self.assertIn("preparation_resource_leases", script)
        self.assertIn("OWNER.json", script)


if __name__ == "__main__":
    unittest.main()
