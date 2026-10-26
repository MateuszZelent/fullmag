"""Regression checks for the managed idle-backend stop boundary.

The fixture models an admitted, healthy backend/frontend pair and authentic
process-drain evidence.  It never starts Docker or compiles an application.
"""
from __future__ import annotations

from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import docker_build_control
import docker_backend_volume_cache
import docker_dev
import docker_volume_dev as dev


PROJECT = "fullmag-master"
SOURCE = Path(__file__).resolve().parents[1]
ATTEMPT = "a" * 32
IMAGE = "sha256:" + "b" * 64
BACKEND_ID = "c" * 64
FRONTEND_ID = "d" * 64


class _Operation:
    def __init__(self, events):
        self.events = events
        self.value = {
            "root": "development/attempts/" + ATTEMPT + "/iteration",
            "receipt": {"attempt": ATTEMPT},
        }

    def __enter__(self):
        self.events.append(("enter", None))
        return self.value

    def __exit__(self, exception_type, exception, traceback):
        self.events.append(("exit", dict(self.value["receipt"])))
        return False


class IdleStopFixture:
    def __init__(self):
        self.events = []
        self.frontend_stopped = False
        self.backend_stopped = False
        self.args = SimpleNamespace(
            repo_root=SOURCE,
            source_root=SOURCE,
            attempt=ATTEMPT,
            config_sha256="0" * 64,
        )
        self.identity = {
            "project_name": PROJECT,
            "network_name": "fullmag-master_fullmag",
            "project_id": "fullmag-test",
            "worktree_id": "master",
            "checkout_kind": "main-checkout",
        }
        self.environment = {
            "FULLMAG_SESSION_STORAGE_PROFILE": "linux-native-v1",
            "FULLMAG_HOST_LEDGER_MOUNT_ROOT": "/ledger",
            "FULLMAG_HOST_LEDGER_PROJECT_ID": "fullmag-test",
            "FULLMAG_HOST_LEDGER_BACKING_IMAGE": "/ledger.ext4",
        }
        self.document = {
            "name": PROJECT,
            "services": {
                "backend": {"environment": self.environment},
                "frontend": {},
            },
        }
        self.previous = {
            "state": "succeeded",
            "compose_project": PROJECT,
            "inputs": {"source_root": str(SOURCE), "image_id": IMAGE},
            "state_root": "/state/fullmag",
            "backend_volumes": ["fullmag-backend-cache"],
            "frontend_volume": "fullmag-frontend-cache",
            "backend_container": BACKEND_ID,
            "frontend_container": FRONTEND_ID,
        }
        # A group that never quarantined its control namespace records "".
        self.control = Mock(
            project=PROJECT, volume="fullmag-control-master", identity=self.identity, namespace="",
        )
        self.control.read.side_effect = self.read
        self.control.write.side_effect = self.write
        self.control.operation.side_effect = lambda *args, **kwargs: _Operation(self.events)

    def read(self, relative, optional=False):
        self.events.append(("read", relative))
        values = {
            f"development/attempts/{ATTEMPT}/terminal.json": self.previous,
            f"development/attempts/{ATTEMPT}/compose.json": self.document,
            f"development/attempts/{ATTEMPT}/backend-cache.json": {},
            f"development/attempts/{ATTEMPT}/host-ledger.json": {},
            f"development/attempts/{ATTEMPT}/ledger-maintenance-compose.json": {},
        }
        if relative in values:
            return values[relative]
        if optional:
            return None
        raise AssertionError(f"unexpected control read: {relative}")

    def write(self, relative, value):
        self.events.append(("write", relative))

    def actual(self, service):
        identifier = BACKEND_ID if service == "backend" else FRONTEND_ID
        running = not (self.backend_stopped if service == "backend" else self.frontend_stopped)
        state = {
            "Running": running,
            "Health": {"Status": "healthy"},
            "StartedAt": "2026-10-20T10:00:00Z",
            "OOMKilled": False,
            "ExitCode": 0,
        }
        return {
            "Id": identifier,
            "Image": IMAGE,
            "Config": {
                "Labels": {
                    "com.docker.compose.project": PROJECT,
                    "com.docker.compose.service": service,
                    "org.fullmag.source.worktree-id": "master",
                },
            },
            "State": state,
            "Mounts": [{
                "Destination": "/opt/fullmag/runtime-control",
                "Type": "volume",
                "Name": "fullmag-control-master",
                "RW": True,
            }],
            "HostConfig": {"Mounts": [{
                "Target": "/opt/fullmag/runtime-control",
                "Type": "volume",
                "Source": "fullmag-control-master",
                "ReadOnly": False,
                "VolumeOptions": {"Subpath": "runtime-control"},
            }]},
        }

    def stopped_backend(self):
        value = self.actual("backend")
        value["State"].update(Running=False, OOMKilled=False, ExitCode=0)
        return value

    def compose(self, document, *args, **kwargs):
        service = args[-1]
        return (BACKEND_ID if service == "backend" else FRONTEND_ID).encode() + b"\n"

    def text(self, *args, **kwargs):
        if args[:2] == ("image", "inspect"):
            return json.dumps([{"Config": {}}])
        if args[:1] == ("inspect",):
            identifier = args[1]
            if identifier == BACKEND_ID and self.backend_stopped:
                return json.dumps([self.stopped_backend()])
            service = "backend" if identifier == BACKEND_ID else "frontend"
            return json.dumps([self.actual(service)])
        if args[:1] == ("exec",):
            return json.dumps({"status": "ok", "active_session": False})
        raise AssertionError(f"unexpected docker text: {args}")

    def capture(self, *args, **kwargs):
        self.events.append((args[0], args[1:]))
        if args[0] == "stop":
            identifier = args[3]
            if identifier == FRONTEND_ID:
                self.frontend_stopped = True
            elif identifier == BACKEND_ID:
                self.backend_stopped = True
            return SimpleNamespace(stdout=b"", stderr=b"", returncode=0)
        if args[0] == "start":
            raise AssertionError("idle stop must never start a service")
        raise AssertionError(f"unexpected docker capture: {args}")

    def stop_capture(self, *args, **kwargs):
        if args[:2] == ("volume", "inspect") and args[2] == "fullmag-control-master":
            self.events.append(("volume-inspect", args[2]))
            return SimpleNamespace(stdout=json.dumps([{
                "Name": "fullmag-control-master",
                "Driver": "local",
                "Options": {},
                "Labels": {"com.fullmag.compose.project": PROJECT},
            }]).encode())
        raise AssertionError(f"unexpected terminal-receipt preflight capture: {args}")


