"""Lightweight contract checks for failed-worker reconciliation.

These tests exercise only bounded request/receipt validation and command
construction.  They never contact Docker, compile Rust, or mutate a control
volume.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_failed_worker_reconciliation as reconciliation  # noqa: E402


def _args(**overrides: object) -> argparse.Namespace:
    values = {
        "attempt": "a" * 32,
        "iteration_attempt": "d" * 32,
        "config_sha256": "b" * 64,
        "source_root": Path("/worktree/fullmag"),
        "port": 3197,
        "pending_activation": "c" * 32,
        "run_id": "run-live-1",
        "task_id": "task-1",
        "exit_receipt_id": "receipt-1",
        "apply": False,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def _records() -> dict[str, object]:
    return {
        "request_id": "9d4aa4cc-4e4b-5d9a-8c52-b48bdfd98e11",
        "config_sha256": "a" * 64,
        "owner_sha256": "b" * 64,
        "expected_owner": {
            "schema_version": "runtime_service_owner.v1",
            "state": "failed",
            "target_id": "docker-all",
            "owner_token": "owner-token",
        },
        "catalog_sha256": "c" * 64,
        "lease_sha256": "d" * 64,
        "receipt_sha256": "e" * 64,
        "catalog_revision": 7,
        "expected_task": {
            "task_id": "task-1",
            "input_fingerprint": "1" * 64,
            "lifecycle": "failed",
            "readiness": "ready",
            "observation": {"state": "failed"},
            "attempt_id": "attempt-1",
            "ownership_epoch": 1,
            "resolved_input_fingerprint": "2" * 64,
            "artifact_ids": [],
            "resource_id": "cpu-1",
            "coordinator_watermark": None,
            "coordinator_genesis": None,
        },
        "expected_lease": {
            "schema_version": "resource_lease.v1",
            "resource_id": "cpu-1",
            "kind": "cpu",
            "budget": {
                "cpu_millis": 100,
                "memory_bytes": 1,
                "gpu_memory_bytes": 0,
                "storage_bytes": 1,
            },
            "run_id": "run-live-1",
            "task_id": "task-1",
            "attempt_id": "attempt-1",
            "ownership_epoch": 1,
            "lease_token": "lease-1",
            "state": "active",
            "acquired_at": "2026-01-01T00:00:00Z",
            "heartbeat_at": "2026-01-01T00:00:01Z",
            "heartbeat_sequence": 2,
            "released_at": None,
            "host_launch_binding": None,
        },
        "expected_receipt": {
            "schema_version": "worker_process_exit_receipt.v1",
            "receipt_id": "receipt-1",
            "run_id": "run-live-1",
            "task_id": "task-1",
            "attempt_id": "attempt-1",
            "ownership_epoch": 1,
            "resource_id": "cpu-1",
            "lease_token": "lease-1",
            "lease_heartbeat_sequence": 2,
            "process_id": 44,
            "process_start_token": "start-1",
            "status_success": False,
            "exit_code": 1,
            "timed_out": False,
            "stop_requested": False,
            "failure_reason": "worker failed",
            "observed_at": "2026-01-01T00:00:02Z",
        },
        "expected_reservation": {
            "identity": {
                "store_id": "sha256:" + "3" * 64,
                "run_id": "run-live-1",
                "task_id": "task-1",
                "resource_id": "cpu-1",
                "owner": {
                    "kind": "solver",
                    "attempt_id": "attempt-1",
                    "ownership_epoch": 1,
                },
                "lease_token": "lease-1",
            },
            "request_sha256": "4" * 64,
            "host_id": "host-1",
            "policy_revision": 2,
            "host_owner_epoch": 3,
            "runtime_generation_sha256": "5" * 64,
            "compute_node_owner_id": "node-1",
            "compute_node_owner_epoch": 4,
            "topology_sha256": "6" * 64,
            "budget": {
                "cpu_millis": 100,
                "memory_bytes": 1,
                "gpu_memory_bytes": 0,
                "storage_bytes": 1,
            },
            "exclusive_gpu_uuids": [],
            "gpu_vram_bytes_by_uuid": {},
            "cpu_ids": [],
            "release_proof_sha256": None,
            "state": "quarantined",
            "worker_launch_gate": {"state": "consumed", "token": "gate-1"},
            "preparation_launch_gate": None,
            "preparation_launch_owner": None,
            "node_policy_revision": 2,
            "scheduling_priority": 0,
            "parallelism": "single_process",
        },
    }


class FailedWorkerReconciliationContractTests(unittest.TestCase):
    def test_control_reads_use_the_actual_control_document_budget(self) -> None:
        from docker_build_control import MAX_DOCUMENT_BYTES, control_read_script

        def bounded_read(_control, relative, *, optional=False, maximum):
            control_read_script("/control/" + relative, maximum)
            self.assertEqual(maximum, MAX_DOCUMENT_BYTES)
            return b"{}"

        with patch("docker_volume_unclaimed_cancellation._control_raw", side_effect=bounded_read):
            self.assertEqual(reconciliation._control_raw(object(), "terminal.json"), b"{}")

    def test_candidate_execution_checks_actual_bytes_and_uses_verified_descriptor(self) -> None:
        import hashlib
        import os
        import tempfile
        import types

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "package"
            (root / "bin").mkdir(parents=True)
            binary = root / "bin/fullmag-runtime-service"
            binary.write_bytes(b"verified native executable")
            binary.chmod(0o755)
            original = binary.read_bytes()
            receipt = {"artifacts": [{"path": "bin/fullmag-runtime-service", "size": len(original),
                                      "sha256": hashlib.sha256(original).hexdigest()}]}
            receipt_raw = reconciliation._canonical_json(receipt)
            fake_backend = types.ModuleType("backend_dev")
            fake_backend._validated_package = lambda *_args: (receipt, receipt_raw, {})
            argv = ["probe", str(root), reconciliation._sha256(receipt_raw), str(binary), "--reconcile-failed-worker-exit"]
            def execute(fd, command, environment):
                self.assertIsInstance(fd, int)
                self.assertEqual(os.fstat(fd).st_ino, binary.stat().st_ino)
                self.assertEqual(command[0], str(binary))
            with patch.dict(sys.modules, {"backend_dev": fake_backend}), patch.object(sys, "argv", argv), \
                 patch("os.execve", side_effect=execute) as execve:
                exec(reconciliation.VALIDATE_AND_EXEC_CANDIDATE_SCRIPT, {})
                self.assertEqual(execve.call_count, 1)
                binary.write_bytes(b"modified native executable")
                with self.assertRaisesRegex(RuntimeError, "metadata|bytes"):
                    exec(reconciliation.VALIDATE_AND_EXEC_CANDIDATE_SCRIPT, {})
                self.assertEqual(execve.call_count, 1)
                binary.write_bytes(original)
                alias = root / "alias"
                os.link(binary, alias)
                with self.assertRaisesRegex(RuntimeError, "metadata"):
                    exec(reconciliation.VALIDATE_AND_EXEC_CANDIDATE_SCRIPT, {})
                self.assertEqual(execve.call_count, 1)

    def test_native_request_is_exactly_the_five_native_pins(self) -> None:
        request = reconciliation.build_native_request(_records())
        self.assertEqual(
            set(request),
            {
                "schema_version",
                "request_id",
                "config_sha256",
                "owner_sha256",
                "expected_owner",
                "expected_catalog_sha256",
                "expected_lease_sha256",
                "expected_receipt_sha256",
                "reconciliation",
            },
        )
        self.assertEqual(
            set(request["reconciliation"]),
            {
                "expected_catalog_revision",
                "expected_task",
                "expected_lease",
                "expected_receipt",
                "expected_reservation",
            },
        )
        self.assertEqual(request["reconciliation"]["expected_catalog_revision"], 7)
        self.assertEqual(request["reconciliation"]["expected_task"]["task_id"], "task-1")

    def test_request_scope_rejects_task_or_receipt_identity_drift(self) -> None:
        records = _records()
        records["expected_receipt"] = {
            **records["expected_receipt"],
            "task_id": "other-task",
        }
        with self.assertRaisesRegex(reconciliation.ReconciliationError, "receipt task"):
            reconciliation.build_native_request(records)

    def test_request_rejects_non_failed_owner_or_non_ready_task(self) -> None:
        records = _records()
        records["expected_owner"] = {
            **records["expected_owner"],
            "state": "unknown",
        }
        with self.assertRaisesRegex(reconciliation.ReconciliationError, "Failed owner"):
            reconciliation.build_native_request(records)
        records = _records()
        records["expected_task"] = {
            **records["expected_task"],
            "readiness": {"state": "blocked"},
        }
        with self.assertRaisesRegex(reconciliation.ReconciliationError, "ready task"):
            reconciliation.build_native_request(records)

    def test_candidate_receipt_must_bind_every_captured_source_pin(self) -> None:
        probe = {
            "resolved_commit": "a" * 40,
            "source_digest": "b" * 64,
            "source_snapshot_sha256": "c" * 64,
            "live_manifest_sha256": "d" * 64,
        }
        receipt = {
            "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            "state": "succeeded",
            "source": {
                "resolved_commit": probe["resolved_commit"],
                "source_digest": probe["source_digest"],
                "source_snapshot_sha256": probe["source_snapshot_sha256"],
                "live_manifest_sha256": probe["live_manifest_sha256"],
            },
            "artifacts": [{"path": "bin/fullmag-runtime-service", "sha256": "e" * 64}],
        }
        self.assertEqual(
            reconciliation.validate_candidate_receipt(receipt, probe)["state"],
            "succeeded",
        )
        receipt["source"]["source_digest"] = "f" * 64
        with self.assertRaisesRegex(reconciliation.ReconciliationError, "source pin"):
            reconciliation.validate_candidate_receipt(receipt, probe)

        receipt["source"]["source_digest"] = probe["source_digest"]
        receipt["artifacts"].append({"path": "bin/fullmag-runtime-service", "sha256": "e" * 64})
        with self.assertRaisesRegex(reconciliation.ReconciliationError, "one runtime-service"):
            reconciliation.validate_candidate_receipt(receipt, probe)

    def test_native_result_rejects_wrong_scope_and_unknown_shape(self) -> None:
        valid = {
            "schema_version": reconciliation.NATIVE_RESULT_SCHEMA,
            "request_id": _records()["request_id"],
            "request_sha256": "a" * 64,
            "disposition": "released",
            "run_id": "run-live-1",
            "task_id": "task-1",
            "lease_token": "lease-1",
            "receipt_id": "receipt-1",
            "release_proof_sha256": "f" * 64,
            "task_lifecycle": "failed",
            "solver_replayed": False,
            "artifacts_requalified": False,
        }
        self.assertEqual(
            reconciliation.validate_native_result(valid, "a" * 64, "run-live-1", "task-1", "lease-1", "receipt-1")["disposition"],
            "released",
        )
        with self.assertRaisesRegex(reconciliation.ReconciliationError, "scope"):
            reconciliation.validate_native_result(valid, "a" * 64, "run-live-1", "other-task", "lease-1", "receipt-1")

    def test_native_command_is_one_shot_and_never_starts_api(self) -> None:
        command = reconciliation.native_command(
            "/build/maintenance/request/package/bin/fullmag-runtime-service",
            "/opt/fullmag/runtime-control/runtime-service/docker-all.json",
            "/opt/fullmag/control/activation/attempts/" + "c" * 32 + "/failed-worker-reconciliation/request.json",
            apply=False,
        )
        self.assertEqual(command[:3], ["/build/maintenance/request/package/bin/fullmag-runtime-service", "--reconcile-failed-worker-exit", "--config"])
        self.assertNotIn("fullmag-api", " ".join(command))
        self.assertNotIn("--apply", command)

    def test_prepare_and_apply_are_mutually_exclusive_and_cli_is_bounded(self) -> None:
        request_id = _records()["request_id"]
        parsed = reconciliation._parser().parse_args([
            "--repo-root", "/worktree",
            "--attempt", "a" * 32,
            "--iteration-attempt", "d" * 32,
            "--config-sha256", "b" * 64,
            "--source-root", "/worktree/fullmag",
            "--port", "3197",
            "--pending-activation", "c" * 32,
            "--run-id", "run-live-1",
            "--task-id", "task-1",
            "--exit-receipt-id", "receipt-1",
            "--request-id", request_id,
            "--prepare-candidate",
        ])
        self.assertTrue(parsed.prepare_candidate)
        self.assertFalse(parsed.apply)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            reconciliation._parser().parse_args([
                "--repo-root", "/worktree",
                "--attempt", "a" * 32,
                "--iteration-attempt", "d" * 32,
                "--config-sha256", "b" * 64,
                "--source-root", "/worktree/fullmag",
                "--port", "3197",
                "--pending-activation", "c" * 32,
                "--run-id", "run-live-1",
                "--task-id", "task-1",
                "--exit-receipt-id", "receipt-1",
                "--request-id", request_id,
                "--prepare-candidate", "--apply",
            ])

    def test_docker_dev_dispatch_parser_exposes_same_contract(self) -> None:
        import docker_dev

        args = docker_dev._parser().parse_args([
            "reconcile-failed-worker",
            "--attempt", "a" * 32,
            "--iteration-attempt", "d" * 32,
            "--config-sha256", "b" * 64,
            "--source-root", "/worktree/fullmag",
            "--port", "3197",
            "--pending-activation", "c" * 32,
            "--run-id", "run-live-1",
            "--task-id", "task-1",
            "--exit-receipt-id", "receipt-1",
            "--request-id", _records()["request_id"],
            "--apply",
        ])
        self.assertEqual(args.action, "reconcile-failed-worker")
        self.assertTrue(args.apply)
        self.assertFalse(args.prepare_candidate)

    def test_prepare_then_apply_uses_separate_immutable_phase_records(self) -> None:
        class FakeControl:
            project = "fullmag-master"
            volume = "build-control"

            def __init__(self) -> None:
                self.records: dict[str, bytes] = {}

        control = FakeControl()
        source_root = Path(__file__).resolve().parent
        request_id = _records()["request_id"]
        source = {
            "manifest_path": f"/build/maintenance/{request_id}/source-capture/.fullmag-live-source/manifest.json",
            "resolved_commit": "a" * 40,
            "source_digest": "b" * 64,
            "source_snapshot_sha256": "c" * 64,
            "live_manifest_sha256": "d" * 64,
        }
        candidate = {
            "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            "state": "succeeded",
            "source": {key: source[key] for key in (
                "resolved_commit", "source_digest", "source_snapshot_sha256", "live_manifest_sha256",
            )},
            "artifacts": [{"path": "bin/fullmag-runtime-service", "sha256": "e" * 64}],
        }
        candidate_raw = reconciliation._canonical_json(candidate)
        records = _records()
        context = {
            "selected": source_root,
            "control": control,
            "backend_id": "f" * 64,
            "image_id": "sha256:" + "1" * 64,
            "backend_started_at": "2026-01-01T00:00:00.000000000Z",
            "iteration_attempt": "d" * 32,
            "iteration_relative": "iteration/attempts/" + "d" * 32 + "/terminal.json",
            "iteration_sha256": "7" * 64,
            "original_backend_id": "f" * 64,
            "helper_id": "helper-1",
            "config_raw": b"runtime-config",
            "owner_raw": b"runtime-owner",
            "owner": records["expected_owner"],
        }
        native_calls: list[bool] = []

        def read_control(_control, relative, *, optional=False, maximum=0):
            del maximum
            value = control.records.get(relative)
            if value is None and not optional:
                raise reconciliation.ReconciliationError("missing " + relative)
            return value

        def publish(_control, relative, raw):
            previous = control.records.get(relative)
            if previous is not None and previous != raw:
                raise reconciliation.ReconciliationError("immutable overwrite " + relative)
            control.records[relative] = raw

        def invoke(_backend, _package, _config, request_path, *, apply, candidate_receipt_sha256):
            self.assertEqual(candidate_receipt_sha256, reconciliation._sha256(candidate_raw))
            native_calls.append(apply)
            request_raw = control.records[request_path.removeprefix("/opt/fullmag/control/")]
            request = reconciliation._read_json_bytes(request_raw, "request")
            lease = request["reconciliation"]["expected_lease"]
            receipt = request["reconciliation"]["expected_receipt"]
            result = {
                "schema_version": reconciliation.NATIVE_RESULT_SCHEMA,
                "request_id": request_id,
                "request_sha256": reconciliation._sha256(request_raw),
                "disposition": "released" if apply else "validated",
                "run_id": lease["run_id"],
                "task_id": lease["task_id"],
                "lease_token": lease["lease_token"],
                "receipt_id": receipt["receipt_id"],
                "release_proof_sha256": "9" * 64 if apply else None,
                "task_lifecycle": "failed",
                "solver_replayed": False,
                "artifacts_requalified": False,
            }
            return reconciliation._canonical_json(result), b""

        def args_for(*, prepare=False, apply=False):
            return _args(
                source_root=source_root,
                request_id=request_id,
                prepare_candidate=prepare,
                apply=apply,
            )

        with patch.object(reconciliation, "_load_context", return_value=context), \
             patch.object(reconciliation, "_recheck_context"), \
             patch.object(reconciliation, "_capture_source", return_value=(source, b"capture")), \
             patch.object(reconciliation, "_collect_expected_records", return_value=records), \
             patch.object(reconciliation, "_prepare_candidate", return_value=(
                 f"/build/maintenance/{request_id}/package", candidate, candidate_raw, b"build", b"",
             )), \
             patch.object(reconciliation, "_read_candidate_receipt", return_value=(candidate, candidate_raw)), \
             patch.object(reconciliation, "_invoke_native", side_effect=invoke), \
             patch.object(reconciliation, "_control_raw", side_effect=read_control), \
             patch.object(reconciliation, "_publish_immutable", side_effect=publish):
            prepared = reconciliation.run(args_for(prepare=True))
            applied = reconciliation.run(args_for(apply=True))
            self.assertEqual(reconciliation.run(args_for(apply=True)), applied)
            for key, value in (("run_id", "other-run"), ("task_id", "other-task"),
                               ("exit_receipt_id", "other-receipt"), ("iteration_attempt", "e" * 32)):
                changed = args_for(apply=True)
                setattr(changed, key, value)
                with self.subTest(key=key), self.assertRaises(reconciliation.ReconciliationError):
                    reconciliation.run(changed)

        operation_root = reconciliation._operation_root("c" * 32) + "/" + request_id
        self.assertEqual(prepared["state"], "candidate-prepared")
        self.assertEqual(applied["state"], "succeeded")
        self.assertEqual(native_calls, [False, True])
        self.assertIn(operation_root + "/prepare-receipt.json", control.records)
        self.assertIn(operation_root + "/terminal.json", control.records)
        self.assertNotIn(operation_root + "/receipt.json", control.records)


if __name__ == "__main__":
    unittest.main()
