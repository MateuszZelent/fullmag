import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import docker_backend_volume_cache as volume_cache

spec = importlib.util.spec_from_file_location(
    "recover_docker_orphan", Path(__file__).with_name("recover_docker_orphan.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)

PROJECT = "fullmag-worktree-task-123"
REQUEST = "03741782-a58a-4faa-b65d-0217b65240f3"


def target():
    return {
        "Id": "a" * 64, "Image": "sha256:" + "b" * 64,
        "Config": {"User": "65532:65532", "Labels": {
            "com.docker.compose.project": PROJECT,
            "com.docker.compose.service": "backend"},
            "Env": ["FULLMAG_COMPOSE_PROJECT=" + PROJECT,
                    "FULLMAG_TOOLCHAIN_IMAGE_ID=sha256:" + "c" * 64,
                    "FULLMAG_BACKEND_CARGO_PROFILE=backend-dev",
                    "FULLMAG_STARTUP_SCRIPT=example.py", "SECRET=do-not-copy",
                    "NVIDIA_VISIBLE_DEVICES=all"]},
        "HostConfig": {"Privileged": False, "PidMode": "", "ReadonlyRootfs": True,
                       "DeviceRequests": [{"Capabilities": [["gpu"]], "Count": -1}]},
        "State": {"Status": "running", "Running": True, "Pid": 91,
                  "FinishedAt": "0001-01-01T00:00:00Z"},
        "Mounts": [{"Destination": destination, "Type": "bind",
                    "Source": "/existing" + destination, "RW": True}
                   for destination in ["/state", "/host-ledger", "/opt/fullmag/package",
                                       "/user-data", "/var/run/docker.sock"]]}


def v2_backend_cache(root: Path) -> dict[str, object]:
    """Build the host-published v2 descriptor used by recovery tests."""
    profile: dict[str, object] = {
        "schema": volume_cache.SCHEMA,
        "profile": volume_cache.PROFILE,
        "state": "ready",
        "project_id": "fullmag",
        "worktree_id": "worktree-test",
        "control_project": PROJECT,
        "cache_key": "c" * 64,
        "unit_key": "d" * 64,
        "owner_id": "e" * 64,
        "cargo_profile": "backend-dev",
        "runtime_image_id": "sha256:" + "a" * 64,
        "toolchain_image_id": "sha256:" + "b" * 64,
        "volume_names": {
            volume_cache.BUILD_VOLUME_ROLE: "fullmag-cache-build-test",
            volume_cache.PACKAGE_VOLUME_ROLE: "fullmag-cache-package-test",
            volume_cache.CONTROL_VOLUME_ROLE: "fullmag-cache-control-test",
        },
        "build_root": volume_cache.BUILD_TARGET,
        "mount_root": volume_cache.BUILD_TARGET,
        "package_root": volume_cache.PACKAGE_TARGET,
    }
    profile["environment"] = volume_cache._cache_environment(profile)
    profile["mounts"] = volume_cache.mount_specs(profile)
    documents: dict[str, dict[str, object]] = {}
    for role in volume_cache.VOLUME_ROLES:
        documents[role] = {
            "Name": profile["volume_names"][role],
            "Driver": "local",
            "Options": {},
            "Scope": "local",
            "Mountpoint": "/var/lib/docker/volumes/" + profile["volume_names"][role] + "/_data",
            "Labels": volume_cache.volume_labels(profile, role),
        }
    profile["volume_documents"] = documents
    markers: dict[str, dict[str, object]] = {}
    for role in volume_cache.VOLUME_ROLES:
        if role == volume_cache.CONTROL_VOLUME_ROLE:
            markers[role] = {
                "schema": "fullmag.docker-toolchain-control-owner.v1",
                "state": "owned",
                "role": role,
                "volume_name": profile["volume_names"][role],
                "mount": volume_cache.CONTROL_TARGET,
                "namespace": volume_cache.CONTROL_BACKEND_TARGET,
            }
        else:
            markers[role] = {
                "schema": volume_cache.OWNER_SCHEMA,
                "state": "owned",
                "unit_key": profile["unit_key"],
                "owner_id": profile["owner_id"],
                "role": role,
                "volume_name": profile["volume_names"][role],
                "uid": 65532,
                "gid": 65532,
            }
    maintenance = {
        "schema": volume_cache.MAINTENANCE_RECEIPT_SCHEMA,
        "profile": volume_cache.PROFILE,
        "state": "ready",
        "project_id": profile["project_id"],
        "cache_key": profile["cache_key"],
        "unit_key": profile["unit_key"],
        "owner_id": profile["owner_id"],
        "cargo_profile": profile["cargo_profile"],
        "runtime_image_id": profile["runtime_image_id"],
        "toolchain_image_id": profile["toolchain_image_id"],
        "volume_names": dict(profile["volume_names"]),
        "markers": markers,
        "probe": {
            "schema": volume_cache.PROBE_SCHEMA,
            "state": "passed",
            "owner_uid": 65532,
            "owner_gid": 65532,
            "volumes": {
                role: {
                    "regular_marker": True,
                    "writable": True,
                    "readonly_reopen": True,
                    "no_reparse": True,
                }
                for role in volume_cache.VOLUME_ROLES
            },
        },
    }
    profile["maintenance_receipt"] = maintenance
    receipt = {
        "schema": volume_cache.SCHEMA,
        "profile": volume_cache.PROFILE,
        "state": "ready",
        "project_id": profile["project_id"],
        "worktree_id": profile["worktree_id"],
        "cache_key": profile["cache_key"],
        "unit_key": profile["unit_key"],
        "owner_id": profile["owner_id"],
        "cargo_profile": profile["cargo_profile"],
        "runtime_image_id": profile["runtime_image_id"],
        "toolchain_image_id": profile["toolchain_image_id"],
        "volume_names": dict(profile["volume_names"]),
        "mounts": list(profile["mounts"]),
        "build_root": volume_cache.BUILD_TARGET,
        "package_root": volume_cache.PACKAGE_TARGET,
        "control_root": volume_cache.CONTROL_TARGET,
        "volume_documents": documents,
        "maintenance_receipt": maintenance,
    }
    receipt_path = root / "backend-volume-cache-receipt.json"
    receipt["host_receipt_path"] = str(receipt_path)
    profile["receipt"] = receipt
    receipt_path.write_bytes(json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode())
    profile["receipt_path"] = str(receipt_path)
    overlay_path = root / "compose.backend-cache-v2.json"
    overlay = volume_cache.overlay(profile)
    overlay_path.write_bytes(json.dumps(overlay, sort_keys=True, separators=(",", ":")).encode())
    profile["overlay"] = overlay
    profile["compose_overlay"] = str(overlay_path)
    profile["compose_overlay_sha256"] = hashlib.sha256(overlay_path.read_bytes()).hexdigest()
    maintenance_path = root / "compose.backend-cache-v2-maintenance.json"
    maintenance_overlay = volume_cache.maintenance_overlay(profile)
    maintenance_path.write_bytes(json.dumps(maintenance_overlay, sort_keys=True, separators=(",", ":")).encode())
    profile["maintenance_overlay"] = maintenance_overlay
    profile["maintenance_compose_overlay"] = str(maintenance_path)
    return profile


def mount_v2_cache(target_document: dict[str, object], cache: dict[str, object]) -> None:
    """Attach the exact build/package/control volumes to a backend fixture."""
    mounts = target_document["Mounts"]
    for destination, role in (
        (volume_cache.BUILD_TARGET, volume_cache.BUILD_VOLUME_ROLE),
        (volume_cache.PACKAGE_TARGET, volume_cache.PACKAGE_VOLUME_ROLE),
        (volume_cache.CONTROL_TARGET, volume_cache.CONTROL_VOLUME_ROLE),
    ):
        mount = next((item for item in mounts if item["Destination"] == destination), None)
        if mount is None:
            mount = {"Destination": destination, "RW": True}
            mounts.append(mount)
        mount.pop("Source", None)
        mount.update({
            "Type": "volume",
            "Name": cache["volume_names"][role],
            "RW": True,
        })


def package_probe_output():
    artifact = {"path": "bin/fullmag-runtime-service", "size": 1,
                "sha256": "c" * 64, "mode": "100755"}
    receipt = {"schema": "fullmag.direct-compose.backend-build-receipt.v1",
               "state": "succeeded", "execution_lanes": {
                   "fdm-cpu": {}, "fdm-gpu": {}, "fem-cpu": {}, "fem-gpu": {}},
               "artifacts": [artifact]}
    return json.dumps({"schema": "fullmag.docker.cached-package-probe.v1",
                       "package_root": "/opt/fullmag/package",
                       "receipt_path": "/opt/fullmag/package/backend-build-receipt.json",
                       "receipt_sha256": "d" * 64, "package_sha256": "e" * 64,
                       "read_only_mount": True, "state": "succeeded",
                       "receipt": receipt, "artifacts": [artifact]})


class FakeDocker:
    def __init__(self, document):
        self.before = copy.deepcopy(document)
        self.after = copy.deepcopy(document)
        self.after["State"] = {"Status": "exited", "Running": False, "Pid": 0,
                                "FinishedAt": "2026-10-17T20:00:00Z"}
        self.stopped = False
        self.calls = []
        self.stop_error = None
        self.maintenance_documents = {}
        self.volume_documents = {}

    def __call__(self, *args, timeout=60):
        self.calls.append(args)
        if args[:2] == ("volume", "inspect"):
            document = self.volume_documents.get(args[2])
            if document is None:
                raise OSError("volume is unavailable")
            return json.dumps([document])
        if args[:2] == ("info", "--format"):
            return "sha256:" + "f" * 64
        if args == ("ps", "--quiet", "--no-trunc"):
            return self.before["Id"] + "\n" if not self.stopped else ""
        if args[0] == "inspect":
            if len(args) > 1 and args[1] in self.maintenance_documents:
                return json.dumps([self.maintenance_documents[args[1]]])
            return json.dumps([self.after if self.stopped else self.before])
        if args[0] == "run":
            return json.dumps({"schema": "fullmag.orphan-recovery-loader-pin.v1",
                               "status": "ready", "stub_sha256": "1" * 64,
                               "gpu_devices": False})
        if args[0] == "stop":
            if self.stop_error:
                raise self.stop_error
            self.stopped = True
            return self.before["Id"]
        return ""


def fake_pure():
    def build_request(pins, engine, document):
        return {"schema_version": "host_worker_orphan_teardown_request.v1",
                "request_id": pins["request_id"], "run_id": "run-1",
                "task_id": "task-1", "resource_id": "resource-1",
                "containers": [{"container_id": document["Id"],
                                "image_id": document["Image"],
                                "config_sha256": "a" * 64,
                                "device_requests": document["HostConfig"]["DeviceRequests"]}]}

    def build_attestation(*args):
        return {"schema_version": "docker_namespace_teardown_attestation.v1",
                "request_sha256": "a" * 64}

    def digest(value):
        return "a" * 64

    def finalize(*args):
        return {"schema": "fullmag.docker.orphan-recovery-receipt.v2",
                "protocol_version": 2, "outcome": "await_reconciliation",
                "run_id": "run-1", "task_id": "task-1", "container_id": "a" * 64,
                "history_immutable": True, "solve_replayed": False}

    def write(path, value):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        if path.exists() and path.read_bytes() != raw:
            raise ValueError("immutable record changed")
        path.write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    return build_request, build_attestation, digest, finalize, write


def fake_validators():
    def validate_request(request):
        return dict(request)

    def validate_attestation(request, attestation):
        return dict(attestation)

    return validate_request, validate_attestation


def recovery_pins():
    return {"request_id": REQUEST, "cached_package": {
        "root": "/existing/opt/fullmag/package",
        "receipt_path": "/existing/opt/fullmag/package/backend-build-receipt.json",
        "receipt_sha256": "d" * 64, "package_sha256": "e" * 64,
        "read_only": True, "state": "succeeded",
        "schema": "fullmag.direct-compose.backend-build-receipt.v1"},
        "device_release": {"resource_id": "resource-1", "mapping_sha256": "2" * 64}}


class RecoveryRunnerTests(unittest.TestCase):
    def _maintenance_phase(self, target_document, phase, command, preflight, docker=None):
        service = recovery.maintenance_compose(
            target_document, PROJECT, REQUEST, command, preflight=preflight
        )["services"]["backend-recovery"]
        container_id = hashlib.sha256(phase.encode("utf-8")).hexdigest()
        inspect = {
            "Id": container_id, "Image": target_document["Image"],
            "Config": {"User": service.get("user", ""), "Labels": {
                "com.docker.compose.project": PROJECT,
                "com.docker.compose.service": "backend-recovery",
                "fullmag.recovery.request_id": REQUEST,
                "fullmag.recovery.target_container": target_document["Id"],
            }},
            "HostConfig": {"Runtime": "runc", "Tmpfs": {
                "/tmp": "rw,nosuid,nodev,size=64m"},
                "PidMode": "", "NetworkMode": "none", "IpcMode": "private",
                "ReadonlyRootfs": True, "Privileged": False,
                "DeviceRequests": [], "Devices": [], "CapAdd": [],
                "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"]},
            "Mounts": [{
                "Type": "bind", "Source": item["source"], "Destination": item["target"],
                "RW": not item["read_only"],
            } for item in service["volumes"]],
            "State": {"Status": "exited", "Running": False, "Pid": 0,
                      "ExitCode": 0},
        }
        if docker is not None:
            docker.maintenance_documents[container_id] = inspect
        return {"container_id": container_id, "inspect": inspect}

    def _runner(self, events, *, fail_phase=None, docker=None):
        def run(target_document, name, command, preflight, phase):
            events.append((phase, preflight, tuple(command)))
            if phase == fail_phase:
                raise recovery.RecoveryAborted(f"fixture failure at {phase}")
            terminal = self._maintenance_phase(
                target_document, phase, command, preflight, docker=docker)
            if phase == "package-probe":
                return {"output": package_probe_output(), **terminal}
            if phase == "sdk-loader-probe":
                result = {"schema": "fullmag.orphan-recovery-loader-pin.v1",
                          "status": "ready", "stub_sha256": "1" * 64,
                          "gpu_devices": False}
                return {"result": result, "output": json.dumps(result), **terminal}
            if phase == "loader-probe":
                return {"result": {"status": "ready"}, "output": "", **terminal}
            if phase == "prepare":
                return {"result": {"schema_version": "runtime_service_orphan_teardown_result.v1",
                                    "status": "prepared", "request_sha256": "a" * 64,
                                    "started": False, "solve_replayed": False,
                                    "startup_replayed": False}, "output": "", **terminal}
            if phase in {"complete", "complete-replay"}:
                return {"result": {"schema_version": "runtime_service_orphan_teardown_result.v1",
                                    "status": "completed", "request_sha256": "a" * 64,
                                    "started": False, "solve_replayed": False,
                                    "startup_replayed": False}, "output": "", **terminal}
            raise AssertionError(phase)
        return run

    def _seed_stopped_replay(self, docker, state_root, *, complete=False, pins=None):
        pins = recovery_pins() if pins is None else pins
        request_dir = state_root / "diagnostics" / "orphan" / REQUEST
        request_dir.mkdir(parents=True)
        build_request = fake_pure()[0]
        request = build_request(pins, "sha256:" + "f" * 64, docker.after)
        (request_dir / "request.json").write_text(
            json.dumps(request, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        (request_dir / "pins-sha256.json").write_text(json.dumps({
            "schema": "fullmag.docker.orphan-pins-digest.v1",
            "sha256": recovery._pins_digest(pins, ""),
        }, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        manifest = {"after": recovery._manifest_observation(docker.after, stopped=True)}
        manifest_path = request_dir / "teardown-manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        manifest_sha = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        (request_dir / "attestation.json").write_text(json.dumps({
            "schema_version": "docker_namespace_teardown_attestation.v1",
            "request_sha256": "a" * 64, "manifest_sha256": manifest_sha,
            "device_release": {**pins["device_release"], "mapping_detached": True},
            "containers": [{
                "container_id": docker.after["Id"], "image_id": docker.after["Image"],
                "config_sha256": "a" * 64,
                "after": {"state": "exited", "pid": 0,
                           "finished_at": docker.after["State"]["FinishedAt"],
                           "descendant_count": 0,
                           "private_pid_namespace": True, "host_pid": False,
                           "device_requests_sha256": "a" * 64},
            }],
        }, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        (request_dir / "package-probe.json").write_text(
            json.dumps({"result": {}}, sort_keys=True), encoding="utf-8")
        (request_dir / "sdk-loader-probe.json").write_text(json.dumps({
            "result": {"status": "ready", "stub_sha256": "1" * 64}
        }, sort_keys=True), encoding="utf-8")
        (request_dir / "loader-probe.json").write_text(
            json.dumps({"result": {"status": "ready"}}, sort_keys=True), encoding="utf-8")
        if complete:
            terminal = self._maintenance_phase(
                docker.after, "complete-replay", [recovery.NATIVE_PROGRAM,
                "--recover-orphan-after-teardown"], False, docker=docker)
            (request_dir / "complete-result.json").write_text(json.dumps({
                "schema_version": "runtime_service_orphan_teardown_result.v1",
                "status": "completed", "request_sha256": "a" * 64,
                "started": False, "solve_replayed": False,
                "startup_replayed": False,
            }, sort_keys=True), encoding="utf-8")
            (request_dir / "complete-phase.json").write_text(json.dumps({
                "schema": "fullmag.docker.orphan-maintenance-phase.v1",
                "phase": "complete", **terminal,
            }, sort_keys=True), encoding="utf-8")

    def _run(self, docker, events, *, fail_phase=None, pins=None):
        pins = recovery_pins() if pins is None else pins
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()):
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            return recovery.recover_orphan(
                pins, target()["Id"], PROJECT, state_root / "diagnostics",
                docker_client=docker,
                maintenance_runner=self._runner(events, fail_phase=fail_phase, docker=docker))

    def test_engine_change_during_probes_aborts_before_native_prepare(self):
        docker = FakeDocker(target())
        events = []
        original_call = docker.__call__
        infos = 0

        def changing_engine(*args, **kwargs):
            nonlocal infos
            if args[:2] == ("info", "--format"):
                infos += 1
                if infos > 1:
                    return "81a2002d-4c88-48aa-b4da-fed771788cfa"
            return original_call(*args, **kwargs)

        with mock.patch.object(FakeDocker, "__call__", side_effect=changing_engine):
            with self.assertRaises(recovery.RecoveryAborted):
                self._run(docker, events)
        self.assertNotIn("prepare", [event[0] for event in events])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_preflight_failure_does_not_prepare_or_stop(self):
        docker = FakeDocker(target())
        events = []
        with self.assertRaises(recovery.RecoveryAborted):
            self._run(docker, events, fail_phase="package-probe")
        self.assertEqual([event[0] for event in events], ["package-probe"])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_prepare_failure_does_not_stop_target(self):
        docker = FakeDocker(target())
        events = []
        with self.assertRaises(recovery.RecoveryAborted):
            self._run(docker, events, fail_phase="prepare")
        self.assertEqual([event[0] for event in events],
                         ["package-probe", "sdk-loader-probe", "loader-probe", "prepare"])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_windows_grant_fence_rejects_api_or_additional_writer(self):
        document = target()
        clean = ("PID PPID COMMAND COMMAND\n"
                 "91 1 docker-init /sbin/docker-init -- python3 /opt/fullmag/backend_dev.py\n"
                 "92 91 python3 /usr/local/bin/python3 /opt/fullmag/entrypoint.py\n")
        recovery._assert_failed_keeper_only(lambda *args, **kwargs: clean, document)
        for output in (clean + "93 91 fullmag-api /opt/fullmag/package/bin/fullmag-api\n",
                       clean.replace("/opt/fullmag/entrypoint.py", "/tmp/writer.py"),
                       clean.replace("91 1 docker-init", "95 1 docker-init")):
            with self.subTest(output=output), self.assertRaises(ValueError):
                recovery._assert_failed_keeper_only(lambda *args, **kwargs: output, document)

    def test_failed_prepare_resumes_only_with_explicit_flag_and_same_request(self):
        docker = FakeDocker(target())
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()):
            root = Path(temporary) / "state"
            root.mkdir()
            for document in (docker.before, docker.after):
                next(m for m in document["Mounts"] if m["Destination"] == "/state")["Source"] = str(root)
            kwargs = dict(docker_client=docker,
                          maintenance_runner=self._runner(events, fail_phase="prepare", docker=docker))
            with self.assertRaises(recovery.RecoveryAborted):
                recovery.recover_orphan(recovery_pins(), target()["Id"], PROJECT,
                                        root / "diagnostics", **kwargs)
            request_path = root / "diagnostics" / "orphan" / REQUEST / "request.json"
            original = request_path.read_bytes()
            with self.assertRaises(recovery.RecoveryUnknown):
                recovery.recover_orphan(recovery_pins(), target()["Id"], PROJECT,
                                        root / "diagnostics", **kwargs)
            self.assertFalse(docker.stopped)
            kwargs["maintenance_runner"] = self._runner(events, docker=docker)
            result = recovery.recover_orphan(
                recovery_pins(), target()["Id"], PROJECT, root / "diagnostics",
                resume_before_stop=True, **kwargs)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(request_path.read_bytes(), original)
            self.assertEqual(sum(call[0] == "stop" for call in docker.calls), 1)
            self.assertTrue((request_path.parent / "package-probe.json").exists())
            self.assertEqual(len(list((request_path.parent / "pre-stop-resume").iterdir())), 1)

    def test_unknown_prepare_after_native_start_can_resume_exact_administrative_request(self):
        docker = FakeDocker(target())
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()):
            root = Path(temporary) / "state"
            root.mkdir()
            for document in (docker.before, docker.after):
                next(m for m in document["Mounts"] if m["Destination"] == "/state")["Source"] = str(root)
            base_runner = self._runner(events, docker=docker)
            def lose_native_result(target_document, name, command, preflight, phase):
                result = base_runner(target_document, name, command, preflight, phase)
                if phase == "prepare":
                    raise recovery.RecoveryUnknown("native prepare ran; result observation lost")
                return result
            kwargs = dict(docker_client=docker, maintenance_runner=lose_native_result)
            with self.assertRaises(recovery.RecoveryUnknown):
                recovery.recover_orphan(recovery_pins(), target()["Id"], PROJECT,
                                        root / "diagnostics", **kwargs)
            request_path = root / "diagnostics" / "orphan" / REQUEST / "request.json"
            original = request_path.read_bytes()
            with self.assertRaises(recovery.RecoveryUnknown):
                recovery.recover_orphan(recovery_pins(), target()["Id"], PROJECT,
                                        root / "diagnostics", **kwargs)
            self.assertFalse(docker.stopped)
            kwargs["maintenance_runner"] = self._runner(events, docker=docker)
            result = recovery.recover_orphan(
                recovery_pins(), target()["Id"], PROJECT, root / "diagnostics",
                resume_before_stop=True, **kwargs)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(request_path.read_bytes(), original)
            self.assertEqual(sum(call[0] == "stop" for call in docker.calls), 1)
            self.assertTrue((request_path.parent / "package-probe.json").exists())
            self.assertEqual(len(list((request_path.parent / "pre-stop-resume").iterdir())), 1)

    def test_pre_stop_resume_requires_an_existing_request(self):
        docker = FakeDocker(target())
        events = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            for document in (docker.before, docker.after):
                next(m for m in document["Mounts"] if m["Destination"] == "/state")["Source"] = str(root)
            with self.assertRaisesRegex(ValueError, "existing immutable request"):
                recovery.recover_orphan(
                    recovery_pins(), target()["Id"], PROJECT, root / "diagnostics",
                    resume_before_stop=True, docker_client=docker,
                    maintenance_runner=self._runner(events, docker=docker))
        self.assertEqual(events, [])
        self.assertFalse(docker.stopped)

    def test_pre_stop_resume_rejects_changed_pins_without_any_new_probe(self):
        docker = FakeDocker(target())
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()):
            root = Path(temporary) / "state"
            root.mkdir()
            for document in (docker.before, docker.after):
                next(m for m in document["Mounts"] if m["Destination"] == "/state")["Source"] = str(root)
            with self.assertRaises(recovery.RecoveryAborted):
                recovery.recover_orphan(
                    recovery_pins(), target()["Id"], PROJECT, root / "diagnostics",
                    docker_client=docker,
                    maintenance_runner=self._runner(events, fail_phase="prepare", docker=docker))
            previous_events = list(events)
            pins = recovery_pins()
            pins["run_id"] = "different-run"
            with self.assertRaises((ValueError, recovery.RecoveryUnknown)):
                recovery.recover_orphan(
                    pins, target()["Id"], PROJECT, root / "diagnostics",
                    resume_before_stop=True, docker_client=docker,
                    maintenance_runner=self._runner(events, docker=docker))
            self.assertEqual(events, previous_events)
            self.assertFalse(docker.stopped)

    def test_pin_change_during_readonly_probes_does_not_prepare_or_stop(self):
        docker = FakeDocker(target())
        events = []
        with tempfile.TemporaryDirectory() as temporary:
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            pins_path = Path(temporary) / "pins.json"
            pins_path.write_text(json.dumps(recovery_pins(), sort_keys=True))
            pins, pins_sha = recovery._load_pins(pins_path)
            pins["pins_path"] = str(pins_path)
            def runner(target_document, name, command, preflight, phase):
                result = self._runner(events, docker=docker)(
                    target_document, name, command, preflight, phase)
                if phase == "loader-probe":
                    pins_path.write_text(pins_path.read_text() + " ")
                return result
            with mock.patch.object(recovery, "_pure_module", return_value=fake_pure()):
                with self.assertRaises((ValueError, recovery.RecoveryAborted)):
                    recovery.recover_orphan(pins, target()["Id"], PROJECT, state_root / "diagnostics",
                                            pins_sha256=pins_sha, docker_client=docker,
                                            maintenance_runner=runner)
        self.assertNotIn("stop", [call[0] for call in docker.calls])

        self.assertNotIn("prepare", [event[0] for event in events])

    def test_pin_change_after_prepare_does_not_stop_target(self):
        docker = FakeDocker(target())
        events = []
        with tempfile.TemporaryDirectory() as temporary:
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            pins_path = Path(temporary) / "pins.json"
            pins_path.write_text(json.dumps(recovery_pins(), sort_keys=True))
            pins, pins_sha = recovery._load_pins(pins_path)
            pins["pins_path"] = str(pins_path)
            def runner(target_document, name, command, preflight, phase):
                result = self._runner(events, docker=docker)(
                    target_document, name, command, preflight, phase)
                if phase == "prepare":
                    pins_path.write_text(pins_path.read_text() + " ")
                return result
            with mock.patch.object(recovery, "_pure_module", return_value=fake_pure()):
                with self.assertRaises(recovery.RecoveryUnknown):
                    recovery.recover_orphan(pins, target()["Id"], PROJECT, state_root / "diagnostics",
                                            pins_sha256=pins_sha, docker_client=docker,
                                            maintenance_runner=runner)
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_uncertain_stop_does_not_complete_or_infer_release(self):
        docker = FakeDocker(target())
        docker.stop_error = recovery.RecoveryUnknown("stop result unknown")
        events = []
        with self.assertRaises(recovery.RecoveryUnknown):
            self._run(docker, events)
        self.assertEqual([event[0] for event in events],
                         ["package-probe", "sdk-loader-probe", "loader-probe", "prepare"])
        self.assertNotIn("complete", [event[0] for event in events])

    def test_zero_release_mapping_is_rejected_before_native_prepare(self):
        docker = FakeDocker(target())
        events = []
        pins = recovery_pins()
        pins["device_release"]["mapping_sha256"] = "0" * 64
        with self.assertRaises(recovery.RecoveryAborted):
            self._run(docker, events, pins=pins)
        self.assertNotIn("prepare", [event[0] for event in events])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_detachment_is_observed_only_after_factual_target_stop(self):
        docker = FakeDocker(target())
        events = []
        pins = recovery_pins()
        pins["device_release"].pop("mapping_detached", None)
        published = []
        write_record = recovery._write_record

        def observe_record(path, value):
            if Path(path).name == "teardown-manifest.json":
                self.assertTrue(docker.stopped)
                self.assertEqual(value["after"]["state"], "exited")
                self.assertEqual(value["after"]["pid"], 0)
                self.assertTrue(value["device_release"]["mapping_detached"])
                published.append(copy.deepcopy(value))
            return write_record(path, value)

        with mock.patch.object(recovery, "_write_record", side_effect=observe_record):
            result = self._run(docker, events, pins=pins)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(published), 1)
        self.assertNotIn("mapping_detached", pins["device_release"])

    def test_future_detachment_claim_is_rejected_before_native_prepare(self):
        docker = FakeDocker(target())
        events = []
        pins = recovery_pins()
        pins["device_release"]["mapping_detached"] = True
        with self.assertRaises(recovery.RecoveryAborted):
            self._run(docker, events, pins=pins)
        self.assertNotIn("prepare", [event[0] for event in events])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_success_has_exact_prepare_stop_complete_order(self):
        docker = FakeDocker(target())
        events = []
        result = self._run(docker, events)
        self.assertEqual(result["status"], "completed")
        self.assertEqual([event[0] for event in events],
                         ["package-probe", "sdk-loader-probe", "loader-probe", "prepare", "complete"])
        names = [call[0] for call in docker.calls]
        self.assertLess(names.index("stop"), names.index("inspect", names.index("stop") + 1))

    def test_stopped_target_replays_immutable_completion_without_prepare_or_stop(self):
        docker = FakeDocker(target())
        docker.stopped = True
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()), mock.patch.object(
                recovery, "_pure_validators", return_value=fake_validators()):
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            self._seed_stopped_replay(docker, state_root)
            result = recovery.recover_orphan(
                recovery_pins(), target()["Id"], PROJECT, state_root / "diagnostics",
                docker_client=docker,
                maintenance_runner=self._runner(events, docker=docker),
            )
        self.assertEqual(result["status"], "completed")
        self.assertEqual([event[0] for event in events], ["complete-replay"])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_stopped_replay_refreshes_engine_before_native_completion(self):
        docker = FakeDocker(target())
        docker.stopped = True
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()), mock.patch.object(
                recovery, "_pure_validators", return_value=fake_validators()):
            root = Path(temporary) / "state"
            root.mkdir()
            for document in (docker.before, docker.after):
                next(m for m in document["Mounts"] if m["Destination"] == "/state")["Source"] = str(root)
            self._seed_stopped_replay(docker, root)
            first_engine = recovery._engine(docker)
            with mock.patch.object(recovery, "_engine", side_effect=[
                    first_engine, {"ID": "81a2002d-4c88-48aa-b4da-fed771788cfa"}]), self.assertRaisesRegex(
                        recovery.RecoveryUnknown, "engine identity changed"):
                recovery.recover_orphan(
                    recovery_pins(), target()["Id"], PROJECT, root / "diagnostics",
                    docker_client=docker, maintenance_runner=self._runner(events, docker=docker))
        self.assertEqual(events, [])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_replay_rejects_changed_gpu_uuid_before_native_completion(self):
        docker = FakeDocker(target())
        docker.stopped = True
        events = []
        pins = recovery_pins()
        pins["device_release"]["gpu_uuid"] = "GPU-pinned-device"
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()), mock.patch.object(
                recovery, "_pure_validators", return_value=fake_validators()):
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            self._seed_stopped_replay(docker, state_root, pins=pins)
            attestation_path = state_root / "diagnostics" / "orphan" / REQUEST / "attestation.json"
            attestation = json.loads(attestation_path.read_text())
            attestation["device_release"]["gpu_uuid"] = "GPU-another-device"
            attestation_path.write_text(json.dumps(attestation), encoding="utf-8")
            with self.assertRaises(recovery.RecoveryUnknown):
                recovery.recover_orphan(
                    pins, target()["Id"], PROJECT, state_root / "diagnostics",
                    docker_client=docker,
                    maintenance_runner=self._runner(events, docker=docker),
                )
        self.assertEqual(events, [])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_legacy_detachment_pin_replays_only_recorded_stopped_namespace(self):
        docker = FakeDocker(target())
        docker.stopped = True
        events = []
        pins = recovery_pins()
        pins["device_release"]["mapping_detached"] = True
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()), mock.patch.object(
                recovery, "_pure_validators", return_value=fake_validators()):
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            self._seed_stopped_replay(docker, state_root, pins=pins)
            result = recovery.recover_orphan(
                pins, target()["Id"], PROJECT, state_root / "diagnostics",
                docker_client=docker,
                maintenance_runner=self._runner(events, docker=docker),
            )
        self.assertEqual(result["status"], "completed")
        self.assertEqual([event[0] for event in events], ["complete-replay"])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_stopped_target_with_complete_result_only_finalizes_without_native_replay(self):
        docker = FakeDocker(target())
        docker.stopped = True
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()), mock.patch.object(
                recovery, "_pure_validators", return_value=fake_validators()):
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            self._seed_stopped_replay(docker, state_root, complete=True)
            result = recovery.recover_orphan(
                recovery_pins(), target()["Id"], PROJECT, state_root / "diagnostics",
                docker_client=docker,
                maintenance_runner=self._runner(events, docker=docker),
            )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(events, [])
        self.assertNotIn("stop", [call[0] for call in docker.calls])

    def test_final_receipt_alone_cannot_complete_replay(self):
        docker = FakeDocker(target())
        docker.stopped = True
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()), mock.patch.object(
                recovery, "_pure_validators", return_value=fake_validators()):
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            self._seed_stopped_replay(docker, state_root)
            request_dir = state_root / "diagnostics" / "orphan" / REQUEST
            receipt = fake_pure()[3](None, None, None)
            receipt.update({"request_sha256": "a" * 64, "attestation_sha256": "a" * 64})
            (request_dir / "final-receipt.json").write_text(
                json.dumps(receipt, sort_keys=True, separators=(",", ":")), encoding="utf-8")
            with self.assertRaises(recovery.RecoveryUnknown):
                recovery.recover_orphan(
                    recovery_pins(), target()["Id"], PROJECT, state_root / "diagnostics",
                    docker_client=docker,
                    maintenance_runner=self._runner(events, docker=docker),
                )
        self.assertEqual(events, [])
        self.assertNotIn("rm", [call[0] for call in docker.calls])

    def test_existing_final_receipt_requires_validated_complete_result(self):
        docker = FakeDocker(target())
        docker.stopped = True
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()), mock.patch.object(
                recovery, "_pure_validators", return_value=fake_validators()):
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            self._seed_stopped_replay(docker, state_root, complete=True)
            request_dir = state_root / "diagnostics" / "orphan" / REQUEST
            complete_path = request_dir / "complete-result.json"
            malformed = json.loads(complete_path.read_text(encoding="utf-8"))
            malformed["status"] = "prepared"
            complete_path.write_text(
                json.dumps(malformed, sort_keys=True, separators=(",", ":")), encoding="utf-8")
            receipt = fake_pure()[3](None, None, None)
            receipt.update({"request_sha256": "a" * 64, "attestation_sha256": "a" * 64})
            (request_dir / "final-receipt.json").write_text(
                json.dumps(receipt, sort_keys=True, separators=(",", ":")), encoding="utf-8")
            with self.assertRaises(recovery.RecoveryUnknown):
                recovery.recover_orphan(
                    recovery_pins(), target()["Id"], PROJECT, state_root / "diagnostics",
                    docker_client=docker,
                    maintenance_runner=self._runner(events, docker=docker),
                )
        self.assertEqual(events, [])