class DockerVolumeIdleStopTests(unittest.TestCase):
    def _patches(self, fixture, drain):
        import docker_volume_stop_unadmitted as stop
        import docker_volume_cancelled_activation_guard as cancelled_guard

        fixture.control.read.side_effect = fixture.read
        finish = patch.object(dev, "_finish")
        patchers = (
            # This test covers the idle-stop boundary with no cancelled
            # activation recovery record. The control-volume helper read is
            # represented as an authenticated optional absence.
            patch.object(cancelled_guard, "_read_control_bytes", return_value=None),
            patch.object(dev, "require_host"),
            patch.object(docker_dev, "_select_source", return_value=(SOURCE, {"runtime_root": Path("/state")})),
            patch.object(docker_dev, "_compose_identity", return_value=fixture.identity),
            patch.object(docker_build_control, "toolchain_configuration", return_value={
                "services": {"fem-gpu-toolchain": {"build": {"args": {
                    "FULLMAG_CUDA_BASE_IMAGE": "sha256:" + "f" * 64,
                }}}}
            }),
            patch.object(dev, "BuildControl", return_value=fixture.control),
            patch.object(dev, "compose_capture", side_effect=fixture.compose),
            patch.object(dev, "docker_text", side_effect=fixture.text),
            patch.object(dev, "docker_capture", side_effect=fixture.capture),
            patch.object(dev, "storage", SimpleNamespace(validate_path=lambda *args: Path("/state/fullmag"))),
            patch.object(dev, "_operator_probe_record_from_retained", return_value={}),
            patch.object(dev, "_validate_retained_service"),
            patch.object(dev, "_certificate_path", return_value=Path("/state/fullmag/certificate.json")),
            patch.object(dev, "_retained_certificate", return_value={"restart_verified": True}),
            patch.object(dev, "_retained_startup_enabled", return_value=False),
            patch.object(dev, "_read_cancelled_activation_bytes", return_value=None),
            patch.object(docker_backend_volume_cache, "validate_container"),
            patch.object(dev, "_assert_private_restart_network"),
            patch.object(stop, "docker_capture", side_effect=fixture.stop_capture),
            patch.object(
                stop,
                "_read_terminal_process_receipt",
                side_effect=drain if isinstance(drain, BaseException) else None,
                return_value=None if isinstance(drain, BaseException) else drain,
            ),
            patch.object(dev, "recreate"),
            finish,
        )
        return patchers

    def test_verified_drain_returns_stopped_without_start_or_finish(self):
        fixture = IdleStopFixture()
        digest = hashlib.sha256(dev.canonical(fixture.document)).hexdigest()
        fixture.args.config_sha256 = digest
        drain = (b'{"state":"stopped"}\n', {"state": "stopped"})
        patches = self._patches(fixture, drain)
        with ExitStack() as stack:
            entered = [stack.enter_context(patcher) for patcher in patches]
            result = dev.stop_idle(fixture.args)
        finish = entered[-1]
        recreate = entered[-2]
        self.assertIsNone(result)
        self.assertTrue(fixture.control.operation.called)
        drain_index = fixture.events.index(("write", "development/attempts/" + ATTEMPT + "/iteration/backend-drain.json"))
        exit_index = next(index for index, event in enumerate(fixture.events) if event[0] == "exit")
        self.assertLess(drain_index, exit_index)
        receipt = next(event[1] for event in fixture.events if event[0] == "exit")
        self.assertTrue(receipt["idle_backend_stopped"])
        self.assertEqual(receipt["state"], "succeeded")
        self.assertFalse(any(event[0] == "start" for event in fixture.events))
        recreate.assert_not_called()
        finish.assert_not_called()

    def test_unknown_drain_fails_closed_without_start_or_finish(self):
        fixture = IdleStopFixture()
        digest = hashlib.sha256(dev.canonical(fixture.document)).hexdigest()
        fixture.args.config_sha256 = digest
        patches = self._patches(
            fixture, docker_build_control.BuildControlError("process drain receipt is unknown")
        )
        with self.assertRaisesRegex(dev.BuildControlError, "drain receipt is unknown"):
            with ExitStack() as stack:
                entered = [stack.enter_context(patcher) for patcher in patches]
                dev.stop_idle(fixture.args)
        finish = entered[-1]
        recreate = entered[-2]
        self.assertFalse(any(event[0] == "start" for event in fixture.events))
        recreate.assert_not_called()
        finish.assert_not_called()

    def test_terminal_receipt_preflight_runs_before_lease_and_any_stop(self):
        fixture = IdleStopFixture()
        fixture.args.config_sha256 = hashlib.sha256(dev.canonical(fixture.document)).hexdigest()
        patches = self._patches(fixture, (b'{"state":"stopped"}\n', {"state": "stopped"}))
        with ExitStack() as stack:
            for patcher in patches:
                stack.enter_context(patcher)
            dev.stop_idle(fixture.args)
        inspect_index = fixture.events.index(("volume-inspect", "fullmag-control-master"))
        enter_index = fixture.events.index(("enter", None))
        first_stop = next(index for index, event in enumerate(fixture.events) if event[0] == "stop")
        self.assertLess(inspect_index, enter_index)
        self.assertLess(enter_index, first_stop)

    def test_invalid_runtime_control_namespace_fails_before_lease_or_stop(self):
        fixture = IdleStopFixture()
        fixture.args.config_sha256 = hashlib.sha256(dev.canonical(fixture.document)).hexdigest()
        fixture.control.namespace = "namespaces/not-a-token"
        patches = self._patches(fixture, (b'{"state":"stopped"}\n', {"state": "stopped"}))
        import docker_volume_stop_unadmitted as stop
        with self.assertRaisesRegex(stop.StopUnadmittedError, "namespace is invalid"):
            with ExitStack() as stack:
                for patcher in patches:
                    stack.enter_context(patcher)
                dev.stop_idle(fixture.args)
        self.assertFalse(fixture.control.operation.called)
        self.assertFalse(any(event[0] in {"stop", "start", "enter"} for event in fixture.events))
        self.assertFalse(fixture.frontend_stopped or fixture.backend_stopped)


if __name__ == "__main__":
    unittest.main()
