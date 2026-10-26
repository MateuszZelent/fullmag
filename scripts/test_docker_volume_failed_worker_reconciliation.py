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
    def setUp(self) -> None:
        from contextlib import nullcontext
        live_lock = type("LiveLock", (), {"poll": lambda self: None})()
        lock_patcher = patch.object(reconciliation, "_maintenance_lock", side_effect=lambda *_: nullcontext(live_lock))
        self.child_lock = lock_patcher.start()
        self.addCleanup(lock_patcher.stop)

    def test_recheck_capture_uses_a_separate_manifest(self) -> None:
        request_id = _records()["request_id"]
        manifest = {
            "manifest_path": f"/build/maintenance/{request_id}/source-verification/.fullmag-live-source/manifest.json",
            "source_mode": "live-shadow-v1",
            "resolved_commit": "a" * 40,
            "source_digest": "b" * 64,
            "source_snapshot_sha256": "c" * 64,
            "live_manifest_sha256": "d" * 64,
        }
        with patch.object(reconciliation, "_exec", return_value=(
            reconciliation._canonical_json(manifest), b"",
        )) as execute:
            observed, _ = reconciliation._capture_source("f" * 64, request_id, verification=True)
        self.assertEqual(observed, manifest)
        self.assertEqual(execute.call_args.args[1][-2:], (request_id, "verification"))

    def test_embedded_capture_preserves_original_file_on_rechecks(self) -> None:
        import json
        import tempfile
        import types
        from contextlib import redirect_stdout

        request_id = _records()["request_id"]
        captures = []
        producer = types.ModuleType("backend_source")

        def capture(_source, _git, build_root):
            captures.append(build_root)
            path = build_root / ".fullmag-live-source/manifest.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            # Model the real producer's distinct identity for each capture.
            path.write_text(json.dumps({"capture_id": str(len(captures))}))
            return path

        producer.capture_live_source_manifest = capture
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # Redirect only the Docker volume root; execute the actual path logic.
            marker = 'Path("/build/maintenance")'
            self.assertEqual(reconciliation.SOURCE_CAPTURE_SCRIPT.count(marker), 1)
            script = reconciliation.SOURCE_CAPTURE_SCRIPT.replace(marker, f"Path({directory!r})")
            original = root / request_id / "source-capture/.fullmag-live-source/manifest.json"
            with patch.dict(sys.modules, {"backend_source": producer}), \
                 patch.object(sys, "path", sys.path.copy()):
                original_raw = None
                for purpose in ("prepare", "verification", "verification"):
                    output = io.StringIO()
                    with patch.object(sys, "argv", ["capture", request_id, purpose]), redirect_stdout(output):
                        exec(script, {})
                    expected_directory = "source-capture" if purpose == "prepare" else "source-verification"
                    self.assertEqual(captures[-1], root / request_id / expected_directory)
                    self.assertEqual(Path(json.loads(output.getvalue())["manifest_path"]),
                                     captures[-1] / ".fullmag-live-source/manifest.json")
                    if purpose == "prepare":
                        original_raw = original.read_bytes()
                    else:
                        self.assertEqual(original.read_bytes(), original_raw)
                        self.assertNotEqual((captures[-1] / ".fullmag-live-source/manifest.json").read_bytes(), original_raw)

    def test_child_lock_is_rechecked_after_long_running_work(self) -> None:
        class Lock:
            stopped = False
            def poll(self):
                return 1 if self.stopped else None
        lock = Lock()
        context = {"maintenance_lock_process":lock}
        reconciliation._assert_child_lock_alive(context)
        lock.stopped = True
        with self.assertRaisesRegex(reconciliation.ReconciliationError, "child lock exited"):
            reconciliation._assert_child_lock_alive(context)

    def test_dead_child_lock_prevents_any_operation(self) -> None:
        from contextlib import nullcontext
        control = type("Control", (), {"project":"project", "volume":"control"})()
        context = {"control":control, "backend_id":"f" * 64}
        args = _args(source_root=Path(__file__).resolve().parent,
                     request_id=_records()["request_id"], prepare_candidate=True)
        dead_lock = type("DeadLock", (), {"poll":lambda self: 1})()
        self.child_lock.side_effect = lambda *_: nullcontext(dead_lock)
        with patch.object(reconciliation, "_load_context", return_value=context), \
             patch.object(reconciliation, "_capture_source") as capture, \
             patch.object(reconciliation, "_invoke_native") as native:
            with self.assertRaisesRegex(reconciliation.ReconciliationError, "child lock is not alive"):
                reconciliation.run(args)
            capture.assert_not_called()
            native.assert_not_called()

    def test_source_failure_records_phase_and_fences_retry(self) -> None:
        import json
        from docker_dev_codegen import CodegenError

        class Control:
            project = "project"
            volume = "control"
            records: dict[str, bytes] = {}

        control = Control()
        context = {"control": control, "backend_id": "f" * 64}
        args = _args(source_root=Path(__file__).resolve().parent,
                     request_id=_records()["request_id"], prepare_candidate=True)
        def read(_control, relative, *, optional=False, maximum=0):
            del maximum
            value = control.records.get(relative)
            if value is None and not optional:
                raise reconciliation.ReconciliationError("missing " + relative)
            return value
        def publish(_control, relative, raw):
            if relative in control.records and control.records[relative] != raw:
                raise reconciliation.ReconciliationError("immutable mismatch")
            control.records[relative] = raw
        def failed_capture(*_args, **_kwargs):
            try:
                raise CodegenError("client timed out", reconciliation_required=True)
            except CodegenError as error:
                raise reconciliation.ReconciliationError("capture observation timed out") from error
        with patch.object(reconciliation, "_load_context", return_value=context), \
             patch.object(reconciliation, "_recheck_context"), \
             patch.object(reconciliation, "_control_raw", side_effect=read), \
             patch.object(reconciliation, "_publish_immutable", side_effect=publish), \
             patch.object(reconciliation, "_capture_source", side_effect=failed_capture) as capture:
            with self.assertRaisesRegex(reconciliation.ReconciliationError, "capture observation"):
                reconciliation.run(args)
            root = reconciliation._operation_root(args.pending_activation) + "/" + args.request_id
            failure = json.loads(control.records[root + "/pre-native-failure.json"])
            self.assertEqual(failure["phase"], "source-capture")
            self.assertFalse(failure["native_invoked"])
            self.assertTrue(failure["daemon_operation_may_remain"])
            with self.assertRaisesRegex(reconciliation.ReconciliationError, "failed before native"):
                reconciliation.run(args)
            self.assertEqual(capture.call_count, 1)
            self.child_lock.assert_called_with(control, args.pending_activation)

    def test_apply_requires_prepared_candidate_before_capture_or_build(self) -> None:
        control = type("Control", (), {"project":"project", "volume":"control"})()
        context = {"control":control, "backend_id":"f" * 64}
        args = _args(source_root=Path(__file__).resolve().parent,
                     request_id=_records()["request_id"], apply=True, prepare_candidate=False)
        with patch.object(reconciliation, "_load_context", return_value=context), \
             patch.object(reconciliation, "_recheck_context"), \
             patch.object(reconciliation, "_existing_operation", return_value=(None, None, None, None)), \
             patch.object(reconciliation, "_capture_source") as capture, \
             patch.object(reconciliation, "_invoke_native") as native:
            with self.assertRaisesRegex(reconciliation.ReconciliationError, "requires.*prepared"):
                reconciliation.run(args)
            capture.assert_not_called()
            native.assert_not_called()

    def test_plain_preview_never_publishes_failure_receipt(self) -> None:
        control = type("Control", (), {"project":"project", "volume":"control"})()
        context = {"control":control, "backend_id":"f" * 64}
        args = _args(source_root=Path(__file__).resolve().parent,
                     request_id=_records()["request_id"], prepare_candidate=False)
        with patch.object(reconciliation, "_load_context", return_value=context), \
             patch.object(reconciliation, "_recheck_context"), \
             patch.object(reconciliation, "_existing_operation", return_value=(None, None, None, None)), \
             patch.object(reconciliation, "_capture_source", side_effect=reconciliation.ReconciliationError("capture failed")), \
             patch.object(reconciliation, "_publish_immutable") as publish:
            with self.assertRaisesRegex(reconciliation.ReconciliationError, "capture failed"):
                reconciliation.run(args)
            publish.assert_not_called()

    def test_collector_reads_receipt_scoped_lease_and_rejects_drift(self) -> None:
        import json
        import subprocess
        import tempfile

        records = _records()
        task = records["expected_task"]
        lease = records["expected_lease"]
        exit_receipt = records["expected_receipt"]
        reservation = records["expected_reservation"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "session-store"
            run = root / "runs" / lease["run_id"]
            receipt_path = run / "worker_process_exit_receipts" / (exit_receipt["receipt_id"] + ".json")
            lease_path = run / "resource_leases" / lease["resource_id"] / (lease["lease_token"] + ".json")
            ledger_path = Path(directory) / "HOST_RESOURCE_LEDGER.json"
            receipt_path.parent.mkdir(parents=True)
            lease_path.parent.mkdir(parents=True)
            def put(path, value):
                path.write_text(json.dumps(value), encoding="utf-8")
            put(run / "run_catalog.json", {"schema_version":"run_catalog.v1", "run_id":lease["run_id"],
                "revision":records["catalog_revision"], "tasks":[task]})
            put(receipt_path, exit_receipt)
            put(lease_path, lease)
            put(ledger_path, {"schema_version":"host_resource_ledger.v4", "reservations":[reservation]})
            script = reconciliation.COLLECT_EXPECTED_SCRIPT.replace(
                'pathlib.Path("/state/runs/docker-all/session-store")', f'pathlib.Path({str(root)!r})'
            ).replace('pathlib.Path("/host-ledger/ledger/HOST_RESOURCE_LEDGER.json")',
                      f'pathlib.Path({str(ledger_path)!r})')
            command = [sys.executable, "-B", "-c", script, lease["run_id"], task["task_id"], exit_receipt["receipt_id"]]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["expected_lease"]["lease_token"], lease["lease_token"])
            exit_receipt["lease_heartbeat_sequence"] += 1
            put(receipt_path, exit_receipt)
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("exact resource lease differs", result.stderr)

    def test_control_reads_use_the_actual_control_document_budget(self) -> None:
        from docker_build_control import MAX_DOCUMENT_BYTES, control_read_script

        def bounded_read(_control, relative, *, optional=False, maximum):
            control_read_script("/control/" + relative, maximum)
            self.assertEqual(maximum, MAX_DOCUMENT_BYTES)
            return b"{}"

        with patch("docker_volume_unclaimed_cancellation._control_raw", side_effect=bounded_read):
            self.assertEqual(reconciliation._control_raw(object(), "terminal.json"), b"{}")

    def test_existing_package_gate_rejects_unattested_files(self) -> None:
        import tempfile
        backend_scripts = Path(__file__).resolve().parents[1] / "docker/all-in-one"
        sys.path.insert(0, str(backend_scripts))
        try:
            from backend_dev import BackendBuildError, _assert_direct_candidate_inventory
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "bin").mkdir()
                (root / "bin/fullmag-runtime-service").write_bytes(b"binary")
                (root / "backend-build-receipt.json").write_bytes(b"{}")
                artifacts = [{"path":"bin/fullmag-runtime-service"}]
                _assert_direct_candidate_inventory(root, artifacts, include_receipt=True)
                (root / "bin/unexpected.so").write_bytes(b"unexpected")
                with self.assertRaisesRegex(BackendBuildError, "unrecognized file inventory"):
                    _assert_direct_candidate_inventory(root, artifacts, include_receipt=True)
        finally:
            sys.path.remove(str(backend_scripts))

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
            fake_backend._assert_direct_candidate_inventory = lambda *_args, **_kwargs: None
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

    def test_native_invoke_binds_candidate_receipt_to_exact_request_directory(self) -> None:
        root = "/opt/fullmag/control/activation/attempts/" + "c" * 32 + "/failed-worker-reconciliation/request"
        digest = "a" * 64
        with patch.object(reconciliation, "_exec", return_value=(b"{}", b"")) as execute:
            reconciliation._invoke_native(
                "f" * 64, "/build/maintenance/request/package", "/control/config.json",
                root + "/request.json", apply=False, candidate_receipt_sha256=digest,
                candidate_receipt_path=root + "/candidate-receipt.json",
            )
            command = execute.call_args.args[1]
            self.assertIn(reconciliation.VALIDATE_AND_EXEC_CANDIDATE_SCRIPT, command)
            self.assertEqual(command[-4:], ("--candidate-receipt", root + "/candidate-receipt.json",
                                            "--candidate-receipt-sha256", digest))
            with self.assertRaisesRegex(reconciliation.ReconciliationError, "immutable request scope"):
                reconciliation._invoke_native(
                    "f" * 64, "/build/maintenance/request/package", "/control/config.json",
                    root + "/request.json", apply=False, candidate_receipt_sha256=digest,
                    candidate_receipt_path="/control/other/candidate-receipt.json",
                )
            self.assertEqual(execute.call_count, 1)

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
        verification_source = dict(
            source,
            manifest_path=f"/build/maintenance/{request_id}/source-verification/.fullmag-live-source/manifest.json",
            # Each producer capture includes a new UUID and timestamp.
            live_manifest_sha256="f" * 64,
        )
        original_capture = [reconciliation._canonical_json({
            "schema": "fullmag.docker-backend-live-source.v1",
            **{key: source[key] for key in (
                "resolved_commit", "source_digest", "source_snapshot_sha256", "live_manifest_sha256",
            )},
        })]
        candidate = {
            "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            "state": "succeeded",
            "source": {key: source[key] for key in (
                "resolved_commit", "source_digest", "source_snapshot_sha256", "live_manifest_sha256",
            )},
            "artifacts": [{"path": "bin/fullmag-runtime-service", "sha256": "e" * 64}],
        }
        candidate["source"]["manifest_sha256"] = reconciliation._sha256(original_capture[0])
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

        def invoke(_backend, _package, _config, request_path, *, apply, candidate_receipt_sha256, candidate_receipt_path):
            self.assertEqual(candidate_receipt_sha256, reconciliation._sha256(candidate_raw))
            self.assertEqual(candidate_receipt_path, str(Path(request_path).parent) + "/candidate-receipt.json")
            if apply:
                relative = str(Path(request_path.removeprefix("/opt/fullmag/control/")).parent)
                self.assertIn(relative + "/apply-start.json", control.records)
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
             patch.object(reconciliation, "_capture_source", side_effect=lambda _backend, _id, *, verification=False: (
                 verification_source if verification else source, b"capture",
             )), \
             patch.object(reconciliation, "_collect_expected_records", return_value=records), \
             patch.object(reconciliation, "_prepare_candidate", return_value=(
                 f"/build/maintenance/{request_id}/package", candidate, candidate_raw, b"build", b"",
             )), \
             patch.object(reconciliation, "_read_candidate_receipt", return_value=(candidate, candidate_raw)), \
             patch.object(reconciliation, "_read_original_capture", side_effect=lambda *_: original_capture[0]), \
             patch.object(reconciliation, "_invoke_native", side_effect=invoke), \
             patch.object(reconciliation, "_control_raw", side_effect=read_control), \
             patch.object(reconciliation, "_publish_immutable", side_effect=publish):
            # A native preview cannot mutate the lease; its failure is distinct
            # from an apply whose outcome may be unknown.
            import json
            operation_root = reconciliation._operation_root("c" * 32) + "/" + request_id
            with patch.object(reconciliation, "_invoke_native", side_effect=reconciliation.ReconciliationError("preview failed")):
                with self.assertRaisesRegex(reconciliation.ReconciliationError, "preview failed"):
                    reconciliation.run(args_for(prepare=True))
            failed_preview = json.loads(control.records[operation_root + "/prepare-receipt.json"])
            self.assertEqual(failed_preview["state"], "failed-confirmed")
            self.assertEqual(failed_preview["phase"], "native-preview")
            self.assertTrue(failed_preview["native_invoked"])
            # Reset only the in-memory fixture to exercise a fresh preparation.
            control.records.clear()
            prepared = reconciliation.run(args_for(prepare=True))
            receipt_path = operation_root + "/prepare-receipt.json"
            saved_receipt = control.records[receipt_path]
            forged = dict(prepared)
            forged["native_result"] = dict(prepared["native_result"], disposition="released")
            control.records[receipt_path] = reconciliation._canonical_json(forged)
            with self.assertRaisesRegex(reconciliation.ReconciliationError, "no successful native preview"):
                reconciliation.run(args_for(apply=True))
            self.assertEqual(native_calls, [False])
            control.records[receipt_path] = saved_receipt
            for key, changed in (("resolved_commit", "1" * 40),
                                 ("source_digest", "2" * 64),
                                 ("source_snapshot_sha256", "3" * 64)):
                previous = verification_source[key]
                verification_source[key] = changed
                with self.subTest(source_drift=key), self.assertRaisesRegex(
                    reconciliation.ReconciliationError, "source capture differs"
                ):
                    reconciliation.run(args_for(apply=True))
                self.assertNotIn(operation_root + "/apply-start.json", control.records)
                self.assertEqual(native_calls, [False])
                verification_source[key] = previous
            saved_capture = original_capture[0]
            original_capture[0] += b" "
            with self.assertRaisesRegex(reconciliation.ReconciliationError, "preserved source capture differs"):
                reconciliation.run(args_for(apply=True))
            self.assertNotIn(operation_root + "/apply-start.json", control.records)
            self.assertEqual(native_calls, [False])
            original_capture[0] = saved_capture
            # A crash after durable applying intent but before a terminal result
            # leaves an unknown outcome; do not invoke native a second time.
            control.records[operation_root + "/apply-start.json"] = b'{}'
            with self.assertRaisesRegex(reconciliation.ReconciliationError, "previous apply"):
                reconciliation.run(args_for(apply=True))
            self.assertEqual(native_calls, [False])
            del control.records[operation_root + "/apply-start.json"]
            before_apply = dict(control.records)
            with patch.object(reconciliation, "_invoke_native", side_effect=reconciliation.ReconciliationError("apply observation lost")):
                with self.assertRaisesRegex(reconciliation.ReconciliationError, "apply observation lost"):
                    reconciliation.run(args_for(apply=True))
            unknown = json.loads(control.records[operation_root + "/terminal.json"])
            self.assertEqual(unknown["state"], "outcome-unknown-resources-retained")
            self.assertEqual(unknown["phase"], "native-apply")
            self.assertIn(operation_root + "/apply-start.json", control.records)
            # Restore only the in-memory fixture to exercise a separate success.
            control.records = before_apply
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
        self.assertIn(operation_root + "/apply-start.json", control.records)
        self.assertNotIn(operation_root + "/receipt.json", control.records)


if __name__ == "__main__":
    unittest.main()
