"""Focused source regressions for native failed-stop recreation."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
from subprocess import CompletedProcess
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_dev as dev
import docker_volume_activation_reconcile as reconcile
import docker_volume_stop_failed as stop_failed
import docker_volume_stop_unadmitted as stop_unadmitted


BACKEND_ID = "b" * 64
IMAGE_ID = "sha256:" + "a" * 64


def failed_owner(*, compute_status: str = "exited_success") -> dict[str, object]:
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
        "acquired_at": "2026-10-19T10:00:00Z",
        "heartbeat_at": "2026-10-19T10:00:01Z",
        "build_commit": "a" * 40,
        "build_snapshot": "b" * 64,
        "compute_pool_id": "compute-pool",
        "preparation_pool_id": "preparation-pool",
        "compute_pool_generation": 7,
        "preparation_pool_generation": 8,
        "children": [
            {"role": "compute", "pid": 3250, "status": compute_status},
            {"role": "preparation", "pid": 3251, "status": "exited_success"},
        ],
    }


def ready_owner() -> dict[str, object]:
    value = failed_owner()
    value["state"] = "ready"
    value["children"] = [
        {**child, "status": "running"} for child in value["children"]
    ]
    return value


def native_probe() -> dict[str, object]:
    owner = failed_owner()
    owner_raw = json.dumps(owner, sort_keys=True).encode()
    receipt = {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "failed_outcome_retained",
        "api_pid": 3227,
        "api_exit_code": -15,
        "error": "runtime CLI failed: native service exited during startup",
    }
    return {
        "schema": stop_failed.NATIVE_FAILURE_PROBE_SCHEMA,
        "process_receipt_sha256": "d" * 64,
        "process_receipt": receipt,
        "failed_owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
        "failed_owner": owner,
        "api_pid_exists": False,
        "native_processes_live": False,
        "startup_enabled": None,
        "legacy_activation_marker_exists": False,
        "reservation_states": ["released"],
        "lease_states": ["released"],
        "active_lease_count": 0,
    }


def after_ready_native_probe() -> dict[str, object]:
    ready = ready_owner()
    owner = failed_owner(compute_status="exited_failure")
    owner_raw = json.dumps(owner, sort_keys=True).encode()
    receipt = {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "failed_outcome_retained",
        "api_pid": 3227,
        "api_exit_code": -15,
        "error": "runtime service owner observation failed during supervision",
        "service_owner": ready,
    }
    return {
        "schema": stop_failed.NATIVE_AFTER_READY_FAILURE_PROBE_SCHEMA,
        "process_receipt_sha256": "d" * 64,
        "process_receipt": receipt,
        "failed_owner_sha256": hashlib.sha256(owner_raw).hexdigest(),
        "failed_owner": owner,
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


def terminal_receipt() -> dict[str, object]:
    return {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "shutdown_unknown",
        "api_exit_code": -15,
        "runtime_pid": None,
    }


class NativeFailedRecreateTests(unittest.TestCase):
    def setUp(self):
        self.control = Mock()
        self.control.project = "fullmag-worktree-test"
        self.control.volume = "fullmag-worktree-test-control"
        self.control.identity = {
            "project_name": self.control.project,
            "project_id": "fullmag-project",
            "worktree_id": "test",
            "checkout_kind": "worktree",
        }
        self.control.read.side_effect = self.read_control
        self.namespace_raw = None
        self.terminal = terminal_receipt()
        self.owner = failed_owner()
        self.terminal_raw = json.dumps(self.terminal, sort_keys=True).encode()
        self.owner_raw = json.dumps(self.owner, sort_keys=True).encode()
        self.journal = {
            "schema": "fullmag.stop-failed-admission.v1",
            "state": "stopped-confirmed",
            "failure_kind": "native-start-failure",
            "container_id": BACKEND_ID,
            "image_id": IMAGE_ID,
            "exit_code": 1,
            "failure_receipt": {
                "sha256": "d" * 64,
                "receipt": native_probe()["process_receipt"],
            },
            "native_failure_probe": native_probe(),
            "terminal_process_receipt": self.terminal,
            "terminal_failed_owner": self.owner,
            "terminal_failed_owner_sha256": hashlib.sha256(self.owner_raw).hexdigest(),
            "container_state": self.container_state(),
        }
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        self.inspect_patch = patch.object(
            reconcile, "docker_capture", return_value=self.stopped_backend_inspect()
        )
        self.inspect_patch.start()
        self.addCleanup(self.inspect_patch.stop)

    @staticmethod
    def container_state() -> dict[str, object]:
        return {
            "id": BACKEND_ID,
            "image": IMAGE_ID,
            "started_at": "2026-10-19T10:00:00.000000000Z",
            "finished_at": "2026-10-19T10:00:10.000000000Z",
            "exit_code": 1,
        }

    def stopped_backend_inspect(self) -> CompletedProcess:
        state = self.container_state()
        document = {
            "Id": BACKEND_ID,
            "Image": IMAGE_ID,
            "State": {
                "Running": False,
                "Status": "exited",
                "StartedAt": state["started_at"],
                "FinishedAt": state["finished_at"],
                "ExitCode": state["exit_code"],
            },
            "Config": {
                "Labels": {
                    "com.docker.compose.project": self.control.project,
                    "com.docker.compose.service": "backend",
                    "org.fullmag.source.project-id": "fullmag-project",
                    "org.fullmag.source.worktree-id": "test",
                    "org.fullmag.source.checkout-kind": "worktree",
                    "org.fullmag.compose.project": self.control.project,
                }
            },
        }
        return CompletedProcess(
            ["docker", "inspect"], 0,
            json.dumps([document]).encode(), b"",
        )

    def read_control(self, relative, *, optional=False):
        if relative == "verification/stop-failed-" + BACKEND_ID + ".json":
            return self.journal
        raise AssertionError(relative)

    def control_bytes(self, _control, relative, *, optional=False):
        if relative == "verification/stop-failed-" + BACKEND_ID + ".json":
            return self.journal_raw
        if relative == "verification/stopped-namespace-attestation-" + BACKEND_ID + ".json":
            return self.namespace_raw
        if relative.endswith("process-tree.json"):
            return self.terminal_raw
        if relative.endswith("OWNER.json"):
            return self.owner_raw
        raise AssertionError(relative)

    def previous(self):
        return {"inputs": {"image_id": IMAGE_ID, "source_root": "C:/git/fullmag"}}

    def configure_after_ready_journal(self):
        probe = after_ready_native_probe()
        ready = probe["process_receipt"]["service_owner"]
        self.terminal = {**terminal_receipt(), "service_owner": ready}
        self.owner = probe["failed_owner"]
        self.terminal_raw = json.dumps(self.terminal, sort_keys=True).encode()
        self.owner_raw = json.dumps(self.owner, sort_keys=True).encode()
        self.journal = {
            "schema": "fullmag.stop-failed-admission.v1",
            "state": "stopped-confirmed",
            "failure_kind": "native-after-ready-failure",
            "container_id": BACKEND_ID,
            "image_id": IMAGE_ID,
            "exit_code": 1,
            "failure_receipt": {
                "sha256": "d" * 64,
                "receipt": probe["process_receipt"],
            },
            "native_failure_probe": probe,
            "retained_ready_owner": ready,
            "terminal_process_receipt": self.terminal,
            "terminal_retained_ready_owner": ready,
            "terminal_failed_owner": self.owner,
            "terminal_failed_owner_sha256": hashlib.sha256(self.owner_raw).hexdigest(),
            "container_state": self.container_state(),
        }
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()

    def make_namespace_attestation(self) -> None:
        probe = self.journal["native_failure_probe"]
        attestation = {
            "schema": reconcile.NAMESPACE_ATTESTATION_SCHEMA,
            "state": "stopped-confirmed",
            "compose_project": self.control.project,
            "control_volume": self.control.volume,
            "backend_container": BACKEND_ID,
            "image_id": IMAGE_ID,
            "source_root": "C:/git/fullmag",
            "container_state": self.container_state(),
            "stop_journal_path": "verification/stop-failed-" + BACKEND_ID + ".json",
            "stop_journal_sha256": hashlib.sha256(self.journal_raw).hexdigest(),
            "terminal_process_receipt_path": "runtime-control/runtime-service/process-tree.json",
            "terminal_process_receipt_sha256": hashlib.sha256(self.terminal_raw).hexdigest(),
            "terminal_process_receipt": self.terminal,
            "terminal_failed_owner_path": "runtime-control/runtime-services/OWNER.json",
            "terminal_failed_owner_sha256": hashlib.sha256(self.owner_raw).hexdigest(),
            "terminal_failed_owner": self.owner,
            "failure_kind": self.journal["failure_kind"],
            "native_failure_probe_sha256": hashlib.sha256(
                reconcile.canonical(probe) + b"\n"
            ).hexdigest(),
            "native_failure_probe": probe,
            "created_at": 1_729_000_000.0,
        }
        if self.journal["failure_kind"] == "native-after-ready-failure":
            attestation["retained_ready_owner"] = self.journal["retained_ready_owner"]
        self.namespace_raw = reconcile.canonical(attestation) + b"\n"

    def test_native_stop_journal_pins_owner_and_current_config(self):
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            context = dev._native_failed_stop_recovery_context(
                self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
            )
        self.assertEqual(context["previous_config_sha256"], "c" * 64)
        self.assertNotIn("recovery_metadata", context)
        self.assertNotIn("recovery_environment", context)
        self.assertFalse(context["native_restart_metadata"]["claim_pending"])
        self.assertEqual(
            context["native_restart_metadata"]["terminal_failed_owner_sha256"],
            hashlib.sha256(self.owner_raw).hexdigest(),
        )

    def test_native_stop_refuses_changed_failed_owner(self):
        altered = dict(self.owner)
        altered["heartbeat_at"] = "2026-10-19T10:00:02Z"
        self.owner_raw = json.dumps(altered, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            with self.assertRaisesRegex(dev.BuildControlError, "failed owner changed"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
                )

    def test_native_stop_refuses_changed_runtime_configuration(self):
        self.journal["previous_config_sha256"] = "d" * 64
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            with self.assertRaisesRegex(dev.BuildControlError, "configuration digest differs"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
                )

    def test_legacy_stop_journal_requires_fresh_namespace_attestation(self):
        self.journal.pop("container_state")
        self.journal.pop("terminal_failed_owner_sha256")
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            with self.assertRaisesRegex(dev.BuildControlError, "fresh namespace attestation"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
                )

    def test_inline_stop_journal_uses_probe_owner_digest(self):
        self.journal.pop("terminal_failed_owner_sha256")
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            context = dev._native_failed_stop_recovery_context(
                self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
            )
        self.assertEqual(
            context["native_restart_metadata"]["terminal_failed_owner_sha256"],
            hashlib.sha256(self.owner_raw).hexdigest(),
        )

    def test_legacy_stop_journal_accepts_matching_fresh_namespace_attestation(self):
        self.journal.pop("container_state")
        self.journal.pop("terminal_failed_owner_sha256")
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        self.make_namespace_attestation()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            context = dev._native_failed_stop_recovery_context(
                self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
            )
        self.assertEqual(
            context["native_restart_metadata"]["namespace_attestation_sha256"],
            hashlib.sha256(self.namespace_raw).hexdigest(),
        )

    def test_fresh_state_does_not_consume_native_stop_proof(self):
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes):
            with self.assertRaisesRegex(dev.BuildControlError, "retained session storage"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=True
                )

    def test_after_ready_stop_journal_consumes_identity_pinned_proof(self):
        self.configure_after_ready_journal()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            context = dev._native_failed_stop_recovery_context(
                self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
            )
        metadata = context["native_restart_metadata"]
        self.assertEqual(metadata["failure_kind"], "native-after-ready-failure")
        self.assertEqual(metadata["retained_ready_owner"], ready_owner())
        self.assertFalse(metadata["claim_pending"])

    def test_after_ready_stop_requires_terminal_ready_owner_pin(self):
        self.configure_after_ready_journal()
        self.terminal.pop("service_owner")
        self.terminal_raw = json.dumps(self.terminal, sort_keys=True).encode()
        self.journal["terminal_process_receipt"] = self.terminal
        self.journal_raw = json.dumps(self.journal, sort_keys=True).encode()
        with patch.object(stop_unadmitted, "_control_bytes", side_effect=self.control_bytes), \
                patch.object(dev, "_read_runtime_config_digest", return_value="c" * 64):
            with self.assertRaisesRegex(dev.BuildControlError, "terminal ready owner differs"):
                dev._native_failed_stop_recovery_context(
                    self.control, self.previous(), backend_id=BACKEND_ID, fresh_state=False
                )


if __name__ == "__main__":
    unittest.main()
