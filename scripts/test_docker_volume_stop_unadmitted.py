"""Interpreted regressions for the pre-admission stop boundary.

This file deliberately does not invoke Docker, Compose, a solver, or Rust
compilation.  It tests the fail-closed source validators and the in-container
probe contract in memory.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path, PureWindowsPath
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_stop_unadmitted as stop


class StopUnadmittedTests(unittest.TestCase):
    def probe_lock(self, effects, ticks):
        function = next(node for node in ast.parse(stop._probe_script()).body
                        if isinstance(node, ast.FunctionDef) and node.name == 'lock_probe')
        path = Mock()
        path.is_file.return_value = True
        path.is_symlink.return_value = False
        flock = Mock(side_effect=effects)
        close = Mock()
        sleep = Mock()
        namespace = {
            'pathlib': SimpleNamespace(Path=lambda value: value),
            'os': SimpleNamespace(open=lambda *args: 7, close=close, O_RDWR=2),
            'fcntl': SimpleNamespace(flock=flock, LOCK_EX=2, LOCK_NB=4),
            'time': SimpleNamespace(monotonic=Mock(side_effect=ticks), sleep=sleep),
        }
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<production-lock-probe>', 'exec'), namespace)
        return namespace['lock_probe'], path, flock, close, sleep

    def test_probe_waits_boundedly_for_transient_writer(self):
        lock, path, flock, close, sleep = self.probe_lock([BlockingIOError(), None], [0, .1])
        self.assertEqual(lock(path, 'writer'), 7)
        self.assertEqual(flock.call_count, 2)
        sleep.assert_called_once_with(.05)
        close.assert_not_called()

    def test_probe_closes_descriptor_when_writer_stays_busy(self):
        lock, path, flock, close, sleep = self.probe_lock([BlockingIOError()], [0, 5])
        with self.assertRaisesRegex(RuntimeError, 'observation budget'):
            lock(path, 'writer')
        close.assert_called_once_with(7)
        sleep.assert_not_called()

    def test_control_read_preserves_guest_paths_on_windows_host(self):
        class Control:
            path = staticmethod(lambda relative: '/control/' + relative)
            helper_args = staticmethod(lambda script: [script])

        result = type('Result', (), {'returncode': 0, 'stdout': b'{}', 'stderr': b''})()
        with patch.object(stop, 'Path', PureWindowsPath), patch.object(
            stop, 'bounded_capture', return_value=result
        ) as capture:
            self.assertEqual(stop._control_bytes(Control(), 'development/attempts/a/terminal.json'), b'{}')
        command = capture.call_args.args[0][0]
        self.assertIn("/control/development/attempts/a/terminal.json", command)
        self.assertNotIn('\\', command)

    @staticmethod
    def args(**overrides):
        values = {
            "attempt": "a" * 32,
            "config_sha256": "b" * 64,
            "backend_container_id": "c" * 64,
            "frontend_container_id": "d" * 64,
            "image_id": "sha256:" + "e" * 64,
            "failure_marker_sha256": "f" * 64,
            "process_receipt_sha256": "0" * 64,
            "source_sha256": "1" * 64,
            "request_id": "docker-volume-" + "a" * 32,
            "session_id": "docker-startup-" + "2" * 32,
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def valid_probe(self, **overrides):
        args = self.args(**overrides)
        owner = {
            "owner_token": "owner-token",
            "process_start_token": "process-token",
            "pid": 123,
            "host": "fullmag-test-host",
            "target_id": "fullmag-runtime-service",
            "control_address": "127.0.0.1:43123",
            "build_commit": "a" * 40,
            "build_snapshot": "b" * 64,
            "compute_pool_id": "compute-pool",
            "preparation_pool_id": "preparation-pool",
            "compute_pool_generation": 7,
            "preparation_pool_generation": 8,
            "children": [
                {"role": "compute", "pid": 124},
                {"role": "preparation", "pid": 125},
            ],
        }
        marker = {
            "schema": "fullmag.docker-startup-activation-receipt.v1",
            "state": "rejected",
            "request_id": args.request_id,
            "source_sha256": args.source_sha256,
            "source_relative": "examples/scene.py",
            "authorization": {
                "request_id": args.request_id,
                "source_sha256": args.source_sha256,
                "container_source_root": "/opt/fullmag/source",
                "source_relative": "examples/scene.py",
            },
            "result": {
                "schema": "fullmag.startup-script-activation.v1",
                "state": "rejected",
                "request_id": args.request_id,
                "source_sha256": args.source_sha256,
                "source_relative": "examples/scene.py",
            },
        }
        receipt = {
            "schema": "fullmag.docker-process-tree.v1",
            "state": "ready",
            "service_owner": owner,
        }
        return args, {
            "schema": "fullmag.docker-unadmitted-stop-probe.v1",
            "request_id": args.request_id,
            "session_id": args.session_id,
            "source_sha256": args.source_sha256,
            "activation_marker_sha256": args.failure_marker_sha256,
            "process_receipt_sha256": args.process_receipt_sha256,
            "current_session": {
                "session_id": args.session_id,
                "status": "startup_failed",
                "script": {"sha256": args.source_sha256},
            },
            "current_run_status": 404,
            "compute_queue": {
                "schema_version": "compute_queue.v1",
                "items": [],
            },
            "runtime_service": {
                "configured": True,
                "state": "ready",
                "reason": {"code": "service_ready"},
            },
            "accepted_store": {"run_records": []},
            "host_ledger": {"reservation_states": []},
            "activation_marker": marker,
            "process_receipt": receipt,
        }

    def test_probe_contract_accepts_empty_store_released_ledger_and_no_run(self):
        args, probe = self.valid_probe()
        stop._validate_probe_document(probe, args)

    def test_probe_contract_rejects_any_run_record(self):
        args, probe = self.valid_probe()
        probe["accepted_store"] = {"run_records": ["runs/run-1/run_intent.json"]}
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_probe_document(probe, args)

    def test_probe_contract_rejects_nonterminal_reservation(self):
        args, probe = self.valid_probe()
        probe["host_ledger"] = {"reservation_states": ["committed"]}
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_probe_document(probe, args)

    def test_probe_contract_rejects_unknown_current_run(self):
        args, probe = self.valid_probe()
        probe["current_run_status"] = 200
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_probe_document(probe, args)

    def test_probe_contract_rejects_non_failed_session(self):
        args, probe = self.valid_probe()
        probe["current_session"]["status"] = "awaiting_command"
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_probe_document(probe, args)

    def test_probe_contract_rejects_nonempty_compute_queue(self):
        args, probe = self.valid_probe()
        probe["compute_queue"]["items"] = [{"item_id": "run/1"}]
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_probe_document(probe, args)

    def test_probe_contract_rejects_unready_runtime_service(self):
        args, probe = self.valid_probe()
        probe["runtime_service"]["state"] = "unknown"
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_probe_document(probe, args)

    def test_probe_contract_rejects_internal_activation_receipt(self):
        args, probe = self.valid_probe()
        probe["process_receipt"]["startup_activation"] = {"state": "rejected"}
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_probe_document(probe, args)

    def test_probe_contract_requires_ready_owner_children(self):
        args, probe = self.valid_probe()
        probe["process_receipt"]["service_owner"].pop("children")
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_probe_document(probe, args)

    def test_network_recheck_allows_stopped_frontend_endpoint_to_disappear(self):
        args, _ = self.valid_probe()
        backend_id = args.backend_container_id
        frontend_id = args.frontend_container_id
        actual = {
            "backend": {
                "NetworkSettings": {"Networks": {"fullmag-net": {}}},
                "HostConfig": {"PortBindings": None, "NetworkMode": ""},
            },
            "frontend": {"NetworkSettings": {"Networks": {}}},
        }
        network = {
            "Driver": "bridge",
            "Labels": {"com.docker.compose.project": "fullmag-master"},
            "Containers": {backend_id: {}},
        }
        result = type("Result", (), {"stdout": json.dumps([network]).encode()})()
        with patch.object(stop, "_assert_private_restart_network"), patch.object(
            stop, "docker_capture", return_value=result
        ):
            stop._validate_network(
                actual,
                {"backend": backend_id, "frontend": frontend_id},
                "fullmag-master",
                allow_stopped_frontend=True,
            )

    def test_probe_contract_rejects_started_activation_marker(self):
        args, probe = self.valid_probe()
        probe["activation_marker"] = {"state": "started"}
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_probe_document(probe, args)

    def test_source_mount_must_be_readonly_and_selected(self):
        source = Path("/checkout").resolve()
        actual = {"Mounts": [{"Destination": "/opt/fullmag/source", "Type": "bind",
                              "RW": False, "Source": str(source)}]}
        stop._validate_source_bind(actual, source)
        actual["Mounts"][0]["RW"] = True
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_source_bind(actual, source)

    def test_source_mount_uses_exact_pinned_daemon_path_without_client_fallback(self):
        source = Path("/home/fullmag")
        daemon = "/run/desktop/mnt/host/wsl/checkout-token"
        actual = {"Mounts": [{"Destination": "/opt/fullmag/source", "Type": "bind",
                              "RW": False, "Source": daemon}]}
        pins = {"/opt/fullmag/source": daemon}
        stop._validate_source_bind(actual, source, pins)
        for changed in (daemon + "-other", str(source)):
            with self.subTest(changed=changed):
                actual["Mounts"][0]["Source"] = changed
                with self.assertRaises(stop.StopUnadmittedError):
                    stop._validate_source_bind(actual, source, pins)
        for invalid in ({}, {"/opt/fullmag/source": ""}, "invalid-pins"):
            with self.subTest(pins=invalid), self.assertRaises(stop.StopUnadmittedError):
                stop._validate_source_bind(actual, source, invalid)

    def test_runtime_validation_helper_uses_host_adapter_and_preserves_isolation(self):
        backend = {"Image": "sha256:" + "a" * 64}
        control = SimpleNamespace(project="fullmag-master")
        with patch.object(stop, "_runtime_control_volume_mount", return_value=("owned-volume", "runtime-control")), \
                patch.object(stop, "docker_argv", return_value=["docker", "run"]) as adapter:
            args = stop._runtime_control_validation_helper(backend, control)
        adapter.assert_called_once_with("run")
        self.assertEqual(args[:2], ["docker", "run"])
        self.assertNotIn("desktop-linux", args)
        self.assertIn("--read-only", args)
        self.assertIn("com.docker.compose.project=fullmag-master", args)
        self.assertIn("type=volume,src=owned-volume,dst=/opt/fullmag/runtime-control,readonly,volume-subpath=runtime-control,volume-nocopy", args)

    def test_runtime_process_receipt_uses_image_default_when_override_is_absent(self):
        stop._validate_runtime_process_receipt_override({})
        stop._validate_runtime_process_receipt_override({
            "FULLMAG_RUNTIME_PROCESS_RECEIPT": stop.CANONICAL_RUNTIME_PROCESS_RECEIPT,
        })
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_runtime_process_receipt_override({
                "FULLMAG_RUNTIME_PROCESS_RECEIPT": "/tmp/process-tree.json",
            })

    def test_frontend_stop_requires_zero_exit_code(self):
        stop._validate_frontend_stopped({"State": {"Running": False, "ExitCode": 0}})
        with self.assertRaises(stop.StopUnadmittedError):
            stop._validate_frontend_stopped({"State": {"Running": False, "ExitCode": 137}})

    def test_runtime_control_mount_requires_the_compose_subpath(self):
        backend = {
            "Mounts": [{
                "Destination": "/opt/fullmag/runtime-control",
                "Type": "volume",
                "Name": "fullmag-build-control-test",
                "RW": True,
            }],
            "HostConfig": {"Mounts": [{
                "Target": "/opt/fullmag/runtime-control",
                "Type": "volume",
                "Source": "fullmag-build-control-test",
                "ReadOnly": False,
                "VolumeOptions": {"Subpath": "runtime-control"},
            }]},
        }
        result = type("Result", (), {"stdout": json.dumps([{
            "Name": "fullmag-build-control-test",
            "Driver": "local",
            "Options": {},
            "Labels": {"com.fullmag.compose.project": "fullmag-master"},
        }]).encode()})()
        with patch.object(stop, "docker_capture", return_value=result):
            self.assertEqual(
                stop._runtime_control_volume_mount(backend, "fullmag-master"),
                ("fullmag-build-control-test", "runtime-control"),
            )
        backend["HostConfig"]["Mounts"][0]["VolumeOptions"] = {"Subpath": ""}
        with patch.object(stop, "docker_capture", return_value=result), self.assertRaises(
            stop.StopUnadmittedError
        ):
            stop._runtime_control_volume_mount(backend, "fullmag-master")

    def test_retained_attempt_pins_config_source_and_image(self):
        args = self.args()
        selected = Path("/checkout").resolve()
        compose = {"services": {"backend": {}, "frontend": {}}}
        args.config_sha256 = hashlib.sha256(stop.canonical(compose)).hexdigest()
        terminal = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "failed-confirmed",
            "compose_project": "fullmag-master",
            "attempt": args.attempt,
            "config_sha256": args.config_sha256,
            "inputs": {"source_root": str(selected), "image_id": args.image_id},
            "state_root": str(selected / "runtime"),
        }
        control = type("Control", (), {"project": "fullmag-master"})()
        with patch.object(stop.storage, "resolve_layout", return_value={"runtime_root": str(selected)}), \
             patch.object(stop.storage, "validate_path"):
            result = stop._validate_attempt_identity(args, selected, control, terminal, compose)
        self.assertEqual(result["inputs"]["image_id"], args.image_id)

    def test_succeeded_development_attempt_is_allowed_with_separate_rejection_marker(self):
        args = self.args()
        selected = Path("/checkout").resolve()
        compose = {"services": {"backend": {}, "frontend": {}}}
        args.config_sha256 = hashlib.sha256(stop.canonical(compose)).hexdigest()
        terminal = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "succeeded",
            "compose_project": "fullmag-master",
            "attempt": args.attempt,
            "config_sha256": args.config_sha256,
            "inputs": {"source_root": str(selected), "image_id": args.image_id},
            "state_root": str(selected / "runtime"),
        }
        control = type("Control", (), {"project": "fullmag-master"})()
        with patch.object(stop.storage, "resolve_layout", return_value={"runtime_root": str(selected)}), \
             patch.object(stop.storage, "validate_path"):
            result = stop._validate_attempt_identity(args, selected, control, terminal, compose)
        self.assertEqual(result["inputs"]["source_root"], str(selected))

    def test_probe_source_contains_bounded_admission_guards(self):
        source = stop._probe_script()
        compile(source, "backend-pre-admission-probe", "exec")
        for marker in ("run_intent.json", "run_catalog.json", "WRITER.lock",
                       "simulation/runs/current", "platform/compute/queue",
                       "platform/runtime-service", "startup_failed",
                       "compute_queue.v1", "service_ready", "startup_activation",
                       "_validate_terminal_owner", "state!='released'",
                       "/opt/fullmag/control/backend/script-activation-"):
            self.assertIn(marker, source)
        self.assertNotIn("HOST_INVENTORY_OWNER.lock", source)
        self.assertIn('control.operation("stop-unadmitted"', Path(stop.__file__).read_text())
        self.assertNotIn('active = _control_bytes(control, "active"', source)


if __name__ == "__main__":
    unittest.main()