class RecoveryExecutionBoundaryTests(unittest.TestCase):
    def test_engine_probe_preserves_canonical_uuid_identity(self):
        value = "81a2002d-4c88-48aa-b4da-fed771788cfa"
        with mock.patch.object(recovery, "_docker_call", return_value=value + "\n"):
            self.assertEqual(recovery._engine(lambda *a, **kw: None), {"ID": value})

    def test_engine_probe_rejects_placeholder_identity(self):
        for value in ("unknown", "00000000-0000-0000-0000-000000000000",
                      "0" * 64, "sha256:" + "0" * 64):
            with self.subTest(value=value), mock.patch.object(
                recovery, "_docker_call", return_value=value
            ), self.assertRaises(recovery.RecoveryAborted):
                recovery._engine(lambda *a, **kw: None)

    def _created_maintenance_document(self, *, tamper_mount=False,
                                      tamper_tmpfs=False, runtime="runc"):
        service = recovery.maintenance_compose(
            target(), PROJECT, REQUEST, ["python3", "-c", "print(1)"],
            preflight=True)["services"]["backend-recovery"]
        mounts = [{
            "Type": "bind", "Source": item["source"], "Destination": item["target"],
            "RW": not item["read_only"],
        } for item in service["volumes"]]
        mounts.append({"Type": "tmpfs", "Source": "tmpfs", "Destination": "/tmp",
                       "RW": True, "Mode": "rw,nosuid,nodev,size=64m"})
        if tamper_mount:
            mounts[0]["Source"] += "-tampered"
        if tamper_tmpfs:
            mounts[-1]["Mode"] = "rw"
        return {
            "Id": "d" * 64, "Image": target()["Image"],
            "Config": {"User": service.get("user", ""), "Labels": {
                "com.docker.compose.project": PROJECT,
                "com.docker.compose.service": "backend-recovery",
                "fullmag.recovery.request_id": REQUEST,
                "fullmag.recovery.target_container": target()["Id"],
            }},
            "HostConfig": {"Runtime": runtime, "Tmpfs": {
                                "/tmp": "rw,nosuid,nodev,size=64m"},
                            "PidMode": "", "NetworkMode": "none", "IpcMode": "private",
                            "ReadonlyRootfs": True, "Privileged": False,
                            "DeviceRequests": [], "Devices": [], "CapAdd": [],
                            "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"]},
            "Mounts": mounts,
            "State": {"Status": "created", "Running": False, "ExitCode": None},
        }

    def test_diagnostics_are_bound_to_target_state(self):
        document = target()
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            state.mkdir()
            for mount in document["Mounts"]:
                if mount["Destination"] == "/state":
                    mount["Source"] = str(state)
            self.assertEqual(recovery._assert_diagnostics_binding(
                document, state / "diagnostics"), state / "diagnostics")
            with self.assertRaises(recovery.RecoveryAborted):
                recovery._assert_diagnostics_binding(document, state / "diagnostics" / "request")
            with self.assertRaises(recovery.RecoveryAborted):
                recovery._assert_diagnostics_binding(document, Path(temporary) / "outside")

    def test_diagnostics_rejects_symlink_ancestor_before_normalization(self):
        document = target()
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            state.mkdir()
            redirected = Path(temporary) / "redirected"
            redirected.mkdir()
            (state / "diagnostics").symlink_to(redirected, target_is_directory=True)
            for mount in document["Mounts"]:
                if mount["Destination"] == "/state":
                    mount["Source"] = str(state)
            with self.assertRaises(recovery.RecoveryAborted):
                recovery._assert_diagnostics_binding(document, state / "diagnostics")

    def test_diagnostics_rejects_parent_traversal_before_symlink_normalization(self):
        document = target()
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            state.mkdir()
            linked = Path(temporary) / "linked"
            linked.mkdir()
            (state / "link").symlink_to(linked, target_is_directory=True)
            for mount in document["Mounts"]:
                if mount["Destination"] == "/state":
                    mount["Source"] = str(state)
            with self.assertRaises(recovery.RecoveryAborted):
                recovery._assert_diagnostics_binding(
                    document, state / "link" / ".." / "diagnostics")

    def test_request_directory_symlink_is_rejected_before_mkdir(self):
        docker = FakeDocker(target())
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()):
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            outside = Path(temporary) / "outside"
            outside.mkdir()
            diagnostics = state_root / "diagnostics"
            diagnostics.mkdir()
            (diagnostics / "orphan").symlink_to(outside, target_is_directory=True)
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            with self.assertRaises(recovery.RecoveryAborted):
                recovery.recover_orphan(
                    recovery_pins(), target()["Id"], PROJECT, diagnostics,
                    docker_client=docker,
                    maintenance_runner=RecoveryRunnerTests()._runner(
                        events, docker=docker),
                )
            self.assertEqual(events, [])
            self.assertFalse((outside / REQUEST).exists())

    def test_maintenance_cannot_inherit_network_gpu_secrets_or_extra_mounts(self):
        original = target()
        before = copy.deepcopy(original)
        compose = recovery.maintenance_compose(
            original, PROJECT, REQUEST, [recovery.NATIVE_PROGRAM, "--recover-orphan-after-teardown"])
        service = compose["services"]["backend-recovery"]
        self.assertEqual(original, before)
        self.assertEqual(compose["name"], PROJECT)
        self.assertEqual(service["network_mode"], "none")
        self.assertNotIn("ports", service)
        self.assertNotIn("gpus", service)
        self.assertNotIn("devices", service)
        self.assertEqual(service["environment"]["NVIDIA_VISIBLE_DEVICES"], "void")
        self.assertEqual(service["environment"]["FULLMAG_COMPOSE_PROJECT"], PROJECT)
        self.assertEqual(service["environment"]["FULLMAG_BACKEND_CARGO_PROFILE"], "backend-dev")
        self.assertTrue(service["environment"]["FULLMAG_TOOLCHAIN_IMAGE_ID"].startswith("sha256:"))
        self.assertNotIn("SECRET", service["environment"])
        self.assertNotIn("FULLMAG_STARTUP_SCRIPT", service["environment"])
        mounts = {item["target"]: item for item in service["volumes"]}
        self.assertEqual(set(mounts), {"/state", "/host-ledger", "/opt/fullmag/package"})
        self.assertTrue(mounts["/opt/fullmag/package"]["read_only"])
        self.assertFalse(mounts["/state"]["read_only"])
        self.assertTrue(all(not item["bind"]["create_host_path"] for item in mounts.values()))
        self.assertEqual(service["cap_drop"], ["ALL"])
        self.assertEqual(service["restart"], "no")

    def test_v2_recovery_uses_the_pinned_package_volume_without_host_bind(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = v2_backend_cache(Path(temporary))
            document = target()
            mount_v2_cache(document, cache)
            service = recovery.maintenance_compose(
                document, PROJECT, REQUEST,
                [recovery.NATIVE_PROGRAM, "--recover-orphan-after-teardown"],
                backend_cache=cache,
            )["services"]["backend-recovery"]
            mounts = {item["target"]: item for item in service["volumes"]}
            package_mount = next(item for item in service["volumes"]
                                 if item["target"] == volume_cache.PACKAGE_TARGET)
            self.assertEqual(package_mount["type"], "volume")
            self.assertEqual(package_mount["source"],
                             cache["volume_names"][volume_cache.PACKAGE_VOLUME_ROLE])
            self.assertEqual(package_mount["volume"], {"nocopy": True})
            self.assertNotIn(volume_cache.CONTROL_TARGET, mounts)
            args = recovery._maintenance_create_args(
                {"name": PROJECT, "services": {"backend-recovery": service}},
                name="fullmag-recovery-test")
            mount_args = [args[index + 1] for index, value in enumerate(args[:-1])
                          if value == "--mount"]
            self.assertTrue(any(
                "type=volume" in value
                and "volume-nocopy" in value
                and cache["volume_names"][volume_cache.PACKAGE_VOLUME_ROLE] in value
                for value in mount_args
            ))

    def test_v2_recovery_rejects_a_foreign_cache_volume_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = v2_backend_cache(Path(temporary))
            document = target()
            mount_v2_cache(document, cache)
            control = next(item for item in document["Mounts"]
                           if item["Destination"] == volume_cache.CONTROL_TARGET)
            control["Name"] = "foreign-control-volume"
            with self.assertRaises(recovery.RecoveryAborted):
                recovery.maintenance_compose(
                    document, PROJECT, REQUEST, ["true"], backend_cache=cache)

            missing_control = target()
            mount_v2_cache(missing_control, cache)
            missing_control["Mounts"] = [
                item for item in missing_control["Mounts"]
                if item["Destination"] != volume_cache.CONTROL_TARGET
            ]
            with self.assertRaises(recovery.RecoveryAborted):
                recovery.maintenance_compose(
                    missing_control, PROJECT, REQUEST, ["true"], backend_cache=cache)

    def test_v2_descriptor_rejection_precedes_any_maintenance_runner(self):
        for mutation in ("overlay", "receipt", "none", "absent"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                cache = v2_backend_cache(Path(temporary))
                if mutation == "overlay":
                    cache["compose_overlay_sha256"] = "0" * 64
                elif mutation == "receipt":
                    receipt_path = Path(cache["receipt_path"])
                    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                    receipt["state"] = "failed"
                    receipt_path.write_text(
                        json.dumps(receipt, sort_keys=True, separators=(",", ":")),
                        encoding="utf-8",
                    )
                document = target()
                if mutation != "none":
                    mount_v2_cache(document, cache)
                docker = FakeDocker(document)
                docker.volume_documents = cache["volume_documents"]
                events = []
                pins = recovery_pins()
                if mutation == "none":
                    pins["backend_cache"] = None
                elif mutation != "absent":
                    pins["backend_cache"] = cache
                state_root = Path(temporary) / "state"
                state_root.mkdir()
                for document in (docker.before, docker.after):
                    for mount in document["Mounts"]:
                        if mount["Destination"] == "/state":
                            mount["Source"] = str(state_root)
                def runner(*args):
                    events.append(args)
                    raise AssertionError("maintenance runner must not be reached")
                with mock.patch.object(recovery, "_pure_module", return_value=fake_pure()):
                    with self.assertRaises(recovery.RecoveryAborted):
                        recovery.recover_orphan(
                            pins, target()["Id"], PROJECT,
                            state_root / "diagnostics",
                            docker_client=docker,
                            maintenance_runner=runner,
                        )
                self.assertEqual(events, [])
                self.assertFalse(any(call[0] == "volume" for call in docker.calls))

    def test_preflight_has_no_mutable_store_or_ledger_mount(self):
        service = recovery.maintenance_compose(
            target(), PROJECT, REQUEST, ["python3", "-c", recovery.LOADER_PROBE],
            preflight=True)["services"]["backend-recovery"]
        self.assertTrue(all(item["read_only"] for item in service["volumes"]))

    def test_foreign_or_shared_or_privileged_target_is_refused(self):
        variants = []
        foreign = target()
        foreign["Config"]["Labels"]["com.docker.compose.project"] = "fullmag-master"
        variants.append(foreign)
        shared = target()
        shared["HostConfig"]["PidMode"] = "container:other"
        variants.append(shared)
        privileged = target()
        privileged["HostConfig"]["Privileged"] = True
        variants.append(privileged)
        for document in variants:
            with self.subTest(document=document), self.assertRaises(ValueError):
                recovery.maintenance_compose(document, PROJECT, REQUEST, ["true"])

    def test_other_ledger_writer_blocks_but_readonly_reader_does_not(self):
        backend = target()
        other = {"Id": "c" * 64, "Mounts": [{"Source": "/existing/host-ledger", "RW": True}]}
        with self.assertRaisesRegex(ValueError, "another running client"):
            recovery.assert_shared_clients_quiescent(backend, [backend, other])
        other["Mounts"][0]["RW"] = False
        recovery.assert_shared_clients_quiescent(backend, [backend, other])

    def test_overlapping_ledger_writers_block_recovery(self):
        backend = target()
        for source in ("/existing", "/", "/existing/host-ledger/ledger",
                       "/existing//host-ledger/ledger/"):
            with self.subTest(source=source):
                other = {"Id": "c" * 64,
                         "Mounts": [{"Type": "bind", "Source": source, "RW": True}]}
                with self.assertRaisesRegex(ValueError, "another running client"):
                    recovery.assert_shared_clients_quiescent(backend, [backend, other])

    def test_sibling_writers_and_readonly_overlaps_do_not_block_recovery(self):
        backend = target()
        for source, writable in (("/existing/host-ledger-extra", True),
                                 ("/existing/host-ledger/../separate", True),
                                 ("/existing", False),
                                 ("/existing/host-ledger/ledger", False)):
            with self.subTest(source=source, writable=writable):
                other = {"Id": "c" * 64,
                         "Mounts": [{"Type": "bind", "Source": source, "RW": writable}]}
                recovery.assert_shared_clients_quiescent(backend, [backend, other])

    def test_unverifiable_writable_host_mount_blocks_recovery(self):
        backend = target()
        other = {"Id": "c" * 64,
                 "Mounts": [{"Type": "bind", "Source": "relative/unknown", "RW": True}]}
        with self.assertRaisesRegex(ValueError, "host mount source"):
            recovery.assert_shared_clients_quiescent(backend, [backend, other])
        other["Mounts"][0] = {"Type": "tmpfs", "Source": "", "RW": True}
        recovery.assert_shared_clients_quiescent(backend, [backend, other])

    def test_running_inventory_requests_full_container_ids(self):
        docker = FakeDocker(target())
        recovery._running_containers(docker)
        self.assertIn(("ps", "--quiet", "--no-trunc"), docker.calls)

    def test_native_paths_are_materialized_under_state_orphan_directory(self):
        docker = FakeDocker(target())
        events = []
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                recovery, "_pure_module", return_value=fake_pure()):
            state_root = Path(temporary) / "state"
            state_root.mkdir()
            for document in (docker.before, docker.after):
                for mount in document["Mounts"]:
                    if mount["Destination"] == "/state":
                        mount["Source"] = str(state_root)
            result = recovery.recover_orphan(
                recovery_pins(), target()["Id"], PROJECT, state_root / "diagnostics",
                docker_client=docker,
                maintenance_runner=RecoveryRunnerTests()._runner(events, docker=docker))
            request_dir = state_root / "diagnostics" / "orphan" / REQUEST
            self.assertEqual(result["diagnostics"], str(request_dir))
            self.assertTrue((request_dir / "request.json").is_file())
            self.assertTrue((request_dir / "attestation.json").is_file())
            prepare = next(event for event in events if event[0] == "prepare")
            complete = next(event for event in events if event[0] == "complete")
            self.assertIn(f"/state/diagnostics/orphan/{REQUEST}/request.json", prepare[2])
            self.assertIn(f"/state/diagnostics/orphan/{REQUEST}/attestation.json", complete[2])

    def test_failed_maintenance_reports_container_stderr(self):
        document = self._created_maintenance_document()
        calls = []
        started = False

        def client(*args, timeout=60, combined=False):
            nonlocal started
            calls.append(args)
            if args[0] == "create":
                return document["Id"]
            if args[0] == "start":
                started = True
                return document["Id"]
            if args[0] == "inspect":
                current = copy.deepcopy(document)
                if started:
                    current["State"] = {"Status": "exited", "Running": False,
                                        "Pid": 0, "ExitCode": 1}
                return json.dumps([current])
            if args[0] == "logs":
                return "native admission denied: namespace mismatch" if combined else ""
            return ""

        with self.assertRaisesRegex(recovery.RecoveryUnknown, "namespace mismatch"):
            recovery._maintenance_run(
                client, target(), PROJECT, REQUEST,
                ["python3", "-c", "print(1)"], preflight=True, phase="probe")
        self.assertNotIn("rm", [call[0] for call in calls])

    def test_maintenance_retains_terminal_evidence_until_explicit_cleanup(self):
        created = "d" * 64
        calls = []
        service = recovery.maintenance_compose(
            target(), PROJECT, REQUEST, ["python3", "-c", "print(1)"],
            preflight=True)["services"]["backend-recovery"]
        actual_mounts = [{
            "Type": "bind", "Source": item["source"], "Destination": item["target"],
            "RW": not item["read_only"],
        } for item in service["volumes"]]
        class MaintenanceDocker:
            def __call__(self, *args, timeout=60, combined=False):
                calls.append(args)
                if args[0] == "create":
                    return created + "\n"
                if args[0] == "inspect":
                    return json.dumps([{"Id": created, "Image": target()["Image"],
                        "Config": {"Labels": {
                            "com.docker.compose.project": PROJECT,
                            "com.docker.compose.service": "backend-recovery",
                            "fullmag.recovery.request_id": REQUEST,
                            "fullmag.recovery.target_container": target()["Id"]},
                                  "User": service.get("user", "")},
                        "HostConfig": {"PidMode": "", "NetworkMode": "none",
                                        "Runtime": "runc",
                                        "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=64m"},
                                        "IpcMode": "private", "ReadonlyRootfs": True,
                                        "Privileged": False, "DeviceRequests": [],
                                        "Devices": [], "CapAdd": [], "CapDrop": ["ALL"],
                                        "SecurityOpt": ["no-new-privileges:true"]},
                        "Mounts": actual_mounts + [{
                            "Type": "tmpfs", "Source": "tmpfs", "Destination": "/tmp",
                            "RW": True, "Mode": "rw,nosuid,nodev,size=64m"}],
                        "State": {"Status": "exited", "Running": False, "ExitCode": 0}}])
                if args[0] == "logs":
                    return '{"status":"ready"}\n'
                return ""
        phase = recovery._maintenance_run(
            MaintenanceDocker(), target(), PROJECT, REQUEST,
            ["python3", "-c", "print(1)"], preflight=True, phase="probe")
        self.assertNotIn("rm", [call[0] for call in calls])
        create = next(call for call in calls if call[0] == "create")
        self.assertNotIn("--pid", create)
        self.assertEqual(phase["container_id"], created)
        recovery._cleanup_maintenance(MaintenanceDocker(), phase)
        self.assertIn("rm", [call[0] for call in calls])

    def test_cleanup_accepts_only_factual_absent_container(self):
        created = self._created_maintenance_document()
        created["State"] = {"Status": "exited", "Running": False,
                             "Pid": 0, "ExitCode": 0}
        phase = {"container_id": created["Id"], "inspect": created}

        class Absent:
            def __call__(self, *args, timeout=60):
                if args[0] == "inspect":
                    raise RuntimeError("Error response from daemon: No such container")
                raise AssertionError(args)

        recovery._cleanup_maintenance(Absent(), phase)

        class PermissionDenied:
            def __call__(self, *args, timeout=60):
                if args[0] == "inspect":
                    return json.dumps([created])
                if args[0] == "rm":
                    raise RuntimeError("permission denied")
                raise AssertionError(args)

        with self.assertRaises(recovery.RecoveryUnknown):
            recovery._cleanup_maintenance(PermissionDenied(), phase)

    def test_post_create_mount_tamper_is_rejected_before_start(self):
        created = self._created_maintenance_document(tamper_mount=True)
        calls = []

        class Docker:
            def __call__(self, *args, timeout=60):
                calls.append(args)
                if args[0] == "create":
                    return created["Id"] + "\n"
                if args[0] == "inspect":
                    return json.dumps([created])
                return ""

        with self.assertRaises(recovery.RecoveryAborted):
            recovery._maintenance_run(
                Docker(), target(), PROJECT, REQUEST,
                ["python3", "-c", "print(1)"], preflight=True, phase="probe")
        self.assertNotIn("start", [call[0] for call in calls])

    def test_post_create_tmpfs_tamper_is_rejected_before_start(self):
        created = self._created_maintenance_document(tamper_tmpfs=True)
        calls = []

        class Docker:
            def __call__(self, *args, timeout=60):
                calls.append(args)
                if args[0] == "create":
                    return created["Id"] + "\n"
                if args[0] == "inspect":
                    return json.dumps([created])
                return ""

        with self.assertRaises(recovery.RecoveryAborted):
            recovery._maintenance_run(
                Docker(), target(), PROJECT, REQUEST,
                ["python3", "-c", "print(1)"], preflight=True, phase="probe")
        self.assertNotIn("start", [call[0] for call in calls])

    def test_post_create_runtime_mismatch_is_rejected_before_start(self):
        created = self._created_maintenance_document(runtime="docker")
        calls = []

        class Docker:
            def __call__(self, *args, timeout=60):
                calls.append(args)
                if args[0] == "create":
                    return created["Id"] + "\n"
                if args[0] == "inspect":
                    return json.dumps([created])
                return ""

        with self.assertRaises(recovery.RecoveryAborted):
            recovery._maintenance_run(
                Docker(), target(), PROJECT, REQUEST,
                ["python3", "-c", "print(1)"], preflight=True, phase="probe")
        self.assertNotIn("start", [call[0] for call in calls])

    def test_post_start_failure_is_unknown_and_not_aborted(self):
        created = self._created_maintenance_document()
        calls = []

        class Docker:
            def __call__(self, *args, timeout=60):
                calls.append(args)
                if args[0] == "create":
                    return created["Id"] + "\n"
                if args[0] == "inspect":
                    return json.dumps([created])
                if args[0] == "start":
                    return ""
                if args[0] == "wait":
                    raise RuntimeError("wait transport lost")
                return ""

        with self.assertRaises(recovery.RecoveryUnknown):
            recovery._maintenance_run(
                Docker(), target(), PROJECT, REQUEST,
                ["python3", "-c", "print(1)"], preflight=True, phase="probe")
        self.assertIn("start", [call[0] for call in calls])

    def test_namespace_proof_requires_factual_exit_and_pid_zero(self):
        stopped = FakeDocker(target()).after
        observation = recovery._manifest_observation(stopped, stopped=True)
        self.assertEqual(observation["descendant_count"], 0)
        self.assertEqual(
            observation["namespace_teardown_proof"]["basis"],
            "docker-engine-private-pid-namespace-exit",
        )
        stopped["State"]["Pid"] = 1
        with self.assertRaises(ValueError):
            recovery._manifest_observation(stopped, stopped=True)

    def test_release_pin_rejects_all_zero_mapping_digest(self):
        with self.assertRaisesRegex(ValueError, "cannot be all zeroes"):
            recovery._validate_release_pin({
                "device_release": {"resource_id": "resource-1",
                                    "mapping_sha256": "0" * 64}},
                "resource-1")

    def test_package_probe_accepts_canonical_git_modes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "package"
            root.mkdir()
            executable = root / "bin" / "fullmag-runtime-service"
            regular = root / "lib" / "libfullmag_fdm.so"
            executable.parent.mkdir()
            regular.parent.mkdir()
            executable.write_bytes(b"native")
            regular.write_bytes(b"library")
            os.chmod(executable, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
            os.chmod(regular, stat.S_IRUSR | stat.S_IWUSR)
            artifacts = []
            for path in (executable, regular):
                mode = "100755" if path.stat().st_mode & 0o111 else "100644"
                data = path.read_bytes()
                artifacts.append({"path": path.relative_to(root).as_posix(),
                                  "size": len(data),
                                  "sha256": hashlib.sha256(data).hexdigest(),
                                  "mode": mode})
            receipt = {"schema": "fullmag.direct-compose.backend-build-receipt.v1",
                       "state": "succeeded", "artifacts": artifacts}
            (root / "backend-build-receipt.json").write_text(
                json.dumps(receipt, sort_keys=True), encoding="utf-8")
            helper = Path(temporary) / "backend_dev.py"
            helper.write_text(
                "import json\n"
                "def _validated_package(root, name, *, exclude_development_control=False):\n"
                "    if not exclude_development_control:\n"
                "        raise RuntimeError('development control exclusion was not requested')\n"
                "    raw = (root / \"backend-build-receipt.json\").read_bytes()\n"
                "    return json.loads(raw.decode()), raw, {}\n",
                encoding="utf-8")
            script = recovery.PACKAGE_PROBE_SCRIPT
            script = script.replace("pathlib.Path('/opt/fullmag/package')",
                                    f"pathlib.Path({str(root)!r})", 1)
            script = script.replace("pathlib.Path('/opt/fullmag/backend_dev.py')",
                                    f"pathlib.Path({str(helper)!r})", 1)
            completed = subprocess.run([sys.executable, "-c", script],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            probe = json.loads(completed.stdout)
            self.assertEqual([item["mode"] for item in probe["artifacts"]],
                             ["100755", "100644"])

    def test_package_probe_uses_exact_trusted_backend_validator_with_owned_control(self):
        """Validate live-package artifacts while excluding its control directory."""
        backend_source = Path(__file__).parents[1] / "docker" / "all-in-one" / "backend_source.py"
        backend_dev = Path(__file__).parents[1] / "docker" / "all-in-one" / "backend_dev.py"
        with tempfile.TemporaryDirectory() as temporary:
            temporary_root = Path(temporary)
            root = temporary_root / "package"
            trusted = temporary_root / "trusted"
            root.mkdir()
            trusted.mkdir()
            trusted_source = trusted / "backend_source.py"
            trusted_dev = trusted / "backend_dev.py"
            trusted_source.write_bytes(backend_source.read_bytes())
            trusted_dev.write_bytes(backend_dev.read_bytes())

            module_spec = importlib.util.spec_from_file_location(
                "trusted_backend_dev_fixture", trusted_dev)
            self.assertIsNotNone(module_spec)
            self.assertIsNotNone(module_spec.loader)
            trusted_module = importlib.util.module_from_spec(module_spec)
            sys.path.insert(0, str(trusted))
            try:
                module_spec.loader.exec_module(trusted_module)
            finally:
                sys.path.pop(0)

            required = list(trusted_module.REQUIRED_PACKAGE_PATHS) + [
                "lib/libfullmag_fdm.so", "lib/libfullmag_fem.so",
            ]
            for relative in required:
                path = root.joinpath(*Path(relative).parts)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(relative.encode("utf-8"))
                if relative.startswith("bin/"):
                    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
            (root / "launcher-build-mode").write_text("cuda-fem-gpu\n", encoding="utf-8")
            development = root / ".development"
            development.mkdir()
            (development / "owner.json").write_text("{}\n", encoding="utf-8")
            artifacts = trusted_module._hash_package(root)
            receipt = {
                "schema": "fullmag.direct-compose.backend-build-receipt.v1",
                "state": "succeeded",
                "execution_lanes": {lane: {} for lane in trusted_module.LANES},
                "artifacts": artifacts,
            }
            (root / "backend-build-receipt.json").write_text(
                json.dumps(receipt, sort_keys=True), encoding="utf-8")

            script = recovery.PACKAGE_PROBE_SCRIPT
            script = script.replace("pathlib.Path('/opt/fullmag/package')",
                                    f"pathlib.Path({str(root)!r})", 1)
            script = script.replace("pathlib.Path('/opt/fullmag/backend_dev.py')",
                                    f"pathlib.Path({str(trusted_dev)!r})", 1)
            completed = subprocess.run([sys.executable, "-c", script],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            probe = json.loads(completed.stdout)
            self.assertEqual(probe["state"], "succeeded")
            self.assertEqual(probe["artifacts"], artifacts)

    def test_unknown_profile_and_shared_namespace_modes_are_rejected(self):
        document = target()
        document["Config"]["Env"] = ["FULLMAG_SESSION_STORAGE_PROFILE=unknown-profile"]
        with self.assertRaisesRegex(ValueError, "unknown recovery session storage profile"):
            recovery._grant_context(document, {}, "prepare")
        for field in ("NetworkMode", "IpcMode"):
            document = target()
            document["HostConfig"][field] = "container:" + "a" * 64
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "private namespace"):
                recovery._manifest_observation(document, stopped=False)

    def test_windows_namespace_rotation_requires_exact_host_certificate_mount(self):
        document = target()
        document["Config"]["Env"] = ["FULLMAG_SESSION_STORAGE_PROFILE=windows-folder-v1"]
        with self.assertRaisesRegex(ValueError, "host certificate"):
            recovery._grant_context(document, {}, "prepare")

    def test_readonly_loader_cannot_issue_a_namespace_grant(self):
        with self.assertRaisesRegex(ValueError, "read-only loader"):
            recovery.noncompute_command(
                [recovery.NATIVE_PROGRAM, "--fullmag-recovery-loader-probe"],
                "1" * 64, {"phase": "prepare"})

    def test_native_command_has_fixed_program_config_phase_and_contained_inputs(self):
        request = "/state/diagnostics/orphan/request.json"
        attestation = "/state/diagnostics/orphan/attestation.json"
        command = recovery.native_arguments("complete", request, attestation)
        self.assertEqual(command[0], recovery.NATIVE_PROGRAM)
        self.assertIn(recovery.CONFIG_PATH, command)
        self.assertIn("--recover-orphan-after-teardown", command)
        for phase, path, proof in [("prepare", request, attestation),
                                   ("complete", request, None),
                                   ("complete", "/state/diagnostics/../owner.json", attestation),
                                   ("complete", "/outside/request.json", attestation)]:
            with self.subTest(phase=phase, path=path), self.assertRaises(ValueError):
                recovery.native_arguments(phase, path, proof)


if __name__ == "__main__":
    unittest.main()
